// The worker side of the on-account model checks (M1.4 Task 4.9 step 3, extended by Task 4.10C), run inside the worker container by the boot qualification hook once the
// qualification succeeded:
//
//   node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --bucket <control artifacts bucket> --prefix e2e-runtime/<role unique ID>:<instance ID>/ [--wait-seconds 604800]
//
// It is a bounded server. It polls `<prefix>canary-request.json` (put by the broker's model check route, or by `scripts/test-model-canary.ts`) every 20 seconds for the first two hours and
// every 120 seconds after, until the runner's registration expires (seven days) or it is stopped (SIGTERM). Each distinct request id is served ONCE (a repeat is ignored), at most
// 12 requests in the runner's life (a 13th is refused `served-limit` with no call), at least 60 seconds apart. A request is a model check (`rovara-e2e-model-check-request/v2`: a
// driving test or a discovery) or, as before, a single-call canary (v1), which gates nothing. The result is put under `<prefix>canary-result.json`: receipts, digests and counts, never
// a prompt or an answer. The two keys are the only objects it touches (the `E2eQualificationTransportCanary` grant allows exactly those).
//
// It prints fixed lines only, to stderr, which the boot hook writes to the journal as `model-check: ...` lines. The first unreadable request logs one line with the error's name.
// Exit 0 when it stops, 1 when a result could not be written, 2 for bad arguments.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";
import { E2E_MODEL_CHECK_RESULT_SCHEMA, MODEL_CHECK_MAX_PER_RUNNER, MODEL_CHECK_MIN_SPACING_MS } from "@agentx/contracts";
import { runE2EModelCanary } from "./e2e-model-canary.js";
import { requestFingerprint, requestIdOf, runE2EModelCheck } from "./e2e-model-check.js";

export const CANARY_REQUEST_KEY = "canary-request.json";
export const CANARY_RESULT_KEY = "canary-result.json";
const REQUEST_MAX_BYTES = 4_096;
const PREFIX = /^e2e-runtime\/AROA[A-Z0-9]{12,}:i-[0-9a-f]{8,17}\/$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The registration lives seven days. */
export const MODEL_CHECK_SERVE_SECONDS = 604_800;
const FAST_POLL_MS = 20_000;
const SLOW_POLL_MS = 120_000;
const FAST_POLL_WINDOW_MS = 2 * 60 * 60_000;

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
  const waitSeconds = Number(values.get("--wait-seconds") ?? String(MODEL_CHECK_SERVE_SECONDS));
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MODEL_CHECK_SERVE_SECONDS) throw new Error(`--wait-seconds must be a whole number from 0 to ${MODEL_CHECK_SERVE_SECONDS}`);
  return { bucket, prefix, waitSeconds };
}

export interface CanaryTransport {
  /** The object's bytes, or undefined when it is not there (yet). */
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: string): Promise<void>;
}
export interface ModelCheckServerDependencies {
  transport: CanaryTransport;
  /** Answers one parsed request (any version) with the result to put. */
  run: (raw: unknown) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  /** True once the process was told to stop. */
  stopped?: () => boolean;
  /** Test seams for the bounds (the plan's values by default). */
  maxServed?: number;
  spacingMs?: number;
}

