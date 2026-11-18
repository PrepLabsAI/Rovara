// L4-EVP: the setup agent PROPOSES prompt locations, a maintainer confirms them with the setup candidate, and they are stored with the setup revision. Reader rules, the candidate, the risk and who approves it, and isolation between projects.
import { describe, expect, it } from "vitest";
import { ProjectDefinitionSchema, sanitizeSetupProposal, setupItemHandling, setupItemRisk, setupItemsOf, workerProjectDefinition, type PromptLocation, type SetupProposal, type SetupVerification } from "@agentx/contracts";
import { promptLocationsFromProposal, setupApplyDigest } from "../../packages/broker/src/core/setup-agent/apply.js";
import { classifySetupChange, setupApproverAllows } from "../../packages/broker/src/core/setup-agent/setup-risk.js";
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
  it("a person's choice may add one that could not be checked (listed as unchecked), never one that failed", () => {
    const made = promptLocationsFromProposal(proposal, verdicts({ [ids[0]!]: "unchecked", [ids[1]!]: "unverified" }), definition, new Set(ids));
    expect(made.used).toEqual([ids[0]]);
    expect(made.unchecked).toEqual([ids[0]]);
    expect(made.left).toEqual([{ id: ids[1], reason: "unverified" }]);
  });
  it("only the chosen ids, and a repository the project does not have is left out", () => {
    expect(promptLocationsFromProposal(proposal, verdicts(), definition, new Set([ids[1]!])).used).toEqual([ids[1]]);
    expect(promptLocationsFromProposal(proposal, verdicts(), { repositories: [{ name: "web" }] }).left).toEqual([{ id: ids[0], reason: "unverified" }]);
  });
  it("adds to the locations the project already has (an agent's proposal never removes one), once", () => {
    const have: PromptLocation[] = [locationOf(ids[0]!), { repo: "app", path: "keep.py", kind: "file" }];
    const made = promptLocationsFromProposal(proposal, verdicts(), { ...definition, promptLocations: have });
    expect(made.locations.map((l) => l.path)).toEqual(["deskbot/agent.py", "keep.py", "web/prompt.ts"]);
    expect(made.used).toEqual(ids);
  });
  it("refuses to take the list past its limit", () => {
    const have = Array.from({ length: 40 }, (_, index): PromptLocation => ({ repo: "app", path: `p${index}.py`, kind: "file" }));
    const made = promptLocationsFromProposal(proposal, verdicts(), { ...definition, promptLocations: have });
    expect(made.used).toEqual([]);
    expect(made.left.map((entry) => entry.reason)).toEqual(["too_many", "too_many"]);
  });
  it("is bound into what the approver approves: the digest moves with the locations and is the commands' alone without them", () => {
    const setup = [{ cwd: "repo/app", executable: "npm", args: ["ci"], timeoutSeconds: 60 }];
    expect(setupApplyDigest(setup, setup)).toBe(setupApplyDigest(setup, setup, undefined));
    expect(setupApplyDigest(setup, setup, [])).toBe(setupApplyDigest(setup, setup));
    expect(setupApplyDigest(setup, setup, [locationOf(ids[0]!)])).not.toBe(setupApplyDigest(setup, setup));
    expect(setupApplyDigest(setup, setup, [locationOf(ids[0]!)])).not.toBe(setupApplyDigest(setup, setup, [locationOf(ids[1]!)]));
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
  it("a change of the locations is MEDIUM, its own area, and a project maintainer may approve it; a member without the grant may not", () => {
    const result = classifySetupChange(base, { ...base, revision: 4, promptLocations: locations });
    expect(result).toEqual({ risk: "medium", changes: [{ area: "prompt_locations", risk: "medium" }] });
    expect(setupApproverAllows({ companyRole: "member", projectGrant: "administrator" }, result.risk, "approve")).toBe(true);
    expect(setupApproverAllows({ companyRole: "member", projectGrant: "developer" }, result.risk, "approve")).toBe(false);
    expect(setupApproverAllows({ companyRole: "member" }, result.risk, "approve")).toBe(false);
    expect(classifySetupChange({ ...base, promptLocations: locations }, { ...base, revision: 4 }).risk).toBe("medium");
    expect(classifySetupChange({ ...base, promptLocations: locations }, { ...base, revision: 4, promptLocations: locations }).changes).toEqual([]);
  });
  it("with another change it never LOWERS the risk (a new website beside it is still high)", () => {
    expect(classifySetupChange(base, { ...base, revision: 4, promptLocations: locations, network: { allowedDomains: ["api.stripe.com"] } }).risk).toBe("high");
  });
});
