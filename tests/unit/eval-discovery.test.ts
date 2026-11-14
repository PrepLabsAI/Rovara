import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, opendir } from "node:fs/promises";
import { join } from "node:path";
import { discoverEvals } from "../../packages/worker/src/verification/eval-discovery.js";
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "te-f3d-discovery-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it("finds measures, JUnit cases, tools and eval folders without choosing one", async () => {
  const path = await root(); await mkdir(join(path, "evals/refund"), { recursive: true });
  await writeFile(join(path, "evals/refund/promptfooconfig.yaml"), "tests: []");
  await writeFile(join(path, "rovara-measures.json"), JSON.stringify({ schemaVersion: 1, measures: [{ name: "score", unit: "fraction", value: .8, direction: "up_good" }], questions: [{ id: "q", samples: [{ pass: true, answer: "ok" }] }] }));
  await writeFile(join(path, "junit.xml"), '<testsuite tests="2"><testcase name="a"/><testcase name="b"/></testsuite>');
  const found = await discoverEvals(path);
  expect(found.status).toBe("found");
  expect(found.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "rovara-measures.json", questions: 1, perQuestion: true }),
    expect.objectContaining({ path: "junit.xml", questions: 2, perQuestion: true }),
    expect.objectContaining({ path: "evals/refund", tool: "promptfoo" }),
  ]));
  expect(found.message).toContain("Confirm an eval or point to the right one");
});
it("uses the exact no-eval text only after a complete empty scan", async () => {
  expect((await discoverEvals(await root())).message).toBe("No eval found. Prompt changes will show old vs new answers but can't be scored. Add an eval, or let Rovara help start one.");
  expect((await discoverEvals("does-not-exist")).status).toBe("incomplete");
});
it("reports aggregate-only measures honestly", async () => {
  const path = await root(); await writeFile(join(path, "rovara-measures.json"), JSON.stringify({ schemaVersion: 1, measures: [{ name: "score", unit: "fraction", value: .8, direction: "up_good" }] }));
  expect((await discoverEvals(path)).candidates).toEqual([expect.objectContaining({ perQuestion: false })]);
});
it("refuses links, unreadable reports and exhausted inventories instead of claiming nothing exists", async () => {
  const path = await root(); const outside = await root(); await symlink(outside, join(path, "evals"));
  expect((await discoverEvals(path)).status).toBe("incomplete");
  await writeFile(join(path, "rovara-measures.json"), '{"__proto__": {"polluted":true}}');
  expect((await discoverEvals(path)).omitted.length).toBeGreaterThan(0);
  expect((await discoverEvals(path, { maxEntries: 1 })).status).toBe("incomplete");
});
it("makes repository names inert, including a hostile megabyte", async () => {
  const path = await root(); await mkdir(join(path, "evals"));
  for (const name of ["@team #123", "[x[1]](url)", "![a[b]c](url)", "[x][ref]", "<b>html<", "# title", "> quote", "---", "```", "~~~", "hidden\u200b\ufe0f"]) await mkdir(join(path, "evals", name));
  const result = await discoverEvals(path);
  const text = result.candidates.map(c => c.label).join(" ");
  expect(text).not.toMatch(/@team|#123|\[|<b>|\u200b|\ufe0f/u);
  await writeFile(join(path, "rovara-measures.json"), "x".repeat(1_048_576));
  expect((await discoverEvals(path)).status).toBe("incomplete");
});
it("does not accept a symlink root or an expanded inventory limit", async () => {
  const path = await root(); const target = await root(); await symlink(target, join(path, "linked"));
  expect((await discoverEvals(join(path, "linked"))).status).toBe("incomplete");
  expect((await discoverEvals(target, { maxEntries: 2001 })).status).toBe("incomplete");
});
it("records a truncation when plain candidates exceed the inventory budget", async () => {
  const path = await root(); await writeFile(join(path, "promptfooconfig.yaml"), ""); await writeFile(join(path, "deepeval.json"), "{}");
  const result = await discoverEvals(path, { maxEntries: 1 });
  expect(result.status).toBe("incomplete"); expect(result.candidates).toHaveLength(1);
});
it("finds root candidates before traversing a large source tree", async () => {
  const path = await root();
  // Populate the first actual filesystem entry with a large subtree. The report is a
  // later root entry on both APFS and Linux, without depending on either directory order.
  for (let i = 0; i < 20; i++) await mkdir(join(path, `source-${i}`));
  const entries: string[] = [];
  for await (const entry of await opendir(path)) entries.push(entry.name);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(path, entries[0]!, `${i}.ts`), "")));
  await writeFile(join(path, "promptfooconfig.yaml"), "");
  const found = await discoverEvals(path, { maxEntries: 30 });
  expect(found.candidates.some(c => c.tool === "promptfoo")).toBe(true);
});
it("records a reason for every omitted entry within the bounded scan", async () => {
  const path = await root();
  await Promise.all(Array.from({ length: 110 }, (_, i) => symlink("missing-target", join(path, `link-${i}`))));
  const result = await discoverEvals(path);
  expect(result.omitted).toHaveLength(110); expect(result.status).toBe("incomplete");
});

it("deduplicates nested config, reports and support folders to their eval roots", async () => {
  const path = await root();
  await mkdir(join(path, "evals/refund/fixtures/prompts"), { recursive: true });
  await mkdir(join(path, "evals/refund/results"));
  await mkdir(join(path, "evals/search/data"), { recursive: true });
  await mkdir(join(path, "packages/app/evaluations/data"), { recursive: true });
  await writeFile(join(path, "evals/refund/promptfooconfig.yaml"), "tests: []");
  await writeFile(join(path, "evals/refund/results/junit.xml"), '<testsuite tests="2"><testcase name="a"/><testcase name="b"/></testsuite>');
  const result = await discoverEvals(path);
  expect(result.status).toBe("found"); expect(result.omitted).toEqual([]);
  expect(result.candidates).toEqual([
    expect.objectContaining({ path: "evals/refund", tool: "promptfoo", questions: 2, perQuestion: true }),
    expect.objectContaining({ path: "evals/search", tool: "eval folder" }),
    expect.objectContaining({ path: "packages/app/evaluations/data", tool: "eval folder" }),
  ]);
  expect(result.candidates[0]!.label).toBe("Found: evals/refund (2 questions, promptfoo)");
});
it("keeps question metadata when a nested config is discovered after the report", async () => {
  const path = await root(); await mkdir(join(path, "evals/refund/config"), { recursive: true });
  await writeFile(join(path, "evals/refund/junit.xml"), '<testsuite tests="1"><testcase name="a"/></testsuite>');
  await writeFile(join(path, "evals/refund/config/promptfooconfig.yaml"), "tests: []");
  const result = await discoverEvals(path);
  expect(result.candidates).toEqual([expect.objectContaining({ path: "evals/refund", tool: "promptfoo", perQuestion: true, questions: 1 })]);
});
