import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attestRovaraOnlyBaseCheckout, detectPromptChanges, evalResultFromArtifact, type ModelEgress, type ModelEgressFrame, type ModelEgressScope, type PromptChangeReport } from "@agentx/contracts";
import { candidatePromptChanges, changedPromptClassifier, evalChangedPrompt, withEvalChangedPromptClassifier } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import { evalFinalCheckForTask } from "../../packages/worker/src/verification/eval-wiring.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";
import { frame } from "../support/eval-model-access.js";

const git = vi.hoisted(() => ({ bytes: vi.fn(), text: vi.fn(), read: vi.fn() }));
const bridge = vi.hoisted(() => ({ send: undefined as ((f: ModelEgressFrame) => Promise<void>) | undefined }));
// Exercise the real exec counter, runner, meter and task binding without opening a forbidden Unix socket.
vi.mock("../../packages/worker/src/model-bridge.js", () => ({ createModelBridge: (options: { egress: ModelEgress; egressScope: ModelEgressScope }) => {
  bridge.send = async f => { let drained = 0; for await (const event of options.egress.forward(options.egressScope, f)) drained += event.kind.length; void drained; };
  return { listen: async () => undefined, issueToken: () => "test-only-bridge-token", dropToken: () => undefined, close: async () => undefined };
} }));
vi.mock("../../packages/worker/src/isolated-git.js", () => ({
  withIsolatedGit: async (directory: string, mode: string, use: (g: unknown) => Promise<unknown>) => {
    git.read(directory, mode); return use(git);
  },
}));
afterEach(() => vi.resetAllMocks());

const modelFrame = (body: unknown): ModelEgressFrame => frame(JSON.stringify(body));
const call = (text = "new prompt", claim?: boolean) => modelFrame({ contents: [{ parts: [{ text }] }], ...(claim === undefined ? {} : { changedPrompt: claim }) });
const report = (before: string, after: string, path = "prompts/system.txt") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] }).report;
const baseCommitSha = "a".repeat(40); const treeSha = "b".repeat(40); const oldOid = "c".repeat(40); const newOid = "d".repeat(40);
const repositories = [{ repositoryId: "one", directory: "/worker/repo", baseCommitSha }];
const candidates = [{ repositoryId: "one", commitSha: "e".repeat(40), treeSha, baseCommitSha }];
const signal = () => new AbortController().signal;
const planned = (baseCommit = baseCommitSha) => async () => ({ key: { baseCommit } });
function source(before: string, after: string, path = "prompts/system.txt", mode = "100644", status = "M") {
  const old = Buffer.from(before); const next = Buffer.from(after);
  git.bytes.mockImplementation(async (args: string[]) => args[0] === "diff"
    ? Buffer.from(`:${mode} ${mode} ${oldOid} ${newOid} ${status}\0${path}\0`)
    : args[2] === oldOid ? old : next);
  git.text.mockImplementation(async (args: string[]) => String(args[2] === oldOid ? old.length : next.length));
}

