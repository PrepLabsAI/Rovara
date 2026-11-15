// Task actions (DEC 236h): accepting a SECURITY review finding is the web page's alone, with a fresh step-up. The rules, each tested against what the move left in the store:
//   1. a script token and an API token (the laptop's route, the CLI, an AI tool) never accept a security finding, even when the caller carries a step-up of its own;
//   2. a page with no step-up, a stale one (older than the company's window), a future one, or one made with a factor Code does not own is refused too, and a window that cannot be read refuses;
//   3. a page with a fresh step-up accepts, and the way is recorded as the page;
//   4. nothing else changed: a token still accepts the code review's findings, and fixes any finding; the refusal uses fixed words and never echoes what the request carried.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema } from "@agentx/contracts";
import type { TaskCaller } from "../../packages/broker/src/core/task-flow/deps.js";
import { SECURITY_ACCEPT_ON_THE_PAGE, acceptedOfRole, requirePageForSecurityAccept } from "../../packages/broker/src/core/task-flow/security-accept.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { code, blockedReview, PARSER, REQUEST_A, TASK_ID, TOKEN, parserId, report, seed, stateOf, taskOf, tokenId } from "../support/task-actions-world.js";

const both = () => blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]);
const answer = (findingId: string, action: "ACCEPT" | "FIX", note = action === "ACCEPT" ? "Reviewed; fine." : "Fix it.") => ({ findingId, action, note });
const request = (resolutions: unknown[]) => ({ requestId: REQUEST_A, expectedRevision: 6, candidateDigest: code.digest, resolutions });
const acceptSecurity = () => request([answer(parserId, "FIX", "Keep the footer."), answer(tokenId, "ACCEPT", "Test token only.")]);
const acceptBoth = () => request([answer(parserId, "ACCEPT"), answer(tokenId, "ACCEPT", "Test token only.")]);
const acceptCodeOnly = () => request([answer(parserId, "ACCEPT"), answer(tokenId, "FIX", "Remove the log line.")]);
const fixBoth = () => request([answer(parserId, "FIX", "Keep it."), answer(tokenId, "FIX", "Remove it.")]);

/** The harness clock (2026-11-09T10:00:00Z) is the time of "now"; a step-up is this many seconds old. */
const NOW_MS = Date.parse("2026-11-09T10:00:00.000Z");
const stepUp = (ageSeconds: number, method = "email_code") => ({ at: new Date(NOW_MS - ageSeconds * 1_000).toISOString(), method });
const withStepUp = (caller: TaskCaller, value: { at: string; method: string } | undefined): TaskCaller => (value === undefined ? caller : { ...caller, stepUp: value });
const refused = { message: expect.stringContaining(SECURITY_ACCEPT_ON_THE_PAGE) as string };

