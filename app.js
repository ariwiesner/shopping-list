(() => {
  "use strict";

  const STORAGE_KEY = "basket.v1";

  // ---------- State ----------
  // Each item keeps a `price` field (null for now) so the cost calculation
  // can be added later without migrating saved lists.
  let state = load();
  let lastRemoved = null; // { items: [...], indexes: [...] } for undo
  let editingId = null;
  let editQty = 1;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.items)) return { doneOpen: true, ...data };
    } catch (_) { /* private mode / blocked storage */ }
    return { items: [], doneOpen: true };
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- Helpers ----------
  const EMOJI = [
    [/milk|חלב/i, "🥛"], [/egg|ביצ/i, "🥚"], [/bread|לחם|פית/i, "🍞"], [/cheese|גבינ/i, "🧀"],
    [/butter|חמא/i, "🧈"], [/yog|יוגורט/i, "🥣"], [/apple|תפוח/i, "🍎"], [/banana|בננ/i, "🍌"],
    [/tomato|עגבני/i, "🍅"], [/cucumber|מלפפון/i, "🥒"], [/potato|תפוחי אדמה|תפו"א/i, "🥔"],
    [/onion|בצל/i, "🧅"], [/garlic|שום/i, "🧄"], [/carrot|גזר/i, "🥕"], [/lemon|לימון/i, "🍋"],
    [/orange|תפוז/i, "🍊"], [/grape|ענב/i, "🍇"], [/strawberr|תות/i, "🍓"], [/avocado|אבוקדו/i, "🥑"],
    [/pepper|פלפל/i, "🫑"], [/lettuce|salad|חסה|סלט/i, "🥬"], [/chicken|עוף|שניצל/i, "🍗"],
    [/meat|beef|steak|בשר/i, "🥩"], [/fish|salmon|tuna|דג|טונה/i, "🐟"], [/rice|אורז/i, "🍚"],
    [/pasta|spaghetti|פסטה/i, "🍝"], [/coffee|קפה/i, "☕"], [/tea\b|תה/i, "🍵"],
    [/water|מים/i, "💧"], [/juice|מיץ/i, "🧃"], [/wine|יין/i, "🍷"], [/beer|בירה/i, "🍺"],
    [/chocolate|שוקולד/i, "🍫"], [/cookie|עוגי/i, "🍪"], [/cake|עוג/i, "🍰"], [/sugar|סוכר/i, "🍬"],
    [/salt|מלח/i, "🧂"], [/honey|דבש/i, "🍯"], [/oil|שמן/i, "🫒"], [/flour|קמח/i, "🌾"],
    [/corn|תירס/i, "🌽"], [/soap|סבון/i, "🧼"], [/shampoo|שמפו/i, "🧴"], [/tissue|toilet|נייר/i, "🧻"],
    [/sponge|ספוג/i, "🧽"], [/diaper|חיתול/i, "👶"], [/ice cream|גלידה/i, "🍦"], [/pizza|פיצה/i, "🍕"],
  ];
  const emojiFor = (name) => (EMOJI.find(([re]) => re.test(name)) || [, "🛒"])[1];

  const SUGGESTIONS = ["Milk", "Eggs", "Bread", "Bananas", "Tomatoes", "Cheese", "Coffee", "Chicken"];

  // "2 milk", "milk x3", "milk 3" → { name, qty }
  function parseInput(text) {
    let s = text.trim().replace(/\s+/g, " ");
    let qty = 1;
    let m = s.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i);
    if (m) { qty = +m[1]; s = m[2]; }
    else if ((m = s.match(/^(.+?)\s*[x×]\s*(\d{1,3})$/i)) || (m = s.match(/^(.+?)\s+(\d{1,3})$/))) {
      s = m[1]; qty = +m[2];
    }
    qty = Math.min(Math.max(qty || 1, 1), 999);
    return { name: s.charAt(0).toUpperCase() + s.slice(1), qty };
  }

  const buzz = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const todoList = $("todoList"), doneList = $("doneList");
  const doneSection = $("doneSection"), doneToggle = $("doneToggle"), doneCount = $("doneCount");
  const emptyState = $("emptyState"), suggestions = $("suggestions");
  const progressLabel = $("progressLabel"), progressCount = $("progressCount"), progressFill = $("progressFill");
  const composer = $("composer"), input = $("itemInput");
  const sheet = $("sheet"), editSheet = $("editSheet"), backdrop = $("sheetBackdrop");
  const toast = $("toast"), toastText = $("toastText"), toastUndo = $("toastUndo");

  function greeting() {
    const h = new Date().getHours();
    $("greeting").textContent = h < 5 ? "Late-night shopping? 🌙" : h < 12 ? "Good morning ☀️" : h < 18 ? "Good afternoon 👋" : "Good evening 🌆";
  }

  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function itemHtml(it) {
    const name = escapeHtml(it.name);
    return `
      <li class="item${it.done ? " done" : ""}" data-id="${it.id}">
        <div class="item-delete-hint" aria-hidden="true">Delete</div>
        <div class="item-body">
          <button class="check" data-act="toggle" aria-label="${it.done ? "Move back to list" : "Mark as in cart"}: ${name}">
            <span class="check-box">${CHECK_SVG}</span>
          </button>
          <button class="item-main" data-act="edit" aria-label="Edit ${name}">
            <div class="item-name"><span class="item-emoji" aria-hidden="true">${emojiFor(it.name)}</span>${name}</div>
          </button>
          <div class="stepper" role="group" aria-label="Quantity">
            <button data-act="dec" aria-label="Decrease quantity">−</button>
            <output aria-live="polite">${it.qty}</output>
            <button data-act="inc" aria-label="Increase quantity">+</button>
          </div>
          ${it.qty > 1 ? `<span class="qty-badge">×${it.qty}</span>` : ""}
        </div>
      </li>`;
  }

  function render() {
    const todo = state.items.filter((i) => !i.done);
    const done = state.items.filter((i) => i.done);
    const total = state.items.length;

    todoList.innerHTML = todo.map(itemHtml).join("");
    doneList.innerHTML = done.map(itemHtml).join("");

    emptyState.hidden = total > 0;
    doneSection.hidden = done.length === 0;
    doneCount.textContent = done.length;
    doneToggle.setAttribute("aria-expanded", String(state.doneOpen));
    doneList.hidden = !state.doneOpen;

    // Progress
    const pct = total ? Math.round((done.length / total) * 100) : 0;
    progressFill.style.width = pct + "%";
    progressCount.textContent = total ? `${done.length} / ${total}` : "";
    progressLabel.textContent =
      !total ? "Nothing on the list yet" :
      done.length === total ? "All done — great job! 🎉" :
      done.length === 0 ? `${todo.length} item${todo.length > 1 ? "s" : ""} to get` :
      `${todo.length} left to go`;

    if (!total) {
      suggestions.innerHTML = SUGGESTIONS.map((s) => `<button class="chip" data-name="${s}">${emojiFor(s)} ${s}</button>`).join("");
    }
  }

  function commit() { save(); render(); }

  // ---------- Actions ----------
  function addItem(text) {
    const { name, qty } = parseInput(text);
    if (!name) return;
    const existing = state.items.find((i) => !i.done && i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty = Math.min(existing.qty + qty, 999);
      commit();
      showToast(`${existing.name} is already on the list — now ×${existing.qty}`, false);
    } else {
      state.items.unshift({ id: uid(), name, qty, done: false, price: null, createdAt: Date.now() });
      commit();
    }
    buzz();
  }

  const find = (id) => state.items.find((i) => i.id === id);

  function toggle(id) {
    const it = find(id);
    if (!it) return;
    it.done = !it.done;
    // Move to top of its new group so the latest action is easy to see.
    state.items = [it, ...state.items.filter((i) => i !== it)];
    buzz(it.done ? 15 : 8);
    commit();
  }

  function changeQty(id, delta) {
    const it = find(id);
    if (!it) return;
    const next = it.qty + delta;
    if (next < 1) return removeItems([id]);
    it.qty = Math.min(next, 999);
    buzz(5);
    commit();
  }

  function removeItems(ids, message) {
    const indexes = [], items = [];
    state.items.forEach((it, idx) => { if (ids.includes(it.id)) { indexes.push(idx); items.push(it); } });
    if (!items.length) return;
    state.items = state.items.filter((it) => !ids.includes(it.id));
    lastRemoved = { items, indexes };
    commit();
    showToast(message || (items.length === 1 ? `Removed ${items[0].name}` : `Removed ${items.length} items`), true);
  }

  function undo() {
    if (!lastRemoved) return;
    lastRemoved.indexes.forEach((idx, n) => state.items.splice(idx, 0, lastRemoved.items[n]));
    lastRemoved = null;
    hideToast();
    commit();
  }

  // ---------- Toast ----------
  let toastTimer;
  function showToast(text, undoable) {
    toastText.textContent = text;
    toastUndo.hidden = !undoable;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undoable ? 5000 : 2500);
  }
  function hideToast() { toast.hidden = true; }
  toastUndo.addEventListener("click", undo);

  // ---------- Sheets ----------
  function openSheet(el) {
    backdrop.hidden = false;
    el.hidden = false;
  }
  function closeSheets() {
    backdrop.hidden = true;
    sheet.hidden = true;
    editSheet.hidden = true;
    editingId = null;
  }
  backdrop.addEventListener("click", closeSheets);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

  $("menuBtn").addEventListener("click", () => openSheet(sheet));
  sheet.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    closeSheets();
    if (action === "uncheck-all") {
      state.items.forEach((i) => (i.done = false));
      commit();
    } else if (action === "clear-done") {
      removeItems(state.items.filter((i) => i.done).map((i) => i.id), "Cleared the cart");
    } else if (action === "clear-all") {
      removeItems(state.items.map((i) => i.id), "Started a new list");
    }
  });

  function openEdit(id) {
    const it = find(id);
    if (!it) return;
    editingId = id;
    editQty = it.qty;
    $("editName").value = it.name;
    $("editQty").textContent = editQty;
    openSheet(editSheet);
  }
  editSheet.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (!step) return;
    editQty = Math.min(Math.max(editQty + +step.dataset.step, 1), 999);
    $("editQty").textContent = editQty;
    buzz(5);
  });
  $("editForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const it = find(editingId);
    const name = $("editName").value.trim();
    if (it && name) {
      it.name = name.charAt(0).toUpperCase() + name.slice(1);
      it.qty = editQty;
      commit();
    }
    closeSheets();
  });
  $("editDelete").addEventListener("click", () => {
    const id = editingId;
    closeSheets();
    removeItems([id]);
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
    state.doneOpen = !state.doneOpen;
    commit();
  });

  suggestions.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) addItem(chip.dataset.name);
  });

  // Swipe left to delete
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
        if (Math.abs(my) > Math.abs(mx) || mx > 0) { active = false; return; } // vertical scroll or right swipe
        li.classList.add("dragging");
        body.setPointerCapture?.(e.pointerId);
      }
      dx = Math.min(0, mx);
      body.style.transform = `translateX(${dx}px)`;
    });

    function end() {
      if (!active) return;
      active = false;
      if (!decided) return;
      li.classList.remove("dragging");
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 50);
      const threshold = Math.min(120, body.offsetWidth * 0.35);
      if (-dx > threshold) {
        body.style.transform = `translateX(-110%)`;
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

  // ---------- Init ----------
  greeting();
  render();
})();
