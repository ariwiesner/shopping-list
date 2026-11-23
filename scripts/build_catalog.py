#!/usr/bin/env python3
"""Build small per-chain price catalogs from Israeli price-transparency files.

Israeli supermarket chains must publish every branch's full price list
("PriceFull" XML files). For each chain we pick its largest branch (the one
with the most products), download that file, and write a compact JSON catalog:

    <out>/index.json          list of chains (id, name, color, count, updated)
    <out>/<chain>.json        { id, name, store, updated, items: [[code, name, price, brand, weighted], ...] }

Standard library only, so it runs anywhere (locally or in GitHub Actions):
    python scripts/build_catalog.py --out catalog
"""
import argparse
import datetime as dt
import gzip
import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

UA = {"User-Agent": "Mozilla/5.0 (compatible; shopping-list-catalog/1.0)"}
MIN_ITEMS = 500  # skip tiny branch files (kiosks, online-only stubs)


def get(url, timeout=90, method="GET"):
    req = urllib.request.Request(url, headers=UA, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r if method == "HEAD" else r.read()


def size_of(text):
    m = re.match(r"\s*([\d.,]+)\s*(B|KB|MB|GB)", text or "", re.I)
    if not m:
        return None
    mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}[m.group(2).upper()]
    return int(float(m.group(1).replace(",", "")) * mult)


def head_size(url):
    try:
        req = urllib.request.Request(url, headers=UA, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Sources: each returns a list of (download_url, size_bytes_or_None, store_label)
# ---------------------------------------------------------------------------

def list_shufersal():
    files = []
    for page in range(1, 80):
        t = get(f"https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page={page}").decode("utf-8", "replace")
        rows = re.findall(r'<tr class="webgrid-(?:row-style|alternating-row)">(.*?)</tr>', t, re.S)
        if not rows:
            break
        for r in rows:
            link = re.search(r'href="([^"]+)"', r)
            cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<td>(.*?)</td>", r, re.S)]
            if link and len(cells) >= 6:
                files.append((html.unescape(link.group(1)), size_of(cells[2]), html.unescape(cells[5])))
        if f"page={page + 1}" not in t:
            break
    return files


def list_carrefour():
    t = get("https://prices.carrefour.co.il/").decode("utf-8", "replace")
    path = re.search(r"const path = '(\d+)'", t).group(1)
    files = []
    for name, size in re.findall(r'\{"name":"(PriceFull[^"]+\.gz)","size":(\d+)', t):
        store = name.split("-")[2] if name.count("-") >= 3 else ""
        files.append((f"https://prices.carrefour.co.il/{path}/{name}", int(size), f"סניף {store}"))
    return files


def list_hazi_hinam():
    t = get("https://shop.hazi-hinam.co.il/Prices").decode("utf-8", "replace")
    urls = sorted(set(re.findall(r'https://[^"\'\s]+/PriceFull[^"\'\s]+\.gz', t)))
    files = []
    for u in urls[:80]:
        store = u.rsplit("/", 1)[-1].split("-")[2]
        files.append((u, head_size(u), f"סניף {store}"))
    return files


CHAINS = [
    {"id": "shufersal", "name": "שופרסל", "color": "#d71f26", "list": list_shufersal},
    {"id": "carrefour", "name": "קרפור", "color": "#1d4f9c", "list": list_carrefour},
    {"id": "hazi-hinam", "name": "חצי חינם", "color": "#f28c00", "list": list_hazi_hinam},
]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_price_file(data):
    raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        root = ET.fromstring(raw.decode("utf-8-sig", "replace").encode("utf-8"))

    items = {}
    for el in root.iter():
        if el.tag.lower() != "item":
            continue
        f = {c.tag.lower(): (c.text or "").strip() for c in el}
        name = re.sub(r"\s+", " ", f.get("itemname", "")).strip()
        code = f.get("itemcode", "")
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
        items[code] = [code, name, price, brand[:40], weighted]
    return list(items.values())


def build_chain(chain, out_dir):
    files = [f for f in chain["list"]() if f[0]]
    if not files:
        raise RuntimeError("no PriceFull files found")
    files.sort(key=lambda f: f[1] or 0, reverse=True)
    for url, size, store in files[:4]:
        items = parse_price_file(get(url, timeout=180))
        if len(items) >= MIN_ITEMS:
            break
    else:
        raise RuntimeError("no branch file with enough items")

    items.sort(key=lambda it: it[1])
    updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    doc = {"id": chain["id"], "name": chain["name"], "store": store, "updated": updated, "items": items}
    with open(os.path.join(out_dir, f"{chain['id']}.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    return {"id": chain["id"], "name": chain["name"], "color": chain["color"], "store": store,
            "count": len(items), "updated": updated}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog")
    ap.add_argument("--only", nargs="*", help="chain ids to build (default: all)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

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
        try:
            info = build_chain(chain, args.out)
            print(f"✓ {chain['id']}: {info['count']} items ({info['store']})")
            results.append(info)
        except Exception as e:  # noqa: BLE001 - report and continue with other chains
            failures += 1
            print(f"✗ {chain['id']}: {e}", file=sys.stderr)
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
