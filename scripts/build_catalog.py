#!/usr/bin/env python3
"""Build compact price catalogs (per chain and per branch) from Israeli price-transparency files.

Israeli supermarket chains must publish every branch's full price list ("PriceFull" XML)
and their branch list ("Stores"). For each chain we download ALL branches and write:

    <out>/index.json                     chains: id, name, color, count, branches, updated
    <out>/<chain>.json                   every product sold in the chain, at its *common* price
                                         (the price most branches charge), and the deals most
                                         branches run:
                                         { items: [[code, name, price, brand, weighted], ...],
                                           promos: [description, ...],
                                           deals: {code: [minQty, total, promoIdx, basketMin?]},
                                           club:  {code: [...]}  (club/credit-card members only) }
    <out>/<chain>/stores.json            branches: [[storeId, name, city, itemCount, address], ...]
    <out>/<chain>/<storeId>.json         only what differs in this branch: { p: {code: price},
                                         d: {code: deal | 0}, c: {code: club deal | 0} }

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
import math
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

# Trusted certificate authorities: certifi's up-to-date list when installed (some systems'
# lists miss newer chains, e.g. Let's Encrypt's), else the system's.
try:
    import certifi
    import ssl
    TLS = urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))
except ImportError:
    TLS = None


def make_opener(cookies=False):
    handlers = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())] if cookies else []
    if TLS:
        handlers.append(TLS)
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

def _shufersal_files(cat):
    files = []
    for page in range(1, 80):
        t = text(f"https://prices.shufersal.co.il/FileObject/UpdateCategory?catID={cat}&storeId=0&page={page}")
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
    return files


def src_shufersal():
    files = _shufersal_files(2)    # PriceFull
    promos = _shufersal_files(4)   # PromoFull
    t = text("https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=5&storeId=0")
    m = re.search(r'href="(https://pricesprodpublic[^"]+)"', t)
    return files, (html.unescape(m.group(1)) if m else None), fetch, promos


def src_carrefour():
    t = text("https://prices.carrefour.co.il/")
    path = re.search(r"const path = '(\d+)'", t).group(1)
    base = f"https://prices.carrefour.co.il/{path}/"
    files = [{"store": store_id_of(n), "url": base + n, "file": n}
             for n in re.findall(r'"name":"(PriceFull[^"]+\.gz)"', t)]
    promos = [{"store": store_id_of(n), "url": base + n, "file": n}
              for n in re.findall(r'"name":"(PromoFull[^"]+\.gz)"', t)]
    stores = re.findall(r'"name":"(Stores[^"]+)"', t)
    return files, (base + sorted(stores)[-1] if stores else None), fetch, promos


def src_hazi_hinam():
    urls = set()
    for page in range(1, 40):  # the price page is paged; t=1 = price files
        t = text(f"https://shop.hazi-hinam.co.il/Prices?p={page}&s=&f=&t=1&d=")
        if ".gz" not in t:
            break
        urls.update(re.findall(r'https://[^"\'\s]+/PriceFull[^"\'\s]+\.gz', t))
    files = [{"store": store_id_of(u), "url": u, "file": u} for u in sorted(urls)]
    purls = set()
    for page in range(1, 40):  # t=2 = promotion files
        t = text(f"https://shop.hazi-hinam.co.il/Prices?p={page}&s=&f=&t=2&d=")
        if ".gz" not in t:
            break
        purls.update(re.findall(r'https://[^"\'\s]+/PromoFull[^"\'\s]+\.gz', t))
    promos = [{"store": store_id_of(u), "url": u, "file": u} for u in sorted(purls)]
    s = text("https://shop.hazi-hinam.co.il/Prices?t=3")
    st = sorted(set(re.findall(r'https://[^"\'\s]+/Stores[^"\'\s]+', s)))
    return files, (st[-1] if st else None), fetch, promos


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
        promos = [{"store": store_id_of(n), "url": base + "/file/d/" + n, "file": n}
                  for n in listing("PromoFull") if n.startswith("PromoFull")]
        stores = sorted((n for n in listing("Stores") if n.startswith("Stores")), key=stamp_of)
        return files, (base + "/file/d/" + stores[-1] if stores else None), lambda url, **kw: fetch(url, opener=op, **kw), promos
    return source


def src_laib(edi):
    """laibcatalog.co.il (Victory, Mahsanei HaShuk, H. Cohen): a JSON file list per chain
    (its 'edi' code); files download from /webapi/<edi>/<name>."""
    def source():
        base = "https://laibcatalog.co.il"
        listing = json.loads(text(f"{base}/webapi/api/getfiles?edi={edi}", timeout=90))
        def of(kind):
            return [x["fileName"] for x in listing if (x.get("fileType") or "").lower() == kind and x.get("fileName")]
        url = lambda n: f"{base}/webapi/{edi}/{n}"
        files = [{"store": store_id_of(n), "url": url(n), "file": n} for n in of("pricefull")]
        promos = [{"store": store_id_of(n), "url": url(n), "file": n} for n in of("promofull")]
        stores = sorted(of("stores") + of("storesfull"), key=stamp_of)
        return files, (url(stores[-1]) if stores else None), fetch, promos
    return source


def src_bina(prefix):
    """<prefix>.binaprojects.com (Zol VeBegadol, Shuk HaIr, Bareket, King Store, Super
    Sapir): MainIO_Hok.aspx lists files by type (1 stores, 4 PriceFull, 5 PromoFull,
    with past days too); each downloads from /Download/<name>."""
    def source():
        base = f"https://{prefix}.binaprojects.com"
        def of(kind):
            body = urllib.parse.urlencode({"WStore": "", "WDate": "", "WFileType": kind}).encode()
            return [x["FileNm"] for x in json.loads(fetch(base + "/MainIO_Hok.aspx", data=body, timeout=90)) if x.get("FileNm")]
        url = lambda n: f"{base}/Download/{n}"
        files = [{"store": store_id_of(n), "url": url(n), "file": n} for n in of(4) if n.lower().startswith("pricefull")]
        promos = [{"store": store_id_of(n), "url": url(n), "file": n} for n in of(5) if n.lower().startswith("promofull")]
        stores = sorted((n for n in of(1) if n.lower().startswith("store")), key=stamp_of)
        return files, (url(stores[-1]) if stores else None), fetch, promos
    return source


def src_superpharm():
    """prices.super-pharm.co.il: a paged table, filtered by file type and day; links go to
    /Download/<name>?bucketName=…. Today's files, or yesterday's early in the morning."""
    base = "https://prices.super-pharm.co.il"
    def listing(kind):
        for days in (0, 1):
            day = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%d/%m/%Y")
            out = []
            for page in range(1, 60):
                q = urllib.parse.urlencode({"Category-equals": kind, "Date-equals": day, "page": page})
                t = text(f"{base}/?{q}")
                links = re.findall(r'href="(/Download/[^"]+)"', t)
                if not links:
                    break
                out += [html.unescape(l) for l in links]
                if f'data-page="{page + 1}"' not in t:
                    break
            if out:
                return out
        return []
    def source():
        name = lambda l: l.split("/Download/", 1)[1].split("?", 1)[0]
        files = [{"store": store_id_of(name(l)), "url": base + l, "file": name(l)} for l in listing("PriceFull")]
        promos = [{"store": store_id_of(name(l)), "url": base + l, "file": name(l)} for l in listing("PromoFull")]
        stores = sorted(listing("Stores"), key=lambda l: stamp_of(name(l)))
        return files, (base + stores[-1] if stores else None), fetch, promos
    return source


def src_netiv_hesed():
    """app.netiv-hesed.com: one page per day (?Date=YYYY-MM-DD) listing that day's files;
    each downloads from /Prices/Download?fileName=<name>. Today's, else yesterday's."""
    base = "https://app.netiv-hesed.com"
    def source():
        names = []
        for days in (0, 1):
            day = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%Y-%m-%d")
            names = re.findall(r'href="/Prices/Download\?fileName=([^"&]+)"', text(f"{base}/?Date={day}"))
            if any(n.startswith("PriceFull") for n in names):
                break
        url = lambda n: f"{base}/Prices/Download?fileName={urllib.parse.quote(n)}"
        files = [{"store": store_id_of(n), "url": url(n), "file": n} for n in names if n.startswith("PriceFull")]
        promos = [{"store": store_id_of(n), "url": url(n), "file": n} for n in names if n.startswith("PromoFull")]
        stores = sorted((n for n in names if n.startswith("Stores")), key=stamp_of)
        return files, (url(stores[-1]) if stores else None), fetch, promos
    return source


def src_json_list(url):
    """A JSON list of files ({type, name, url, date}) - Mishnat Yosef (KT) on Cloudflare."""
    def source():
        rows = json.loads(text(url, timeout=90))
        of = lambda kind: [r for r in rows if r.get("type") == kind and r.get("url")]
        files = [{"store": store_id_of(r["name"]), "url": r["url"], "file": r["name"]} for r in of("PriceFull")]
        promos = [{"store": store_id_of(r["name"]), "url": r["url"], "file": r["name"]} for r in of("PromoFull")]
        stores = sorted(of("Stores"), key=lambda r: r.get("date") or "")
        return files, (stores[-1]["url"] if stores else None), fetch, promos
    return source


CHAINS = [
    {"id": "shufersal", "name": "שופרסל", "color": "#d71f26", "source": src_shufersal},
    {"id": "rami-levy", "name": "רמי לוי", "color": "#0a5bab", "source": src_cerberus("RamiLevi")},
    {"id": "carrefour", "name": "קרפור", "color": "#1d4f9c", "source": src_carrefour},
    {"id": "yochananof", "name": "יוחננוף", "color": "#e4002b", "source": src_cerberus("yohananof")},
    {"id": "osher-ad", "name": "אושר עד", "color": "#f7a600", "source": src_cerberus("osherad")},
    {"id": "hazi-hinam", "name": "חצי חינם", "color": "#f28c00", "source": src_hazi_hinam},
    {"id": "tiv-taam", "name": "טיב טעם", "color": "#00843d", "source": src_cerberus("TivTaam")},
    {"id": "victory", "name": "ויקטורי", "color": "#f47920", "source": src_laib("7290696200003")},
    {"id": "mahsanei-hashuk", "name": "מחסני השוק", "color": "#00843d", "source": src_laib("7290661400001")},
    {"id": "het-cohen", "name": "היפר כהן", "color": "#f2c500", "source": src_laib("7290455000004")},
    {"id": "freshmarket", "name": "פרשמרקט", "color": "#d7141a", "source": src_cerberus("freshmarket")},
    {"id": "keshet", "name": "קשת טעמים", "color": "#2e3192", "source": src_cerberus("Keshet")},
    {"id": "stop-market", "name": "סטופ מרקט", "color": "#c8102e", "source": src_cerberus("Stop_Market")},
    {"id": "politzer", "name": "פוליצר", "color": "#e2231a", "source": src_cerberus("politzer")},
    {"id": "salach-dabach", "name": "סאלח דבאח", "color": "#e30613", "source": src_cerberus("SalachD")},
    {"id": "zol-vebegadol", "name": "זול ובגדול", "color": "#e30613", "source": src_bina("zolvebegadol")},
    {"id": "shuk-hair", "name": "שוק העיר", "color": "#2e9e48", "source": src_bina("shuk-hayir")},
    {"id": "bareket", "name": "ברקת", "color": "#f2a900", "source": src_bina("superbareket")},
    {"id": "king-store", "name": "קינג סטור", "color": "#c8102e", "source": src_bina("kingstore")},
    {"id": "super-sapir", "name": "סופר ספיר", "color": "#3aa655", "source": src_bina("supersapir")},
    {"id": "maayan-2000", "name": "מעיין 2000", "color": "#e31e24", "source": src_bina("maayan2000")},
    {"id": "shefa-birkat-hashem", "name": "שפע ברכת השם", "color": "#00a651", "source": src_bina("shefabirkathashem")},
    {"id": "city-market", "name": "סיטי מרקט", "color": "#e31e24", "source": src_bina("citymarketkiryatgat")},
    {"id": "alonit", "name": "אלונית", "color": "#6ab023", "source": src_cerberus("doralon")},
    {"id": "netiv-hesed", "name": "נתיב החסד", "color": "#d71920", "source": src_netiv_hesed()},
    # Mishnat Yosef (KT, src_json_list("https://list-files.w5871031-kt.workers.dev/")) publishes
    # empty price files for now; add it back when they have products.
    {"id": "super-pharm", "name": "סופר-פארם", "color": "#e2001a", "source": src_superpharm()},
    {"id": "good-pharm", "name": "גוד פארם", "color": "#222222", "source": src_bina("goodpharm")},
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


def _when(v):
    """'2026-11-08T00:00:00.000' / '2026-11-08 00:00' -> datetime, or None."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?", v or "")
    if not m:
        return None
    y, mo, d, h, mi = (int(x) if x else 0 for x in m.groups())
    try:
        return dt.datetime(y, mo, d, h, mi)
    except ValueError:
        return None


