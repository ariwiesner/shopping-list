#!/usr/bin/env python3
"""Build compact price catalogs (per chain and per branch) from Israeli price-transparency files.

Israeli supermarket chains must publish every branch's full price list ("PriceFull" XML)
and their branch list ("Stores"). For each chain we download ALL branches and write:

    <out>/index.json                     chains: id, name, color, count, branches, updated
    <out>/<chain>.json                   every product sold in the chain, at its *common* price
                                         (the price most branches charge):
                                         { items: [[code, name, price, brand, weighted], ...] }
    <out>/<chain>/stores.json            branches: [[storeId, name, city, itemCount, address], ...]
    <out>/<chain>/<storeId>.json         only the prices that differ in this branch: { p: {code: price} }

The app downloads one chain file plus the one small branch file the user picked.
Standard library only:   python scripts/build_catalog.py --out catalog [--only shufersal]
"""
import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import gzip
import html
import http.cookiejar
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (compatible; shopping-list-catalog/2.0)"
MIN_ITEMS = 100   # ignore near-empty branch files
WORKERS = 6       # parallel downloads per chain (be polite to the chains' servers)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def make_opener(cookies=False):
    handlers = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())] if cookies else []
    op = urllib.request.build_opener(*handlers)
    op.addheaders = [("User-Agent", UA)]
    return op


DEFAULT = make_opener()


def fetch(url, opener=DEFAULT, data=None, timeout=120, tries=3):
    for attempt in range(tries):
        try:
            with opener.open(url, data=data, timeout=timeout) as r:
                return r.read()
        except Exception:  # noqa: BLE001 - network hiccups: retry, then give up
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def text(url, **kw):
    return fetch(url, **kw).decode("utf-8", "replace")


def size_of(s):
    m = re.match(r"\s*([\d.,]+)\s*(B|KB|MB|GB)", s or "", re.I)
    if not m:
        return None
    return int(float(m.group(1).replace(",", "")) * {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}[m.group(2).upper()])


def store_id_of(filename):
    """PriceFull<chain>-<subchain>-<store>-<date>-<time>.gz -> '42' (no leading zeros)."""
    parts = os.path.basename(filename).split("-")
    return str(int(parts[2])) if len(parts) >= 4 and parts[2].isdigit() else None


def stamp_of(filename):
    m = re.search(r"-(\d{8})-?(\d{4,6})?", os.path.basename(filename))
    return (m.group(1) + (m.group(2) or "")) if m else ""


# ---------------------------------------------------------------------------
# Sources. Each returns (price_files, stores_file_url_or_None, fetcher)
#   price_files: list of dicts {store, url, name?}
# ---------------------------------------------------------------------------

def src_shufersal():
    files = []
    for page in range(1, 80):
        t = text(f"https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page={page}")
        rows = re.findall(r'<tr class="webgrid-(?:row-style|alternating-row)">(.*?)</tr>', t, re.S)
        if not rows:
            break
        for r in rows:
            link = re.search(r'href="([^"]+)"', r)
            cells = [html.unescape(re.sub(r"<[^>]+>", "", c).strip()) for c in re.findall(r"<td>(.*?)</td>", r, re.S)]
            if link and len(cells) >= 7:
                url = html.unescape(link.group(1))
                label = cells[5]
                name = label.split(" - ", 1)[1].strip() if " - " in label else label
                files.append({"store": store_id_of(cells[6]), "url": url, "file": cells[6], "name": name})
        if f"page={page + 1}" not in t:
            break
    t = text("https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=5&storeId=0")
    m = re.search(r'href="(https://pricesprodpublic[^"]+)"', t)
    return files, (html.unescape(m.group(1)) if m else None), fetch


def src_carrefour():
    t = text("https://prices.carrefour.co.il/")
    path = re.search(r"const path = '(\d+)'", t).group(1)
    base = f"https://prices.carrefour.co.il/{path}/"
    files = [{"store": store_id_of(n), "url": base + n, "file": n}
             for n in re.findall(r'"name":"(PriceFull[^"]+\.gz)"', t)]
    stores = re.findall(r'"name":"(Stores[^"]+)"', t)
    return files, (base + sorted(stores)[-1] if stores else None), fetch


def src_hazi_hinam():
    urls = set()
    for page in range(1, 40):  # the price page is paged; t=1 = price files
        t = text(f"https://shop.hazi-hinam.co.il/Prices?p={page}&s=&f=&t=1&d=")
        if ".gz" not in t:
            break
        urls.update(re.findall(r'https://[^"\'\s]+/PriceFull[^"\'\s]+\.gz', t))
    files = [{"store": store_id_of(u), "url": u, "file": u} for u in sorted(urls)]
    s = text("https://shop.hazi-hinam.co.il/Prices?t=3")
    st = sorted(set(re.findall(r'https://[^"\'\s]+/Stores[^"\'\s]+', s)))
    return files, (st[-1] if st else None), fetch


