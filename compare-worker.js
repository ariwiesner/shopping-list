// Price comparison, run off the main thread so the app never freezes.
//
// For every chain: load its catalog, price the list at the chain's common prices,
// then at the few branches nearest the user, keep only the totals, and drop the
// catalog before moving to the next chain, so memory stays at about one chain.
//
// In:  { id, items, choices, here: {lat, lon} | null, maxKm, current: {chain, branch} | null }
// Out: { type: "progress", id, done, total, name }
//      { type: "result", id, result } | { type: "error", id, message }

import { fetchJson, parseChain, parseStores, applyBranch, priceItem, priceByReference, chainOffer, referencesFrom, norm, round } from "./catalog.js";

const PER_CHAIN = 4; // nearest branches checked per chain

// Straight-line distance in km.
function km(a, b) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Per item in one store, priced exactly as the list prices it in that store (so what the
// comparison promises is what the list shows after switching): { total, est, sub } or null.
//   est: a general item ("גבינה"), priced at a typical product of that kind
//   sub: the product the user chose isn't sold here; a similar one is priced instead
//   ref: a general item priced on the same product as at the other chains (refs[i])
function pricesIn(cat, items, choices, club = false, refs = []) {
  const price = (it, i, opts) => {
    const choice = choices[norm(it.kind || it.name)] || null;
    return refs[i]?.length && !choice ? priceByReference(cat, it, refs[i], opts) : priceItem(cat, it, choice, opts);
  };
  // Deals as on the list: first without basket-minimum deals to get the total, then with them.
  const basket = items.reduce((a, it, i) => a + price(it, i, { club, basket: 0 }).total, 0);
  return items.map((it, i) => {
    const p = price(it, i, { club, basket });
    if (p.kind === "none") return null;
    return {
      total: p.total, est: p.kind === "estimate", sub: !!p.missingProduct, ref: !!p.reference && !p.similar, alt: !!p.alt,
      name: p.product?.name || null, kinds: p.kind === "estimate" ? p.count : null, // what was priced
      // To tell identical products apart from similar ones: the barcode priced, and
      // whether it's loose produce by its plain name ("עגבניה" by weight, comparable as is).
      code: p.kind === "exact" ? p.product.code : null,
      loose: p.kind === "exact" && !!p.product.weighted && !!p.auto && !p.missingProduct && !p.similar,
    };
  });
}

// General items ("חלב", "שמן"): which product to compare them on, the same at every chain.
// Gathered chain by chain (only a small summary of each is kept).
const isGeneral = (it, choices) => !it.barcode && !(typeof it.price === "number" && it.price > 0) && !choices[norm(it.kind || it.name)];

self.onmessage = async ({ data }) => {
  const { id, items, choices, here, maxKm, current, clubs = false } = data;
  const club = (chain) => clubs === true || !!clubs[chain];
  try {
    const index = await fetchJson("index.json");
    const chains = [], branches = [];
    const steps = index.chains.length;
    const general = items.map((it) => isGeneral(it, choices));
    const offers = items.map(() => []);
    let n = 0;
    if (general.some(Boolean)) {
      // First pass: which product to compare each general item on.
      for (const c of index.chains) {
        self.postMessage({ type: "progress", id, phase: "match", done: n++, total: steps, name: c.name });
        try {
          const cat = parseChain(await fetchJson(`${encodeURIComponent(c.id)}.json`));
          items.forEach((it, i) => { if (general[i]) offers[i].push(chainOffer(cat, it.name)); });
        } catch (_) {}
      }
    }
    n = 0;
    const refs = items.map((it, i) => (general[i] ? referencesFrom(offers[i], it.name) : []));
    for (const c of index.chains) {
      self.postMessage({ type: "progress", id, phase: "price", done: n, total: steps, name: c.name });
      let cat;
      try { cat = parseChain(await fetchJson(`${encodeURIComponent(c.id)}.json`)); }
      catch (e) { console.warn("Skipping chain", c.id, e); n++; continue; }

      let stores = [];
      try { stores = parseStores(await fetchJson(`${encodeURIComponent(c.id)}/stores.json`)); } catch (_) {}
      const located = here ? stores.filter((s) => s.lat !== undefined).map((s) => ({ ...s, km: km(here, s) })) : [];
      located.sort((a, b) => a.km - b.km);

      chains.push({
        id: c.id, name: c.name, color: c.color,
        prices: pricesIn(cat, items, choices, club(c.id), refs),
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
          const { p: diff, d, c: cd } = await fetchJson(`${encodeURIComponent(c.id)}/${encodeURIComponent(s.id)}.json`);
          branches.push({ chain: c.id, chainName: c.name, ...strip(s), prices: pricesIn(applyBranch(cat, s.id, diff, d, cd), items, choices, club(c.id), refs) });
        } catch (e) { console.warn("Skipping branch", c.id, s.id, e); }
      }
      cat = null; // let this chain's catalog go before loading the next
      n++;
    }
    const result = summarize(items, chains, branches, current);
    // Say what general items were compared on.
    result.refs = items.map((it, i) => (refs[i]?.length ? { item: it.name, product: refs[i][0].name, refs: refs[i].slice(0, 8) } : null)).filter(Boolean);
    self.postMessage({ type: "result", id, result });
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e?.message || e) });
  }
};

