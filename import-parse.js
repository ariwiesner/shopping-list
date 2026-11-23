// Turn a shopping list pasted from outside the app (WhatsApp, notes, email) into items.
//
// Usually one item per line, but people also write "חלב, לחם וביצים" on one line,
// number or bullet their lines, add quantities in many ways ("2 חלב", "חלב x2",
// "חלב - 2", "שני חלב", "2 ק״ג עגבניות"), paste whole WhatsApp messages with
// "[12:30, 23/11/2026] אמא: " in front, cross things out (~חלב~), and add chatter
// ("תודה!", "זהו"). parseList() copes with all of that.
//
// parseList(text) -> [{ name, qty, done }]   (same name twice is merged)

const MAX_ITEMS = 200;
const MAX_NAME = 60;

// Invisible direction marks and similar that WhatsApp and phones insert.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

// "[23/11/2026, 12:30:15] אמא: " (iPhone export) / "23.11.2026, 12:30 - אמא: " (Android export)
const WA_PREFIX = /^\[?\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?\]?\s*(?:-\s*)?(?:[^:]{1,40}:\s)?/;

// Lines that are chat, not items.
const CHATTER = new Set([
  "תודה", "תודה רבה", "בבקשה", "אוקיי", "אוקי", "סבבה", "טוב", "זהו", "זה הכל", "זה הכול", "כן", "לא",
  "רשימת קניות", "רשימה", "קניות", "לקנות", "צריך לקנות", "צריך", "לסופר", "מהסופר", "בסופר", "ותודה",
  "thanks", "thank you", "ok", "okay", "shopping list", "list", "groceries", "to buy",
  "<media omitted>", "<המדיה הושמטה>", "המדיה הושמטה", "הודעה זו נמחקה", "this message was deleted",
  "you deleted this message", "מחקת את ההודעה הזו", "null",
]);

// Hebrew number words, as quantities ("שני חלב", "שלוש בננות").
const NUMBER_WORDS = {
  "אחד": 1, "אחת": 1, "שני": 2, "שתי": 2, "שניים": 2, "שתיים": 2, "שלוש": 3, "שלושה": 3,
  "ארבע": 4, "ארבעה": 4, "חמש": 5, "חמישה": 5, "שש": 6, "שישה": 6, "שבע": 7, "שבעה": 7,
  "שמונה": 8, "תשע": 9, "תשעה": 9, "עשר": 10, "עשרה": 10, "חצי": 1,
  "אחת עשרה": 11, "שתים עשרה": 12, "עשרים": 20,
};

// ---------- Long, chatty lines ----------
// "בשר- קילו מספר חמש או שמונה מה שהוא אומר שיותר מתאים" -> "בשר מספר 5", 1 (kg).
// After the product name come details (an amount, "מספר 5", "3%", "500 גרם") and then,
// often, remarks ("אם יש מבצע", "או שמונה", "מה שהוא אומר"). Keep the product and the
// useful details; drop the remarks. The preview shows the original line, so the user
// can see what was left out.

// Words that open a remark: everything from here on is advice, not the product.
const REMARK_WORDS = new Set(["אם", "ואם", "כי", "מה", "אבל", "בשביל", "למקרה", "לפי", "שיהיה", "שיש", "שזה", "שהוא",
  "שהיא", "שהם", "שיותר", "שפחות", "אולי", "אפשר", "עדיף", "רצוי", "בערך", "כמו", "כדי", "רק", "לא", "אלא", "תשאל",
  "תשאלי", "תבדוק", "תבדקי", "תגיד", "תגידי", "מה שיש", "if", "because", "maybe", "or", "whatever", "like"]);
