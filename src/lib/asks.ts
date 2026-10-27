import { z } from "zod";
import type { Env } from "../types";
import { HOUR, clamp, ipKey, iso, now, overLimit, randomId, randomToken, sha256, sleep } from "./util";
import { safeWebhook, sensitiveMatch } from "./guard";
import { judgePhoto, parseExtract } from "./vision";
import { deliverCallback } from "./deliver";

export type AskKind = "photo" | "location" | "choice" | "text" | "sequence";
export type StepKind = Exclude<AskKind, "sequence">;
export interface StepInput { kind: StepKind; ask: string; extract?: Record<string, string>; options?: string[]; hint?: string }
export interface CreateAskInput { kind: AskKind; ask: string; extract?: Record<string, string>; options?: string[]; hint?: string; steps?: StepInput[]; ttl_seconds?: number; max_attempts?: number; callback_url?: string }
export interface AskView {
  id: string; status: "pending" | "opened" | "done" | "expired" | "failed"; kind: AskKind; ask: string;
  url: string; qr_url: string; wait_url: string; attempts: number; max_attempts: number;
  steps?: { done: number; total: number };
  attempt_log: { n: number; ok: boolean; issue: string | null }[]; result: any | null;
  expires_at: string; created_at: string; opened_at: string | null; done_at: string | null;
  tokens: { agent_saw: number | null; raw_image_loop_would_cost: number | null; spared: number | null; note: string } | null;
}

interface Row {
  id: string; token_hash: string; kind: AskKind; ask: string; spec: string; status: AskView["status"];
  attempts: number; max_attempts: number; attempt_log: string; result: string | null; callback_url: string | null;
  image_tokens_spared: number; created_at: number; opened_at: number | null; done_at: number | null; expires_at: number;
}
interface LogEntry { n: number; ok: boolean; issue: string | null; at: number; img?: number; step?: number; res?: unknown }
interface Spec { extract?: Record<string, string>; options?: string[]; hint?: string; steps?: StepInput[] }

const TERMINAL = new Set(["done", "expired", "failed"]);
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
// Global spend backstops (per-IP limits alone are bypassable with many IPs / IPv6 ranges).
const GLOBAL_CREATES_PER_HOUR = 500;
const GLOBAL_VISION_PER_DAY = 1500;

// ---------- validation ----------

const extractSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, "field names must be identifiers"), z.string().trim().min(1).max(240))
  .refine((o) => Object.keys(o).length <= 8, "at most 8 extract fields");
const stepSchema = z.object({
  kind: z.enum(["photo", "location", "choice", "text"]),
  ask: z.string().trim().min(3).max(300),
  extract: extractSchema.optional(),
  options: z.array(z.string().trim().min(1).max(60)).min(2).max(8).optional(),
  hint: z.string().trim().max(120).optional(),
});
const createSchema = z.object({
  kind: z.enum(["photo", "location", "choice", "text", "sequence"]),
  ask: z.string().trim().min(3).max(300),
  extract: extractSchema.optional(),
  options: z.array(z.string().trim().min(1).max(60)).min(2).max(8).optional(),
  hint: z.string().trim().max(120).optional(),
  steps: z.array(stepSchema).min(2).max(6).optional(),
  ttl_seconds: z.number().int().min(60).max(3600).default(900),
  max_attempts: z.number().int().min(1).max(8).default(5),
  callback_url: z.string().trim().max(500).optional(),
});

type Fail = { ok: false; status: number; error: string; message: string };
type Parsed = CreateAskInput & Required<Pick<CreateAskInput, "ttl_seconds" | "max_attempts">>;
export type ParsedCreate = { ok: true; value: Parsed } | Fail;

