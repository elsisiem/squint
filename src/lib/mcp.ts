import type { Env } from "../types";
import { cancelAsk, createAsk, getAskView } from "./asks";

// Minimal remote MCP server (streamable HTTP, JSON responses). Lets any MCP-capable agent ask its human for a photo/location/choice/text.

const TOOLS = [
  {
    name: "squint_ask",
    description:
      "Ask your human for one real-world thing through their phone: a photo, their location, a choice between options, or a short text answer. " +
      "Use this when you need something physical or personal and you have no upload UI or camera of your own. " +
      "It returns a link (`url`) immediately: give that link to the human through whatever channel you have (chat, email, SMS, terminal; it also has a QR at qr_url). " +
      "When they open it, a vision model checks photos on the spot and makes the human retake bad ones, so you never handle images or retake loops. " +
      "You receive small typed JSON (for photos, the fields you listed in `extract`), never the image. " +
      "Then call squint_wait with the id and token until status is done. " +
      "Never ask for passwords, card numbers, IDs or other credentials: such requests are refused.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["photo", "location", "choice", "text"], description: "photo -> typed fields + description; location -> {lat,lng,accuracy_m}; choice -> {choice,index}; text -> {text} (<=280 chars)" },
        ask: { type: "string", description: "Plain-language instruction shown to the human, e.g. 'a clear photo of the water meter'" },
        extract: { type: "object", additionalProperties: { type: "string" }, description: "photo only. Fields to read from the image as {name: 'type: description'}, type is string|number|boolean|date. E.g. {\"reading\":\"number: the digits on the meter\"}" },
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8, description: "choice only. 2-8 short labels" },
        hint: { type: "string", description: "text only. Placeholder shown in the input" },
        ttl_seconds: { type: "integer", minimum: 60, maximum: 3600, description: "How long the link stays valid. Default 900" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 25, description: "Block up to this long for the human to finish and return the final result. Default 0 = return the link immediately (recommended, so you can hand it to the human first)" },
      },
      required: ["kind", "ask"],
    },
  },
  {
    name: "squint_wait",
    description:
      "Wait for a Squint ask to finish. Long-polls up to wait_seconds (max 25) and returns the ask: status pending|opened|done|expired|failed, attempts with the reasons photos were rejected, and `result` once done. " +
      "If status is still pending/opened, call it again. Stop when status is done, expired or failed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        token: { type: "string", description: "The sq_... token returned by squint_ask" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 25, description: "Default 25" },
      },
      required: ["id", "token"],
    },
  },
  {
    name: "squint_cancel",
    description: "Cancel a Squint ask you no longer need. The link stops working (status becomes expired).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, token: { type: "string" } }, required: ["id", "token"] },
  },
];

const ok = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (o: unknown, isError = false) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }], isError });
const secs = (v: unknown, def: number) => Math.max(0, Math.min(25, Math.floor(Number(v ?? def)) || 0));

const HOW_TO_WAIT = "Give `url` to your human now. Then call squint_wait {id, token} (long-polls up to 25s) until status is done, expired or failed.";

async function callTool(env: Env, name: string, a: any, ip: string) {
  a = a && typeof a === "object" ? a : {};
  if (name === "squint_ask") {
    const { wait_seconds, ...input } = a;
    const r = await createAsk(env, input, ip);
    if (!r.ok) return text({ error: r.error, message: r.message }, true);
    const w = secs(wait_seconds, 0);
    if (w > 0) {
      const v = await getAskView(env, r.ask.id, r.token, w);
      if (v) return text({ ...v, token: r.token, ...(v.status === "done" ? {} : { how_to_wait: HOW_TO_WAIT }) });
    }
    return text({ id: r.ask.id, url: r.ask.url, qr_url: r.ask.qr_url, status: r.ask.status, token: r.token, expires_at: r.ask.expires_at, how_to_wait: HOW_TO_WAIT });
  }
  if (name === "squint_wait") {
    const v = await getAskView(env, String(a.id || ""), String(a.token || ""), secs(a.wait_seconds, 25));
    return v ? text(v) : text({ error: "not_found", message: "Unknown id or wrong token." }, true);
  }
  if (name === "squint_cancel") {
    const id = String(a.id || "");
    const v = await cancelAsk(env, id, String(a.token || ""));
    return v ? text({ id, status: v.status }) : text({ error: "not_found", message: "Unknown id or wrong token." }, true);
  }
  return text({ error: "unknown_tool" }, true);
}

export async function handleMcp(req: Request, env: Env, ip: string): Promise<Response> {
  if (req.method === "GET") return new Response("SSE not supported; POST JSON-RPC to this endpoint.", { status: 405, headers: { allow: "POST" } });
  let msg: any;
  try { msg = await req.json(); } catch { return Response.json(err(null, -32700, "parse error"), { status: 400 }); }
  const one = async (m: any) => {
    const id = m?.id;
    try {
      switch (m?.method) {
        case "initialize":
          return ok(id, {
            protocolVersion: m.params?.protocolVersion || "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "squint", version: "0.1.0" },
            instructions: "Squint is a camera for headless agents: it asks your human's phone for a photo, location, choice or short text, validates photos on the spot, and returns typed JSON (never the image). Use squint_ask, hand the url to the human, then squint_wait.",
          });
        case "ping": return ok(id, {});
        case "tools/list": return ok(id, { tools: TOOLS });
        case "tools/call": return ok(id, await callTool(env, m.params?.name, m.params?.arguments, ip));
        default:
          return id === undefined ? null : err(id, -32601, "method not found");
      }
    } catch (e) {
      return id === undefined ? null : err(id, -32603, "internal error");
    }
  };
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(one))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await one(msg);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
