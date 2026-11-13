// What the broker decides before it asks the image registry for a login: the switch, the approved pin, the Prove report, the repository's name, and that nobody else made the repository first.
import { describe, expect, it } from "vitest";
import { HostedSavedEnvRegistryAuthSchema, SAVED_ENV_PULL_SESSION_SECONDS, SAVED_ENV_PUSH_SESSION_SECONDS, savedEnvRepositoryName } from "@rovara-code/contracts";
import { mintPullSession, mintPushSession, repositoryOf, verifyRepository } from "../../packages/core/src/core/test-env/saved-env-session.js";
import { APPROVED, savedEnvWorld, type WorldOptions } from "../support/saved-env-world.js";

const ids = { orgId: "org-1", projectId: "proj-1" };
const sessions = (over: WorldOptions = {}) => { const w = savedEnvWorld(over); return { w, config: w.deps.session.config, ports: w.deps.session.ports }; };

describe("the schema a login is read through", () => {
  it("is a setting: a hosted install's schema refuses the local registry's login for a push and a pull, where Code's own takes it", async () => {
    const { config, ports } = sessions();
    const hosted = { ...ports, registryAuthSchema: HostedSavedEnvRegistryAuthSchema };
    expect((await mintPushSession(config, ports, { ...ids, approved: APPROVED })).ok).toBe(true);
    expect(await mintPushSession(config, hosted, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
    expect(await mintPullSession(config, hosted, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("a push login", () => {
  it("is for the project's own repository, for the longest push session, and only after the checks below", async () => {
    const { w, config, ports } = sessions();
    const minted = await mintPushSession(config, ports, { ...ids, approved: APPROVED });
    expect(minted).toMatchObject({ ok: true, auth: { repository: savedEnvRepositoryName({ env: "test", orgId: ids.orgId, projectId: ids.projectId }) } });
    expect(w.logins).toEqual([{ repository: w.repository, access: "push", maxSeconds: SAVED_ENV_PUSH_SESSION_SECONDS }]);
    expect(minted.ok && minted.expiresAtMs).toBeLessThanOrEqual(w.clock.now + SAVED_ENV_PUSH_SESSION_SECONDS * 1000);
  });

  it("is refused with the switch off, for an id that is not text, for a registry that cannot take a worker's push: the registry is not reached", async () => {
    for (const [name, over, input] of [
      ["switch off", { enabled: false }, ids], ["bad project id", {}, { ...ids, projectId: "" }], ["cannot push", { capabilities: { workerPush: false } }, ids],
    ] as const) {
      const { w, config, ports } = sessions(over);
      const refused = await mintPushSession(config, ports, { ...input, approved: APPROVED });
      expect(refused.ok, name).toBe(false);
      expect(w.calls.reached, name).toBe(0);
    }
    expect(await mintPushSession(sessions({ enabled: false }).config, sessions().ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "disabled" });
    expect(await mintPushSession(sessions().config, sessions().ports, { ...ids, projectId: "", approved: APPROVED })).toEqual({ ok: false, reason: "bad_ids" });
  });

  it("is refused when the pin is not the project's newest approved environment (revision or digest), or there is none", async () => {
    for (const approved of [{ ...APPROVED, revision: 3 }, { ...APPROVED, digest: "d".repeat(64) }]) {
      const { w, config, ports } = sessions();
      expect(await mintPushSession(config, ports, { ...ids, approved })).toEqual({ ok: false, reason: "not_approved" });
      expect(w.logins).toEqual([]);
    }
    const none = sessions({ approved: undefined });
    expect(await mintPushSession(none.config, none.ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "not_approved" });
  });

  it("is refused when the Prove report did not hold, and never reaches the registry", async () => {
    const { w, config, ports } = sessions({ proveHolds: false });
    expect(await mintPushSession(config, ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "not_proved" });
    expect(w.calls.reached).toBe(0);
  });

  it("is refused for a repository somebody else made first, and allowed for one that does not exist yet (the first push makes it)", async () => {
    const squat = sessions({ state: "unusable" });
    expect(await mintPushSession(squat.config, squat.ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
    expect(squat.w.logins).toEqual([]);
    const fresh = sessions({ state: "absent" });
    expect((await mintPushSession(fresh.config, fresh.ports, { ...ids, approved: APPROVED })).ok).toBe(true);
  });

  it("answers a registry that is down as unavailable, keeping nothing of its error", async () => {
    const { config, ports } = sessions({ registry: { login: async () => { throw new Error("secret-looking address 10.0.0.9"); } } });
    const answer = await mintPushSession(config, ports, { ...ids, approved: APPROVED });
    expect(answer).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("10.0.0.9");
  });
});

describe("a pull login", () => {
  it("is for the project's repository for the shorter session, and needs the repository to be there and to be the one Rovara makes", async () => {
    const { w, config, ports } = sessions();
    expect((await mintPullSession(config, ports, { ...ids, approved: APPROVED })).ok).toBe(true);
    expect(w.logins).toEqual([{ repository: w.repository, access: "pull", maxSeconds: SAVED_ENV_PULL_SESSION_SECONDS }]);
    for (const state of ["absent", "unusable"] as const) {
      const other = sessions({ state });
      expect(await mintPullSession(other.config, other.ports, { ...ids, approved: APPROVED }), state).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("is refused for a registry the worker cannot pull from, a moved pin and the switch off, without reaching the registry", async () => {
    const cannot = sessions({ capabilities: { workerPull: false } });
    expect(await mintPullSession(cannot.config, cannot.ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
    const moved = sessions();
    expect(await mintPullSession(moved.config, moved.ports, { ...ids, approved: { ...APPROVED, revision: 9 } })).toEqual({ ok: false, reason: "not_approved" });
    const off = sessions({ enabled: false });
    expect(await mintPullSession(off.config, off.ports, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "disabled" });
    expect(cannot.w.logins.length + moved.w.logins.length + off.w.logins.length).toBe(0);
  });
});

describe("the repository check", () => {
  it("answers matches or absent, never a pass for an unusable repository, and an error as unavailable", async () => {
    expect(await verifyRepository(sessions().config, sessions().ports, ids)).toEqual({ ok: true, state: "matches" });
    expect(await verifyRepository(sessions({ state: "absent" }).config, sessions({ state: "absent" }).ports, ids)).toEqual({ ok: true, state: "absent" });
    expect(await verifyRepository(sessions({ state: "unusable" }).config, sessions({ state: "unusable" }).ports, ids)).toEqual({ ok: false, reason: "unavailable" });
    const down = sessions({ registry: { inspect: async () => { throw new Error("down"); } } });
    expect(await verifyRepository(down.config, down.ports, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyRepository(sessions({ enabled: false }).config, sessions().ports, ids)).toEqual({ ok: false, reason: "disabled" });
    expect(repositoryOf(sessions().config, "org-1", "")).toBeUndefined();
  });
});
