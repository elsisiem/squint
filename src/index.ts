import { Hono, type Context } from "hono";
import type { Env } from "./types";
import { askExists, cancelAsk, createAsk, expireSweep, getAskView, publicView, submitAttempt } from "./lib/asks";
import { qrSvg } from "./lib/qr";
import { HOUR, ID_RE, ipKey, overLimit } from "./lib/util";
import { handleMcp } from "./lib/mcp";
import { openapi } from "./lib/openapi";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const BODY_CAP = 2 * 1024 * 1024;
const clientIp = (c: C) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
// Fixed 1-hour windows: an hour is a safe upper bound for when a limited caller may retry.
const err = (c: C, status: number, error: string, message: string) =>
  c.json({ error, message }, status as 400, status === 429 ? { "retry-after": "3600" } : undefined);

// Phone page may use inline script/style and Google Fonts; nothing else leaves the origin.
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// CORS + security headers on every response (including ones built from ASSETS).
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  const h = c.res.headers;
  try {
    h.set("access-control-allow-origin", "*");
    h.set("access-control-expose-headers", "mcp-session-id");
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "no-referrer");
    if (c.req.path.startsWith("/s/")) {
      h.set("content-security-policy", PAGE_CSP);
      h.set("x-frame-options", "DENY");
      h.set("permissions-policy", "geolocation=(self), camera=(self), microphone=()");
    }
  } catch {
    // immutable headers (asset responses): rebuild
    const r = new Response(c.res.body, c.res);
    r.headers.set("access-control-allow-origin", "*");
    r.headers.set("x-content-type-options", "nosniff");
    r.headers.set("referrer-policy", "no-referrer");
    c.res = r;
  }
});

/** Read and parse a JSON body, enforcing the 2 MB cap. */
async function readJson(c: C): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > BODY_CAP) return { ok: false, res: err(c, 413, "too_large", "Body exceeds 2 MB.") };
  const text = await c.req.text();
  if (text.length > BODY_CAP) return { ok: false, res: err(c, 413, "too_large", "Body exceeds 2 MB.") };
  try {
    return { ok: true, body: JSON.parse(text || "{}") };
  } catch {
    return { ok: false, res: err(c, 400, "invalid_json", "Body must be valid JSON.") };
  }
}

const agentToken = (c: C) => (c.req.header("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1] ?? c.req.query("token") ?? "");
const idOk = (id: string) => ID_RE.test(id);

app.get("/healthz", (c) => c.json({ ok: true }));

// ---------- agent API ----------

app.post("/v1/asks", async (c) => {
  const b = await readJson(c);
  if (!b.ok) return b.res;
  const r = await createAsk(c.env, b.body, clientIp(c));
  if (!r.ok) return err(c, r.status, r.error, r.message);
  return c.json({ ...r.ask, token: r.token }, 201);
});

app.get("/v1/asks/:id", async (c) => {
  const id = c.req.param("id");
  const wait = Math.min(25, Math.max(0, parseInt(c.req.query("wait") ?? "0", 10) || 0));
  const v = idOk(id) ? await getAskView(c.env, id, agentToken(c), wait) : null;
  return v ? c.json(v) : err(c, 404, "not_found", "Unknown ask or bad token.");
});

app.delete("/v1/asks/:id", async (c) => {
  const id = c.req.param("id");
  const v = idOk(id) ? await cancelAsk(c.env, id, agentToken(c)) : null;
  return v ? c.json(v) : err(c, 404, "not_found", "Unknown ask or bad token.");
});

// ---------- human API (no auth) ----------

app.get("/v1/public/asks/:id", async (c) => {
  const id = c.req.param("id");
  if (await overLimit(c.env, `pub:${await ipKey(clientIp(c), c.env.TOKEN_SECRET)}`, 300, HOUR)) return err(c, 429, "rate_limited", "Too many requests.");
  const v = idOk(id) ? await publicView(c.env, id) : null;
  return v ? c.json(v, 200, { "cache-control": "no-store" }) : err(c, 404, "not_found", "Unknown ask.");
});

app.post("/v1/public/asks/:id/submit", async (c) => {
  const id = c.req.param("id");
  if (!idOk(id)) return err(c, 404, "not_found", "Unknown ask.");
  const ih = await ipKey(clientIp(c), c.env.TOKEN_SECRET);
  // IP first (bounded writes), then a read-only existence check, so junk ids never create rate_limits rows.
  const tooMany = () => err(c, 429, "rate_limited", "Too many attempts. Please wait a bit and try again.");
  if (await overLimit(c.env, `sub:ip:${ih}`, 200, HOUR)) return tooMany();
  if (!(await askExists(c.env, id))) return err(c, 404, "not_found", "Unknown ask.");
  if (await overLimit(c.env, `sub:ask:${id}`, 60, HOUR)) return tooMany();
  const b = await readJson(c);
  if (!b.ok) return b.res;
  const r = await submitAttempt(c.env, id, b.body, (p) => c.executionCtx.waitUntil(p));
  return c.json(r.body, r.http as 200, { "cache-control": "no-store" });
});

app.get("/q/:file", async (c) => {
  const m = /^([a-z2-9]{16})\.svg$/.exec(c.req.param("file"));
  if (!m || !(await askExists(c.env, m[1]))) return err(c, 404, "not_found", "Unknown ask.");
  return c.body(qrSvg(`${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/s/${m[1]}`), 200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
});

// Serve the static phone page for known ids only.
app.get("/s/:id", async (c) => {
  const id = c.req.param("id");
  if (!idOk(id) || !(await askExists(c.env, id))) {
    return c.html("<!doctype html><meta name=viewport content='width=device-width'><title>Squint</title><body style='font-family:system-ui;text-align:center;padding:4rem 1rem'><h1>Link not found</h1><p>This Squint link is unknown or has been cleaned up. Ask your agent for a new one.</p>", 404);
  }
  const u = new URL(c.req.url);
  u.pathname = "/s.html";
  let r = await c.env.ASSETS.fetch(new Request(u.toString(), { headers: c.req.raw.headers }));
  // assets may canonicalise /s.html -> /s; follow one redirect inside the asset store
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
    r = await c.env.ASSETS.fetch(new Request(new URL(r.headers.get("location")!, u).toString(), { headers: c.req.raw.headers }));
  }
  return new Response(r.body, { status: r.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});

// ---------- agent docs + MCP ----------

const asset = (path: string, type: string) => async (c: C) => {
  const u = new URL(c.req.url);
  u.pathname = path;
  const r = await c.env.ASSETS.fetch(new Request(u.toString()));
  return new Response(r.body, { status: r.status, headers: { "content-type": type, "cache-control": "public, max-age=300" } });
};
app.get("/llms.txt", asset("/llms.txt", "text/plain; charset=utf-8"));
app.get("/agents.md", asset("/llms.txt", "text/markdown; charset=utf-8"));
app.get("/openapi.json", (c) => c.json(openapi, 200, { "cache-control": "public, max-age=300" }));

// Rate limiting lives inside handleMcp (per tools/call, answered as JSON-RPC, not a bare REST 429).
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, clientIp(c)));

// Everything else: static assets (landing page, svgs).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((e, c) => {
  console.log("unhandled", e.name);
  return err(c, 500, "internal", "Something went wrong.");
});

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(expireSweep(env));
  },
} satisfies ExportedHandler<Env>;