/** Pure validation + guard (no I/O): validation -> 400, sensitive request -> 422. */
export function parseCreateInput(input: unknown): ParsedCreate {
  const p = createSchema.safeParse(input);
  if (!p.success) {
    const i = p.error.issues[0];
    return { ok: false, status: 400, error: "invalid_request", message: `${i.path.join(".") || "body"}: ${i.message}` };
  }
  const v: Parsed = p.data;
  if (v.kind === "choice" && !v.options) return { ok: false, status: 400, error: "invalid_request", message: "options: required (2-8 strings) for kind 'choice'" };
  if (v.kind === "sequence") {
    if (!v.steps) return { ok: false, status: 400, error: "invalid_request", message: "steps: required (2-6 steps) for kind 'sequence'" };
    for (const [i, st] of v.steps.entries()) {
      if (st.kind === "choice" && !st.options) return { ok: false, status: 400, error: "invalid_request", message: `steps.${i}.options: required (2-8 strings) for kind 'choice'` };
      if (st.kind !== "photo") delete st.extract;
      if (st.kind !== "choice") delete st.options;
    }
    delete v.extract;
    delete v.options;
  } else {
    delete v.steps;
  }
  if (v.kind !== "photo") delete v.extract;
  if (v.kind !== "choice") delete v.options;
  const stepTexts = (v.steps ?? []).flatMap((st) => [st.ask, st.hint, ...(st.options ?? []), ...Object.entries(st.extract ?? {}).flat()]);
  const hit = sensitiveMatch([v.ask, v.hint, ...(v.options ?? []), ...Object.entries(v.extract ?? {}).flat(), ...stepTexts]);
  if (hit) {
    return { ok: false, status: 422, error: "sensitive_request", message: `Squint won't ask people for "${hit}": credentials, card numbers and ID documents are blocked.` };
  }
  if (v.callback_url && !safeWebhook(v.callback_url)) {
    return { ok: false, status: 400, error: "invalid_callback_url", message: "callback_url must be https with a public hostname (no localhost, IPs, .local or .internal)." };
  }
  return { ok: true, value: v };
}

// ---------- token accounting ----------

export const agentSawTokens = (result: unknown) => Math.ceil(JSON.stringify(result ?? null).length / 4);
export const imageTokens = (w: number, h: number) => Math.min(1600, Math.ceil((w * h) / 750));

/** Honest estimate of what an agent would have spent receiving each photo itself and asking for retakes. */
export function tokenAccounting(imgTokens: number[], result: unknown | null): NonNullable<AskView["tokens"]> | null {
  if (!imgTokens.length) return null;
  const loop = imgTokens.reduce((a, b) => a + b, 0) + 120 * (imgTokens.length - 1);
  const saw = result == null ? null : agentSawTokens(result);
  return {
    agent_saw: saw,
    raw_image_loop_would_cost: loop + (saw ?? 0),
    spared: saw == null ? null : Math.max(0, loop),
    note: "estimate: what an agent would have spent receiving each photo itself and asking for retakes",
  };
}

// ---------- sequence bookkeeping ----------

export interface SeqProgress { current: number; total: number; stepAttempts: number; results: unknown[] }

/** Where a sequence stands, derived from the attempt log alone. */
export function seqProgress(log: { ok: boolean; step?: number; res?: unknown }[], total: number): SeqProgress {
  const okEntries = log.filter((e) => e.ok);
  const current = Math.min(okEntries.length, Math.max(0, total - 1));
  const done = okEntries.length;
  return {
    current: Math.min(done, total - 1),
    total,
    stepAttempts: log.filter((e) => !e.ok && (e.step ?? 0) === Math.min(done, total - 1)).length,
    results: okEntries.map((e) => e.res ?? null),
  };
}

// ---------- views ----------

const base = (env: Env) => env.PUBLIC_BASE_URL.replace(/\/$/, "");
const parse = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

function toView(env: Env, r: Row): AskView {
  const log = parse<LogEntry[]>(r.attempt_log, []);
  const result = parse<any>(r.result, null);
  const spec = parse<Spec>(r.spec, {});
  const seq = r.kind === "sequence" ? { done: log.filter((e) => e.ok).length, total: (spec.steps ?? []).length } : undefined;
  return {
    id: r.id, status: r.status, kind: r.kind, ask: r.ask,
    url: `${base(env)}/s/${r.id}`, qr_url: `${base(env)}/q/${r.id}.svg`, wait_url: `${base(env)}/v1/asks/${r.id}?wait=25`,
    attempts: r.attempts, max_attempts: r.max_attempts,
    attempt_log: log.map((e) => ({ n: e.n, ok: e.ok, issue: e.issue })),
    result,
    ...(seq ? { steps: seq } : {}),
    expires_at: iso(r.expires_at), created_at: iso(r.created_at),
    opened_at: r.opened_at ? iso(r.opened_at) : null, done_at: r.done_at ? iso(r.done_at) : null,
    tokens: r.kind === "photo" || r.kind === "sequence" ? tokenAccounting(log.filter((e) => e.img != null).map((e) => e.img!), result) : null,
  };
}

const loadRow = (env: Env, id: string) => env.DB.prepare("SELECT * FROM asks WHERE id=?").bind(id).first<Row>();

/** Lazy expiry so callers never see a stale pending/opened ask. Mutates and returns the row. */
async function withExpiry(env: Env, r: Row): Promise<Row> {
  if ((r.status === "pending" || r.status === "opened") && r.expires_at <= now()) {
    await env.DB.prepare("UPDATE asks SET status='expired' WHERE id=? AND status IN ('pending','opened')").bind(r.id).run();
    r.status = "expired";
  }
  return r;
}