const NUM_WORD_RE = new RegExp(`^(?:${Object.keys(NUMBER_WORDS).filter((w) => !w.includes(" ")).join("|")})$`);
const isNum = (w) => /^\d+(?:[.,]\d+)?$/.test(w) || NUM_WORD_RE.test(w);
const numOf = (w) => (/^\d/.test(w) ? parseFloat(w.replace(",", ".")) : NUMBER_WORDS[w]);
const KILO = /^(?:קילו|קילוגרם|ק"ג|ק״ג|קג|kg)$/i;
const SIZE = /^(?:גרם|גר'?|גר׳|מ"ל|מ״ל|מל|ליטר|ליטרים|g|gr|ml|l)$/i;
const NUMBER_LABEL = /^(?:מספר|מס'|מס׳|מס|no\.?|#)$/i;

// A word that starts the details part after the product name.
const startsDetails = (w, next) =>
  KILO.test(w) || NUMBER_LABEL.test(w) || w === "חצי" || w === "רבע" || /^\d+(?:[.,]\d+)?%$/.test(w) ||
  (isNum(w) && next !== undefined && (KILO.test(next) || SIZE.test(next) || COUNT_UNITS.test(next) || next === "%"));

// -> { name, qty } or null when the line has no details/remarks to simplify.
function simplify(text) {
  const words = text.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  // Where the product name ends: a separator ("בשר- קילו"), a details word, or a remark.
  let end = words.length;
  for (let i = 1; i < words.length; i++) {
    if (REMARK_WORDS.has(words[i]) || startsDetails(words[i], words[i + 1])) { end = i; break; }
  }
  let head = words.slice(0, end).join(" ");
  let tail = words.slice(end);
  const dash = head.match(/^(.{2,40}?)\s*[-–—]\s*(.+)$/) || head.match(/^(.{2,40}?)[-–—]$/);
  if (dash) { head = dash[1]; tail = [...(dash[2] ? dash[2].split(" ") : []), ...tail]; }
  head = head.replace(/[-–—:,]+$/, "").trim();
  if (!tail.length || !head) return null;

  // Read details until a remark starts ("או שמונה" = an alternative: also a remark).
  let qty = null;
  const keep = [];
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i].replace(/[,.;:!?]+$/, ""), next = tail[i + 1]?.replace(/[,.;:!?]+$/, "");
    if (REMARK_WORDS.has(w) || (w === "או" && i > 0)) break;
    if (KILO.test(w)) { if (qty === null) qty = 1; continue; }                                // "קילו" = 1 kg
    if (w === "חצי" && next && KILO.test(next)) { keep.push("חצי קילו"); i++; qty = 1; continue; }
    if (isNum(w) && next && KILO.test(next)) { qty = Math.ceil(numOf(w)); i++; continue; }    // "2 קילו"
    if (isNum(w) && next && COUNT_UNITS.test(next)) { qty = Math.ceil(numOf(w)); i++; continue; } // "3 חבילות"
    if (isNum(w) && next && SIZE.test(next)) { keep.push(`${/^\d/.test(w) ? w : numOf(w)} ${next}`); i++; continue; }
    if (NUMBER_LABEL.test(w) && next && isNum(next)) { keep.push(`מספר ${numOf(next)}`); i++; continue; } // "מספר חמש"
    if (/^\d+(?:[.,]\d+)?%$/.test(w)) { keep.push(w); continue; }
    if (isNum(w) && next === "%") { keep.push(`${numOf(w)}%`); i++; continue; }
    if (i === 0 && !isNum(w) && w.length > 1 && tail.length <= 2) { keep.push(w); continue; }   // "בשר - טחון"
    if (keep.length || qty !== null) continue; // stray words between details
  }
  return { name: [head, ...keep].join(" "), qty };
}

// Counting units: "2 חבילות פסטה" is pasta ×2. Weights by the kilo count too
// ("2 ק״ג עגבניות" = tomatoes ×2, priced per kg). Grams and litres stay in the
// name ("גבינה 200 גרם"), since they describe the product, not how many.
const COUNT_UNITS = /^(?:ק"ג|קג|ק״ג|קילו|קילוגרם|kg|יח'?|יח׳|יחידות|יחידה|חבילות|חבילה|חבילת|חב'|שקיות|שקית|בקבוקים|בקבוקי|בקבוק|קרטונים|קרטוני|קרטון|קופסאות|קופסאת|קופסת|קופסא|קופסה|פחיות|פחית|מארזים|מארזי|מארז|צנצנות|צנצנת|pcs?|packs?|bottles?|cans?)\.?$/i;
const SIZE_UNITS = /^(?:גרם|גר'?|גר׳|ג'|מ"ל|מל|מ״ל|ליטר|ל'|g|gr|ml|l|liters?|litres?)$/i;

// Words starting with ו that aren't "and ..." (so "חלב וופלים" isn't split).
const VAV_WORDS = /^(?:וניל|ויטמין|ויטמינים|וופל|וופלים|ופלים|וודקה|ויסקי|וואקום|ואקום|ויאגרה|וזלין|וג'י|ורד|ורדים)/;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function cleanLine(raw) {
  let s = raw.replace(INVISIBLE, "").replace(/\t/g, " ").trim();
  s = s.replace(WA_PREFIX, "");
  return s.trim();
}

// Strip bullets, numbering, checkboxes and leading emoji: "1.", "2)", "א.", "-", "•", "☐", "[x]", "✅", "🥛"
function stripMarkers(s) {
  let done = false;
  for (let i = 0; i < 4; i++) {
    const before = s;
    if (/^(?:\[[xX✓✔]\]|☑|✅|✔️?|✓)/.test(s)) done = true;
    s = s
      .replace(/^(?:\[[ xX✓✔]?\]|[☐☑✅✔✓⬜⬛◻◼▫▪•·●○◦‣⁃∙\-–—+>=]+)\s*/, "")
      .replace(/^[*~]+\s+/, "")
      .replace(/^(?:\d{1,3}|[א-י])\s*[.)\]:-]\s+/, "")   // "1. " "2) " "א. " (not "2 חלב")
      .replace(/^(?:\d{1,3})[.)]\s*(?=\D)/, "")            // "1.חלב"
      .replace(/^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}]+\s*/u, "")
      .trim();
    if (s === before) break;
  }
  return { s, done };
}

