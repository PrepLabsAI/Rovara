// following a session and who is looking now. The owner follows without an item; another person (a members adapter's, through the `level` seam) follows with one item and a count in the same transaction.
 
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PRESENCE_TTL_SECONDS, SESSION_FOLLOWERS_MAX, agentSessionKey, livePresenceKey, type OrgId, type Principal } from "@rovara-code/contracts";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/core/src/core/sessions/index.js";
import { followSession, presenceIsFresh, recordPresence, removeFollower, unfollowSession, viewingNow } from "../../packages/core/src/core/sessions/followers.js";
import { SessionStore } from "../../packages/core/src/core/sessions/store.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const SESSION = taskSessionId("8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6");
const clock = { ms: Date.parse("2026-11-10T10:00:00.000Z") };
const person = (id: string, name: string): Principal => ({ companyId: ORG, personId: id, displayName: name, roles: [], provider: "local-owner" });
const DANA = person("dana", "Dana");
const LEVELS: Record<string, "none" | "view"> = { dana: "view", eli: "view", nobody: "none" };

async function world() {
  const store = new MemoryDocumentStore();
  await store.transact(createTaskSessionItems({
    orgId: ORG, sessionId: SESSION, taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "t", owner: OWNER, origin: "app",
    payer: { kind: "member", developerId: developerIdOf(OWNER) } as never, now: "2026-11-10T09:00:00.000Z",
  }));
  const deps = { store, now: () => new Date(clock.ms), level: (principal: Principal) => (principal.personId === "local-owner" || principal.roles.includes("owner") ? "edit" as const : LEVELS[principal.personId] ?? "none") };
  const count = async () => (await new SessionStore(store).get(ORG, SESSION))!.followerCount;
  return { store, deps, count };
}

describe("following a session", () => {
  it("the owner follows already: nothing is written, and an unfollow cannot stop it", async () => {
    const w = await world();
    expect(await followSession(w.deps, OWNER, ORG, SESSION)).toEqual({ following: true });
    expect(await unfollowSession(w.deps, OWNER, ORG, SESSION)).toEqual({ following: true });
    expect(await w.count()).toBe(0);
    expect((await w.store.query({ pk: agentSessionKey(ORG, SESSION, "META").pk, sk: { op: "beginsWith", prefix: "FOLLOWER#" } })).items).toHaveLength(0);
  });

  it("another person follows with one item and one count, once, and stops with the count going back", async () => {
    const w = await world();
    expect(await followSession(w.deps, DANA, ORG, SESSION)).toEqual({ following: true });
    expect(await followSession(w.deps, DANA, ORG, SESSION)).toEqual({ following: true });
    expect(await w.count()).toBe(1);
    const items = (await w.store.query({ pk: agentSessionKey(ORG, SESSION, "META").pk, sk: { op: "beginsWith", prefix: "FOLLOWER#" } })).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entityType: "AGENT_SESSION_FOLLOWER", developerId: developerIdOf(DANA) });
    expect(await unfollowSession(w.deps, DANA, ORG, SESSION)).toEqual({ following: false });
    expect(await unfollowSession(w.deps, DANA, ORG, SESSION)).toEqual({ following: false });
    expect(await w.count()).toBe(0);
  });

  it("is refused at the most followers a session keeps, and a drifted count never keeps a follow or goes below zero", async () => {
    const w = await world();
    await w.store.update({ key: agentSessionKey(ORG, SESSION, "META"), ops: [{ op: "set", path: ["followerCount"], value: SESSION_FOLLOWERS_MAX }] });
    await expect(followSession(w.deps, DANA, ORG, SESSION)).rejects.toThrow("most followers");
    expect(await w.store.get(agentSessionKey(ORG, SESSION, `FOLLOWER#${developerIdOf(DANA)}`))).toBeUndefined();
    // A follow item whose count already drifted to zero is removed alone.
    await w.store.update({ key: agentSessionKey(ORG, SESSION, "META"), ops: [{ op: "set", path: ["followerCount"], value: 0 }] });
    await w.store.put({ item: { ...agentSessionKey(ORG, SESSION, `FOLLOWER#${developerIdOf(DANA)}`), entityType: "AGENT_SESSION_FOLLOWER" } });
    expect(await removeFollower(w.store, { orgId: ORG, sessionId: SESSION }, developerIdOf(DANA))).toBe(true);
    expect(await w.count()).toBe(0);
    expect(await removeFollower(w.store, { orgId: ORG, sessionId: SESSION }, developerIdOf(DANA))).toBe(false);
  });

  it("reads a session the person may not view, or another company's, as missing", async () => {
    const w = await world();
    await expect(followSession(w.deps, person("nobody", "Nobody"), ORG, SESSION)).rejects.toThrow("There is no such session.");
    await expect(followSession(w.deps, { ...DANA, companyId: "org_99999999999999999999" }, ORG, SESSION)).rejects.toThrow("There is no such session.");
    await expect(followSession(w.deps, DANA, ORG, "ses_00000000000000000000")).rejects.toThrow("There is no such session.");
  });
});

describe("who is looking now", () => {
  it("a heartbeat counts for the time it is trusted and then lapses, even before the store removes it; the names are in order and the index holds the same heartbeat", async () => {
    const w = await world();
    expect((await recordPresence(w.deps, OWNER, ORG, SESSION)).viewingNow.map((viewer) => viewer.name)).toEqual([OWNER.displayName]);
    clock.ms += 10_000;
    const both = await recordPresence(w.deps, DANA, ORG, SESSION);
    expect(both.viewingNow.map((viewer) => viewer.name)).toEqual([DANA.displayName, OWNER.displayName].sort());
    expect(await w.store.get(livePresenceKey(ORG, SESSION, developerIdOf(DANA)))).toMatchObject({ entityType: "LIVE_PRESENCE", name: "Dana" });
    clock.ms += (PRESENCE_TTL_SECONDS - 5) * 1000;
    expect((await viewingNow(w.store, { orgId: ORG, sessionId: SESSION }, clock.ms)).map((viewer) => viewer.name)).toEqual(["Dana"]);
    clock.ms += 10_000;
    expect(await viewingNow(w.store, { orgId: ORG, sessionId: SESSION }, clock.ms)).toEqual([]);
    expect(presenceIsFresh("not a time", clock.ms)).toBe(false);
    expect(presenceIsFresh(undefined, clock.ms)).toBe(false);
  });
});
