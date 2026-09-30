# Squint

**A camera for headless agents.** An agent mints a link that asks its human's phone for one real-world thing: a photo, a location, a choice, a short text. Claude vision checks the photo on the spot (blurry, too dark, wrong thing: the human retakes it right there), and the agent receives **typed JSON, never the image**.

Live: https://squint.elsisi.workers.dev

## Why an agent would call it
Agents with no upload UI (voice agents, background jobs, swarms, anything that talks to a person through SMS or a phone call) can't just "take a picture". Today that means building an upload page and storage, then burning agent turns on "that's blurry, please retake" while every attempt costs ~1.5k image tokens.

With Squint the agent makes one call, hands the URL to the human over whatever channel it already has, and waits:

```bash
# 1. ask
curl -s https://squint.elsisi.workers.dev/v1/asks -H 'content-type: application/json' -d '{
  "kind": "photo",
  "ask": "a clear photo of the water meter",
  "extract": { "reading": "number: the digits on the meter" }
}'
# -> { "id": "...", "url": "https://.../s/...", "token": "sq_..." }

# 2. wait (long-poll, up to 25s per call)
curl -s "https://squint.elsisi.workers.dev/v1/asks/<id>?wait=25" -H "authorization: Bearer <token>"
# -> { "status": "done", "result": { "fields": { "reading": 4821 }, "confidence": 0.96, ... } }
```

Kinds: `photo` (validated by Claude vision, optional typed `extract` schema), `location` (`{lat,lng,accuracy_m}`), `choice` (`{choice,index}`), `text` (`{text}`).

MCP (Claude Code, Cursor, anything that speaks remote MCP):

```bash
claude mcp add --transport http squint https://squint.elsisi.workers.dev/mcp
```

Tools: `squint_ask`, `squint_wait`, `squint_cancel`. Agent-readable docs: [`/llms.txt`](public/llms.txt), [`/openapi.json`](src/lib/openapi.ts).

## Safety
- Photos are checked and thrown away. Nothing but the typed result is stored, and rows are deleted after 24h.
- Asks for passwords, card numbers, IDs, one-time codes and similar are rejected (422), and the phone page warns the human. The vision judge also refuses photos of documents.
- Text inside a photo is treated as data, never as instructions.
- Links are unguessable, expire (default 15 min) and cap retries. Per-IP rate limits. Webhooks: HTTPS, public hosts only, no redirects.

## Stack
Cloudflare Workers + Hono + D1 (state only) + Cron. Anthropic Claude (`claude-haiku-4-5`) for vision. No storage bucket, no SDKs. Brainbase is used for the hosted-agent demo (`npm run brainbase`).

## Dev
```bash
npm install
cp .dev.vars.example .dev.vars   # ANTHROPIC_API_KEY, TOKEN_SECRET, ADMIN_SECRET
npm run db:local && npm run dev
npm run check                    # typecheck + tests
npm run demo -- --selftest --base http://localhost:8787   # plays agent and human, end to end
```
Design notes and the API contract are in [SPEC.md](SPEC.md).

## Not done yet
Signed webhooks, API keys with usage-based billing (Stripe), more kinds (scan a barcode, short video, signature), per-ask custom branding of the phone page.
