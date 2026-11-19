// Rovara picks only models the install can actually call. A call that a provider (or the model proxy) refused as "not available for this account" or "not priced" teaches the broker that, for a while, that model is
// not one to choose by default: the next default choice, for any task, leaves it out (`UsableModels.markUnusable`). This is the failure half of the hosted product's usability record (its availability probe reads the
// cloud's own account and stays Cloud's). The record is ONE row with flat attributes, under the hosted layout's key, so a company that moves between Code and the hosted product keeps what it learned:
//   `SETTINGS` / `MODEL_USABILITY`   `failed#<canonical model name>` = the time of the last refused call (ms)
// It is advice for DEFAULT choices only. Nothing here refuses a model somebody chose, and it never narrows a list to nothing: with no usable model left, the full list stands.
import { canonicalModelName, change, type DocumentStore, type ModelIdentifier } from "@agentx/contracts";

export const MODEL_USABILITY_KEY = { pk: "SETTINGS", sk: "MODEL_USABILITY" } as const;
/** How long a refused call keeps its model out of default choices. Short, so a model the owner has just enabled or priced comes back soon. */
export const FAILURE_TTL_MS = 30 * 60_000;
const FAILED_PREFIX = "failed#";
const NAME_MAX = 200;

export interface UsableModels {
  /** The canonical names (`canonicalModelName`) of the models known not to be callable now. Never throws; unknown is not listed. */
  unusable(): Promise<ReadonlySet<string>>;
  /** A call to `model` was refused as not enabled or not priced: keep it out of default choices for a while. Never throws. */
  markUnusable(model: ModelIdentifier): Promise<void>;
}

export interface UsableModelsDependencies {
  store: Pick<DocumentStore, "get" | "update">;
  now(): number;
  /** Told when the record could not be read or written (the error's name only: its words could hold a host). */
  onProblem?: (event: string, errorName: string) => void;
}

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function createUsableModels(deps: UsableModelsDependencies): UsableModels {
  const problem = (event: string, error: unknown): void => { try { deps.onProblem?.(event, error instanceof Error ? error.name : "unknown"); } catch { /* telling is never a reason to fail */ } };
  return {
    async unusable() {
      try {
        const now = deps.now();
        const item = await deps.store.get(MODEL_USABILITY_KEY);
        const out = new Set<string>();
        for (const [name, value] of Object.entries(item ?? {})) {
          if (!name.startsWith(FAILED_PREFIX)) continue;
          const failedAt = numberOf(value);
          // A mark from the future (a clock set back) never counts: it would hold a model out for as long as the clock is wrong.
          if (failedAt !== undefined && failedAt <= now && now - failedAt < FAILURE_TTL_MS) out.add(name.slice(FAILED_PREFIX.length));
        }
        return out;
      } catch (error) {
        // A record that cannot be read teaches nothing: every model stays usable, as before this check existed.
        problem("model_usability.unreadable", error);
        return new Set<string>();
      }
    },
    async markUnusable(model) {
      const name = canonicalModelName(model);
      if (name === "" || name.length > NAME_MAX) return;
      try {
        await deps.store.update({ key: MODEL_USABILITY_KEY, ops: [change.set([`${FAILED_PREFIX}${name}`], deps.now())] });
      } catch (error) { problem("model_usability.mark_failed", error); }
    },
  };
}

/** The models of `models` the install can call: the models unchanged, less those known not to work. Never empty because of this: with none usable left the list stands as it was. */
export function withoutUnusable(models: readonly ModelIdentifier[], unusable: ReadonlySet<string>): ModelIdentifier[] {
  if (unusable.size === 0) return [...models];
  const kept = models.filter((model) => !unusable.has(canonicalModelName(model)));
  return kept.length === 0 ? [...models] : kept;
}
