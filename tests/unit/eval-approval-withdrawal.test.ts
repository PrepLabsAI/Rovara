// PRODUCT-EVAL-APPROVER-REREAD: an eval approval counts at the gateway's stage hold only while it is fresh (15 minutes from the
// role check Cloud made with Code) and its approver has not been withdrawn (Cloud's member and invite flows call
// ProductKeyStore.withdrawApprovals before they change a person). A stale or withdrawn approval is refused with
// eval_approval_stale (approve again); anything unreadable fails closed. Two companies never meet.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { storedEvalApprovals, storedEvalBudget } from "../../packages/model-gateway/src/eval-approvals.js";
import { EVAL_APPROVAL_STALE, EVAL_APPROVAL_STALE_CODE, EVAL_HOLD_PATH, ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { APPROVAL_WITHDRAWALS_MAX, EVAL_APPROVAL_FRESH_MS, InMemoryProductKeyTable, ProductKeyError, ProductKeyStore, type ProductActor, type TableWrite } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now } from "./model-gateway-fixture.js";
import { cid, pid, productGateway, storeKit } from "./model-gateway-product-fixture.js";

const ISS = "https://install-a.example/v1/auth";
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const pam: ProductActor = { id: "a".repeat(64), role: "project_maintainer" };
const ada: ProductActor = { id: "d".repeat(64), role: "company_admin" };
const approval = { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 400, maxCostMicros: 4_000_000 };

function kit(beforeCommit?: (writes: readonly TableWrite[]) => boolean | void) {
  const clock = { at: now };
  const table = new InMemoryProductKeyTable(beforeCommit);
  const store = new ProductKeyStore({ table, sealer: new ProductKeySealer(localProductKeyService(randomBytes(32))), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => clock.at });
  const source = storedEvalApprovals(store, () => clock.at);
  return { clock, table, store, source };
}
const approve = (k: ReturnType<typeof kit>, cid: string, actor: ProductActor, expectedRevision: number, roleCheckedAt?: number) =>
  k.store.setEvalApproval({ iss: ISS, cid, owner: "web", requestId: randomUUID(), expectedRevision, actor, approval, provider: "rovara-code", ...(roleCheckedAt === undefined ? {} : { roleCheckedAt }) });