// ---------- agent-facing API ----------

export async function createAsk(env: Env, input: unknown, ip: string): Promise<{ ok: true; ask: AskView; token: string } | Fail> {
  // Validate first (pure, no I/O) so rejected requests do not burn the create budget.
  const p = parseCreateInput(input);
  if (!p.ok) return p;
  const v = p.value;
  const ih = await ipKey(ip, env.TOKEN_SECRET);
  if (await overLimit(env, `create:${ih}`, 30, HOUR)) {
    return { ok: false, status: 429, error: "rate_limited", message: "Too many asks from this address (30/hour in beta). Try again later." };
  }
  if (await overLimit(env, "global:create", GLOBAL_CREATES_PER_HOUR, HOUR)) {
    return { ok: false, status: 429, error: "rate_limited", message: "Squint is at capacity right now (beta). Try again later." };
  }
  const id = randomId(16);
  const token = randomToken();
  const t = now();
  const spec: Spec = { extract: v.extract, options: v.options, hint: v.hint };
  await env.DB.prepare(
    `INSERT INTO asks (id,token_hash,kind,ask,spec,status,attempts,max_attempts,attempt_log,callback_url,ip_hash,created_at,expires_at)
     VALUES (?,?,?,?,?,'pending',0,?,'[]',?,?,?,?)`,
  ).bind(id, await sha256(token), v.kind, v.ask, JSON.stringify(spec), v.max_attempts, v.callback_url ?? null, ih, t, t + v.ttl_seconds * 1000).run();
  const row = (await loadRow(env, id))!;
  return { ok: true, ask: toView(env, row), token };
}

/** null = unknown id or bad token. Long-polls D1 (1s) until terminal or waitSeconds (<=25). */
export async function getAskView(env: Env, id: string, token: string, waitSeconds: number): Promise<AskView | null> {
  const th = await sha256(token || "");
  const deadline = now() + clamp(Math.floor(waitSeconds) || 0, 0, 25) * 1000;
  for (;;) {
    const r = await loadRow(env, id);
    if (!r || r.token_hash !== th) return null;
    await withExpiry(env, r);
    if (TERMINAL.has(r.status) || now() >= deadline) return toView(env, r);
    await sleep(Math.min(1000, deadline - now()));
  }
}

/** Agent cancels: status becomes expired (no-op once terminal). null = unknown id or bad token. */
export async function cancelAsk(env: Env, id: string, token: string): Promise<AskView | null> {
  const r = await loadRow(env, id);
  if (!r || r.token_hash !== (await sha256(token || ""))) return null;
  await env.DB.prepare("UPDATE asks SET status='expired' WHERE id=? AND status IN ('pending','opened')").bind(id).run();
  return toView(env, (await loadRow(env, id))!);
}

export const askExists = async (env: Env, id: string) => !!(await env.DB.prepare("SELECT 1 x FROM asks WHERE id=?").bind(id).first());

// ---------- human-facing API ----------

/** What the phone page may see. Never the result, token or agent-owned data. First call flips pending -> opened. */
export async function publicView(env: Env, id: string) {
  const r0 = await loadRow(env, id);
  if (!r0) return null;
  const r = await withExpiry(env, r0);
  if (r.status === "pending") {
    await env.DB.prepare("UPDATE asks SET status='opened', opened_at=? WHERE id=? AND status='pending'").bind(now(), id).run();
    r.status = "opened";
  }
  const spec = parse<Spec>(r.spec, {});
  const log = parse<LogEntry[]>(r.attempt_log, []);
  if (r.kind === "sequence") {
    const steps = spec.steps ?? [];
    const prog = seqProgress(log, steps.length);
    const step = steps[prog.current];
    const last = [...log].reverse().find((e) => !e.ok && (e.step ?? 0) === prog.current);
    return {
      id: r.id, kind: step?.kind ?? "text", ask: step?.ask ?? r.ask, hint: step?.hint ?? null, options: step?.options ?? null,
      status: r.status, attempts: prog.stepAttempts, max_attempts: r.max_attempts, expires_at: iso(r.expires_at),
      extract_fields: Object.keys(step?.extract ?? {}), last_issue: last?.issue ?? null,
      seq: { index: prog.current, total: steps.length, done: log.filter((e) => e.ok).length, title: r.ask },
    };
  }
  const last = [...log].reverse().find((e) => !e.ok);
  return {
    id: r.id, kind: r.kind, ask: r.ask, hint: spec.hint ?? null, options: spec.options ?? null,
    status: r.status, attempts: r.attempts, max_attempts: r.max_attempts, expires_at: iso(r.expires_at),
    extract_fields: Object.keys(spec.extract ?? {}), last_issue: last?.issue ?? null,
  };
}

