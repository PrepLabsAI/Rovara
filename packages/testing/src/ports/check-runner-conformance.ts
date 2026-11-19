// The CheckRunner contract: external build and check results. An adapter lists the checks on what it can list, never answers an empty list for a target
// it cannot list, reads a log as untrusted bounded text, and starts a run once per idempotency key.
import { expect } from "vitest";
import {
  CheckRunnerCapabilitiesSchema,
  type Check, type CheckRunner, type CheckTarget, type HostScope, type RepositoryRef,
} from "@agentx/contracts";
import type { FakeHostModel } from "@agentx/broker/fakes";
import { twoCompanyChecks, type TwoCompanyIsolation } from "../isolation/two-company.js";
import { rejection, type ContractCheck } from "./plugin-contract-kit.js";

export interface CheckRunnerWorld {
  /** Two companies that share raw ids on this adapter, for the isolation kit. Absent: the adapter serves one company, and the isolation checks show as skipped. */
  readonly isolation?: TwoCompanyIsolation;
  readonly runner: CheckRunner;
  readonly model: FakeHostModel;
  readonly repository: RepositoryRef;
  readonly unregistered: RepositoryRef;
  readonly scope: HostScope;
  /** A project name the runner accepts for a gate (CodeBuild wants its own prefix). */
  readonly project: string;
  /** A revision with a change request open on it, so a target by change request can be built. */
  readonly changeRequest: () => { ref: { repository: RepositoryRef; id: string; url: string }; revision: string };
  /** Makes a started run finish (the host's side of the world). */
  readonly finishRun: (runId: string, conclusion: "success" | "failure", log?: string) => void;
}

const revisionTarget = (world: CheckRunnerWorld, revision: string): CheckTarget => ({ kind: "revision", repository: world.repository, revision });

/** A target the runner can list, of the kind it lists by, naming a registered repository or one nobody registered. */
function listTarget(world: CheckRunnerWorld, registered: boolean): CheckTarget {
  const repository = registered ? world.repository : world.unregistered;
  if (world.runner.capabilities.listByRevision) {
    return { kind: "revision", repository, revision: registered ? world.model.commit("rovara/x", { "x.txt": "x\n" }) : "a".repeat(40) };
  }
  if (world.runner.capabilities.listByChangeRequest) {
    return { kind: "change-request", ref: registered ? world.changeRequest().ref : { repository, id: "1", url: "" } };
  }
  return { kind: "run", repository, revision: "a".repeat(40), run: { runner: world.runner.kind, id: "build-1" }, gate: "unit", project: world.project };
}

