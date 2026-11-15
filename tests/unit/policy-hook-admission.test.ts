// Lane H: "may this task start?". Stricter only; never cached; with no answer the start is held and the same signed question is sent again for up to
// 240 s in all, then refused with fixed words. Every other admission action is the install's own, untouched.
import { describe, expect, it } from "vitest";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { withPolicyHookAdmission } from "../../packages/broker/src/core/policy-hook/admission.js";
import { POLICY_HOOK_WORDS, type Admission, type AdmissionRequest } from "../../packages/contracts/src/index.js";
import { COMPANY, ISSUER, fakeService, makeKey, memoryAudit, settingsFor, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const T0 = 1_800_000_000_000;
const request = (taskId: string, extra: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
  companyId: COMPANY, idempotencyKey: `task.start:${taskId}:1`, action: "task.start", projectName: "web", subject: { type: "task", id: taskId },
  actor: { companyId: COMPANY, personId: "person-1", displayName: "P", roles: [], provider: "local-owner" }, taskStart: { workflow: true, path: "FULL" }, ...extra,
});

function world(answer: Parameters<typeof fakeService>[0]["answer"], base: Admission = createAllowAllAdmission()) {
  let clock = T0;
  const sleeps: number[] = [];
  const service = fakeService({ key: hookKey, now: () => clock, answer });
  const audit = memoryAudit();
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => clock, audit: audit.sink });
  const admission = withPolicyHookAdmission(base, client, { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  return { admission, service, audit, sleeps, elapsed: () => clock - T0 };
}

describe("policy hook: may this task start", () => {
  it("a yes lets the install's own decision through, with its steps", async () => {
    const w = world(() => ({ allow: true }));
    expect(await w.admission.stage(request("task_1"))).toEqual({ decision: { allowed: true }, items: [] });
    expect(w.service.asked).toHaveLength(1);
    expect(w.service.asked[0]!.q).toEqual({ cid: COMPANY, pid: "web", per: "person-1", tid: "task_1", path: "FULL" });
  });

  it("a no refuses with fixed words, whatever the service says", async () => {
    const w = world(() => ({ allow: false, code: "over_budget" }));
    expect(await w.admission.stage(request("task_1"))).toEqual({ decision: { allowed: false, code: "company_rules_refused", message: POLICY_HOOK_WORDS.startRefused }, items: [] });
    expect(w.audit.events.map((event) => event["action"])).toEqual(["policy_hook.answered"]);
  });

  it("stricter only: the install's own refusal stands and the service is not asked", async () => {
    const refusing: Admission = { ...createAllowAllAdmission(), async admit() { return { allowed: false, code: "budget_exhausted", message: "Over budget." }; }, async stage() { return { decision: { allowed: false, code: "budget_exhausted", message: "Over budget." }, items: [] }; } };
    const w = world(() => ({ allow: true }), refusing);
    expect((await w.admission.stage(request("task_1"))).decision).toEqual({ allowed: false, code: "budget_exhausted", message: "Over budget." });
    expect((await w.admission.admit(request("task_1")))).toEqual({ allowed: false, code: "budget_exhausted", message: "Over budget." });
    expect(w.service.asked).toHaveLength(0);
  });

  it("not cached: every start asks again", async () => {
    let answers = 0;
    const w = world(() => ({ allow: answers++ === 0 }));
    expect((await w.admission.stage(request("task_1"))).decision.allowed).toBe(true);
    expect((await w.admission.stage(request("task_1"))).decision.allowed).toBe(false);
    expect(w.service.asked).toHaveLength(2);
  });

  it("service down: holds and retries the same signed question for up to 240 s in all, then refuses plainly; nothing has started", async () => {
    const w = world(() => new Response("down", { status: 503 }));
    const staged = await w.admission.stage(request("task_1"));
    expect(staged).toEqual({ decision: { allowed: false, code: "company_rules_no_answer", message: "the company rules service did not answer; nothing has started", retryAfterSeconds: 60 }, items: [] });
    // 240 s in all, last attempt included (an attempt may take its 5 s timeout), under Node's 300 s request timeout.
    expect(w.elapsed() + 5_000).toBeLessThanOrEqual(240_000);
    expect(w.elapsed()).toBeGreaterThan(180_000);
    expect(w.service.asked.length).toBeGreaterThan(5);
    expect(new Set(w.service.asked.map((asked) => asked.text)).size).toBe(1);
    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({ action: "policy_hook.no_answer", details: { attempts: w.service.asked.length } });
  });

  it("the hold never passes 240 s, even when each attempt takes its full timeout or a longer hold is asked for", async () => {
    let clock = T0;
    const audit = memoryAudit();
    const slow: typeof fetch = async () => { clock += 5_000; return new Response("down", { status: 503 }); };
    const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: slow, now: () => clock, audit: audit.sink });
    const admission = withPolicyHookAdmission(createAllowAllAdmission(), client, { holdMs: 600_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect((await admission.stage(request("task_1"))).decision).toMatchObject({ allowed: false, message: POLICY_HOOK_WORDS.startNoAnswer });
    expect(clock - T0).toBeLessThanOrEqual(240_000);
  });

  it("service back within the hold: the start goes ahead on the late answer", async () => {
    let calls = 0;
    const w = world(() => (calls++ < 3 ? new Response("down", { status: 503 }) : { allow: true }));
    expect((await w.admission.stage(request("task_1"))).decision).toEqual({ allowed: true });
    expect(w.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("other actions are the install's own admission, untouched and never asked", async () => {
    const w = world(() => ({ allow: false }));
    expect(await w.admission.admit(request("task_1", { action: "machine.start" }))).toEqual({ allowed: true });
    expect(await w.admission.admit(request("task_1", { action: "learning.call" }))).toEqual({ allowed: true });
    expect(w.service.asked).toHaveLength(0);
  });

  it("a refusal gives back the install's reservation", async () => {
    const released: string[] = [];
    const holding: Admission = { ...createAllowAllAdmission(), enforcesCost: true, async admit() { return { allowed: true, reservationId: "res-1" }; }, async release(id) { released.push(id); } };
    const w = world(() => ({ allow: false }), holding);
    expect((await w.admission.admit(request("task_1"))).allowed).toBe(false);
    expect(released).toEqual(["res-1"]);
    expect(w.admission.enforcesCost).toBe(true);
  });

  it("a refusal drops the steps the install's own admission staged", async () => {
    const charge = { kind: "put", key: { pk: "budget", sk: "charge" }, item: {} } as never;
    const staging: Admission = { ...createAllowAllAdmission(), async stage() { return { decision: { allowed: true, reservationId: "res-2" }, items: [charge] }; } };
    expect(await world(() => ({ allow: false }), staging).admission.stage(request("task_1"))).toEqual({ decision: { allowed: false, code: "company_rules_refused", message: POLICY_HOOK_WORDS.startRefused }, items: [] });
    expect((await world(() => ({ allow: true }), staging).admission.stage(request("task_1"))).items).toEqual([charge]);
  });

  it("a refusal at stage gives back the install's staged reservation", async () => {
    const released: string[] = [];
    const staging: Admission = { ...createAllowAllAdmission(), async stage() { return { decision: { allowed: true, reservationId: "res-3" }, items: [] }; }, async release(id) { released.push(id); } };
    expect((await world(() => ({ allow: false }), staging).admission.stage(request("task_1"))).decision.allowed).toBe(false);
    expect(released).toEqual(["res-3"]);
  });

  it("a start the contract cannot carry (no project) is refused, not asked", async () => {
    const w = world(() => ({ allow: true }));
    const noProject: AdmissionRequest = { ...request("task_1") };
    delete noProject.projectName;
    expect((await w.admission.stage(noProject)).decision).toEqual({ allowed: false, code: "company_rules_unaskable", message: POLICY_HOOK_WORDS.startRefused });
    expect(w.service.asked).toHaveLength(0);
  });
});
