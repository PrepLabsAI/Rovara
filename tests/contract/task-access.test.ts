// Who may read, comment, suggest, decide and ask on a task page: one access rule and one table of roles and actions.
import { describe, expect, it, vi } from "vitest";
import { TASK_ACTION_ROLES, can, resolveTaskAccess, resolveTaskReadAccess } from "../../packages/broker/src/developer/task-access.js";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { OMAR, PRIYA, SAM, pagePlan, pageTask } from "../support/page-tasks.js";

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string; owners?: string[] };
  }
  throw new Error("expected a refusal");
};

describe("resolveTaskReadAccess", () => {
  it("reads a workflow task through its existing access checks without calling the core GET", async () => {
    const fixture = pageTask();
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "{}" }));
    fixture.deps.coreTasks = { route };

    await expect(resolveTaskReadAccess(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({
      role: "commenter", task: { taskId: fixture.taskId },
    });
    expect(route).not.toHaveBeenCalled();

    fixture.deps.checkAccess = async () => { throw Object.assign(new Error("denied"), { code: "PROJECT_ACCESS_DENIED" }); };
    await expect(resolveTaskReadAccess(fixture.deps, SAM, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(route).not.toHaveBeenCalled();
  });

  it("refuses a malformed task ID before looking up its engine or task", async () => {
    const fixture = pageTask();
    const send = vi.spyOn(fixture.deps.documentClient, "send");
    try {
      await expect(resolveTaskReadAccess(fixture.deps, PRIYA, "not-a-task-id")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it.each([undefined, 403, 404, 500])("refuses core reads with response %s before reading the task record", async (statusCode) => {
    const fixture = pageTask();
    fixture.db.set({ pk: `TASK_ENGINE#${fixture.taskId}`, sk: "STAMP", coreEngine: {
      engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "", stampedAt: "2026-11-22T00:00:00.000Z",
    } });
    if (statusCode !== undefined) fixture.deps.coreTasks = { route: async () => ({ statusCode, headers: {}, body: "{}" }) };
    const send = vi.spyOn(fixture.deps.documentClient, "send");
    try {
      await expect(resolveTaskReadAccess(fixture.deps, PRIYA, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      // The engine lookup is allowed; a refused core GET must not read the private task record.
      expect(send.mock.calls.some(([command]) => typeof command === "object" && command !== null && "input" in command && JSON.stringify(command.input).includes(`DEVTASK#${fixture.taskId}`))).toBe(false);
    } finally { send.mockRestore(); }
  });

  it("refuses a missing stored core task with the same not-found contract after a successful GET", async () => {
    const fixture = pageTask();
    fixture.db.set({ pk: `TASK_ENGINE#${fixture.taskId}`, sk: "STAMP", coreEngine: {
      engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "", stampedAt: "2026-11-22T00:00:00.000Z",
    } });
    fixture.deps.coreTasks = { route: async () => ({ statusCode: 200, headers: {}, body: "{}" }) };
    fixture.db.delete(`DEVTASK#${fixture.taskId}`, "META");
    await expect(resolveTaskReadAccess(fixture.deps, PRIYA, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("reads a valid core task through its authenticated GET and retains the owner's role", async () => {
    const fixture = pageTask();
    fixture.db.set({
      pk: `TASK_ENGINE#${fixture.taskId}`, sk: "STAMP",
      coreEngine: {
        engine: "core", areas: { flow: "core", build: "core", merge: "core" },
        flags: "", stampedAt: "2026-11-22T00:00:00.000Z",
      },
    });
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "{}" }));
    fixture.deps.coreTasks = { route };

    await expect(resolveTaskReadAccess(fixture.deps, PRIYA, fixture.taskId)).resolves.toMatchObject({
      role: "owner", task: { taskId: fixture.taskId, developerId: PRIYA.developerId },
    });
    expect(route).toHaveBeenCalledExactlyOnceWith({ method: "GET", path: `/v1/dev/tasks/${fixture.taskId}`, headers: {} }, PRIYA);
    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "publish")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("resolveTaskAccess", () => {
  it("the owner, a channel member who can use the project, and everyone else", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", pagePlan());
    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId)).resolves.toMatchObject({ role: "owner", task: { taskId: fixture.taskId } });
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({ role: "commenter" });

    // Someone signed in without Slack, a missing task and a malformed ID all read the same.
    const withoutSlack = await refusal(resolveTaskAccess(fixture.deps, { ...OMAR, slackUserId: undefined } as never, fixture.taskId));
    const missing = await refusal(resolveTaskAccess(fixture.deps, SAM, "8b579b4b-eaa7-4bf2-87bc-999999999999"));
    const malformed = await refusal(resolveTaskAccess(fixture.deps, SAM, "<b>nope</b>"));
    for (const error of [withoutSlack, missing, malformed]) expect([error.code, error.message]).toEqual([missing.code, missing.message]);
    expect(missing.code).toBe("TASK_NOT_FOUND");

    // A channel member who may not use the project reads as not found too.
    fixture.deps.checkAccess = async () => { throw Object.assign(new Error("PROJECT_ACCESS_DENIED: no"), { code: "PROJECT_ACCESS_DENIED" }); };
    expect((await refusal(resolveTaskAccess(fixture.deps, SAM, fixture.taskId))).code).toBe("TASK_NOT_FOUND");

  });

  it("the page view says what each reader may do", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", pagePlan());
    const owner = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    expect(owner.role).toBe("owner");
    expect(owner.access).toEqual({ role: "owner", canComment: true, canSuggest: false, canDecide: true, canAsk: true });
    const commenter = await getTaskDocumentView(fixture.deps, SAM, fixture.taskId);
    expect(commenter.role).toBe("reader");
    expect(commenter.access).toEqual({ role: "commenter", canComment: true, canSuggest: true, canDecide: false, canAsk: true });
    expect(commenter.comments).toEqual([]);
    expect(commenter.suggestions).toEqual([]);
    fixture.close();
    expect((await getTaskDocumentView(fixture.deps, SAM, fixture.taskId)).access).toEqual({ role: "commenter", canComment: false, canSuggest: false, canDecide: false, canAsk: false });
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId, "read")).resolves.toMatchObject({ role: "commenter" });
    expect((await refusal(resolveTaskAccess(fixture.deps, SAM, fixture.taskId, "comment"))).code).toBe("TASK_NOT_FOUND");
  });

  it("a reader outside the channel on this Slack workspace is told whom to ask", async () => {
    const fixture = pageTask();
    const denied = await refusal(resolveTaskAccess(fixture.deps, OMAR, fixture.taskId));
    expect(denied.code).toBe("TASK_ACCESS_DENIED");
    expect(denied.owners).toEqual([PRIYA.name]);
    // On another Slack workspace the same reader learns nothing.
    fixture.deps.slackTeamId = "T0OTHER01";
    expect((await refusal(resolveTaskAccess(fixture.deps, OMAR, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    // A task that is not shared into any channel is the owner's alone.
    const unshared = pageTask({ shared: false });
    expect((await refusal(resolveTaskAccess(unshared.deps, SAM, unshared.taskId))).code).toBe("TASK_NOT_FOUND");
    expect((await refusal(resolveTaskAccess(unshared.deps, PRIYA, unshared.taskId, "peopleManage"))).code).toBe("TASK_NOT_FOUND");
  });

  it("a membership lookup failure reads as no access", async () => {
    const fixture = pageTask();
    const logged: Array<Record<string, unknown>> = [];
    fixture.deps.log = (entry) => { logged.push(entry); };
    fixture.deps.channelMember = async () => { throw Object.assign(new Error("SLACK_UNAVAILABLE: down"), { code: "SLACK_UNAVAILABLE" }); };
    expect((await refusal(resolveTaskAccess(fixture.deps, SAM, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    expect(logged).toContainEqual(expect.objectContaining({ event: "developer.task_page_membership_unavailable", taskId: fixture.taskId }));
  });

  it("the action table includes every C role and retained human action", () => {
    expect(TASK_ACTION_ROLES).toEqual({
      read: ["owner", "commenter", "viewer"], peopleRead: ["owner", "commenter", "viewer"],
      comment: ["owner", "commenter"], ask: ["owner", "commenter"], suggest: ["commenter"],
      decide: ["owner"], retry: ["owner"], publish: ["owner"], feedback: ["owner"], close: ["owner"], control: ["owner"], peopleManage: ["owner"],
      takeOwnership: ["owner", "commenter", "viewer"],
    });
    expect(["read", "comment", "suggest", "ask"].every((action) => can("commenter", action as never))).toBe(true);
    expect(can("commenter", "decide")).toBe(false);
    expect(can("owner", "decide")).toBe(true);
    expect(can("owner", "suggest")).toBe(false);
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "peopleRead")).toBe(true);
    expect(can("viewer", "comment")).toBe(false);
  });

  it("enforces a readable sidecar, denied tombstones, owner actor IDs, and terminal write refusal", async () => {
    const fixture = pageTask();
    fixture.db.set({
      pk: `DEVTASK#${fixture.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false,
      people: [
        { developerId: PRIYA.developerId, slackUserId: PRIYA.slackUserId, name: PRIYA.name, role: "owner" },
        { developerId: SAM.developerId, slackUserId: SAM.slackUserId, name: SAM.name, role: "viewer" },
        { developerId: OMAR.developerId, slackUserId: OMAR.slackUserId, name: OMAR.name, role: "denied" },
      ],
    });
    fixture.deps.taskPeopleConfiguration = { peopleChangesEnabled: true };
    fixture.deps.checkTaskPerson = async (_task, developerId) => {
      const caller = [PRIYA, SAM, OMAR].find((candidate) => candidate.developerId === developerId);
      if (caller === undefined || caller.slackUserId === undefined) throw new Error("unknown");
      return {
        subject: { developerId, slackUserId: caller.slackUserId },
        identity: { developerId, slackUserId: caller.slackUserId, name: caller.name, method: "slack", issuer: "https://slack.com", subject: caller.slackUserId },
        eligible: true, channelMember: true,
      };
    };

    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "peopleManage")).resolves.toMatchObject({
      role: "owner", peopleRevision: 4, ownerActorIds: [taskOwnerKey(PRIYA.developerId, fixture.taskId)],
    });
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({ role: "viewer", peopleRevision: 4 });
    expect((await refusal(resolveTaskAccess(fixture.deps, OMAR, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    fixture.deps.taskPeopleConfiguration = { peopleChangesEnabled: false };
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({ role: "viewer", peopleRevision: 4 });
    expect((await refusal(resolveTaskAccess(fixture.deps, OMAR, fixture.taskId))).code).toBe("TASK_NOT_FOUND");

    fixture.close();
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId, "read")).resolves.toMatchObject({ role: "viewer" });
    expect((await refusal(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "comment"))).code).toBe("TASK_NOT_FOUND");
  });

});

it("task-page membership carries the authoritative task workspace through the callback", async () => {
  for (const [companyId, teamId] of [["org_aaaaaaaaaaaaaaaaaaaa", "T0AAAAAAA"], ["org_bbbbbbbbbbbbbbbbbbbb", "T0BBBBBBB"]]) {
    const fixture = pageTask();
    const workspace = { companyId: companyId!, teamId: teamId! };
    fixture.deps.workspaceForTask = async () => workspace;
    const calls: unknown[] = [];
    fixture.deps.channelMember = async (...args) => { calls.push(args); return true; };
    await expect(resolveTaskAccess(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({ role: "commenter" });
    expect(calls).toEqual([[SAM.slackUserId, (fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!.share as { channelId: string }).channelId, workspace]]);
  }
});
