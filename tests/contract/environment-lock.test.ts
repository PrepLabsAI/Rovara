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

  it("refuses a stale lock without confirmTakeover, naming how to clear it instead of offering takeover", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    const error = await withEnvironmentLock({ ...base, store, now: () => t0 }, async () => 1)
      .catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("older than 2 hours");
    expect(error.message).not.toContain("confirm to take it over");
    expect(error.message).toContain("/agentx/staging/lock");
    expect(error.message).toMatch(/no AgentX command is running/);
  });

  it("says the lock was released while waiting for takeover confirmation, when the recheck finds it gone", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    const confirmTakeover = async () => {
      // The original stale lock is released (e.g. cleaned up) while we wait for confirmation.
      store.values.delete("/agentx/staging/lock");
      return true;
    };
    const error = await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 1)
      .catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("released");
    expect(error.message).not.toContain("another command that took over");
    expect(error.message).toMatch(/run (?:the command|it) again/);
  });

  it("says the lock was removed by someone else while the work ran, when it is gone after the work finished", async () => {
    const store = new MemoryParameterStore();
    const error = await withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
      // Someone else removed the lock entirely (not a takeover) while our work was running.
      store.values.delete(lockParameterName("staging"));
      return 1;
    }).catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("removed by someone else");
    expect(error.message).toContain("work finished");
  });

  it("says the lock is unreadable, not released, when the recheck after takeover confirmation finds garbage", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    const confirmTakeover = async () => {
      // Something unparseable replaces the stale lock while we wait for takeover confirmation.
      store.values.set("/agentx/staging/lock", "not json");
      return true;
    };
    const error = await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 1)
      .catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("unreadable");
    expect(error.message).toContain("/agentx/staging/lock");
    expect(error.message).toContain("no AgentX command is running");
    expect(error.message).not.toContain("released");
  });

  it("says the lock is unreadable, not removed by someone else, when it is unparseable after the work finished", async () => {
    const store = new MemoryParameterStore();
    const error = await withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
      // Something unparseable replaces our lock (not a clean removal) while our work was running.
      store.values.set(lockParameterName("staging"), "not json");
      return 1;
    }).catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("unreadable");
    expect(error.message).toContain("/agentx/staging/lock");
    expect(error.message).not.toContain("removed by someone else");
  });

  it("distinguishes an unreadable lock from another command's re-create in the post-delete race", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    const realDelete = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (name: string) => {
      await realDelete(name);
      // Simulate another command's write landing in the gap between this command's delete and its own re-create.
      store.values.set(name, "not json");
    });
    const error = await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover: async () => true }, async () => 1)
      .catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("unreadable");
    expect(error.message).toContain("/agentx/staging/lock");
    expect(error.message).not.toContain("between this command's delete and re-create");
  });

  it("names the command that raced this one to re-create the lock right after this one deleted it", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    const realDelete = store.delete.bind(store);
    const otherLock = JSON.stringify({ holder: "carol", command: "env upgrade", acquiredAt: new Date(t0).toISOString() });
    vi.spyOn(store, "delete").mockImplementation(async (name: string) => {
      await realDelete(name);
      // Another command's own createOnly put lands in the gap between this command's delete and its re-create.
      store.values.set(name, otherLock);
    });
    const error = await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover: async () => true }, async () => 1)
      .catch((caught: unknown) => caught) as { code?: string; message?: string };
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("carol");
    expect(error.message).toContain("between this command's delete and re-create");
    expect(error.message).not.toContain("took over the lock first");
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

  it("offers a takeover of the caller's own fresh lock for the same command when takeOverOwn is set (Review Focus 1)", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    const result = await withEnvironmentLock({ ...base, command: "init", store, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 7);
    expect(result).toBe(7);
    expect(confirmTakeover).toHaveBeenCalledOnce();
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("refuses the caller's own fresh lock, saying how, when the takeover is declined", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store, now: () => t0, takeOverOwn: true, confirmTakeover: async () => false }, async () => 1))
      .rejects.toThrow("(your own earlier \"init\"; confirm the takeover only if that run is no longer going)");
  });

  it("never offers a takeover of someone else's fresh lock, or of the caller's own lock for another command", async () => {
    const confirmTakeover = vi.fn(async () => true);
    const other = new MemoryParameterStore();
    other.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store: other, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 1)).rejects.toThrow("locked by bob");
    const own = new MemoryParameterStore();
    own.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "deploy install", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store: own, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 1)).rejects.toThrow("running \"deploy install\"");
    expect(confirmTakeover).not.toHaveBeenCalled();
  });
});