describe("eval approval freshness (15 minutes)", () => {
  it("counts while fresh, then is stale (not none): the hold tells the app to approve again", async () => {
    const k = kit();
    await approve(k, A, pam, 0);
    expect(await k.source.current(ISS, A, "web")).toEqual({ ...approval, approver: { personId: pam.id, provider: "rovara-code" } });
    expect(await k.source.roleOf(ISS, A, "web", { personId: pam.id, provider: "rovara-code" })).toBe("maintainer");
    expect((await k.store.view(ISS, A, "web")).evalApprovalState).toBe("current");
    k.clock.at = now + EVAL_APPROVAL_FRESH_MS - 1;
    expect(await k.source.current(ISS, A, "web")).not.toBe(EVAL_APPROVAL_STALE);
    k.clock.at = now + EVAL_APPROVAL_FRESH_MS;
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    expect(await k.source.roleOf(ISS, A, "web", { personId: pam.id, provider: "rovara-code" })).toBeUndefined();
    expect((await k.store.view(ISS, A, "web")).evalApprovalState).toBe("stale");
    // An approval dated after the hold's clock (a clock running ahead) does not count either.
    k.clock.at = now - 1;
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    // No approval at all is still "none", and the budget read is unchanged.
    expect(await k.source.current(ISS, B, "web")).toBeUndefined();
    expect(await storedEvalBudget(k.store)(ISS, A, "web")).toEqual({ calls: 400, costMicros: 4_000_000 });
  });

  it("the hold's own clock decides too: an approval the store still calls current is stale on a gateway clock 15 minutes on", async () => {
    const k = kit();
    await approve(k, A, pam, 0);
    const late = storedEvalApprovals(k.store, () => now + EVAL_APPROVAL_FRESH_MS);
    expect((await k.store.evalFor(ISS, A, "web")).approvalState).toBe("current");
    expect(await late.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    expect(await late.roleOf(ISS, A, "web", { personId: pam.id, provider: "rovara-code" })).toBeUndefined();
  });

  it("counts from the role check, not from the save", async () => {
    const k = kit();
    await approve(k, A, pam, 0, now - EVAL_APPROVAL_FRESH_MS + 1000);
    expect((await k.store.evalFor(ISS, A, "web")).approval?.approvedAt).toBe(now - EVAL_APPROVAL_FRESH_MS + 1000);
    k.clock.at = now + 1000;
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    // A role check time later than the save is never taken (the save's own time wins), and a bad one is refused.
    await approve(k, A, pam, 1, now + 1_000_000);
    expect((await k.store.evalFor(ISS, A, "web")).approval?.approvedAt).toBe(now + 1000);
    await expect(approve(k, A, pam, 2, -1)).rejects.toThrow(new ProductKeyError("invalid"));
  });
});

describe("withdrawing a person's approvals (membership or role changed)", () => {
  it("withdraws every approval the person made up to now, in every project of the company, at once", async () => {
    const k = kit();
    await approve(k, A, pam, 0);
    await k.store.setEvalApproval({ iss: ISS, cid: A, owner: "api", requestId: randomUUID(), expectedRevision: 0, actor: pam, approval, provider: "rovara-code" });
    k.clock.at = now + 1000;
    await k.store.withdrawApprovals(ISS, A, pam.id);
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    expect(await k.source.current(ISS, A, "api")).toBe(EVAL_APPROVAL_STALE);
    expect(await k.source.roleOf(ISS, A, "web", { personId: pam.id, provider: "rovara-code" })).toBeUndefined();
    expect((await k.store.view(ISS, A, "web")).evalApprovalState).toBe("withdrawn");
    // A new approval after the change (with a new role check) counts again.
    k.clock.at = now + 2000;
    await approve(k, A, pam, 1);
    expect(await k.source.current(ISS, A, "web")).toMatchObject({ approver: { personId: pam.id } });
  });

  it("catches an approval whose role check began before the withdrawal, even when it is saved after it", async () => {
    const k = kit();
    const checkedAt = now;
    k.clock.at = now + 500;
    await k.store.withdrawApprovals(ISS, A, pam.id);
    k.clock.at = now + 1000;
    await approve(k, A, pam, 0, checkedAt);
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
  });

  it("touches only that person, and only in that company (two companies)", async () => {
    const k = kit();
    await approve(k, A, ada, 0);
    await approve(k, B, pam, 0);
    k.clock.at = now + 1000;
    await k.store.withdrawApprovals(ISS, A, pam.id);
    expect(await k.source.current(ISS, A, "web")).toMatchObject({ approver: { personId: ada.id } });
    expect(await k.source.current(ISS, B, "web")).toMatchObject({ approver: { personId: pam.id } });
    // The withdrawal row sits under company A's partition only.
    expect([...k.table.rows.keys()].filter((key) => key.includes("withdrawn")).every((key) => key.startsWith(`CO#${JSON.stringify([ISS, A])}#`))).toBe(true);
  });

  it("past the limit of named people, every approval made up to now is withdrawn (fail closed)", async () => {
    const k = kit();
    await approve(k, A, ada, 0);
    for (let i = 0; i <= APPROVAL_WITHDRAWALS_MAX; i++) { k.clock.at = now + 1 + i; await k.store.withdrawApprovals(ISS, A, i.toString(16).padStart(64, "0")); }
    expect(await k.source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    const row = [...k.table.rows.entries()].find(([key]) => key.includes("withdrawn"))![1];
    expect(row.item).toMatchObject({ people: {}, allBefore: expect.any(Number) as unknown });
  });

  it("an unreadable withdrawal row fails the read: no approval counts, nothing is guessed", async () => {
    const k = kit();
    await approve(k, A, pam, 0);
    await k.store.withdrawApprovals(ISS, A, "e".repeat(64));
    const key = [...k.table.rows.keys()].find((each) => each.includes("withdrawn"))!;
    for (const bad of [{ people: { [pam.id]: "soon" } }, { people: { short: 1 } }, { people: {}, allBefore: -1 }, { people: {}, extra: 1 }, { people: [] }]) {
      k.table.rows.set(key, { version: 9, item: bad });
      await expect(k.store.evalFor(ISS, A, "web")).rejects.toThrow(new ProductKeyError("unavailable"));
      await expect(k.source.current(ISS, A, "web")).rejects.toThrow();
    }
  });

  it("a withdrawal that can't be saved throws (the caller must not make the change), and bad input is refused", async () => {
    const k = kit(() => false);
    await expect(k.store.withdrawApprovals(ISS, A, pam.id)).rejects.toThrow(new ProductKeyError("unavailable"));
    const k2 = kit(() => { throw new Error("down"); });
    await expect(k2.store.withdrawApprovals(ISS, A, pam.id)).rejects.toThrow(new ProductKeyError("unavailable"));
    for (const [cid, person] of [[A, "not-a-person"], ["org_bad", pam.id]] as const) await expect(kit().store.withdrawApprovals(ISS, cid, person)).rejects.toThrow(new ProductKeyError("invalid"));
  });

  it("drops withdrawals older than twice the freshness window (their approvals are stale anyway)", async () => {
    const k = kit();
    await k.store.withdrawApprovals(ISS, A, pam.id);
    k.clock.at = now + 2 * EVAL_APPROVAL_FRESH_MS + 1;
    await k.store.withdrawApprovals(ISS, A, ada.id);
    const row = [...k.table.rows.entries()].find(([key]) => key.includes("withdrawn"))![1];
    expect(Object.keys((row.item as { people: Record<string, number> }).people)).toEqual([ada.id]);
  });
});

describe("the stage hold answers eval_approval_stale", () => {
  async function control(deps: GatewayDependencies, body: unknown) {
    const sink = new MemorySink();
    const bytes = Buffer.from(JSON.stringify(body));
    await handleGateway(deps, { method: "POST", url: EVAL_HOLD_PATH, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield bytes; })() }, sink);
    return { status: sink.status, json: JSON.parse(sink.text()) as { error?: { type: string; message: string }; scope?: string } };
  }
  const grant = { company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
  async function gateway() {
    const clock = { at: now };
    const s = storeKit({ clock: () => clock.at });
    const stages = new ProductEvalStages({ approvals: storedEvalApprovals(s.store, () => clock.at), budget: storedEvalBudget(s.store), now: () => clock.at });
    const g = await productGateway({ evalStages: stages, kit: s, companyCaps: new FixedCapsSource({ task: 1e9, projectMonth: 1e9, companyMonth: 1e9 }) });
    const change = (expectedRevision: number) => ({ iss: ISS, cid, owner: pid, requestId: randomUUID(), expectedRevision, actor: pam, approval, provider: "rovara-code" });
    return { clock, s, g, change };
  }

  it("holds on a fresh approval; refuses a stale one with the re-approve answer, holding nothing", async () => {
    const w = await gateway();
    const revision = (await w.s.store.view(ISS, cid, pid)).revision;
    await w.s.store.setEvalApproval(w.change(revision));
    expect((await control(w.g.deps, { grant, calls: 10, costMicros: 1000 })).status).toBe(200);
    w.clock.at = now + EVAL_APPROVAL_FRESH_MS;
    const stale = await control(w.g.deps, { grant, calls: 10, costMicros: 1000 });
    expect(stale.status).toBe(422);
    expect(stale.json.error).toEqual({ type: EVAL_APPROVAL_STALE_CODE, message: "the eval spend approval is no longer current; approve it again" });
  });

  it("refuses a withdrawn approver's approval at once, while it would still be fresh", async () => {
    const w = await gateway();
    const revision = (await w.s.store.view(ISS, cid, pid)).revision;
    await w.s.store.setEvalApproval(w.change(revision));
    w.clock.at = now + 1000;
    await w.s.store.withdrawApprovals(ISS, cid, pam.id);
    const r = await control(w.g.deps, { grant, calls: 10, costMicros: 1000 });
    expect(r.status).toBe(422);
    expect(r.json.error?.type).toBe(EVAL_APPROVAL_STALE_CODE);
  });
});
