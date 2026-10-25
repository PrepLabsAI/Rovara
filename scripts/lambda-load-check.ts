// Bundles control-plane Lambdas exactly as the release and test-deploy do, then require()s each bundle with a minimal environment.
//
// Why this exists: acb278a1 imported a module that reads `import.meta.url` into the broker's bundle. esbuild's CJS output turns that
// into `undefined`, so nine of eleven TEST Lambdas crashed at init, and nothing between the commit and TEST bundled or loaded them.
// This check is the gate: it runs in the default test suite (tests/contract/lambda-load.test.ts) and as a pre-step of every
// test-deploy apply that moves Lambda code. It reads and writes only a temporary directory; it makes no AWS call.
//
// Fail closed: a bundle passes only when it loads and exports a `handler` function, or when its init stops at a missing
// environment variable (`NAME is required`, the one failure a minimal environment legitimately causes). Every other error, a
// timeout, a missing result line, and any esbuild `import.meta` warning not in the allow-list below is a failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, type BuildOptions } from "esbuild";

/**
 * The esbuild options that decide what a Lambda bundle contains. test-deploy's buildLambdaZip spreads this same object, so the check
 * and the deploy cannot drift apart. (`entryPoints`, `outfile` and the output flags are set by each caller.)
 */
export const LAMBDA_BUNDLE_OPTIONS = {
  bundle: true, platform: "node", target: "node22", minify: true, sourcemap: true, external: [],
} as const satisfies BuildOptions;

export interface ImportMetaSite {
  /** How many `import.meta` warnings esbuild reports in this file; one more than this fails the check. */
  count: number;
  reason: string;
}

const VERIFIER_REASON = "reached through the @agentx/verifier index, which the broker imports for its compile/qualify helpers; the site sits inside a function the broker never calls (it uses only E2E_EXECUTOR_HOST_* constants from this module), so it cannot run at init";
/**
 * The `import.meta` sites esbuild reports in today's bundles, by repo-relative file. They are all in packages/verifier/dist and all
 * inside functions of runtime-only code (m14-final-review M-1). Narrowing the broker to verifier subpaths would remove them; until
 * then a NEW site, or one in another file, fails the check. `import.meta` at module level would crash at init, which the load step
 * catches independently of this list.
 */
export const IMPORT_META_ALLOWLIST: Readonly<Record<string, ImportMetaSite>> = {
  "packages/verifier/dist/application-runtime-assets.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/application-runtime-bootstrap.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/application-runtime-cli.js": { count: 3, reason: VERIFIER_REASON },
  "packages/verifier/dist/application-runtime-probes.js": { count: 2, reason: VERIFIER_REASON },
  "packages/verifier/dist/executor/host-registry.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/host/executor-seccomp.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/host/web-api-probe-plan.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/host/web-api-qualification-app.js": { count: 1, reason: VERIFIER_REASON },
  "packages/verifier/dist/runtime-cli.js": { count: 1, reason: VERIFIER_REASON },
};

export interface LambdaLoadEntry {
  name: string;
  /** Repo-relative entry file, as in CONTROL_PLANE_LAMBDAS. */
  entry: string;
}

export interface LambdaLoadResult {
  name: string;
  status: "loaded" | "env-missing" | "failed";
  detail: string;
}

export interface LambdaLoadReport {
  ok: boolean;
  results: LambdaLoadResult[];
  /** One line per failure, ready to print. */
  problems: string[];
}

/** The only init error a minimal environment may cause: the repo's `requiredEnvironment` message, `NAME is required`. */
const MISSING_ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]*[A-Z0-9] is required$/;
const RESULT_MARKER = "__LAMBDA_LOAD_RESULT__";
const LOAD_TIMEOUT_MS = 60_000;

/** Runs in the child: requires the bundle and prints exactly one marked result line. */
const LOADER = `
const marker = ${JSON.stringify(RESULT_MARKER)};
try {
  const loaded = require(process.argv[1]);
  console.log(marker + JSON.stringify({ ok: true, handler: typeof loaded.handler }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(marker + JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "thrown", code: error && error.code, message: message.slice(0, 300) }));
}
`;

/** The environment a loaded handler sees: a region and placeholder credentials so no provider chain waits on the network, and nothing else. */
function minimalEnvironment(): NodeJS.ProcessEnv {
  return { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "load-check", AWS_SECRET_ACCESS_KEY: "load-check" };
}

