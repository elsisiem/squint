import type { Env } from "../types";

export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const iso = (ms: number) => new Date(ms).toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** IPv6 callers rotate freely inside their /64, so bucket by its first four hextets. IPv4 (and IPv4-mapped IPv6) is kept whole. */
export function ipBucket(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!a.includes(":")) return a;
  const mapped = /^(?:0{0,4}:){2,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a; // not a valid address: keep it whole
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Privacy-preserving per-IP key: we never store raw IPs. */
export const ipKey = (ip: string, secret: string) => sha256(ipBucket(ip) + secret);

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 chars, no lookalikes
export function randomId(n = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => ID_ALPHABET[x & 31]).join("");
}
export const ID_RE = /^[a-z2-9]{16}$/;

export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return "sq_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Fixed-window counter in D1 (rate_limits: k, n, reset_at), one atomic upsert.
 * Returns true when the caller is OVER the limit.
 */
export async function overLimit(env: Env, key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (k,n,reset_at) VALUES (?1,1,?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN reset_at <= ?3 THEN 1 ELSE n + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING n`,
  ).bind(key, t + windowMs, t).first<{ n: number }>();
  return (r?.n ?? 0) > max;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
