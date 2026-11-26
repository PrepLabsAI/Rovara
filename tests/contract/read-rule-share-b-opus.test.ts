// READ-RULE-SHARE-B Opus review (owner DEC 254zzz577), two cells the lane's tests did not pin:
// 1. REMOVAL WINS at the stored share's comment write when the deny lands AFTER the write's own read of the People list (the S1 fix covers a deny before it): the People revision fence of the same transaction refuses it.
// 2. What the Slack CHANNEL share needs today on the REAL Slack proof: the person must reach the PROJECT (a grant, or a bound channel of a project that lets channel members use it). A same-company person in the shared
//    channel with no project access at all is refused (the proof's `targetProjectAccess` says PROJECT_ACCESS_DENIED). This pins the code as it is; owner rule 1 asks for "no project access" for the channel share too
//    (see READ-RULE-SHARE-B-REVIEW-OPUS.md): if the owner widens it, this test is the one to flip.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import { resolveTaskPeopleAccess, type TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { PRIYA, pagePlan, pageTask } from "../support/page-tasks.js";
import { authorizeFor } from "../support/read-rule-authorize.js";

const COMPANY = "org_corehost00000000000a";

describe("REMOVAL WINS at the stored share's comment write, after the write read the People list", () => {
  it("a deny that lands between the write's list read and its transaction fails the People fence: nothing is written", async () => {
    const h = pageTask();
    h.addVersion("plan", pagePlan());
    h.deps.companyId = COMPANY;
    const meta = { pk: `DEVTASK#${h.taskId}`, sk: "META" };
    h.db.set({ ...h.db.get(meta.pk, meta.sk)!, companyId: COMPANY });
    h.db.set({ ...coreTaskMarkKey(h.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "all", stampedAt: new Date().toISOString() } });
    const SHARED = "9".repeat(64);
    const ownerEntry = { developerId: PRIYA.developerId, name: PRIYA.name, method: "oidc", role: "owner" };
    h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: `READER#${SHARED}`, role: "viewer" });
    h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [ownerEntry] });
    const base = h.deps.documentClient;
    let denyBeforeTransaction = false;
    const documentClient = {
      send: async (command: unknown) => {
        // The owner's deny commits after every read of this request and just before the comment's transaction.
        if (denyBeforeTransaction && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
          h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: [ownerEntry, { developerId: SHARED, name: "Reader", method: "oidc", role: "denied" }] });
        }
        return await base.send(command);
      },
    };
    const post = async (deny: boolean) => {
      denyBeforeTransaction = deny;
      const routes = createCoreTaskRuleRoutes(() => ({ ...h.deps, documentClient, taskReaderPerson: async () => ({ name: "Reader", projectMember: false, companyMember: true }) }));
      const path = `/v1/dev/tasks/${h.taskId}/comments`;
      const principal = { companyId: COMPANY as never, personId: SHARED, displayName: "Reader", roles: ["member" as const], provider: HOSTED_IDENTITY_PROVIDER };
      try {
        const answer = await routes.route({ request: { method: "POST", path, headers: {}, body: JSON.stringify({ requestId: randomUUID(), document: "plan", text: "Looks right to me.", anchor: "claim:2.1" }) }, path,
          person: { developerId: SHARED, name: "Reader" }, companyId: COMPANY, task: h.db.get(meta.pk, meta.sk)!, store: { query: async () => ({ items: [] }) },
          authorize: authorizeFor(routes, { companyId: COMPANY, principal, task: h.db.get(meta.pk, meta.sk)! }) });
        return answer.statusCode;
      } catch { return "refused"; }
    };
    const comments = () => h.db.find((item) => item.entityType === "TASK_COMMENT").length;
    // The deny lands just before the transaction: refused, no row.
    expect(await post(true)).not.toBe(200);
    expect(comments(), "no comment row for the denied person").toBe(0);
    // The control: the same share with the list unchanged (rev 1 again, the person not named) writes.
    h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: [ownerEntry] });
    expect(await post(false)).toBe(200);
    expect(comments()).toBe(1);
  });
});

describe("the Slack channel share on the REAL proof needs project access today (owner rule 1 asks for none: an open owner question)", () => {
  const TASK_ID = "11111111-1111-4111-8111-111111111111";
  const TEAM = "T0INSTALL1";
  const CHANNEL = "C0SHARED01";
  const START = Date.parse("2026-11-25T10:00:00.000Z");
  const OWNER_SLACK = "U0OWNER001";
  const MEMBER_SLACK = "U0MEMBER01";
  const OWNER = developerIdForSlackUser(OWNER_SLACK);
  const MEMBER = developerIdForSlackUser(MEMBER_SLACK);
  const task = {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, developerId: OWNER, provider: "slack", developerName: "Owner", slackUserId: OWNER_SLACK,
    client: "slack", project: "payments", title: "Payments", workspaceId: "workspace", ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: new Date(START).toISOString() },
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(), workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" },
  } as unknown as DeveloperTaskRecord;

  function depsWith(targetProjectAccess: () => Promise<"granted" | "channel">): TaskPeopleDependencies {
    const db = new FakeDynamoDb();
    db.set(task as unknown as Record<string, unknown>);
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Owner", role: "owner" }] });
    const directory = slackDirectory({ teamId: TEAM, now: () => START, botToken: async () => "INERT", fetch: async (input) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      if (url.pathname.endsWith("/users.info")) return Response.json({ ok: true, user: { id: url.searchParams.get("user"), team_id: TEAM, is_bot: false } });
      return Response.json({ ok: true, members: [OWNER_SLACK, MEMBER_SLACK], response_metadata: { next_cursor: "" } });
    } });
    const identity = { documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => START, uuid: () => TASK_ID,
      trustedCaller: { developerId: MEMBER, amr: "slack" as const, slackUserId: MEMBER_SLACK, name: "Member" },
      taskPersonProof: async (request: { slackUserId: string; channelIds: readonly string[] }) => directory.taskPersonProof(request.slackUserId, request.channelIds),
      developerRecord: async () => undefined, projectChannelIds: async () => [] as string[], targetProjectAccess };
    return { documentClient: db, tableName: "state", now: () => START, taskPeopleConfiguration: { peopleChangesEnabled: false }, checkTaskPerson: async (current, id) => checkTaskPersonIdentity(identity, current, id) };
  }

  it("a same-workspace person in the shared channel who reaches the project (a bound channel) reads as the implicit commenter; with NO project access at all (the binding's PROJECT_ACCESS_DENIED) they are refused", async () => {
    await expect(resolveTaskPeopleAccess(depsWith(async () => "channel"), task, MEMBER)).resolves.toMatchObject({ role: "commenter", implicit: true });
    // aws/developer-routes.ts targetProjectAccess: no grant and no bound channel of the project -> PROJECT_ACCESS_DENIED, which the proof reads as "not eligible".
    const noProjectAccess = async (): Promise<never> => { throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified"); };
    await expect(resolveTaskPeopleAccess(depsWith(noProjectAccess), task, MEMBER)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});
