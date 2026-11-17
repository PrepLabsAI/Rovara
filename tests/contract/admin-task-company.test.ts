// Q2 (web task channel): the install administrator's task routes `POST /v1/admin/tasks/{id}/share-mode` and `/v1/admin/tasks/{id}/e2e-replay` match the administrator's project grant by
// project NAME only (grant rows carry no company). On an install with company sign-in the grant now counts only for an administrator whose live membership is the stored task's company
// (an old task without a company is the install's fixed company); another company's administrator, or one whose company can't be read, gets exactly the no-grant answer. Without company
// sign-in nothing changes (golden).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call, issuer, loadSlackBroker } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };
const NO_GRANT = { subject: "other-admin", admin: true };
const OTHER = "org_corehost00000000000b";
beforeAll(async () => { await loadSlackBroker(); });

/** A legacy task of MAYA's on "payments"; `companies`: the administrators' live memberships by owner key (an Error: the read fails), or no company sign-in at all. */
async function legacyTask(companies?: Map<string, string | Error>) {
  const harness = await createDeveloperTaskBroker(companies === undefined ? {} : { brokerExtra: { companies: { companyOf: async (personId: string) => {
    const found = companies.get(personId);
    if (found instanceof Error) throw found;
    return found;
  } } } });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true, shareMode: "continue" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const shareMode = (user: typeof ADMIN) => call(harness.handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/share-mode`, user, body: { requestId: randomUUID(), shareMode: "view" } });
  const replays = (user: typeof ADMIN) => call(harness.handler, { method: "GET", path: `/v1/admin/tasks/${taskId}/e2e-replay`, user });
  const mode = () => (harness.db.get(`DEVTASK#${taskId}`, "META") as { share?: { mode: string } }).share?.mode;
  return { harness, taskId, shareMode, replays, mode };
}
const withoutRequestId = (answer: { status: number; body: Record<string, unknown> }) => JSON.stringify({ ...answer, body: { ...answer.body, requestId: "<id>" } });
const ADMIN_KEY = ownerKeyForSubject(issuer, ADMIN.subject), NO_GRANT_KEY = ownerKeyForSubject(issuer, NO_GRANT.subject);

describe("share-mode and e2e-replay bind the administrator's grant to the task's company (Q2)", () => {
  it("golden: without company sign-in an administrator with the grant is served as before", async () => {
    const task = await legacyTask();
    expect((await task.replays(ADMIN)).body.error).toMatchObject({ code: "CONFIG_INVALID" }); // past the authority check: the task has no qualified round
    expect((await task.shareMode(ADMIN)).status).toBe(200);
    expect(task.mode()).toBe("view");
  });

  it("an administrator of the task's own company (an old task without a company is the install's company) is served as without company sign-in", async () => {
    const task = await legacyTask(new Map([[ADMIN_KEY, IMPLICIT_COMPANY_ID]]));
    const plain = await legacyTask();
    expect(withoutRequestId(await task.replays(ADMIN))).toBe(withoutRequestId(await plain.replays(ADMIN)));
    expect((await task.shareMode(ADMIN)).status).toBe(200);
    expect(task.mode()).toBe("view");
  });

  it("two companies: an administrator whose grant names 'payments' but whose membership is another company's (or none, or unreadable) gets exactly the no-grant answer; nothing changes", async () => {
    for (const held of [OTHER, undefined, new Error("sign-in table throttled: secret-cause")] as const) {
      const task = await legacyTask(new Map<string, string | Error>([...(held === undefined ? [] : [[ADMIN_KEY, held] as const]), [NO_GRANT_KEY, IMPLICIT_COMPANY_ID]]));
      for (const route of [task.shareMode, task.replays]) {
        const foreign = await route(ADMIN), missing = await route(NO_GRANT);
        expect(missing).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "administrator project membership is required" } } });
        expect(withoutRequestId(foreign)).toBe(withoutRequestId(missing));
        expect(JSON.stringify(foreign)).not.toMatch(/secret-cause|throttled|org_/u);
      }
      expect(task.mode()).toBe("continue");
    }
  });

  it("the stored task's company decides: a task of company B is served to B's administrator and refused to the install company's", async () => {
    const memberships = new Map<string, string | Error>([[ADMIN_KEY, IMPLICIT_COMPANY_ID]]);
    const task = await legacyTask(memberships);
    const record = task.harness.db.get(`DEVTASK#${task.taskId}`, "META")!;
    task.harness.db.set({ ...record, companyId: OTHER });
    expect((await task.shareMode(ADMIN)).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(task.mode()).toBe("continue");
    memberships.set(ADMIN_KEY, OTHER);
    expect((await task.shareMode(ADMIN)).status).toBe(200);
    expect(task.mode()).toBe("view");
  });
});