describe("worker F4/F8 classifier", () => {
  it("recognizes changed prompt text through F8's whitespace-normalized fingerprint", () => {
    expect(changedPromptClassifier(report("old", "new prompt"))(call(" new  prompt "))).toBe(true);
  });
  it("returns false for a readable prompt call when complete source changes touch only unrelated code", () => {
    const change = report("export const count = 1;", "export const count = 2;", "src/count.ts");
    expect(change).toMatchObject({ coverage: "complete", status: "none_found" });
    expect(changedPromptClassifier(change)(call())).toBe(false);
  });
  it.each([
    ["unknown file kind", () => report("old", "new", "src/prompt.unsupported")],
    ["unreadable diff", () => undefined],
    ["dynamic source", () => report("system = f'old {name}'", "system = f'new {name}'", "ai/app.py")],
    ["removed prompt", () => detectPromptChanges({ files: [{ path: "system.prompt", before: "old", status: "removed", wholeFile: true }] }).report],
  ] as Array<[string, () => PromptChangeReport | undefined]>)("counts %s as changed", (_name, get) => {
    expect(changedPromptClassifier(get())(call())).toBe(true);
  });
  it("a non-match cannot prove a call came from unchanged source", () => {
    expect(changedPromptClassifier(report("old", "changed source"))(call("assembled at runtime"))).toBe(true);
  });
  it("unreadable and unmappable frames count as changed even with an unrelated-code diff", () => {
    const classify = changedPromptClassifier(report("const x = 1;", "const x = 2;", "src/x.ts"));
    for (const f of [frame("not JSON"), modelFrame({ unknownContents: "new prompt" }), modelFrame({}), modelFrame([])]) expect(classify(f)).toBe(true);
  });
  it("ignores claims in the sandbox's body and headers in both directions", () => {
    const changed = changedPromptClassifier(report("old", "new prompt"));
    const unchanged = changedPromptClassifier(report("let x = 1;", "let x = 2;", "src/x.ts"));
    expect(changed({ ...call("new prompt", false), headers: [["x-changed-prompt", "false"]] })).toBe(true);
    expect(unchanged({ ...call("new prompt", true), headers: [["x-changed-prompt", "true"]] })).toBe(false);
  });
});

