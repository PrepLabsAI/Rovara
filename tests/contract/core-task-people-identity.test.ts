import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { loadOwnedTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentXError, SLACK_OIDC_ISSUER, type DeveloperSignInMethod } from "@agentx/contracts";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { HOSTED_TASK_SIGN_IN_METHODS, isHostedTaskSignInMethod, checkTaskPersonIdentity, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import { taskPeopleDisplayAdmission } from "../../packages/broker/src/developer/task-people-display-budget.js";
import { prepareTaskPeopleStart } from "../../packages/broker/src/developer/task-people-start.js";
import { getTaskPeople, type TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { developerRecordKeyedBy, type DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { readsAsRow } from "../support/code-api-row-read.js";

/** "attribute": the record carries `developerId` (the old fixture shape). "key": the REAL stored shape, the id only in `pk`. */
type RecordShape = "attribute" | "key";

async function world(method: DeveloperSignInMethod = "cloud", linked = false, initialize = false, shape: RecordShape = "attribute") {
  const h = createHarness();
  await h.registerProject();
  const issuer = method === "slack" ? SLACK_OIDC_ISSUER : "https://signin.example.test";
  const subject = method === "slack" ? "U0OWNER01" : "owner";
  const developerId = ownerKeyForSubject(issuer, subject);
  const caller = { ...h.owner, principal: { ...h.owner.principal, provider: "rovara-sign-in", personId: developerId, displayName: "Owner" } };
  if (linked || method === "slack") Object.assign(caller, { slackUserId: "U0OWNER01" });
  const db = new FakeDynamoDb();
  const record: DeveloperRecord = { developerId, provider: method, issuer, subject, displayName: "Owner", revoked: false, firstSignInAt: new Date(h.clock.now).toISOString(), lastSignInAt: new Date(h.clock.now).toISOString(), ...(linked || method === "slack" ? { slackUserId: "U0OWNER01" } : {}) };
  const documentClient = { send: (command: unknown) => db.send(command as never) };
  const storedRow = (): DeveloperRecord | undefined => {
    const { developerId: _kept, ...withoutId } = record;
    void _kept;
    return { pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", ...(shape === "key" ? withoutId : record) } as unknown as DeveloperRecord;
  };
  const identity: TaskPersonIdentityDependencies = {
    documentClient, tableName: "state", now: () => h.clock.now, uuid: randomUUID, slackTeamId: "T0TEAM001",
    // The reader every route wires: the stored row keyed by its id (real rows have no `developerId` attribute), the id taken from the key.
    developerRecord: async id => developerRecordKeyedBy(storedRow(), id),
    companyMembership: async () => ({ companyId: h.deps.companyId }), projectGrant: async () => true,
    projectChannelIds: async () => [], targetProjectAccess: async () => {},
    taskPersonProof: async request => ({ ok: true, user: { id: request.slackUserId, teamId: "T0TEAM001", name: "Owner" }, memberOf: [] }),
  };
  const people: TaskPeopleDependencies = { documentClient, tableName: "state", now: () => h.clock.now, taskPeopleConfiguration: { peopleChangesEnabled: true }, checkTaskPerson: (task, id) => checkTaskPersonIdentity(identity, task, id) };
  const started = await h.flow.start(caller, { requestId: newRequestId(), project: "payments", instructions: "Fix payments", workflow: true, workflowPath: "QUICK" });
  const stored = await h.store.get({ pk: `DEVTASK#${started.task.taskId}`, sk: "META" });
  const task = stored as unknown as DeveloperTaskRecord;
  if (initialize) await h.store.transact(await prepareTaskPeopleStart(identity, task));
  for (const row of (await h.store.query({ pk: task.pk })).items) db.set(row);
  db.set(task as unknown as Record<string, unknown>);
  const webCaller = { developerId, sessionId: "core", name: "Owner", amr: method };
  return { h, db, task, record, identity, people, webCaller, developerId, storedRow };
}

describe("People on a task made by real core start", () => {

  it.each([["attribute", false], ["attribute", true], ["key", false], ["key", true]] as const)("dispatches a real core start with no People runtime (record shape=%s, People opened first=%s)", async (shape, openedFirst) => {
    const w = await world("cloud", false, false, shape);
    if (openedFirst) await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    w.h.deps.deliveryAccess = async (_deps, operation, workspace) => {
      for (const pk of [w.task.pk, workspace.pk]) {
        for (const row of (await w.h.store.query({ pk })).items) w.db.set(row);
      }
      return guardTaskDispatch({ documentClient: w.db, tableName: "state", core: { companyId: w.h.deps.companyId, workspacePk: workspace.pk } }, {
        id: "dispatch-core-start", workspaceId: workspace.id, operationId: operation.id, invocation: { kind: operation.dispatch.kind, fence: operation.fence },
      });
    };
    let delivered = 0;
    for (let i = 0; i < 12; i++) { delivered += (await w.h.flow.dispatchOnce({ maxMessages: 10 })).delivered; w.h.clock.advance(70); }
    expect(delivered).toBe(1);
    // The core keeps the delivered operation in DISPATCHING until the worker reports RUNNING.
    expect((await w.h.flow.get(w.h.owner, w.task.taskId)).operations[0]).toMatchObject({ kind: "prepare", status: "DISPATCHING" });
    if (openedFirst) expect(w.db.get(w.task.pk, "PEOPLE")).toMatchObject({ revision: 1, people: [{ developerId: w.developerId, role: "owner" }] });
    else expect(w.db.get(w.task.pk, "PEOPLE")).toBeUndefined();
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    const rows = w.db.find(row => row.pk === w.task.pk && /^(PEOPLE|PERSON#|PERSON_SUBJECT#)/u.test(String(row.sk)));
    expect(rows).toHaveLength(3);
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    expect(w.db.find(row => row.pk === w.task.pk && /^(PEOPLE|PERSON#|PERSON_SUBJECT#)/u.test(String(row.sk)))).toEqual(rows);
  });

  it.each([false, true])("hides an unassigned same-company member on task reads and actions (display=%s)", async display => {
    const w = await world();
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    if (display) w.people.createTaskPeopleDisplayAdmission = () => taskPeopleDisplayAdmission({ now: () => w.h.clock.now, read: async () => { throw new Error("unused"); } });
    const subject = "other-person";
    const developerId = ownerKeyForSubject(w.record.issuer, subject);
    w.identity.developerRecord = async id => id === developerId ? { ...w.record, developerId, subject } : w.record;
    w.h.deps.access = hostedTaskAccess({ companyId: w.h.deps.companyId, membershipOf: async () => ({ companyId: w.h.deps.companyId, role: "member" }), projectGrant: async () => true, storage: async () => w.h.store, people: w.people });
    const caller = { principal: { ...w.h.owner.principal, provider: "rovara-sign-in", personId: developerId } };
    await expect(w.h.flow.get(caller, w.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(loadOwnedTask(w.h.deps, caller, w.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(getTaskPeople(w.people, { ...w.webCaller, developerId }, w.task.taskId)).rejects.toMatchObject({ code: display ? "RUNTIME_UNAVAILABLE" : "TASK_ACCESS_DENIED" });
    w.identity.developerRecord = async () => { throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable"); };
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it.each(["future-method", "rovara-sign-in", "local-owner", "Cloud", "cloudx", "", null, undefined, 1, {}])("rejects an unsupported concrete sign-in method %s", method => {
    expect(isHostedTaskSignInMethod(method)).toBe(false);
  });
  it("the documented GET /v1/dev/tasks/{id}/people input returns its owner's view", async () => {
    const w = await world("cloud", false, true);
    const path = `/v1/dev/tasks/${w.task.taskId}/people`;
    const routes = createCoreTaskRuleRoutes(() => w.people as unknown as DeveloperTaskRouteDependencies);
    const answer = await routes.route({ request: { method: "GET", path, headers: {} }, path, person: { developerId: w.developerId, name: "Owner" }, companyId: w.h.deps.companyId, task: w.task as unknown as Record<string, unknown>, store: w.h.store, authorize: async () => { throw new Error("the read rule was asked"); } });
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ view: { canManage: true, people: [{ you: true, role: "owner", method: "cloud" }] } });
    readsAsRow("tasks.people", JSON.parse(answer.body));
  });
  it.each([false, true])("only the cold owner receives a specific People proof refusal (display=%s)", async display => {
    for (const owner of [false, true]) {
      const w = await world();
      if (display) w.people.createTaskPeopleDisplayAdmission = () => taskPeopleDisplayAdmission({ now: () => w.h.clock.now, read: async () => { throw new Error("unused"); } });
      w.people.checkTaskPerson = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "specific proof refusal"); };
      await expect(getTaskPeople(w.people, { ...w.webCaller, developerId: owner ? w.developerId : "f".repeat(64) }, w.task.taskId)).rejects.toMatchObject({ code: owner ? "PROJECT_ACCESS_DENIED" : "TASK_ACCESS_DENIED" });
      expect(w.db.get(w.task.pk, "PEOPLE")).toBeUndefined();
    }
  });

  it.each(["owner", "commenter", "viewer", "denied", "absent"])("only an assigned reader receives a specific People refusal (role=%s)", async role => {
    const w = await world();
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    const people = w.db.get(w.task.pk, "PEOPLE")!;
    w.db.set({ ...people, people: role === "absent" ? [] : [{ ...(people.people as object[])[0], role }] });
    w.people.checkTaskPerson = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "specific proof refusal"); };
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: role === "denied" || role === "absent" ? "TASK_ACCESS_DENIED" : "PROJECT_ACCESS_DENIED" });
  });

  it.each([false, true])("legacy People reads retain generic proof refusals (display=%s)", async display => {
    const w = await world();
    Object.assign(w.task, { provider: "cloud" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    if (display) w.people.createTaskPeopleDisplayAdmission = () => taskPeopleDisplayAdmission({ now: () => w.h.clock.now, read: async () => { throw new Error("unused"); } });
    w.people.checkTaskPerson = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "specific proof refusal"); };
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("does not fall back to creator access after a proof denial when People disappears", async () => {
    const w = await world();
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    // The identity proof reads the existing People row; the later fallback read would see it absent.
    const access = hostedTaskAccess({ companyId: w.h.deps.companyId, membershipOf: async () => ({ companyId: w.h.deps.companyId, role: "member" }), projectGrant: async () => true, storage: async () => w.h.store, people: w.people });
    w.people.checkTaskPerson = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "task access could not be verified"); };
    const principal = { ...w.h.owner.principal, personId: w.developerId, provider: "rovara-sign-in" };
    expect(await access.canAct(principal, w.task)).toBe(false);
  });

  it("task access propagates an unexpected store failure instead of hiding it as a missing task", async () => {
    const w = await world();
    await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    const access = hostedTaskAccess({ companyId: w.h.deps.companyId, membershipOf: async () => ({ companyId: w.h.deps.companyId, role: "member" }), projectGrant: async () => true, storage: async () => w.h.store, people: { ...w.people, documentClient: { send: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "state unavailable"); } } } });
    await expect(access.canAct(w.h.owner.principal, w.task)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("pins the exact hosted method set", () => {
    expect(HOSTED_TASK_SIGN_IN_METHODS).toEqual(["slack", "oidc", "github", "cloud", "saml"]);
  });
  it.each(["slack", "oidc", "github", "cloud", "saml"] as const)("lazily initializes %s owner People after real core META", async method => {
    const w = await world(method);
    expect(await w.h.store.get({ pk: w.task.pk, sk: "PEOPLE" })).toBeUndefined();
    expect((await getTaskPeople(w.people, w.webCaller, w.task.taskId)).canManage).toBe(true);
    expect(w.db.get(w.task.pk, "PEOPLE")).toMatchObject({ revision: 1, people: [{ developerId: w.developerId, role: "owner" }] });
  });
  // DEC 254zzz382: exact closed set, independent of the built-in method registry.
  it.each(["slack", "oidc", "github", "cloud", "saml"] as const)("initializes and shows its %s owner, preserving the adapter", async method => {
    const w = await world(method);
    expect(w.task.provider).toBe("rovara-sign-in");
    const view = await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    expect(view).toMatchObject({ canManage: true, people: [{ name: "Owner", role: "owner", effectiveRole: "owner", you: true, method }] });
    expect(w.db.get(w.task.pk, "PEOPLE")).toMatchObject({ revision: 1, orphaned: false });
  });

  it.each(["non-member", "other company", "revoked", "no grant", "unknown method", "wrong subject", "wrong person"])("refuses %s with an authorization message", async reason => {
    const w = await world();
    if (reason === "non-member") w.identity.companyMembership = async () => undefined;
    if (reason === "other company") w.identity.companyMembership = async () => ({ companyId: `org_${"b".repeat(20)}` });
    if (reason === "revoked") w.record.revoked = true;
    if (reason === "no grant") w.identity.projectGrant = async () => false;
    if (reason === "unknown method") Object.assign(w.record, { provider: "future-method" });
    if (reason === "wrong subject") w.record.subject = "someone-else";
    if (reason === "wrong person") w.record.developerId = "f".repeat(64);
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: expect.stringMatching(/^(TASK|PROJECT)_ACCESS_DENIED$/) as unknown, message: expect.stringContaining("could not be verified") as unknown });
    expect(w.db.get(w.task.pk, "PEOPLE")).toBeUndefined();
  });

  it("requires presence as well as eligibility when staging a shared native owner", async () => {
    const w = await world("slack");
    Object.assign(w.task, { share: { teamId: "T0TEAM001", channelId: "C0SHARED1", threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: w.task.createdAt }, shared: true });
    w.db.set(w.task as unknown as Record<string, unknown>);
    await expect(prepareTaskPeopleStart(w.identity, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("requires eligibility as well as presence when staging a native owner", async () => {
    const w = await world("slack");
    w.identity.targetProjectAccess = async () => { throw Object.assign(new Error("denied"), { code: "PROJECT_ACCESS_DENIED" }); };
    await expect(prepareTaskPeopleStart(w.identity, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it.each(["PEOPLE", "PERSON#", "PERSON_SUBJECT#"])("a conflicting %s row leaves the entire creation transaction unchanged", async prefix => {
    const w = await world();
    const items = await prepareTaskPeopleStart(w.identity, w.task);
    const target = items.find(item => item.kind === "put" && item.item.sk.startsWith(prefix));
    if (target?.kind !== "put") throw new Error("missing expected creation row");
    const original = { ...target.item, sentinel: "keep" };
    await w.h.store.put({ item: original });
    expect((await w.h.store.transact(items)).applied).toBe(false);
    expect(await w.h.store.get({ pk: original.pk, sk: original.sk })).toEqual(original);
    for (const item of items) if (item.kind === "put" && item.item.sk !== original.sk) {
      expect(await w.h.store.get({ pk: item.item.pk, sk: item.item.sk })).toBeUndefined();
    }
  });

  it.each(["pk", "sk", "entityType", "taskId", "project", "developerId", "provider"])("refuses malformed stored META %s", async field => {
    const w = await world();
    const client = w.identity.documentClient;
    w.identity.documentClient = { send: async command => {
      if (command instanceof GetCommand && command.input.Key?.["sk"] === "META") return { Item: { ...w.task, [field]: field === "project" ? 42 : "invalid" } };
      return client.send(command);
    } };
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("preserves exact concrete-method equality for a non-hosted task", async () => {
    const w = await world();
    Object.assign(w.task, { provider: "cloud" });
    Object.assign(w.record, { provider: "github" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses an unknown adapter even when a valid owner registry already exists", async () => {
    const w = await world("cloud", false, true);
    Object.assign(w.task, { provider: "future-adapter" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    await expect(prepareTaskPeopleStart(w.identity, w.task)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it.each(["non-member", "other company", "revoked", "no grant", "unknown method"])("stages no creation rows for %s", async reason => {
    const w = await world();
    if (reason === "non-member") w.identity.companyMembership = async () => undefined;
    if (reason === "other company") w.identity.companyMembership = async () => ({ companyId: `org_${"b".repeat(20)}` });
    if (reason === "revoked") w.record.revoked = true;
    if (reason === "no grant") w.identity.projectGrant = async () => false;
    if (reason === "unknown method") Object.assign(w.record, { provider: "future-method" });
    await expect(prepareTaskPeopleStart(w.identity, w.task)).rejects.toMatchObject({ code: expect.stringMatching(/^(TASK|PROJECT)_ACCESS_DENIED$/) as unknown });
    expect(w.db.get(w.task.pk, "PEOPLE")).toBeUndefined();
  });

  it.each(["wrong subject", "unknown method", "record unavailable"])("with display admission, preserves the %s refusal", async reason => {
    const w = await world();
    w.people.createTaskPeopleDisplayAdmission = () => taskPeopleDisplayAdmission({ now: () => w.h.clock.now, read: async () => { throw new Error("web proof must not read Slack"); } });
    if (reason === "wrong subject") w.record.subject = "someone-else";
    if (reason === "unknown method") Object.assign(w.record, { provider: "future-method" });
    if (reason === "record unavailable") w.identity.developerRecord = async () => { throw new Error("offline"); };
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: reason === "record unavailable" ? "SLACK_UNAVAILABLE" : "PROJECT_ACCESS_DENIED" });
  });

  it.each([false, true])("rechecks a native hosted sign-in's revocation (registered=%s)", async registered => {
    const w = await world("slack", false, registered);
    w.record.revoked = true;
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it.each(["provider", "issuer", "subject", "developerId", "revoked"])("refuses a changed registered native sign-in %s", async field => {
    const w = await world("slack", false, true);
    Object.assign(w.record, { [field]: field === "revoked" ? undefined : "different" });
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses a first-read person mismatch even when a later read would match", async () => {
    const w = await world();
    let first = true;
    w.identity.developerRecord = async () => {
      if (first) { first = false; return { ...w.record, developerId: "f".repeat(64) }; }
      return w.record;
    };
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses missing and unreadable sign-in records instead of falling back to the adapter", async () => {
    const w = await world();
    w.identity.developerRecord = async () => undefined;
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    w.identity.developerRecord = async () => { throw new Error("offline"); };
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE", message: expect.stringContaining("proof is unavailable") as unknown });
  });

  it("refuses unknown adapters both at creation and on existing tasks", async () => {
    const w = await world();
    Object.assign(w.task, { provider: "future-adapter" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    await expect(prepareTaskPeopleStart(w.identity, w.task)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it.each(["oidc", "github"] as const)("a revoked %s Slack-linked identity is ineligible", async method => {
    const w = await world(method, true);
    w.record.revoked = true;
    expect(await checkTaskPersonIdentity(w.identity, w.task, w.developerId)).toMatchObject({ eligible: false, channelMember: false });
  });

  it("retains a legacy native task's stored-identity proof without a sign-in record", async () => {
    const w = await world("slack");
    Object.assign(w.task, { provider: "slack" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    w.identity.developerRecord = async () => undefined;
    expect(await checkTaskPersonIdentity(w.identity, w.task, w.developerId)).toMatchObject({ eligible: true, identity: { developerId: w.developerId, method: "slack" } });
  });

  it("refuses a legacy native task whose stored Slack id names another person", async () => {
    const w = await world("slack");
    Object.assign(w.task, { provider: "slack", slackUserId: "U0OTHER01" });
    w.db.set(w.task as unknown as Record<string, unknown>);
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("retains fresh proof for the exact authenticated native Slack caller", async () => {
    const w = await world();
    const slackUserId = "U0OTHER01";
    const developerId = ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId);
    const record = { ...w.record, developerId, issuer: SLACK_OIDC_ISSUER, subject: slackUserId, slackUserId, provider: "slack" as const };
    w.identity.developerRecord = async id => id === developerId ? record : w.record;
    w.identity.trustedCaller = { developerId, slackUserId, amr: "slack", name: "Other" };
    expect(await checkTaskPersonIdentity(w.identity, w.task, developerId)).toMatchObject({ eligible: true, identity: { developerId, slackUserId, method: "slack" } });
  });

  it("rejects an unregistered non-owner even when that person's record and live grants are valid", async () => {
    const w = await world();
    const subject = "other-person";
    const developerId = ownerKeyForSubject(w.record.issuer, subject);
    w.identity.developerRecord = async id => id === developerId ? { ...w.record, developerId, subject } : w.record;
    await expect(checkTaskPersonIdentity(w.identity, w.task, developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses a malformed linked record before attempting to format its absent name", async () => {
    const w = await world("oidc", true);
    delete w.record.slackUserId;
    Object.assign(w.record, { displayName: undefined });
    await expect(checkTaskPersonIdentity(w.identity, w.task, w.developerId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it.each(["oidc", "github"] as const)("retains the %s Slack-linked proof", async method => {
    const w = await world(method, true);
    w.identity.taskPersonProof = async () => ({ ok: false, error: "ineligible" });
    const proof = await checkTaskPersonIdentity(w.identity, w.task, w.developerId);
    expect(proof.identity.slackUserId).toBe("U0OWNER01");
    expect(proof.eligible).toBe(false);
  });
});

describe("People identity on a sign-in row shaped like the stored data (the id only in the key)", () => {
  const rowKey = (developerId: string) => `DEVELOPER#${developerId}`;
  const viewOf = async (w: Awaited<ReturnType<typeof world>>) => {
    const path = `/v1/dev/tasks/${w.task.taskId}/people`;
    const routes = createCoreTaskRuleRoutes(() => w.people as unknown as DeveloperTaskRouteDependencies);
    return routes.route({ request: { method: "GET", path, headers: {} }, path, person: { developerId: w.developerId, name: "Owner" }, companyId: w.h.deps.companyId, task: w.task as unknown as Record<string, unknown>, store: w.h.store, authorize: async () => { throw new Error("the read rule was asked"); } });
  };

  it.each(["attribute", "key"] as const)("the owner opens People: exactly one entry, the creator, role owner (record shape=%s)", async shape => {
    const w = await world("cloud", false, true, shape);
    expect(w.storedRow()).toMatchObject({ pk: rowKey(w.developerId) });
    if (shape === "key") expect(w.storedRow()).not.toHaveProperty("developerId");
    const answer = await viewOf(w);
    expect(answer.statusCode).toBe(200);
    const view = (JSON.parse(answer.body) as { view: { people: unknown[] } }).view;
    expect(view.people).toHaveLength(1);
    expect(view).toMatchObject({ canManage: true, people: [{ you: true, role: "owner", method: "cloud" }] });
    expect(w.db.get(w.task.pk, "PEOPLE")).toMatchObject({ revision: 1, people: [{ developerId: w.developerId, role: "owner" }] });
  });

  it("People init refuses nothing for the key-only row and the next step still dispatches after People is opened", async () => {
    const w = await world("cloud", false, false, "key");
    const view = await getTaskPeople(w.people, w.webCaller, w.task.taskId);
    expect(view.people).toHaveLength(1);
    expect(w.db.get(w.task.pk, "PEOPLE")).toMatchObject({ people: [{ developerId: w.developerId, role: "owner" }] });
    w.h.deps.deliveryAccess = async (_deps, operation, workspace) => {
      for (const pk of [w.task.pk, workspace.pk]) for (const row of (await w.h.store.query({ pk })).items) w.db.set(row);
      return guardTaskDispatch({ documentClient: w.db, tableName: "state", core: { companyId: w.h.deps.companyId, workspacePk: workspace.pk } }, {
        id: "dispatch-key-only", workspaceId: workspace.id, operationId: operation.id, invocation: { kind: operation.dispatch.kind, fence: operation.fence },
      });
    };
    let delivered = 0;
    for (let i = 0; i < 12; i++) { delivered += (await w.h.flow.dispatchOnce({ maxMessages: 10 })).delivered; w.h.clock.advance(70); }
    expect(delivered).toBe(1);
  });

  it("refuses when the developerId attribute disagrees with the key", async () => {
    const w = await world("cloud", false, false, "attribute");
    const other = ownerKeyForSubject(w.record.issuer, "someone-else");
    w.identity.developerRecord = async id => developerRecordKeyedBy({ pk: rowKey(id), sk: "META", ...w.record, developerId: other } as unknown as DeveloperRecord, id);
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(w.db.get(w.task.pk, "PEOPLE")).toBeUndefined();
  });

  it("refuses when the row read is another person's (pk names someone else)", async () => {
    const w = await world("cloud", false, false, "key");
    const other = ownerKeyForSubject(w.record.issuer, "someone-else");
    w.identity.developerRecord = async id => developerRecordKeyedBy({ ...(w.storedRow() as object), pk: rowKey(other) } as unknown as DeveloperRecord, id);
    await expect(getTaskPeople(w.people, w.webCaller, w.task.taskId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("still refuses a different person than the task's creator", async () => {
    const w = await world("cloud", false, false, "key");
    const stranger = ownerKeyForSubject(w.record.issuer, "stranger");
    w.identity.developerRecord = async id => developerRecordKeyedBy({ pk: rowKey(id), sk: "META", ...w.record, developerId: undefined, issuer: w.record.issuer, subject: "stranger" } as unknown as DeveloperRecord, id);
    await expect(w.identity.developerRecord(stranger)).resolves.toMatchObject({ developerId: stranger });
    await expect(checkTaskPersonIdentity(w.identity, w.task, stranger)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("still refuses when the company differs", async () => {
    const w = await world("cloud", false, false, "key");
    w.identity.companyMembership = async () => ({ companyId: "org_zzzzzzzzzzzzzzzzzzzz" });
    const proof = await checkTaskPersonIdentity(w.identity, w.task, w.developerId).catch((error: unknown) => error);
    if (proof instanceof Error) expect(proof).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    else expect(proof).toMatchObject({ eligible: false });
  });
});
