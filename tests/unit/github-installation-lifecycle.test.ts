// Guided onboarding PR 3: the binding store's lifecycle (webhook marks, the mint refusal, reconnect by claim, disconnect), two companies throughout.
import { describe, expect, it } from "vitest";
import { GITHUB_DISCONNECTED_MESSAGE } from "@agentx/contracts";
import { GithubInstallationBindings, isGithubDisconnected } from "../../packages/broker/src/aws/github-credentials.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64);
const BEA = "b".repeat(64);
const NOW = "2026-11-17T12:00:00.000Z";
const D1 = "550e8400-e29b-41d4-a716-446655440001";
const D2 = "550e8400-e29b-41d4-a716-446655440002";
const D3 = "550e8400-e29b-41d4-a716-446655440003";

async function setup() {
  const db = new FakeDynamoDb();
  let now = Date.parse(NOW);
  const store = new GithubInstallationBindings(db, "state", () => now);
  db.set({ pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" });
  expect(await store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA, { accountType: "Organization" })).toBe("bound");
  expect(await store.claimPerson(B, { installationId: 202, accountLogin: "beta" }, BEA)).toBe("bound");
  return { db, store, tick: (ms = 1000) => { now += ms; } };
}
const binding = (db: FakeDynamoDb, id: number) => db.get(`GITHUB_INSTALLATION#${id}`, "BINDING");
const refusal = (work: Promise<unknown>) => work.then(() => "allowed", (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
const settle = <T,>(work: Promise<T>) => work.catch((error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
const companyRows = (db: FakeDynamoDb, company: string) => JSON.stringify(db.find((item) => JSON.stringify(item).includes(company)));

describe("webhook marks", () => {
  it("moves only the named installation's binding, conditionally, with an audit row by github, and keeps history", async () => {
    const { db, store } = await setup();
    const beforeA = companyRows(db, A);
    expect(await store.markLifecycle(202, "suspend", D1)).toEqual({ outcome: "marked", companyId: B, from: "active", to: "suspended" });
    expect(binding(db, 202)).toMatchObject({ companyId: B, state: "suspended", stateAt: NOW, boundBy: BEA });
    expect(db.get("GITHUB_INSTALLATION#202", `AUDIT#LIFECYCLE#${D1}`)).toMatchObject({ actor: "github", from: "active", to: "suspended", action: "suspend", companyId: B });
    expect(await store.markLifecycle(202, "deleted", D2)).toMatchObject({ outcome: "marked", from: "suspended", to: "uninstalled" });
    // History stays: the binding row, its claim audit and every lifecycle audit.
    expect(binding(db, 202)).toMatchObject({ state: "uninstalled" });
    expect(db.find((item) => item.pk === "GITHUB_INSTALLATION#202" && String(item.sk).startsWith("AUDIT#"))).toHaveLength(3);
    expect(companyRows(db, A)).toBe(beforeA);
  });
  it("an uninstalled binding is never re-activated by a webhook; a redelivered event changes nothing; an unbound installation is left alone", async () => {
    const { db, store } = await setup();
    await store.markLifecycle(101, "deleted", D1);
    for (const action of ["unsuspend", "suspend", "deleted"] as const) expect(await store.markLifecycle(101, action, D2)).toEqual({ outcome: "unchanged", companyId: A });
    expect(binding(db, 101)).toMatchObject({ state: "uninstalled" });
    const { db: db2, store: store2 } = await setup();
    await store2.markLifecycle(101, "suspend", D1);
    await store2.markLifecycle(101, "unsuspend", D2);
    // The first delivery again (GitHub's redelivery): already processed, so the state it would set is not set again.
    expect(await store2.markLifecycle(101, "suspend", D1)).toEqual({ outcome: "unchanged", companyId: A });
    expect(binding(db2, 101)).toMatchObject({ state: "active" });
    expect(await store2.markLifecycle(999, "deleted", D3)).toEqual({ outcome: "unbound" });
    expect(db2.get("GITHUB_INSTALLATION#999", "BINDING")).toBeUndefined();
  });
  it("refuses a malformed delivery id or action without writing", async () => {
    const { db, store } = await setup();
    const before = JSON.stringify([...db.items]);
    for (const [id, action] of [["not-a-uuid", "deleted"], [D1, "created"], [D1, "__proto__"]] as const) {
      await expect(store.markLifecycle(101, action as "deleted", id)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    }
    expect(JSON.stringify([...db.items])).toBe(before);
  });
});

describe("the mint check", () => {
  it("the company's own suspended or uninstalled installation gets the one clear sentence; another company gets the ordinary refusal", async () => {
    const { store } = await setup();
    await store.requireBound(A, 101);
    const foreignBefore = await refusal(store.requireBound(B, 101));
    await store.markLifecycle(101, "suspend", D1);
    expect(await refusal(store.requireBound(A, 101))).toEqual({ code: "GITHUB_NOT_CONNECTED", message: `GITHUB_NOT_CONNECTED: ${GITHUB_DISCONNECTED_MESSAGE}` });
    expect(await refusal(store.requireBound(B, 101))).toEqual(foreignBefore);
    expect(JSON.stringify(foreignBefore)).not.toContain("Reconnect");
    await store.markLifecycle(101, "unsuspend", D2);
    await store.requireBound(A, 101);
    await store.markLifecycle(101, "deleted", D3);
    const uninstalled = await store.requireBound(A, 101).catch((error: unknown) => error);
    expect(isGithubDisconnected(uninstalled)).toBe(true);
    // B's installation is untouched by A's marks.
    await store.requireBound(B, 202);
  });
  it("disconnectedFor: true only when every one of the company's bindings for that owner is not active", async () => {
    const { store } = await setup();
    expect(await store.disconnectedFor(A, "ACME")).toBe(false);
    await store.markLifecycle(101, "deleted", D1);
    expect(await store.disconnectedFor(A, "ACME")).toBe(true);
    expect(await store.disconnectedFor(B, "acme")).toBe(false);
    expect(await store.disconnectedFor(A, "beta")).toBe(false);
    expect(await store.claimPerson(A, { installationId: 103, accountLogin: "acme" }, ADA)).toBe("bound");
    expect(await store.disconnectedFor(A, "acme")).toBe(false);
  });
});

describe("reconnect by claim", () => {
  it("a new installation id binds after an uninstall; the same id re-activates only by the claim, with an audit row naming the person", async () => {
    const { db, store } = await setup();
    await store.markLifecycle(101, "deleted", D1);
    expect(await store.claimPerson(A, { installationId: 102, accountLogin: "acme" }, ADA)).toBe("bound");
    await store.requireBound(A, 102);
    expect(await store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA)).toBe("reconnected");
    expect(binding(db, 101)).toMatchObject({ companyId: A, state: "active" });
    expect(db.find((item) => item.pk === "GITHUB_INSTALLATION#101" && String(item.sk).startsWith("AUDIT#RECONNECT#"))[0]).toMatchObject({ actor: ADA, from: "uninstalled", to: "active" });
    await store.requireBound(A, 101);
    // Another company never takes or re-activates it.
    await store.markLifecycle(101, "deleted", D2);
    expect(await store.claimPerson(B, { installationId: 101, accountLogin: "acme" }, BEA)).toBe("taken");
    expect(binding(db, 101)).toMatchObject({ companyId: A, state: "uninstalled" });
  });
  it("a claim that GitHub says is still suspended keeps it suspended", async () => {
    const { db, store } = await setup();
    await store.markLifecycle(101, "deleted", D1);
    expect(await store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA, { suspended: true })).toBe("reconnected");
    expect(binding(db, 101)).toMatchObject({ state: "suspended" });
    expect(await store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA, { suspended: true })).toBe("already_bound");
  });
});

describe("disconnect", () => {
  it("unbinds the company's own installation with an audit row naming the person; another company's and an unknown one are not found and untouched", async () => {
    const { db, store } = await setup();
    const beforeB = companyRows(db, B);
    expect(await store.disconnect(B, 101, BEA)).toEqual({ outcome: "not_found" });
    expect(await store.disconnect(A, 999, ADA)).toEqual({ outcome: "not_found" });
    expect(binding(db, 101)).toBeDefined();
    expect(await store.disconnect(A, 101, ADA)).toEqual({ outcome: "disconnected", accountLogin: "acme", accountType: "Organization" });
    expect(binding(db, 101)).toBeUndefined();
    expect(db.get(`ORG#${A}#GITHUB_INSTALLATIONS`, "INSTALLATION#101")).toBeUndefined();
    expect(db.find((item) => item.pk === "GITHUB_INSTALLATION#101" && String(item.sk).startsWith("AUDIT#DISCONNECT#"))[0]).toMatchObject({ actor: ADA, companyId: A, accountLogin: "acme" });
    expect(db.find((item) => item.pk === "GITHUB_INSTALLATION#101" && String(item.sk).startsWith("AUDIT#CLAIM#"))).toHaveLength(1);
    expect(await store.ownerOf(101)).toBeUndefined();
    expect(companyRows(db, B)).toBe(beforeB);
    expect(await store.companyInstallations(A)).toEqual([]);
  });
  it("is refused (nothing written) before the backfill marker exists", async () => {
    const { db, store } = await setup();
    db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
    await expect(store.disconnect(A, 101, ADA)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(binding(db, 101)).toBeDefined();
  });
  it("loses cleanly to a change made after its read (a webhook mark in between): refused, nothing deleted", async () => {
    const { db, store } = await setup();
    const send = db.send.bind(db);
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand") { raced = true; await store.markLifecycle(101, "suspend", D1); }
      return send(command);
    };
    await expect(store.disconnect(A, 101, ADA)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(binding(db, 101)).toMatchObject({ state: "suspended" });
  });
  it("races a same-company claim: the end state is consistent (bound with its list row, or unbound with neither) and never another company's", async () => {
    for (let round = 0; round < 6; round++) {
      const { db, store } = await setup();
      // A transaction conflict may refuse either side (DynamoDB's TransactionConflict): the refused side says "try again" and wrote nothing.
      const [gone, claimed] = await Promise.all([settle(store.disconnect(A, 101, ADA)), settle(store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA))]);
      expect([{ outcome: "disconnected", accountLogin: "acme", accountType: "Organization" }, { code: "GITHUB_NOT_CONNECTED", message: "GITHUB_NOT_CONNECTED: the GitHub installation is not connected" }]).toContainEqual(gone);
      expect(["already_bound", "bound", { code: "GITHUB_NOT_CONNECTED", message: "GITHUB_NOT_CONNECTED: the GitHub installation is not connected" }]).toContainEqual(claimed);
      const row = binding(db, 101); const listed = db.get(`ORG#${A}#GITHUB_INSTALLATIONS`, "INSTALLATION#101");
      if (claimed === "bound") { expect(row).toMatchObject({ companyId: A }); expect(listed).toBeDefined(); }
      expect((await store.companyInstallations(A)).length).toBe(row === undefined ? 0 : 1);
    }
  });
  it("races another company's claim after it: the other company may bind only once it is unbound", async () => {
    const { db, store } = await setup();
    const [gone, other] = await Promise.all([store.disconnect(A, 101, ADA), store.claimPerson(B, { installationId: 101, accountLogin: "acme" }, BEA)]);
    expect(gone.outcome).toBe("disconnected");
    expect(db.find((item) => item.pk === "GITHUB_INSTALLATION#101" && String(item.sk).startsWith("AUDIT#DISCONNECT#"))).toHaveLength(1);
    if (other === "bound") expect(binding(db, 101)).toMatchObject({ companyId: B });
    else { expect(other).toBe("taken"); expect(binding(db, 101)).toBeUndefined(); }
  });
});

describe("fences on what was read (races between the read and the write)", () => {
  /** Runs `between` once, just before the store's next transaction. */
  const before = (db: FakeDynamoDb, between: () => Promise<void> | void) => {
    const send = db.send.bind(db); let done = false;
    db.send = async (command) => {
      if (!done && command.constructor.name === "TransactWriteCommand") { done = true; await between(); }
      return send(command);
    };
  };
  it("a mark never recreates a binding a disconnect removed in between", async () => {
    const { db, store } = await setup();
    before(db, () => db.delete("GITHUB_INSTALLATION#101", "BINDING"));
    expect(await store.markLifecycle(101, "deleted", D1)).toEqual({ outcome: "unbound" });
    expect(binding(db, 101)).toBeUndefined();
  });
  it("a disconnect never deletes a binding made again in between (same company, later bind; or another company, same bind time)", async () => {
    for (const change of [{ boundAt: "2026-11-17T12:00:05.000Z" }, { companyId: B }]) {
      const { db, store } = await setup();
      before(db, () => { db.set({ ...binding(db, 101)!, ...change }); });
      await settle(store.disconnect(A, 101, ADA));
      expect(binding(db, 101)).toMatchObject(change);
    }
  });
  it("a reconnect claim that read 'suspended' never re-activates a binding GitHub uninstalled in between", async () => {
    const { db, store } = await setup();
    await store.markLifecycle(101, "suspend", D1);
    before(db, async () => { await store.markLifecycle(101, "deleted", D2); });
    await expect(store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(binding(db, 101)).toMatchObject({ state: "uninstalled" });
  });
  it("an already-bound claim that loses to a disconnect does not bring back the list row without its binding", async () => {
    const { db, store, tick } = await setup();
    tick();
    before(db, async () => { expect((await store.disconnect(A, 101, ADA)).outcome).toBe("disconnected"); tick(); });
    expect(await store.claimPerson(A, { installationId: 101, accountLogin: "acme" }, ADA)).toBe("bound");
    expect(binding(db, 101)).toMatchObject({ companyId: A });
    expect(await store.companyInstallations(A)).toHaveLength(1);
  });
  it("a disconnect whose transaction committed but answered an error still says disconnected", async () => {
    const { db, store } = await setup();
    const send = db.send.bind(db); let done = false;
    db.send = async (command) => {
      const result = await send(command);
      if (!done && command.constructor.name === "TransactWriteCommand") { done = true; throw Object.assign(new Error("lost answer"), { name: "InternalServerError" }); }
      return result;
    };
    expect((await store.disconnect(A, 101, ADA)).outcome).toBe("disconnected");
    expect(binding(db, 101)).toBeUndefined();
  });
  it("a mark names the binding's account: an event for another account changes nothing", async () => {
    const { db, store } = await setup();
    expect(await store.markLifecycle(101, "deleted", D1, "someone-else")).toEqual({ outcome: "unchanged", companyId: A });
    expect(binding(db, 101)).not.toHaveProperty("state");
    expect((await store.markLifecycle(101, "deleted", D2, "ACME")).outcome).toBe("marked");
  });
});