describe("pinned source producer", () => {
  it("reads complete immutable blob sides in isolated read mode, then runs F4", async () => {
    source("old", "new prompt");
    const change = await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha);
    expect(change).toMatchObject({ status: "changes", coverage: "complete", counts: { prompt_file: 1 } });
    expect(git.read.mock.calls).toEqual([["/worker/repo", "read"]]);
    expect(git.bytes.mock.calls[0]![0]).toEqual(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", baseCommitSha, treeSha, "--"]);
    expect(git.bytes.mock.calls.slice(1).map((c): unknown => c[0])).toEqual([["cat-file", "blob", oldOid], ["cat-file", "blob", newOid]]);
  });
  it("makes the production classifier false for a known unrelated change and removes the context afterward", async () => {
    source("export const count = 1;", "export const count = 2;", "src/count.ts");
    expect(evalChangedPrompt(call())).toBe(true);
    expect(await withEvalChangedPromptClassifier(repositories, candidates, signal(), planned(), async () => evalChangedPrompt(call()))).toBe(false);
    expect(evalChangedPrompt(call())).toBe(true);
  });
  it("changed source produces a positive and concurrent/nested check contexts do not share classifications", async () => {
    source("let x = 1;", "let x = 2;", "src/x.ts");
    await withEvalChangedPromptClassifier(repositories, candidates, signal(), planned(), async () => {
      expect(evalChangedPrompt(call())).toBe(false);
      await withEvalChangedPromptClassifier([], [], signal(), planned(), async () => { expect(evalChangedPrompt(call())).toBe(true); });
      expect(evalChangedPrompt(call())).toBe(false);
      const parallel = withEvalChangedPromptClassifier([], [], signal(), planned(), async () => {
        await new Promise(resolve => setTimeout(resolve, 0)); return evalChangedPrompt(call());
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(evalChangedPrompt(call())).toBe(false); expect(await parallel).toBe(true);
    });
    source("old", "new prompt");
    expect(await withEvalChangedPromptClassifier(repositories, candidates, signal(), planned(), async () => evalChangedPrompt(call()))).toBe(true);
  });
  it.each(["120000", "160000"])("treats non-regular mode %s as unknown without reading its content", async mode => {
    source("old", "new", "app.ts", mode);
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toBeUndefined();
    expect(git.text).not.toHaveBeenCalled();
  });
  it("fails closed on unreadable source, invalid UTF-8, oversized source, and malformed raw diff", async () => {
    source("old", "new"); git.bytes.mockRejectedValueOnce(new Error("unreadable"));
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toBeUndefined();
    source("old", "new"); git.bytes.mockResolvedValueOnce(Buffer.from([0xff]));
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toBeUndefined();
    source("old", "new"); git.text.mockResolvedValue("1048577");
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toBeUndefined();
    git.bytes.mockResolvedValue(Buffer.from(":invalid\0path.ts\0"));
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toBeUndefined();
  });
  it("refuses missing/mismatched bases, duplicate identities and cancellation before Git", async () => {
    const stop = new AbortController(); stop.abort();
    expect(await candidatePromptChanges(repositories, [{ ...candidates[0]!, baseCommitSha: treeSha }], signal(), baseCommitSha)).toBeUndefined();
    expect(await candidatePromptChanges([{ ...repositories[0]!, baseCommitSha: undefined } as never], candidates, signal(), baseCommitSha)).toBeUndefined();
    expect(await candidatePromptChanges([...repositories, ...repositories], [...candidates, ...candidates], signal(), baseCommitSha)).toBeUndefined();
    expect(await candidatePromptChanges(repositories, candidates, stop.signal, baseCommitSha)).toBeUndefined();
    expect(git.read).not.toHaveBeenCalled();
  });
});

describe("source to final-check artifact (in-memory bridge transport)", () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/internal/model-access")) return json({ baseUrl: "https://gateway.example.test", apiKey: "test-only-token", expiresAt: Date.now() + 3_600_000 });
    if (url.endsWith("/v1/product/eval/hold")) {
      const asked = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { calls: number; costMicros: number }; return json({ scope: "0f8fad5b-d9cb-469f-a165-70867728950e", calls: asked.calls, costMicros: asked.costMicros });
    }
    if (url.endsWith("/v1/product/eval/release")) return json({ released: 0 });
    if (!url.includes("/v1/product/gemini/")) throw new Error("unexpected route");
    return new Response([
      { kind: "head", status: 200, headers: [["content-type", "application/json"]] },
      { kind: "chunk", b64: Buffer.from('{"ok":true}').toString("base64") },
      { kind: "settle", status: 200, class: "ok", costMicros: 10, estimated: false },
    ].map(line => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;

  it.each([
    ["changed prompt ignores a false sandbox claim", "prompts/system.txt", call("new prompt", false), true],
    ["unrelated code ignores a true sandbox claim", "src/count.ts", call("new prompt", true), false],
    ["unknown file kind", "source.unsupported", call(), true],
    ["unmappable frame", "src/count.ts", modelFrame({ unknownContents: "new prompt", changedPrompt: false }), true],
    ["unreadable diff", "unreadable", call(), true],
  ] as const)("%s", async (_name, path, modelFrame, changed) => {
    const w = await createEvalFinalCheckWorld(); let reports = 0; let calls = 0;
    source("export const count = 1;", "export const count = 2;", path);
    if (path === "unreadable") git.bytes.mockRejectedValue(new Error("unreadable"));
    try {
      const ports = evalFinalCheckForTask({ requested: true, environment: { ROVARA_EVAL_GATEWAY_URL: "https://gateway.example.test" },
        controlPlaneUrl: "https://control.example.test", capability: "test-only-operation-capability", fetch: fetchImpl,
        sources: { plan: (...args: Parameters<typeof w.ports.plan>) => w.ports.plan(...args), approval: w.ports.approval, cache: w.ports.cache, baselines: w.ports.baselines, runDir: w.root, modelAllowed: () => true,
          sandbox: { available: () => true, run: async input => {
            for (let n = 0; n < input.ids.length * input.runs; n++) { calls++; await bridge.send!(modelFrame); }
            const file = `report-${++reports}.json`;
            await writeFile(join(w.root, file), JSON.stringify({ schemaVersion: 1, eval_set_hash: w.plan.evalSetHash,
              measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }],
              questions: input.ids.map(id => ({ id, samples: Array.from({ length: input.runs }, () => ({ pass: true, answer: "answer" })) })) }));
            return { report: { root: w.root, cwd: ".", argument: file, notBeforeMs: Date.now() - 1000 }, changedPromptCalls: changed ? 0 : 999,
              ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: w.plan.key.baseCommit }) } : {}) };
          } },
        },
      });
      expect(ports).toBeDefined();
      const artifact = await withEvalChangedPromptClassifier(repositories, candidates, signal(), () => w.ports.plan(), () => runFinalCheckEval(
        { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 }, ports,
        { status: "verified", candidateDigest: "f".repeat(64), signal: signal() },
      ));
      expect(calls).toBeGreaterThan(0);
      expect(artifact?.options?.changedPromptCalls).toBe(changed ? calls : 0);
      const result = evalResultFromArtifact(artifact);
      if (changed) expect(result.label).toBe("No regression measured (eval)");
      else expect(result).toMatchObject({ label: "Not run", notRun: { reason: "no_changed_prompt_call" } });
    } finally { await w.cleanup(); }
  });
});