const ownChecks: readonly ContractCheck<CheckRunnerWorld>[] = [
  {
    name: "advertises capabilities that fit the schema",
    async run({ runner }) {
      expect(CheckRunnerCapabilitiesSchema.safeParse(runner.capabilities).success).toBe(true);
      expect(runner.kind).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    },
  },
  {
    name: "lists the checks on a revision, with a conclusion on every finished one",
    needs: ({ runner }) => runner.capabilities.listByRevision,
    async run(world) {
      const revision = world.model.commit("rovara/x", { "x.txt": "x\n" });
      world.model.setChecks(revision, [
        { name: "unit", state: "completed", conclusion: "success", required: true, url: "https://ci.example.test/1", runId: "1" },
        { name: "lint", state: "pending", required: false, url: "", runId: "2" },
      ]);
      const checks = await world.runner.listChecks(revisionTarget(world, revision), world.scope);
      expect(checks.map((check) => [check.name, check.state, check.conclusion])).toEqual([["unit", "completed", "success"], ["lint", "pending", undefined]]);
      for (const check of checks) if (check.state === "completed") expect(check.conclusion).toBeDefined();
    },
  },
  {
    name: "lists the checks on a change request's head",
    needs: ({ runner }) => runner.capabilities.listByChangeRequest,
    async run(world) {
      const { ref, revision } = world.changeRequest();
      world.model.setChecks(revision, [{ name: "unit", state: "completed", conclusion: "failure", required: true, url: "", runId: "1" }]);
      const checks = await world.runner.listChecks({ kind: "change-request", ref }, world.scope);
      expect(checks).toEqual([expect.objectContaining({ name: "unit", conclusion: "failure" })]);
    },
  },
  {
    name: "refuses a target that names a repository nobody registered",
    async run(world) {
      expect(await rejection(() => world.runner.listChecks(listTarget(world, false), world.scope))).toBeDefined();
    },
  },
  {
    name: "refuses a call with no valid scope",
    async run(world) {
      for (const scope of [{}, { system: "anything" }, undefined] as unknown as HostScope[]) {
        expect(await rejection(() => world.runner.listChecks(listTarget(world, true), scope))).toBeDefined();
      }
    },
  },
  {
    name: "stops a listing when its read budget is spent",
    async run(world) {
      const spent = { signal: new AbortController().signal, beforeRequest: () => { throw new Error("read allowance spent"); } };
      expect(await rejection(() => world.runner.listChecks(listTarget(world, true), world.scope, spent))).toBeDefined();
    },
  },
  {
    name: "reads the tail of a log, bounded, and undefined when the log is gone",
    needs: ({ runner }) => runner.capabilities.logTail,
    async run(world) {
      const revision = world.model.commit("rovara/x", { "x.txt": "x\n" });
      const failing: Check = { name: "unit", state: "completed", conclusion: "failure", required: true, url: "", runId: "7" };
      world.model.setChecks(revision, [failing, { name: "lint", state: "completed", conclusion: "success", required: false, url: "", runId: "8" }]);
      world.model.setLog("7", `${"noise\n".repeat(10_000)}FAILED: expected 1 to equal 2\n`);
      const target = revisionTarget(world, revision);
      const tail = await world.runner.logTail(target, failing, world.scope);
      expect(tail).toBeDefined();
      // A runner may trim the final newline; the last line is what the failure says.
      expect(tail!.trimEnd().endsWith("FAILED: expected 1 to equal 2")).toBe(true);
      expect(tail!.length).toBeLessThanOrEqual(65_536);
      expect(await world.runner.logTail(target, { ...failing, runId: "8" }, world.scope)).toBeUndefined();
    },
  },
  {
    name: "starts a run once per idempotency key, and reads it again until it finishes",
    needs: ({ runner }) => runner.capabilities.start && runner.start !== undefined && runner.getRun !== undefined,
    async run(world) {
      const revision = world.model.commit("rovara/x", { "x.txt": "x\n" });
      const request = { repository: world.repository, revision, gate: "unit", project: world.project, timeoutMinutes: 20, idempotencyKey: "task-1:unit" };
      const first = await world.runner.start!(request, world.scope);
      const again = await world.runner.start!(request, world.scope);
      expect(again.run).toEqual(first.run);
      expect(first.check).toMatchObject({ name: "unit", state: "pending" });
      const target = { kind: "run" as const, repository: world.repository, revision, run: first.run, gate: "unit", project: world.project };
      expect((await world.runner.getRun!(target, world.scope)).state).toBe("pending");
      world.finishRun(first.run.id, "success");
      expect(await world.runner.getRun!(target, world.scope)).toMatchObject({ state: "completed", conclusion: "success" });
      const other = await world.runner.start!({ ...request, idempotencyKey: "task-2:unit" }, world.scope);
      expect(other.run.id).not.toBe(first.run.id);
    },
  },
  {
    name: "refuses to start a run on a repository nobody registered",
    needs: ({ runner }) => runner.capabilities.start && runner.start !== undefined,
    async run(world) {
      const request = { repository: world.unregistered, revision: "a".repeat(40), gate: "unit", project: world.project, timeoutMinutes: 20, idempotencyKey: "k" };
      expect(await rejection(() => world.runner.start!(request, world.scope))).toBeDefined();
    },
  },
  {
    name: "runs a finished check again",
    needs: ({ runner }) => runner.capabilities.rerun && runner.rerun !== undefined && runner.start !== undefined && runner.getRun !== undefined,
    async run(world) {
      const revision = world.model.commit("rovara/x", { "x.txt": "x\n" });
      const { run, check } = await world.runner.start!({ repository: world.repository, revision, gate: "unit", project: world.project, timeoutMinutes: 20, idempotencyKey: "k" }, world.scope);
      world.finishRun(run.id, "failure");
      const target = { kind: "run" as const, repository: world.repository, revision, run, gate: "unit", project: world.project };
      const finished = await world.runner.getRun!(target, world.scope);
      expect(finished.conclusion).toBe("failure");
      await world.runner.rerun!(target, { ...check, ...finished }, world.scope);
      expect(await world.runner.getRun!(target, world.scope)).toMatchObject({ state: "pending" });
    },
  },
];

export const checkRunnerChecks: readonly ContractCheck<CheckRunnerWorld>[] = [...ownChecks, ...twoCompanyChecks<CheckRunnerWorld>()];
