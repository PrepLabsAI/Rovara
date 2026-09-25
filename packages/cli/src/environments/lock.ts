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

/** Another command already took the stale lock before we could; racedHeld is what it now holds. */
const takeoverRaceMessage = (env: string, racedHeld: LockRecord | undefined) =>
  racedHeld === undefined
    ? `environment ${env} is locked by another command that took over the lock first`
    : `${heldMessage(env, racedHeld)}, which took over the lock first`;

/** The lock we held was replaced by someone else's while our own work was still running. */
const releaseTakeoverMessage = (env: string, held: LockRecord | undefined) =>
  `environment ${env}'s lock was taken over by ${held === undefined ? "another command" : held.holder} while this command ran (the work finished, but its own lock had already been replaced)`;

export async function withEnvironmentLock<T>(input: {
  store: ParameterStore; env: string; holder: string; command: string;
  now?: () => number; confirmTakeover?: (held: LockRecord) => Promise<boolean>;
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
    if (!stale) throw agentXError("CONFIG_INVALID", heldMessage(input.env, held));
    if (!input.confirmTakeover || !(await input.confirmTakeover(held))) {
      throw agentXError("CONFIG_INVALID", `${heldMessage(input.env, held)} (older than 2 hours; confirm to take it over)`);
    }

    // The lock may have changed while we waited for confirmation: it may have been released, or
    // another command may already have taken over this same stale lock. Re-check before touching it.
    const recheck = await input.store.get(name);
    if (recheck?.value !== stored.value) {
      const racedHeld = recheck === undefined ? undefined : parseLock(recheck.value);
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
      throw agentXError("CONFIG_INVALID", takeoverRaceMessage(input.env, racedHeld));
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
    throw agentXError("CONFIG_INVALID", releaseTakeoverMessage(input.env, held));
  }
  await input.store.delete(name);
  return result;
}
