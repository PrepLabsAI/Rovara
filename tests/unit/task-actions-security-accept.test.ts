// Task actions (DEC 236h): accepting a SECURITY review finding is the web page's alone (DEC 254zzz73: no step-up). The rules, each tested against what the move left in the store:
//   1. a script token and an API token (the laptop's route, the CLI, an AI tool) never accept a security finding;
//   2. a page-way caller that is not the web app's own client is refused, and so is anyone who is not the task's owner;
//   3. the web app's page accepts with no step-up, and the way is recorded as the page;
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

const asPage = (caller: TaskCaller): TaskCaller => ({ ...caller, webApp: true });
const refused = { message: expect.stringContaining(SECURITY_ACCEPT_ON_THE_PAGE) as string };

describe("a security finding is accepted on the web page (no step-up)", () => {
  it("is refused to an API token, with fixed words and nothing written, even from the web app's client", async () => {
    for (const web of [false, true]) {
      const { h, caller } = await seed({ workflow: both() });
      const before = await stateOf(h);
      for (const body of [acceptSecurity(), acceptBoth()]) {
        await expect(createTaskActions(h.deps).resolveFindings((web ? asPage(caller) : caller), TASK_ID, body, "api-token")).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
        // Left out, the way is the token's.
        await expect(createTaskActions(h.deps).resolveFindings((web ? asPage(caller) : caller), TASK_ID, body)).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
      }
      expect(await stateOf(h)).toEqual(before);
      expect((await taskOf(h)).workflow!.acceptedFindings ?? []).toHaveLength(0);
      expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toBeUndefined();
    }
  });

  it("is refused to a script token (the owner is not a script token), with nothing written", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const before = await stateOf(h);
    const script = { ...caller, webApp: true as const, scriptToken: { tokenId: "t", name: "CI", permissions: ["read", "start"] as const, projects: ["payments"] } };
    await expect(createTaskActions(h.deps).resolveFindings(script, TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(h)).toEqual(before);
    // The guard on its own refuses a script token that reached it, whatever the way says.
    const workflow = (await taskOf(h)).workflow!;
    expect(() => requirePageForSecurityAccept(script, "page", workflow, acceptSecurity() as never)).toThrow(expect.objectContaining({ code: "FORBIDDEN", ...refused }) as Error);
  });

  it("is refused on the page to a person who is not the task's owner (#1045: the owner rule is kept), and nothing is written", async () => {
    const { h } = await seed({ workflow: both() });
    const before = await stateOf(h);
    await expect(createTaskActions(h.deps).resolveFindings(asPage(h.guest), TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("is refused to a page-way caller that is not the web app's own client (a full-access AI tool's, say)", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const before = await stateOf(h);
    const tool = { ...caller };
    await expect(createTaskActions(h.deps).resolveFindings(tool, TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
    await expect(createTaskActions(h.deps).resolveFindings({ ...tool, webApp: undefined }, TASK_ID, acceptSecurity(), "page")).rejects.toMatchObject({ code: "FORBIDDEN", ...refused });
    expect(await stateOf(h)).toEqual(before);
    // The code review's findings stay open to it.
    await createTaskActions(h.deps).resolveFindings(tool, TASK_ID, request([answer(parserId, "ACCEPT"), answer(tokenId, "FIX", "Remove it.")]), "page");
  });

  it("is allowed to the task's owner on the web app's page with no step-up, and the way is recorded as the page", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const view = await createTaskActions(h.deps).resolveFindings(asPage(caller), TASK_ID, acceptBoth(), "page");
    expect(view.workflow).toMatchObject({ stage: "PULL_REQUEST" });
    expect((await taskOf(h)).workflow!.acceptedFindings?.map((entry) => entry.role)).toEqual(["CRITIC", "SECURITY"]);
    expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toMatchObject({ method: "page", fingerprints: [parserId, tokenId] });
    expect(h.audit[0]!.details).toMatchObject({ method: "page", securityAccepted: 1 });
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
    await createTaskActions(page.h.deps).resolveFindings(asPage(page.caller), TASK_ID, acceptBoth(), "page");
    const again = await createTaskActions(page.h.deps).resolveFindings(page.caller, TASK_ID, acceptBoth(), "api-token");
    expect(again.workflow).toMatchObject({ stage: "PULL_REQUEST" });
    expect(WorkflowSnapshotSchema.safeParse((await taskOf(page.h)).workflow).success).toBe(true);
  });
});