def parse_promos(data, now):
    """Active promotions of one branch -> {"all": {code: deal}, "club": {code: deal}}
    deal = (minQty, total | None, rate, description, basketMin): the best deal per product
    (lowest price per item). total is the price for minQty items ("2 ב־38" -> 2, 38.0);
    when only a percentage is given, total is None and rate holds it. Coupons, gifts and
    deals that need a minimum basket are kept apart (basketMin) or left out."""
    out = {"all": {}, "club": {}}
    for p in xml_root(data).iter():
        if p.tag.lower() != "promotion":
            continue
        f = fields(p)
        desc = clean(f.get("promotiondescription", ""))[:80]
        if f.get("additionaliscoupon") == "1" or "קופון" in desc or "מתנה" in desc:
            continue  # needs a coupon, or a free gift: not a price
        start, end = _when(f.get("promotionstartdatetime")), _when(f.get("promotionenddatetime"))
        if (start and start > now) or (end and end < now):
            continue
        club_m = re.search(r"\d+", f.get("clubid", "0"))
        club = bool(club_m and int(club_m.group()) != 0)
        basket = 0
        m = re.search(r"מעל\s*(\d+)", desc)
        if m:
            basket = int(m.group(1))
        for g in p.iter():
            if g.tag.lower() == "group":
                try:
                    basket = max(basket, int(float(fields(g).get("minpurchaseamount") or 0)))
                except ValueError:
                    pass
        for it in p.iter():
            if it.tag.lower() != "promotionitem":
                continue
            fi = fields(it)
            code = fi.get("itemcode", "").lstrip("0") or fi.get("itemcode", "")
            try:
                mq = float(fi.get("minqty") or 1)
                price = float(fi.get("discountedprice") or 0)
                rate = float(fi.get("discountrate") or 0)
            except ValueError:
                continue
            if not code or fi.get("rewardtype", "") in ("", "0"):
                continue
            mq = max(1, round(mq)) if mq >= 1 else 1   # weighted items: per kg
            if price > 0:
                deal = (mq, round(price, 2), 0.0, desc, basket)
            elif rate > 0 and rate < 100:
                deal = (mq, None, rate, desc, basket)
            else:
                continue
            bucket = out["club" if club else "all"]
            unit = (deal[1] / mq) if deal[1] else None
            old = bucket.get(code)
            old_unit = (old[1] / old[0]) if old and old[1] else None
            if old is None or (unit is not None and (old_unit is None or unit < old_unit)):
                bucket[code] = deal
    return out


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


