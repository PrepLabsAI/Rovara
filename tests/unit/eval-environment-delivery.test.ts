// L4-EVS (D3): the broker delivers, beside the trusted eval plan, the environment the sealed eval runs in. It is the run's own project's (a saved image's repository is checked against this company and
// project), whole (the schema), and never a reason to withhold the plan. The worker reads it back as a copy, in memory only.
import { describe, expect, it } from "vitest";
import {
  evalCommandFingerprint, savedEnvRepositoryName,
  type EvalEnvironment,
} from "@agentx/contracts";
import { handleEvalPlanDelivery, type EvalPlanDeliveryDeps, type EvalPlanScope, type EvalPlanSources } from "../../packages/broker/src/core/proof/eval-plan-delivery.js";
import { evalSourcesFromDelivery } from "../../packages/worker/src/verification/eval-plan-delivery.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const hex = (c: string, n = 64) => c.repeat(n);
const planOf = (company: string, project: string) => ({
  company, project, selection: "evals/main", evalSetHash: hex("b"), evalConfigured: true, judgePin: hex("c"), baselineJudgePin: hex("c"), subsetSupported: true,
  inputs: { evalSetHash: hex("b"), judgePin: hex("c"), modelVersion: "gemini-small-2026-10-01", model: "gemini-small", catalogRowId: "gemini", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: hex("d") },
  key: { company, project, baseCommit: hex("a", 40), commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01" },
  settings: { imageDigest: "sha256:" + hex("e"), route: "gateway" },
  questions: [{ id: "q1", category: "ordinary", baseHash: hex("1"), headHash: hex("2") }], maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 1000,
});
const saved = (orgId: string, projectId: string): EvalEnvironment => {
  const repository = savedEnvRepositoryName({ env: "staging", orgId, projectId });
  return { kind: "saved", repository, digest: `sha256:${hex("a")}`, environmentKey: hex("b"), testEnvRevision: 2, directory: "app",
    login: { registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", repository, username: "AWS", password: ["pw", "z".repeat(24)].join("-"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
};

const operation = { kind: "task", workflowMode: "CHECKS", status: "RUNNING", companyId: A, dispatch: { payload: { evalRequest: { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } } } };
async function deliver(environment: unknown, scope: EvalPlanScope = { companyId: A, project: "web" }) {
  const events: string[] = [];
  const sources: EvalPlanSources = {
    read: async () => ({ plan: planOf(scope.companyId, scope.project), approval: undefined, ...(environment === undefined ? {} : { environment }) }),
    cache: () => undefined,
  };
  const deps: EvalPlanDeliveryDeps = { sources, companyId: A, projectOf: async () => "web", log: (event) => { events.push(event); } };
  return { answer: await handleEvalPlanDelivery(deps, operation), events };
}

describe("the environment beside the plan", () => {

  it("an environment that makes the answer too big is dropped and the plan still goes (never a reason to withhold the plan)", async () => {
    const big: EvalEnvironment = { kind: "install", commands: Array.from({ length: 8 }, () => ({ executable: "npm", args: Array.from({ length: 256 }, () => "x".repeat(700)), cwd: "." })) };
    const { answer, events } = await deliver(big);
    expect(answer.status).toBe("ready");
    expect("environment" in answer).toBe(false);
    expect(events).toEqual(["eval_environment_invalid"]);
  });

  it("cross-company and cross-project: another company's or another project's saved image is dropped, the plan still goes, and only a fixed event is logged (mutant: the repository scope check)", async () => {
    for (const wrong of [saved(B, "web"), saved(A, "api"), saved(B, "api")]) {
      const { answer, events } = await deliver(wrong);
      expect(answer.status).toBe("ready");
      expect("environment" in answer).toBe(false);
      expect(events).toEqual(["eval_environment_scope_mismatch"]);
      expect(JSON.stringify(events)).not.toContain(wrong.kind === "saved" ? wrong.login.password : "x");
    }
  });

  it("an environment that is not whole is dropped (mutant: the schema check): wrong kind, extra field, a login for another repository, a tag, a shell string", async () => {
    const good = saved(A, "web");
    const other = saved(B, "web");
    for (const bad of [{ kind: "other" }, { ...good, extra: 1 }, other.kind === "saved" && good.kind === "saved" ? { ...good, login: other.login } : {}, good.kind === "saved" ? { ...good, digest: "latest" } : {}, { kind: "install", commands: [{ executable: "a && b", args: [], cwd: "." }] }, "text", 7, null]) {
      const { answer, events } = await deliver(bad);
      expect(answer.status).toBe("ready");
      expect("environment" in answer).toBe(false);
      expect(events).toEqual(["eval_environment_invalid"]);
    }
  });

  it("the worker reads it back as a copy (a change to what it was handed never changes the next read), or undefined when there is none", async () => {
    const environment = saved(A, "web");
    const { answer } = await deliver(environment);
    const delivered = evalSourcesFromDelivery(answer)!;
    const first = await delivered.environment();
    expect(first).toEqual(environment);
    if (first?.kind === "saved") first.directory = "elsewhere";
    expect((await delivered.environment())).toMatchObject({ directory: "app" });
    const none = evalSourcesFromDelivery((await deliver(undefined)).answer)!;
    expect(await none.environment()).toBeUndefined();
  });
});
