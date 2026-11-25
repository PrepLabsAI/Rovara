// PROJECT-GRANT-RECHECK, ARCH QUESTION (3): on the NEW (core) engine, what can a person with NO project grant who is in the project's bound Slack channel (a channel-only person) actually do?
// One test per path, each over the real code of that path (hostedTaskAccess over real grant lookups and a real People list; the page's `resolveCoreTaskAccess`; the core's task rule routes).
// The answers are pinned here so the release notes and the next lane read them from a test, not from the code.
import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId, type Principal } from "@agentx/contracts";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import { hostedTaskAccess, NO_PROJECT_GRANT, projectGrantRoleFromDynamo } from "../../packages/broker/src/aws/core-engine-root.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { resolveCoreTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import type { TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { authorizeFor } from "../support/read-rule-authorize.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyRouteHarness, PERSON, TASK, TIME } from "../support/company-route-harness.js";

const COMPANY = FAKE_COMPANY as OrgId;
const STARTER = "a".repeat(64);   // started the task, holds a grant
const CHANNEL_ONLY = "b".repeat(64); // in the bound channel, no grant
const principal = (personId: string): Principal => ({ companyId: COMPANY, personId, displayName: personId.slice(0, 4), roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });
const task = { taskId: "11111111-1111-4111-8111-111111111111", developerId: STARTER, project: "payments", ownerKey: "k" };

