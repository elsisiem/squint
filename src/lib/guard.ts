/** Requests for credentials / identity documents are refused at creation time. */
const SENSITIVE = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`passports?`, String.raw`driv(?:er|ing)'?s?\s+licen[cs]es?`, String.raw`id\s+cards?`, String.raw`identity\s+cards?`, String.raw`national\s+id`, String.raw`social\s+security`, String.raw`ssn`,
      String.raw`(?:credit|debit|bank)\s+cards?`, String.raw`card\s+(?:numbers?|details)`, String.raw`cvv`, String.raw`cvc`, String.raw`security\s+codes?`, String.raw`security\s+answers?`,
      String.raw`pass\s?(?:words?|codes?|phrases?)`, String.raw`one\s+time\s+(?:codes?|password|passcode)s?`, String.raw`otp`,
      String.raw`(?:[23]fa|mfa|verification|sms|backup|recovery|authenticator|auth|authentication|confirmation)\s+codes?`,
      String.raw`codes?\s+(?:we|i)\s+(?:just\s+)?(?:sent|texted|emailed)`, String.raw`codes?\s+(?:sent|texted)\s+to\s+you`, String.raw`\d{4,8}\s*digit\s+(?:codes?|pin)`,
      String.raw`seed\s+phrase`, String.raw`recovery\s+phrase`, String.raw`private\s+keys?`, String.raw`secret\s+keys?`, String.raw`api\s+keys?`, String.raw`access\s+tokens?`, String.raw`bank\s+login`,
      String.raw`login\s+credentials?`, String.raw`credentials`, String.raw`iban`, String.raw`routing\s+numbers?`, String.raw`account\s+numbers?`,
      String.raw`mot\s+de\s+passe`, String.raw`contrase[ñn]a`, String.raw`passwort`, String.raw`kennwort`,
      // a bare "PIN", but not "drop a pin" / "map pin" / "pin on the map"
      String.raw`(?<!\bdrop(?:ped)?\s+(?:a|the|your)\s+)(?<!map\s+)pin(?!\s+(?:on|it|to|this|that|down|at|in|a|of|the)\b)`,
    ].join("|") +
    String.raw`)\b`,
  "i",
);
/** Long, unambiguous tokens also matched with every non-letter removed, to catch "p a s s w o r d" / "creditcard". */
const COMPACT = /passport|password|passcode|passphrase|creditcard|debitcard|seedphrase|privatekey|securitycode|verificationcode|socialsecurity|routingnumber|accountnumber|drivinglicen[cs]e|driverslicen[cs]e|driverlicen[cs]e/;

const CYRILLIC: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ѕ: "s", ј: "j", к: "k", м: "m", н: "h", т: "t", в: "b" };
const LEET: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "@": "a", $: "s" };

/** Returns the matched phrase, or null when all texts are fine. */
export function sensitiveMatch(texts: (string | undefined | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const norm = t
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .toLowerCase()
      .replace(/[’`´]/g, "'")
      .replace(/[а-яіѕј]/g, (c) => CYRILLIC[c] ?? c)
      .replace(/[_\-.]+/g, " ");
    const leet = norm.replace(/[01345@$]/g, (c) => LEET[c]);
    for (const v of [norm, leet]) {
      const m = SENSITIVE.exec(v);
      if (m) return m[0].toLowerCase();
    }
    const c = COMPACT.exec(leet.replace(/[^a-z]/g, ""));
    if (c) return c[0];
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
