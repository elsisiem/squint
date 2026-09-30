import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/lib/mcp";

// Minimal D1 stub: every rate-limit upsert returns the next count for its key.
function env() {
  const n: Record<string, number> = {};
  return {
    TOKEN_SECRET: "s",
    DB: { prepare: () => ({ bind: (k: string) => ({ first: async () => ({ n: (n[k] = (n[k] ?? 0) + 1) }) }) }) },
  } as any;
}
const post = (body: unknown) => new Request("https://x/mcp", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("mcp rate limiting", () => {
  it("meters only tools/call and answers over-limit as a JSON-RPC result", async () => {
    const e = env();
    for (let i = 0; i < 130; i++) {
      const r = await handleMcp(post({ jsonrpc: "2.0", id: i, method: "ping" }), e, "1.2.3.4");
      expect(r.status).toBe(200);
    }
    let last: any;
    for (let i = 0; i < 121; i++) last = await (await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "squint_cancel", arguments: {} } }), e, "1.2.3.4")).json();
    expect(last).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: true } });
    expect(last.result.content[0].text).toMatch(/rate_limited/);
  });
  it("caps batch size and body size", async () => {
    const e = env();
    const batch = Array.from({ length: 11 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
    expect((await handleMcp(post(batch), e, "ip")).status).toBe(400);
    expect((await handleMcp(post("x".repeat(2_100_000)), e, "ip")).status).toBe(413);
  });
});
