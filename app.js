import { firebaseConfig } from "./firebase-config.js";
import { loadIndex, loadChain, loadStores, loadBranch, search, resolve, priceItem, norm, money } from "./catalog.js";
import { parseList, cleanItems } from "./import-parse.js";
import { PHOTO_URL } from "./photo-config.js";

const LOCAL_KEY = "basket.v1";
const PREFS_KEY = "basket.prefs";
const JOIN_KEY = "basket.pendingJoin";

// ---------- Small utils ----------
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const buzz = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : "");
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};
const plural = (n, one, many) => (n === 1 ? `${one} אחד` : `${n} ${many}`);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Emoji + parsing ----------
const EMOJI = [
  [/potato|תפוחי אדמה|תפו"א/i, "🥔"], // before "apple" so תפוחי אדמה isn't matched as תפוח
  [/milk|חלב/i, "🥛"], [/egg|ביצ/i, "🥚"], [/bread|לחם|פית/i, "🍞"], [/cheese|גבינ/i, "🧀"],
  [/butter|חמא/i, "🧈"], [/yog|יוגורט/i, "🥣"], [/apple|תפוח/i, "🍎"], [/banana|בננ/i, "🍌"],
  [/tomato|עגבני/i, "🍅"], [/cucumber|מלפפון/i, "🥒"],
  [/onion|בצל/i, "🧅"], [/garlic|שום/i, "🧄"], [/carrot|גזר/i, "🥕"], [/lemon|לימון/i, "🍋"],
  [/orange|תפוז/i, "🍊"], [/grape|ענב/i, "🍇"], [/strawberr|תות/i, "🍓"], [/avocado|אבוקדו/i, "🥑"],
  [/pepper|פלפל/i, "🫑"], [/lettuce|salad|חסה|סלט/i, "🥬"], [/chicken|עוף|שניצל/i, "🍗"],
  [/meat|beef|steak|בשר/i, "🥩"], [/fish|salmon|tuna|דג|טונה/i, "🐟"], [/rice|אורז/i, "🍚"],
  [/pasta|spaghetti|פסטה/i, "🍝"], [/coffee|קפה/i, "☕"], [/\btea\b|^תה$/i, "🍵"],
  [/water|מים/i, "💧"], [/juice|מיץ/i, "🧃"], [/wine|יין/i, "🍷"], [/beer|בירה/i, "🍺"],
  [/chocolate|שוקולד/i, "🍫"], [/cookie|עוגי/i, "🍪"], [/cake|עוג/i, "🍰"], [/sugar|סוכר/i, "🍬"],
  [/salt|מלח/i, "🧂"], [/honey|דבש/i, "🍯"], [/oil|שמן/i, "🫒"], [/flour|קמח/i, "🌾"],
  [/corn|תירס/i, "🌽"], [/soap|סבון/i, "🧼"], [/shampoo|שמפו/i, "🧴"], [/tissue|toilet|נייר/i, "🧻"],
  [/sponge|ספוג/i, "🧽"], [/diaper|חיתול/i, "👶"], [/ice cream|גלידה/i, "🍦"], [/pizza|פיצה/i, "🍕"],
];
const emojiFor = (name) => (EMOJI.find(([re]) => re.test(name)) || [, "🛒"])[1];

// "2 חלב", "חלב x3", "חלב 3" → { name, qty }
function parseInput(text) {
  let s = text.trim().replace(/\s+/g, " ");
  let qty = 1;
  let m = s.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i);
  if (m) { qty = +m[1]; s = m[2]; }
  else if ((m = s.match(/^(.+?)\s*[x×]\s*(\d{1,3})$/i)) || (m = s.match(/^(.+?)\s+(\d{1,3})$/))) {
    s = m[1]; qty = +m[2];
  }
  qty = Math.min(Math.max(qty || 1, 1), 999);
  return { name: capitalize(s), qty };
}

// ---------- Backends ----------
// Both backends share one interface: put(items), patch(ids, fields), del(ids).
// The UI never mutates items directly; it calls the backend and re-renders on its callback.
function createLocalBackend() {
  const saved = store.get(LOCAL_KEY, null);
  let items = (saved && Array.isArray(saved.items) ? saved.items : []).map((it, i) => ({
    price: null, createdAt: Date.now(), ...it, sortKey: it.sortKey ?? Date.now() - i,
  }));
  let listener = () => {};
  const emit = () => { store.set(LOCAL_KEY, { items }); listener(items.slice()); };
  return {
    get items() { return items.slice(); },
    subscribe(cb) { listener = cb; cb(items.slice()); },
    async put(list) {
      list.forEach((it) => {
        const i = items.findIndex((x) => x.id === it.id);
        if (i >= 0) items[i] = { ...it }; else items.push({ ...it });
      });
      emit();
    },
    async patch(ids, fields) { items = items.map((it) => (ids.includes(it.id) ? { ...it, ...fields } : it)); emit(); },
    async del(ids) { items = items.filter((it) => !ids.includes(it.id)); emit(); },
    clear() { items = []; emit(); },
  };
}

const local = createLocalBackend();
let cloud = null;        // set when Firebase is configured
let backend = local;     // where the current list lives

const prefs = store.get(PREFS_KEY, {});
const ui = {
  items: [],
  doneOpen: prefs.doneOpen ?? store.get(LOCAL_KEY, {})?.doneOpen ?? true,
  chains: [],        // available stores from the catalog index
  cat: null,         // loaded catalog of the selected store
  catId: null,       // chain id of the catalog in ui.cat (or being loaded)
  catKey: null,      // "chain|branch" being shown
  storeLists: {},    // chain id -> [{ id, name, city, count }] branches
  catError: false,
  choices: prefs.choices || {}, // remembered product per item name: { [norm(name)]: { code, name } }
  list: null,       // cloud list doc { id, name, ownerId, inviteCode }
  members: [],
  userLists: {},    // { listId: name }
  flash: new Set(), // ids changed by someone else, highlighted briefly
};

// ---------- DOM ----------
const todoList = $("todoList"), doneList = $("doneList");
const doneSection = $("doneSection"), doneToggle = $("doneToggle"), doneCount = $("doneCount");
const emptyState = $("emptyState");
const composer = $("composer"), input = $("itemInput");
const backdrop = $("sheetBackdrop"), menuSheet = $("sheet"), editSheet = $("editSheet"), shareSheet = $("shareSheet");
const toast = $("toast"), toastText = $("toastText"), toastUndo = $("toastUndo");

function greeting() {
  const h = new Date().getHours();
  const name = cloud?.user?.displayName?.split(" ")[0];
  const base = h < 5 ? "קניות בלילה?" : h < 12 ? "בוקר טוב" : h < 18 ? "צהריים טובים" : "ערב טוב";
  const icon = h < 5 ? "🌙" : h < 12 ? "☀️" : h < 18 ? "👋" : "🌆";
  $("greeting").textContent = name ? `${base}, ${name} ${icon}` : `${base} ${icon}`;
}

function avatarHtml(m, cls = "avatar") {
  const photo = safeUrl(m.photo);
  const initial = escapeHtml((m.name || m.email || "?").trim().charAt(0).toUpperCase());
  return photo
    ? `<img class="${cls}" src="${escapeHtml(photo)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="${cls} avatar-letter">${initial}</span>`;
}

// ---------- Render ----------
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// Money inside Hebrew text: keep ~₪12.90 in left-to-right order.
const amt = (s) => `<bdi dir="ltr">${s}</bdi>`;

function priceLine(it) {
  const p = it._price;
  if (!p || (!ui.cat && p.kind !== "manual")) return "";
  const qtyNote = it.qty > 1 ? ` <span class="muted">(${amt(money(p.unit))} ליח׳)</span>` : "";
  if (p.kind === "manual") return `<div class="item-price">${amt(money(p.total))}${qtyNote} <span class="tag">ידני</span></div>`;
  if (p.kind === "exact") {
    const perKg = p.weighted ? " לק״ג" : "";
    // Same barcode = same product in every chain, but chains word names differently;
    // show the name the user picked so it doesn't look like a different product.
    // The chosen product isn't sold here: say so, and name the product priced instead.
    if (p.missingProduct) {
      return `<div class="item-price">${amt(money(p.total))}${perKg}${qtyNote} <span class="pick">המוצר שבחרתם לא נמכר כאן · במקומו: ${escapeHtml(p.product.name)}</span></div>`;
    }
    const label = it.productName || ui.choices[norm(it.name)]?.name || p.product.name;
    return `<div class="item-price">${amt(money(p.total))}${perKg}${qtyNote} <span class="muted">· ${escapeHtml(label)}</span></div>`;
  }
  if (p.kind === "estimate") {
    // How close the match is: every detail found, some ("בלי: פרווה"), or just the product type.
    const fit = p.missingProduct ? "המוצר שבחרתם לא נמכר כאן — מחיר משוער למוצר דומה · "
      : p.fit === "partial" ? `לא מצאנו בדיוק (בלי: ${escapeHtml(p.missing.join(" "))}) — מחיר לפי מוצרים דומים · `
      : p.fit === "general" ? `לא מצאנו ${escapeHtml(p.missing.join(" "))} — מחיר כללי לסוג המוצר · `
      : "";
    const note = fit;
    const kinds = p.count > 1 ? `יש ${p.count} סוגים — ` : "";
    return `<div class="item-price est">${amt("~" + money(p.total))}${p.weighted ? " לק״ג" : ""}${qtyNote} <span class="pick">${note}${kinds}הקישו לבחירה</span></div>`;
  }
  return `<div class="item-price none">לא נמצא ב${escapeHtml(ui.cat.name)}</div>`;
}

// On a list shared by several people: who added the item, and who edited it if that was
// someone else, in tiny words stacked at the card's edge beside the checkbox
// ("נוסף / ארי / נערך / מיכל"). Ticking it into the cart isn't an edit.
function byLine(it) {
  if (ui.members.length < 2) return "";
  const parts = [];
  if (it.createdByName) parts.push(["נוסף", it.createdByName]);
  if (it.editedByName && it.editedBy !== it.createdBy) parts.push(["נערך", it.editedByName]);
  if (!parts.length) return "";
  const label = parts.map(([verb, who]) => `${verb} ע״י ${who}`).join(", ");
  return `<div class="item-who" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">` +
    parts.map(([verb, who]) => `<span>${verb}</span><b>${escapeHtml(who)}</b>`).join("") + `</div>`;
}

