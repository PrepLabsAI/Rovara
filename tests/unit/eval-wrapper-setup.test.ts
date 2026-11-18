// L4-EVW2 (DEC 254zzz20 D2): the proposal inside the setup flow. The setup run's eval report opens the wrapper pull request (best effort, never failing the report); an eval whose results Rovara cannot read yet cannot
// be approved for spend; and after the person merges the pull request, the next setup run reads the eval through the wrapper and it can be approved. Fakes only: the fake code host, the company's own store.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVAL_OUTPUT_UNREADABLE_MESSAGE, EVAL_WRAPPER_REPORT_PATH, evalCommandFingerprintOf, evalWrapperCommandOf } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { listEvalWrappers, refreshEvalWrappers, type EvalWrapperDeps } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { workspaceKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { A, B, NOW, company, filesOf, project, reportOf, type EvalCardWorld } from "../support/eval-card-world.js";

const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } } as const;
const URL_WEB = "https://github.com/acme/web";

function host(companyId: string) {
  const model = new FakeHostModel({ url: URL_WEB, id: "4242", fullName: "acme/web", webBase: "https://github.com" });
  const fake = new FakeCodeHost(model);
  const audits: string[] = [];
  const wrapper = (world: EvalCardWorld, over: Partial<EvalWrapperDeps> = {}): EvalWrapperDeps => ({
    store: world.store, companyId: companyId, now: () => NOW, targets: async () => [{ name: "web", place: "fake:repo/4242", repository: { url: URL_WEB }, scope: { orgId: companyId }, host: fake }],
    audit: async (event) => { audits.push(event.action); }, ...over,
  });
  return { model, fake, audits, wrapper };
}

/** A running setup run of the company, and its callback with the wrapper seam wired the way a host wires it. */
async function callback(world: EvalCardWorld, wrapper: EvalWrapperDeps | undefined, report: unknown) {
  const workspaceId = randomUUID(); const taskId = randomUUID();
  await world.store.put({ item: { ...workspaceKey(world.companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: world.companyId } });
  await world.store.put({ item: { ...(await workspaceKeys({ store: world.store, companyId: world.companyId }, workspaceId)).taskPointerKey(), taskId } });
  await world.store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId: world.companyId, purpose: "setup_agent", preparedBase: [{ repositoryId: "web", baseCommitSha: "a".repeat(40) }] } });
  await world.store.put({ item: { ...setupAgentKey(world.companyId, project), entityType: "SETUP_AGENT", taskId } });
  const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId: world.companyId };
  return handleSetupAgentCallback({ store: world.store, companyId: world.companyId, now: () => NOW, log: () => undefined, ...(wrapper === undefined ? {} : { evalWrapper: wrapper }) }, operation, { kind: "eval_discovery", report });
}

