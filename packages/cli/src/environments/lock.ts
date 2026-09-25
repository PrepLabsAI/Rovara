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

export async function withEnvironmentLock<T>(input: {
  store: ParameterStore; env: string; holder: string; command: string;
  now?: () => number; confirmTakeover?: (held: LockRecord) => Promise<boolean>;
}, work: () => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const name = lockParameterName(input.env);
  const mine: LockRecord = { holder: input.holder, command: input.command, acquiredAt: new Date(now()).toISOString() };
  try {
    await input.store.put(name, JSON.stringify(mine), { createOnly: true });
  } catch (error) {
    if (!(error instanceof ParameterExistsError)) throw error;
    const stored = await input.store.get(name);
    const held = stored === undefined ? undefined : parseLock(stored.value);
    if (held === undefined) {
      throw agentXError("CONFIG_INVALID", `environment ${input.env} is locked by an unreadable lock at ${name}; remove it only if no AgentX command is running`);
    }
    const message = `environment ${input.env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}`;
    const stale = now() - Date.parse(held.acquiredAt) > STALE_LOCK_MS;
    if (!stale) throw agentXError("CONFIG_INVALID", message);
    if (!input.confirmTakeover || !(await input.confirmTakeover(held))) {
      throw agentXError("CONFIG_INVALID", `${message} (older than 2 hours; confirm to take it over)`);
    }
    await input.store.put(name, JSON.stringify(mine));
  }
  let result: T;
  try {
    result = await work();
  } catch (workError) {
    try {
      await input.store.delete(name);
    } catch {
      /* the work's own error takes priority; a failed release is not reported over it */
    }
    throw workError;
  }
  await input.store.delete(name);
  return result;
}