function itemHtml(it) {
  const name = escapeHtml(it.name);
  return `
    <li class="item${it.done ? " done" : ""}${ui.flash.has(it.id) ? " flash" : ""}" data-id="${escapeHtml(it.id)}">
      <div class="item-delete-hint" aria-hidden="true">מחיקה</div>
      <div class="item-body">
        ${byLine(it)}
        <button class="check" data-act="toggle" aria-label="${it.done ? "החזרה לרשימה" : "סימון כנמצא בעגלה"}: ${name}">
          <span class="check-box">${CHECK_SVG}</span>
        </button>
        <button class="item-main" data-act="edit" aria-label="עריכת ${name}">
          <div class="item-name"><span class="item-emoji" aria-hidden="true">${emojiFor(it.name)}</span>${name}</div>
          ${priceLine(it)}
          ${ui.flash.has(it.id) && it.updatedByName ? `<div class="item-by">${escapeHtml(it.updatedByName)} עדכן/ה עכשיו</div>` : ""}
          ${it.importNote && Date.now() - it.importNote.at < 864e5 ? `<div class="item-by import-note">📥 שימו לב: ${it.importNote.added === 1 ? "נוסף 1" : `נוספו ${it.importNote.added}`} מהרשימה המיובאת</div>` : ""}
        </button>
        <div class="stepper" role="group" aria-label="כמות">
          <button data-act="inc" aria-label="הגדלת כמות">+</button>
          <output aria-live="polite">${it.qty}</output>
          <button data-act="dec" aria-label="הקטנת כמות">−</button>
        </div>
        ${it.qty > 1 ? `<span class="qty-badge">×${it.qty}</span>` : ""}
      </div>
    </li>`;
}

function render() {
  const items = ui.items.slice().sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0))
    .map((it) => ({ ...it, _price: priceItem(ui.cat, it, ui.choices[norm(it.name)]) }));
  const todo = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const total = items.length;

  todoList.innerHTML = todo.map(itemHtml).join("");
  $("todoHead").hidden = !total;
  $("todoCount").textContent = todo.length;
  doneList.innerHTML = done.map(itemHtml).join("");

  emptyState.hidden = total > 0;
  doneSection.hidden = done.length === 0;
  doneCount.textContent = done.length;
  doneToggle.setAttribute("aria-expanded", String(ui.doneOpen));
  doneList.hidden = !ui.doneOpen;

  renderTotal(items);
  renderStores();
  $("dealsBtn").hidden = !total || !ui.chains.length;

  // Header: list name + who's in it
  $("listTitle").innerHTML = `<span class="title-text">${escapeHtml(listName())}</span>`;
  $("listTitle").setAttribute("aria-label", `${listName()} — שינוי שם הרשימה`);
  const others = ui.members.filter((m) => m.id !== cloud?.user?.uid);
  $("avatars").innerHTML = others.slice(0, 3).map((m) => avatarHtml(m, "avatar sm")).join("");
  $("shareBtn").classList.toggle("shared", others.length > 0);
  $("shareBtn").setAttribute("aria-label", others.length ? `משותף עם ${others.length} — ניהול שיתוף` : "שיתוף הרשימה");
}

function renderTotal(items) {
  const box = $("totalBox");
  const anyManual = items.some((i) => i._price.kind === "manual");
  box.hidden = !items.length || (!ui.cat && !anyManual);
  $("progressCard").hidden = box.hidden; // the card holds only the total now
  if (box.hidden) return;
  let sum = 0, inCart = 0, estCount = 0, noneCount = 0;
  for (const it of items) {
    sum += it._price.total;
    if (it.done) inCart += it._price.total;
    if (it._price.kind === "estimate") estCount++;
    if (it._price.kind === "none") noneCount++;
  }
  $("totalStore").textContent = ui.cat ? ui.cat.name : "רשימה";
  $("totalAmount").textContent = (estCount ? "~" : "") + money(sum);
  const notes = [];
  if (inCart) notes.push(`בעגלה: ${money(inCart)}`);
  if (estCount) notes.push(`${estCount === 1 ? "פריט אחד כללי" : `${estCount} פריטים כלליים`} — מחיר משוער`);
  if (noneCount) notes.push(`${noneCount === 1 ? "פריט אחד" : `${noneCount} פריטים`} בלי מחיר`);
  $("totalNote").textContent = notes.join(" · ");
}

// ---------- Stores ----------
// The store choice: a chain id, NO_STORE ("none": a plain list, no prices) or null (never chosen).
// A shared list's choice wins over this device's, so everyone on the list sees the same thing.
const NO_STORE = "none";
const storeChoice = () => (backend === cloud && ui.list?.store) || prefs.store || null;
const currentStoreId = () => { const s = storeChoice(); return s && s !== NO_STORE ? s : null; };

function renderStores() {
  const sel = currentStoreId();
  if (!ui.chains.length) {
    wheel.el.innerHTML = ""; wheel.key = "";
    $("storeNote").textContent = ui.catError ? "לא הצלחנו לטעון את רשימת החנויות. בדקו את החיבור לאינטרנט." : "טוען חנויות…";
    return;
  }
  buildWheel();
  // Someone else on a shared list picked a store: turn the wheel to it.
  const k = wheelItems().findIndex((x) => x.id === (sel || ""));
  if (k >= 0 && !wheel.dragging && !wheel.anim && wheelIndex() !== k) spinToChain(k, false);
  const c = ui.chains.find((x) => x.id === sel);
  const b = currentBranchId(sel);
  const branch = b && ui.storeLists[sel]?.find((s) => s.id === b);
  $("branchBtn").hidden = !sel || !c?.branches;
  $("branchName").textContent = !b ? "כל הסניפים — מחיר נפוץ ברשת"
    : (branch ? `סניף ${branch.name}${branch.city && !branch.name.includes(branch.city) ? `, ${branch.city}` : ""}` : `סניף ${b}`)
      + (isAutoBranch(sel) && !userPickedBranch(sel) ? " · הקרוב אליך" : "");
  $("storeNote").textContent = !sel
    ? "רשימה בלי מחירים · סובבו לחנות כדי לראות כמה הקנייה תעלה"
    : ui.catError ? "לא הצלחנו לטעון את המחירים. נסו שוב."
    : ui.catId === sel && (!ui.cat || ui.cat.id !== sel || (ui.cat.branch || null) !== b) ? "טוען מחירים…"
    : c ? `עודכן ${new Date(c.updated).toLocaleDateString("he-IL")}` : "";
}

// The branch picked for a chain: the shared list's choice, else this device's last choice.
const currentBranchId = (chain = currentStoreId()) =>
  (backend === cloud && ui.list?.store === chain && ui.list?.branch) || prefs.branches?.[chain] || null;

async function loadStore(id) {
  if (!id) { ui.cat = null; ui.catId = null; ui.catKey = null; render(); return; }
  const branch = currentBranchId(id);
  const key = `${id}|${branch || ""}`;
  if (ui.catKey === key && (ui.cat || !ui.catError)) return;
  if (ui.catId !== id) ui.cat = null; // switching chain; same chain keeps old prices while the branch loads
  ui.catId = id; ui.catKey = key; ui.catError = false;
  render();
  loadStores(id).then((list) => { ui.storeLists[id] = list; render(); }).catch(() => {});
  try {
    let cat = await loadChain(id);
    if (branch) {
      try { cat = await loadBranch(cat, branch); }
      catch (e) { console.warn("Branch prices unavailable, using chain prices", e); }
    }
    if (ui.catKey === key) { ui.cat = cat; render(); }
  } catch (e) {
    console.error(e);
    if (ui.catKey === key) { ui.catError = true; render(); }
  }
}

// id: a chain id, or null for a plain list with no store (no prices).
function selectStore(id) {
  const choice = id || NO_STORE;
  if (choice === storeChoice()) return loadStore(id || null);
  prefs.store = choice;
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), store: choice });
  // (A branch picked automatically as the nearest is this device's only; don't share it.)
  if (backend === cloud && ui.list) cloud.setListStore(choice, id && !isAutoBranch(id) ? prefs.branches?.[id] || null : null).catch(fail);
  loadStore(id || null);
  if (id) nearestBranch(id, true);
}

function selectBranch(branchId) {
  const chain = currentStoreId();
  if (!chain) return;
  saveBranch(chain, branchId || null, false);
  if (backend === cloud && ui.list) cloud.setListStore(chain, branchId || null).catch(fail);
  buzz(8);
  loadStore(chain);
}

function saveBranch(chain, branchId, auto) {
  prefs.branches = { ...(prefs.branches || {}), [chain]: branchId };
  prefs.autoBranches = { ...(prefs.autoBranches || {}), [chain]: auto };
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), branches: prefs.branches, autoBranches: prefs.autoBranches });
}

// ---------- Nearest branch by default ----------
// A chain the user never picked a branch for gets the branch nearest them, and keeps
// following them while that's an automatic choice. A branch the user picks (even
// "all branches") stays, and so does one set on a shared list.
const isAutoBranch = (chain) => !!prefs.autoBranches?.[chain];
const userPickedBranch = (chain) =>
  (prefs.branches && Object.prototype.hasOwnProperty.call(prefs.branches, chain) && !isAutoBranch(chain)) ||
  (backend === cloud && ui.list?.store === chain && !!ui.list?.branch);
function kmBetween(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// mayAsk: whether a location prompt may appear (yes when the user just picked a chain;
// not on app launch, where we only use a permission they already gave).
async function nearestBranch(chain, mayAsk) {
  if (!chain || userPickedBranch(chain)) return;
  let perm = "prompt";
  try { perm = (await navigator.permissions.query({ name: "geolocation" })).state; } catch (_) {}
  if (perm === "denied" || (!mayAsk && perm !== "granted")) return;
  const here = await getLocation();
  if (!here) return;
  let list;
  try { list = ui.storeLists[chain] = await loadStores(chain); } catch (_) { return; }
  let best = null, bestKm = Infinity;
  for (const s of list) {
    if (s.lat === undefined) continue;
    const d = kmBetween(here, s);
    if (d < bestKm) { best = s; bestKm = d; }
  }
  // Still on this chain, and the user didn't pick a branch while we were looking?
  if (!best || currentStoreId() !== chain || userPickedBranch(chain)) return;
  if (prefs.branches?.[chain] === best.id) return;
  saveBranch(chain, best.id, true);
  loadStore(chain);
}

// ---------- Branch picker ----------
const branchSheet = $("branchSheet");
$("branchBtn").addEventListener("click", async () => {
  const chain = currentStoreId();
  if (!chain) return;
  $("branchTitle").textContent = `באיזה סניף של ${ui.chains.find((c) => c.id === chain)?.name || ""}?`;
  $("branchSearch").value = "";
  openSheet(branchSheet);
  renderBranches();
  try { ui.storeLists[chain] = await loadStores(chain); renderBranches(); }
  catch (e) { console.error(e); $("branchList").innerHTML = `<li class="products-empty">לא הצלחנו לטעון את רשימת הסניפים</li>`; }
});
$("branchSearch").addEventListener("input", () => renderBranches());
$("branchSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

function renderBranches() {
  const chain = currentStoreId();
  const list = ui.storeLists[chain];
  const sel = currentBranchId(chain);
  if (!list) { $("branchList").innerHTML = `<li class="products-empty">טוען סניפים…</li>`; return; }
  const q = norm($("branchSearch").value);
  const shown = q ? list.filter((s) => norm(`${s.name} ${s.city} ${s.address}`).includes(q)) : list;
  const where = (s) => [s.city, s.address].filter(Boolean).join(" · ");
  const row = (id, title, sub, selected) => `
    <li><button type="button" class="product${selected ? " selected" : ""}" data-branch="${escapeHtml(id)}" role="option" aria-selected="${selected}">
      <span class="product-name">${title}${sub ? `<small>${sub}</small>` : ""}</span>
    </button></li>`;
  $("branchList").innerHTML =
    (q ? "" : row("", "כל הסניפים", "המחיר הנפוץ ברוב הסניפים של הרשת", !sel)) +
    shown.map((s) => row(s.id, escapeHtml(s.name), escapeHtml(where(s)), s.id === sel)).join("") +
    (q && !shown.length ? `<li class="products-empty">לא מצאנו סניף כזה</li>` : "");
}

$("branchList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-branch]");
  if (!b) return;
  selectBranch(b.dataset.branch || null);
  closeSheets();
});

