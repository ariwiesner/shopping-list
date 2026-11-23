// Price comparison, run off the main thread so the app never freezes.
//
// For every chain: load its catalog, price the list at the chain's common prices,
// then at the few branches nearest the user, keep only the totals, and drop the
// catalog before moving to the next chain, so memory stays at about one chain.
//
// In:  { id, items, choices, here: {lat, lon} | null, maxKm, current: {chain, branch} | null }
// Out: { type: "progress", id, done, total, name }
//      { type: "result", id, result } | { type: "error", id, message }

import { fetchJson, parseChain, parseStores, applyBranch, priceItem, estimatePool, norm, round } from "./catalog.js";

const PER_CHAIN = 4; // nearest branches checked per chain

// Straight-line distance in km.
function km(a, b) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Per item in one store: { total, exact, perKg, est, pool } or null.
//   exact: the item's chosen product is sold here (same barcode, or same name)
//   perKg: no chosen product, and the name clearly means one loose product (bananas)
//   pool:  the products the item's plain name could mean here, with prices, used to
//          measure how expensive this store is for that kind of product
// Items with a price the user typed are left out: they cost the same everywhere.
function pricesIn(cat, items, choices) {
  return items.map((it) => {
    if (typeof it.price === "number" && it.price > 0) return null;
    const p = priceItem(cat, it, choices[norm(it.name)] || null);
    const priced = p.kind === "exact" || p.kind === "estimate";
    const pool = estimatePool(cat, it.name).map((x) => [x.code, x.price]);
    if (!priced && !pool.length) return null;
    return {
      total: priced ? p.total : null,
      // Its chosen product, or the same product under this chain's wording.
      exact: p.kind === "exact" && (!p.auto || (!!it.productName && p.matchedBy === it.productName)),
      barcode: p.kind === "exact" && !p.auto,
      perKg: p.kind === "exact" && !!p.auto && !!p.weighted,
      est: p.kind === "estimate",
      pool,
    };
  });
}

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Each chain words and stocks products differently, so pricing "the same item" needs care:
// - A vague item ("גבינה") means different products in each chain; a chain with many
//   premium cheeses would look expensive. So: products sold in at least two chains get a
//   reference price (their median across chains), each store a price level for that kind
//   of product (median of its price ÷ reference), and the item costs reference × level.
// - A chosen product ("ביצים L 12 תנובה") costs its real price where it's sold; where it
//   isn't, a comparable product costs its typical price × that store's level for the kind.
//   (Otherwise every other chain would just be "missing" it and the chosen store would win.)
// - Loose produce priced per kg in every chain is already comparable as is.
function harmonize(items, chains, branches) {
  const stores = [...chains, ...branches];
  items.forEach((it, i) => {
    const qty = it.qty || 1;
    const here = chains.map((c) => c.prices[i]).filter(Boolean);
    if (!here.length) return;

    const seen = new Map(); // code -> prices across chains
    for (const p of here) for (const [code, price] of p.pool) {
      if (!seen.has(code)) seen.set(code, []);
      seen.get(code).push(price);
    }
    const ref = new Map([...seen].filter(([, ps]) => ps.length >= 2).map(([code, ps]) => [code, median(ps)]));
    const level = (p) => {
      const ls = (p?.pool || []).filter(([code]) => ref.has(code)).map(([code, price]) => price / ref.get(code));
      return ls.length ? median(ls) : null;
    };
    const set = (x, total) => { x.prices[i] = { ...x.prices[i], total: round(total), est: true }; };

    const anchors = chains.map((c) => c.prices[i]).filter((p) => p?.exact);
    if (anchors.length) {
      // Chosen product: its typical price at an average store, from where it's sold.
      // (Same-barcode prices are the surest guide; a same-name match only prices its own chain.)
      const sure = anchors.some((p) => p.barcode) ? anchors.filter((p) => p.barcode) : anchors;
      const typical = median(sure.map((p) => p.total / qty / (level(p) || 1)));
      for (const x of stores) {
        const p = x.prices[i];
        if (p?.exact) continue;
        const l = level(p);
        if (l) set(x, typical * l * qty);
        if (x.prices[i]) x.prices[i].sub = true; // the chosen product isn't sold here: a similar one is priced
      }
      return;
    }
    const named = here.filter((p) => p.total != null);
    if (named.length && named.every((p) => p.perKg)) return;
    if (!ref.size) return;
    const base = median([...ref.values()]);
    for (const x of stores) {
      const l = level(x.prices[i]);
      if (l) set(x, base * l * qty);
    }
  });
  for (const x of stores) x.prices = x.prices.map((p) => (p && p.total != null ? { total: p.total, est: p.est, sub: !!p.sub } : null));
}

