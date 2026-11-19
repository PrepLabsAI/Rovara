// REVIEW-1 (Opus) probes, kept as tests: the classifier over real git repositories and the real bridge socket.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEgress, ModelEgressScope } from "@agentx/contracts";
import { attestRovaraOnlyBaseCheckout } from "@agentx/contracts";
import { candidatePromptChanges, withEvalChangedPromptClassifier, evalChangedPrompt } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import { createBridgedEvalExec } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import { answer, frame } from "../support/eval-model-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function repo(base: Record<string, string | Buffer>, head: Record<string, string | Buffer | null>, extra?: (dir: string) => void) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ecp-"))); roots.push(dir);
  g(dir, "init", "-q");
  // One unrelated model-call module: a repository where no model-call code is recognised at all is unknown.
  for (const [p, c] of Object.entries({ "llm.py": "import openai\n", ...base })) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); const baseSha = g(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(head)) { if (c === null) await rm(join(dir, p)); else { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); } }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty"); const tree = g(dir, "rev-parse", "HEAD^{tree}");
  extra?.(dir);
  return { repositories: [{ repositoryId: "one", directory: dir, baseCommitSha: baseSha }], candidates: [{ repositoryId: "one", commitSha: g(dir, "rev-parse", "HEAD"), treeSha: tree, baseCommitSha: baseSha }], dir };
}
const sig = () => new AbortController().signal;