const nameOf = (error: unknown): string => (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error");
const refused = (code: string, checkId: string | null) => `${JSON.stringify({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "refused", code, checkId })}\n`;

/** One fixed log line about a result: its kind and outcome as fixed words, nothing from the result's text. */
function describeResult(result: unknown): string {
  const value = (typeof result === "object" && result !== null ? result : {}) as { status?: unknown; code?: unknown; receipt?: { outcome?: unknown }; drive?: { outcome?: unknown } };
  if (value.status === "driven") return `driving test ${value.drive?.outcome === "passed" ? "passed" : "failed"}`;
  if (value.status === "discovered") return "discovery done";
  if (value.status === "called") return `canary called, outcome ${typeof value.receipt?.outcome === "string" && /^[a-z-]{1,40}$/.test(value.receipt.outcome) ? value.receipt.outcome : "unknown"}`;
  if (value.status === "refused") return `refused, ${typeof value.code === "string" && /^[a-z-]{1,64}$/.test(value.code) ? value.code : "unknown"}`;
  return "did not run";
}

export async function serveModelChecks(args: CanaryCliArgs, dependencies: ModelCheckServerDependencies): Promise<number> {
  const { transport, log } = dependencies;
  const maxServed = dependencies.maxServed ?? MODEL_CHECK_MAX_PER_RUNNER;
  const spacingMs = dependencies.spacingMs ?? MODEL_CHECK_MIN_SPACING_MS;
  const startedAt = dependencies.now();
  const deadline = startedAt + args.waitSeconds * 1000;
  const served = new Set<string>();
  let lastServedAt: number | undefined;
  let unreadableLogged = false;
  log("model-check: serving model checks from this runner");

  const put = async (body: string): Promise<boolean> => {
    try { await transport.put(`${args.prefix}${CANARY_RESULT_KEY}`, body); return true; } catch { log("model-check: the result could not be uploaded"); return false; }
  };

  for (;;) {
    if (dependencies.stopped?.() === true || dependencies.now() >= deadline) { log("model-check: stopped"); return 0; }
    let bytes: Uint8Array | undefined;
    // A read that fails (denied, throttled) is treated as "not there yet": nothing is called without a request. The first failure is logged, with the error's name only.
    try { bytes = await transport.get(`${args.prefix}${CANARY_REQUEST_KEY}`); } catch (error) {
      if (!unreadableLogged) { unreadableLogged = true; log(`model-check: request not readable (${nameOf(error)})`); }
      bytes = undefined;
    }
    if (bytes !== undefined) {
      let raw: unknown;
      let id: string | undefined;
      const oversize = bytes.byteLength === 0 || bytes.byteLength > REQUEST_MAX_BYTES;
      if (!oversize) { try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); id = requestIdOf(raw); } catch { raw = undefined; } }
      const key = id ?? `x-${requestFingerprint(bytes)}`;
      if (!served.has(key)) {
        served.add(key);
        if (served.size > maxServed) {
          log("model-check: refused, served-limit");
          if (!await put(refused("served-limit", id ?? null))) return 1;
        } else if (oversize || raw === undefined) {
          log("model-check: refused, check-request-invalid");
          if (!await put(refused("check-request-invalid", id ?? null))) return 1;
        } else {
          // At least `spacingMs` after the last one: wait it out (the request stays under the key).
          if (lastServedAt !== undefined) { const wait = lastServedAt + spacingMs - dependencies.now(); if (wait > 0) await dependencies.sleep(wait); }
          let body: string;
          try {
            const result = await dependencies.run(raw);
            body = `${JSON.stringify(result)}\n`;
            log(`model-check: ${describeResult(result)}`);
          } catch (error) {
            // A fault outside the route (the route answers every provider failure with a receipt). Only a fixed reason is kept.
            log(`model-check: failed (${nameOf(error)})`);
            body = id === undefined ? refused("check-request-invalid", null) : `${JSON.stringify({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "failed", reason: "check-run-failed", checkId: id })}\n`;
          }
          lastServedAt = dependencies.now();
          if (!await put(body)) return 1;
        }
      }
    }
    await dependencies.sleep(dependencies.now() - startedAt < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS);
  }
}

/** The request's own version decides who answers it: the single-call canary (v1) as before, anything else is a model check. */
export function runRequest(raw: unknown): Promise<unknown> {
  const version = typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  return version === "rovara-e2e-model-canary-request/v1" ? runE2EModelCanary(raw) : runE2EModelCheck(raw);
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
  try { args = parseCanaryCliArgs(argv); } catch { console.error("model-check: bad arguments"); return 2; }
  const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"] || undefined;
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  return serveModelChecks(args, {
    transport: s3CanaryTransport(args.bucket, region), run: runRequest,
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }), now: () => Date.now(), log: (line) => console.error(line), stopped: () => stop,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainCanaryCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