describe("the setup run's report opens the proposal", () => {
  it("opens one pull request through the callback and the card says so; a repeat of the report opens nothing more", async () => {
    const w = company(A); const h = host(A);
    expect(await callback(w, h.wrapper(w), reportOf(2, { output: ROWS }))).toEqual({ recorded: "new" });
    expect(h.model.changeRequests).toHaveLength(1);
    expect(h.audits).toEqual(["eval_wrapper.proposed"]);
    const card = await w.run(filesOf(2), reportOf(2, { output: ROWS })).then((r) => r.card());
    expect(card.wrappers[0]).toMatchObject({ state: "open", number: "1", line: "Rovara proposed a small file so it can read your eval results: review PR #1" });
    expect(card.suites[0]).toMatchObject({ readable: false, needsFile: EVAL_OUTPUT_UNREADABLE_MESSAGE });
    // A later setup run that reports the same unreadable eval finds the proposal and adds nothing.
    await callback(w, h.wrapper(w), reportOf(2, { output: ROWS }));
    expect(h.model.changeRequests).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("a proposal that cannot be made never fails the report: the report is kept and the card says why", async () => {
    const w = company(A); const h = host(A);
    expect(await callback(w, h.wrapper(w, { audit: async () => { throw new Error("down"); } }), reportOf(2, { output: ROWS }))).toEqual({ recorded: "new" });
    expect(h.model.changeRequests).toHaveLength(0);
    const w2 = company(A, undefined, w.store);
    expect(await callback(w2, h.wrapper(w2, { targets: async () => { throw new Error("no host"); } }), reportOf(2, { output: ROWS }))).toEqual({ recorded: "new" });
    expect(h.model.changeRequests).toHaveLength(0);
    expect((await (await w.run(filesOf(2), reportOf(2, { output: ROWS }))).card()).suites[0]).toMatchObject({ readable: false });
  });

  it("makes no proposal where the host wires none, or for an output Rovara reads as it is", async () => {
    const w = company(A); const h = host(A);
    expect(await callback(w, undefined, reportOf(2, { output: ROWS }))).toEqual({ recorded: "new" });
    expect(await callback(w, h.wrapper(w), reportOf(2, { output: { kind: "junit" } }))).toEqual({ recorded: "new" });
    expect(await callback(w, h.wrapper(w), reportOf(2))).toEqual({ recorded: "new" });
    expect(h.model.changeRequests).toHaveLength(0);
    expect(h.audits).toEqual([]);
  });
});

describe("an eval Rovara cannot read yet is not approved for spend", () => {
  it("refuses to confirm or approve it, marks nothing and spends nothing; after the merge the next run reads it through the wrapper and it is approved", async () => {
    const w = company(A); const h = host(A);
    const r = await w.run(filesOf(2), reportOf(2, { output: ROWS }));
    await expect(r.confirmOnly()).rejects.toThrow(EVAL_OUTPUT_UNREADABLE_MESSAGE);
    await expect(r.approve()).rejects.toThrow(EVAL_OUTPUT_UNREADABLE_MESSAGE);
    expect(await w.item()).toBeUndefined();
    expect(await w.record()).toBeUndefined();
    expect(w.approved).toEqual([]);

    // The person merges Rovara's pull request; setup reads the eval again, now through the wrapper's own command and report.
    await callback(w, h.wrapper(w), reportOf(2, { output: ROWS }));
    const cr = h.model.changeRequests[0]!;
    h.model.merge(cr.id, { revision: h.model.headRevisionOf(cr), method: "squash" });
    await refreshEvalWrappers(h.wrapper(w), project);
    expect((await listEvalWrappers({ store: w.store, companyId: A }, project))[0]).toMatchObject({ state: "merged" });
    const command = evalWrapperCommandOf("python");
    const report = { cwd: ".", argument: EVAL_WRAPPER_REPORT_PATH };
    const again = await w.run(filesOf(2), reportOf(2, { command, report, commandFingerprint: evalCommandFingerprintOf(command, report), output: { kind: "junit" } }));
    expect((await again.card()).suites[0]).toMatchObject({ readable: true });
    await again.approve();
    expect(await w.item()).toMatchObject({ state: "approved" });
  });

  it("a report from before this (no output) is read exactly as it was", async () => {
    const w = company(A);
    const r = await w.run(filesOf(2), reportOf(2));
    expect((await r.card()).suites[0]).toMatchObject({ readable: true });
    await r.approve();
    expect(await w.item()).toMatchObject({ state: "approved" });
  });
});

describe("two companies", () => {
  it("one company's proposal is not on another's card, and an approval in one is unaffected by the other's unreadable eval", async () => {
    const a = company(A); const b = company(B, undefined, a.store); const h = host(A);
    await callback(a, h.wrapper(a), reportOf(2, { output: ROWS }));
    expect(h.model.changeRequests).toHaveLength(1);
    const rb = await b.run(filesOf(2), reportOf(2));
    expect((await rb.card()).wrappers).toEqual([]);
    expect(await listEvalWrappers({ store: a.store, companyId: B }, project)).toEqual([]);
    await rb.approve();
    expect(await b.item()).toMatchObject({ state: "approved" });
    expect(await a.item()).toBeUndefined();
  });
});
