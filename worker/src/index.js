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
        properties: { name: { type: "STRING" }, qty: { type: "INTEGER" } },
        required: ["name", "qty"],
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
    if (request.method !== "POST") return reply(405, { error: "bad_request" });
    if (!env.GEMINI_API_KEY) return reply(500, { error: "failed" });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: "bad_request" }); }
    const { image, mime } = body || {};
    if (typeof image !== "string" || !MIMES.has(mime)) return reply(400, { error: "bad_request" });
    if (image.length > MAX_BASE64) return reply(413, { error: "too_big" });

    // Try each model in turn: the free tier limits each model separately, and is often
    // briefly overloaded ("high demand", 503). If every model is busy, wait and go round again.
    const models = (env.GEMINI_MODELS || "gemini-flash-latest,gemini-flash-lite-latest").split(",").map((s) => s.trim()).filter(Boolean);
    let quota = false, busy = false;
    for (let round = 0; round < 3; round++) {
      if (round) await new Promise((r) => setTimeout(r, 1500 * round));
      busy = false;
      for (const model of models) {
        const out = await ask(model);
        if (out.items) return reply(200, { items: out.items });
        if (out.quota) quota = true;
        if (out.busy) busy = true;
      }
      if (!busy) break; // nothing temporary: don't retry
    }
    return reply(busy ? 503 : quota ? 429 : 502, { error: busy ? "busy" : quota ? "quota" : "failed" });

    async function ask(model) {
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
            generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
          }),
        });
      } catch (e) {
        console.log("gemini fetch failed", model, String(e));
        return { busy: true };
      }
      if (res.status === 429) return { quota: true };
      if (!res.ok) {
        console.log("gemini error", model, res.status, (await res.text()).slice(0, 200));
        return { busy: res.status >= 500 };
      }
      try {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        const items = (JSON.parse(text).items || [])
          .filter((it) => it && typeof it.name === "string" && it.name.trim())
          .slice(0, 200)
          .map((it) => ({ name: it.name.trim().slice(0, 60), qty: Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 999) }));
        return { items };
      } catch (e) {
        console.log("gemini parse failed", model, String(e));
        return { busy: true }; // an unreadable answer is usually a hiccup: worth another round
      }
    }
  },
};