/** Several changed files in one diff: each file gets its own pair of blob ids. */
function sources(files: Array<[path: string, before: string | undefined, after: string | undefined]>) {
  const blobs = new Map<string, Buffer>(); const lines: string[] = [];
  files.forEach(([path, before, after], i) => {
    const old = `${(i * 2 + 1).toString(16).padStart(2, "0")}`.repeat(20); const next = `${(i * 2 + 2).toString(16).padStart(2, "0")}`.repeat(20);
    if (before !== undefined) blobs.set(old, Buffer.from(before));
    if (after !== undefined) blobs.set(next, Buffer.from(after));
    const status = before === undefined ? "A" : after === undefined ? "D" : "M";
    lines.push(`:${before === undefined ? "000000" : "100644"} ${after === undefined ? "000000" : "100644"} ${before === undefined ? "0".repeat(40) : old} ${after === undefined ? "0".repeat(40) : next} ${status}\0${path}\0`);
  });
  git.bytes.mockImplementation(async (args: string[]) => args[0] === "diff" ? Buffer.from(lines.join("")) : blobs.get(args[2]!)!);
  git.text.mockImplementation(async (args: string[]) => String(blobs.get(args[2]!)!.length));
}

describe("the diff base is the plan's baseCommit (EVAL-WIRE-CLASSIFIER-BASE-BINDING)", () => {
  const other = "9".repeat(40);
  it("diffs from the plan's base when the repository base agrees", async () => {
    source("old", "new prompt");
    expect(await candidatePromptChanges(repositories, candidates, signal(), baseCommitSha)).toMatchObject({ status: "changes" });
    expect(git.bytes.mock.calls[0]![0] as string[]).toContain(baseCommitSha);
  });
  it.each([
    ["no plan base", undefined],
    ["a plan base that differs from the repository's base", other],
    ["a malformed plan base", "HEAD~1"],
    ["a non-string plan base", 5 as never],
  ] as Array<[string, string | undefined]>)("is unknown for %s, and Git is never read", async (_name, base) => {
    source("export const count = 1;", "export const count = 2;", "src/count.ts");
    expect(await candidatePromptChanges(repositories, candidates, signal(), base)).toBeUndefined();
    expect(git.read).not.toHaveBeenCalled();
  });
  it("counts every call as changed without a plan, with an unreadable plan, with a plan for another base, and with an invalid plan base", async () => {
    source("export const count = 1;", "export const count = 2;", "src/count.ts");
    const ask = (plan: Parameters<typeof withEvalChangedPromptClassifier>[3]) => withEvalChangedPromptClassifier(repositories, candidates, signal(), plan, async () => evalChangedPrompt(call()));
    expect(await ask(planned())).toBe(false);
    expect(await ask(undefined)).toBe(true);
    expect(await ask(async () => undefined)).toBe(true);
    expect(await ask(async () => { throw new Error("plan unavailable"); })).toBe(true);
    expect(await ask(planned("9".repeat(40)))).toBe(true);
    expect(await ask(planned("not-a-commit"))).toBe(true);
    expect(await ask(async () => ({}) as never)).toBe(true);
  });
});