// ---------- Where is it cheapest? ----------
// Prices the list in every chain (common price) and in the branches nearest the user,
// in a background worker. Drive time is estimated from straight-line distance;
// the Waze button gives the real route.
const dealsSheet = $("dealsSheet");
const MIN_PER_KM = 1.25;          // rough driving pace: 20 km ≈ 25 minutes
const RADII = [10, 25, 40];        // minutes the user can choose
const deals = { worker: null, runId: 0, key: "", result: null, stage: null, progress: null, error: false, here: null, hereAt: 0, locError: null };
const dealRadius = () => (RADII.includes(prefs.dealRadius) ? prefs.dealRadius : 25);
const driveMin = (km) => Math.max(2, Math.round(km * MIN_PER_KM));
const kmText = (km) => (km < 1 ? "פחות מק״מ" : `${km < 10 ? km.toFixed(1) : Math.round(km)} ק״מ`);
const wazeUrl = (b) => `https://waze.com/ul?ll=${b.lat},${b.lon}&navigate=yes`;

$("dealsBtn").addEventListener("click", () => { openSheet(dealsSheet); runDeals(); });
$("dealsRadius").addEventListener("click", (e) => {
  const b = e.target.closest("[data-min]");
  if (!b) return;
  prefs.dealRadius = Number(b.dataset.min);
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), dealRadius: prefs.dealRadius });
  buzz(8);
  renderDeals(); // nearby branches are already priced up to the largest radius
});
$("dealsBody").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const [chain, branch] = JSON.parse(pick.dataset.pick);
    chooseStore(chain, branch);
    closeSheets();
    showToast(`עברנו ל${ui.chains.find((c) => c.id === chain)?.name || "חנות"}`);
    return;
  }
  if (e.target.closest("[data-act='deals-retry']")) runDeals(true);
});

function chooseStore(chain, branch) {
  prefs.store = chain;
  saveBranch(chain, branch || null, false);
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), store: chain });
  if (backend === cloud && ui.list) cloud.setListStore(chain, branch || null).catch(fail);
  buzz(8);
  loadStore(chain);
}

// One location reading per comparison (reused for 10 minutes); never tracked.
function getLocation() {
  if (deals.here && Date.now() - deals.hereAt < 10 * 60e3) return Promise.resolve(deals.here);
  return new Promise((resolve) => {
    if (!navigator.geolocation) { deals.locError = "unsupported"; resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        deals.here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        deals.hereAt = Date.now(); deals.locError = null;
        resolve(deals.here);
      },
      (err) => { deals.locError = err.code === 1 ? "denied" : "failed"; resolve(deals.here); },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60e3 });
  });
}

async function runDeals(force = false) {
  if (deals.stage) return; // already running
  const items = ui.items.map(({ name, qty, barcode, productName, price }) => ({ name, qty, barcode, productName, price }));
  if (!items.length) { renderDeals(); return; }
  const current = currentStoreId() ? { chain: currentStoreId(), branch: currentBranchId() } : null;
  deals.error = false; deals.stage = "locating"; renderDeals();
  const here = await getLocation();
  const key = JSON.stringify([items, ui.choices, current, here && [here.lat.toFixed(2), here.lon.toFixed(2)]]);
  if (!force && key === deals.key && deals.result) { deals.stage = null; renderDeals(); return; }

  deals.stage = "pricing"; deals.progress = null; renderDeals();
  const id = ++deals.runId;
  const w = deals.worker = new Worker(new URL("./compare-worker.js", import.meta.url), { type: "module" });
  const finish = (result) => {
    w.terminate(); // frees all the catalogs it loaded
    if (deals.runId !== id) return;
    deals.worker = null; deals.stage = null;
    if (result) { deals.result = result; deals.key = key; } else deals.error = true;
    renderDeals();
  };
  w.onmessage = ({ data }) => {
    if (data.id !== id) return;
    if (data.type === "progress") { deals.progress = data; renderDeals(); }
    else if (data.type === "result") finish(data.result);
    else { console.error(data.message); finish(null); }
  };
  w.onerror = (e) => { console.error(e); finish(null); };
  w.postMessage({ id, items, choices: ui.choices, here, maxKm: Math.max(...RADII) / MIN_PER_KM, current });
}

function renderDeals() {
  const r = dealRadius(), maxKm = r / MIN_PER_KM;
  $("dealsRadius").querySelectorAll("[data-min]").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.min) === r)));
  const body = $("dealsBody");
  const msg = (text, retry) => `<p class="deals-msg">${text}</p>` +
    (retry ? `<button type="button" class="btn ghost deals-retry" data-act="deals-retry">${retry}</button>` : "");
  const loading = (text) => `<div class="deals-loading"><span class="spinner" aria-hidden="true"></span>${text}</div>`;

  if (!ui.items.length) { body.innerHTML = msg("הוסיפו פריטים לרשימה כדי להשוות מחירים."); return; }
  if (deals.stage === "locating") { body.innerHTML = loading("מאתרים איפה אתם…"); return; }
  if (deals.stage === "pricing") {
    const p = deals.progress;
    body.innerHTML = loading(p ? `בודקים מחירים ב${escapeHtml(p.name)}… (${p.done + 1}/${p.total})` : "טוענים מחירים…");
    return;
  }
  const res = deals.result;
  if (deals.error || !res) { body.innerHTML = msg("לא הצלחנו להשוות מחירים. בדקו את החיבור לאינטרנט.", "לנסות שוב"); return; }
  if (!res.counted) { body.innerHTML = msg("לא מצאנו מחירים לפריטים ברשימה באף רשת."); return; }

  const ok = (x) => !x.missing && x.total > 0;
  const byTotal = (a, b) => a.total - b.total || (a.km ?? 1e9) - (b.km ?? 1e9);
  const cur = res.current;
  const logo = (id) => `<img class="deal-logo" src="stores/${escapeHtml(id)}.png" alt="" />`;
  const est = (x) => (x.est ? "~" : "");
  const where = (b) => [b.name, b.city && !b.name.includes(b.city) ? b.city : ""].filter(Boolean).join(", ");
  const trip = (b) => b.km == null ? "" :
    `~${driveMin(b.km)} דק׳ נסיעה · ${kmText(b.km)}${b.prec === "c" ? " · מיקום משוער לפי העיר" : ""}`;
  // Chosen products this store doesn't sell, priced by a similar product instead.
  // Tap to see, per product: what was chosen and its price where it's sold, and what was priced here instead.
  const subsNote = (x, short = false) => !x.subs || (cur && x.chain === cur.chain && cur.kind === "branch" && x.id === cur.id) ? "" :
    `<details class="deal-warn${short ? " in-row" : ""}"><summary>⚠️ ${x.subs === 1 ? "מוצר אחד שבחרתם לא נמכר כאן" : `${x.subs} מוצרים שבחרתם לא נמכרים כאן`}` +
    `${short ? "" : " — חושב לפי מחיר של מוצר דומה"} <span class="more">פרטים</span></summary><ul class="subs">` +
    x.subList.map((d) => {
      const q = d.qty > 1 ? ` <span class="muted">(×${d.qty})</span>` : "";
      const chosen = d.chosenAt
        ? `${escapeHtml(d.chosen || d.item)} — <strong>${amt(money(d.chosenAt.total))}</strong>${q} ב${escapeHtml(d.chosenAt.at)}`
        : escapeHtml(d.chosen || d.item);
      const instead = d.instead
        ? `${escapeHtml(d.instead)} — <strong>${amt(money(d.total))}</strong>${q}`
        : `מחיר טיפוסי של ${d.kinds > 1 ? `${d.kinds} סוגים` : "מוצר דומה"} — <strong>${amt("~" + money(d.total))}</strong>${q}`;
      return `<li><b>${escapeHtml(d.item)}</b><span>בחרתם: ${chosen}</span><span>כאן במקומו: ${instead}</span></li>`;
    }).join("") + `</ul></details>`;
  const isCur = (b) => cur?.kind === "branch" && cur.chain === b.chain && cur.id === b.id;
  const save = (x) => {
    if (!cur || !ok(cur)) return "";
    const d = Math.round((cur.total - x.total) * 100) / 100;
    return d >= 1 ? `<p class="deal-save">חוסכים ${amt(money(d))} לעומת ${escapeHtml(cur.chainName)}</p>` : "";
  };
  const actions = (chain, b) => `<div class="deal-actions">
      <button type="button" class="btn primary" data-pick='${escapeHtml(JSON.stringify([chain, b?.id || null]))}'>לקנות כאן</button>
      ${b?.lat !== undefined ? `<a class="btn ghost" href="${wazeUrl(b)}" target="_blank" rel="noopener">ניווט ב-Waze</a>` : ""}
    </div>`;

  let html = "";
  if (cur) {
    const label = cur.kind === "branch" ? `${escapeHtml(cur.chainName)}, ${escapeHtml(where(cur))}` : `${escapeHtml(cur.chainName)} (מחיר נפוץ ברשת)`;
    html += `<p class="deals-current">הקנייה שלך ב${label}: <strong>${amt(est(cur) + money(cur.total))}</strong></p>`;
    // Items the current store lacks are left out for every store, so the totals compare like for like.
    if (res.excluded.length) {
      html += `<p class="deal-warn deals-excluded">אין ב${escapeHtml(cur.chainName)}: ${res.excluded.map(escapeHtml).join(", ")}. ` +
        `כדי להשוות הוגן, ${res.excluded.length === 1 ? "הפריט הזה לא נכלל" : "הפריטים האלה לא נכללו"} בסכומים כאן.</p>`;
    }
  }

  // Cheapest within the chosen drive time.
  const nearby = res.branches.filter((b) => b.km != null && b.km <= maxKm && ok(b)).sort(byTotal);
  const best = nearby[0];
  html += `<section class="deal"><p class="deal-kicker">📍 הכי זול לידך · עד ${r} דק׳ נסיעה</p>`;
  if (best) {
    html += `<div class="deal-head">${logo(best.chain)}
        <div class="deal-name"><strong>${escapeHtml(best.chainName)}</strong><small>${escapeHtml(where(best))}</small></div>
        <strong class="deal-total">${amt(est(best) + money(best.total))}</strong></div>
      <p class="deal-meta">${trip(best)}</p>${subsNote(best)}
      ${isCur(best) ? `<p class="deal-save">🎉 הסניף שלך הוא הכי זול באזור</p>` : save(best) + actions(best.chain, best)}`;
  } else if (!deals.here) {
    html += deals.locError === "denied"
      ? msg("המיקום חסום. כדי למצוא סניפים לידך, אפשרו גישה למיקום בהגדרות הדפדפן ונסו שוב.", "לנסות שוב")
      : msg("כדי למצוא את הכי זול לידך צריך את המיקום שלכם.", "לאפשר מיקום");
  } else {
    html += msg(r < 40 ? "לא מצאנו סניף עם כל הפריטים במרחק הזה. נסו מרחק גדול יותר." : "לא מצאנו סניף עם כל הפריטים במרחק הזה.");
  }
  html += `</section>`;

  // Cheapest chain overall, wherever it is (each chain's common price).
  const top = res.chains.filter(ok).sort(byTotal)[0];
  if (top && best && top.id === best.chain && top.nearest?.id === best.id) {
    html += `<p class="deals-also">🏆 ${escapeHtml(top.name)} היא גם הרשת הכי זולה בארץ</p>`;
  } else if (top) {
    const near = top.nearest;
    html += `<section class="deal"><p class="deal-kicker">🏆 הכי זול בארץ · מחיר נפוץ ברשת</p>
      <div class="deal-head">${logo(top.id)}
        <div class="deal-name"><strong>${escapeHtml(top.name)}</strong>${near ? `<small>הסניף הקרוב: ${escapeHtml(where(near))}</small>` : ""}</div>
        <strong class="deal-total">${amt(est(top) + money(top.total))}</strong></div>
      ${near ? `<p class="deal-meta">${trip(near)}</p>` : ""}${subsNote(top)}
      ${cur?.chain === top.id && (cur.kind === "chain" || cur.id === near?.id) ? `<p class="deal-save">🎉 זו הרשת שבחרת</p>` : save(top) + actions(top.id, near)}
    </section>`;
  }

  // Other chains nearby: the cheapest branch of each.
  const more = nearby.filter((b, k) => b.chain !== best?.chain && b.chain !== cur?.chain
    && nearby.findIndex((x) => x.chain === b.chain) === k).slice(0, 5);
  if (more.length) {
    html += `<p class="sheet-label">רשתות אחרות לידך</p><ul class="deal-list">` + more.map((b) => `
      <li><button type="button" class="deal-row" data-pick='${escapeHtml(JSON.stringify([b.chain, b.id]))}'>
        ${logo(b.chain)}
        <span class="deal-name"><strong>${escapeHtml(b.chainName)}</strong><small>${escapeHtml(where(b))} · ~${driveMin(b.km)} דק׳</small></span>
        <strong class="deal-total">${amt(est(b) + money(b.total))}</strong>
      </button>${subsNote(b, true)}</li>`).join("") + `</ul>`;
  }

  const notes = [`המחירים כאן הם בדיוק מה שהרשימה תראה אחרי מעבר לחנות`];
  const general = Math.max(cur?.est || 0, best?.est || 0, top?.est || 0);
  if (general) notes.push(`${general === 1 ? "פריט אחד כללי" : `${general} פריטים כלליים`} (כמו "גבינה") מתומחרים לפי מוצר טיפוסי, אז ההשוואה משוערת. להשוואה מדויקת, הקישו על פריט ברשימה ובחרו מוצר`);
  // Chains left out because they lack something on the list.
  const lacking = res.chains.filter((c) => c.missing && c.id !== cur?.chain)
    .map((c) => `${escapeHtml(c.name)} (${c.missing === 1 ? "חסר פריט אחד" : `חסרים ${c.missing} פריטים`})`);
  if (lacking.length) notes.push(`לא הוצגו: ${lacking.join(", ")}`);
  notes.push("זמן הנסיעה משוער לפי המרחק", "נבדקו 4 הסניפים הקרובים מכל רשת");
  html += `<p class="deals-foot">${notes.join(" · ")}</p>`;
  body.innerHTML = html;
}

