// The worker side of the model canary (M1.4 Task 4.9 step 3), run inside the worker container by the boot qualification hook:
//
//   node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --request-file <path> --out <path>
//
// It reads the operator's request (at most 4 KiB), makes at most one model call through the governed route (`runE2EModelCanary`) and writes the result: the receipt, the payload
// digest and the counts, never a prompt or an answer. It prints one fixed line. Exit 0 when a result was written (whatever its outcome), 2 for bad arguments or an unreadable request
// (a refused result is still written when the output path is known), 1 when the result could not be written.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { E2E_MODEL_CANARY_RESULT_SCHEMA, runE2EModelCanary, type E2EModelCanaryResult } from "./e2e-model-canary.js";

const REQUEST_MAX_BYTES = 4_096;

export function parseCanaryCliArgs(argv: readonly string[]): { requestFile: string; out: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (name !== "--request-file" && name !== "--out") throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const requestFile = values.get("--request-file");
  const out = values.get("--out");
  if (requestFile === undefined || out === undefined) throw new Error("--request-file and --out are required");
  return { requestFile, out };
}

export async function mainCanaryCli(argv: readonly string[], run: typeof runE2EModelCanary = runE2EModelCanary): Promise<number> {
  let args: { requestFile: string; out: string };
  try { args = parseCanaryCliArgs(argv); } catch { console.error("model-canary: bad arguments"); return 2; }
  let raw: unknown;
  let readable = true;
  try {
    const bytes = readFileSync(args.requestFile);
    if (bytes.byteLength > REQUEST_MAX_BYTES) throw new Error("too large");
    raw = JSON.parse(bytes.toString("utf8"));
  } catch { readable = false; }
  let result: E2EModelCanaryResult;
  try {
    result = readable ? await run(raw) : { schemaVersion: E2E_MODEL_CANARY_RESULT_SCHEMA, status: "refused", code: "canary-request-invalid", canaryId: null };
  } catch (error) {
    // A setup fault outside the route (none is expected: the route answers every failure with a receipt). Only its name is kept.
    console.error(`model-canary: failed (${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "error"})`);
    return 1;
  }
  try { writeFileSync(args.out, `${JSON.stringify(result)}\n`, { mode: 0o600 }); } catch { console.error("model-canary: the result could not be written"); return 1; }
  console.error(result.status === "called" ? `model-canary: called, outcome ${result.receipt.outcome}` : `model-canary: refused, ${result.code}`);
  return readable ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainCanaryCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
