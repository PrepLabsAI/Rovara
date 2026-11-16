// EVAL-TRIGGER-NARROW (owner 2026-11-16): only a change to an AI-related file counts every model call as changed (and so runs the
// customer-paid eval). Real git repositories, so the tree listing and the batch read are the production ones. A missed prompt change is the risk:
// each fixture proves the direct, transitive and asset paths count, an unrelated typo does not, and every unresolvable case reads unknown.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AI_WALK_LIMITS, aiRelatedSet, type AiWalkLimits } from "../../packages/worker/src/verification/eval-ai-related.js";
import { candidatePromptChanges, evalChangedPrompt, withEvalChangedPromptClassifier } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import { frame } from "../support/eval-model-access.js";
import { expectLinearScaling } from "../support/scaling.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
type Files = Record<string, string | Buffer | null>;
async function write(dir: string, files: Files) {
  for (const [p, c] of Object.entries(files)) {
    if (c === null) await rm(join(dir, p)); else { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  }
}
async function repo(base: Files, head: Files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "etn-"))); roots.push(dir);
  g(dir, "init", "-q"); await write(dir, base); g(dir, "add", "-A"); g(dir, "commit", "-qm", "base");
  const baseSha = g(dir, "rev-parse", "HEAD");
  await write(dir, head); g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty");
  return {
    repositories: [{ repositoryId: "one", directory: dir, baseCommitSha: baseSha }],
    candidates: [{ repositoryId: "one", commitSha: g(dir, "rev-parse", "HEAD"), treeSha: g(dir, "rev-parse", "HEAD^{tree}"), baseCommitSha: baseSha }],
  };
}
const sig = () => new AbortController().signal;
async function classify(base: Files, head: Files, limits?: AiWalkLimits) {
  const r = await repo(base, head);
  return candidatePromptChanges(r.repositories, r.candidates, sig(), r.repositories[0]!.baseCommitSha, limits);
}
/** What the eval sees: true = this call counts as a changed prompt call (the eval runs), false = it does not. */
async function evalRuns(base: Files, head: Files) {
  const r = await repo(base, head);
  const call = frame(JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }));
  return withEvalChangedPromptClassifier(r.repositories, r.candidates, sig(), async () => ({ key: { baseCommit: r.repositories[0]!.baseCommitSha } }), async () => evalChangedPrompt(call));
}

// ---- a TypeScript project ------------------------------------------------------------------------------------------------------------------
const TS: Files = {
  "package.json": JSON.stringify({ name: "shop-bot", dependencies: { openai: "^4.0.0", zod: "^3.0.0" } }),
  "tsconfig.json": "{\n  // the app's alias\n  \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@lib/*\": [\"src/lib/*\"] }, },\n}\n",
  "src/llm.ts": [
    "import OpenAI from \"openai\";", "import { readFileSync } from \"node:fs\";", "import { join } from \"node:path\";",
    "const persona = readFileSync(join(__dirname, \"assets/persona.txt\"), \"utf8\");",
    "export async function ask(system: string, question: string) {",
    "  return new OpenAI().chat.completions.create({ model: \"gpt-4o\", messages: [{ role: \"system\", content: persona + system }, { role: \"user\", content: question }] });",
    "}", "",
  ].join("\n"),
  "src/assets/persona.txt": "You are a calm shop assistant.\n",
  "src/support/handler.ts": "import { ask } from \"../llm.js\";\nimport { SUPPORT_RULES } from \"./rules.js\";\nexport const handle = (q: string) => ask(SUPPORT_RULES, q);\n",
  "src/support/rules.ts": "import { tone } from \"@lib/tone\";\nexport const SUPPORT_RULES = `Answer from the order history. ${tone}`;\n",
  "src/lib/tone.ts": "export const tone = \"Keep it short.\";\n",
  "src/billing/errors.ts": "export const NOT_FOUND = \"Invoice not foud\";\n",
  "src/billing/invoice.ts": "import { z } from \"zod\";\nimport { NOT_FOUND } from \"./errors.js\";\nexport const invoice = (id: unknown) => z.string().parse(id) || NOT_FOUND;\n",
  "src/server.ts": "import { handle } from \"./support/handler.js\";\nimport { invoice } from \"./billing/invoice.js\";\nexport { handle, invoice };\n",
  "README.md": "# Shop bot\nUses OpenAI.\n",
};
const typoTs: Files = { "src/billing/errors.ts": "export const NOT_FOUND = \"Invoice not found\";\n" };

