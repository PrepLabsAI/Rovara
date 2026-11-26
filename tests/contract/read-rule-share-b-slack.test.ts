// READ-RULE-SHARE-B (owner DEC 254zzz577), rule 1 for the Slack CHANNEL share: a person the People list does not name reads the task as the share's implicit commenter only when the install's OWN Slack workspace proves them, live. A Slack Connect guest
// (a person of another workspace in the shared channel) and a task shared into a foreign workspace's channel are refused, on the REAL Slack proof (`slackDirectory.taskPersonProof` -> `checkTaskPersonIdentity` -> `resolveTaskPeopleAccess`),
// and REMOVAL WINS (rule 2): the same person named `denied` on the People list is refused though they are in the channel.
import { describe, expect, it } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import { resolveTaskPeopleAccess, type TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TEAM = "T0INSTALL1";
const FOREIGN_TEAM = "T0FOREIGN1";
const CHANNEL = "C0SHARED01";
const START = Date.parse("2026-11-25T10:00:00.000Z");
const OWNER_SLACK = "U0OWNER001";
const MEMBER_SLACK = "U0MEMBER01";
const GUEST_SLACK = "U0GUEST001";
const OWNER = developerIdForSlackUser(OWNER_SLACK);
const MEMBER = developerIdForSlackUser(MEMBER_SLACK);
const GUEST = developerIdForSlackUser(GUEST_SLACK);

const taskOf = (shareTeam: string): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, developerId: OWNER, provider: "slack", developerName: "Owner", slackUserId: OWNER_SLACK,
  client: "slack", project: "payments", title: "Payments", workspaceId: "workspace", ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: true, share: { teamId: shareTeam, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: new Date(START).toISOString() },
  createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(), workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" } as never,
}) as unknown as DeveloperTaskRecord;

/** What Slack says: each user's profile (`users.info`) and the members of the shared channel. */
interface World { users: Record<string, Record<string, unknown>>; members: string[]; installTeam: string }
const native = (id: string): Record<string, unknown> => ({ id, team_id: TEAM, is_bot: false });

