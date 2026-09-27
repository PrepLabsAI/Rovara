import { agentXError, environmentSettingsPrefix } from "@agentx/contracts";
import { ParameterExistsError, type ParameterStore } from "./parameter-store.js";

export interface LockRecord { holder: string; command: string; acquiredAt: string }
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

export function lockParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}lock`;
}

function parseLock(value: string): LockRecord | undefined {
  try {
    const record = JSON.parse(value) as Partial<LockRecord>;
    if (typeof record.holder === "string" && typeof record.command === "string" && typeof record.acquiredAt === "string" && !Number.isNaN(Date.parse(record.acquiredAt))) {
      return record as LockRecord;
    }
  } catch { /* fall through */ }
  return undefined;
}

const unreadableLockMessage = (env: string, name: string) =>
  `environment ${env} is locked by an unreadable lock at ${name}; remove it only if no AgentX command is running`;

const heldMessage = (env: string, held: LockRecord) => `environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}`;

/**
 * Another command already took the stale lock before we could (racedHeld is what it now holds), or
 * the stale lock was simply released while we waited for takeover confirmation (racedHeld is
 * undefined): nobody holds it now, so running the command again should succeed.
 */
const takeoverRaceMessage = (env: string, racedHeld: LockRecord | undefined) =>
  racedHeld === undefined
    ? `environment ${env}'s lock was released while this command waited for takeover confirmation; run the command again`
    : `${heldMessage(env, racedHeld)}, which took over the lock first`;

/**
 * By the time we tried to re-create the lock, another command's own createOnly put had already
 * landed in the small window between our delete of the stale lock and that re-create: it holds the
 * lock now (racedHeld names it), or it briefly held it and released it again before this check
 * (racedHeld is undefined). Either way this is not a takeover of the lock we deleted — it is a
 * fresh acquisition by someone else — so this command must simply be run again.
 */
const postDeleteRaceMessage = (env: string, racedHeld: LockRecord | undefined) =>
  racedHeld === undefined
    ? `environment ${env}'s lock was acquired and released by another command between this command's delete and re-create; run the command again`
    : `${heldMessage(env, racedHeld)}, which acquired the lock between this command's delete and re-create`;

/**
 * The lock we held was replaced by someone else's takeover while our own work was still running
 * (held names the new holder), or it was simply removed by someone else in that window and nobody
 * holds it now (held is undefined): either way the work itself finished.
 */
const releaseTakeoverMessage = (env: string, held: LockRecord | undefined) =>
  held === undefined
    ? `environment ${env}'s lock was removed by someone else while this command ran (the work finished, but there was no lock left to release)`
    : `environment ${env}'s lock was taken over by ${held.holder} while this command ran (the work finished, but its own lock had already been replaced)`;

export async function withEnvironmentLock<T>(input: {
  store: ParameterStore; env: string; holder: string; command: string;
  now?: () => number; confirmTakeover?: (held: LockRecord) => Promise<boolean>;
  /** Offers a takeover, without waiting for staleness, of a lock that is already this caller's own,
   * for this same command: `agentx init` uses it, since a closed terminal leaves its own lock held
   * (nothing releases it on process death) and the next `agentx init` run is otherwise refused for
   * up to two hours even though it is clearly the same person resuming. */
  takeOverOwn?: boolean;
}, work: () => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const name = lockParameterName(input.env);
  const mine: LockRecord = { holder: input.holder, command: input.command, acquiredAt: new Date(now()).toISOString() };
  const mineJson = JSON.stringify(mine);

  try {
    await input.store.put(name, mineJson, { createOnly: true });
  } catch (error) {
    if (!(error instanceof ParameterExistsError)) throw error;
    const stored = await input.store.get(name);
    if (stored === undefined) throw agentXError("CONFIG_INVALID", unreadableLockMessage(input.env, name));
    const held = parseLock(stored.value);
    if (held === undefined) throw agentXError("CONFIG_INVALID", unreadableLockMessage(input.env, name));

    const stale = now() - Date.parse(held.acquiredAt) > STALE_LOCK_MS;
    const ownEarlierRun = input.takeOverOwn === true && held.holder === input.holder && held.command === input.command;
    if (!stale && !ownEarlierRun) throw agentXError("CONFIG_INVALID", heldMessage(input.env, held));
    const why = stale
      ? "older than 2 hours"
      : `your own earlier "${held.command}"; confirm the takeover only if that run is no longer going`;
    if (!input.confirmTakeover) {
      throw agentXError("CONFIG_INVALID", `${heldMessage(input.env, held)} (${why}; to clear it, delete ${name} once you are sure no AgentX command is running)`);
    }
    if (!(await input.confirmTakeover(held))) {
      throw agentXError("CONFIG_INVALID", `${heldMessage(input.env, held)} (${why})`);
    }

    // The lock may have changed while we waited for confirmation: it may have been released, or
    // another command may already have taken over this same stale lock. Re-check before touching it.
    const recheck = await input.store.get(name);
    if (recheck?.value !== stored.value) {
      const racedHeld = recheck === undefined ? undefined : parseLock(recheck.value);
      if (recheck !== undefined && racedHeld === undefined) throw agentXError("CONFIG_INVALID", unreadableLockMessage(input.env, name));
      throw agentXError("CONFIG_INVALID", takeoverRaceMessage(input.env, racedHeld));
    }
    // SSM has no conditional delete, so a small window between the check above and this delete
    // remains: another command's createOnly put can still land in that window.
    await input.store.delete(name);
    try {
      await input.store.put(name, mineJson, { createOnly: true });
    } catch (raceError) {
      if (!(raceError instanceof ParameterExistsError)) throw raceError;
      const racedStored = await input.store.get(name);
      const racedHeld = racedStored === undefined ? undefined : parseLock(racedStored.value);
      if (racedStored !== undefined && racedHeld === undefined) throw agentXError("CONFIG_INVALID", unreadableLockMessage(input.env, name));
      throw agentXError("CONFIG_INVALID", postDeleteRaceMessage(input.env, racedHeld));
    }
  }

  let result: T;
  try {
    result = await work();
  } catch (workError) {
    try {
      // SSM has no conditional delete, so a small window between this check and the delete below
      // remains: only release the lock if it still holds exactly what we wrote.
      const stored = await input.store.get(name);
      if (stored?.value === mineJson) await input.store.delete(name);
    } catch {
      /* the work's own error takes priority; a failed release is not reported over it */
    }
    throw workError;
  }

  // SSM has no conditional delete, so a small window between this check and the delete below
  // remains: only release the lock if it still holds exactly what we wrote.
  const stored = await input.store.get(name);
  if (stored?.value !== mineJson) {
    const held = stored === undefined ? undefined : parseLock(stored.value);
    if (stored !== undefined && held === undefined) throw agentXError("CONFIG_INVALID", unreadableLockMessage(input.env, name));
    throw agentXError("CONFIG_INVALID", releaseTakeoverMessage(input.env, held));
  }
  await input.store.delete(name);
  return result;
}
