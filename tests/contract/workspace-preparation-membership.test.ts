import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, issuer, lazyEnsureWorkspace } from "../support/slack-broker.js";

// Task AUTH2 (finding 2 of the Task AUTH1 review): workspace preparation read a project membership and wrote it back without a condition.
// That issued a new grantId on an existing administrator's row, restored a role that was downgraded in between, and (for the admin
// prepareWorkspace route) created a developer membership without saying who granted it. Preparation now creates the row only when it is
// absent, leaves an existing row exactly as it is, and never writes over a change it did not see.

const FIRST = { subject: "admin-subject", admin: true };
const OTHER_ADMIN_SUBJECT = "another-projects-admin";
const NEW_DEVELOPER_SUBJECT = "cognito-subject-of-a-new-developer";

const ownerKeyOf = (subject: string) => createHash("sha256").update(issuer).update("\0").update(subject).digest("hex");

type Item = { Put?: { Item?: Record<string, unknown> }; ConditionCheck?: { Key?: Record<string, unknown> } };
type Row = Record<string, unknown>;

async function harness() {
  const broker = await createDeveloperTaskBroker();
  const db = broker.db;
  const prepare = (ownerSubject: string, user = FIRST) =>
    call(broker.handler, { method: "POST", path: "/v1/admin/workspaces/prepare", user, body: { requestId: randomUUID(), projectName: "payments", projectRevision: 1, ownerSubject } });
  const membership = (ownerKey: string): Row | undefined => db.find((row) => row.entityType === "MEMBERSHIP" && row.ownerKey === ownerKey && row.projectName === "payments")[0];
  const plant = (ownerKey: string, row: Partial<Row> = {}): Row => {
    const planted = { pk: `MEMBER#${ownerKey}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey, projectName: "payments", role: "administrator", grantId: "planted-grant", ...row };
    db.set(planted);
    return planted;
  };
  /** Runs `act` immediately before each transaction that carries a membership item, with the number of the transaction (from 1). */
  const beforeMembershipTransactions = (act: (transaction: number, ownerKey: string) => void) => {
    const send = db.send.bind(db);
    let count = 0;
    db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") {
        const items = (command as unknown as { input: { TransactItems: Item[] } }).input.TransactItems;
        const pk = items.map((item) => item.Put?.Item?.pk ?? item.ConditionCheck?.Key?.pk).find((value): value is string => typeof value === "string" && value.startsWith("MEMBER#"));
        if (pk !== undefined) { count += 1; act(count, pk.slice("MEMBER#".length)); }
      }
      return send(command);
    };
  };
  return { ...broker, prepare, membership, plant, beforeMembershipTransactions };
}

describe("admin prepareWorkspace and the target's project membership", () => {
  it("leaves an existing administrator's membership exactly as it was, grantId included", async () => {
    const broker = await harness();
    const before = structuredClone(broker.membership(ownerKeyOf(FIRST.subject)));
    expect(before?.role).toBe("administrator");
    const prepared = await broker.prepare(FIRST.subject);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    expect(broker.membership(ownerKeyOf(FIRST.subject))).toEqual(before);
  });

  it("leaves an existing developer's membership exactly as it was", async () => {
    const broker = await harness();
    const planted = broker.plant(ownerKeyOf(NEW_DEVELOPER_SUBJECT), { role: "developer", grantId: "granted-earlier", grantedBy: { issuer, subject: "someone" }, grantedAt: "2026-01-01T00:00:00.000Z" });
    const prepared = await broker.prepare(NEW_DEVELOPER_SUBJECT);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    expect(broker.membership(ownerKeyOf(NEW_DEVELOPER_SUBJECT))).toEqual(planted);
  });

  it("records who granted a developer membership it creates, and when", async () => {
    const broker = await harness();
    const before = Date.now();
    expect(broker.membership(ownerKeyOf(NEW_DEVELOPER_SUBJECT))).toBeUndefined();
    const prepared = await broker.prepare(NEW_DEVELOPER_SUBJECT);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    const created = broker.membership(ownerKeyOf(NEW_DEVELOPER_SUBJECT))!;
    expect(created).toMatchObject({ role: "developer", projectName: "payments", grantedBy: { issuer, subject: FIRST.subject } });
    expect(typeof created.grantId).toBe("string");
    expect(Date.parse(String(created.grantedAt))).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(String(created.grantedAt))).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("does not restore a role that was downgraded between the read and the write", async () => {
    const broker = await harness();
    const ownerKey = ownerKeyOf(OTHER_ADMIN_SUBJECT);
    broker.plant(ownerKey, { role: "administrator", grantId: "the-grant" });
    broker.beforeMembershipTransactions((transaction) => { if (transaction === 1) broker.plant(ownerKey, { role: "developer", grantId: "the-grant" }); });
    const prepared = await broker.prepare(OTHER_ADMIN_SUBJECT);
    // Re-read and re-decided: the workspace is prepared for a developer, and the downgrade stands.
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    expect(broker.membership(ownerKey)).toMatchObject({ role: "developer", grantId: "the-grant" });
  });

  it("does not replace a membership that another request created between the read and the write", async () => {
    const broker = await harness();
    const ownerKey = ownerKeyOf(NEW_DEVELOPER_SUBJECT);
    broker.beforeMembershipTransactions((transaction) => { if (transaction === 1) broker.plant(ownerKey, { role: "developer", grantId: "created-by-the-rival" }); });
    const prepared = await broker.prepare(NEW_DEVELOPER_SUBJECT);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(202);
    expect(broker.membership(ownerKey)).toMatchObject({ role: "developer", grantId: "created-by-the-rival" });
    expect(broker.membership(ownerKey)?.grantedBy).toBeUndefined();
  });

  it("gives up after a bounded number of attempts when the row keeps changing, and never overwrites it", async () => {
    const broker = await harness();
    const ownerKey = ownerKeyOf(OTHER_ADMIN_SUBJECT);
    broker.plant(ownerKey, { role: "administrator", grantId: "grant-0" });
    let attempts = 0;
    broker.beforeMembershipTransactions((transaction) => { attempts = transaction; broker.plant(ownerKey, { role: "administrator", grantId: `grant-${transaction}` }); });
    const prepared = await broker.prepare(OTHER_ADMIN_SUBJECT);
    expect(prepared.status).toBe(409);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(broker.membership(ownerKey)).toMatchObject({ role: "administrator", grantId: `grant-${attempts}` });
    expect(broker.db.find((row) => row.entityType === "WORKSPACE" && row.ownerKey === ownerKey)).toEqual([]);
  });
});

describe("a Slack thread's first workspace and the thread owner's project membership", () => {
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const SLACK_USER = "U0MAYA001";

  it("creates a developer membership when none exists, and leaves an existing row alone", async () => {
    const broker = await harness();
    const created = await lazyEnsureWorkspace(broker.handler, THREAD, SLACK_USER);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const [row] = broker.db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "developer" && item.projectName === "payments" && item.ownerKey !== ownerKeyOf(FIRST.subject));
    expect(row).toBeDefined();
    // The same thread again finds its workspace and does not touch the membership.
    const before = structuredClone(row);
    expect((await lazyEnsureWorkspace(broker.handler, THREAD, SLACK_USER)).status).toBe(200);
    expect(broker.membership(String(row!.ownerKey))).toEqual(before);
  });

  it("does not restore a role that was downgraded, nor replace a row created, between the read and the write", async () => {
    const broker = await harness();
    let ownerKey = "";
    broker.beforeMembershipTransactions((transaction, key) => {
      ownerKey = key;
      // First the row appears (another request of the thread created it as an administrator), then it is downgraded before the retry commits.
      if (transaction === 1) broker.plant(key, { role: "administrator", grantId: "the-grant" });
      if (transaction === 2) broker.plant(key, { role: "developer", grantId: "the-grant" });
    });
    const created = await lazyEnsureWorkspace(broker.handler, THREAD, SLACK_USER);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.outcome).toBe("WORKSPACE");
    expect(broker.membership(ownerKey)).toMatchObject({ role: "developer", grantId: "the-grant" });
  });
});