def src_cerberus(user):
    """Shared portal url.publishedprices.co.il: public per-chain username, empty password."""
    def source():
        base = "https://url.publishedprices.co.il"
        op = make_opener(cookies=True)
        tok = lambda page: re.search(r'name="csrftoken" content="([^"]+)"', page).group(1)
        login = text(base + "/login", opener=op)
        fetch(base + "/login/user", opener=op,
              data=urllib.parse.urlencode({"username": user, "password": "", "csrftoken": tok(login)}).encode())
        csrf = tok(text(base + "/file", opener=op))

        def listing(search):
            body = urllib.parse.urlencode({"sSearch": search, "iDisplayLength": 100000, "csrftoken": csrf, "cd": "/"}).encode()
            return [f["fname"] for f in json.loads(fetch(base + "/file/json/dir", opener=op, data=body)).get("aaData", [])]

        files = [{"store": store_id_of(n), "url": base + "/file/d/" + n, "file": n}
                 for n in listing("PriceFull") if n.startswith("PriceFull")]
        stores = sorted((n for n in listing("Stores") if n.startswith("Stores")), key=stamp_of)
        return files, (base + "/file/d/" + stores[-1] if stores else None), lambda url, **kw: fetch(url, opener=op, **kw)
    return source


CHAINS = [
    {"id": "shufersal", "name": "שופרסל", "color": "#d71f26", "source": src_shufersal},
    {"id": "rami-levy", "name": "רמי לוי", "color": "#0a5bab", "source": src_cerberus("RamiLevi")},
    {"id": "carrefour", "name": "קרפור", "color": "#1d4f9c", "source": src_carrefour},
    {"id": "yochananof", "name": "יוחננוף", "color": "#e4002b", "source": src_cerberus("yohananof")},
    {"id": "osher-ad", "name": "אושר עד", "color": "#f7a600", "source": src_cerberus("osherad")},
    {"id": "hazi-hinam", "name": "חצי חינם", "color": "#f28c00", "source": src_hazi_hinam},
    {"id": "tiv-taam", "name": "טיב טעם", "color": "#00843d", "source": src_cerberus("TivTaam")},
]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def xml_root(data):
    raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
    if raw[:2] == b"PK":  # some chains zip their files
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        for enc in ("utf-8-sig", "utf-16", "cp1255"):
            try:
                s = raw.decode(enc)
                s = re.sub(r"^\s*<\?xml[^>]*\?>", "", s)
                return ET.fromstring(s.encode("utf-8"))
            except (UnicodeDecodeError, ET.ParseError):
                continue
        raise


def fields(el):
    return {c.tag.lower(): (c.text or "").strip() for c in el}


def parse_prices(data):
    """-> {code: (name, price, brand, weighted)}"""
    items = {}
    for el in xml_root(data).iter():
        if el.tag.lower() != "item":
            continue
        f = fields(el)
        name = re.sub(r"\s+", " ", f.get("itemname", "")).strip()
        code = f.get("itemcode", "").lstrip("0") or f.get("itemcode", "")
        try:
            price = round(float(f.get("itemprice", "0")), 2)
        except ValueError:
            continue
        if not name or not code or price <= 0 or price > 5000:
            continue
        brand = re.sub(r"\s+", " ", f.get("manufacturename", "")).strip()
        if brand in ("", "לא ידוע", "כללי", "---", "unknown", "Unknown") or brand in name:
            brand = ""
        weighted = 1 if f.get("bisweighted", "0") in ("1", "true", "True") else 0
        items[code] = (name, price, brand[:40], weighted)
    return items


# Israeli locality codes (CBS "סמל ישוב") -> names, from data.gov.il. Chains publish
# the code in <City>; a few leave it 0, so we then look for a city name in the text.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cities.json"), encoding="utf-8") as _fh:
    CITIES = json.load(_fh)
# Everyday names that differ from the official ones.
CITY_ALIASES = {"תל אביב": "תל אביב - יפו", 'ת"א': "תל אביב - יפו", "יפו": "תל אביב - יפו",
                "מודיעין": "מודיעין-מכבים-רעות", "פתח תקוה": "פתח תקווה", "ראשלצ": "ראשון לציון"}
_CITY_LOOKUP = {**{n: n for n in CITIES.values() if len(n) >= 3}, **CITY_ALIASES}
_CITY_NAMES = sorted(_CITY_LOOKUP, key=len, reverse=True)


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def city_in_text(*texts):
    """The longest known city name that appears as whole words in any of the texts."""
    for text in texts:
        t = " " + re.sub(r"[^\w\"'-]+", " ", text) + " "
        for n in _CITY_NAMES:
            if f" {n} " in t:
                return _CITY_LOOKUP[n]
    return ""


