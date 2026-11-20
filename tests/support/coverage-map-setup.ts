// #1211: per-test coverage, used only by `scripts/test-coverage-map.ts collect` (vitest.coverage-map.config.ts), never by the ordinary test run.
// V8 precise coverage (node:inspector) is reset before each test and taken after it, so each record holds exactly what that test (with its own
// beforeEach/afterEach hooks) executed. Only product code is kept: the scripts vitest evaluates from packages/*/src. A script's executed regions are
// worked out here (the innermost V8 range decides whether an offset ran) and written as offset intervals into the transformed code; the transformed code
// itself is saved once per content hash so the reducer can map offsets back to TypeScript lines through its inline source map.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { afterEach, beforeEach, type TestContext } from "vitest";
import { executedIntervals, isProductScript, type CoverageRange } from "./coverage-map-core.js";

interface ScriptCoverage { scriptId: string; url: string; functions: Array<{ ranges: CoverageRange[] }> }

const directory = process.env.COVMAP_DIR;
if (directory === undefined || directory === "") throw new Error("coverage-map-setup needs COVMAP_DIR (run it through scripts/test-coverage-map.ts)");
const sources = join(directory, "sources");
mkdirSync(sources, { recursive: true });
const records = join(directory, `records-${String(process.pid)}.jsonl`);
// `collect --skip <ids.json>`: the tests named there are skipped, to check that the area's coverage without them is unchanged.
const skipped = new Set<string>(process.env.COVMAP_SKIP === undefined ? [] : (JSON.parse(readFileSync(process.env.COVMAP_SKIP, "utf8")) as string[]));

const session = new Session();
session.connect();
await session.post("Debugger.enable");
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const savedSource = new Map<string, string>();

async function sourceHash(scriptId: string): Promise<string> {
  const known = savedSource.get(scriptId);
  if (known !== undefined) return known;
  const { scriptSource } = await session.post("Debugger.getScriptSource", { scriptId });
  const hash = createHash("sha256").update(scriptSource).digest("hex").slice(0, 20);
  const path = join(sources, `${hash}.js`);
  if (!existsSync(path)) writeFileSync(path, scriptSource);
  savedSource.set(scriptId, hash);
  return hash;
}

/** "tests/unit/x.test.ts > describe > it": the file, then every suite and the test's own title. */
function testId(context: TestContext): { id: string; file: string } {
  const names: string[] = [];
  for (let task: { name: string; suite?: unknown } | undefined = context.task; task !== undefined; task = task.suite as typeof task) {
    if (task.name !== "") names.unshift(task.name);
  }
  const file = context.task.file.filepath.replace(/^.*?\/tests\//u, "tests/");
  return { id: [file, ...names.filter((name) => name !== context.task.file.name)].join(" > "), file };
}

beforeEach(async (context) => {
  await session.post("Profiler.takePreciseCoverage");
  if (skipped.size > 0 && skipped.has(testId(context).id)) context.skip();
});

afterEach(async (context) => {
  const { result } = (await session.post("Profiler.takePreciseCoverage")) as unknown as { result: ScriptCoverage[] };
  const { id, file } = testId(context);
  if (skipped.has(id)) return;
  const scripts: Record<string, { h: string; iv: Array<[number, number]> }> = {};
  for (const script of result) {
    if (!isProductScript(script.url)) continue;
    if (!script.functions.some((fn) => fn.ranges[0] !== undefined && fn.ranges[0].count > 0)) continue;
    const intervals = executedIntervals(script.functions.flatMap((fn) => fn.ranges));
    if (intervals.length === 0) continue;
    const url = script.url.replace(/^file:\/\//u, "").replace(/^.*?\/packages\//u, "packages/");
    scripts[url] = { h: await sourceHash(script.scriptId), iv: intervals };
  }
  // A test that failed here (a timing check slowed by the coverage itself, say) is recorded as failed and always kept.
  const failed = (context.task.result?.errors?.length ?? 0) > 0 || context.task.result?.state === "fail";
  appendFileSync(records, `${JSON.stringify({ id, file, concurrent: context.task.concurrent === true, failed, scripts })}\n`);
});
