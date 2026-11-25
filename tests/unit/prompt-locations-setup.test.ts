// L4-EVP: the setup agent PROPOSES prompt locations, a maintainer confirms them with the setup candidate, and they are stored with the setup revision. Reader rules, the candidate, the risk and who approves it, and isolation between projects.
import { describe, expect, it } from "vitest";
import { ProjectDefinitionSchema, sanitizeSetupProposal, setupItemHandling, setupItemRisk, setupItemsOf, workerProjectDefinition, type PromptLocation, type SetupProposal, type SetupVerification } from "@agentx/contracts";
import { SETUP_CONFIRM_WORDS, chooseCandidateItems, promptLocationsFromProposal } from "../../packages/broker/src/core/setup-agent/apply.js";
import { setupProposalFormatLines } from "../../packages/worker/src/setup-draft.js";

const COMMIT = "a".repeat(40);
const context = { basedOnRevision: 1, repositories: [{ name: "app", commit: COMMIT }, { name: "web", commit: COMMIT }] };
const cite = (path = "deskbot/agent.py", repo = "app") => [{ kind: "file", repo, path, commit: COMMIT, line: 12, quote: 'SYSTEM_PROMPT = """You are Deskbot.' }];
const SETUP = { setup: [{ repo: "app", commands: ["pip install -e ."], from: [{ kind: "file", repo: "app", path: "pyproject.toml", commit: COMMIT, line: 1, quote: "pip install -e ." }] }] };
const read = (answer: unknown): SetupProposal => {
  const result = sanitizeSetupProposal(answer, context);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.proposal;
};
const ONE = { repo: "app", path: "deskbot/agent.py", kind: "variable", symbol: "SYSTEM_PROMPT", from: cite() };

describe("the setup agent proposes prompt locations", () => {
  it("each is one item with its place, handled as a setting and safe to show; ids start with prompt-", () => {
    const proposal = read({ ...SETUP, promptLocations: [ONE, { repo: "app", path: "config/agents.yaml", kind: "yaml_key", symbol: "support.system_prompt", from: cite("config/agents.yaml") }, { repo: "app", path: "deskbot/persona.py", kind: "file", from: cite("deskbot/persona.py") }] });
    expect(proposal.promptLocations!.map((item) => item.value)).toEqual([
      { repo: "app", path: "deskbot/agent.py", kind: "variable", symbol: "SYSTEM_PROMPT" },
      { repo: "app", path: "config/agents.yaml", kind: "yaml_key", symbol: "support.system_prompt" },
      { repo: "app", path: "deskbot/persona.py", kind: "file" },
    ]);
    expect(proposal.promptLocations!.every((item) => item.id.startsWith("prompt-") && item.from.length === 1)).toBe(true);
    expect(setupItemsOf(proposal).filter((item) => item.kind === "prompt_location")).toHaveLength(3);
    expect(setupItemHandling("prompt_location", proposal.promptLocations![0]!.value)).toBe("settings");
    expect(setupItemRisk("prompt_location", proposal.promptLocations![0]!.value)).toBe("safe");
  });
  it("the same location named twice is one item with both places", () => {
    const proposal = read({ ...SETUP, promptLocations: [ONE, { ...ONE, from: [{ ...cite()[0]!, line: 30, quote: "return SYSTEM_PROMPT" }] }] });
    expect(proposal.promptLocations).toHaveLength(1);
    expect(proposal.promptLocations![0]!.from).toHaveLength(2);
  });
  it("leaves out an item with no place, a place in another file, an unknown repository, a bad kind or symbol, a .git path and an item that only came from a README", () => {
    const proposal = read({ ...SETUP, promptLocations: [
      ONE,
      { ...ONE, symbol: "OTHER", from: undefined },
      { ...ONE, symbol: "ELSEWHERE", from: cite("deskbot/other.py") },
      { ...ONE, symbol: "NOREPO", repo: "nope", from: cite("deskbot/agent.py", "nope") },
      { ...ONE, kind: "class" }, { ...ONE, symbol: "not a name" }, { ...ONE, kind: "function", symbol: undefined }, { ...ONE, kind: "file" },
      { ...ONE, path: ".git/config", symbol: "X", from: cite(".git/config") },
      { ...ONE, symbol: "INFERRED", from: [{ kind: "inferred", note: "looks like a prompt" }] },
    ] });
    expect(proposal.promptLocations!.map((item) => item.value.symbol)).toEqual(["SYSTEM_PROMPT"]);
    expect(proposal.notes).toMatch(/left out/u);
  });
  it("is cut at the limit and leaves a proposal with none exactly as it read before (golden)", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ repo: "app", path: `deskbot/p${index}.py`, kind: "file", from: cite(`deskbot/p${index}.py`) }));
    expect(read({ ...SETUP, promptLocations: many }).promptLocations).toHaveLength(40);
    const without = read(SETUP);
    expect(without).not.toHaveProperty("promptLocations");
    expect(read({ ...SETUP, promptLocations: [] })).toEqual(without);
    expect(read({ ...SETUP, promptLocations: "agent.py" })).toEqual(without);
  });
  it("is read again to the same proposal (the broker reads the worker's copy)", () => {
    const once = read({ ...SETUP, promptLocations: [ONE] });
    expect(sanitizeSetupProposal(JSON.parse(JSON.stringify(once)) as unknown, context)).toEqual({ ok: true, proposal: once });
  });
  it("a proposal of only locations is a proposal (it has something a person can use)", () => {
    expect(read({ promptLocations: [ONE] }).promptLocations).toHaveLength(1);
  });
  it("the agent is told about it, and told to cite the same file", () => {
    const words = setupProposalFormatLines(undefined).join("\n");
    expect(words).toContain("promptLocations");
    expect(words).toContain("cite a line in that same file");
  });
});