describe("TypeScript project: only AI-related changes count", () => {
  it("a typo in an unrelated error message runs NO eval", async () => {
    expect(await classify(TS, typoTs)).toMatchObject({ status: "none_found", coverage: "complete" });
    expect(await evalRuns(TS, typoTs)).toBe(false);
  });
  it("docs, unrelated code and an unrelated added file run no eval", async () => {
    expect(await classify(TS, { "README.md": "# Shop bot\nUses OpenAI models.\n", "src/billing/new.ts": "export const late = 30;\n", "src/server.ts": `${TS["src/server.ts"] as string}// tidy\n` })).toMatchObject({ status: "none_found" });
  });
  it.each([
    ["the SDK-calling file", { "src/llm.ts": (TS["src/llm.ts"] as string).replace("gpt-4o", "gpt-4o-mini") }],
    ["a caller of the model-call module", { "src/support/handler.ts": (TS["src/support/handler.ts"] as string).replace("(q: string)", "(q: string, _x = 1)") }],
    ["a file the caller imports (the prompt text)", { "src/support/rules.ts": (TS["src/support/rules.ts"] as string).replace("order history", "order history only") }],
    ["a file imported two hops away through a tsconfig alias", { "src/lib/tone.ts": "export const tone = \"Keep it very short.\";\n" }],
    ["an asset the SDK file reads", { "src/assets/persona.txt": "You are a cheerful shop assistant.\n" }],
    ["a removed asset", { "src/assets/persona.txt": null }],
    ["a dependency manifest", { "package.json": JSON.stringify({ name: "shop-bot", dependencies: { openai: "^5.0.0", zod: "^3.0.0" } }) }],
    ["a tsconfig alias", { "tsconfig.json": "{ \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@lib/*\": [\"src/lib2/*\"] } } }\n" }],
    ["an unrelated file that starts calling an SDK", { "src/billing/errors.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nexport const NOT_FOUND = \"Invoice not found\";\n" }],
    ["an unrelated file that stops calling an SDK", { "src/llm.ts": null, "src/support/handler.ts": "export const handle = (q: string) => q;\n" }],
  ] as Array<[string, Files]>)("a change in %s runs the eval", async (_name, head) => {
    expect(await classify(TS, head)).toBeUndefined();
    expect(await evalRuns(TS, head)).toBe(true);
  });
  it("F4 still counts a model name changed in a file no AI file names", async () => {
    const base = { ...TS, "config/deploy.yaml": "model: gpt-4o\n" };
    expect(await classify(base, { "config/deploy.yaml": "model: gpt-4o-mini\n" })).toMatchObject({ status: "changes" });
    expect(await evalRuns(base, { "config/deploy.yaml": "model: gpt-4o-mini\n" })).toBe(true);
  });
  it("a dynamic import in an AI-related file counts as changed, even for an unrelated typo", async () => {
    const base = { ...TS, "src/support/handler.ts": `${TS["src/support/handler.ts"] as string}export const plugin = (name: string) => import(\`./plugins/\${name}.js\`);\n` };
    expect(await classify(base, typoTs)).toBeUndefined();
    const req = { ...TS, "src/llm.ts": `${TS["src/llm.ts"] as string}export const load = (p: string) => require(p);\n` };
    expect(await classify(req, typoTs)).toBeUndefined();
  });
  it("a literal dynamic import is followed, not refused", async () => {
    const base = { ...TS, "src/support/handler.ts": `${TS["src/support/handler.ts"] as string}export const lazy = () => import("./lazy.js");\n`, "src/support/lazy.ts": "export const L = \"lazy text\";\n" };
    expect(await classify(base, typoTs)).toMatchObject({ status: "none_found" });
    expect(await classify(base, { "src/support/lazy.ts": "export const L = \"lazier text\";\n" })).toBeUndefined();
  });
  it("a changed unrelated file that adds a non-literal dynamic import counts as changed", async () => {
    expect(await classify(TS, { "src/billing/errors.ts": "export const NOT_FOUND = \"Invoice not found\";\nexport const load = (m: string) => import(m);\n" })).toBeUndefined();
  });
  it("a parse failure counts as changed: an AI-related file that is not UTF-8, and any unreadable code file", async () => {
    expect(await classify({ ...TS, "src/lib/tone.ts": Buffer.from([0x65, 0xff, 0x0a]) }, typoTs)).toBeUndefined();
    expect(await classify({ ...TS, "src/billing/blob.ts": Buffer.from([0x61, 0x00, 0x62]) }, typoTs)).toBeUndefined();
  });
  it("an import the walk cannot follow counts as changed", async () => {
    expect(await classify({ ...TS, "src/support/rules.ts": "import { x } from \"./missing.js\";\nexport const SUPPORT_RULES = x;\n" }, typoTs)).toBeUndefined();
    expect(await classify({ ...TS, "src/support/rules.ts": "import { x } from \"@/unmapped/thing\";\nexport const SUPPORT_RULES = x;\n" }, typoTs)).toBeUndefined();
    expect(await classify({ ...TS, "src/support/rules.ts": "import { x } from \"undeclared-pkg\";\nexport const SUPPORT_RULES = x;\n" }, typoTs)).toBeUndefined();
    // An unmapped alias anywhere could hide a caller.
    expect(await classify({ ...TS, "src/billing/invoice.ts": "import { ask } from \"@/llm\";\nexport const invoice = ask;\n" }, typoTs)).toBeUndefined();
  });
  it("an over-budget walk counts as changed", async () => {
    expect(await classify(TS, typoTs, { ...AI_WALK_LIMITS, edges: 10 })).toBeUndefined();
    expect(await classify(TS, typoTs, { ...AI_WALK_LIMITS, treeEntries: 5 })).toBeUndefined();
    expect(await classify(TS, typoTs, { ...AI_WALK_LIMITS, totalBytes: 100 })).toBeUndefined();
    expect(await classify(TS, typoTs, { ...AI_WALK_LIMITS, fileBytes: 50 })).toBeUndefined();
    expect(await classify(TS, typoTs)).toMatchObject({ status: "none_found" });
  });
  it("a workspace package and a barrel re-export make their importers callers", async () => {
    const base: Files = {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
      "packages/ai/package.json": JSON.stringify({ name: "@mono/ai", dependencies: { "@google/genai": "1.0.0" } }),
      "packages/ai/src/gemini.ts": "import { GoogleGenAI } from \"@google/genai\";\nexport const run = (p: string) => new GoogleGenAI({}).models.generateContent({ model: \"gemini-2.5-flash\", contents: p });\n",
      "packages/ai/src/index.ts": "export * from \"./gemini.js\";\n",
      "packages/app/package.json": JSON.stringify({ name: "@mono/app", dependencies: { "@mono/ai": "*" } }),
      "packages/app/src/summarize.ts": "import { run } from \"@mono/ai\";\nimport { STYLE } from \"./style.js\";\nexport const summarize = (t: string) => run(STYLE + t);\n",
      "packages/app/src/style.ts": "export const STYLE = \"Summarize in two lines. \";\n",
      "packages/app/src/errors.ts": "export const E = \"Somthing failed\";\n",
    };
    expect(await classify(base, { "packages/app/src/style.ts": "export const STYLE = \"Summarize in one line. \";\n" })).toBeUndefined();
    expect(await classify(base, { "packages/app/src/errors.ts": "export const E = \"Something failed\";\n" })).toMatchObject({ status: "none_found" });
  });
});