export function classifyLoad(stdout: string, status: number | null, timedOut: boolean): Pick<LambdaLoadResult, "status" | "detail"> {
  if (timedOut) return { status: "failed", detail: `init did not finish in ${LOAD_TIMEOUT_MS / 1000}s` };
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(RESULT_MARKER));
  if (line === undefined) return { status: "failed", detail: `the process ended (exit ${String(status)}) without reporting a load result` };
  let parsed: { ok?: boolean; handler?: string; name?: string; code?: string; message?: string };
  try {
    parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as typeof parsed;
  } catch {
    return { status: "failed", detail: "the load result was not JSON" };
  }
  if (parsed.ok === true) {
    return parsed.handler === "function"
      ? ({ status: "loaded", detail: "exports a handler function" })
      : ({ status: "failed", detail: `loaded, but handler is ${String(parsed.handler)}, not a function` });
  }
  const message = typeof parsed.message === "string" ? parsed.message : "";
  if (MISSING_ENVIRONMENT_VARIABLE.test(message)) return { status: "env-missing", detail: message };
  return { status: "failed", detail: `init threw ${String(parsed.name)}${parsed.code === undefined ? "" : ` (${parsed.code})`}: ${message}` };
}

/** `import.meta` warnings esbuild reported, counted per repo-relative file. Other warnings are not this check's business. */
function importMetaSites(warnings: readonly { id: string; location: { file: string } | null }[]): Map<string, number> {
  const sites = new Map<string, number>();
  for (const warning of warnings) {
    if (warning.id !== "empty-import-meta") continue;
    const file = warning.location?.file ?? "(unknown file)";
    sites.set(file, (sites.get(file) ?? 0) + 1);
  }
  return sites;
}

/** The `import.meta` sites outside the allow-list, one problem line each. */
export function importMetaProblems(name: string, sites: ReadonlyMap<string, number>, allowlist: Readonly<Record<string, ImportMetaSite>>): string[] {
  const problems: string[] = [];
  for (const [file, count] of sites) {
    const allowed = Object.hasOwn(allowlist, file) ? allowlist[file]!.count : 0;
    if (count > allowed) {
      problems.push(`${name}: ${count - allowed} unlisted import.meta site(s) in ${file} (esbuild's CJS output makes import.meta empty, so code that reads import.meta.url throws at run time; import the module's subpath instead of an index that pulls it in, or add the file to IMPORT_META_ALLOWLIST with a reason)`);
    }
  }
  return problems;
}

/**
 * Bundles every entry with LAMBDA_BUNDLE_OPTIONS and loads it. `root` is the repository (the entries' base). The report is `ok` only
 * when every bundle loaded or stopped at a missing environment variable and no import.meta site is outside the allow-list.
 */
export async function checkLambdaBundles(options: {
  root: string;
  entries: readonly LambdaLoadEntry[];
  allowlist?: Readonly<Record<string, ImportMetaSite>>;
}): Promise<LambdaLoadReport> {
  const allowlist = options.allowlist ?? IMPORT_META_ALLOWLIST;
  const scratch = mkdtempSync(join(tmpdir(), "lambda-load-"));
  const results: LambdaLoadResult[] = [];
  const problems: string[] = [];
  try {
    for (const { name, entry } of options.entries) {
      let built;
      try {
        built = await build({
          ...LAMBDA_BUNDLE_OPTIONS, absWorkingDir: options.root, entryPoints: [entry], outfile: "index.js", write: false, metafile: true, logLevel: "silent",
        });
      } catch (error) {
        const detail = `esbuild could not bundle ${entry}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        results.push({ name, status: "failed", detail });
        problems.push(`${name}: ${detail}`);
        continue;
      }
      problems.push(...importMetaProblems(name, importMetaSites(built.warnings), allowlist));
      const dir = join(scratch, name);
      mkdirSync(dir, { recursive: true });
      for (const file of built.outputFiles) writeFileSync(join(dir, file.path.slice(dirname(file.path).length + 1)), file.contents);
      // The cwd is the scratch directory: nothing is read from the repository at init except what the bundle itself holds.
      const child = spawnSync(process.execPath, ["--enable-source-maps", "-e", LOADER, join(dir, "index.js")], {
        cwd: dir, env: minimalEnvironment(), encoding: "utf8", timeout: LOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      });
      const timedOut = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      const result = classifyLoad(child.stdout ?? "", child.status, timedOut);
      results.push({ name, ...result });
      if (result.status === "failed") problems.push(`${name}: ${result.detail}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: problems.length === 0 && results.every((result) => result.status !== "failed"), results, problems };
}

/** The error a deploy or test raises for a failed report. */
export function lambdaLoadError(report: LambdaLoadReport): Error {
  return new Error(`control-plane Lambda bundles do not load; nothing was changed:\n${report.problems.map((problem) => `  - ${problem}`).join("\n")}`);
}