describe("the candidate takes the confirmed locations", () => {
  const definition = { repositories: [{ name: "app" }, { name: "web" }], promptLocations: undefined as unknown };
  const proposal = read({ ...SETUP, promptLocations: [ONE, { repo: "web", path: "web/prompt.ts", kind: "file", from: cite("web/prompt.ts", "web") }] });
  const ids = proposal.promptLocations!.map((item) => item.id);
  const verdicts = (over: Record<string, SetupVerification> = {}): Record<string, SetupVerification> => ({ [ids[0]!]: "verified", [ids[1]!]: "verified", ...over });
  const locationOf = (id: string) => proposal.promptLocations!.find((item) => item.id === id)!.value;

  it("with no choice made, uses only what the code host confirmed", () => {
    const made = promptLocationsFromProposal(proposal, verdicts({ [ids[1]!]: "unchecked" }), definition);
    expect(made.used).toEqual([ids[0]]);
    expect(made.locations).toEqual([locationOf(ids[0]!)]);
    expect(made.left).toEqual([]);
  });
  it("only the chosen ids, and a repository the project does not have is left out", () => {
    expect(promptLocationsFromProposal(proposal, verdicts(), definition, new Set([ids[1]!])).used).toEqual([ids[1]]);
    expect(promptLocationsFromProposal(proposal, verdicts(), { repositories: [{ name: "web" }] }).left).toEqual([{ id: ids[0], reason: "unverified" }]);
  });
  it("adds to the locations the project already has (an agent's proposal never removes one), once", () => {
    const have: PromptLocation[] = [locationOf(ids[0]!), { repo: "app", path: "keep.py", kind: "file" }];
    const made = promptLocationsFromProposal(proposal, verdicts(), { ...definition, promptLocations: have });
    expect(made.locations.map((l) => l.path)).toEqual(["deskbot/agent.py", "keep.py", "web/prompt.ts"]);
    // The one the project already held adds nothing, so it is not "used".
    expect(made.used).toEqual([ids[1]]);
  });
  it("refuses to take the list past its limit", () => {
    const have = Array.from({ length: 40 }, (_, index): PromptLocation => ({ repo: "app", path: `p${index}.py`, kind: "file" }));
    const made = promptLocationsFromProposal(proposal, verdicts(), { ...definition, promptLocations: have });
    expect(made.used).toEqual([]);
    expect(made.left.map((entry) => entry.reason)).toEqual(["too_many", "too_many"]);
  });
});

describe("what a confirm takes (chooseCandidateItems: the item ids a person may choose)", () => {
  const withSetup = read({ ...SETUP, promptLocations: [ONE] });
  const setupId = withSetup.setup[0]!.id;
  const locId = withSetup.promptLocations![0]!.id;
  const definition = { repositories: [{ name: "app", path: "repo/app" }], promptLocations: undefined as unknown };
  const all: Record<string, SetupVerification> = { [setupId]: "verified", [locId]: "verified" };
  const refused = (verdicts: Record<string, SetupVerification>, itemIds: string[] | undefined, def: typeof definition = definition) => () => chooseCandidateItems(withSetup, verdicts, def, itemIds);

  // DEC 254zzz495 (N3): an empty setup can always be used, so the person's explicit empty choice is no longer refused; it takes nothing and changes no command.
  it("an empty choice is the empty setup: nothing taken, nothing refused", () => {
    const empty = chooseCandidateItems(withSetup, all, definition, []);
    expect(empty.made).toEqual({ used: [], unchecked: [], left: [] });
    expect(empty.locations.used).toEqual([]);
  });
  it("an unknown id is refused, alone or beside a location id", () => {
    expect(refused(all, ["nope"])).toThrow(SETUP_CONFIRM_WORDS.unknownItem);
    expect(refused(all, [locId, "nope"])).toThrow(SETUP_CONFIRM_WORDS.unknownItem);
  });
  it("a location that failed its re-read, alone, is refused; with an unchecked one chosen by hand it is allowed", () => {
    expect(refused({ ...all, [locId]: "unverified" }, [locId])).toThrow(SETUP_CONFIRM_WORDS.nothing);
    expect(chooseCandidateItems(withSetup, { ...all, [locId]: "unchecked" }, definition, [locId]).locations.unchecked).toEqual([locId]);
  });
});

describe("the stored setting, its risk and who approves it", () => {
  const base = {
    name: "payments", revision: 3, orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "app", url: "https://github.com/example/app.git", path: "repo/app", defaultBranch: "main", credentialRef: "host-app" }],
    setup: [{ cwd: "repo/app", executable: "npm", args: ["ci"], timeoutSeconds: 600 }], readiness: [{ cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 600 }],
  };
  const locations: PromptLocation[] = [{ repo: "app", path: "deskbot/agent.py", kind: "variable", symbol: "SYSTEM_PROMPT" }];

  it("is part of the project definition, stays out of what a worker is sent, and a bad one does not store", () => {
    expect(ProjectDefinitionSchema.safeParse({ ...base, promptLocations: locations }).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse({ ...base, promptLocations: [{ repo: "app", path: "x.py", kind: "function" }] }).success).toBe(false);
    expect(workerProjectDefinition({ ...base, promptLocations: locations })).not.toHaveProperty("promptLocations");
  });
});