/** The hosted access over a real grant lookup (only STARTER holds a grant; CHANNEL_ONLY is in the bound channel and has none) and a real stored People list. */
async function world(people: Array<[string, "owner" | "commenter" | "viewer"]>) {
  const w = createFakeWorld();
  const db = new FakeDynamoDb({ seed: 7 });
  db.set({ pk: `ORG#${COMPANY}#MEMBER#${STARTER}`, sk: "PROJECT#payments", entityType: "PROJECT_GRANT", companyId: COMPANY, projectName: "payments", role: "developer" });
  db.set({ pk: `ORG#${COMPANY}#SLACK_BINDING#T0SHARED`, sk: "CHANNEL#C0SHARED", teamId: "T0SHARED", channelId: "C0SHARED", projectName: "payments", updatedAt: TIME });
  await w.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "META", companyId: COMPANY, developerId: STARTER, project: "payments", ownerKey: "k", taskId: task.taskId } });
  await w.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: people.map(([developerId, role]) => ({ developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}`, name: `Person ${developerId.slice(0, 4)}`, role })) } });
  const grantRole = projectGrantRoleFromDynamo(db, "state");
  // The Slack People proof (task-person-identity.ts `targetProjectAccess`, the start's own rule) admits a channel member: eligible and present.
  const check = async (_task: unknown, developerId: string) => ({ subject: { developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}` }, identity: { developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}`, name: `Person ${developerId.slice(0, 4)}`, method: "slack", issuer: "https://slack.com", subject: developerId }, eligible: true, channelMember: true });
  const peopleDeps: TaskPeopleDependencies = { documentClient: { send: async (command) => ({ Item: await w.store.get((command as GetCommand).input.Key as { pk: string; sk: string }) }) }, tableName: "state", now: () => w.clock.now, checkTaskPerson: check as never };
  return hostedTaskAccess({ companyId: COMPANY, membershipOf: async () => ({ companyId: COMPANY, role: "member" }), projectGrant: async (p, project, c) => (await grantRole(p, project, c ?? COMPANY)) !== undefined, storage: async () => w.store, people: peopleDeps });
}

describe("a channel-only person on the NEW engine (no grant, in the bound Slack channel)", () => {
  it("opening a task by its link: refused (canRead and canAct false), whoever else is on it", async () => {
    const access = await world([[STARTER, "owner"]]);
    expect(await access.canRead?.(principal(CHANNEL_ONLY), task)).toBe(false);
    expect(await access.canAct?.(principal(CHANNEL_ONLY), task)).toBe(false);
    // control: the starter, with a grant
    expect(await access.canRead?.(principal(STARTER), task)).toBe(true);
  });

  it("on the task's People list as a viewer, a commenter or even an OWNER: still refused every read and act (the hosted resolve needs the grant for every role)", async () => {
    for (const role of ["viewer", "commenter", "owner"] as const) {
      const access = await world([[STARTER, "owner"], [CHANNEL_ONLY, role]]);
      expect([role, await access.canRead?.(principal(CHANNEL_ONLY), task), await access.canAct?.(principal(CHANNEL_ONLY), task)]).toEqual([role, false, false]);
    }
  });

  it("starting a task, and speaking in a task's Slack thread for Rovara to act on (`acting` = checkStart AND ownerActing): refused", async () => {
    const access = await world([[STARTER, "owner"], [CHANNEL_ONLY, "owner"]]);
    expect(await access.checkStart(principal(CHANNEL_ONLY), "payments")).toMatchObject({ allowed: false, message: NO_PROJECT_GRANT });
    expect(await access.ownerActing!(principal(CHANNEL_ONLY), task)).toBeUndefined();
    expect(await access.checkStart(principal(STARTER), "payments")).toEqual({ allowed: true });
  });
});

describe("a channel-only person on the NEW engine: the old routes that still ask the start's rule (the page and the core's task rule routes)", () => {
  const caller: DeveloperCaller = { developerId: PERSON, sessionId: "session", amr: "slack", name: "Test Person", slackUserId: "U0SHARED" };
  /** A core task someone else started and shared into the channel (its Slack thread), the person in the channel with no grant. */
  function sharedCoreTask() {
    // No company Slack layer in this harness: the page's `checkAccess` then answers the install's own team (a company install needs its workspace service for the same answer).
    const h = companyRouteHarness();
    h.project(undefined, "channel"); h.task(TASK, IMPLICIT_COMPANY_ID);
    h.db.set({ ...h.db.get(`DEVTASK#${TASK}`, "META")!, developerId: "e".repeat(64), ownerKey: "e".repeat(64), share: { teamId: "T0SHARED", channelId: "C0SHARED", threadTs: "1700000000.000100" } });
    h.db.set({ ...engineStampKey(TASK), entityType: "TASK_ENGINE", orgId: IMPLICIT_COMPANY_ID, taskId: TASK, coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "test", stampedAt: TIME } });
    return h;
  }
  const row = (h: ReturnType<typeof companyRouteHarness>) => h.db.get(`DEVTASK#${TASK}`, "META") as never;

  it("the page's access (`resolveCoreTaskAccess`, which plan comments and the diff use): a COMMENTER, who may read and comment, never act", async () => {
    const h = sharedCoreTask();
    const deps = developerTaskRouteDependencies(h.deps, caller);
    expect((await resolveCoreTaskAccess(deps, caller, row(h), "read")).role).toBe("commenter");
    expect((await resolveCoreTaskAccess(deps, caller, row(h), "comment")).role).toBe("commenter");
    await expect(resolveCoreTaskAccess(deps, caller, row(h), "decide")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("the core's events and readers routes for the same person: refused (their own task or a reader only)", async () => {
    const h = sharedCoreTask();
    const routes = createCoreTaskRuleRoutes((_person, companyId) => ({ ...developerTaskRouteDependencies(h.deps, caller), companyId }));
    for (const rest of ["events", "readers"]) {
      const path = `/v1/dev/tasks/${TASK}/${rest}`;
      await expect(routes.route({ request: { method: "GET", path, headers: {} }, path, person: { developerId: PERSON, name: "Test Person" }, companyId: IMPLICIT_COMPANY_ID, task: row(h), store: { query: async () => ({ items: [] }) }, authorize: authorizeFor(routes, { companyId: IMPLICIT_COMPANY_ID, principal: { companyId: IMPLICIT_COMPANY_ID, personId: PERSON, displayName: "Test Person", roles: ["member"], provider: "rovara-sign-in" }, task: row(h) }) })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    }
  });
});
