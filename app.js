import { firebaseConfig } from "./firebase-config.js";
import { loadIndex, loadChain, search, resolve, priceItem, norm, money } from "./catalog.js";

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
const SUGGESTIONS = ["חלב", "ביצים", "לחם", "בננות", "עגבניות", "גבינה", "קפה", "עוף"];

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
  suggestOff: prefs.suggestOff ?? false, // true once the user types an item themselves
  chains: [],        // available stores from the catalog index
  cat: null,         // loaded catalog of the selected store
  catId: null,       // id of the catalog in ui.cat (or being loaded)
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
const emptyState = $("emptyState"), suggestions = $("suggestions");
const progressLabel = $("progressLabel"), progressCount = $("progressCount"), progressFill = $("progressFill");
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
    const label = it.productName || ui.choices[norm(it.name)]?.name || p.product.name;
    return `<div class="item-price">${amt(money(p.total))}${perKg}${qtyNote} <span class="muted">· ${escapeHtml(label)}</span></div>`;
  }
  if (p.kind === "estimate") {
    const note = p.missingProduct ? "המוצר שבחרתם לא נמצא כאן · " : "";
    const kinds = p.count > 1 ? `יש ${p.count} סוגים — ` : "";
    return `<div class="item-price est">${amt("~" + money(p.total))}${p.weighted ? " לק״ג" : ""}${qtyNote} <span class="pick">${note}${kinds}הקישו לבחירה</span></div>`;
  }
  return `<div class="item-price none">לא נמצא ב${escapeHtml(ui.cat.name)}</div>`;
}

function itemHtml(it) {
  const name = escapeHtml(it.name);
  return `
    <li class="item${it.done ? " done" : ""}${ui.flash.has(it.id) ? " flash" : ""}" data-id="${escapeHtml(it.id)}">
      <div class="item-delete-hint" aria-hidden="true">מחיקה</div>
      <div class="item-body">
        <button class="check" data-act="toggle" aria-label="${it.done ? "החזרה לרשימה" : "סימון כנמצא בעגלה"}: ${name}">
          <span class="check-box">${CHECK_SVG}</span>
        </button>
        <button class="item-main" data-act="edit" aria-label="עריכת ${name}">
          <div class="item-name"><span class="item-emoji" aria-hidden="true">${emojiFor(it.name)}</span>${name}</div>
          ${priceLine(it)}
          ${ui.flash.has(it.id) && it.updatedByName ? `<div class="item-by">${escapeHtml(it.updatedByName)} עדכן/ה עכשיו</div>` : ""}
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
  doneList.innerHTML = done.map(itemHtml).join("");

  emptyState.hidden = total > 0;
  doneSection.hidden = done.length === 0;
  doneCount.textContent = done.length;
  doneToggle.setAttribute("aria-expanded", String(ui.doneOpen));
  doneList.hidden = !ui.doneOpen;

  const pct = total ? Math.round((done.length / total) * 100) : 0;
  progressFill.style.width = pct + "%";
  progressCount.textContent = total ? `${done.length} / ${total}` : "";
  progressLabel.textContent =
    !total ? "הרשימה עדיין ריקה" :
    done.length === total ? "סיימתם — כל הכבוד! 🎉" :
    done.length === 0 ? `${plural(todo.length, "פריט", "פריטים")} לקנות` :
    `נשארו עוד ${plural(todo.length, "פריט", "פריטים")}`;

  renderTotal(items);
  renderStores();

  // Suggestions: tapping one adds it and removes just that chip (it's now on the list).
  // They stay until the user types an item manually; an empty list brings them back.
  if (!total && ui.suggestOff) setSuggestOff(false);
  const onList = new Set(items.map((i) => i.name));
  const sugg = ui.suggestOff ? [] : SUGGESTIONS.filter((s) => !onList.has(s));
  $("suggestBlock").hidden = !sugg.length;
  $("suggestBlock").classList.toggle("compact", total > 0);
  $("suggestHead").hidden = !total;
  suggestions.innerHTML = sugg.map((s) => `<button class="chip" data-name="${s}">${emojiFor(s)} ${s}</button>`).join("");

  // Header: list name + who's in it
  $("listTitle").textContent = ui.list?.name || "הסל שלי";
  const others = ui.members.filter((m) => m.id !== cloud?.user?.uid);
  $("avatars").innerHTML = others.slice(0, 3).map((m) => avatarHtml(m, "avatar sm")).join("");
  $("shareBtn").classList.toggle("shared", others.length > 0);
  $("shareBtn").setAttribute("aria-label", others.length ? `משותף עם ${others.length} — ניהול שיתוף` : "שיתוף הרשימה");
}

function renderTotal(items) {
  const box = $("totalBox");
  const anyManual = items.some((i) => i._price.kind === "manual");
  box.hidden = !items.length || (!ui.cat && !anyManual);
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
const currentStoreId = () => (backend === cloud && ui.list?.store) || prefs.store || null;

function renderStores() {
  const row = $("storeRow");
  const sel = currentStoreId();
  if (!ui.chains.length) {
    row.innerHTML = "";
    $("storeNote").textContent = ui.catError ? "לא הצלחנו לטעון את רשימת החנויות. בדקו את החיבור לאינטרנט." : "טוען חנויות…";
    return;
  }
  row.innerHTML = ui.chains.map((c) => `
    <button class="store${c.id === sel ? " selected" : ""}" role="radio" aria-checked="${c.id === sel}" data-store="${escapeHtml(c.id)}"
            style="--store-color:${/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#2f9e6b"}">
      <span class="store-circle">${escapeHtml(c.name.split(" ").map((w) => w[0]).join("").slice(0, 2))}</span>
      <span class="store-name">${escapeHtml(c.name)}</span>
    </button>`).join("");
  const c = ui.chains.find((x) => x.id === sel);
  $("storeNote").textContent = !sel
    ? "בחרו חנות כדי לראות כמה הקנייה תעלה"
    : ui.catId === sel && !ui.cat
      ? (ui.catError ? "לא הצלחנו לטעון את המחירים. נסו שוב." : "טוען מחירים…")
      : c ? `מחירים מ${c.store ? `${c.store}` : c.name} · עודכן ${new Date(c.updated).toLocaleDateString("he-IL")}` : "";
}

async function loadStore(id) {
  if (!id) { ui.cat = null; ui.catId = null; render(); return; }
  if (ui.catId === id && (ui.cat || !ui.catError)) return;
  ui.catId = id; ui.cat = null; ui.catError = false;
  render();
  try {
    const cat = await loadChain(id);
    if (ui.catId === id) { ui.cat = cat; render(); }
  } catch (e) {
    console.error(e);
    if (ui.catId === id) { ui.catError = true; render(); }
  }
}

function selectStore(id) {
  if (id === currentStoreId()) id = null; // tapping the selected store clears it
  prefs.store = id;
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), store: id });
  if (backend === cloud && ui.list) cloud.setListStore(id).catch(fail);
  buzz(8);
  loadStore(id);
  if (id) $("storeRow").querySelector(`[data-store="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}

$("storeRow").addEventListener("click", (e) => {
  const b = e.target.closest("[data-store]");
  if (b) selectStore(b.dataset.store);
});

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
  loadStore(currentStoreId());
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
  backend.patch([id], { done: !it.done, sortKey: Date.now() }).catch(fail);
}

