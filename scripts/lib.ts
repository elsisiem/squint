import { existsSync, readFileSync } from "node:fs";

export const BASE = (process.env.BASE || "https://squint.elsisi.workers.dev").replace(/\/$/, "");

/** Read a value from the environment, falling back to .dev.vars. Never logged. */
export function secret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const f = new URL("../.dev.vars", import.meta.url);
  return existsSync(f) ? readFileSync(f, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() : undefined;
}

const API = "https://api.brainbaselabs.com/v2";
const key = secret("BRAINBASE_API_KEY");
if (!key) throw new Error("BRAINBASE_API_KEY missing (env or .dev.vars)");
const H = { Authorization: `Bearer ${key}`, "content-type": "application/json" };

/** Start a Brainbase-hosted agent thread and return its id and initial status. */
export async function startThread(instructions: string, input: string): Promise<{ thread_id: string; status: string }> {
  const r = await fetch(`${API}/threads`, { method: "POST", headers: H, body: JSON.stringify({ agent: { harness: "claude_code", instructions }, input }) });
  if (!r.ok) throw new Error(`Brainbase create thread: HTTP ${r.status}`);
  return (await r.json()) as any;
}

export async function threadStatus(id: string): Promise<string> {
  return ((await (await fetch(`${API}/threads/${id}`, { headers: H })).json()) as any).status;
}

/** Everything worth showing so far: assistant text, the shell commands it runs, and any human link a tool returned. */
export async function assistantMessages(id: string): Promise<string[]> {
  const msgs: any = await (await fetch(`${API}/threads/${id}/messages`, { headers: H })).json();
  const out: string[] = [];
  const linked = new Set<string>();
  for (const m of msgs.items || []) {
    if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content.trim()) out.push(m.content);
      for (const c of m.tool_calls || []) {
        try {
          const cmd: string = JSON.parse(c.function.arguments).command ?? "";
          out.push("$ " + cmd.slice(0, 300));
          // tool results are not exposed by the API, but the agent's poll command contains the ask id
          const ask = cmd.match(/\/v1\/asks\/([A-Za-z0-9]+)\?wait/)?.[1];
          if (ask && !linked.has(ask)) { linked.add(ask); out.push(`OPEN THIS ON YOUR PHONE: ${BASE}/s/${ask}`); }
        } catch {}
      }
    }
  }
  return out;
}
