import { describe, expect, it, vi } from "vitest";
import { agentSawTokens, imageTokens, parseCreateInput, tokenAccounting } from "../src/lib/asks";
import { coerceFields, interpretVerdict, judgePhoto, parseExtract } from "../src/lib/vision";
import { qrSvg } from "../src/lib/qr";

const ok = (x: unknown) => {
  const p = parseCreateInput(x);
  if (!p.ok) throw new Error(p.message);
  return p.value;
};
const fail = (x: unknown) => {
  const p = parseCreateInput(x);
  if (p.ok) throw new Error("expected failure");
  return p;
};

describe("ask validation", () => {
  it("applies defaults", () => {
    const v = ok({ kind: "photo", ask: "a clear photo of the water meter", extract: { reading: "number: the digits" } });
    expect(v.ttl_seconds).toBe(900);
    expect(v.max_attempts).toBe(5);
  });
  it("rejects bad input with 400", () => {
    for (const bad of [
      null,
      { kind: "video", ask: "hello there" },
      { kind: "photo", ask: "x" },
      { kind: "photo", ask: "a photo", ttl_seconds: 5 },
      { kind: "photo", ask: "a photo", ttl_seconds: 99999 },
      { kind: "photo", ask: "a photo", max_attempts: 9 },
      { kind: "choice", ask: "pizza or tacos" },
      { kind: "choice", ask: "pizza or tacos", options: ["only one"] },
      { kind: "photo", ask: "a photo", extract: { "bad name!": "string: x" } },
      { kind: "photo", ask: "a photo", callback_url: "http://localhost/x" },
    ]) expect(fail(bad).status).toBe(400);
  });
  it("blocks sensitive asks with 422", () => {
    expect(fail({ kind: "photo", ask: "a photo of your passport" })).toMatchObject({ status: 422, error: "sensitive_request" });
    expect(fail({ kind: "text", ask: "type something", hint: "your password" }).status).toBe(422);
    expect(fail({ kind: "choice", ask: "which one", options: ["cvv", "other"] }).status).toBe(422);
    expect(fail({ kind: "photo", ask: "a photo of the card", extract: { code: "string: the card number" } }).status).toBe(422);
  });
  it("drops irrelevant fields per kind", () => {
    const v = ok({ kind: "text", ask: "your name?", options: ["a", "b"], extract: { a: "string" } });
    expect(v.options).toBeUndefined();
    expect(v.extract).toBeUndefined();
  });
});

describe("extract parsing and typing", () => {
  it("parses type prefixes", () => {
    expect(parseExtract({ reading: "number: the digits", who: "just a label", ok: "boolean" })).toEqual([
      { name: "reading", type: "number", desc: "the digits" },
      { name: "who", type: "string", desc: "just a label" },
      { name: "ok", type: "boolean", desc: "ok" },
    ]);
  });
  it("accepts type aliases and optional markers", () => {
    expect(parseExtract({ count: "integer: how many", ok: "bool", when: "datetime: printed date", serial: "string?: serial if printed", note: "optional number: x" })).toEqual([
      { name: "count", type: "number", desc: "how many" },
      { name: "ok", type: "boolean", desc: "ok" },
      { name: "when", type: "date", desc: "printed date" },
      { name: "serial", type: "string", desc: "serial if printed", optional: true },
      { name: "note", type: "number", desc: "x", optional: true },
    ]);
    expect(parseExtract({ a: "number of items" })[0]).toEqual({ name: "a", type: "string", desc: "number of items" });
  });
  it("coerces to declared types and flags unreadable fields", () => {
    const f = parseExtract({ n: "number: x", d: "date: y", b: "boolean: z", s: "string: w", m: "number: v" });
    const { fields, missing } = coerceFields(f, { n: "1,234.5", d: "2026-01-02T10:00", b: false, s: "  hi ", m: "abc" });
    expect(fields).toEqual({ n: 1234.5, d: "2026-01-02", b: false, s: "hi", m: null });
    expect(missing).toEqual(["m"]);
  });
  it("rejects verdicts that are ok but flagged or unreadable", () => {
    const f = parseExtract({ reading: "number: digits" });
    const good = { ok: true, issue: null, fields: { reading: 4821 }, description: "meter", confidence: 0.9, blur: false, dark: false, wrong_subject: false };
    expect(interpretVerdict(f, good)).toMatchObject({ ok: true, quality: "good", fields: { reading: 4821 } });
    expect(interpretVerdict(f, { ...good, blur: true })).toMatchObject({ ok: false });
    const unread = interpretVerdict(f, { ...good, fields: { reading: null } });
    expect(unread).toMatchObject({ ok: false });
    expect((unread as any).issue).toMatch(/reading/);
    expect(interpretVerdict(f, { ...good, confidence: 0.1 })).toMatchObject({ ok: false });
  });
  it("optional fields may be null; required booleans default to false on a confident ok", () => {
    const good = { ok: true, issue: null, fields: {}, description: "x", confidence: 0.95, blur: false, dark: false, wrong_subject: false };
    const f = parseExtract({ serial: "string?: serial", paid: "boolean: stamped PAID", total: "number: total" });
    expect(interpretVerdict(f, { ...good, fields: { serial: null, paid: null, total: 23.45 } })).toMatchObject({ ok: true, fields: { serial: null, paid: false, total: 23.45 } });
    expect(interpretVerdict(f, { ...good, confidence: 0.5, fields: { serial: null, paid: null, total: 1 } })).toMatchObject({ ok: false });
    expect(interpretVerdict(f, { ...good, fields: { paid: true, total: null } })).toMatchObject({ ok: false });
  });
  it("names a missing date field helpfully", () => {
    const j = interpretVerdict(parseExtract({ d: "date: use by" }), { ok: true, issue: null, fields: { d: "14 MAR" }, description: "x", confidence: 0.9, blur: false, dark: false, wrong_subject: false });
    expect((j as any).issue).toMatch(/day, month and year/);
  });
  it("always gives actionable feedback on rejection", () => {
    const j = interpretVerdict([], { ok: false, issue: null, fields: {}, description: "", confidence: 0.2, blur: true, dark: false, wrong_subject: false });
    expect((j as any).issue).toMatch(/blurry/i);
  });
});

