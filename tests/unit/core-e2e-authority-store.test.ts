import { describe, expect, it, vi } from "vitest";
import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { change, when, INDEX_EXPIRY_ATTRIBUTE, type TransactItem } from "@agentx/contracts";
import { hostedAuthorityStore, hostedCreatorAuthority } from "../../packages/broker/src/aws/core-e2e-authority-store.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { hostedE2EStoreFixture as fixture } from "../support/core-e2e-hosted-store.js";

const companyId = "org_11111111111111111111";
const task = { companyId, developerId: "maya", project: "payments" };

describe("hosted cross-table creator authority", () => {
  it.each(["revoked", "moved"] as const)("refuses every State write when company membership is %s after the authority read", async (race) => {
    const w = await fixture();
    const authority = (await w.creator())!;
    const membership = unmarshall(w.signin.raw("COMPANY_MEMBER#maya", "COMPANY")!);
    // Keep identity, role and project grant unchanged: only the transaction's membership fence can refuse this race.
    w.signin.seed(marshall({ ...membership, ...(race === "revoked" ? { revokedAt: "2026-11-22T00:00:00.000Z" } : { companyId: "org_22222222222222222222" }) }));
    const grant = w.state.raw(`ORG#${companyId}#MEMBER#maya`, "PROJECT#payments");
    expect(await w.store.transact([...authority.items,
      { kind: "put", item: { pk: "ROUND#membership-race", sk: "META", admitted: true } },
      { kind: "update", key: { pk: `ORG#${companyId}#MEMBER#maya`, sk: "PROJECT#payments" }, ops: [change.set("touched", true)] },
    ])).toMatchObject({ applied: false });
    expect(w.state.raw("ROUND#membership-race", "META")).toBeUndefined();
    expect(w.state.raw(`ORG#${companyId}#MEMBER#maya`, "PROJECT#payments")).toEqual(grant);
  });

  it.each(["admission", "verdict", "publication"])("refuses %s atomically when the creator is revoked after reading authority", async (phase) => {
    const w = await fixture();
    const authority = await w.creator();
    expect(authority?.proof).toMatchObject({ kind: "direct-membership", developerId: "maya", grantId: "grant-1" });
    // A State shadow cannot satisfy the real sign-in condition.
    w.state.seed(marshall({ pk: "DEVELOPER#maya", sk: "META", entityType: "DEVELOPER", revoked: false }));
    w.signin.seed(marshall({ pk: "DEVELOPER#maya", sk: "META", entityType: "DEVELOPER", revoked: true }));
    const result = await w.store.transact([...authority!.items, { kind: "put", item: { pk: `PHASE#${phase}`, sk: "META", phase } },
      { kind: "update", key: { pk: `ORG#${companyId}#MEMBER#maya`, sk: "PROJECT#payments" }, ops: [change.set("touched", true)] }]);
    expect(result.applied).toBe(false);
    expect(w.state.raw(`PHASE#${phase}`, "META")).toBeUndefined();
    expect(w.state.raw(`ORG#${companyId}#MEMBER#maya`, "PROJECT#payments")?.touched).toBeUndefined();
    expect(await w.creator()).toBeUndefined();
  });

  it("pins one physical transaction with sign-in identity/membership checks and State writes", async () => {
    const w = await fixture(); const authority = (await w.creator())!;
    expect(await w.store.transact([...authority.items, { kind: "put", item: { pk: "ROUND#1", sk: "META", admitted: true } }])).toEqual({ applied: true });
    const sent = w.state.requests.filter((request) => request.operation === "TransactWriteItems");
    expect(sent).toHaveLength(1);
    const steps = (sent[0]!.input as TransactWriteItemsCommand["input"]).TransactItems!;
    expect(steps.filter((step) => step.Put).map((step) => step.Put!.TableName)).toEqual(["state"]);
    const checks = steps.flatMap((step) => step.ConditionCheck === undefined ? [] : [step.ConditionCheck]);
    expect(checks.map((check) => [check.TableName, unmarshall(check.Key!)])).toEqual([
      ["signin", { pk: "DEVELOPER#maya", sk: "META" }], ["signin", { pk: "COMPANY_MEMBER#maya", sk: "COMPANY" }],
      ["state", { pk: `ORG#${companyId}#MEMBER#maya`, sk: "PROJECT#payments" }],
    ]);
    const identity = checks[0]!;
    expect(Object.values(identity.ExpressionAttributeNames!)).toEqual(["entityType", "revoked"]);
    expect(Object.values(unmarshall(identity.ExpressionAttributeValues!))).toEqual(["DEVELOPER", false]);
    expect(w.state.raw("ROUND#1", "META")?.admitted).toEqual({ BOOL: true });
  });

  it("refuses a membership role race and a replaced project grant without any State write", async () => {
    const w = await fixture(); const authority = (await w.creator())!;
    w.signin.seed(marshall({ pk: "COMPANY_MEMBER#maya", sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: "maya", companyId, role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" }));
    expect((await w.store.transact([...authority.items, { kind: "put", item: { pk: "ROUND#2", sk: "META" } }])).applied).toBe(false);
    expect(w.state.raw("ROUND#2", "META")).toBeUndefined();
    const current = (await w.creator())!;
    w.state.seed(marshall({ pk: `ORG#${companyId}#MEMBER#maya`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", companyId, ownerKey: "maya", projectName: "payments", role: "developer", grantId: "grant-2" }));
    expect((await w.store.transact([...current.items, { kind: "put", item: { pk: "ROUND#3", sk: "META" } }])).applied).toBe(false);
    expect(w.state.raw("ROUND#3", "META")).toBeUndefined();
  });

  it("fails closed without sign-in and refuses identity writes or foreign creators", async () => {
    const w = await fixture();
    expect(await hostedCreatorAuthority({ documentClient: w.documentClient, stateTableName: "state", signInTableName: undefined, companyId }, task)).toBeUndefined();
    expect(await hostedCreatorAuthority({ documentClient: w.documentClient, stateTableName: "state", signInTableName: "signin", companyId }, { ...task, companyId: "org_22222222222222222222" })).toBeUndefined();
    await expect(w.store.transact([{ kind: "put", item: { pk: "DEVELOPER#maya", sk: "META" } }])).rejects.toMatchObject({ code: "invalid_request" });
    const send = vi.fn(w.documentClient.send);
    const noSignin = hostedAuthorityStore(w.store, { documentClient: { send }, stateTableName: "state", signInTableName: undefined });
    await expect(noSignin.transact([{ kind: "check", key: { pk: "DEVELOPER#maya", sk: "META" }, condition: when.eq("revoked", false) }])).rejects.toMatchObject({ code: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a grant that cannot make a creator proof", async () => {
    const w = await fixture();
    w.state.seed(marshall({ pk: `ORG#${companyId}#MEMBER#maya`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", companyId, projectName: "payments", ownerKey: "maya", role: "viewer", grantId: "grant-1" }));
    expect(await w.creator()).toBeUndefined();
  });

  it("keeps a satisfied check on a single same-row update without reversing its condition", async () => {
    const w = await fixture();
    await w.store.put({ item: { pk: "DATA", sk: "META", version: 1 } });
    expect(await w.store.transact([
      { kind: "check", key: { pk: "DATA", sk: "META" }, condition: when.eq("version", 1) },
      { kind: "update", key: { pk: "DATA", sk: "META" }, ops: [change.set("version", 2)] },
    ])).toEqual({ applied: true });
    expect(await w.store.get({ pk: "DATA", sk: "META" })).toMatchObject({ version: 2 });
  });

  it("ANDs repeated fences into a single physical item without losing either condition", async () => {
    const w = await fixture();
    const checks: TransactItem[] = [{ kind: "check", key: { pk: "DATA", sk: "META" }, condition: when.eq("version", 1) },
      { kind: "check", key: { pk: "DATA", sk: "META" }, condition: when.eq("active", true) },
      { kind: "update", key: { pk: "DATA", sk: "META" }, ops: [change.set("version", 2)] }];
    await w.store.put({ item: { pk: "DATA", sk: "META", version: 1, active: false } });
    expect((await w.store.transact(checks)).applied).toBe(false);
    expect(await w.store.get({ pk: "DATA", sk: "META" })).toMatchObject({ version: 1 });
    await w.store.update({ key: { pk: "DATA", sk: "META" }, ops: [change.set("active", true)] });
    expect((await w.store.transact(checks)).applied).toBe(true);
  });
});

// Characterize the joined-table fake directly: no hosted wrapper may repair the request first.
for (const duplicateTable of ["state", "signin"] as const) it(`refuses repeated items in joined ${duplicateTable} before applying any write`, async () => {
  const state = new FakeDynamoDb({ tableName: "state" });
  const signin = new FakeDynamoDb({ tableName: "signin" });
  state.joinTransactions(signin);
  const key = { pk: "authority", sk: "META" };
  await (duplicateTable === "state" ? state : signin).send(new PutItemCommand({ TableName: duplicateTable, Item: marshall({ ...key, revision: 1 }) }));
  await expect(state.send(new TransactWriteItemsCommand({ TransactItems: [
    { Put: { TableName: duplicateTable === "state" ? "signin" : "state", Item: marshall({ pk: "marker", sk: "META" }) } },
    { ConditionCheck: { TableName: duplicateTable, Key: marshall(key), ConditionExpression: "attribute_exists(pk)" } },
    { Delete: { TableName: duplicateTable, Key: marshall(key) } },
  ] }))).rejects.toMatchObject({ name: "ValidationException", message: "Transaction request cannot include multiple operations on one item" });
  for (const [table, name] of [[state, "state"], [signin, "signin"]] as const) {
    expect(await table.send(new GetItemCommand({ TableName: name, Key: marshall({ pk: "marker", sk: "META" }) }))).toHaveProperty("Item", undefined);
  }
  expect(await (duplicateTable === "state" ? state : signin).send(new GetItemCommand({ TableName: duplicateTable, Key: marshall(key) }))).toMatchObject({ Item: marshall({ ...key, revision: 1 }) });
});

it("allows identical logical keys in different joined physical tables", async () => {
  const state = new FakeDynamoDb({ tableName: "state" });
  const signin = new FakeDynamoDb({ tableName: "signin" });
  state.joinTransactions(signin);
  const key = { pk: "authority", sk: "META" };
  await state.send(new TransactWriteItemsCommand({ TransactItems: [
    { Put: { TableName: "state", Item: marshall({ ...key, value: "state" }) } },
    { Put: { TableName: "signin", Item: marshall({ ...key, value: "signin" }) } },
  ] }));
  expect(await state.send(new GetItemCommand({ TableName: "state", Key: marshall(key) }))).toMatchObject({ Item: marshall({ ...key, value: "state" }) });
  expect(await signin.send(new GetItemCommand({ TableName: "signin", Key: marshall(key) }))).toMatchObject({ Item: marshall({ ...key, value: "signin" }) });
});

it("opus-equiv: identity transaction whose update writes only an expiry", async () => {
  const w = await fixture();
  const authority = (await w.creator())!;
  w.state.seed(marshall({ pk: "ROUND#x", sk: "META", entityType: "WORKSPACE" }));
  let error: unknown;
  try { await w.store.transact([...authority.items, { kind: "update", key: { pk: "ROUND#x", sk: "META" }, ops: [change.set(INDEX_EXPIRY_ATTRIBUTE, 123)] }]); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: "invalid_request", message: "the hosted authority adapter accepts transactions only" });
});

it("opus-live: hosted baseline-start-shaped update with creator checks", async () => {
  const w = await fixture();
  const authority = (await w.creator())!;
  w.state.seed(marshall({ pk: "BASELINE#x", sk: "RECORD", entityType: "E2E_BASELINE", state: "REQUESTED" }));
  const update: TransactItem = { kind: "update", key: { pk: "BASELINE#x", sk: "RECORD" }, ops: [change.set("state", "STARTED"), change.set(INDEX_EXPIRY_ATTRIBUTE, 123)], condition: when.eq("state", "REQUESTED") };
  // Without identity rows the same update commits through the ordinary store.
  await expect(w.store.transact([update])).resolves.toEqual({ applied: true });
  w.state.seed(marshall({ pk: "BASELINE#x", sk: "RECORD", entityType: "E2E_BASELINE", state: "REQUESTED" }));
  // The reviewer's item omits its kind: the identity path still rejects that retention pre-read before any write.
  await expect(w.store.transact([...authority.items, update])).rejects.toMatchObject({ code: "invalid_request", message: "the hosted authority adapter accepts transactions only" });
  expect(unmarshall(w.state.raw("BASELINE#x", "RECORD")!)).toMatchObject({ state: "REQUESTED" });
});
