// Test environment: what the evidence says about the environment a task ran in. The pack's Environment line names the approved test environment and its revision, the data guard is given the
// environment's own production list, and a task whose project HAS an approved environment that was not applied says so (and why) instead of the plain "No approved test environment".
//
// The task's pinned revision is the truth, not the project's newest one: a later approval does not rewrite what an earlier task ran in. Nothing is claimed that the task flow did not do: services and accounts are
// empty (an environment with either is not applied, see usable.ts), and the data is "synthetic" only because a sandbox of the project's own checks touches no other data.
import { UNUSED_WORDS, readTestEnvPin, usableTestEnvironment } from "./usable.js";
import { testEnvironmentEnabled } from "./switch.js";
import type { TestEnvDeps } from "./deps.js";
import type { EvidenceEnvironment, EvidenceNotTested, OrgId, TestEnvProdDeny } from "@agentx/contracts";
import type { PinnedDependency } from "../proof/dependency-evidence.js";

export interface EvidenceEnvironmentChoice {
  environment?: EvidenceEnvironment | undefined;
  deny?: TestEnvProdDeny | undefined;
  /** Replaces "No approved test environment" when the project has one that was not used. */
  note?: EvidenceNotTested | undefined;
  /** Test services: the dependencies the task's pinned environment lists, as the broker pinned them. The pack's rows are built from these and the worker's usage record; only with the switch `tx` on (an environment with dependencies is not used otherwise). */
  dependencies?: readonly PinnedDependency[] | undefined;
}

/** Never throws; with the switch off, or no pin, it says nothing (the pack then reads as it did before). */
export async function evidenceEnvironmentOf(deps: TestEnvDeps, task: { orgId?: OrgId | undefined; project?: string | undefined; taskId: string }, env: NodeJS.ProcessEnv = process.env): Promise<EvidenceEnvironmentChoice> {
  if (!testEnvironmentEnabled(env) || task.orgId === undefined || task.project === undefined) return {};
  try {
    const pin = await readTestEnvPin(deps, task.orgId, task.project, task.taskId);
    if (pin === undefined) return {};
    if (pin.unused !== undefined) return { note: { kind: "environment", id: "test_environment", text: `${UNUSED_WORDS[pin.unused]}: the project's own test setup was used`, reason: "not applied" } };
    const found = await usableTestEnvironment(deps, task.orgId, task.project, pin.revision, env);
    if (!found.ok) return { note: { kind: "environment", id: "test_environment", text: `${UNUSED_WORDS[found.reason]}: the project's own test setup was used`, reason: "not applied" } };
    const body = found.environment.environment;
    const dependencies: PinnedDependency[] = [];
    for (const dependency of body.dependencies ?? []) {
      if (dependency.backing.kind === "emulated") dependencies.push({ id: dependency.id, name: dependency.name, backing: "emulated", awsServices: dependency.backing.awsServices });
      else if (dependency.backing.kind === "local") dependencies.push({ id: dependency.id, name: dependency.name, backing: "local", ...(dependency.backing.substituteImage === undefined ? {} : { substituteImage: true }) });
      else if (dependency.backing.kind === "fake") {
        // what the evidence says about a fake (recorded or hand-written, which revision, when it was recorded) is the STORE's, read for THIS organisation by the pinned digest; the worker's words never set it. A set the store
        // cannot give (no store, withdrawn since) is shown as the less trusted word, hand-written, without a revision.
        const read = await Promise.resolve(deps.fixtureStore?.(() => Promise.resolve(body.prodDeny)).readApproved(task.orgId, task.project, dependency.backing.fixtureSetRef)).catch(() => undefined);
        const set = read?.ok === true ? read.set : undefined;
        dependencies.push({ id: dependency.id, name: dependency.name, backing: "fake", fake: { origin: set?.origin === "recorded" ? "recorded" : "hand_written", ...(set === undefined ? {} : { revision: set.revision }), ...(set?.origin === "recorded" && set.recordedAt !== undefined ? { recordedAt: set.recordedAt } : {}) } });
      }
    }
    return { environment: { tier: body.tier, envRevision: found.environment.revision, services: [], data: "synthetic", accounts: [] }, deny: body.prodDeny, ...(dependencies.length === 0 ? {} : { dependencies }) };
  } catch {
    return {};
  }
}