// ---- a Python project ----------------------------------------------------------------------------------------------------------------------
const PY: Files = {
  "pyproject.toml": "[project]\nname = \"helpdesk\"\ndependencies = [\"anthropic\"]\n",
  "app/__init__.py": "",
  "app/llm.py": [
    "import anthropic", "from pathlib import Path", "from .prompts import SYSTEM", "",
    "TEMPLATE = (Path(__file__).parent / \"templates/answer.md\").read_text()", "",
    "def answer(question):",
    "    return anthropic.Anthropic().messages.create(model=\"claude-sonnet-4-5\", max_tokens=500, system=SYSTEM, messages=[{\"role\": \"user\", \"content\": TEMPLATE.format(q=question)}])", "",
  ].join("\n"),
  "app/prompts.py": "from app.style import (\n    STYLE,\n)\n\nSYSTEM = \"You answer helpdesk tickets. \" + STYLE\n",
  "app/style.py": "STYLE = \"Be brief.\"\n",
  "app/templates/answer.md": "Question: {q}\n",
  "app/views.py": "from app.llm import answer\n\ndef ticket(q):\n    return answer(q)\n",
  "app/errors.py": "NOT_FOUND = \"Ticket not foud\"\n",
  "app/billing.py": "from app.errors import NOT_FOUND\n\ndef bill(x):\n    return x or NOT_FOUND\n",
  "main.py": "from app.views import ticket\nfrom app.billing import bill\n",
};
const typoPy: Files = { "app/errors.py": "NOT_FOUND = \"Ticket not found\"\n" };