// WhatsApp formatting: *bold*, _italic_, ~strike~ (strike = already bought).
function stripFormatting(s) {
  let done = false;
  if (/^~[^~]+~$/.test(s)) { done = true; s = s.slice(1, -1); }
  s = s.replace(/~([^~]+)~/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");
  return { s: s.trim(), done };
}

// Split a line that holds several items: "חלב, לחם וביצים" / "חלב; לחם" / "עגבניות + מלפפונים".
function splitItems(line) {
  const raw = line.split(/\s*(?:[,،;؛|]|\s\+\s)\s*/).filter(Boolean);
  const parts = [];
  for (const p of raw) {
    const [w, next] = p.split(" ");
    const detailOnly = parts.length && (NUMBER_LABEL.test(w) || KILO.test(w) || w === "חצי" || /^\d+(?:[.,]\d+)?%$/.test(w) ||
      (isNum(w) && next && (KILO.test(next) || SIZE.test(next) || next === "%")) || REMARK_WORDS.has(w) || w === "או");
    if (detailOnly) parts[parts.length - 1] += " " + p; else parts.push(p);
  }
  const out = [];
  for (const p of parts) {
    // "לחם וביצים": split on " ו" before a word (but keep "וניל", "וופלים", ...).
    const words = p.split(" ");
    if (words.length > 4) { out.push(p); continue; } // a sentence, not "חלב ולחם"
    let cur = [];
    for (const w of words) {
      if (cur.length && /^ו[\p{L}"'״׳]{2,}$/u.test(w) && !VAV_WORDS.test(w) && !/^\d/.test(cur[cur.length - 1] || "")) {
        out.push(cur.join(" "));
        cur = [w.slice(1)];
      } else cur.push(w);
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out;
}

// Quantity in its many forms. Returns { name, qty }.
function parseQty(s) {
  let qty = null;
  let m;
  s = s.replace(/\s+/g, " ").trim();
  // A size up front ("500 גרם גבינה צהובה") describes the product: "גבינה צהובה 500 גרם".
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(\S+)\s+(.+)$/)) && SIZE_UNITS.test(m[2])) s = `${m[3]} ${m[1]} ${m[2]}`;
  // "מספר 8" is a cut/size number, not a quantity: leave it to simplify() below.
  const labeled = /(?:^|\s)(?:מספר|מס'|מס׳|מס|no\.?|#)\s*\S+/i.test(s);
  // "חלב (2)" "חלב (x2)"
  if (labeled) { /* skip the number-at-the-end forms */ }
  else if ((m = s.match(/^(.+?)\s*\(\s*[x×]?\s*(\d{1,3})\s*[x×]?\s*\)$/i))) { s = m[1]; qty = +m[2]; }
  // "חלב x2" "חלב ×2" "חלב X 2" "חלב - 2" "חלב: 2" "חלב 2"
  else if ((m = s.match(/^(.+?)\s*(?:[x×*]\s*|[-–:]\s*)(\d{1,3})$/i)) || (m = s.match(/^(.+?)\s+(\d{1,3})$/))) {
    // ...but not "גבינה 200" when it's a size ("קוטג' 5%" has no digits at the end anyway)
    if (+m[2] <= 99) { s = m[1]; qty = +m[2]; }
  }
  // "2x חלב" "2 x חלב" "x2 חלב" "2 חלב"
  else if ((m = s.match(/^(?:[x×]\s*)?(\d{1,3})\s*[x×]?\s+(.+)$/i))) { qty = +m[1]; s = m[2]; }
  // "חלב x" (no number) is left alone.

  // A counting unit right after the number: "2 חבילות פסטה", "1.5 ק״ג עגבניות" (decimal kilos round up)
  if (qty === null && (m = s.match(/^(\d{1,3}(?:[.,]\d+)?)\s+(\S+)\s+(.+)$/)) && COUNT_UNITS.test(m[2])) {
    qty = Math.ceil(parseFloat(m[1].replace(",", "."))); s = m[3];
  } else if (qty !== null && (m = s.match(/^(\S+)\s+(.+)$/)) && COUNT_UNITS.test(m[1])) {
    s = m[2];
  } else if (qty !== null && (m = s.match(/^(.+?)\s+(\S+)$/)) && COUNT_UNITS.test(m[2])) {
    s = m[1]; // "חלב 2 קרטונים" -> after taking 2 off, "חלב קרטונים"? handled above; this covers "עגבניות ק״ג"
  }
  // A counting unit after the name: "עגבניות 2 ק״ג", "חלב 2 קרטונים"
  if (qty === null && !labeled && (m = s.match(/^(.+?)\s+(\d{1,3}(?:[.,]\d+)?)\s*(\S+)$/)) && COUNT_UNITS.test(m[3])) {
    qty = Math.ceil(parseFloat(m[2].replace(",", "."))); s = m[1];
  }
  // Number words: "שני חלב", "שלוש בננות"
  if (qty === null && (m = s.match(/^(\S+)\s+(.+)$/)) && NUMBER_WORDS[m[1]]) { qty = NUMBER_WORDS[m[1]]; s = m[2]; }

  // Long, chatty lines: keep the product and its details, drop the remarks.
  const simple = simplify(s);
  if (simple) { s = simple.name; if (qty === null && simple.qty !== null) qty = simple.qty; }

  // A size that got separated ("500 גרם גבינה") reads better as "גבינה 500 גרם".
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(\S+)\s+(.+)$/)) && SIZE_UNITS.test(m[2])) s = `${m[3]} ${m[1]} ${m[2]}`;

  return { name: s.trim(), qty: Math.min(Math.max(qty || 1, 1), 999) };
}

