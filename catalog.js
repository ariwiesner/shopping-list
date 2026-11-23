// Store catalogs: loading, product search and price estimates.
//
// Catalog files are built daily by scripts/build_catalog.py (GitHub Action) and
// published on the `catalog-data` branch. On localhost we read ./catalog/ instead,
// so you can test with files built locally.
//
// Item pricing, in order of precedence:
//   1. manual   - the user typed a price for the item
//   2. exact    - the item is linked to a product (barcode) found in this store
//   3. estimate - typical (median) price of products whose name starts with the item's name
//   4. none     - nothing similar in this store

const REMOTE = "https://raw.githubusercontent.com/ariwiesner/shopping-list/catalog-data/";
const LOCAL = "catalog/";
const BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? LOCAL : REMOTE;
const CACHE = "basket-catalog-v1";
const hasCaches = typeof caches !== "undefined";

export async function fetchJson(path) {
  const url = BASE + path;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    if (hasCaches) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(url, copy)).catch(() => {});
    }
    return await res.json();
  } catch (e) {
    // Offline: fall back to the last copy we saved.
    if (hasCaches) {
      const hit = await (await caches.open(CACHE)).match(url);
      if (hit) return hit.json();
    }
    throw e;
  }
}

// ---------- Hebrew-friendly text matching ----------
export const norm = (s) =>
  String(s || "").toLowerCase()
    .replace(/["'״׳`]/g, "")
    .replace(/[^\p{L}\p{N}%.]+/gu, " ")
    .trim();

// Rough Hebrew stem so singular/plural match: עגבניות/עגבניה → עגבני, ביצים/ביצה → ביצ
export function stem(w) {
  if (w.length >= 4 && /(ים|ות)$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && /ה$/.test(w)) return w.slice(0, -1);
  return w;
}
const words = (s) => norm(s).split(" ").filter(Boolean);

// Words that don't change what a product *is*: "בננה מובחרת" is just a banana,
// "בצל יבש" is a regular onion, "גזר בתפזורת" is loose carrots.
const FILLER = new Set([
  "מובחר", "מובחרת", "מובחרים", "טרי", "טריה", "טריים", "טריות", "בתפזורת", "תפזורת",
  "רגיל", "רגילה", "רגילים", "יבש", "יבשה", "במשקל", "משקל", "לקג", "קג", "ק.ג", "ק", "יח", "יח.", "יחידה", "יחידות",
  "ארוז", "ארוזה", "ארוזים", "ארוזות", "גרם", "גר", "ג", "ליטר", "ל", "מל",
]);
// Query words the stemmer left alone ("חלב") must appear as-is in a product name:
// otherwise "חלב" would match "חלבה" (halva), whose stem is also "חלב".
const unstemmed = (s) => words(s).filter((w) => !FILLER.has(w) && stem(w) === w);
const hasWords = (name, need) => { if (!need.length) return true; const ws = words(name); return need.every((w) => ws.includes(w)); };
const coreOf = (s) => {
  const all = words(s);
  const core = all.filter((w) => !FILLER.has(w)).map(stem).sort();
  return { core, filler: all.length - core.length };
};

// ---------- Loading ----------
let indexPromise = null;
const chains = new Map(); // id -> Promise<catalog>

export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchJson("index.json").catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

// A chain file → a searchable catalog. (loadChain caches it; the price-comparison
// worker calls this directly so each chain can be dropped from memory after use.)
export function parseChain(doc) {
  const byCode = new Map();
  const entries = doc.items.map(([code, name, price, brand, weighted]) => {
    const it = { code, name, price, brand, weighted: !!weighted };
    byCode.set(code, it);
    const { core, filler } = coreOf(name);
    return { it, stems: words(name).map(stem), coreKey: core.join(" "), filler };
  });
  return { ...doc, byCode, entries, estimates: new Map(), resolved: new Map() };
}

export function loadChain(id) {
  if (!chains.has(id)) {
    const p = fetchJson(`${encodeURIComponent(id)}.json`).then(parseChain);
    p.catch(() => chains.delete(id));
    chains.set(id, p);
  }
  return chains.get(id);
}

// ---------- Branches ----------
// Chain files carry each product's *common* price; a branch file lists only the
// prices that differ in that branch. withBranch() returns a catalog with those applied.
// Rows: [id, name, city, itemCount, address, lat?, lon?, precision?]
// precision "a" = located by street address, "c" = only the city is known.
export const parseStores = (d) =>
  d.stores.map(([id, name, city, count, address, lat, lon, prec]) => ({
    id, name, city: city || "", count, address: address || "",
    ...(typeof lat === "number" ? { lat, lon, prec } : {}),
  }));

const storeLists = new Map();
export function loadStores(chainId) {
  if (!storeLists.has(chainId)) {
    const p = fetchJson(`${encodeURIComponent(chainId)}/stores.json`).then(parseStores);
    p.catch(() => storeLists.delete(chainId));
    storeLists.set(chainId, p);
  }
  return storeLists.get(chainId);
}

// The chain catalog with one branch's differing prices applied.
export function applyBranch(cat, storeId, diff) {
  const byCode = new Map();
  const entries = cat.entries.map((e) => {
    const price = diff[e.it.code];
    const it = price === undefined ? e.it : { ...e.it, price };
    byCode.set(it.code, it);
    return it === e.it ? e : { ...e, it };
  });
  return { ...cat, branch: storeId, byCode, entries, estimates: new Map(), resolved: new Map() };
}

const branchCats = new Map(); // `${chain}/${store}` -> Promise<catalog>
export function loadBranch(cat, storeId) {
  const key = `${cat.id}/${storeId}`;
  if (!branchCats.has(key)) {
    const p = fetchJson(`${encodeURIComponent(cat.id)}/${encodeURIComponent(storeId)}.json`)
      .then(({ p: diff }) => applyBranch(cat, storeId, diff));
    p.catch(() => branchCats.delete(key));
    branchCats.set(key, p);
  }
  return branchCats.get(key);
}

// ---------- Search ----------
// Every query word must match the start of some word in the product name.
// Exact word matches score higher, and a match on the product's first word highest.
export function search(cat, query, limit = 40) {
  const q = words(query).map(stem);
  if (!q.length) return [];
  const out = [];
  for (const e of cat.entries) {
    let score = 0;
    for (const t of q) {
      let best = 0;
      for (let i = 0; i < e.stems.length; i++) {
        const w = e.stems[i];
        const s = w === t ? 3 : w.startsWith(t) ? 1 : 0;
        if (s) best = Math.max(best, s + (i === 0 ? 2 : 0));
      }
      if (!best) { score = 0; break; }
      score += best;
    }
    if (score) out.push({ e, score });
  }
  // Best match first; packaged products before sold-by-weight (per-kg) ones; then shorter names.
  out.sort((a, b) => b.score - a.score || a.e.it.weighted - b.e.it.weighted
    || a.e.it.name.length - b.e.it.name.length || a.e.it.price - b.e.it.price);
  return out.slice(0, limit).map((x) => x.e.it);
}

// The product an item name clearly means, or null if it's ambiguous.
// "בננה" → the store's product named "בננה" (or "בננה מובחרת"); "גבינה" → null (dozens of kinds).
export function resolve(cat, name) {
  const key = norm(name);
  if (cat.resolved.has(key)) return cat.resolved.get(key);
  const { core } = coreOf(name);
  let product = null;
  if (core.length) {
    const coreKey = core.join(" ");
    const need = unstemmed(name);
    const cands = cat.entries.filter((e) => e.coreKey === coreKey && hasWords(e.it.name, need));
    if (cands.length) {
      // Prefer the plainest name ("בננה" over "בננה ארוזה"), then loose produce, then the middle price.
      const minFiller = Math.min(...cands.map((c) => c.filler));
      const plain = cands.filter((c) => c.filler === minFiller).map((c) => c.it);
      const loose = plain.filter((p) => p.weighted);
      const pool = (loose.length ? loose : plain).sort((a, b) => a.price - b.price);
      product = pool[Math.floor((pool.length - 1) / 2)];
      // A per-kg product far pricier than the packaged ones of that name is a bulk or deli
      // item (coffee beans at ₪120/kg vs ₪20 jars), not what a plain "קפה" means.
      if (product.weighted) {
        const packed = estimatePool(cat, name).filter((p) => !p.weighted).map((p) => p.price).sort((a, b) => a - b);
        if (packed.length >= 3 && product.price > 3 * packed[packed.length >> 1]) product = null;
      }
    }
  }
  cat.resolved.set(key, product);
  return product;
}

// The products a vague item name like "גבינה" could mean.
// Prefers packaged products; per-kg prices only if that's all there is (e.g. produce).
export function estimatePool(cat, name) {
  const all = words(name);
  if (!all.length) return [];
  const q = all.map(stem);
  const first = stem(all[0]) === all[0] ? all[0] : null; // unstemmed: must match as-is
  // Products whose name begins with the item's first word, and contain the rest.
  let pool = cat.entries
    .filter((e) => e.stems[0] === q[0] && q.slice(1).every((t) => e.stems.some((w) => w.startsWith(t)))
      && (!first || words(e.it.name)[0] === first))
    .map((e) => e.it);
  if (!pool.length) pool = search(cat, name, 15);
  const packaged = pool.filter((p) => !p.weighted);
  return packaged.length ? packaged : pool;
}

// Typical price for a vague item name like "גבינה".
export function estimate(cat, name) {
  const key = norm(name);
  if (cat.estimates.has(key)) return cat.estimates.get(key);
  const pool = estimatePool(cat, name);
  let result = null;
  if (pool.length) {
    const prices = pool.map((p) => p.price).sort((a, b) => a - b);
    const at = (f) => prices[Math.min(prices.length - 1, Math.floor(f * prices.length))];
    result = { price: at(0.5), low: at(0.1), high: at(0.9), count: pool.length, weighted: pool.every((p) => p.weighted) };
  }
  cat.estimates.set(key, result);
  return result;
}

// Price info for one list item in a loaded catalog (cat may be null).
// choice: a remembered product for this item name ({ code, name }) or null.
export function priceItem(cat, item, choice) {
  const qty = item.qty || 1;
  if (typeof item.price === "number" && item.price > 0) {
    return { kind: "manual", unit: item.price, total: round(item.price * qty) };
  }
  if (!cat) return { kind: "none", total: 0 };
  const code = item.barcode || choice?.code;
  const p = code && cat.byCode.get(code);
  if (p) return { kind: "exact", unit: p.price, total: round(p.price * qty), product: p, weighted: p.weighted, learned: !item.barcode };
  // Not linked to a product here (or the chosen product isn't sold in this store):
  // first by the chosen product's name, then by the item's own, plainer name, since
  // chains word product names differently ("ביצים L 12 רגיל" may not exist, "ביצים" will).
  const missingProduct = !!code;
  for (const n of [...new Set([item.productName, item.name].filter(Boolean))]) {
    const auto = resolve(cat, n);
    if (auto) return { kind: "exact", unit: auto.price, total: round(auto.price * qty), product: auto, weighted: auto.weighted, auto: true, missingProduct, matchedBy: n };
    const est = estimate(cat, n);
    if (est) return { kind: "estimate", unit: est.price, total: round(est.price * qty), ...est, missingProduct };
  }
  return { kind: "none", total: 0, missingProduct };
}

export const round = (n) => Math.round(n * 100) / 100;
export const money = (n) => "₪" + (Math.round(n * 100) / 100).toLocaleString("he-IL", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