// ---------- Store wheel ----------
// Stores sit on the rim of a big circle. Drag to spin it; when it stops, the store
// at the top is enlarged and its prices are shown. The ring repeats the stores so
// it can spin endlessly even with only a few chains.
const RTL = document.documentElement.dir === "rtl";
const WHEEL = { step: (34 * Math.PI) / 180, radius: 250, top: 50, pxPerStep: 110, minSlots: 9 };
const wheel = { el: $("storeRow"), btns: [], key: "", slots: 0, rot: 0, dragging: false, anim: 0, lastTick: null };

// Chains with a logo in /stores (others show their initials).
const STORE_LOGOS = new Set(["shufersal", "carrefour", "hazi-hinam", "rami-levy", "yochananof", "osher-ad", "tiv-taam"]);

const NO_STORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>';
const mod = (a, n) => ((a % n) + n) % n;
const wrapDist = (d, n) => { d = mod(d, n); return d > n / 2 ? d - n : d; };
// The first slot on the wheel is "no store": a plain list without prices.
const NO_STORE_SLOT = { id: "", name: "בלי חנות", color: "#8a8f98" };
const wheelItems = () => (ui.chains.length ? [NO_STORE_SLOT, ...ui.chains] : []);
const wheelIndex = () => { const n = wheelItems().length; return n ? mod(Math.round(wheel.rot), wheel.slots) % n : -1; };

function buildWheel() {
  const items = wheelItems();
  const key = items.map((c) => c.id + c.color).join("|");
  if (key === wheel.key) return;
  wheel.key = key;
  const n = items.length;
  wheel.slots = n * Math.ceil(WHEEL.minSlots / n);
  const slots = Array.from({ length: wheel.slots }, (_, s) => items[s % n]);
  wheel.el.innerHTML = `<div class="wheel-arc" aria-hidden="true"></div><div class="wheel-marker" aria-hidden="true"></div>` +
    slots.map((c, s) => `
      <button class="store" data-slot="${s}" tabindex="-1" aria-hidden="${s >= n}"
              style="--store-color:${/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#2f9e6b"}">
        <span class="store-circle${c === NO_STORE_SLOT ? " no-store" : ""}">${c === NO_STORE_SLOT ? NO_STORE_ICON
          : STORE_LOGOS.has(c.id) ? `<img src="stores/${c.id}.png" alt="" draggable="false" />`
          : escapeHtml(c.name.split(" ").map((w) => w[0]).join("").slice(0, 2))}</span>
        <span class="store-name">${escapeHtml(c.name)}</span>
      </button>`).join("");
  wheel.btns = [...wheel.el.querySelectorAll(".store")];
  const k = items.findIndex((c) => c.id === (currentStoreId() || ""));
  wheel.rot = k >= 0 ? k : 0;
  wheel.lastTick = Math.round(wheel.rot);
  layoutWheel();
}

function layoutWheel() {
  // Not on screen yet (e.g. behind the splash): the ResizeObserver lays it out once visible.
  if (!wheel.btns.length || !wheel.el.clientWidth) return;
  const cx = wheel.el.clientWidth / 2;
  const dir = RTL ? -1 : 1; // in Hebrew the next store sits to the left
  const top = wheelIndex();
  wheel.btns.forEach((el, s) => {
    const d = wrapDist(s - wheel.rot, wheel.slots);   // distance from the top, in stores
    const a = d * WHEEL.step * dir;
    const x = cx + WHEEL.radius * Math.sin(a);
    const y = WHEEL.top + WHEEL.radius * (1 - Math.cos(a));
    const near = Math.max(0, 1 - Math.abs(d));       // 1 at the top, 0 one step away
    const scale = 0.72 + 0.5 * near;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    el.style.opacity = String(Math.max(0, 1 - Math.max(0, Math.abs(d) - 1) * 0.75));
    el.style.zIndex = String(100 - Math.round(Math.abs(d) * 10));
    el.classList.toggle("top", Math.abs(d) < 0.5);
  });
  const c = wheelItems()[top];
  wheel.el.setAttribute("aria-valuetext", c ? c.name : "");
  // A little tick each time a store passes the top.
  const r = Math.round(wheel.rot);
  if (r !== wheel.lastTick) { wheel.lastTick = r; buzz(4); }
}

function spinTo(target, animate = true) {
  cancelAnimationFrame(wheel.anim);
  wheel.anim = 0;
  if (!animate) { wheel.rot = target; settleWheel(); return; }
  const from = wheel.rot, dist = target - from;
  const dur = Math.min(650, 220 + Math.abs(dist) * 140);
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    wheel.rot = from + dist * (1 - Math.pow(1 - p, 3)); // ease-out
    layoutWheel();
    if (p < 1) wheel.anim = requestAnimationFrame(step);
    else { wheel.anim = 0; wheel.rot = target; settleWheel(); }
  };
  wheel.anim = requestAnimationFrame(step);
}

// Spin to the nearest copy of wheel item k on the ring.
function spinToChain(k, animate = true) {
  let best = null;
  for (let s = k; s < wheel.slots; s += wheelItems().length) {
    const d = wrapDist(s - wheel.rot, wheel.slots);
    if (best === null || Math.abs(d) < Math.abs(best)) best = d;
  }
  spinTo(wheel.rot + best, animate);
}

function settleWheel() {
  wheel.rot = mod(Math.round(wheel.rot), wheel.slots);
  layoutWheel();
  const c = wheelItems()[wheelIndex()];
  if (c && (c.id || null) !== currentStoreId()) { buzz(12); selectStore(c.id || null); }
}

