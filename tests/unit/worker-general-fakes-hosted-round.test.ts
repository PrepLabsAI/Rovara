// General fakes slice 2b: a CHECKS round whose fakes run in the HOSTED fake-helper container. The launcher is a fake here (the launch itself is tests/unit/worker-general-fakes-hosted.test.ts, the real container is
// tests/linux/general-fakes-helper.test.ts); what is checked is the round's own behaviour with a helper that is read after each command: the variables the commands get, which checks are labelled, when a check is
// "Not run", what an unreadable record does (every check is marked: fail closed), and that the helper is always stopped.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERAL_FAKE_NOT_RUN_SENTENCES, type CheckEntry } from "@agentx/contracts";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { generalFakesPlanFor, withGeneralFakesRound, type GeneralFakesRoundResult, type HostedFakeCalls, type HostedFakesLauncher, type StartedHostedFakes } from "../../packages/worker/src/general-fakes-round.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const PETS = JSON.stringify({
  openapi: "3.0.3", info: { title: "pets", version: "1" },
  paths: { "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } } },
});
async function workspace(files: Record<string, string> = { "repo/openapi.json": PETS }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rovara-gf-hosted-round-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const NONE: HostedFakeCalls = { served: 0, foreign: 0, unrouted: 0, refused: 0, cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0 } };
const calls = (change: Partial<Omit<HostedFakeCalls, "cannotAnswer">> & { cannotAnswer?: Partial<HostedFakeCalls["cannotAnswer"]> } = {}): HostedFakeCalls => ({ ...NONE, ...change, cannotAnswer: { ...NONE.cannotAnswer, ...(change.cannotAnswer ?? {}) } });

interface Script { reads: (HostedFakeCalls | undefined)[]; startFails?: boolean }
function launcher(script: Script) {
  const events: string[] = [];
  const started: { fakes: unknown; variables: readonly string[] }[] = [];
  const hosted: HostedFakesLauncher = {
    async start(input) {
      started.push({ fakes: input.fakes, variables: input.variables });
      events.push("start");
      if (script.startFails === true) throw new Error("docker said something private /srv/secret");
      const helper: StartedHostedFakes = {
        environment: Object.fromEntries(input.variables.map((variable, index) => [variable, `http://172.30.5.16:8080/s/${String(index)}`])),
        async drain() { events.push("drain"); return script.reads.length === 0 ? NONE : script.reads.shift(); },
        async stop() { events.push("stop"); },
      };
      return helper;
    },
  };
  return { hosted, events, started };
}
/** Runners that record the environment of every command, and exit with the given codes. */
function recording(exitCodes: number[] = []) {
  const seen: (Record<string, string> | undefined)[] = [];
  const runners: CheckRunners = {
    async runProjectCommand(command) { seen.push(command.env); return { exitCode: exitCodes.shift() ?? 0, timedOut: false, stdout: "", stderr: "" }; },
    async runAgentCommand() { return { exitCode: 0, timedOut: false, output: "" }; },
  };
  return { runners, seen };
}
const command = () => ({ cwd: ".", executable: "x", args: [], timeoutSeconds: 30 });
const planOf = (count: number): CheckPlan => ({ source: "project", readiness: Array.from({ length: count }, command), projectBefore: Array.from({ length: count }, () => "passed" as const) });
const options = () => ({ budgetMs: 60_000, signal: new AbortController().signal });

async function round(script: Script, options_: { count?: number; exitCodes?: number[]; services?: { variable: string }[]; onResultThrows?: boolean } = {}) {
  const root = await workspace();
  const results: GeneralFakesRoundResult[] = [];
  const l = launcher(script);
  const plan = generalFakesPlanFor({ services: options_.services ?? [{ variable: "PETS_API_URL" }] }, {
    localShell: false, hosted: l.hosted, rootPath: root, repositoryPaths: [join(root, "repo")],
    onResult: (result) => { results.push(result); if (options_.onResultThrows === true) throw new Error("sink"); },
  });
  if (plan === undefined) throw new Error("expected a plan");
  const rec = recording(options_.exitCodes);
  const result = await runChecks(planOf(options_.count ?? 2), withGeneralFakesRound(plan, rec.runners), options());
  return { result, results, ...l, seen: rec.seen };
}
const labelled = (entries: readonly CheckEntry[]) => entries.map((entry) => entry.madeByRovara);