const CHAT_WORDS = new Set(["תודה", "ותודה", "רבה", "זהו", "זה", "הכל", "הכול", "בבקשה", "סבבה", "אוקיי", "אוקי",
  "טוב", "כן", "לא", "שוב", "מאמי", "חמוד", "חמודה", "thanks", "thank", "you", "ok", "okay", "please", "that's", "all"]);
// Requests around the item: "אל תשכח לחם", "תקנה גם חלב", "יש לנו חלב?"
const REQUEST_PREFIX = /^(?:(?:אל\s+ת(?:שכח|שכחי|שכחו)|לא\s+לשכוח|ת(?:קנה|קני|קנו|ביא|ביאי|ביאו)|לקנות|צריך|צריכה|צריכים|חסר|חסרים|יש\s+לנו|אין\s+לנו|עוד|גם|קצת|please\s+buy|buy|get|need)\s+)+/i;

const isChatter = (s) => {
  const k = s.toLowerCase().replace(/[!.?,:;)(…'"\s]+/g, " ").trim();
  return !k || CHATTER.has(k) || /^(?:https?:\/\/|www\.)/i.test(s) || !/[\p{L}]/u.test(s) ||
    k.split(" ").every((w) => CHAT_WORDS.has(w) || !/[\p{L}]/u.test(w));
};

// Collects items: cleans each name, skips chatter, merges repeats.
function collector() {
  const items = [];
  const byKey = new Map();
  const add = (name, qty, done, source = "") => {
    name = name.replace(/^[\s\-–—:.,]+|[\s\-–—:.,!?]+$/g, "").replace(REQUEST_PREFIX, "").trim();
    if (!name || isChatter(name)) return;
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim();
    name = capitalize(name);
    const key = name.toLowerCase();
    const prev = byKey.get(key);
    if (prev) { prev.qty = Math.min(prev.qty + qty, 999); prev.done = prev.done && done; return; }
    if (items.length >= MAX_ITEMS) return;
    const it = { name, qty, done };
    if (source && source.replace(/\s+/g, " ").trim() !== name) it.source = source.replace(/\s+/g, " ").trim().slice(0, 140);
    byKey.set(key, it);
    items.push(it);
  };
  return { items, add };
}

// Items read from a photo ([{ name, qty }]), cleaned the same way as pasted text.
export function cleanItems(list) {
  const { items, add } = collector();
  for (const it of list || []) if (it && typeof it.name === "string") add(it.name, Math.min(Math.max(+it.qty || 1, 1), 999), false);
  return items;
}

export function parseList(text) {
  const { items, add } = collector();

  for (const raw of String(text || "").split(/\r?\n|\u2028|\u2029/)) {
    let line = cleanLine(raw);
    if (!line) continue;
    let done = false;
    let r = stripMarkers(line); line = r.s; done ||= r.done;
    r = stripFormatting(line); line = r.s; done ||= r.done;
    r = stripMarkers(line); line = r.s; done ||= r.done;
    if (!line || /^(?:https?:\/\/|www\.)/i.test(line)) continue;
    // "ירקות: עגבניות, מלפפון" -> the items after a short label; "רשימת קניות:" alone -> skip
    const colon = line.match(/^([^:]{1,25}):\s*(.*)$/);
    const detailAfterColon = colon && colon[2] && startsDetails(colon[2].split(" ")[0], colon[2].split(" ")[1]);
    if (detailAfterColon) line = `${colon[1]} ${colon[2]}`;
    else if (colon && !/\d$/.test(colon[1])) {
      if (!colon[2]) continue;
      if (!/^\d{1,3}$/.test(colon[2].trim())) line = colon[2];
    }
    if (isChatter(line)) continue;
    for (const part of splitItems(line)) {
      const p = stripMarkers(part);
      const { name, qty } = parseQty(p.s);
      add(name, qty, done || p.done, part);
    }
  }
  return items;
}