def parse_stores(data):
    """-> {storeId: (name, city, address)}"""
    out = {}
    for el in xml_root(data).iter():
        f = fields(el)
        sid, name = f.get("storeid") or f.get("storeidnumber"), clean(f.get("storename"))
        if not sid or not name or not sid.isdigit():
            continue
        address = clean(f.get("address"))
        if address.lower() in ("unknown", "0") or address.startswith("http"):
            address = ""
        city = clean(f.get("city"))
        if city.isdigit():  # usually a locality code, not a name
            city = CITIES.get(str(int(city)), "")
        if not city:
            city = city_in_text(address, name)
        # "רחוב X, חולון, ישראל" -> "רחוב X" when the city is shown separately
        parts = [p.strip() for p in address.split(",") if p.strip() and p.strip() not in (city, "ישראל")]
        out[str(int(sid))] = (name, city, ", ".join(parts))
    return out


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_chain(chain, out_dir, log):
    files, stores_url, get = chain["source"]()
    # Latest file per branch.
    latest = {}
    for f in files:
        if f["store"] and (f["store"] not in latest or stamp_of(f["file"]) > stamp_of(latest[f["store"]]["file"])):
            latest[f["store"]] = f
    if not latest:
        raise RuntimeError("no PriceFull files found")

    store_info = {}
    if stores_url:
        try:
            store_info = parse_stores(get(stores_url))
        except Exception as e:  # noqa: BLE001
            log(f"  (branch names unavailable: {e})")

    branches = {}

    def work(f):
        return f, parse_prices(get(f["url"], timeout=180))

    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for fut in cf.as_completed([ex.submit(work, f) for f in latest.values()]):
            try:
                f, items = fut.result()
            except Exception as e:  # noqa: BLE001 - skip a broken branch file
                log(f"  ! branch file failed: {e}")
                continue
            if len(items) >= MIN_ITEMS:
                branches[f["store"]] = (f, items)
    if not branches:
        raise RuntimeError("no branch file with enough items")

    # Common (most frequent) price and a representative name per product.
    prices, names = collections.defaultdict(collections.Counter), {}
    for _, items in branches.values():
        for code, (name, price, brand, weighted) in items.items():
            prices[code][price] += 1
            if code not in names or len(name) > len(names[code][0]):
                names[code] = (name, brand, weighted)
    common = {code: c.most_common(1)[0][0] for code, c in prices.items()}

    updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    items = sorted(([code, n, common[code], b, w] for code, (n, b, w) in names.items()), key=lambda it: it[1])
    write_json(os.path.join(out_dir, f"{chain['id']}.json"),
               {"id": chain["id"], "name": chain["name"], "updated": updated, "items": items})

    bdir = os.path.join(out_dir, chain["id"])
    if os.path.isdir(bdir):
        shutil.rmtree(bdir)
    os.makedirs(bdir)
    stores = []
    for sid, (f, its) in branches.items():
        diff = {code: p for code, (_, p, _, _) in its.items() if p != common[code]}
        write_json(os.path.join(bdir, f"{sid}.json"), {"p": diff})
        name, city, address = store_info.get(sid, (f.get("name") or f"סניף {sid}", "", ""))
        stores.append([sid, name, city, len(its), address])
    stores.sort(key=lambda s: (s[2] or "תתת", s[1]))
    write_json(os.path.join(bdir, "stores.json"), {"updated": updated, "stores": stores})

    return {"id": chain["id"], "name": chain["name"], "color": chain["color"],
            "count": len(items), "branches": len(stores), "updated": updated}


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog")
    ap.add_argument("--only", nargs="*", help="chain ids to build (default: all)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    log = lambda s: print(s, flush=True)

    # Keep previous entries for chains that fail today, so one broken site doesn't empty the app.
    index_path = os.path.join(args.out, "index.json")
    previous = {}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as fh:
            previous = {c["id"]: c for c in json.load(fh).get("chains", [])}

    results, failures = [], 0
    for chain in CHAINS:
        if args.only and chain["id"] not in args.only:
            if chain["id"] in previous:
                results.append(previous[chain["id"]])
            continue
        t0 = time.time()
        try:
            info = build_chain(chain, args.out, log)
            log(f"✓ {chain['id']}: {info['count']} products, {info['branches']} branches ({time.time() - t0:.0f}s)")
            results.append(info)
        except Exception as e:  # noqa: BLE001 - report and continue with other chains
            failures += 1
            log(f"✗ {chain['id']}: {e}")
            if chain["id"] in previous:
                results.append(previous[chain["id"]])

    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump({"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "chains": results},
                  fh, ensure_ascii=False, indent=1)
    if not results:
        sys.exit(1)
    if failures:
        print(f"{failures} chain(s) failed; kept previous data where available", file=sys.stderr)


if __name__ == "__main__":
    main()
