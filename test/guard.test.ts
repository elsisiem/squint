import { describe, expect, it } from "vitest";
import { safeWebhook, sensitiveMatch } from "../src/lib/guard";

describe("sensitiveMatch", () => {
  it.each([
    "a photo of your passport",
    "Driver's license please",
    "drivers licence front",
    "your credit card number",
    "enter the CVV",
    "what is your password",
    "send the one-time code",
    "the 2FA code on your phone",
    "OTP from SMS",
    "your seed phrase",
    "private_key file",
    "ssn",
    "bank login screen",
    "ID card photo",
  ])("blocks %s", (t) => expect(sensitiveMatch([t])).not.toBeNull());

  it.each(["a clear photo of the water meter", "pizza or tacos", "a pinned note", "photo of a chopstick", "your favourite hotel"])(
    "allows %s",
    (t) => expect(sensitiveMatch([t])).toBeNull(),
  );

  it("checks every text and ignores empties", () => {
    expect(sensitiveMatch([undefined, "", "fine", "my passcode"])).toBe("passcode");
  });
});

describe("safeWebhook (callback_url host validation)", () => {
  it("accepts public https hosts", () => {
    expect(safeWebhook("https://example.com/hook?x=1")?.hostname).toBe("example.com");
    expect(safeWebhook("https://hooks.slack.com/services/a/b")).not.toBeNull();
  });
  it.each([
    "http://example.com/hook",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://[::1]/x",
    "https://192.168.1.1",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://user:pw@example.com/x",
    "https://intranet/x",
    "https://2130706433/x",
    "ftp://example.com",
    "not a url",
  ])("rejects %s", (u) => expect(safeWebhook(u)).toBeNull());
});
