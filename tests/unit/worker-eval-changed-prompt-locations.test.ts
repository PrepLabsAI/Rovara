// L4-EVP: the eval's changed-prompt classifier treats a diff that touches a prompt location the project confirmed as a changed prompt (region level where the region can be read whole, file level otherwise), over real git.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptLocation } from "@agentx/contracts";
import { candidatePromptChanges, evalChangedPrompt, withEvalChangedPromptClassifier } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import { frame } from "../support/eval-model-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function repo(base: Record<string, string>, head: Record<string, string | null>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "evp-"))); roots.push(dir);
  g(dir, "init", "-q");
  // One unrelated model-call module: a repository where no model-call code is recognised at all is unknown.
  for (const [p, c] of Object.entries({ "llm.py": "import openai\n", ...base })) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); const baseSha = g(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(head)) { if (c === null) await rm(join(dir, p)); else { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); } }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty"); const tree = g(dir, "rev-parse", "HEAD^{tree}");
  return { repositories: [{ repositoryId: "one", directory: dir, baseCommitSha: baseSha }], candidates: [{ repositoryId: "one", commitSha: g(dir, "rev-parse", "HEAD"), treeSha: tree, baseCommitSha: baseSha }], base: baseSha };
}
const sig = () => new AbortController().signal;
const classify = async (r: Awaited<ReturnType<typeof repo>>, locations: readonly PromptLocation[] = []) => (await candidatePromptChanges(r.repositories, r.candidates, sig(), r.base, undefined, locations))?.status;
const loc = (over: Partial<PromptLocation> & Pick<PromptLocation, "path" | "kind">): PromptLocation => ({ repo: "one", ...over });

const SETTINGS_PY = ['BANNER = """Welcome to the desk.', 'Be brief."""', "", "def retries():", "    return 3", ""].join("\n");
const AGENTS_YAML = ["tone: warm", "other: 1", ""].join("\n");

describe("a prompt location the project confirmed", () => {
  it("is invisible to the walk (a plain config file reads as no change), and a location makes a change to it unknown", async () => {
    const r = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("return 3", "return 4") });
    expect(await classify(r)).toBe("none_found");
    expect(await classify(r, [loc({ path: "app/settings.py", kind: "file" })])).toBeUndefined();
  });
  it("region level (Python): a change outside the region is not a touch, a change inside it is", async () => {
    const outside = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("return 3", "return 4") });
    const inside = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("Be brief.", "Be chatty.") });
    const banner = loc({ path: "app/settings.py", kind: "variable", symbol: "BANNER" });
    expect(await classify(outside, [banner])).toBe("none_found");
    expect(await classify(inside, [banner])).toBeUndefined();
  });
  it("region level (YAML): the tone key and another key", async () => {
    const other = await repo({ "config/agents.yaml": AGENTS_YAML }, { "config/agents.yaml": AGENTS_YAML.replace("other: 1", "other: 2") });
    const tone = await repo({ "config/agents.yaml": AGENTS_YAML }, { "config/agents.yaml": AGENTS_YAML.replace("warm", "cold") });
    const key = loc({ path: "config/agents.yaml", kind: "yaml_key", symbol: "tone" });
    expect(await classify(other, [key])).toBe("none_found");
    expect(await classify(tone, [key])).toBeUndefined();
  });
  it("falls back to the file when the region is gone or the language is not read, and for an added or removed file", async () => {
    const renamed = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("BANNER", "GREETING") });
    expect(await classify(renamed, [loc({ path: "app/settings.py", kind: "variable", symbol: "BANNER" })])).toBeUndefined();
    const toml = await repo({ "config/agents.toml": "tone = 'a'\nother = 1\n" }, { "config/agents.toml": "tone = 'a'\nother = 2\n" });
    expect(await classify(toml, [loc({ path: "config/agents.toml", kind: "yaml_key", symbol: "tone" })])).toBeUndefined();
    const added = await repo({}, { "app/settings.py": SETTINGS_PY });
    expect(await classify(added, [loc({ path: "app/settings.py", kind: "variable", symbol: "BANNER" })])).toBeUndefined();
    const removed = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": null });
    expect(await classify(removed, [loc({ path: "app/settings.py", kind: "file" })])).toBeUndefined();
  });
  it("does not count a location of another repository, another file, or none", async () => {
    const r = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("return 3", "return 4") });
    expect(await classify(r, [loc({ repo: "elsewhere", path: "app/settings.py", kind: "file" })])).toBe("none_found");
    expect(await classify(r, [loc({ path: "app/other.py", kind: "file" })])).toBe("none_found");
    expect(await classify(r, [])).toBe("none_found");
  });
  it("makes every call count as changed through the classifier the worker installs, and none when no location is touched", async () => {
    const call = frame(JSON.stringify({ systemInstruction: { parts: [{ text: "You are Deskbot." }] }, contents: [{ parts: [{ text: "hello" }] }] }));
    const touched = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("Be brief.", "Be chatty.") });
    const untouched = await repo({ "app/settings.py": SETTINGS_PY }, { "app/settings.py": SETTINGS_PY.replace("return 3", "return 4") });
    const banner = [loc({ path: "app/settings.py", kind: "variable" as const, symbol: "BANNER" })];
    const ask = (r: Awaited<ReturnType<typeof repo>>, locations: readonly PromptLocation[]) => withEvalChangedPromptClassifier(r.repositories, r.candidates, sig(), async () => ({ key: { baseCommit: r.base } }), async () => evalChangedPrompt(call), locations);
    expect(await ask(touched, banner)).toBe(true);
    expect(await ask(untouched, banner)).toBe(false);
    // Without the setting the same touched change reads as no changed prompt: the gap this closes.
    expect(await ask(touched, [])).toBe(false);
  });
  it("is bounded: a location file that is too large is unknown, never read as untouched", async () => {
    const big = `BANNER = "x"\n${"y = 1\n".repeat(400_000)}`;
    const r = await repo({ "app/settings.py": big }, { "app/settings.py": `${big}z = 2\n` });
    expect(await classify(r, [loc({ path: "app/settings.py", kind: "variable", symbol: "BANNER" })])).toBeUndefined();
  });
});