# Real place names that are also everyday address words: "רחוב הפלדה" (street), "שדרות תל חי"
# (avenue), "אזור תעשיה" (industrial zone), "יגאל אלון 57". Never taken from an address;
# taken from a branch name only when the name is just that word ("שדרות", the city).
AMBIGUOUS_CITIES = {"רחוב", "שדרות", "אזור", "נווה", "אלון", "סגולה", "מבקיעים", "גבעות", "צומת"}


def city_in_text(name, address=""):
    """The longest known city name that appears as whole words in the branch name, else its address."""
    for text, from_name in ((name, True), (address, False)):
        words = re.sub(r"[^\w\"'-]+", " ", text or "").split()
        t = " " + " ".join(words) + " "
        for n in _CITY_NAMES:
            if f" {n} " not in t:
                continue
            if n in AMBIGUOUS_CITIES and not (from_name and words[-1] == n):
                continue
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
            city = city_in_text(name, address)
        # "רחוב X, חולון, ישראל" -> "רחוב X" when the city is shown separately
        parts = [p.strip() for p in address.split(",") if p.strip() and p.strip() not in (city, "ישראל")]
        out[str(int(sid))] = (name, city, ", ".join(parts))
    return out


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_chain(chain, out_dir, log):
    files, stores_url, get, promo_files = chain["source"]()
    latest_promo = {}
    for f in promo_files:
        if f["store"] and (f["store"] not in latest_promo or stamp_of(f["file"]) > stamp_of(latest_promo[f["store"]]["file"])):
            latest_promo[f["store"]] = f
    now = dt.datetime.now()
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
        items = parse_prices(get(f["url"], timeout=180))
        promos = {"all": {}, "club": {}}
        pf = latest_promo.get(f["store"])
        if pf and len(items) >= MIN_ITEMS:
            try:
                promos = parse_promos(get(pf["url"], timeout=180), now)
            except Exception as e:  # noqa: BLE001 - prices still count without deals
                log(f"  ! promotions failed for branch {f['store']}: {e}")
        return f, (items, promos)

    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for fut in cf.as_completed([ex.submit(work, f) for f in latest.values()]):
            try:
                f, items = fut.result()
            except Exception as e:  # noqa: BLE001 - skip a broken branch file
                log(f"  ! branch file failed: {e}")
                continue
            items, promos = items
            if len(items) >= MIN_ITEMS:
                branches[f["store"]] = (f, items, promos)
    if not branches:
        raise RuntimeError("no branch file with enough items")

    # Common (most frequent) price and a representative name per product.
    prices, names = collections.defaultdict(collections.Counter), {}
    for _, items, _ in branches.values():
        for code, (name, price, brand, weighted) in items.items():
            prices[code][price] += 1
            if code not in names or len(name) > len(names[code][0]):
                names[code] = (name, brand, weighted)
    common = {code: c.most_common(1)[0][0] for code, c in prices.items()}

    # Deals per branch, final: a percentage becomes a price (from that branch's regular
    # price), and anything that isn't actually cheaper is dropped.
    def finalize(its, promos):
        out = {}
        for kind in ("all", "club"):
            out[kind] = {}
            for code, (mq, total, rate, desc, basket) in promos.get(kind, {}).items():
                if code not in its:
                    continue
                regular = its[code][1]
                if total is None:
                    total = round(regular * mq * (1 - rate / 100), 2)
                if total <= 0 or total / mq >= regular - 0.005:
                    continue
                out[kind][code] = (mq, total, desc, basket)
        return out
    branch_deals = {sid: finalize(its, promos) for sid, (_, its, promos) in branches.items()}

    # The deal most branches run (if more than half do) belongs to the chain; branches
    # store only how they differ.
    def common_deals(kind):
        counts = collections.defaultdict(collections.Counter)
        for d in branch_deals.values():
            for code, deal in d[kind].items():
                counts[code][deal] += 1
        half = len(branch_deals) / 2
        return {code: c.most_common(1)[0][0] for code, c in counts.items() if c.most_common(1)[0][1] > half}
    common_all, common_club = common_deals("all"), common_deals("club")
    promo_ids = {}
    def enc(deal):
        mq, total, desc, basket = deal
        di = promo_ids.setdefault(desc, len(promo_ids))
        return [mq, total, di] + ([basket] if basket else [])
    deals_json = {code: enc(d) for code, d in sorted(common_all.items())}
    club_json = {code: enc(d) for code, d in sorted(common_club.items())}

    def deal_diff(mine, chain_wide):
        out = {}
        for code in set(mine) | set(chain_wide):
            b, c = mine.get(code), chain_wide.get(code)
            if b != c:
                out[code] = enc(b) if b else 0
        return out
    branch_diffs = {sid: (deal_diff(d["all"], common_all), deal_diff(d["club"], common_club)) for sid, d in branch_deals.items()}

    updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    items = sorted(([code, n, common[code], b, w] for code, (n, b, w) in names.items()), key=lambda it: it[1])
    promos_json = [None] * len(promo_ids)
    for desc, i in promo_ids.items():
        promos_json[i] = desc
    write_json(os.path.join(out_dir, f"{chain['id']}.json"),
               {"id": chain["id"], "name": chain["name"], "updated": updated, "items": items,
                "promos": promos_json, "deals": deals_json, "club": club_json})
    log(f"  deals: {len(deals_json)} for everyone, {len(club_json)} club (chain-wide), {len(promos_json)} promotions")

    bdir = os.path.join(out_dir, chain["id"])
    if os.path.isdir(bdir):
        shutil.rmtree(bdir)
    os.makedirs(bdir)
    stores = []
    for sid, (f, its, _) in branches.items():
        diff = {code: p for code, (_, p, _, _) in its.items() if p != common[code]}
        d_all, d_club = branch_diffs[sid]
        write_json(os.path.join(bdir, f"{sid}.json"),
                   {"p": diff, **({"d": d_all} if d_all else {}), **({"c": d_club} if d_club else {})})
        name, city, address = store_info.get(sid, (f.get("name") or f"סניף {sid}", "", ""))
        stores.append([sid, name, city, len(its), address])
    stores.sort(key=lambda s: (s[2] or "תתת", s[1]))
    write_json(os.path.join(bdir, "stores.json"), {"updated": updated, "stores": stores})

    return {"id": chain["id"], "name": chain["name"], "color": chain["color"],
            "count": len(items), "branches": len(stores), "updated": updated}


