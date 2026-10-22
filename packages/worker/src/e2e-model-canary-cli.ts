// The worker side of the model canary (M1.4 Task 4.9 step 3), run inside the worker container by the boot qualification hook once the qualification succeeded:
//
//   node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --bucket <control artifacts bucket> --prefix e2e-runtime/<role unique ID>:<instance ID>/ [--wait-seconds 7200]
//
// It waits (bounded) for the operator's `<prefix>canary-request.json` (put by `scripts/test-model-canary.ts --apply`), makes at most one model call through the governed route
// (`runE2EModelCanary`) and puts `<prefix>canary-result.json`: the receipt, the payload digest and the counts, never a prompt or an answer. It serves one request and exits.
// The two keys are the only objects it touches (the `E2eQualificationTransportCanary` grant allows exactly those). It prints fixed lines only.
// Exit 0 when it wrote a result or no request came, 1 when the result could not be written, 2 for bad arguments.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";
import { E2E_MODEL_CANARY_RESULT_SCHEMA, runE2EModelCanary } from "./e2e-model-canary.js";

export const CANARY_REQUEST_KEY = "canary-request.json";
export const CANARY_RESULT_KEY = "canary-result.json";
const REQUEST_MAX_BYTES = 4_096;
const PREFIX = /^e2e-runtime\/AROA[A-Z0-9]{12,}:i-[0-9a-f]{8,17}\/$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface CanaryCliArgs { bucket: string; prefix: string; waitSeconds: number }

export function parseCanaryCliArgs(argv: readonly string[]): CanaryCliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!["--bucket", "--prefix", "--wait-seconds"].includes(name)) throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const bucket = values.get("--bucket") ?? "";
  const prefix = values.get("--prefix") ?? "";
  if (!BUCKET.test(bucket) || !PREFIX.test(prefix)) throw new Error("--bucket and --prefix (e2e-runtime/<role ID>:<instance ID>/) are required");
  const waitSeconds = Number(values.get("--wait-seconds") ?? "7200");
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86_400) throw new Error("--wait-seconds must be a whole number from 0 to 86400");
  return { bucket, prefix, waitSeconds };
}

export interface CanaryTransport {
  /** The object's bytes, or undefined when it is not there (yet). */
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: string): Promise<void>;
}
export interface CanaryCliDependencies {
  transport: CanaryTransport;
  run: (raw: unknown) => ReturnType<typeof runE2EModelCanary>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  pollMs?: number;
}

const failed = (reason: string) => `${JSON.stringify({ schemaVersion: E2E_MODEL_CANARY_RESULT_SCHEMA, status: "failed", reason })}\n`;

export async function serveModelCanary(args: CanaryCliArgs, dependencies: CanaryCliDependencies): Promise<number> {
  const { transport, log } = dependencies;
  const deadline = dependencies.now() + args.waitSeconds * 1000;
  let bytes: Uint8Array | undefined;
  for (;;) {
    // A read that fails (denied, throttled) is treated as "not there yet": nothing is called without a request.
    try { bytes = await transport.get(`${args.prefix}${CANARY_REQUEST_KEY}`); } catch { bytes = undefined; }
    if (bytes !== undefined) break;
    if (dependencies.now() >= deadline) { log("model-canary: no model canary was asked for"); return 0; }
    await dependencies.sleep(dependencies.pollMs ?? 10_000);
  }
  let body: string;
  if (bytes.byteLength === 0 || bytes.byteLength > REQUEST_MAX_BYTES) body = failed("canary-request-size-rejected");
  else {
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { raw = undefined; }
    try {
      const result = await dependencies.run(raw);
      body = `${JSON.stringify(result)}\n`;
      log(result.status === "called" ? `model-canary: called, outcome ${result.receipt.outcome}` : `model-canary: refused, ${result.code}`);
    } catch (error) {
      // A fault outside the route (the route answers every provider failure with a receipt). Only a fixed reason is kept.
      log(`model-canary: failed (${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "error"})`);
      body = failed("canary-run-failed");
    }
  }
  try { await transport.put(`${args.prefix}${CANARY_RESULT_KEY}`, body); } catch { log("model-canary: the result could not be uploaded"); return 1; }
  return 0;
}

export function s3CanaryTransport(bucket: string, region: string | undefined): CanaryTransport {
  const s3 = new S3Client({ ...(region === undefined ? {} : { region }), maxAttempts: 3 });
  return {
    async get(key) {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body === undefined ? new Uint8Array() : await response.Body.transformToByteArray();
      } catch (error) {
        if ((error as { name?: unknown }).name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", ServerSideEncryption: "AES256" }));
    },
  };
}

export async function mainCanaryCli(argv: readonly string[]): Promise<number> {
  let args: CanaryCliArgs;
  try { args = parseCanaryCliArgs(argv); } catch { console.error("model-canary: bad arguments"); return 2; }
  const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"] || undefined;
  return serveModelCanary(args, {
    transport: s3CanaryTransport(args.bucket, region), run: (raw) => runE2EModelCanary(raw),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }), now: () => Date.now(), log: (line) => console.error(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainCanaryCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