(function wheelInput() {
  const el = wheel.el;
  let startX = 0, startRot = 0, moved = false, downSlot = null, samples = [];
  const sign = RTL ? 1 : -1;

  el.addEventListener("pointerdown", (e) => {
    if (!wheel.btns.length || (e.pointerType === "mouse" && e.button !== 0)) return;
    cancelAnimationFrame(wheel.anim); wheel.anim = 0;
    wheel.dragging = true; moved = false;
    startX = e.clientX; startRot = wheel.rot;
    downSlot = e.target.closest(".store")?.dataset.slot ?? null;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener("pointermove", (e) => {
    if (!wheel.dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) moved = true;
    if (!moved) return;
    wheel.rot = startRot + (sign * dx) / WHEEL.pxPerStep;
    samples.push({ x: e.clientX, t: e.timeStamp });
    if (samples.length > 6) samples.shift();
    layoutWheel();
  });
  const end = () => {
    if (!wheel.dragging) return;
    wheel.dragging = false;
    if (!moved) {
      // A tap: bring the tapped store to the top.
      if (downSlot !== null) spinTo(wheel.rot + wrapDist(+downSlot - wheel.rot, wheel.slots));
      return;
    }
    // Fling: keep spinning a bit in the direction of the swipe, then snap to a store.
    const a = samples[0], b = samples[samples.length - 1];
    const v = b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0; // px per ms
    const coast = Math.max(-3, Math.min(3, (sign * v * 220) / WHEEL.pxPerStep));
    spinTo(Math.round(wheel.rot + coast));
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const towardNext = (e.key === "ArrowLeft") === RTL;
    spinTo(Math.round(wheel.rot) + (towardNext ? 1 : -1));
  });
  // Re-center whenever the wheel appears or changes width (app shown, rotation, wider screens).
  if ("ResizeObserver" in window) new ResizeObserver(() => layoutWheel()).observe(el);
  else window.addEventListener("resize", layoutWheel);
})();

async function initStores() {
  try {
    const idx = await loadIndex();
    ui.chains = idx.chains || [];
    ui.catError = false;
  } catch (e) {
    console.error(e);
    ui.catError = true;
  }
  render();
  // New users start on "no store" (a plain list); a store that no longer exists falls back to it too.
  if (currentStoreId() && ui.chains.length && !ui.chains.some((c) => c.id === currentStoreId())) selectStore(null);
  else loadStore(currentStoreId());
  nearestBranch(currentStoreId(), false); // follow the user if their branch was picked as the nearest
}

// ---------- Import a list (paste text or read a photo) ----------
// Paste: parsed in the app (import-parse.js). Photo: shrunk in the app, read by the
// Cloudflare Worker (worker/) with Google Gemini. Either way the user checks and edits
// the items before anything is added. Signed in: they become a new list; on a phone-only
// list (one list): they're added to it.
const importSheet = $("importSheet");
const imp = { step: "start", text: "", items: [], name: "", error: "", photo: "", busy: false };
const intoNewList = () => backend === cloud && !!cloud?.user;
const commitLabel = (n) => (intoNewList() ? `יצירת רשימה (${n})` : `הוספה לרשימה (${n})`);

function openImport() {
  Object.assign(imp, { step: "start", items: [], name: "", error: "", busy: false, retry: false, lastFile: null });
  openSheet(importSheet);
  renderImport();
}
$("emptyImport").addEventListener("click", openImport);
$("importBtn").addEventListener("click", openImport);

// On a phone-only list, imported items merge into what's there: the item already on the list.
const existingFor = (name) => !intoNewList() && name.trim()
  ? ui.items.find((i) => !i.done && i.name.toLowerCase() === capitalize(name.trim().replace(/\s+/g, " ")).toLowerCase())
  : null;

// Under a preview row: the original line when it was shortened, and whether the item
// is already on the list (its quantity will grow instead of adding it twice).
function importHints(it) {
  const hints = [];
  if (it.source && it.source.split(" ").length - it.name.split(" ").length >= 2) {
    hints.push(`<span>מהשורה: "${escapeHtml(it.source)}"</span>`);
  }
  const ex = !it.done && existingFor(it.name);
  if (ex) hints.push(`<span class="import-merge">כבר ברשימה (×${ex.qty}) · יעודכן ל־×${Math.min(ex.qty + it.qty, 999)}</span>`);
  return hints.length ? `<div class="import-hints">${hints.join("")}</div>` : "";
}

function renderImport() {
  const body = $("importBody");
  const err = imp.error ? `<p class="deal-warn import-error" role="alert">${escapeHtml(imp.error)}</p>` : "";
  if (imp.step === "reading") {
    body.innerHTML = `${imp.photo ? `<img class="import-photo" src="${imp.photo}" alt="" />` : ""}
      <div class="deals-loading"><span class="spinner" aria-hidden="true"></span>קוראים את הרשימה מהתמונה…</div>`;
    return;
  }
  if (imp.step === "preview") {
    const n = imp.items.filter((it) => it.name.trim()).length;
    body.innerHTML = `<p class="sheet-note">מצאנו ${plural(n, "פריט", "פריטים")}. אפשר לתקן, למחוק או להוסיף לפני שממשיכים.</p>
      ${intoNewList() ? `<label class="field import-name"><span>שם הרשימה החדשה</span>
        <input id="importName" type="text" maxlength="80" value="${escapeHtml(imp.name)}" placeholder="רשימה מיובאת" /></label>` : ""}
      <ul class="import-items">${imp.items.map((it, k) => `
        <li data-k="${k}">
          <input class="import-qty" type="number" inputmode="numeric" min="1" max="999" value="${it.qty}" aria-label="כמות" />
          <input class="import-item-name" type="text" maxlength="60" value="${escapeHtml(it.name)}" aria-label="שם הפריט" />
          ${it.done ? `<span class="tag">בעגלה</span>` : ""}
          <button type="button" class="import-del" data-imp="del" aria-label="מחיקת ${escapeHtml(it.name)}">✕</button>
          ${importHints(it)}
        </li>`).join("")}</ul>
      <button type="button" class="link-btn" data-imp="add-row">＋ הוספת פריט</button>
      ${err}
      <div class="import-actions">
        <button type="button" class="btn ghost" data-imp="back">חזרה</button>
        <button type="button" class="btn primary" data-imp="commit" ${n && !imp.busy ? "" : "disabled"}>${imp.busy ? "רגע…" : commitLabel(n)}</button>
      </div>`;
    return;
  }
  const canPaste = !!navigator.clipboard?.readText;
  body.innerHTML = `<p class="sheet-note">הדביקו רשימה מוואטסאפ, מהפתקים או מכל מקום. כל שורה (או פסיק) היא פריט, וכמויות כמו "2 חלב" או "חלב x2" נקלטות.</p>
    <textarea id="importText" class="import-text" rows="6" placeholder="למשל:&#10;2 חלב&#10;לחם&#10;ביצים x2">${escapeHtml(imp.text)}</textarea>
    <div class="import-actions">
      ${canPaste ? `<button type="button" class="btn ghost" data-imp="paste">📋 הדבקה</button>` : ""}
      <button type="button" class="btn primary" data-imp="parse">המשך</button>
    </div>
    <p class="import-or">או מתמונה של רשימה, גם בכתב יד</p>
    <div class="import-actions">
      <button type="button" class="btn ghost" data-imp="camera">📷 צילום</button>
      <button type="button" class="btn ghost" data-imp="gallery">🖼️ מהגלריה</button>
    </div>
    ${err}
    ${imp.retry ? `<button type="button" class="btn primary import-retry" data-imp="retry-photo">לנסות שוב עם אותה תמונה</button>` : ""}`;
}

importSheet.addEventListener("input", (e) => {
  if (e.target.id === "importText") { imp.text = e.target.value; return; }
  if (e.target.id === "importName") { imp.name = e.target.value; return; }
  const li = e.target.closest("li[data-k]");
  if (!li) return;
  const it = imp.items[+li.dataset.k];
  if (e.target.classList.contains("import-item-name")) it.name = e.target.value;
  if (e.target.classList.contains("import-qty")) it.qty = Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), 999);
  // Keep the count on the button current without re-rendering (which would drop focus).
  const n = imp.items.filter((x) => x.name.trim()).length;
  const btn = importSheet.querySelector("[data-imp='commit']");
  if (btn) { btn.disabled = !n; btn.textContent = commitLabel(n); }
});

importSheet.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-imp]")?.dataset.imp;
  if (!act) return;
  imp.error = "";
  if (act === "paste") {
    try { imp.text = await navigator.clipboard.readText(); }
    catch (_) { imp.error = "לא הצלחנו לקרוא מהלוח. לחצו לחיצה ארוכה בתיבה ובחרו 'הדבקה'."; }
    renderImport();
  } else if (act === "parse") {
    imp.items = parseList(imp.text);
    if (!imp.items.length) imp.error = imp.text.trim() ? "לא מצאנו פריטים בטקסט הזה." : "הדביקו קודם את הרשימה בתיבה.";
    else imp.step = "preview";
    renderImport();
  } else if (act === "camera" || act === "gallery") {
    if (!PHOTO_URL) { imp.error = "קריאת רשימות מתמונה עוד לא הופעלה. בינתיים אפשר להדביק את הרשימה כטקסט."; renderImport(); return; }
    $(act === "camera" ? "importCamera" : "importGallery").click();
  } else if (act === "del") {
    imp.items.splice(+e.target.closest("li").dataset.k, 1);
    if (!imp.items.length) imp.step = "start";
    renderImport();
  } else if (act === "add-row") {
    imp.items.push({ name: "", qty: 1, done: false });
    renderImport();
    importSheet.querySelector("li:last-child .import-item-name")?.focus();
  } else if (act === "back") {
    imp.step = "start";
    renderImport();
  } else if (act === "commit") {
    commitImport();
  } else if (act === "retry-photo") {
    if (imp.lastFile) readPhoto(imp.lastFile);
  }
});

for (const id of ["importCamera", "importGallery"]) {
  $(id).addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so the same photo can be picked again
    if (file) readPhoto(file);
  });
}

// Photos from phones are large: shrink to at most 1600px on the long side, as JPEG.
async function shrinkImage(file) {
  let src, w, h;
  try {
    src = await createImageBitmap(file, { imageOrientation: "from-image" });
    w = src.width; h = src.height;
  } catch (_) {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  return { data, mime: "image/jpeg" };
}

async function readPhoto(file) {
  if (imp.photo) URL.revokeObjectURL(imp.photo);
  imp.photo = URL.createObjectURL(file);
  imp.lastFile = file;
  imp.retry = false;
  imp.step = "reading";
  imp.error = "";
  renderImport();
  try {
    const { data, mime } = await shrinkImage(file);
    const res = await fetch(PHOTO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: data, mime }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "failed");
    imp.items = cleanItems(out.items);
    if (imp.items.length) imp.step = "preview";
    else { imp.step = "start"; imp.error = "לא מצאנו פריטים בתמונה. נסו לצלם מקרוב, ישר ובאור טוב."; }
  } catch (e) {
    console.error(e);
    imp.step = "start";
    imp.retry = e.message !== "too_big" && e.message !== "quota";
    imp.error = e.message === "busy" ? "שירות קריאת התמונות עמוס כרגע. נסו שוב בעוד רגע."
      : e.message === "quota" ? "נגמרה המכסה היומית החינמית לקריאת תמונות. נסו שוב מחר, או הדביקו את הרשימה כטקסט."
      : e.message === "too_big" ? "התמונה גדולה מדי. נסו תמונה אחרת."
      : "לא הצלחנו לקרוא את התמונה. בדקו את החיבור לאינטרנט ונסו שוב.";
  }
  renderImport();
}