function peopleDeps(world: World, task: DeveloperTaskRecord, caller: string, callerSlack: string, listed: Array<Record<string, unknown>>) {
  const db = new FakeDynamoDb();
  db.set(task as unknown as Record<string, unknown>);
  db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: listed });
  const directory = slackDirectory({ teamId: world.installTeam, now: () => START, botToken: async () => "INERT", fetch: async (input) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.pathname.endsWith("/users.info")) {
      const user = world.users[url.searchParams.get("user") ?? ""];
      return Response.json(user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user });
    }
    return Response.json({ ok: true, members: world.members, response_metadata: { next_cursor: "" } });
  } });
  const identity = { documentClient: db, tableName: "state", slackTeamId: world.installTeam, now: () => START, uuid: () => TASK_ID,
    trustedCaller: { developerId: caller, amr: "slack" as const, slackUserId: callerSlack, name: "Reader" },
    taskPersonProof: async (request: { slackUserId: string; channelIds: readonly string[] }) => directory.taskPersonProof(request.slackUserId, request.channelIds),
    developerRecord: async () => undefined, projectChannelIds: async () => [CHANNEL], targetProjectAccess: async () => "channel" as const };
  const deps: TaskPeopleDependencies = { documentClient: db, tableName: "state", now: () => START, taskPeopleConfiguration: { peopleChangesEnabled: false },
    checkTaskPerson: async (current, id) => checkTaskPersonIdentity(identity, current, id) };
  return { db, deps };
}
const ownerEntry = { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Owner", role: "owner" };

describe("the Slack channel share needs the install's own workspace (rule 1)", () => {
  it("a person of the install's own workspace, in the shared channel and not on the People list, reads as the share's implicit commenter (the control)", async () => {
    const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [MEMBER_SLACK]: native(MEMBER_SLACK) }, members: [OWNER_SLACK, MEMBER_SLACK], installTeam: TEAM };
    const { deps } = peopleDeps(world, taskOf(TEAM), MEMBER, MEMBER_SLACK, [ownerEntry]);
    await expect(resolveTaskPeopleAccess(deps, taskOf(TEAM), MEMBER)).resolves.toMatchObject({ role: "commenter", implicit: true });
  });

  it("a Slack Connect guest (a person of ANOTHER workspace, in the shared channel) is refused, whether Slack calls them a stranger of this workspace or says nothing about their team", async () => {
    // The guest's own workspace is theirs, and the profile says so: not the install's team, no linkage to it.
    for (const profile of [
      { id: GUEST_SLACK, team_id: FOREIGN_TEAM, is_bot: false },
      { id: GUEST_SLACK, team_id: FOREIGN_TEAM, is_bot: false, is_stranger: true },
      { id: GUEST_SLACK, team_id: FOREIGN_TEAM, is_bot: false, enterprise_user: { teams: [FOREIGN_TEAM] } },
    ]) {
      const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [GUEST_SLACK]: profile }, members: [OWNER_SLACK, GUEST_SLACK], installTeam: TEAM };
      const { deps } = peopleDeps(world, taskOf(TEAM), GUEST, GUEST_SLACK, [ownerEntry]);
      await expect(resolveTaskPeopleAccess(deps, taskOf(TEAM), GUEST), JSON.stringify(profile)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    }
  });

  it("the install's own team is compared on the proof itself, not only on the directory's eligibility: a proof that says ok for a user of another team is refused (and the same proof for the install's team is the control)", async () => {
    const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [GUEST_SLACK]: native(GUEST_SLACK) }, members: [OWNER_SLACK, GUEST_SLACK], installTeam: TEAM };
    const { deps: base } = peopleDeps(world, taskOf(TEAM), GUEST, GUEST_SLACK, [ownerEntry]);
    const proofWith = (teamId: string) => async (request: { slackUserId: string; channelIds: readonly string[] }) => ({ ok: true as const, user: { id: request.slackUserId, teamId, name: "Guest" }, memberOf: [CHANNEL] });
    const withProof = (teamId: string) => {
      const { db } = peopleDeps(world, taskOf(TEAM), GUEST, GUEST_SLACK, [ownerEntry]);
      const identity = { documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => START, uuid: () => TASK_ID,
        trustedCaller: { developerId: GUEST, amr: "slack" as const, slackUserId: GUEST_SLACK, name: "Guest" }, taskPersonProof: proofWith(teamId),
        developerRecord: async () => undefined, projectChannelIds: async () => [CHANNEL], targetProjectAccess: async () => "channel" as const };
      return { ...base, documentClient: db, checkTaskPerson: async (current: DeveloperTaskRecord, id: string) => id === OWNER ? (await base.checkTaskPerson!(current, id)) : checkTaskPersonIdentity(identity, current, id) };
    };
    await expect(resolveTaskPeopleAccess(withProof(TEAM), taskOf(TEAM), GUEST)).resolves.toMatchObject({ role: "commenter", implicit: true });
    await expect(resolveTaskPeopleAccess(withProof(FOREIGN_TEAM), taskOf(TEAM), GUEST)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("a task shared into a FOREIGN workspace's channel gives its members nothing here, even a person of the install's own workspace", async () => {
    const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [MEMBER_SLACK]: native(MEMBER_SLACK) }, members: [OWNER_SLACK, MEMBER_SLACK], installTeam: TEAM };
    const { deps } = peopleDeps(world, taskOf(FOREIGN_TEAM), MEMBER, MEMBER_SLACK, [ownerEntry]);
    await expect(resolveTaskPeopleAccess(deps, taskOf(FOREIGN_TEAM), MEMBER)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("a person who left the shared channel reads nothing (the membership is read live, not remembered)", async () => {
    const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [MEMBER_SLACK]: native(MEMBER_SLACK) }, members: [OWNER_SLACK], installTeam: TEAM };
    const { deps } = peopleDeps(world, taskOf(TEAM), MEMBER, MEMBER_SLACK, [ownerEntry]);
    await expect(resolveTaskPeopleAccess(deps, taskOf(TEAM), MEMBER)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});

describe("REMOVAL WINS over the Slack channel share (rule 2)", () => {
  it("a person of the install's own workspace, in the shared channel, whom the People list names `denied` (a deny, or a removal) reads nothing; the same person not named reads (the control above)", async () => {
    const world: World = { users: { [OWNER_SLACK]: native(OWNER_SLACK), [MEMBER_SLACK]: native(MEMBER_SLACK) }, members: [OWNER_SLACK, MEMBER_SLACK], installTeam: TEAM };
    const denied = { developerId: MEMBER, slackUserId: MEMBER_SLACK, name: "Member", role: "denied" };
    const { deps } = peopleDeps(world, taskOf(TEAM), MEMBER, MEMBER_SLACK, [ownerEntry, denied]);
    await expect(resolveTaskPeopleAccess(deps, taskOf(TEAM), MEMBER)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});
