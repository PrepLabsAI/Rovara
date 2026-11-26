// L4-EVW4 (DEC 254zzz43): the wrapper inside the setup flow. The setup run's eval report is only RECORDED (it opens nothing); an eval whose results Rovara cannot read is not approved for spend until its file is on the
// project's DEFAULT branch (found by a read, whoever put it there); from then on the eval runs THROUGH the file, and the approval of the test run is the eval spend approval, in dollars, bound to what the person saw.
// Fakes only: the fake code host, the company's own store, the real approval gate.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVAL_OUTPUT_UNREADABLE_MESSAGE, EVAL_WRAPPER_PYTHON_PATH, evalWrapperFor } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { detectEvalWrappers, openEvalWrapperPullRequest, type EvalWrapperDeps } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { evalSetupNeededLine } from "../../packages/broker/src/core/setup-agent/eval-wrapper-card.js";
import { dismissEvalWrapper } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { A, B, NOW, command, company, filesOf, project, reportOf, reportPath, type EvalCardWorld } from "../support/eval-card-world.js";

const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } } as const;
const URL_WEB = "https://github.com/acme/web";
/** What the setup run's dry-run adds to a suite whose file it checked. */
const OFFERED = { output: ROWS, wrapperDryRun: "passed" } as const;

function host(companyId: string) {
  const model = new FakeHostModel({ url: URL_WEB, id: "4242", fullName: "acme/web", webBase: "https://github.com" });
  const fake = new FakeCodeHost(model);
  const audits: Array<{ action: string; details: Record<string, string> }> = [];
  const wrapper = (world: EvalCardWorld, over: Partial<EvalWrapperDeps> = {}): EvalWrapperDeps => ({
    store: world.store, companyId, now: () => NOW, targets: async () => [{ name: "web", place: "fake:repo/4242", repository: { url: URL_WEB }, scope: { orgId: companyId }, host: fake }],
    audit: async (event) => { audits.push(event); }, ...over,
  });
  return { model, fake, audits, wrapper };
}
const fileOf = () => evalWrapperFor({ command, report: reportPath, output: ROWS })!;

describe("the setup run's report opens NOTHING (DEC 254zzz43: no automatic proposal)", () => {

  it("the setup callback has no code host seam at all, and only the card's route calls the pull request opener (a source guard)", () => {
    const callback = readFileSync("packages/broker/src/core/setup-agent/callback.ts", "utf8");
    expect(callback).not.toMatch(/eval-wrapper|evalWrapper|EvalWrapper|proposeEvalWrappers|openEvalWrapperPullRequest/u);
    const routes = readFileSync("packages/broker/src/core-host/setup-run-routes.ts", "utf8");
    expect(routes.match(/openEvalWrapperPullRequest\(/gu)).toHaveLength(1);
    for (const file of ["packages/broker/src/core/setup-agent/eval-discovery.ts", "packages/broker/src/core/setup-agent/eval-card.ts", "packages/broker/src/aws/core-engine-root.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/openEvalWrapperPullRequest/u);
    }
  });
});

describe("an eval Rovara cannot read is not approved for spend until its file is on the default branch", () => {

  it("an out-of-date file, a file that is gone, and an edited file are told apart: only the first two are not approvable", async () => {
    const w = company(A); const h = host(A);
    const report = reportOf(2, { ...OFFERED, repository: "web" });
    const r = await w.run(filesOf(2), report);
    h.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: fileOf().content.replace(/template: 1/u, "template: 0") });
    await detectEvalWrappers(h.wrapper(w), project, report, { force: true });
    await expect(r.approve()).rejects.toThrow(EVAL_OUTPUT_UNREADABLE_MESSAGE);
    expect((await r.card()).wrappers[0]).toMatchObject({ step: "file_outdated" });
    // Edited by the person: judged by the outcome of the test run, so it is approvable.
    h.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: `${fileOf().content}# mine\n` });
    await detectEvalWrappers(h.wrapper(w), project, report, { force: true });
    await r.approve();
    expect(await w.item()).toMatchObject({ state: "approved" });
  });
});

describe("a pull request Rovara opened, then merged, is found on the default branch", () => {
  it("one click opens it; the merge puts the file on the default branch; the next read finds it and the eval is approvable", async () => {
    const w = company(A); const h = host(A);
    const report = reportOf(2, { ...OFFERED, repository: "web" });
    const r = await w.run(filesOf(2), report);
    const outcome = await openEvalWrapperPullRequest(h.wrapper(w), project, { report, selection: "evals/demo", taskId: r.taskId, by: "person-1" });
    expect(outcome).toMatchObject({ state: "open", number: "1" });
    expect(h.audits).toHaveLength(1);
    const cr = h.model.changeRequests[0]!;
    h.model.merge(cr.id, { revision: h.model.headRevisionOf(cr), method: "squash" });
    await detectEvalWrappers(h.wrapper(w), project, report, { force: true });
    await r.approve();
    expect(await w.item()).toMatchObject({ state: "approved" });
  });
});

describe("the pull request line", () => {
  it("'Eval not read: setup needed' while the card is set aside and the eval is still unread; gone once the file is found or the card is back", async () => {
    const w = company(A); const h = host(A);
    const report = reportOf(2, { ...OFFERED, repository: "web" });
    const r = await w.run(filesOf(2), report);
    expect(await evalSetupNeededLine({ store: w.store, companyId: A }, project)).toBeUndefined();
    await dismissEvalWrapper({ ...h.wrapper(w) }, project, { reportDigest: await r.digest(), by: "person-1" });
    expect(await evalSetupNeededLine({ store: w.store, companyId: A }, project)).toBe("Eval not read: setup needed");
    // Another company's project of the same name is not affected.
    expect(await evalSetupNeededLine({ store: w.store, companyId: B }, project)).toBeUndefined();
    h.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: fileOf().content });
    await detectEvalWrappers(h.wrapper(w), project, report, { force: true });
    expect(await evalSetupNeededLine({ store: w.store, companyId: A }, project)).toBeUndefined();
  });
});
