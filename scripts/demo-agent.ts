// A terminal "agent" that uses Squint: create an ask, show the link + QR, long-poll, print the typed result.
// Usage: npm run demo -- [--kind photo|location|choice|text] [--ask "..."] [--extract '{"k":"string: ..."}'] [--options a,b] [--base URL]
//        npm run demo -- --selftest     (plays BOTH sides: a bad photo first, then a good one, no phone needed)
import qrcode from "qrcode-generator";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const selftest = argv.includes("--selftest");
const BASE = (flag("base") || process.env.BASE || "https://squint.elsisi.workers.dev").replace(/\/$/, "");
const kind = flag("kind") || "photo";
const ask = flag("ask") || "a clear photo of any object";
const extract = flag("extract") ? JSON.parse(flag("extract")!) : kind === "photo" ? { object: "string: what the main object is" } : undefined;
const options = flag("options")?.split(",").map((s) => s.trim());

// Small generated JPEGs for --selftest: a flat grey square (should be rejected) and a red mug on a table (should pass).
const GREY_JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA0JCgsKCA0LCwsPDg0QFCEVFBISFCgdHhghMCoyMS8qLi00O0tANDhHOS0uQllCR05QVFVUMz9dY1xSYktTVFH/2wBDAQ4PDxQRFCcVFSdRNi42UVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVH/wAARCABgAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==";
const SCENE_JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAoHBwkHBgoJCAkLCwoMDxkQDw4ODx4WFxIZJCAmJSMgIyIoLTkwKCo2KyIjMkQyNjs9QEBAJjBGS0U+Sjk/QD3/2wBDAQsLCw8NDx0QEB09KSMpPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT3/wAARCADwAUADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1CiiisTQKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiii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jMytKCc715z9aokYODXb1HJBFN/rIkf/AHlBrVVe5m6fY4yiuqfR7KTrCAf9kkVA3h+1bo0q/Qj/AAq/axJ9mzAW4mT7srj6MakXULlekp/EA1rN4cjP3Z3H1UGmHw4e1yD9U/8Ar0c8GUpVY7N/eZ41S5HVwfqopf7VufVf++auHw5JnidMf7po/wCEdl/57p+RovTL9viP5n95T/tW59V/75pDqlyf4lH/AAGrv/COy/8APdPyNH/COy55nT8jRemHt8R/M/vKB1G6brKfwAFRNczP96Vz/wACNaw8OHvcgfRP/r09fDiD71wx+i4o54IlyrS3b+8wutFdEvh61H3nlP4j/Cp00ayT/lluP+0xo9rEj2bOWq1baddXLDy4mA/vNwK6iO1gh/1cMan1CjNS1Lq9hqn3I4I2igRHcuyqAWPepKKKxNQooooAKKKKACiiigAooooAKKKKAJrz/j9n/wCujfzqGprz/j9n/wCujfzqGhggooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//Z";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(BASE + path, init);
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok && !body.status) throw new Error(`${r.status} ${body.error || ""} ${body.message || ""}`.trim());
  return body;
}

/** The human's side, simulated: open the page, send a garbage photo, then a good one. */
async function simulateHuman(id: string) {
  await sleep(1500);
  const pub = await api(`/v1/public/asks/${id}`);
  log(`[human] opened the link (status ${pub.status})`);
  const send = (image: string, w: number, h: number) =>
    api(`/v1/public/asks/${id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image, media_type: "image/jpeg", width: w, height: h }),
    });
  let r = await send(GREY_JPEG, 96, 96);
  log(`[human] sent a flat grey photo -> ${r.status}: ${r.feedback ?? ""}`);
  r = await send(SCENE_JPEG, 320, 240);
  log(`[human] retook it -> ${r.status}${r.feedback ? ": " + r.feedback : ""}`);
}

const created = await api("/v1/asks", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: selftest ? "photo" : kind, ask: selftest ? "a clear photo of any object" : ask, extract: selftest ? { object: "string: what the main object is" } : extract, options }),
});
if (!created.id) throw new Error(`create failed: ${created.error} ${created.message}`);
log(`[agent] created ask ${created.id} (${created.kind}): "${created.ask}"`);
log(`[agent] give this link to your human: ${created.url}\n`);
const qr = qrcode(0, "L");
qr.addData(created.url);
qr.make();
log(qr.createASCII(2, 2));

if (selftest) simulateHuman(created.id).catch((e) => log(`[human] error: ${e.message}`));

// Long-poll; the server returns as soon as the ask reaches a final status or after ~20s, so print any change in between.
let seen = "";
let view: any = created;
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  view = await api(`/v1/asks/${created.id}?wait=${selftest ? 3 : 20}`, { headers: { authorization: `Bearer ${created.token}` } });
  const sig = `${view.status}/${view.attempts}`;
  if (sig !== seen) {
    seen = sig;
    const last = view.attempt_log?.at(-1);
    log(`[agent] status=${view.status} attempts=${view.attempts}/${view.max_attempts}${last && !last.ok ? ` last issue: ${last.issue}` : ""}`);
  }
  if (["done", "expired", "failed"].includes(view.status)) break;
}

log("\n[agent] final result:");
log(JSON.stringify(view.result, null, 2));
const t = view.tokens;
if (t && t.spared != null) {
  log(`\ntokens: agent saw ${t.agent_saw}; receiving the photos yourself and asking for retakes would have cost about ${t.raw_image_loop_would_cost}; spared ${t.spared}. (${t.note})`);
}
if (view.status !== "done") { log(`[agent] ended with status ${view.status}`); process.exit(1); }