const strip = (s) => ({
  id: s.id, name: s.name, city: s.city, address: s.address,
  lat: s.lat, lon: s.lon, prec: s.prec, km: s.km === undefined ? null : round(s.km),
});

// Totals compared like for like.
// With a current store: every store is compared on the items the current store has
// (items it lacks are left out for everyone, and named), so a smaller chain doesn't look
// cheaper just because something is missing there. A store lacking one of those items
// can't be "the cheapest" (you couldn't buy the whole list there).
// Without a current store: on the items at least one chain has.
function summarize(items, chains, branches, current) {
  const mine = current?.chain && (
    (current.branch && branches.find((x) => x.chain === current.chain && x.id === current.branch)) ||
    chains.find((x) => x.id === current.chain));
  const counted = mine ? mine.prices.map(Boolean) : items.map((_, i) => chains.some((c) => c.prices[i]));
  // For a chosen product some store lacks: where it is sold, and its price there
  // (the user's own store first), to show next to what was priced instead.
  const mineName = mine && (mine.chain ? `${mine.chainName} ${mine.name}` : mine.name);
  const chosenAt = items.map((_, i) => {
    if (mine?.prices[i] && !mine.prices[i].sub) return { at: mineName, total: mine.prices[i].total, name: mine.prices[i].name };
    const c = chains.find((x) => x.prices[i] && !x.prices[i].sub);
    return c ? { at: c.name, total: c.prices[i].total, name: c.prices[i].name } : null;
  });
  const total = (prices) => {
    let sum = 0, missing = 0, est = 0, subs = 0;
    const subList = [];
    prices.forEach((p, i) => {
      if (!counted[i]) return;
      if (!p) { missing++; return; }
      sum += p.total;
      if (p.est) est++;
      if (p.sub) {
        subs++;
        subList.push({ item: items[i].name, qty: items[i].qty || 1, chosen: items[i].productName || chosenAt[i]?.name || null,
          chosenAt: chosenAt[i], instead: p.name, kinds: p.kinds, total: p.total });
      }
    });
    return { total: round(sum), missing, est, subs, subList };
  };
  // Identical products: the same barcode in both stores (or loose produce by its plain
  // name). Savings are counted on those only, so "חוסכים ₪5" never comes from a
  // different product. The baseline is the user's store; with none, for each item the
  // product most stores priced, at its middle price.
  // A replacement the user approved for that chain counts too (they decided it's the same).
  const same = (a, b) => !!a && !!b && !a.est && !b.est && ((!!a.code && a.code === b.code) || (a.loose && b.loose) || a.alt || b.alt);
  const all = [...chains, ...branches];
  const base = items.map((_, i) => {
    if (!counted[i]) return null;
    if (mine) return mine.prices[i] && !mine.prices[i].est ? mine.prices[i] : null;
    const groups = new Map();
    for (const s of all) {
      const p = s.prices[i];
      if (!p || p.est) continue;
      const k = p.loose ? "loose" : p.code;
      if (k) groups.set(k, [...(groups.get(k) || []), p]);
    }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < 2) return null;
    const ts = best.map((p) => p.total).sort((a, b) => a - b);
    return { ...best[0], total: ts[ts.length >> 1] };
  });
  const versus = (prices) => {
    let n = 0, here = 0, there = 0;
    const diff = [];
    prices.forEach((p, i) => {
      if (!counted[i]) return;
      if (base[i] && same(p, base[i])) { n++; here += p.total; there += base[i].total; return; }
      diff.push({ item: items[i].name, qty: items[i].qty || 1, name: p?.name || null, total: p ? p.total : null, est: !!p?.est, missing: !p });
    });
    return { same: n, sameSave: round(there - here), diff };
  };

  const out = {
    itemCount: items.length,
    counted: counted.filter(Boolean).length,
    // Items left out because the current store doesn't have them (but another chain does).
    excluded: mine ? items.filter((_, i) => !counted[i] && chains.some((c) => c.prices[i])).map((it) => it.name) : [],
    chains: chains.map(({ prices, ...c }) => ({ ...c, ...total(prices), ...versus(prices) })),
    branches: branches.map(({ prices, ...b }) => ({ ...b, ...total(prices), ...versus(prices) })),
    baseline: mine ? "mine" : "typical",
    current: null,
  };
  if (mine) {
    const b = mine.chain && out.branches.find((x) => x.chain === mine.chain && x.id === mine.id);
    const c = out.chains.find((x) => x.id === current.chain);
    out.current = b ? { ...b, kind: "branch" } : { ...c, chain: c.id, chainName: c.name, kind: "chain" };
  }
  return out;
}