export interface SubmitBody { status: "accepted" | "rejected" | "failed" | "expired"; feedback: string | null; attempts: number; max_attempts: number; squint: "happy" | "squint" | "sad"; retryable?: boolean; seq?: { done: number; total: number } }
type Submit = { http: number; body: SubmitBody | { error: string; message: string } };

function imageMime(b64: string): string | null {
  let b: string;
  try { b = atob(b64.slice(0, 24)); } catch { return null; }
  if (b.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (b.startsWith("\x89PNG")) return "image/png";
  if (b.startsWith("RIFF") && b.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

const bad = (message: string, http = 400): Submit => ({ http, body: { error: "invalid_submission", message } });

/** One capture judged: either malformed input (no attempt burned), an infrastructure
 *  hiccup (no attempt burned, retryable), or a verdict with an optional extracted result. */
export type Evaluated =
  | { t: "bad"; message: string; http: number }
  | { t: "unavailable"; message: string }
  | { t: "judged"; result: unknown | null; issue: string | null; img?: number };

/** Validate and judge one capture of the given kind. Pure except for the vision call. */
export async function evaluateCapture(
  env: Env,
  kind: Exclude<AskKind, "sequence">,
  spec: Spec,
  ask: string,
  raw: any,
): Promise<Evaluated> {
  if (kind === "photo") {
    const image = typeof raw.image === "string" ? raw.image.replace(/^data:[^,]*,/, "").replace(/\s/g, "") : "";
    if (!image) return { t: "bad", message: "image (base64 JPEG) is required.", http: 400 };
    if (Math.floor((image.length * 3) / 4) > MAX_IMAGE_BYTES) return { t: "bad", message: "Image too large (max 1.5 MB). Please retake.", http: 413 };
    const mime = imageMime(image);
    if (!mime) return { t: "judged", result: null, issue: "That file doesn't look like a photo. Please take a new one." };
    const w = clamp(Math.round(Number(raw.width)) || 1280, 1, 8000);
    const h = clamp(Math.round(Number(raw.height)) || 960, 1, 8000);
    const img = imageTokens(w, h);
    if (await overLimit(env, `global:vision:${new Date().toISOString().slice(0, 10)}`, GLOBAL_VISION_PER_DAY, 25 * HOUR)) {
      return { t: "unavailable", message: "Squint is at capacity for today. Please try again tomorrow." };
    }
    const j = await judgePhoto(env, { ask, extract: parseExtract(spec.extract), image, mediaType: mime });
    if (j.state === "error") return { t: "unavailable", message: j.message };
    if (j.ok) return { t: "judged", result: { fields: j.fields, description: j.description, confidence: j.confidence, quality: j.quality }, issue: null, img };
    return { t: "judged", result: null, issue: j.issue ?? "Please try another photo.", img };
  }
  if (kind === "location") {
    const lat = Number(raw.lat), lng = Number(raw.lng), acc = Number(raw.accuracy_m ?? 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isFinite(acc) || acc < 0) {
      return { t: "bad", message: "lat, lng and accuracy_m must be valid numbers.", http: 400 };
    }
    return { t: "judged", result: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy_m: Math.round(acc) }, issue: null };
  }
  if (kind === "choice") {
    const i = raw.index, opts = spec.options ?? [];
    if (!Number.isInteger(i) || i < 0 || i >= opts.length) return { t: "bad", message: "index is out of range.", http: 400 };
    return { t: "judged", result: { choice: opts[i], index: i }, issue: null };
  }
  // eslint-disable-next-line no-control-regex
  const text = typeof raw.text === "string" ? raw.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";
  if (!text || text.length > 280) return { t: "bad", message: "text must be 1-280 characters.", http: 400 };
  return { t: "judged", result: { text }, issue: null };
}

/** Validate a human submission and (for photos) run vision. */
export async function submitAttempt(env: Env, id: string, raw: any, waitUntil: (p: Promise<unknown>) => void): Promise<Submit> {
  const r0 = await loadRow(env, id);
  if (!r0) return { http: 404, body: { error: "not_found", message: "Unknown ask." } };
  const r = await withExpiry(env, r0);
  const out = (status: SubmitBody["status"], feedback: string | null, attempts = r.attempts, extra: Partial<SubmitBody> = {}): SubmitBody => ({
    status, feedback, attempts, max_attempts: r.max_attempts,
    squint: status === "accepted" ? "happy" : status === "rejected" ? "squint" : "sad", ...extra,
  });
  if (r.status === "expired") return { http: 200, body: out("expired", "This request expired.") };
  if (r.status === "done") return { http: 200, body: out("accepted", "Already done. You can close this page.") };
  if (r.status === "failed") return { http: 200, body: out("failed", "Too many tries. Ask your agent to send a new link.") };
  if (!raw || typeof raw !== "object") return bad("Body must be a JSON object.");

  const spec = parse<Spec>(r.spec, {});
  const log = parse<LogEntry[]>(r.attempt_log, []);
  const isSeq = r.kind === "sequence";
  const steps = spec.steps ?? [];
  const prog = isSeq ? seqProgress(log, steps.length) : null;
  const step = prog ? steps[prog.current] : null;
  if (isSeq && !step) return { http: 200, body: out("accepted", "Already done. You can close this page.") };

  const ev = await evaluateCapture(
    env,
    (isSeq ? step!.kind : r.kind) as StepKind,
    isSeq ? step! : spec,
    isSeq ? step!.ask : r.ask,
    raw,
  );
  if (ev.t === "bad") return bad(ev.message, ev.http);
  if (ev.t === "unavailable") return { http: 503, body: out("failed", ev.message, prog ? prog.stepAttempts : r.attempts, { retryable: true }) };
  const { result, issue, img } = ev;

  // Optimistic concurrency: only the submit that saw `attempts` == current may write.
  const n = r.attempts + 1;
  const okNow = result != null;
  log.push({ n, ok: okNow, issue, at: now(), ...(img != null ? { img } : {}), ...(isSeq ? { step: prog!.current, ...(okNow ? { res: result } : {}) } : {}) });
  const okCount = isSeq ? log.filter((e) => e.ok).length : 0;
  const done = isSeq ? okNow && okCount >= steps.length : okNow;
  const attemptsShown = isSeq ? (okNow ? 0 : prog!.stepAttempts + 1) : n;
  const exhausted = !okNow && (isSeq ? prog!.stepAttempts + 1 : n) >= r.max_attempts;
  const status = done ? "done" : exhausted ? "failed" : r.status;
  const t = now();
  const finalResult = !done ? null : isSeq
    ? { steps: steps.map((st, i) => ({ kind: st.kind, ask: st.ask, result: log.filter((e) => e.ok)[i]?.res ?? null })) }
    : result;
  const tok = (r.kind === "photo" || isSeq) && done ? tokenAccounting(log.filter((e) => e.img != null).map((e) => e.img!), finalResult) : null;
  const res = await env.DB.prepare(
    `UPDATE asks SET attempts=?, attempt_log=?, status=?, result=?, done_at=?, image_tokens_spared=?
     WHERE id=? AND attempts=? AND status IN ('pending','opened') AND expires_at>?`,
  ).bind(n, JSON.stringify(log), status, done ? JSON.stringify(finalResult) : null, done ? t : null, tok?.spared ?? 0, id, r.attempts, t).run();
  if (!res.meta.changes) {
    const cur = await loadRow(env, id); // lost a race, or expired while vision ran
    const s = cur ? (await withExpiry(env, cur)).status : "expired";
    return { http: 200, body: out(s === "done" ? "accepted" : s === "failed" ? "failed" : "expired", s === "done" ? "Already done. You can close this page." : "This request is no longer open.", cur?.attempts ?? r.attempts) };
  }

  const seqInfo = isSeq ? { seq: { done: okCount, total: steps.length } } : {};
  if (done) {
    if (r.callback_url) {
      const view = toView(env, (await loadRow(env, id))!);
      waitUntil(deliverCallback(env, id, r.callback_url, { id, kind: r.kind, status: "done", result: view.result, tokens: view.tokens, done_at: view.done_at }));
    }
    return { http: 200, body: out("accepted", null, attemptsShown, seqInfo) };
  }
  if (isSeq && okNow) return { http: 200, body: out("accepted", null, 0, seqInfo) };
  if (exhausted) return { http: 200, body: out("failed", `${issue ?? "That didn't work"} No attempts left: ask your agent for a new link.`, attemptsShown) };
  return { http: 200, body: out("rejected", issue, attemptsShown, seqInfo) };
}

// ---------- cron ----------

export async function expireSweep(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE asks SET status='expired' WHERE status IN ('pending','opened') AND expires_at<=?").bind(t),
    env.DB.prepare("DELETE FROM asks WHERE created_at<?").bind(t - 24 * HOUR),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at<?").bind(t),
  ]);
}
