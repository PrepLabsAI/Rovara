import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IMPORT_META_ALLOWLIST, checkLambdaBundles, classifyLoad, importMetaProblems, lambdaLoadError } from "../../scripts/lambda-load-check.js";
import { CONTROL_PLANE_LAMBDAS } from "../../scripts/test-deploy.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const handlerSource = "export const handler = async () => ({ statusCode: 200 });\n";

const scratch = mkdtempSync(join(tmpdir(), "lambda-load-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes fixture entry files into their own root and returns it. */
function fixtureRoot(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function check(name: string, files: Record<string, string>, allowlist: Parameters<typeof checkLambdaBundles>[0]["allowlist"] = {}) {
  const root = fixtureRoot(name, files);
  return checkLambdaBundles({ root, entries: Object.keys(files).map((entry) => ({ name: entry.replace(/\.ts$/, ""), entry })), allowlist });
}

describe("the real control-plane Lambdas (I-1 LAMBDALOAD gate)", () => {
  const entries = Object.entries(CONTROL_PLANE_LAMBDAS).map(([name, lambda]) => ({ name, entry: lambda.entry }));

  it("every CONTROL_PLANE_LAMBDAS bundle loads, or stops at init on a missing environment variable only", async () => {
    const report = await checkLambdaBundles({ root: repoRoot, entries });
    // Positive control: every entry was bundled and loaded, not skipped.
    expect(report.results.map((result) => result.name)).toEqual(entries.map((entry) => entry.name));
    expect(report.problems).toEqual([]);
    expect(report.results.filter((result) => result.status === "failed")).toEqual([]);
    expect(report.results.filter((result) => result.status === "loaded").length).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(true);
  }, 300_000);

  it("keeps the import.meta allow-list exact: the broker's sites are all listed, and no listed site is gone", async () => {
    // With an empty allow-list the broker's own warnings become the problems, so this proves both that detection works on a real bundle
    // and that the list names exactly those files with exactly those counts (a fixed site must leave the list).
    const report = await checkLambdaBundles({ root: repoRoot, entries: entries.filter((entry) => entry.name === "broker"), allowlist: {} });
    const found = new Map(report.problems.map((problem) => [/ in (\S+) \(/.exec(problem)?.[1] ?? problem, Number(/: (\d+) unlisted/.exec(problem)?.[1])]));
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(IMPORT_META_ALLOWLIST).map(([file, site]) => [file, site.count])));
    for (const [file, site] of Object.entries(IMPORT_META_ALLOWLIST)) {
      expect(file.startsWith("packages/verifier/dist/")).toBe(true);
      expect(site.reason.length).toBeGreaterThan(20);
    }
  }, 120_000);

  it("is wired into test-deploy: buildLambdaZip uses the shared bundle options and the load check runs before any step is applied", () => {
    const source = readFileSync(join(repoRoot, "scripts", "test-deploy.ts"), "utf8");
    const zip = source.slice(source.indexOf("async function buildLambdaZip"));
    expect(zip.slice(0, zip.indexOf("deterministicZip"))).toContain("...LAMBDA_BUNDLE_OPTIONS");
    const main = source.slice(source.indexOf("export async function main"));
    const gate = main.indexOf("await assertLambdasLoad(context, args.only)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(main.indexOf("for (const step of steps) await applyStep(context, step)"));
  });
});

describe("checkLambdaBundles on fixtures", () => {
  it("accepts a bundle that exports a handler", async () => {
    const report = await check("ok", { "ok.ts": handlerSource });
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(report.results[0]).toMatchObject({ status: "loaded" });
  });

  it("accepts an init that stops at a missing environment variable, and only that", async () => {
    const report = await check("env", { "env.ts": `if (!process.env.SOME_TABLE_NAME) throw new Error("SOME_TABLE_NAME is required");\n${handlerSource}` });
    expect(report.ok).toBe(true);
    expect(report.results[0]).toMatchObject({ status: "env-missing", detail: "SOME_TABLE_NAME is required" });
  });

  it("fails the acb278a1 shape: import.meta.url read at init throws in CJS", async () => {
    const files = { "crash.ts": `import { fileURLToPath } from "node:url";\nexport const here = fileURLToPath(import.meta.url);\n${handlerSource}` };
    const report = await check("crash", files);
    expect(report.ok).toBe(false);
    expect(report.results[0]).toMatchObject({ status: "failed" });
    expect(report.results[0]!.detail).toMatch(/ERR_INVALID_ARG_TYPE/);
    expect(report.problems.some((problem) => /unlisted import\.meta site/.test(problem))).toBe(true);
  });

  it("fails an import.meta site inside a function that init never runs, unless that file is listed with that count", async () => {
    const files = { "latent.ts": `export const where = () => import.meta.url;\n${handlerSource}` };
    const unlisted = await check("latent-unlisted", files);
    expect(unlisted.ok).toBe(false);
    expect(unlisted.results[0]).toMatchObject({ status: "loaded" });
    expect(unlisted.problems).toHaveLength(1);
    const listed = await check("latent-listed", files, { "latent.ts": { count: 1, reason: "fixture" } });
    expect(listed).toMatchObject({ ok: true, problems: [] });
    const second = { "latent.ts": `export const where = () => [import.meta.url, import.meta.dirname];\n${handlerSource}` };
    const grown = await check("latent-grown", second, { "latent.ts": { count: 1, reason: "fixture" } });
    expect(grown.ok).toBe(false);
    expect(grown.problems[0]).toMatch(/1 unlisted import\.meta site/);
  });

  it("fails any other init error, an env-looking message with extra words, a missing handler, and a silent exit", async () => {
    const cases: Record<string, string> = {
      "boom.ts": `throw new Error("boom");\n${handlerSource}`,
      "loose.ts": `throw new Error("X_Y is required to start the thing");\n${handlerSource}`,
      "lower.ts": `throw new Error("table name is required");\n${handlerSource}`,
      "nohandler.ts": "export const other = 1;\n",
      "exits.ts": `process.exit(0);\n${handlerSource}`,
      "thrown.ts": `throw "FOO_BAR is required";\n${handlerSource}`,
    };
    const report = await check("failures", cases);
    expect(report.ok).toBe(false);
    expect(Object.fromEntries(report.results.map((result) => [result.name, result.status]))).toEqual({
      boom: "failed", loose: "failed", lower: "failed", nohandler: "failed", exits: "failed", thrown: "env-missing",
    });
  });

  it("fails a bundle esbuild cannot build, without loading anything", async () => {
    const report = await check("unbuildable", { "bad.ts": `import "./does-not-exist.js";\n${handlerSource}` });
    expect(report.ok).toBe(false);
    expect(report.results[0]!.detail).toMatch(/esbuild could not bundle/);
  });

  it("states every failure in the error a deploy throws", async () => {
    const report = await check("message", { "boom.ts": `throw new Error("boom");\n` });
    const error = lambdaLoadError(report);
    expect(error.message).toMatch(/nothing was changed/);
    expect(error.message).toContain("boom: init threw Error: boom");
  });
});

describe("classifyLoad and importMetaProblems", () => {
  it("fails closed on a timeout, no result line, and a result line that is not JSON", () => {
    expect(classifyLoad("", 0, true).status).toBe("failed");
    expect(classifyLoad("noise\n", 0, false).status).toBe("failed");
    expect(classifyLoad("__LAMBDA_LOAD_RESULT__{not json", 0, false).status).toBe("failed");
  });

  it("counts a site in an unlisted file as a problem and a listed one within its count as fine", () => {
    const sites = new Map([["packages/a/dist/x.js", 2]]);
    expect(importMetaProblems("n", sites, {})).toHaveLength(1);
    expect(importMetaProblems("n", sites, { "packages/a/dist/x.js": { count: 2, reason: "r" } })).toEqual([]);
    expect(importMetaProblems("n", sites, { "packages/a/dist/x.js": { count: 1, reason: "r" } })).toHaveLength(1);
    // A file name that is an Object.prototype key is not on the list.
    expect(importMetaProblems("n", new Map([["constructor", 1]]), {})).toHaveLength(1);
  });
});
