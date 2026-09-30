import type { Env } from "../types";
import { safeWebhook } from "./guard";

/**
 * POST the typed result to the agent's callback_url (https, public host, no redirects, 5s).
 * Carries no secrets; the agent can confirm via GET /v1/asks/:id with its token.
 */
export async function deliverCallback(env: Env, id: string, url: string, payload: unknown): Promise<boolean> {
  const u = safeWebhook(url);
  let ok = false;
  if (u) {
    try {
      const r = await fetch(u.toString(), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "user-agent": "squint-webhook/1" },
        body: JSON.stringify(payload),
      });
      ok = r.status >= 200 && r.status < 300;
    } catch {
      ok = false;
    }
  }
  await env.DB.prepare("UPDATE asks SET callback_state=? WHERE id=?").bind(ok ? "sent" : "failed", id).run();
  return ok;
}