describe("Python project: only AI-related changes count", () => {
  it("a typo in an unrelated error message runs NO eval", async () => {
    expect(await classify(PY, typoPy)).toMatchObject({ status: "none_found", coverage: "complete" });
    expect(await evalRuns(PY, typoPy)).toBe(false);
  });
  it.each([
    ["the SDK-calling file", { "app/llm.py": (PY["app/llm.py"] as string).replace("500", "800") }],
    ["the prompt module it imports", { "app/prompts.py": (PY["app/prompts.py"] as string).replace("helpdesk", "support") }],
    ["a module imported two hops away", { "app/style.py": "STYLE = \"Be very brief.\"\n" }],
    ["a template it reads", { "app/templates/answer.md": "Ticket question: {q}\n" }],
    ["a caller of the model-call module", { "app/views.py": `${PY["app/views.py"] as string}\n# note\n` }],
    ["the dependency list", { "pyproject.toml": "[project]\nname = \"helpdesk\"\ndependencies = [\"anthropic>=0.40\"]\n" }],
  ] as Array<[string, Files]>)("a change in %s runs the eval", async (_name, head) => {
    expect(await classify(PY, head)).toBeUndefined();
    expect(await evalRuns(PY, head)).toBe(true);
  });
  it("a dynamic import in an AI-related module counts as changed", async () => {
    expect(await classify({ ...PY, "app/prompts.py": `import importlib\n${PY["app/prompts.py"] as string}EXTRA = importlib.import_module("app.extra_" + STYLE)\n` }, typoPy)).toBeUndefined();
    // A literal module name is followed instead.
    const literal = { ...PY, "app/prompts.py": `import importlib\n${PY["app/prompts.py"] as string}EXTRA = importlib.import_module("app.extra")\n`, "app/extra.py": "X = \"x\"\n" };
    expect(await classify(literal, typoPy)).toMatchObject({ status: "none_found" });
    expect(await classify(literal, { "app/extra.py": "X = \"y\"\n" })).toBeUndefined();
  });
  it("a parse failure counts as changed: an unclosed import list in an AI-related module", async () => {
    expect(await classify({ ...PY, "app/prompts.py": "from app.style import (\n    STYLE,\n\nSYSTEM = 1\n" }, typoPy)).toBeUndefined();
  });
  it("a relative import of a missing module in an AI-related file counts as changed", async () => {
    expect(await classify({ ...PY, "app/prompts.py": "from .gone import STYLE\nSYSTEM = STYLE\n" }, typoPy)).toBeUndefined();
  });
  it("an over-budget walk counts as changed", async () => {
    expect(await classify(PY, typoPy, { ...AI_WALK_LIMITS, edges: 5 })).toBeUndefined();
  });
  it("Bedrock through boto3 is an SDK call", async () => {
    const base = { ...PY, "app/bedrock.py": "import boto3\nfrom app.errors import NOT_FOUND\nclient = boto3.client(\"bedrock-runtime\")\n" };
    expect(await classify(base, typoPy)).toBeUndefined();
  });
});

// ---- the pure walk: bounded and linear ------------------------------------------------------------------------------------------------------
describe("aiRelatedSet", () => {
  const DEPS = "{\"dependencies\":{\"openai\":\"1\",\"x\":\"1\"}}";
  const snapshot = (files: Record<string, string>, removed: string[] = []) => ({ paths: Object.keys(files), removed, text: new Map(Object.entries(files)) });
  it("a removed import target is a member, so its removal is seen", () => {
    const set = aiRelatedSet(snapshot({ "package.json": "{\"dependencies\":{\"openai\":\"1\"}}", "a.ts": "import OpenAI from 'openai';\nimport { p } from './p.js';\n" }, ["p.ts"]));
    expect(set.known && set.has("p.ts")).toBe(true);
  });
  it("a code file the caller did not hand over is unknown", () => {
    expect(aiRelatedSet({ paths: ["a.ts"], removed: [], text: new Map() }).known).toBe(false);
  });
  it("a long import chain is followed to its end", () => {
    const files: Record<string, string> = { "package.json": DEPS, "m0.ts": "import 'openai';\nimport './m1.js';\n" };
    for (let i = 1; i < 300; i++) files[`m${i}.ts`] = `import './m${i + 1}.js';\n`;
    files["m300.ts"] = "export const P = 'deep prompt';\n";
    const set = aiRelatedSet(snapshot(files));
    expect(set.known).toBe(true);
    expect(set.known && set.has("m300.ts")).toBe(true);
  });
  it("scales linearly in the number of files", () => {
    expectLinearScaling(n => {
      const files: Record<string, string> = { "package.json": DEPS, "m0.ts": "import 'openai';\nimport './d1/m1.js';\n" };
      for (let i = 1; i < n; i++) files[`d${i % 7}/m${i}.ts`] = `${i + 1 < n ? `import '../d${(i + 1) % 7}/m${i + 1}.js';` : ""}\nconst s = "assets/a${i}.txt";\n`;
      const snap = snapshot(files);
      expect(aiRelatedSet(snap).known).toBe(true);
      return () => aiRelatedSet(snap);
    }, { n: 400, unitBytes: 70, label: "ai walk files" });
  });
  it("scales linearly in hostile text inside an AI-related file", () => {
    expectLinearScaling(n => {
      const hostile = "from '\"`import(require(\"x".repeat(Math.ceil(n / 26)).slice(0, n);
      const snap = snapshot({ "package.json": DEPS, "a.ts": `import 'openai';\n${hostile}` });
      return () => aiRelatedSet(snap);
    }, { n: 16_384, label: "ai walk hostile" });
  });
});