# ---------------------------------------------------------------------------
# Branch locations
# ---------------------------------------------------------------------------
# Each branch's address is looked up once on OpenStreetMap (Nominatim) and remembered in
# <out>/geo.json, so daily runs only look up new or changed addresses. Nominatim's rules:
# at most one request per second, and an identifying User-Agent.

GEO_URL = "https://nominatim.openstreetmap.org/search?"
GEO_UA = "shopping-list-catalog/2.0 (branch locator; one-time lookups, cached)"


def _geo_query(params):
    url = GEO_URL + urllib.parse.urlencode({**params, "format": "jsonv2", "countrycodes": "il", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": GEO_UA, "Accept-Language": "he"})
    with urllib.request.urlopen(req, timeout=30) as r:
        hits = json.loads(r.read())
    time.sleep(1.1)
    return [round(float(hits[0]["lat"]), 5), round(float(hits[0]["lon"]), 5)] if hits else None


def _km(a, b):
    r = 3.141592653589793 / 180
    h = (math.sin((b[0] - a[0]) * r / 2) ** 2
         + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def geocode_stores(out_dir, log, budget=1500):
    """Add [lat, lon, precision] to every branch row in <out>/<chain>/stores.json.
    precision: "a" = street address, "c" = city centre only. Unknown branches get no location."""
    cache_path = os.path.join(out_dir, "geo.json")
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fh:
            cache = json.load(fh)
    used = 0

    def lookup(key, params):
        nonlocal used
        if key in cache:
            return cache[key]
        if used >= budget:
            return None  # out of lookups this run; try again tomorrow (not cached)
        used += 1
        try:
            cache[key] = _geo_query(params)
        except Exception as e:  # noqa: BLE001 - network trouble: skip, retry next run
            log(f"  geo: {key}: {e}")
            return None
        return cache[key]

    found = {"a": 0, "c": 0, None: 0}
    for name in sorted(os.listdir(out_dir)):
        path = os.path.join(out_dir, name, "stores.json")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        for row in doc["stores"]:
            city, address = row[2], row[4]
            loc, prec = None, None
            centre = lookup(f"|{city}", {"city": city}) if city else None
            if address and city:
                loc = lookup(f"{address}|{city}", {"street": address, "city": city})
                if not loc:
                    loc = lookup(f"q:{address}, {city}", {"q": f"{address}, {city}"})
                # A street of the same name in another town: trust the city instead.
                if loc and centre and _km(loc, centre) > 12:
                    loc = None
                prec = "a" if loc else None
            if not loc and centre:
                loc, prec = centre, "c"
            del row[5:]
            if loc:
                row += [loc[0], loc[1], prec]
            found[prec if loc else None] += 1
        write_json(path, doc)

    write_json(cache_path, cache)
    log(f"✓ locations: {found['a']} by address, {found['c']} by city, {found[None]} unknown ({used} lookups)")


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


def write_common(out, chain_ids, log):
    """common.json: products (real barcodes) sold at two chains or more, for choosing a
    product while typing an item, whichever store is selected (or none). Each row:
    [barcode, name, chains bitmask (bit k = chains[k]), lowest price].
    The name is the fullest one any chain uses (chains cut names short)."""
    seen = {}
    ids = []
    for cid in chain_ids:
        path = os.path.join(out, f"{cid}.json")
        if not os.path.exists(path):
            continue
        k = len(ids)
        ids.append(cid)
        with open(path, encoding="utf-8") as fh:
            items = json.load(fh).get("items", [])
        for it in items:
            code, name, price = it[0], it[1], it[2]
            if not re.fullmatch(r"\d{12,14}", code) or re.match(r"0*2", code):
                continue  # in-store codes (produce, deli) differ per chain
            row = seen.setdefault(code, [code, name, 0, price])
            row[2] |= 1 << k
            if len(name) > len(row[1]):
                row[1] = name
            row[3] = min(row[3], price)
    rows = [r for r in seen.values() if bin(r[2]).count("1") >= 2]
    rows.sort(key=lambda r: (-bin(r[2]).count("1"), r[1]))
    with open(os.path.join(out, "common.json"), "w", encoding="utf-8") as fh:
        json.dump({"chains": ids, "items": rows}, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"✓ common products: {len(rows)} sold at 2+ chains")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog")
    ap.add_argument("--only", nargs="*", help="chain ids to build (default: all)")
    ap.add_argument("--geocode-only", action="store_true", help="only add branch locations to existing files")
    ap.add_argument("--common-only", action="store_true", help="only rebuild common.json from existing files")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    log = lambda s: print(s, flush=True)
    if args.geocode_only:
        geocode_stores(args.out, log, budget=10**6)
        return
    if args.common_only:
        write_common(args.out, [c["id"] for c in CHAINS], log)
        return

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

    try:
        write_common(args.out, [c["id"] for c in CHAINS], log)
    except Exception as e:  # noqa: BLE001 - the product list is a bonus; never fail the price build
        log(f"✗ common products: {e}")

    try:
        geocode_stores(args.out, log)
    except Exception as e:  # noqa: BLE001 - locations are a bonus; never fail the price build
        log(f"✗ locations: {e}")

    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump({"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "chains": results},
                  fh, ensure_ascii=False, indent=1)
    if not results:
        sys.exit(1)
    if failures:
        print(f"{failures} chain(s) failed; kept previous data where available", file=sys.stderr)


if __name__ == "__main__":
    main()