function changeQty(id, delta) {
  const it = find(id);
  if (!it) return;
  const next = it.qty + delta;
  if (next < 1) return removeItems([id]);
  buzz(5);
  backend.patch([id], { qty: Math.min(next, 999) }).catch(fail);
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
function openSheet(el) {
  closeSheets();
  backdrop.hidden = false;
  el.hidden = false;
}
function closeSheets() {
  backdrop.hidden = true;
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
  editingId = null;
}
backdrop.addEventListener("click", closeSheets);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

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
  $("productField").hidden = !ui.cat;
  if (ui.cat) {
    $("productStore").textContent = `(${ui.cat.name})`;
    $("productSearch").value = it.name;
    renderProducts();
  }
}

function renderProducts() {
  const q = $("productSearch").value.trim();
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
$("productSearch").addEventListener("input", () => {
  clearTimeout(productSearchTimer);
  productSearchTimer = setTimeout(renderProducts, 120);
});
$("productSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
$("productList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (!b) return;
  const p = b.dataset.code && ui.cat?.byCode.get(b.dataset.code);
  editProduct = p ? { code: p.code, name: p.name } : null;
  buzz(5);
  renderProducts();
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

function setSuggestOff(off) {
  ui.suggestOff = off;
  store.set(PREFS_KEY, { ...store.get(PREFS_KEY, {}), doneOpen: ui.doneOpen, suggestOff: off });
}

suggestions.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) addItem(chip.dataset.name);
});
$("suggestClose").addEventListener("click", () => { setSuggestOff(true); render(); });

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
  setSuggestOff(true); // typing your own item hides the suggestions
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
      render();
      if (!shareSheet.hidden) renderShare();
      if (list.store && list.store !== ui.catId) loadStore(list.store); // someone on the list picked a store
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
