// CI's docs-only check. A pull request that changes only Markdown under specs/ or docs/ (or the
// root README) skips CI's heavy steps, unless a test mentions one of the changed files: some tests
// read a guide or the constitution, and those must still run. Pushes to mainline and manual runs
// never reach this check, so they always run everything. Node runs this file directly, before
// npm ci, so it imports only Node's own modules.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DocsOnlyResult { docsOnly: boolean; reason: string }

const DOCS_PATH = /^(?:(?:specs|docs)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|README)\.md$/;

/** Whether a change to these repository paths is Markdown only, given every test file's source. */
export function docsOnlyChange(changed: readonly string[], testSources: ReadonlyMap<string, string>): DocsOnlyResult {
  if (changed.length === 0) return { docsOnly: false, reason: "no changed files" };
  for (const path of changed) {
    if (!DOCS_PATH.test(path) || path.split("/").some((part) => part === "..")) {
      return { docsOnly: false, reason: `${path} is not a Markdown file under specs/ or docs/` };
    }
    for (const [testPath, source] of testSources) {
      if (source.includes(path)) return { docsOnly: false, reason: `${path} is mentioned in ${testPath}` };
    }
  }
  return { docsOnly: true, reason: `${changed.length} Markdown file${changed.length === 1 ? "" : "s"}, none read by a test` };
}

function testFiles(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [nested, source] of testFiles(path)) sources.set(nested, source);
    else if (entry.name.endsWith(".ts")) sources.set(path, readFileSync(path, "utf8"));
  }
  return sources;
}

// Usage: node scripts/ci-docs-only.ts <file listing the changed paths, one per line>
if (process.argv[1]?.endsWith("ci-docs-only.ts")) {
  const listed = process.argv[2];
  if (listed === undefined) throw new Error("usage: node scripts/ci-docs-only.ts <changed-files list>");
  const changed = readFileSync(listed, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const result = docsOnlyChange(changed, testFiles("tests"));
  console.log(result.docsOnly ? `Markdown-only change: ${result.reason}; skipping the heavy steps.` : `Full CI: ${result.reason}.`);
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result.docsOnly}\n`);
}