async function commitImport() {
  const rows = imp.items
    .map((it) => ({ ...it, name: capitalize(it.name.trim().replace(/\s+/g, " ")) }))
    .filter((it) => it.name);
  if (!rows.length || imp.busy) return;
  const now = Date.now();
  // First item on top: the list shows the highest sortKey first.
  const make = (it, k) => ({ id: uid(), name: it.name, qty: it.qty, done: !!it.done, price: null, createdAt: now, sortKey: now - k });
  if (intoNewList()) {
    imp.busy = true;
    renderImport();
    try {
      const id = await cloud.createList(rows.map(make), imp.name.trim() || "רשימה מיובאת");
      closeSheets();
      openCloudList(id);
      showToast(`נוצרה רשימה חדשה עם ${plural(rows.length, "פריט", "פריטים")}`, false);
    } catch (e) {
      console.error(e);
      imp.error = "לא הצלחנו ליצור את הרשימה. נסו שוב.";
    } finally {
      imp.busy = false;
      if (!importSheet.hidden) renderImport();
    }
    return;
  }
  // One list on this phone: add to it; an item already on the list gets the quantity added.
  const fresh = [];
  let merged = 0;
  rows.forEach((it, k) => {
    const existing = !it.done && existingFor(it.name);
    if (existing) {
      merged++;
      const added = it.qty + (existing.importNote?.added || 0);
      backend.patch([existing.id], { qty: Math.min(existing.qty + it.qty, 999), importNote: { added, at: now } }).catch(fail);
    } else fresh.push(make(it, k));
  });
  if (fresh.length) backend.put(fresh).catch(fail);
  closeSheets();
  buzz();
  showToast(merged
    ? `נוספו ${plural(fresh.length, "פריט חדש", "פריטים חדשים")}, ול־${merged === 1 ? "פריט אחד" : `${merged} פריטים`} שכבר היו ברשימה הכמות גדלה`
    : `נוספו ${plural(rows.length, "פריט", "פריטים")} לרשימה`, false);
}

// ---------- Item actions ----------
const find = (id) => ui.items.find((i) => i.id === id);
const fail = (e) => { console.error(e); showToast("משהו השתבש — נסו שוב", false); };

function addItem(text) {
  const { name, qty } = parseInput(text);
  if (!name) return;
  const existing = ui.items.find((i) => !i.done && i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    const next = Math.min(existing.qty + qty, 999);
    backend.patch([existing.id], { qty: next }).catch(fail);
    showToast(`${existing.name} כבר ברשימה — עכשיו ×${next}`, false);
  } else {
    const now = Date.now();
    backend.put([{ id: uid(), name, qty, done: false, price: null, createdAt: now, sortKey: now }]).catch(fail);
  }
  buzz();
}

function toggle(id) {
  const it = find(id);
  if (!it) return;
  buzz(it.done ? 8 : 15);
  backend.patch([id], { done: !it.done, sortKey: Date.now(), ...(it.importNote ? { importNote: null } : {}) }).catch(fail);
}

function changeQty(id, delta) {
  const it = find(id);
  if (!it) return;
  const next = it.qty + delta;
  if (next < 1) return removeItems([id]);
  buzz(5);
  backend.patch([id], { qty: Math.min(next, 999), ...(it.importNote ? { importNote: null } : {}) }).catch(fail);
}

let lastRemoved = null;
function removeItems(ids, message) {
  const items = ui.items.filter((it) => ids.includes(it.id));
  if (!items.length) return;
  lastRemoved = { items, backend };
  backend.del(ids).catch(fail);
  showToast(message || (items.length === 1 ? `${items[0].name} הוסר` : `הוסרו ${items.length} פריטים`), true);
}

function undo() {
  if (!lastRemoved) return;
  if (lastRemoved.backend === backend) backend.put(lastRemoved.items).catch(fail);
  lastRemoved = null;
  hideToast();
}

// ---------- Toast ----------
let toastTimer;
function showToast(text, undoable) {
  toastText.textContent = text;
  toastUndo.hidden = !undoable;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoable ? 5000 : 3000);
}
function hideToast() { toast.hidden = true; }
toastUndo.addEventListener("click", undo);

// ---------- Sheets ----------
let editingId = null, editQty = 1;
// The phone's back gesture/button closes an open sheet instead of leaving the app:
// opening a sheet adds a history entry, and "back" (popstate) closes it. Closing a
// sheet any other way removes that entry again. Switching straight from one sheet to
// another (menu -> share) reuses the entry, so back still takes one step.
let sheetEntry = false;   // our history entry is on top
let pendingBack = 0;      // a scheduled history.back() for a sheet that was just closed
function openSheet(el) {
  hideSheets();
  backdrop.hidden = false;
  el.hidden = false;
  if (pendingBack) { clearTimeout(pendingBack); pendingBack = 0; sheetEntry = true; } // reuse the entry
  else if (!sheetEntry) { history.pushState({ sheet: true }, ""); sheetEntry = true; }
}
function hideSheets() {
  backdrop.hidden = true;
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
  editingId = null;
}
function closeSheets() {
  hideSheets();
  // Drop our history entry, unless another sheet opens right away (it then reuses it).
  if (sheetEntry && !pendingBack) {
    sheetEntry = false;
    pendingBack = setTimeout(() => { pendingBack = 0; history.back(); }, 0);
  }
}
window.addEventListener("popstate", () => {
  if (!sheetEntry) return; // our own history.back() after closing a sheet
  sheetEntry = false;
  hideSheets();
});
backdrop.addEventListener("click", () => closeSheets());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

