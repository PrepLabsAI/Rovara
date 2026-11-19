// TE-F2 part B test support: a real model helper on loopback (the HTTP loop, the ledger, the metadata server) over a temp directory, and a small client. Fake keys are built at run time.
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelReplySetSchema, builtinModelCatalog, type ModelReplySet, type ServableRow, type ServedModelFamily } from "../../packages/contracts/src/index.js";
import { createModelLedgerWriter, summarizeModelLedgerFile, type ModelHelperSummary } from "../../packages/worker/src/model-helper-ledger.js";
import { startModelHelperLoop, type ModelHelperLoopOptions, type RunningModelHelperLoop } from "../../packages/worker/src/model-helper-http.js";

export const ROWS: readonly ServableRow[] = builtinModelCatalog().rows;
export const fakeKey = (): string => ["fake", "key", String(Math.floor(Math.random() * 1e9))].join("-");
export const ZERO_DIGEST = "0".repeat(64);

export function stampSet(family: ServedModelFamily, replies: Array<Record<string, unknown>>): ModelReplySet {
  return ModelReplySetSchema.parse({
    version: 1,
    family,
    replies: replies.map((reply) => ({ provenance: "before_task", origin: "customer_written", match: {}, response: { text: "scripted", finish: "stop" }, ...reply })),
  });
}

export interface World {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly loop: RunningModelHelperLoop;
  readonly base: string;
  readonly meta: string | undefined;
  summary(): ModelHelperSummary;
  ledgerText(): string;
  close(): Promise<void>;
}
const dirs: string[] = [];
export function cleanupWorlds(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function startWorld(over: Partial<ModelHelperLoopOptions> & { sets?: ModelReplySet[]; blockState?: "by_name" | "not_blocked_here"; mode?: "scripted" | "replay" | "record" | "real" } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "rsmh-"));
  dirs.push(dir);
  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = createModelLedgerWriter(ledgerPath, { header: 1, mode: over.mode ?? "scripted", blockState: over.blockState ?? "by_name", digest: ZERO_DIGEST, startedAt: 1 });
  const { sets, blockState: _b, mode: _m, ...rest } = over;
  void _b;
  void _m;
  const loop = await startModelHelperLoop({
    listen: "127.0.0.1",
    port: 0,
    metaPort: 0,
    caller: "127.0.0.1",
    mode: over.mode ?? "scripted",
    rows: ROWS,
    replySets: new Map((sets ?? []).map((set) => [set.family, set] as const)),
    ledger,
    projectId: "rovara-test-project",
    ...rest,
  });
  return {
    dir,
    ledgerPath,
    loop,
    base: `http://127.0.0.1:${String(loop.port)}`,
    meta: loop.metaPort === undefined ? undefined : `http://127.0.0.1:${String(loop.metaPort)}`,
    summary: () => summarizeModelLedgerFile(ledgerPath),
    ledgerText: () => readFileSync(ledgerPath, "utf8"),
    close: () => loop.close(),
  };
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; path?: string } = {}): Promise<Reply> {
  return new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(url);
    const req = http.request({ host: target.hostname, port: target.port, method: init.method ?? "GET", path: init.path ?? `${target.pathname}${target.search}`, headers: { connection: "close", ...init.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", rejectRequest);
    });
    req.on("error", rejectRequest);
    req.end(init.body);
  });
}
export const GEMINI_BODY = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "what is the weather in Paris" }] }] });
export const OPENAI_BODY = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "what is the weather in Paris" }] });
export const geminiPath = (row = "gemini", version = "v1beta", op = "generateContent", model = "gemini-2.5-flash"): string => `/p/${row}/${version}/models/${model}:${op}`;