describe("token accounting", () => {
  it("agent_saw is ceil(len/4) of the result JSON", () => {
    const r = { fields: { object: "mug" }, description: "a mug", confidence: 0.9, quality: "good" };
    expect(agentSawTokens(r)).toBe(Math.ceil(JSON.stringify(r).length / 4));
  });
  it("caps image tokens at 1600", () => {
    expect(imageTokens(1280, 960)).toBe(1600);
    expect(imageTokens(300, 150)).toBe(60);
  });
  it("sums attempts, adds 120 per retake, never negative", () => {
    const r = { text: "x" };
    const t = tokenAccounting([1600, 1600, 1000], r)!;
    const loop = 4200 + 240;
    expect(t.agent_saw).toBe(agentSawTokens(r));
    expect(t.raw_image_loop_would_cost).toBe(loop + t.agent_saw!);
    expect(t.spared).toBe(loop);
    expect(t.note).toMatch(/^estimate:/);
  });
  it("null without attempts; partial while pending", () => {
    expect(tokenAccounting([], null)).toBeNull();
    expect(tokenAccounting([1600], null)).toMatchObject({ agent_saw: null, spared: null, raw_image_loop_would_cost: 1600 });
  });
});

describe("qr", () => {
  it("renders a standalone svg", () => {
    const s = qrSvg("https://squint.elsisi.workers.dev/s/abcdefghjkmnpqrs");
    expect(s.startsWith("<svg")).toBe(true);
    expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(s).toContain("<path");
    expect(s.endsWith("</svg>")).toBe(true);
  });
});

describe("vision prompt", () => {
  it("lets explicitly requested selfies through the safety rule", async () => {
    let sent: any;
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      sent = JSON.parse(String((init as RequestInit).body));
      return Response.json({ content: [{ type: "tool_use", input: { ok: true, issue: null, fields: {}, description: "a selfie", confidence: 0.9, blur: false, dark: false, wrong_subject: false } }] });
    });
    const j = await judgePhoto({ ANTHROPIC_API_KEY: "k", VISION_MODEL: "m" } as any, { ask: "a selfie so the team can see who is at the door", extract: [], image: "AAAA", mediaType: "image/jpeg" });
    f.mockRestore();
    expect(j).toMatchObject({ state: "ok", ok: true });
    expect(sent.system).toMatch(/request itself is about a person/);
    expect(sent.system).toMatch(/never use the safety rejection for faces/);
    expect(sent.messages[0].content[1].text).toContain("a selfie");
  });
});
