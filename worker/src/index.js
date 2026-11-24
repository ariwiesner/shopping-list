// Reads a photo of a shopping list (often handwritten, usually Hebrew) and returns the items.
//
// Runs on Cloudflare Workers (free plan) and asks Google Gemini (free tier) to read the
// photo. The Gemini key lives only here, as the secret GEMINI_API_KEY, never in the app.
//
// POST /  { image: "<base64 JPEG/PNG/WEBP>", mime: "image/jpeg" }
//   200 -> { items: [{ name, qty }] }
//   4xx/5xx -> { error: "too_big" | "bad_request" | "quota" | "busy" | "failed" | "forbidden" }
//
// Only the app's own sites may call it (checked by Origin), and photos are limited in size,
// so the free quota isn't easy to drain from elsewhere.

const MAX_BASE64 = 5_000_000; // ~3.7 MB image; the app sends ~0.3 MB after shrinking
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

const PROMPT = `This photo should show a shopping list: handwritten or printed, usually in Hebrew, sometimes English.
Handwritten Hebrew is often in cursive script (כתב רהוט), whose letters look very different from print
(e.g. cursive א looks like a small "k", ע like "y", ש like "e", ם like "p", ו and י are short strokes).
Read each line slowly, letter by letter: first write the letters you actually see in "raw" (in Hebrew print letters),
then give the item in "name". The name must match those letters: a real Hebrew grocery word with the same letters
(like "ופלים", "שעועית", "בייגלה", "ירקות"), never a different, more common product that merely looks similar.
List every item to buy, in the order written.
- Write each item in the language it is written in (usually Hebrew), fixing obvious spelling, as a short general product name, e.g. "חלב", "גבינה צהובה", "עגבניות". Keep a brand or detail only if it is written (e.g. "קוטג' 5%").
- qty: the number written next to the item (e.g. "2", "x3", "שני"); otherwise 1. A weight like "2 ק"ג" counts as 2.
- Leave out any item with a line drawn through it (crossed out / struck through): it was already bought.
- Leave out titles ("לקנות", "רשימת קניות"), dates, prices, people's names and notes to someone, and doodles.
- If you can't read an item at all, leave it out. If the photo is not a shopping list, return no items.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { raw: { type: "STRING" }, name: { type: "STRING" }, qty: { type: "INTEGER" } },
        required: ["raw", "name", "qty"],
        propertyOrdering: ["raw", "name", "qty"],
      },
    },
  },
  required: ["items"],
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
      : {};
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });
    if (!allowed.includes(origin)) return reply(403, { error: "forbidden" });
    // Testing from the developer's computer only: list the models this key can use.
    const testing = origin === "http://localhost:3000";
    if (testing && request.method === "GET") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
      const d = await r.json();
      return reply(r.status, { models: (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace("models/", "")) });
    }
    if (request.method !== "POST") return reply(405, { error: "bad_request" });
    if (!env.GEMINI_API_KEY) return reply(500, { error: "failed" });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: "bad_request" }); }
    const { image, mime } = body || {};
    if (typeof image !== "string" || !MIMES.has(mime)) return reply(400, { error: "bad_request" });
    if (image.length > MAX_BASE64) return reply(413, { error: "too_big" });

    // Two models at once, since the free tier is often briefly overloaded ("high demand", 503):
    //   GEMINI_BEST   the most accurate free model (reads Hebrew cursive well), "model:thinking"
    //   GEMINI_MODELS fast fallbacks, tried in turn
    // The accurate answer wins if it comes in time; if the fast one is back first, wait up to
    // 12 s more for it, then use the fast one. If everything is busy, wait and go round once more.
    const spec = (s) => { const [model, think = ""] = s.trim().split(":"); return { model, think }; };
    const best = spec(env.GEMINI_BEST || "gemini-3.6-flash:low");
    const fallbacks = (env.GEMINI_MODELS || "gemini-3.5-flash-lite").split(",").map(spec).filter((m) => m.model);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let quota = false, busy = false, lastError = "";
    const ok = (out) => (testing ? { items: out.items, model: out.model } : { items: out.items });

    // Testing: one model (or a list) as asked, to compare them.
    if (testing && Array.isArray(body.models) && body.models.length) {
      for (const model of body.models) {
        const out = await ask({ model: String(model), think: body.thinking ? String(body.thinking) : "" });
        if (out.items) return reply(200, ok(out));
      }
      return reply(busy ? 503 : quota ? 429 : 502, { error: busy ? "busy" : quota ? "quota" : "failed", detail: lastError });
    }

    for (let round = 0; round < 2; round++) {
      if (round) await sleep(2000);
      busy = false;
      const primary = ask(best, 40000).then((o) => (o.items ? o : null));
      const backup = (async () => {
        for (const m of fallbacks) { const o = await ask(m, 25000); if (o.items) return o; }
        return null;
      })();
      const first = await Promise.race([primary.then((r) => ({ isBest: true, r })), backup.then((r) => ({ isBest: false, r }))]);
      const result = first.isBest ? first.r || (await backup)
        : first.r ? (await Promise.race([primary, sleep(12000).then(() => null)])) || first.r
        : await primary;
      if (result) return reply(200, ok(result));
      if (!busy) break; // nothing temporary: don't retry
    }
    return reply(busy ? 503 : quota ? 429 : 502, { error: busy ? "busy" : quota ? "quota" : "failed", ...(testing ? { detail: lastError } : {}) });

    // One request to one model, given up after `ms`.
    async function ask({ model, think }, ms = 40000) {
      let res;
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), ms);
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          signal: stop.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
            generationConfig: {
              responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0,
              ...(think ? { thinkingConfig: { thinkingLevel: think } } : {}),
            },
          }),
        });
      } catch (e) {
        clearTimeout(timer);
        console.log("gemini fetch failed or timed out", model, String(e));
        busy = true;
        return {};
      }
      clearTimeout(timer);
      if (res.status === 429) { quota = true; return {}; }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        console.log("gemini error", model, res.status, text);
        lastError = `${model} ${res.status} ${text}`;
        if (res.status >= 500) busy = true;
        return {};
      }
      try {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        const items = (JSON.parse(text).items || [])
          .filter((it) => it && typeof it.name === "string" && it.name.trim())
          .slice(0, 200)
          .map((it) => ({ name: it.name.trim().slice(0, 60), qty: Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 999),
            ...(testing && typeof it.raw === "string" ? { raw: it.raw.slice(0, 60) } : {}) }));
        return { items, model };
      } catch (e) {
        console.log("gemini parse failed", model, String(e));
        busy = true; // an unreadable answer is usually a hiccup: worth another round
        return {};
      }
    }
  },
};