self.onmessage = async ({ data }) => {
  const { id, items, choices, here, maxKm, current, anchor } = data;
  try {
    const index = await fetchJson("index.json");
    const chains = [], branches = [];
    let n = 0;
    for (const c of index.chains) {
      self.postMessage({ type: "progress", id, done: n, total: index.chains.length, name: c.name });
      let cat;
      try { cat = parseChain(await fetchJson(`${encodeURIComponent(c.id)}.json`)); }
      catch (e) { console.warn("Skipping chain", c.id, e); n++; continue; }

      let stores = [];
      try { stores = parseStores(await fetchJson(`${encodeURIComponent(c.id)}/stores.json`)); } catch (_) {}
      const located = here ? stores.filter((s) => s.lat !== undefined).map((s) => ({ ...s, km: km(here, s) })) : [];
      located.sort((a, b) => a.km - b.km);

      chains.push({
        id: c.id, name: c.name, color: c.color,
        prices: pricesIn(cat, items, choices),
        nearest: located[0] ? strip(located[0]) : null,
      });

      // Nearest branches within reach, plus the user's own branch wherever it is.
      const pick = located.filter((s) => s.km <= maxKm).slice(0, PER_CHAIN);
      if (current?.chain === c.id && current.branch && !pick.some((s) => s.id === current.branch)) {
        const mine = located.find((s) => s.id === current.branch) || stores.find((s) => s.id === current.branch);
        if (mine) pick.push(mine);
      }
      for (const s of pick) {
        try {
          const { p: diff } = await fetchJson(`${encodeURIComponent(c.id)}/${encodeURIComponent(s.id)}.json`);
          branches.push({ chain: c.id, chainName: c.name, ...strip(s), prices: pricesIn(applyBranch(cat, s.id, diff), items, choices) });
        } catch (e) { console.warn("Skipping branch", c.id, s.id, e); }
      }
      cat = null; // let this chain's catalog go before loading the next
      n++;
    }
    self.postMessage({ type: "result", id, result: summarize(items, chains, branches, current, anchor) });
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e?.message || e) });
  }
};

const strip = (s) => ({
  id: s.id, name: s.name, city: s.city, address: s.address,
  lat: s.lat, lon: s.lon, prec: s.prec, km: s.km === undefined ? null : round(s.km),
});

// Totals on a fair basis. Items no chain has (or with a typed price) are left out
// for everyone. A store missing an item the others have can't be "the cheapest"
// (you couldn't buy the whole list there); it is still listed with what it lacks.
function summarize(items, chains, branches, current, anchor) {
  harmonize(items, chains, branches);
  const stores = [...chains, ...branches];
  const mine = current?.chain && (
    (current.branch && branches.find((x) => x.chain === current.chain && x.id === current.branch)) ||
    (!current.branch && chains.find((x) => x.id === current.chain)));

  items.forEach((it, i) => {
    // A price the user typed costs the same in every store.
    if (typeof it.price === "number" && it.price > 0) {
      for (const x of stores) x.prices[i] = { total: round(it.price * (it.qty || 1)), est: false };
      return;
    }
    // Anchor on the list: the user's own store costs exactly what the list says, and every
    // other store costs that × how much more or less it is there (by the measures above).
    // So "your purchase" always matches the list total, and savings are against it.
    const a = anchor?.[i], ref = mine?.prices[i]?.total;
    if (!mine || !(a > 0)) return;
    for (const x of stores) {
      if (x === mine) continue;
      const p = x.prices[i];
      if (p && ref > 0) x.prices[i] = { ...p, total: round(a * (p.total / ref)) };
    }
    mine.prices[i] = { total: a, est: !!mine.prices[i]?.est, sub: !!mine.prices[i]?.sub };
  });

  const counted = items.map((_, i) => chains.some((c) => c.prices[i]));
  const total = (prices) => {
    let sum = 0, missing = 0, est = false, subs = 0;
    prices.forEach((p, i) => {
      if (!counted[i]) return;
      if (!p) { missing++; return; }
      sum += p.total; est ||= p.est; if (p.sub) subs++;
    });
    return { total: round(sum), missing, est, subs };
  };
  const out = {
    itemCount: items.length,
    counted: counted.filter(Boolean).length,
    chains: chains.map(({ prices, ...c }) => ({ ...c, ...total(prices) })),
    branches: branches.map(({ prices, ...b }) => ({ ...b, ...total(prices) })),
    current: null,
  };
  if (current?.chain) {
    const b = current.branch && out.branches.find((x) => x.chain === current.chain && x.id === current.branch);
    const c = out.chains.find((x) => x.id === current.chain);
    out.current = b ? { ...b, kind: "branch" } : c ? { ...c, chain: c.id, chainName: c.name, kind: "chain" } : null;
  }
  return out;
}