describe("changed-prompt classification over real git", () => {
  it("unrelated code -> none_found; nested path recursion", async () => {
    const r = await repo({ "src/deep/count.ts": "export const count = 1;\n" }, { "src/deep/count.ts": "export const count = 2;\n" });
    const rep = await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha);
    expect(rep?.status).toBe("none_found");
  });
  it("prompt file change -> unknown (AI-related)", async () => {
    const r = await repo({ "prompts/sys.md": "old\n" }, { "prompts/sys.md": "new\n" });
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("rename of a prompt file -> unknown (AI-related)", async () => {
    const r = await repo({ "prompts/a.md": "same\n" }, { "prompts/a.md": null, "prompts/b.md": "same\n" });
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("an unrelated binary -> none_found; a non-UTF-8 code file -> undefined", async () => {
    const b = await repo({ "x.png": Buffer.from([1, 0, 2]) }, { "x.png": Buffer.from([1, 0, 3]) });
    expect((await candidatePromptChanges(b.repositories, b.candidates, sig(), b.repositories[0]!.baseCommitSha))?.status).toBe("none_found");
    const n = await repo({ "x.ts": Buffer.from([0x61]) }, { "x.ts": Buffer.from([0xff, 0x61]) });
    expect(await candidatePromptChanges(n.repositories, n.candidates, sig(), n.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("a NUL byte in a changed source blob -> unknown", async () => {
    const r = await repo({ "x.ts": Buffer.from("export const value = 1;\n") }, { "x.ts": Buffer.from("export const value = 2;\0\n") });
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("mode-only change -> none_found", async () => {
    const r = await repo({ "run.sh.ts": "x\n" }, {}, () => undefined);
    // chmod then commit
    execFileSync("chmod", ["+x", join(r.dir, "run.sh.ts")]); g(r.dir, "add", "-A"); g(r.dir, "commit", "-qm", "mode");
    const tree = g(r.dir, "rev-parse", "HEAD^{tree}");
    expect((await candidatePromptChanges(r.repositories, [{ ...r.candidates[0]!, treeSha: tree }], sig(), r.repositories[0]!.baseCommitSha))?.status).toBe("none_found");
  });
  it("candidate replace ref / textconv attrs / ext diff config are not honoured", async () => {
    // A model name in config that no AI file names: F4 still reports it. A honoured replace ref would make both sides equal (none_found).
    const r = await repo({ "config/app.yaml": "model: gpt-4o\n" }, { "config/app.yaml": "model: gpt-4o-mini\n" }, (dir) => {
      execFileSync("sh", ["-c", "mkdir -p .git/info && echo '*.yaml diff=x' > .git/info/attributes"], { cwd: dir });
      const oldBlob = g(dir, "rev-parse", "HEAD~1:config/app.yaml"); const newBlob = g(dir, "rev-parse", "HEAD:config/app.yaml");
      g(dir, "replace", newBlob, oldBlob);
      g(dir, "config", "diff.x.textconv", "false"); g(dir, "config", "diff.external", "false");
    });
    expect((await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha))?.status).toBe("changes");
  });
  const builder = { "package.json": "{\"dependencies\":{\"openai\":\"4.0.0\"}}", "src/llm.ts": "import OpenAI from 'openai';\nimport { readFileSync } from 'node:fs';\nimport { greeting } from './text.js';\nexport const p = readFileSync('assets/persona.txt', 'utf8') + greeting;\n" };
  it("a runtime-loaded persona.txt (no prompt/system in its name) that an AI file reads is unknown; with no reader it is none_found (EVAL-PROMPT-DETECT-RUNTIME-LOADED, EVAL-TRIGGER-NARROW)", async () => {
    const r = await repo({ ...builder, "src/text.ts": "export const greeting = 1;\n", "assets/persona.txt": "You are terse.\n" }, { "assets/persona.txt": "You are verbose.\n" });
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
    const lone = await repo({ "assets/persona.txt": "You are terse.\n" }, { "assets/persona.txt": "You are verbose.\n" });
    expect((await candidatePromptChanges(lone.repositories, lone.candidates, sig(), lone.repositories[0]!.baseCommitSha))?.status).toBe("none_found");
  });
  it("a string constant in a non-AI .ts that the prompt builder imports is unknown, not none_found", async () => {
    const r = await repo({ ...builder, "src/text.ts": "export const greeting = 'Be terse.';\n" }, { "src/text.ts": "export const greeting = 'Be verbose.';\n" });
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("diffs from the plan's base, not from the commit before the candidate", async () => {
    // base -> prompt change -> unrelated change. A diff from HEAD~1 would hide the prompt change; the plan's base shows it.
    const r = await repo({ "prompts/sys.md": "old\n", "src/c.ts": "export const c = 1;\n" }, { "prompts/sys.md": "new\n" });
    await writeFile(join(r.dir, "src/c.ts"), "export const c = 2;\n"); g(r.dir, "add", "-A"); g(r.dir, "commit", "-qm", "later");
    const tree = g(r.dir, "rev-parse", "HEAD^{tree}");
    // From HEAD~1 only the unrelated c.ts would show (none_found); from the plan's base the prompt file shows too (unknown).
    expect(await candidatePromptChanges(r.repositories, [{ ...r.candidates[0]!, treeSha: tree }], sig(), r.repositories[0]!.baseCommitSha)).toBeUndefined();
  });
  it("a plan base other than the repository's base is unknown, even when it is a real commit of that repository", async () => {
    const r = await repo({ "src/c.ts": "export const c = 1;\n" }, { "src/c.ts": "export const c = 2;\n" });
    const head = g(r.dir, "rev-parse", "HEAD");
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), head)).toBeUndefined();
    expect(await candidatePromptChanges(r.repositories, r.candidates, sig(), undefined)).toBeUndefined();
  });
});

describe("per-check classification through the real bridge socket", () => {
  it("unrelated code change gives 0 through a real socket; prompt change counts", async () => {
    for (const [base, head, want] of [[{ "src/c.ts": "export const c = 1;\n" }, { "src/c.ts": "export const c = 2;\n" }, 0], [{ "prompts/s.md": "a\n" }, { "prompts/s.md": "b\n" }, 3]] as const) {
      const r = await repo(base, head);
      const run = await mkdtemp("/tmp/ecr-"); roots.push(run);
      const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward() { yield* answer(); } };
      const exec = createBridgedEvalExec({ runDir: run, modelAllowed: () => true, changedPrompt: evalChangedPrompt, sandbox: { available: () => true, run: async (input) => {
        for (let i = 0; i < 3; i++) await collectModelBridge({ socketPath: input.model.socketPath, mode: "real", token: input.model.token, frame: { ...frame(JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] })) } });
        return { report: { root: "/r", cwd: ".", argument: "r.json", notBeforeMs: 1 }, ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: "a".repeat(40) }) } : {}) };
      } } });
      const result = await withEvalChangedPromptClassifier(r.repositories, r.candidates, sig(), async () => ({ key: { baseCommit: r.repositories[0]!.baseCommitSha } }), () => exec.run({ side: "new", ids: ["q"], runs: 1, egress, scope: Object.freeze({}) as unknown as ModelEgressScope, signal: sig() }));
      expect(result.changedPromptCalls).toBe(want);
    }
  });
});