// Pull a sheet down anywhere on it to close it.
// The top (handle and title) drags right away. Elsewhere the first movement decides:
// a downward pull drags the sheet, unless it starts inside a list that is scrolled down
// (then the list scrolls back up first, as on any phone); anything else scrolls/taps as usual.
// Dragging up only gives a little stretch, since sheets already show everything.
const GRAB_ZONE = 64; // px from the top of the sheet that always drags
const SLOP = 8;       // px of movement before deciding what a touch is
document.querySelectorAll(".sheet").forEach((sheet) => {
  let startX = 0, startY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false, deciding = false, scroller = null;

  // The scrollable element the touch started in (or the sheet itself on short screens).
  const scrollerOf = (el) => {
    for (let n = el; n && n !== sheet.parentNode; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
      if (n === sheet) break;
    }
    return null;
  };
  const startDrag = (y, t) => {
    dragging = true; deciding = false;
    startY = lastY = y; lastT = t; velocity = 0;
    sheet.style.transition = backdrop.style.transition = "none";
  };

  const setOffset = (dy) => {
    const y = dy > 0 ? dy : -Math.sqrt(-dy) * 3; // resistance when pulling up
    sheet.style.transform = `translateY(${y}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / sheet.offsetHeight));
  };
  const reset = () => {
    sheet.style.transition = sheet.style.transform = backdrop.style.transition = backdrop.style.opacity = "";
  };

  sheet.addEventListener("touchstart", (e) => {
    dragging = deciding = false;
    if (e.touches.length !== 1 || e.target.closest("textarea, select")) return;
    const t = e.touches[0];
    if (t.clientY - sheet.getBoundingClientRect().top < GRAB_ZONE && !e.target.closest("input")) {
      startDrag(t.clientY, e.timeStamp);
      return;
    }
    deciding = true;
    startX = t.clientX; startY = t.clientY;
    scroller = scrollerOf(e.target);
  }, { passive: true });

  sheet.addEventListener("touchmove", (e) => {
    if (deciding) {
      const t = e.touches[0], dx = t.clientX - startX, dy = t.clientY - startY;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      deciding = false;
      // A downward pull, not sideways, and not while a list can still scroll up.
      if (dy > 0 && Math.abs(dy) > Math.abs(dx) && !(scroller && scroller.scrollTop > 0)) {
        startDrag(t.clientY, e.timeStamp);
        document.activeElement?.blur?.(); // a field being dragged shouldn't keep the keyboard up
      } else return;
    }
    if (!dragging) return;
    e.preventDefault(); // keep the page behind from scrolling
    const y = e.touches[0].clientY, dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (y - lastY) / dt;
    lastY = y; lastT = e.timeStamp;
    setOffset(y - startY);
  }, { passive: false });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    const dy = lastY - startY;
    const ease = "transform .22s cubic-bezier(.2, .8, .2, 1)";
    if (dy > sheet.offsetHeight * 0.25 || (dy > 20 && velocity > 0.5)) {
      sheet.style.transition = ease;
      backdrop.style.transition = "opacity .22s";
      sheet.style.transform = "translateY(100%)";
      backdrop.style.opacity = "0";
      setTimeout(() => { closeSheets(); reset(); }, 220);
    } else {
      sheet.style.transition = ease;
      backdrop.style.transition = "opacity .22s";
      sheet.style.transform = "";
      backdrop.style.opacity = "";
      setTimeout(() => { reset(); }, 220);
    }
  };
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", end);
});

// Menu
$("menuBtn").addEventListener("click", () => { renderMenu(); openSheet(menuSheet); });

function renderMenu() {
  const lists = Object.entries(ui.userLists);
  $("listSwitcher").innerHTML = cloud?.user && lists.length > 1
    ? `<p class="sheet-label">הרשימות שלי</p>` + lists.map(([id, name]) =>
        `<button class="sheet-item${id === cloud.listId ? " current" : ""}" data-action="switch" data-list="${escapeHtml(id)}">
          ${id === cloud.listId ? "✅" : "📝"} <span>${escapeHtml(name)}</span></button>`).join("") + `<hr class="sheet-sep" />`
    : "";
  const u = cloud?.user;
  $("accountRow").innerHTML = u
    ? `<hr class="sheet-sep" />
       <div class="account">
         ${avatarHtml({ name: u.displayName, email: u.email, photo: u.photoURL })}
         <div class="account-text"><strong>${escapeHtml(u.displayName || "")}</strong><span>${escapeHtml(u.email || "")}</span></div>
         <button class="link-btn" data-action="sign-out">התנתקות</button>
       </div>`
    : cloud
      ? `<hr class="sheet-sep" />
         <button class="sheet-item" data-action="sign-in">👤 <span>התחברות עם Google — לשיתוף ולגיבוי הרשימה</span></button>`
      : "";
}

// Empty the whole list (to buy + cart). Undo is offered in the toast.
$("clearAll").addEventListener("click", () => removeItems(ui.items.map((i) => i.id), "הרשימה רוקנה"));

$("cartActions").addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "uncheck-all") {
    const ids = ui.items.filter((i) => i.done).map((i) => i.id);
    if (ids.length) { buzz(8); backend.patch(ids, { done: false }).catch(fail); }
  } else if (action === "clear-done") {
    removeItems(ui.items.filter((i) => i.done).map((i) => i.id), "העגלה נוקתה");
  }
});

menuSheet.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  closeSheets();
  if (action === "uncheck-all") {
    const ids = ui.items.filter((i) => i.done).map((i) => i.id);
    if (ids.length) backend.patch(ids, { done: false }).catch(fail);
  } else if (action === "clear-done") {
    removeItems(ui.items.filter((i) => i.done).map((i) => i.id), "העגלה נוקתה");
  } else if (action === "clear-all") {
    removeItems(ui.items.map((i) => i.id), "הרשימה רוקנה");
  } else if (action === "switch") {
    openCloudList(el.dataset.list);
  } else if (action === "import") {
    openImport();
  } else if (action === "sign-out") {
    cloud.signOut().catch(fail);
  } else if (action === "sign-in") {
    signIn();
  }
});

// Edit
let editProduct = null; // { code, name } chosen in the picker, or null for "estimate"

function openEdit(id) {
  const it = find(id);
  if (!it) return;
  openSheet(editSheet);
  editingId = id;
  editQty = it.qty;
  $("editName").value = it.name;
  $("editQty").textContent = editQty;
  $("editPrice").value = typeof it.price === "number" && it.price > 0 ? it.price : "";
  const remembered = ui.choices[norm(it.name)];
  editProduct = it.barcode ? { code: it.barcode, name: it.productName } : remembered || null;
  // The name field also searches the store's products (when a store is chosen).
  $("productStore").textContent = ui.cat ? `(${ui.cat.name})` : "";
  $("productList").hidden = !ui.cat;
  if (ui.cat) renderProducts();
}

function renderProducts() {
  const q = $("editName").value.trim();
  const results = ui.cat && q ? search(ui.cat, q, 40) : [];
  const sel = editProduct?.code;
  const selected = sel && ui.cat.byCode.get(sel);
  const list = selected && !results.includes(selected) ? [selected, ...results] : results;
  // First option: let the app decide (the clearly-meant product, or a typical price).
  const auto = ui.cat && resolve(ui.cat, $("editName").value.trim());
  $("productList").innerHTML = `
    <li><button type="button" class="product${!sel ? " selected" : ""}" data-code="" role="option" aria-selected="${!sel}">
      <span class="product-name">${auto ? `אוטומטי — ${escapeHtml(auto.name)}` : "לא משנה איזה — לפי הערכה"}</span>
      <span class="product-price${auto ? "" : " muted"}">${auto ? amt(money(auto.price)) + (auto.weighted ? "<small>לק״ג</small>" : "") : "מחיר טיפוסי"}</span>
    </button></li>` +
    list.map((p) => `
    <li><button type="button" class="product${p.code === sel ? " selected" : ""}" data-code="${escapeHtml(p.code)}" role="option" aria-selected="${p.code === sel}">
      <span class="product-name">${escapeHtml(p.name)}${p.brand ? `<small>${escapeHtml(p.brand)}</small>` : ""}</span>
      <span class="product-price">${amt(money(p.price))}${p.weighted ? "<small>לק״ג</small>" : ""}</span>
    </button></li>`).join("") +
    (q && !results.length ? `<li class="products-empty">לא מצאנו מוצרים בשם הזה</li>` : "");
}

let productSearchTimer;
$("editName").addEventListener("input", () => {
  if (!ui.cat) return;
  clearTimeout(productSearchTimer);
  productSearchTimer = setTimeout(renderProducts, 120);
});
$("productList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (!b) return;
  const p = b.dataset.code && ui.cat?.byCode.get(b.dataset.code);
  editProduct = p ? { code: p.code, name: p.name } : null;
  buzz(5);
  renderProducts();
  // Picking a product is the decision: save right away (with any name/qty/price edits)
  // so nobody has to scroll down to the save button.
  $("editForm").requestSubmit();
});
editSheet.addEventListener("click", (e) => {
  const step = e.target.closest("[data-step]");
  if (!step) return;
  editQty = Math.min(Math.max(editQty + +step.dataset.step, 1), 999);
  $("editQty").textContent = editQty;
  buzz(5);
});
$("editForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = editingId;
  const it = find(id);
  const name = $("editName").value.trim();
  if (it && name) {
    const fields = { name: capitalize(name), qty: editQty };
    const price = parseFloat($("editPrice").value);
    fields.price = price > 0 && price <= 5000 ? Math.round(price * 100) / 100 : null;
    if (ui.cat) {
      // Link the chosen product to the item (shared with everyone on the list), and
      // remember it for this item name so next time "גבינה" means the same cheese.
      fields.barcode = editProduct?.code || null;
      fields.productName = editProduct?.name || null;
      const key = norm(fields.name);
      if (editProduct) ui.choices[key] = editProduct; else delete ui.choices[key];
      store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), choices: ui.choices });
    }
    backend.patch([id], fields).catch(fail);
  }
  closeSheets();
});
$("editDelete").addEventListener("click", () => {
  const id = editingId;
  closeSheets();
  removeItems([id]);
});

// ---------- Rename the list ----------
// Tap the list's name. A shared list is renamed for everyone on it; a list kept only
// on this phone keeps its name here.
const listName = () => (backend === cloud && ui.list ? ui.list.name : prefs.listName) || "הסל שלי";
const renameSheet = $("renameSheet");
$("listTitle").addEventListener("click", () => {
  $("renameInput").value = listName();
  $("renameNote").textContent = backend === cloud && ui.members.length > 1 ? "השם משתנה לכל מי שברשימה" : "";
  openSheet(renameSheet);
  setTimeout(() => { $("renameInput").focus(); $("renameInput").select(); }, 250);
});
$("renameCancel").addEventListener("click", () => closeSheets());
$("renameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("renameInput").value.replace(/\s+/g, " ").trim().slice(0, 40);
  closeSheets();
  if (!name || name === listName()) return;
  if (backend === cloud && ui.list) {
    ui.list = { ...ui.list, name };
    if (ui.userLists[cloud.listId] !== undefined) ui.userLists[cloud.listId] = name;
    render();
    try { await cloud.renameList(name); } catch (err) { fail(err); }
  } else {
    prefs.listName = name;
    store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), listName: name });
    render();
  }
  buzz(8);
  showToast(`שם הרשימה: ${name}`, false);
});

// ---------- Sharing ----------
$("shareBtn").addEventListener("click", () => {
  renderShare();
  openSheet(shareSheet);
});

function shareLink() {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("join", `${ui.list.id}.${ui.list.inviteCode}`);
  return u.toString();
}
const shareMessage = () => `בואו נעשה קניות ביחד 🛒\nהצטרפו לרשימה "${ui.list.name}":\n${shareLink()}`;

function renderShare() {
  const body = $("shareBody");
  if (!cloud) {
    body.innerHTML = `
      <h3 id="shareTitle">שיתוף הרשימה</h3>
      <p class="sheet-note">השיתוף עוד לא הוגדר. צריך לחבר את האפליקציה ל-Firebase (ראו README).</p>
      <button class="sheet-item cancel" data-share="close">סגירה</button>`;
    return;
  }
  if (!cloud.user) {
    body.innerHTML = `
      <h3 id="shareTitle">שיתוף הרשימה</h3>
      <p class="sheet-note">כדי לשתף את הרשימה ולראות שינויים של אחרים בזמן אמת, צריך להתחבר פעם אחת עם Google.
        הרשימה שכבר יש לך תעבור איתך.</p>
      <button class="google-btn" data-share="sign-in">${$("googleBtn").querySelector("svg").outerHTML}<span>כניסה עם Google</span></button>
      <button class="sheet-item cancel" data-share="close">לא עכשיו</button>`;
    return;
  }
  if (!ui.list) {
    body.innerHTML = `<h3 id="shareTitle">שיתוף הרשימה</h3><p class="sheet-note">טוען…</p>`;
    return;
  }
  const myId = cloud.user.uid;
  const iOwn = ui.list.ownerId === myId;
  const members = ui.members.slice().sort((a, b) => (a.id === ui.list.ownerId ? -1 : b.id === ui.list.ownerId ? 1 : 0));
  const wa = `https://wa.me/?text=${encodeURIComponent(shareMessage())}`;
  const mail = `mailto:?subject=${encodeURIComponent("רשימת קניות משותפת 🛒")}&body=${encodeURIComponent(shareMessage())}`;

  body.innerHTML = `
    <h3 id="shareTitle">שיתוף "${escapeHtml(ui.list.name)}"</h3>
    <p class="sheet-note">שלחו קישור — מי שמצטרף/ת רואה ועורך/ת את הרשימה איתכם בזמן אמת.</p>
    <div class="share-grid">
      <a class="share-opt wa" href="${wa}" target="_blank" rel="noopener">
        <span class="share-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4z"/><path d="M9 8.6c.2-.5.5-.6.8-.6h.5c.2 0 .4.1.5.4l.7 1.6c.1.2 0 .5-.1.6l-.5.6c-.1.2-.1.4 0 .5.6 1 1.4 1.8 2.4 2.3.2.1.4.1.5 0l.6-.7c.2-.2.4-.2.6-.1l1.6.8c.2.1.3.3.3.5v.4c0 .4-.2.8-.6 1-.6.3-1.4.5-2.3.2a9 9 0 0 1-5.2-5c-.3-.8-.2-1.7.2-2.5z" fill="currentColor" stroke="none"/></svg></span>
        <span>וואטסאפ</span>
      </a>
      <a class="share-opt mail" href="${mail}">
        <span class="share-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg></span>
        <span>אימייל</span>
      </a>
      <button class="share-opt copy" data-share="copy">
        <span class="share-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></span>
        <span>העתקת קישור</span>
      </button>
      ${navigator.share ? `
      <button class="share-opt more" data-share="native">
        <span class="share-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg></span>
        <span>עוד…</span>
      </button>` : ""}
    </div>

    <p class="sheet-label">משתתפים (${members.length})</p>
    <ul class="members">
      ${members.map((m) => `
        <li class="member">
          ${avatarHtml(m)}
          <div class="member-text">
            <strong>${escapeHtml(m.name || m.email)}${m.id === myId ? " (אני)" : ""}</strong>
            <span>${m.id === ui.list.ownerId ? "יוצר/ת הרשימה" : escapeHtml(m.email || "")}</span>
          </div>
          ${iOwn && m.id !== myId ? `<button class="link-btn danger" data-share="remove" data-uid="${escapeHtml(m.id)}">הסרה</button>` : ""}
        </li>`).join("")}
    </ul>

    ${iOwn
      ? `<button class="link-btn muted" data-share="reset">🔒 איפוס קישור ההזמנה (הקישור הישן יפסיק לעבוד)</button>`
      : `<button class="link-btn danger" data-share="leave">עזיבת הרשימה</button>`}
    <button class="sheet-item cancel" data-share="close">סגירה</button>`;
}

shareSheet.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-share]");
  if (!el) return;
  const act = el.dataset.share;
  try {
    if (act === "close") closeSheets();
    else if (act === "sign-in") { closeSheets(); await signIn(); }
    else if (act === "copy") {
      await navigator.clipboard.writeText(shareLink());
      showToast("הקישור הועתק 📋", false);
    } else if (act === "native") {
      await navigator.share({ title: "רשימת קניות משותפת", text: shareMessage() }).catch(() => {});
    } else if (act === "remove") {
      const m = ui.members.find((x) => x.id === el.dataset.uid);
      if (m && confirm(`להסיר את ${m.name || m.email} מהרשימה?`)) await cloud.removeMember(m.id);
    } else if (act === "reset") {
      if (confirm("לאפס את קישור ההזמנה? מי שכבר ברשימה יישאר, אבל הקישור הישן יפסיק לעבוד.")) {
        await cloud.resetInvite(ui.list);
        showToast("נוצר קישור הזמנה חדש", false);
      }
    } else if (act === "leave") {
      if (confirm("לעזוב את הרשימה? היא תיעלם מהמכשיר שלך.")) {
        closeSheets();
        await cloud.leave();
        await openFallbackList();
        showToast("עזבת את הרשימה", false);
      }
    }
  } catch (err) { fail(err); }
});

