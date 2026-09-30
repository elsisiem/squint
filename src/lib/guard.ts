/** Requests for credentials / identity documents are refused at creation time. */
const SENSITIVE =
  /\b(passport|driver'?s?\s+licen[cs]e|id\s+card|identity\s+card|national\s+id|social\s+security|ssn|(credit|debit|bank)\s+card|card\s+number|cvv|cvc|security\s+code|password|passcode|pin\s+code|one\s+time\s+(code|password|passcode)|otp|[23]fa\s+code|mfa\s+code|verification\s+code|seed\s+phrase|recovery\s+phrase|private\s+key|bank\s+login)\b/i;

/** Returns the matched phrase, or null when all texts are fine. */
export function sensitiveMatch(texts: (string | undefined | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = SENSITIVE.exec(t.replace(/[_\-.]+/g, " "));
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Webhook target: HTTPS only, public hostname only (SSRF guard). Returns the URL or null. */
export function safeWebhook(u: string): URL | null {
  try {
    const x = new URL(u.trim());
    const h = x.hostname.toLowerCase().replace(/\.$/, "");
    if (x.protocol !== "https:" || x.username || x.password) return null;
    if (!h.includes(".") || h.startsWith("[") || /^[\d.]+$/.test(h)) return null; // no IP literals
    if (h === "localhost" || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h)) return null;
    return x;
  } catch {
    return null;
  }
}
