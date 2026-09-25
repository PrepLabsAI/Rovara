import { describe, expect, it, vi } from "vitest";
import { STALE_LOCK_MS, lockParameterName, withEnvironmentLock } from "../../packages/cli/src/environments/lock.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const base = { env: "staging", holder: "arn:aws:iam::123456789012:user/alice", command: "env adopt" };
const t0 = Date.parse("2026-09-26T00:00:00.000Z");

describe("environment lock", () => {
  it("holds the lock while the work runs and releases it afterwards", async () => {
    const store = new MemoryParameterStore();
    const result = await withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
      expect(JSON.parse(store.values.get(lockParameterName("staging"))!)).toEqual({ holder: base.holder, command: "env adopt", acquiredAt: "2026-09-26T00:00:00.000Z" });
      return 42;
    });
    expect(result).toBe(42);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("releases the lock when the work fails", async () => {
    const store = new MemoryParameterStore();
    await expect(withEnvironmentLock({ ...base, store }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("refuses a fresh lock and names its holder, without running the work", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const work = vi.fn(async () => 1);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, work))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("locked by bob running \"upgrade\"") as unknown });
    expect(work).not.toHaveBeenCalled();
    expect(store.values.has("/agentx/staging/lock")).toBe(true);
  });

  it("does not offer takeover of a fresh lock", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(confirmTakeover).not.toHaveBeenCalled();
  });

  it("takes over a stale lock only after confirmation", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    await expect(withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover: async () => false }, async () => 1))
      .rejects.toMatchObject({ message: expect.stringContaining("older than 2 hours") as unknown });
    const confirmTakeover = vi.fn(async () => true);
    expect(await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 7)).toBe(7);
    expect(confirmTakeover).toHaveBeenCalledWith(stale);
  });

  it("treats an unreadable lock as held, not as free", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", "not json");
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, async () => 1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rethrows the work's error even when releasing the lock also fails", async () => {
    const store = new MemoryParameterStore();
    const deleteError = new Error("ssm unavailable");
    vi.spyOn(store, "delete").mockRejectedValue(deleteError);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
  });

  it("surfaces the release failure when the work succeeded but the delete failed", async () => {
    const store = new MemoryParameterStore();
    const deleteError = new Error("ssm unavailable");
    vi.spyOn(store, "delete").mockRejectedValue(deleteError);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, async () => 1))
      .rejects.toThrow("ssm unavailable");
  });

  it("two commands racing to take over the same stale lock: exactly one wins", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));

    // The second command's work starts only once it has actually re-acquired the lock (deleted the
    // stale one and put its own with createOnly). The first command's confirmTakeover doesn't resolve
    // until that has happened, so the first command's re-check is guaranteed to see the second's lock.
    let resolveSecondAcquired!: () => void;
    const secondAcquired = new Promise<void>((resolve) => { resolveSecondAcquired = resolve; });
    let resolveSecondWork!: (value: string) => void;
    const secondWorkDone = new Promise<string>((resolve) => { resolveSecondWork = resolve; });

    const firstWork = vi.fn(async () => "first");
    const secondWork = vi.fn(async () => {
      resolveSecondAcquired();
      return secondWorkDone;
    });

    const firstPromise = withEnvironmentLock(
      {
        env: "staging",
        holder: "alice",
        command: "env adopt",
        store,
        now: () => t0,
        confirmTakeover: async () => {
          await secondAcquired;
          return true;
        },
      },
      firstWork,
    );
    const secondPromise = withEnvironmentLock(
      { env: "staging", holder: "carol", command: "env upgrade", store, now: () => t0, confirmTakeover: async () => true },
      secondWork,
    );

    await expect(firstPromise).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("carol") as unknown });
    expect(firstWork).not.toHaveBeenCalled();

    resolveSecondWork("second");
    await expect(secondPromise).resolves.toBe("second");
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("reports a takeover that happened during the work, and leaves the new holder's lock alone", async () => {
    const store = new MemoryParameterStore();
    const otherLock = JSON.stringify({ holder: "carol", command: "env upgrade", acquiredAt: new Date(t0).toISOString() });
    await expect(
      withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
        // Simulate another command taking over the lock (e.g. a confirmed stale takeover
        // elsewhere) while this command's work is still running.
        store.values.set(lockParameterName("staging"), otherLock);
        return 1;
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("carol") as unknown });
    expect(store.values.get(lockParameterName("staging"))).toBe(otherLock);
  });

  it("keeps rethrowing the work's error when the lock was replaced during a failing work, and leaves the other lock in place", async () => {
    const store = new MemoryParameterStore();
    const otherLock = JSON.stringify({ holder: "carol", command: "env upgrade", acquiredAt: new Date(t0).toISOString() });
    await expect(
      withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
        store.values.set(lockParameterName("staging"), otherLock);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.values.get(lockParameterName("staging"))).toBe(otherLock);
  });
});