// ---------- List interactions ----------
let suppressClick = false;
function onListClick(e) {
  if (suppressClick) { suppressClick = false; return; }
  const btn = e.target.closest("[data-act]");
  const li = e.target.closest(".item");
  if (!btn || !li) return;
  const id = li.dataset.id;
  switch (btn.dataset.act) {
    case "toggle": return toggle(id);
    case "edit": return openEdit(id);
    case "inc": return changeQty(id, 1);
    case "dec": return changeQty(id, -1);
  }
}
todoList.addEventListener("click", onListClick);
doneList.addEventListener("click", onListClick);

doneToggle.addEventListener("click", () => {
  ui.doneOpen = !ui.doneOpen;
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), doneOpen: ui.doneOpen });
  render();
});

// Swipe toward the end side to delete: right in RTL (Hebrew), left in LTR.
const SWIPE_DIR = document.documentElement.dir === "rtl" ? 1 : -1;
function enableSwipe(list) {
  let startX = 0, startY = 0, dx = 0, body = null, li = null, active = false, decided = false;

  list.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    body = e.target.closest(".item-body");
    if (!body) return;
    li = body.parentElement;
    startX = e.clientX; startY = e.clientY; dx = 0;
    active = true; decided = false;
  });

  list.addEventListener("pointermove", (e) => {
    if (!active) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx) || mx * SWIPE_DIR < 0) { active = false; return; }
      li.classList.add("dragging");
      body.setPointerCapture?.(e.pointerId);
    }
    dx = SWIPE_DIR * Math.max(0, mx * SWIPE_DIR);
    body.style.transform = `translateX(${dx}px)`;
  });

  function end() {
    if (!active) return;
    active = false;
    if (!decided) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 50);
    const threshold = Math.min(120, body.offsetWidth * 0.35);
    li.classList.toggle("removing", Math.abs(dx) > threshold);
    li.classList.remove("dragging");
    if (Math.abs(dx) > threshold) {
      body.style.transform = `translateX(${SWIPE_DIR * 110}%)`;
      buzz(20);
      const id = li.dataset.id;
      setTimeout(() => removeItems([id]), 180);
    } else {
      body.style.transform = "";
    }
  }
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
}
enableSwipe(todoList);
enableSwipe(doneList);

// ---------- Composer ----------
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  addItem(text);
  input.value = "";
  input.focus(); // keep keyboard open for quick multi-add
});

// ---------- Screens ----------
function showScreen(name) {
  $("splash").hidden = name !== "splash";
  $("login").hidden = name !== "login";
  $("appRoot").hidden = name !== "app";
}

// ---------- Cloud flow ----------
function readJoinParam() {
  const p = new URLSearchParams(location.search).get("join");
  if (!p) return;
  const m = p.match(/^([A-Za-z0-9]{10,40})\.([a-f0-9]{32})$/);
  if (m) { try { sessionStorage.setItem(JOIN_KEY, JSON.stringify({ listId: m[1], code: m[2] })); } catch (_) {} }
  history.replaceState(null, "", location.pathname);
}
function peekJoin() { try { return JSON.parse(sessionStorage.getItem(JOIN_KEY) || "null"); } catch (_) { return null; } }
function takeJoin() { const j = peekJoin(); try { sessionStorage.removeItem(JOIN_KEY); } catch (_) {} return j; }

function describeRemote(changes) {
  const by = changes.find((c) => c.by)?.by || "מישהו";
  if (changes.length > 1) return `${by} עדכן/ה ${changes.length} פריטים`;
  const { type, item } = changes[0];
  if (type === "removed") return `${item.name} נמחק/ה מהרשימה`;
  if (type === "added") return `${by} הוסיף/ה ${item.name}`;
  return item.done ? `${by} שם/ה ${item.name} בעגלה 🛒` : `${by} עדכן/ה ${item.name}`;
}

function openCloudList(id) {
  backend = cloud;
  ui.items = []; ui.members = []; ui.list = null; ui.flash.clear();
  lastRemoved = null;
  render();
  cloud.setActive(id).catch(() => {});
  cloud.open(id, {
    onItems(items) { ui.items = items; render(); },
    onList(list) {
      ui.list = list;
      if (list?.name && ui.userLists[list.id] !== undefined && ui.userLists[list.id] !== list.name) {
        ui.userLists[list.id] = list.name;
        cloud.setIndexName(list.id, list.name);
      }
      render();
      if (!shareSheet.hidden) renderShare();
      if (list.store) loadStore(currentStoreId()); // someone on the list picked a store, a branch or "no store" (no-op if unchanged)
    },
    onMembers(members) { ui.members = members; render(); if (!shareSheet.hidden) renderShare(); },
    onRemote(changes) {
      changes.forEach((c) => {
        if (c.type === "removed") return;
        ui.flash.add(c.item.id);
        setTimeout(() => { ui.flash.delete(c.item.id); render(); }, 2500);
      });
      render();
      buzz(15);
      showToast(describeRemote(changes), false);
    },
    onLost() {
      showToast("אין לך יותר גישה לרשימה הזו", false);
      cloud.unindexList(id);
      delete ui.userLists[id];
      openFallbackList(id);
    },
  });
}

let fallbackBusy = false;
async function openFallbackList(excludeId) {
  if (fallbackBusy) return;
  fallbackBusy = true;
  try {
    const data = await cloud.getUserData();
    const ids = Object.keys(data.lists || {}).filter((x) => x !== excludeId);
    openCloudList(ids[0] || (await cloud.createList()));
  } catch (e) { fail(e); }
  finally { fallbackBusy = false; }
}

let authRun = 0;
async function enterCloud() {
  const run = ++authRun;
  greeting();
  showScreen("app");
  try {
    cloud.watchUser((data) => { ui.userLists = data.lists || {}; });
    const data = await cloud.getUserData();
    let id = null;

    const join = takeJoin();
    if (join) {
      try {
        id = await cloud.join(join.listId, join.code);
        showToast("הצטרפת לרשימה! 🎉", false);
      } catch (e) {
        console.error(e);
        showToast(e.code === "invalid-invite" ? "קישור ההזמנה כבר לא בתוקף" : "לא הצלחנו להצטרף לרשימה", false);
      }
    }

    const lists = data.lists || {};
    if (!id && local.items.length) {
      // Signing in with a list on this phone: move it to the cloud so it can be shared.
      id = await cloud.createList(local.items);
      local.clear();
    }
    if (!id) id = data.activeListId && lists[data.activeListId] !== undefined ? data.activeListId : Object.keys(lists)[0];
    if (!id) id = await cloud.createList();
    if (run === authRun) openCloudList(id);
  } catch (e) {
    fail(e);
  }
}

function enterLocal() {
  backend = local;
  ui.list = null; ui.members = [];
  local.subscribe((items) => { if (backend === local) { ui.items = items; render(); } });
  greeting();
  showScreen("app");
  if (ui.chains.length) loadStore(currentStoreId());
}

async function boot() {
  readJoinParam();
  initStores(); // store list + prices load in the background
  if (!firebaseConfig) {
    console.info("Firebase is not configured — running in local mode.");
    return enterLocal();
  }
  try {
    cloud = await createCloudSafe();
  } catch (e) {
    console.error("Firebase failed to load — falling back to local mode", e);
    cloud = null;
    return enterLocal();
  }

  $("googleBtn").addEventListener("click", async () => {
    $("loginError").hidden = true;
    try { await cloud.signIn(); }
    catch (e) {
      console.error(e);
      $("loginError").textContent = signInErrorText(e);
      $("loginError").hidden = false;
    }
  });
  $("skipLogin").addEventListener("click", () => { takeJoin(); enterLocal(); });

  cloud.onAuth((user) => {
    if (user) return enterCloud();
    // Signed out: the app works on this device only. Signing in is optional,
    // except to accept an invite link — then we show the login screen.
    authRun++;
    ui.userLists = {};
    closeSheets();
    if (peekJoin()) {
      $("loginSub").textContent = "הוזמנתם לרשימת קניות משותפת 🛒 התחברו עם Google כדי להצטרף.";
      showScreen("login");
    } else {
      enterLocal();
    }
  });
}

function signInErrorText(e) {
  const code = e?.code || "";
  if (code === "auth/network-request-failed") return "אין חיבור לאינטרנט. נסו שוב.";
  if (["auth/configuration-not-found", "auth/operation-not-allowed", "auth/unauthorized-domain"].includes(code)) {
    return `ההתחברות עם Google עוד לא מופעלת באפליקציה (${code}).`;
  }
  return `ההתחברות נכשלה. נסו שוב.${code ? ` (${code})` : ""}`;
}

async function signIn() {
  if (!cloud) return;
  try { await cloud.signIn(); }
  catch (e) { console.error(e); showToast(signInErrorText(e), false); }
}

async function createCloudSafe() {
  const { createCloud } = await import("./cloud.js");
  return createCloud(firebaseConfig);
}

boot();
