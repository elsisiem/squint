// A real Brainbase-hosted agent discovers Squint from llms.txt alone, creates a photo ask over plain HTTP,
// prints the human link, then waits for the typed result. Open the link on your phone to complete it.
// Usage: BASE=https://squint.elsisi.workers.dev npm run brainbase -- "a clear photo of your keyboard"
// (BRAINBASE_API_KEY comes from the environment or .dev.vars.)
import { assistantMessages, BASE, startThread, threadStatus } from "./lib";

const THING = process.argv.slice(2).join(" ").trim() || "a clear photo of something on your desk";

const t = await startThread(
  `You are a helpful agent with no camera and no upload UI. Read ${BASE}/llms.txt and follow it. Use curl over HTTP only. ` +
    `Create ONE Squint ask of kind "photo" for the thing your human must show you, with an "extract" field describing what you need to know about it. ` +
    `Immediately print the ask's human "url" on its own line, clearly labelled, so a person can open it on their phone. ` +
    `Then long-poll GET /v1/asks/{id}?wait=25 with the Bearer token until status is done, expired or failed (repeat the call, up to about 10 minutes). ` +
    `Finish by reporting each status change and the final result JSON. Never ask for credentials or IDs.`,
  `I need a photo of ${THING} from my human. Protocol: ${BASE}/llms.txt`,
);
console.log("Brainbase thread:", t.thread_id);

let status = t.status;
let shown = 0;
const print = async () => {
  const all = await assistantMessages(t.thread_id);
  for (const m of all.slice(shown)) console.log(`\n--- agent ---\n${m}`);
  shown = all.length;
};
for (let i = 0; i < 90 && status === "running"; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  status = await threadStatus(t.thread_id);
  await print(); // the human link shows up here as soon as the agent prints it
}
await print();
console.log(`\nstatus: ${status}`);