describe("a change F4 cannot see is unknown (EVAL-PROMPT-DETECT-RUNTIME-LOADED)", () => {
  const read = (files: Parameters<typeof sources>[0]) => { sources(files); return candidatePromptChanges(repositories, candidates, signal(), baseCommitSha); };
  it.each([
    ["a runtime-loaded text file with no prompt in its name", [["assets/persona.txt", "You are terse.\n", "You are verbose.\n"]]],
    ["a runtime-loaded markdown file", [["docs/persona.md", "Be terse.\n", "Be verbose.\n"]]],
    ["a runtime-loaded added file", [["assets/persona.txt", undefined, "You are verbose.\n"]]],
    ["a runtime-loaded removed file", [["assets/persona.txt", "You are terse.\n", undefined]]],
    ["a text file that F4 does not read next to a recognised prompt file", [["prompts/system.txt", "old", "new prompt"], ["assets/persona.txt", "a b", "c d"]]],
    ["a prose string constant in code with no AI import", [["src/text.ts", "export const greeting = 'Be terse.';\n", "export const greeting = 'Be very terse.';\n"]]],
    ["a prose string constant added to code", [["src/text.ts", "export const x = 1;\n", "export const x = 'Be very terse.';\n"]]],
    ["a changed Python docstring", [["app/text.py", 'def f():\n    """Be terse."""\n', 'def f():\n    """Be verbose."""\n']]],
    ["a changed template literal that spans lines", [["src/text.ts", "export const t = `a\nb c`;\n", "export const t = `a\nb d`;\n"]]],
  ] as Array<[string, Parameters<typeof sources>[0]]>)("%s reads unknown, so every call counts as changed", async (_name, files) => {
    expect(await read(files)).toBeUndefined();
  });
  it("still reads none_found for code that changes no prose string", async () => {
    expect(await read([["src/count.ts", "import a from './a.js';\nexport const count = 1;\n", "import a from './b.js';\nexport const count = 2;\n"]])).toMatchObject({ status: "none_found" });
    expect(await read([["src/same.ts", "const s = 'same words';\nconst n = 1;\n", "const s = 'same words';\nconst n = 2;\n"]])).toMatchObject({ status: "none_found" });
  });
  it("a file F4 found and diffed is accounted for", async () => {
    expect(await read([["prompts/system.txt", "old", "new prompt"]])).toMatchObject({ status: "changes" });
  });
  it.each(["'\"", "\\\"", "\\`", "\"\"\"x\\\"", "`'"])("scans a 1 MiB file of hostile quote runs %j in bounded time", async unit => {
    const hostile = unit.repeat(Math.ceil(1024 * 1024 / unit.length));
    const started = Date.now();
    await read([["src/hostile.ts", hostile, `${hostile}x`]]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it.each([
    ["a stray quote earlier on the line", "const re = /\"/.test(s) ? \"You are A\" : \"You are B\";\n", "const re = /\"/.test(s) ? \"You are A\" : \"You are C\";\n"],
    ["a single-word literal", "const s = \"Summarize.\";\n", "const s = \"Explain.\";\n"],
    ["an escaped multi-word literal", "const s = \"Line one.\\nLine two\";\n", "const s = \"Line one.\\nLine 2\";\n"],
    ["a selector for an unchanged table", "const persona = \"terse\";\n", "const persona = \"verbose\";\n"],
    ["a changed load path", "const t = readFile(\"assets/a.txt\");\n", "const t = readFile(\"assets/b.txt\");\n"],
    ["an indented line inside a template literal", "const t = `\n  be terse\n`;\n", "const t = `\n  be verbose\n`;\n"],
  ])("code with %s reads unknown", async (_name, before, after) => {
    expect(await read([["src/x.ts", before, after]])).toBeUndefined();
  });
  it("the production classifier counts every readable call as changed when coverage is unknown", async () => {
    sources([["assets/persona.txt", "You are terse.\n", "You are verbose.\n"]]);
    expect(await withEvalChangedPromptClassifier(repositories, candidates, signal(), planned(), async () => evalChangedPrompt(call()))).toBe(true);
  });
});