describe("a security finding is accepted on the web page, with a fresh step-up", () => {
  it("is refused to an API token, with fixed words and nothing written, even when the caller says it has a fresh step-up", async () => {
    for (const held of [undefined, stepUp(5)]) {
      const { h, caller } = await seed({ workflow: both() });
      const before = await stateOf(h);
      for (const body of [acceptSecurity(), acceptBoth()]) {
        await expect(createTaskActions(h.deps).resolveFindings(withStepUp(caller, held), TASK_ID, body, "api-token")).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
        // Left out, the way is the token's.
        await expect(createTaskActions(h.deps).resolveFindings(withStepUp(caller, held), TASK_ID, body)).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
      }
      expect(await stateOf(h)).toEqual(before);
      expect((await taskOf(h)).workflow!.acceptedFindings ?? []).toHaveLength(0);
      expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toBeUndefined();
    }
  });

  it("is refused to a script token (the owner is not a script token), with nothing written", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const before = await stateOf(h);
    const script = { ...caller, stepUp: stepUp(5), scriptToken: { tokenId: "t", name: "CI", permissions: ["read", "start"] as const, projects: ["payments"] } };
    await expect(createTaskActions(h.deps).resolveFindings(script, TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(h)).toEqual(before);
    // The guard on its own refuses a script token that reached it, whatever the way and the step-up say.
    const workflow = (await taskOf(h)).workflow!;
    await expect(requirePageForSecurityAccept({}, script, "page", workflow, acceptSecurity() as never, NOW_MS)).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
  });

  it("is refused to a page with no step-up, a stale one, one from the future, or one made another way, and nothing is written", async () => {
    const cases: Array<[string, { at: string; method: string } | undefined]> = [
      ["none", undefined],
      ["stale by a minute", stepUp(601)],
      ["stale by a day", stepUp(86_400)],
      ["from the future", stepUp(-3_600)],
      ["a Slack round trip", stepUp(5, "slack")],
      ["a Google round trip", stepUp(5, "google")],
      ["a time that is not the sign-in's form", { at: "2026-11-09 09:59:55", method: "email_code" }],
    ];
    for (const [name, held] of cases) {
      const { h, caller } = await seed({ workflow: both() });
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps).resolveFindings(withStepUp(caller, held), TASK_ID, acceptSecurity(), "page"), name).rejects.toMatchObject({ code: "REAUTH_REQUIRED", ...refused });
      expect(await stateOf(h), name).toEqual(before);
    }
  });

  it("holds the company's window: it may only shorten the ten minutes, and a window that cannot be read refuses", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const before = await stateOf(h);
    const old = withStepUp(caller, stepUp(300));
    await expect(createTaskActions(h.deps, { stepUpWindowSeconds: async () => 120 }).resolveFindings(old, TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "REAUTH_REQUIRED", ...refused });
    await expect(createTaskActions(h.deps, { stepUpWindowSeconds: async () => 0 }).resolveFindings(withStepUp(caller, stepUp(1)), TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    for (const answerOf of [async () => { throw new Error("down"); }, async () => "ten", async () => 1.5, async () => -1, async () => 86_401]) {
      await expect(createTaskActions(h.deps, { stepUpWindowSeconds: answerOf }).resolveFindings(withStepUp(caller, stepUp(5)), TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    // A longer window never lengthens the default: a step-up 11 minutes old stays stale.
    await expect(createTaskActions(h.deps, { stepUpWindowSeconds: async () => 3_600 }).resolveFindings(withStepUp(caller, stepUp(660)), TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("is allowed to a page with a fresh step-up (each factor Code owns), and the way is recorded as the page", async () => {
    for (const method of ["email_code", "passkey", "company_reauth"]) {
      const { h, caller } = await seed({ workflow: both() });
      const view = await createTaskActions(h.deps).resolveFindings(withStepUp(caller, stepUp(30, method)), TASK_ID, acceptBoth(), "page");
      expect(view.workflow).toMatchObject({ stage: "PULL_REQUEST" });
      expect((await taskOf(h)).workflow!.acceptedFindings?.map((entry) => entry.role)).toEqual(["CRITIC", "SECURITY"]);
      expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toMatchObject({ method: "page", fingerprints: [parserId, tokenId] });
      expect(h.audit[0]!.details).toMatchObject({ method: "page", securityAccepted: 1 });
    }
    // The edge of the window is inside it, and a hook may shorten it and still allow a fresher step-up.
    const edge = await seed({ workflow: both() });
    await createTaskActions(edge.h.deps, { stepUpWindowSeconds: async () => 600 }).resolveFindings(withStepUp(edge.caller, stepUp(600)), TASK_ID, acceptSecurity(), "page");
    const short = await seed({ workflow: both() });
    await createTaskActions(short.h.deps, { stepUpWindowSeconds: async () => 120 }).resolveFindings(withStepUp(short.caller, stepUp(60)), TASK_ID, acceptSecurity(), "page");
  });

  it("changes nothing for a code review finding or a fix: an API token still accepts the first with a reason and fixes either, with no step-up", async () => {
    const accepted = await seed({ workflow: both() });
    const view = await createTaskActions(accepted.h.deps).resolveFindings(accepted.caller, TASK_ID, acceptCodeOnly(), "api-token");
    expect(view.workflow).toMatchObject({ stage: "IMPLEMENT" });
    expect((await taskOf(accepted.h)).workflow!.acceptedFindings?.map((entry) => entry.role)).toEqual(["CRITIC"]);
    expect(await accepted.h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toMatchObject({ method: "api-token", fingerprints: [parserId] });
    const fixed = await seed({ workflow: both() });
    await createTaskActions(fixed.h.deps).resolveFindings(fixed.caller, TASK_ID, fixBoth());
    expect((await taskOf(fixed.h)).workflow!.acceptedFindings ?? []).toHaveLength(0);
    // A review that found only a code problem: accepting it by a token starts the draft pull request, as before.
    const codeOnly = await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "PASS", [])]) });
    expect((await createTaskActions(codeOnly.h.deps).resolveFindings(codeOnly.caller, TASK_ID, request([answer(parserId, "ACCEPT")]))).workflow).toMatchObject({ stage: "PULL_REQUEST" });
    // A script token is still no owner, for a code finding too.
    const script = await seed({ workflow: both() });
    await expect(createTaskActions(script.h.deps).resolveFindings({ ...script.caller, scriptToken: { tokenId: "t", name: "CI", permissions: ["read"], projects: ["payments"] } }, TASK_ID, acceptCodeOnly())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("counts only the security review's accepted findings, and refuses in words that never carry what the request sent", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const workflow = (await taskOf(h)).workflow!;
    expect(acceptedOfRole(workflow, acceptBoth() as never, "SECURITY")).toBe(1);
    expect(acceptedOfRole(workflow, acceptBoth() as never, "CRITIC")).toBe(1);
    expect(acceptedOfRole(workflow, acceptCodeOnly() as never, "SECURITY")).toBe(0);
    expect(acceptedOfRole(workflow, fixBoth() as never, "SECURITY")).toBe(0);
    const secret = "SENTINEL-NOTE-FROM-THE-REQUEST";
    const body = request([answer(parserId, "ACCEPT"), answer(tokenId, "ACCEPT", secret)]);
    for (const way of ["api-token", "page"] as const) {
      const error = await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, body, way).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).toContain(SECURITY_ACCEPT_ON_THE_PAGE);
      expect(error?.message).not.toContain(secret);
      expect(error?.message).not.toContain(tokenId);
    }
    // A repeat of a request the page already decided answers as the first, for anyone who may read the task.
    const page = await seed({ workflow: both() });
    await createTaskActions(page.h.deps).resolveFindings(withStepUp(page.caller, stepUp(5)), TASK_ID, acceptBoth(), "page");
    const again = await createTaskActions(page.h.deps).resolveFindings(page.caller, TASK_ID, acceptBoth(), "api-token");
    expect(again.workflow).toMatchObject({ stage: "PULL_REQUEST" });
    expect(WorkflowSnapshotSchema.safeParse((await taskOf(page.h)).workflow).success).toBe(true);
  });
});