describe("the plan for a hosted round", () => {
  const options_ = { rootPath: tmpdir(), repositoryPaths: [], onResult: () => undefined };
  const hosted = launcher({ reads: [] }).hosted;
  it("is made for a task sandbox only with a launcher, and for the local shell only without one", () => {
    const payload = { services: [{ variable: "PETS_API_URL" }] };
    expect(generalFakesPlanFor(payload, { ...options_, localShell: false })).toBeUndefined();
    expect(generalFakesPlanFor(payload, { ...options_, localShell: false, hosted })?.hosted).toBe(hosted);
    expect(generalFakesPlanFor(payload, { ...options_, localShell: true })).toBeDefined();
    expect(generalFakesPlanFor(payload, { ...options_, localShell: true })?.hosted).toBeUndefined();
    expect(generalFakesPlanFor(payload, { ...options_, localShell: true, hosted })).toBeUndefined();
    expect(generalFakesPlanFor(undefined, { ...options_, localShell: false, hosted })).toBeUndefined();
    expect(generalFakesPlanFor({ services: [] }, { ...options_, localShell: false, hosted })).toBeUndefined();
  });
});

describe("a CHECKS round with the fake helper in a container", () => {

  it("a request refused for its size counts as an unsupported call", async () => {
    const run = await round({ reads: [calls({ refused: 1 }), NONE] }, { count: 1, exitCodes: [1] });
    expect(run.result.entries[0]).toMatchObject({ after: "not_run", output: GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unsupported });
  });

  it("an unreadable record marks EVERY check of the round (fail closed), and a failed command stays failed (the reason is unknown)", async () => {
    const run = await round({ reads: [undefined, calls(), NONE] }, { count: 2, exitCodes: [1, 0] });
    expect(run.results[0]!.facts.unknown).toBe(true);
    expect(labelled(run.result.entries)).toEqual([true, true]);
    expect(run.result.entries[0]).toMatchObject({ after: "failed" });
  });

  it("a connection from another address, or a request no service answers, marks every check (no check can be blamed)", async () => {
    for (const change of [{ foreign: 1 }, { unrouted: 1 }]) {
      const run = await round({ reads: [calls(change), NONE, NONE] }, { count: 2 });
      expect(run.results[0]!.facts.unknown, JSON.stringify(change)).toBe(true);
      expect(labelled(run.result.entries), JSON.stringify(change)).toEqual([true, true]);
    }
  });

  it("calls after the last command (the closing read) belong to no check and mark every check", async () => {
    const run = await round({ reads: [NONE, NONE, calls({ served: 1 })] });
    expect(run.results[0]!.facts.unknown).toBe(true);
    expect(labelled(run.result.entries)).toEqual([true, true]);
    expect(run.results[0]!.lines).toEqual([expect.stringContaining("1 outside call ")]);
  });

  it("a helper that cannot start makes every command Not run with the fixed start sentence, and echoes nothing of what docker said", async () => {
    const run = await round({ reads: [], startFails: true });
    expect(run.result.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(run.result.entries.map((entry) => entry.output)).toEqual([GENERAL_FAKE_NOT_RUN_SENTENCES.start_failed, GENERAL_FAKE_NOT_RUN_SENTENCES.start_failed]);
    expect(JSON.stringify(run.result)).not.toContain("secret");
    expect(run.seen).toEqual([]);
  });

  it("stops the helper even when the result consumer throws", async () => {
    const run = await round({ reads: [] }, { onResultThrows: true });
    expect(run.events.at(-1)).toBe("stop");
    expect(run.results).toHaveLength(1);
  });

});

describe("the wiring in run-task.ts", () => {
  it("builds the hosted launcher once, after the task's docker is known, and hands it to BOTH plan sites (the CHECKS round and the coding run's verification)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(import.meta.dirname, "../../packages/worker/src/run-task.ts"), "utf8");
    expect(source.match(/hostedFakesLauncherFor\(/gu)).toHaveLength(1);
    expect(source.indexOf("const fileToolsDocker")).toBeLessThan(source.indexOf("hostedFakesLauncherFor("));
    const sites = source.split("generalFakesPlanFor(").slice(1);
    expect(sites).toHaveLength(2);
    for (const site of sites) expect(site.slice(0, 700)).toContain("...(hostedFakes === undefined ? {} : { hosted: hostedFakes })");
    // The launcher is only offered a task sandbox that has no test services and no dev container, and only when the broker sent the payload.
    const call = source.slice(source.indexOf("hostedFakesLauncherFor("), source.indexOf("hostedFakesLauncherFor(") + 700);
    expect(call).toContain("testServices: testServices !== undefined");
    expect(call).toContain("devcontainer: devcontainer !== undefined");
    expect(call).toContain("requested: invocation.payload.generalFakes !== undefined");
    expect(call).toContain("workspaceId: invocation.workspaceId, operationId: invocation.operationId");
  });
});
