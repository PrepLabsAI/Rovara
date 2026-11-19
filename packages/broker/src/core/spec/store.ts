// A task's spec state on the document store, at the same key Cloud keeps it (`DEVTASK#<task>` / `SPEC#STATE`, `specStateKey`). An item that is there but is not a state this release reads is `corrupt`:
// the code pull request is held, never let through.
import { type DocumentStore } from "@agentx/contracts";
import { specStateItem, stateDocument, type SpecStore } from "./hooks.js";
import { SpecStateSchema, specStateKey } from "./state.js";

export function documentSpecStore(store: Pick<DocumentStore, "get" | "put" | "transact">): SpecStore {
  return {
    async load(taskId) {
      const found = await store.get(specStateKey(taskId));
      if (found === undefined) return { state: undefined, corrupt: false };
      const parsed = SpecStateSchema.safeParse(found);
      return parsed.success ? { state: parsed.data, corrupt: false } : { state: undefined, corrupt: true };
    },
    async force(next, extra) {
      // Whatever is there is replaced, readable or not; with `extra` items (an access fence) they commit together or not at all.
      if (extra !== undefined && extra.length > 0) return (await store.transact([{ kind: "put", item: stateDocument(next) }, ...extra])).applied;
      return (await store.put({ item: stateDocument(next) })).applied;
    },
    async save(next, replaces, extra) {
      // With `extra` items the state and they commit together or not at all; a failed fence is a lost write, like a lost race.
      if (extra !== undefined && extra.length > 0) return (await store.transact([specStateItem(next, replaces), ...extra])).applied;
      return (await store.transact([specStateItem(next, replaces)])).applied;
    },
  };
}
