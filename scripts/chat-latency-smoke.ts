import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { askPi, disposePiSessions, registerPiSessionCwd } from "../src/pi-session.js";

const PR_KEY = "github.com/local/latency-smoke#1";
const QUESTION = "Reply with the single word: ok.";
const PURPOSES = ["inline-chat", "focus-chat", "chat"];

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

async function timePurpose(purpose: string): Promise<void> {
  const start = performance.now();
  let firstTokenAt: number | null = null;
  const answer = await askPi(PR_KEY, QUESTION, purpose, () => {
    if (firstTokenAt == null) firstTokenAt = performance.now();
  });
  const end = performance.now();
  const ttft = firstTokenAt == null ? end - start : firstTokenAt - start;
  console.log(`${purpose.padEnd(12)} ttft=${ms(ttft).padStart(8)} total=${ms(end - start).padStart(8)} chars=${answer.length}`);
}

async function main(): Promise<void> {
  await registerPiSessionCwd(PR_KEY, resolve(process.cwd()));
  console.log("cold start (includes session creation):");
  for (const purpose of PURPOSES) await timePurpose(purpose);
  console.log("\nwarm (session already created):");
  for (const purpose of PURPOSES) await timePurpose(purpose);
  await disposePiSessions();
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
