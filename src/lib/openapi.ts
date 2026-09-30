// OpenAPI 3.1 description of the agent-facing HTTP API (served at /openapi.json).
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errResp = (description: string) => ({ description, content: json(ref("Error")) });
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
const auth = [{ bearer: [] }, { tokenQuery: [] }];

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Squint",
    version: "0.1.0",
    summary: "A camera for headless agents.",
    description:
      "Mint a link that asks your human's phone for one real-world thing (photo, location, choice, short text). Photos are validated on the spot by a vision model and thrown away; you receive typed JSON, never the image. No signup or API key (beta, rate-limited per IP). Agent auth is the `sq_...` token returned once by POST /v1/asks.",
  },
  servers: [{ url: "https://squint.elsisi.workers.dev" }],
  paths: {
    "/v1/asks": {
      post: {
        operationId: "createAsk",
        summary: "Create an ask and get the link to hand to your human",
        requestBody: { required: true, content: json(ref("CreateAsk")) },
        responses: {
          "201": { description: "Created. Keep `token`: it is shown once.", content: json(ref("CreatedAsk")) },
          "400": errResp("Validation error, or invalid_callback_url"),
          "422": errResp("sensitive_request: asks for credentials/IDs/cards are refused"),
          "429": errResp("Rate limit (30 successful creates/hour/IP)"),
        },
      },
    },
    "/v1/asks/{id}": {
      get: {
        operationId: "getAsk",
        summary: "Get an ask; long-polls until it reaches a final status or `wait` seconds pass",
        security: auth,
        parameters: [idParam, { name: "wait", in: "query", schema: { type: "integer", minimum: 0, maximum: 25, default: 0 }, description: "Long-poll seconds" }, { name: "token", in: "query", schema: { type: "string" }, description: "Alternative to the Authorization header" }],
        responses: { "200": { description: "The ask", content: json(ref("Ask")) }, "404": errResp("Unknown id or bad token") },
      },
      delete: {
        operationId: "cancelAsk",
        summary: "Cancel an ask (status becomes expired)",
        security: auth,
        parameters: [idParam],
        responses: { "200": { description: "Cancelled", content: json(ref("Ask")) }, "404": errResp("Unknown id or bad token") },
      },
    },
    "/q/{id}.svg": {
      get: {
        operationId: "getQr",
        summary: "QR code (SVG) of the human link; public",
        parameters: [idParam],
        responses: { "200": { description: "SVG image", content: { "image/svg+xml": { schema: { type: "string" } } } } },
      },
    },
    "/mcp": {
      post: {
        operationId: "mcp",
        summary: "Remote MCP server (streamable HTTP JSON-RPC). Tools: squint_ask, squint_wait, squint_cancel",
        requestBody: { required: true, content: json({ type: "object" }) },
        responses: { "200": { description: "JSON-RPC response", content: json({ type: "object" }) }, "202": { description: "Notification accepted" } },
      },
    },
    "/healthz": { get: { operationId: "health", summary: "Liveness", responses: { "200": { description: "ok", content: json({ type: "object", properties: { ok: { type: "boolean" } } }) } } } },
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "The sq_... token returned by POST /v1/asks" },
      tokenQuery: { type: "apiKey", in: "query", name: "token" },
    },
    schemas: {
      Error: { type: "object", required: ["error", "message"], properties: { error: { type: "string" }, message: { type: "string" } } },
      CreateAsk: {
        type: "object",
        required: ["kind", "ask"],
        properties: {
          kind: { type: "string", enum: ["photo", "location", "choice", "text"] },
          ask: { type: "string", description: "Plain-language instruction shown to the human, e.g. 'a clear photo of the water meter'" },
          extract: { type: "object", additionalProperties: { type: "string" }, description: "photo: {field: 'type: description'}, type is string|number|boolean|date (int/integer/float = number, bool = boolean, datetime = date as YYYY-MM-DD); no type prefix = string. Fields are required by default (unreadable -> photo rejected); mark optional with '?', e.g. 'string?: serial if printed'" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8, description: "choice: 2-8 short labels" },
          hint: { type: "string", description: "text: placeholder" },
          ttl_seconds: { type: "integer", minimum: 60, maximum: 3600, default: 900 },
          max_attempts: { type: "integer", minimum: 1, maximum: 8, default: 5 },
          callback_url: { type: "string", format: "uri", description: "Optional https webhook (public hosts only) POSTed when the ask finishes" },
        },
      },
      Ask: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pending", "opened", "done", "expired", "failed"] },
          kind: { type: "string", enum: ["photo", "location", "choice", "text"] },
          ask: { type: "string" },
          url: { type: "string", format: "uri", description: "Give this to the human" },
          qr_url: { type: "string", format: "uri" },
          wait_url: { type: "string", format: "uri" },
          attempts: { type: "integer" },
          max_attempts: { type: "integer" },
          attempt_log: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, ok: { type: "boolean" }, issue: { type: ["string", "null"] } } } },
          result: { oneOf: [{ type: "null" }, ref("PhotoResult"), ref("LocationResult"), ref("ChoiceResult"), ref("TextResult")], description: "Set when status is done" },
          expires_at: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
          opened_at: { type: ["string", "null"], format: "date-time" },
          done_at: { type: ["string", "null"], format: "date-time" },
          tokens: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                description: "Photo asks only. An honest estimate of tokens saved versus receiving each photo yourself and asking for retakes.",
                properties: { agent_saw: { type: ["integer", "null"] }, raw_image_loop_would_cost: { type: ["integer", "null"] }, spared: { type: ["integer", "null"] }, note: { type: "string" } },
              },
            ],
          },
        },
      },
      CreatedAsk: { allOf: [ref("Ask"), { type: "object", required: ["token"], properties: { token: { type: "string", description: "sq_... agent token, returned once" } } }] },
      PhotoResult: {
        type: "object",
        properties: {
          fields: { type: "object", description: "The `extract` fields, typed" },
          description: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          quality: { type: "string", enum: ["good", "ok"] },
        },
      },
      LocationResult: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" }, accuracy_m: { type: "number" } } },
      ChoiceResult: { type: "object", properties: { choice: { type: "string" }, index: { type: "integer" } } },
      TextResult: { type: "object", properties: { text: { type: "string", maxLength: 280 } } },
    },
  },
} as const;
