// DEC 254n (2): a GitHub person is a task person on exactly the terms an OIDC person is (their own sign-in record, its Slack link, the same fresh
// Slack proof and project access), and a GitHub person's task takes Slack people as an OIDC person's task does. Nothing more: no Slack link, no person.
import { describe, expect, it, vi } from "vitest";
import { SLACK_OIDC_ISSUER, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { checkTaskPersonIdentity, resolveTaskPersonId, resolveTaskPickerPerson, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_1 = "22222222-2222-4222-8222-222222222222";
const PERSON_2 = "33333333-3333-4333-8333-333333333333";
const SLACK = "U0OCTO001";
const OTHER_SLACK = "U0MAYA001";
type Method = "oidc" | "github";
const ISSUER: Record<Method, string> = { oidc: "https://id.example.test", github: "https://github.com" };
const SUBJECT: Record<Method, string> = { oidc: "octo-employee", github: "1001" };
const person = (method: Method) => ownerKeyForSubject(ISSUER[method], SUBJECT[method]);

const taskBy = (method: Method, linked: boolean) => ({
  pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, developerId: person(method), provider: method,
  developerName: "Creator", ...(linked ? { slackUserId: SLACK } : {}), project: "payments-api", share: { teamId: TEAM, channelId: "C0PAY0001" },
}) as DeveloperTaskRecord;

const record = (method: Method, overrides: Partial<DeveloperRecord> = {}): DeveloperRecord => ({
  developerId: person(method), provider: method, issuer: ISSUER[method], subject: SUBJECT[method], displayName: "Octo", slackUserId: SLACK,
  firstSignInAt: new Date(T0 - 1_000).toISOString(), lastSignInAt: new Date(T0).toISOString(), revoked: false, ...overrides,
});

function harness(task: DeveloperTaskRecord, developer?: DeveloperRecord, proof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>) {
  const db = new FakeDynamoDb();
  db.set(task as unknown as Record<string, unknown>);
  const access = vi.fn(async () => undefined);
  const uuids = [PERSON_1, PERSON_2];
  const deps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => uuids.shift() ?? PERSON_2,
    taskPersonProof: vi.fn(proof ?? (async (request: TaskPersonProofRequest) => ({ ok: true as const, user: { id: request.slackUserId, teamId: TEAM, name: "Octo Cat" }, memberOf: ["C0PAY0001"] }))),
    developerRecord: vi.fn(async (id: string) => (id === developer?.developerId ? developer : undefined)),
    projectChannelIds: vi.fn(async () => ["C0PAY0001"]),
    targetProjectAccess: access,
  };
  return { db, deps, access };
}
const row = (method: Method, extra: Record<string, unknown> = {}) => ({
  pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: person(method), slackUserId: SLACK, name: "Octo",
  method, issuer: ISSUER[method], subject: SUBJECT[method], createdAt: new Date(T0).toISOString(), ...extra,
});
const reverse = (method: Method) => ({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${person(method)}`, schemaVersion: 1, personId: PERSON_1, developerId: person(method), createdAt: new Date(T0).toISOString() });
const outcome = async (work: () => Promise<unknown>) => { try { return { ok: await work() }; } catch (error) { return { code: (error as { code?: string }).code }; } };
/** The same answer with the method-specific parts (id, issuer, subject, method) named generically, so an OIDC run and a GitHub run compare exactly. */
const generic = (value: unknown, method: Method) => JSON.parse(JSON.stringify(value).replaceAll(person(method), "PERSON").replaceAll(ISSUER[method], "ISSUER")
  .replaceAll(`"subject":"${SUBJECT[method]}"`, '"subject":"SUBJECT"').replaceAll(`"method":"${method}"`, '"method":"METHOD"')) as unknown;

describe("GitHub task people (DEC 254n)", () => {
  it.each(["oidc", "github"] as const)("a task a %s person started takes a Slack person from the picker", async (method) => {
    const h = harness(taskBy(method, false));
    expect(await resolveTaskPickerPerson(h.deps, taskBy(method, false), OTHER_SLACK)).toEqual({
      developerId: developerIdForSlackUser(OTHER_SLACK), slackUserId: OTHER_SLACK, name: "Octo Cat", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: OTHER_SLACK,
    });
  });

  it("a linked GitHub creator is checked exactly as a linked OIDC creator, and so is a revoked one, a lost one and an unlinked one", async () => {
    const cases: Array<[string, boolean, Partial<DeveloperRecord>, ((request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>)?]> = [
      ["linked", true, {}], ["revoked", true, { revoked: true }], ["lost", true, {}, async () => ({ ok: false, error: "ineligible" })],
      ["unavailable", true, {}, async () => ({ ok: false, error: "slack_unavailable" })], ["unlinked", false, { slackUserId: undefined }],
    ];
    for (const [, linked, overrides, proof] of cases) {
      const run = async (method: Method) => {
        const h = harness(taskBy(method, linked), record(method, overrides), proof);
        return generic({ answer: await outcome(() => checkTaskPersonIdentity(h.deps, taskBy(method, linked), person(method))), rows: h.db.find((item) => String(item.sk).startsWith("PERSON")) }, method);
      };
      expect(await run("github")).toEqual(await run("oidc"));
    }
    const h = harness(taskBy("github", true), record("github"));
    expect(await checkTaskPersonIdentity(h.deps, taskBy("github", true), person("github"))).toMatchObject({
      identity: { developerId: person("github"), slackUserId: SLACK, method: "github", issuer: ISSUER.github, subject: SUBJECT.github }, eligible: true,
    });
  });

  it.each(["oidc", "github"] as const)("a stored %s task person resolves from its own record, and a record of the other method, issuer or subject is refused", async (method) => {
    const ok = harness(taskBy(method, true), record(method));
    ok.db.set(row(method)); ok.db.set(reverse(method));
    expect(await resolveTaskPersonId(ok.deps, TASK_ID, PERSON_1)).toMatchObject({ developerId: person(method), method });
    const other: Method = method === "oidc" ? "github" : "oidc";
    for (const damaged of [record(method, { provider: other }), record(method, { issuer: ISSUER[other] }), record(method, { subject: "someone-else" }), record(method, { revoked: true }), record(method, { slackUserId: OTHER_SLACK })]) {
      const h = harness(taskBy(method, true), damaged);
      h.db.set(row(method)); h.db.set(reverse(method));
      await expect(resolveTaskPersonId(h.deps, TASK_ID, PERSON_1)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    }
  });

  it("a GitHub creator's task never takes a creator record of another method, and unknown methods are refused everywhere", async () => {
    const swapped = harness(taskBy("github", true), { ...record("oidc"), developerId: person("github") });
    await expect(checkTaskPersonIdentity(swapped.deps, taskBy("github", true), person("github"))).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    for (const provider of ["cloud", "saml", "GitHub", "local"]) {
      const task = { ...taskBy("github", true), provider } as unknown as DeveloperTaskRecord;
      const h = harness(task, record("github"));
      await expect(checkTaskPersonIdentity(h.deps, task, person("github"))).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      await expect(resolveTaskPickerPerson(h.deps, task, OTHER_SLACK)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      const stored = harness(taskBy("github", true), { ...record("github"), provider: provider as "github" });
      stored.db.set(row("github", { method: provider })); stored.db.set(reverse("github"));
      await expect(resolveTaskPersonId(stored.deps, TASK_ID, PERSON_1)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    }
  });
});
