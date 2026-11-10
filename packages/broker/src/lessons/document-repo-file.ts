// The document-store side of `RepoFileStore` (repo-file-state.ts). Items under the LESSONSET prefix a project or company erase already wipes:
//   - one STATE item per project and repository: pk of the project (`teamRecordPk(workspace, project)`), sk `LESSONSET#REPOFILE#<16 hex of the repository place>`; attributes `state` and `revision`;
//   - one PR row per Rovara-made pull request (and one `watch` row per repository Rovara has written to): sk `LESSONSET#REPOFILEPR#<16 hex of the place>#<number>`. Read by the erasure sweep alone, apart from the state; never part of a capped list.
// They hold ids, fingerprints, counts, branch names and times: never a lesson's text, a person or a host's words. A state write is conditional on the revision read and is checked against its schema and size first; an item that exists
// and does not parse THROWS when read (it is never "absent", which would let a pass write a fresh state over it).
import { createHash } from "node:crypto";
import { queryAll, teamRecordPk, when, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { PrRowSchema, StateUnreadable, checkedState, parseRepoFileState, type PrRow, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

const STATE = "LESSONSET#REPOFILE#";
const PR = "LESSONSET#REPOFILEPR#";
const hash = (place: string): string => createHash("sha256").update(place).digest("hex").slice(0, 16);
const pkOf = (key: ScopeKey): string => teamRecordPk(key.workspaceId, key.project);
const stateKey = (key: ScopeKey, place: string) => ({ pk: pkOf(key), sk: `${STATE}${hash(place)}` });
const prKey = (key: ScopeKey, place: string, number: string) => ({ pk: pkOf(key), sk: `${PR}${hash(place)}#${number}` });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function documentRepoFileStore(store: DocumentStore, options: { onUnreadable?: (what: "state" | "row") => void } = {}): RepoFileStore {
  const read = (item: Record<string, unknown>): RepoFileState => {
    const state = parseRepoFileState(item["state"]);
    if (state === undefined || typeof item["revision"] !== "number") throw new StateUnreadable();
    // The item's own revision is the one the condition is written against.
    return { ...state, revision: item["revision"] };
  };
  const query = (key: ScopeKey, prefix: string): Promise<StoredDocument[]> => queryAll(store, { pk: pkOf(key), sk: { op: "beginsWith", prefix } });
  return {
    async list(key) {
      // One item that does not parse (a newer build wrote it, or it was edited by hand) is reported and skipped: it never hides the other repositories.
      const states: RepoFileState[] = [];
      for (const item of await query(key, STATE)) { try { states.push(read(item)); } catch { options.onUnreadable?.("state"); } }
      return states.sort((a, b) => a.place.localeCompare(b.place));
    },
    async get(key, place) {
      const item = await store.get(stateKey(key, place));
      return item === undefined ? undefined : read(item);
    },
    async put(key, state, expected) {
      const revision = expected + 1;
      // Checked first (schema and size): a state that would not read back is refused here, loudly. JSON drops the fields that are undefined.
      const stored: RepoFileState = json({ ...checkedState(state), revision });
      const written = await store.put({
        item: { ...stateKey(key, state.place), entityType: "LESSON_REPOFILE", state: stored, revision } as unknown as StoredDocument,
        condition: expected === 0 ? when.absent() : when.eq("revision", expected),
      });
      return written.applied ? stored : undefined;
    },
    async listPrs(key) {
      const rows: PrRow[] = [];
      let unreadable = 0;
      for (const item of await query(key, PR)) {
        const row = PrRowSchema.safeParse(item["row"]);
        if (row.success && row.data.kind === "lease") continue;
        if (row.success) rows.push(row.data); else { unreadable += 1; options.onUnreadable?.("row"); }
      }
      return { rows, unreadable };
    },
    async putPr(key, row: PrRow) {
      const checked = PrRowSchema.parse(row);
      await store.put({ item: { ...prKey(key, checked.place, checked.number), entityType: "LESSON_REPOFILE_PR", row: json(checked) } as unknown as StoredDocument });
    },
    async claimPr(key, row: PrRow) {
      const checked = PrRowSchema.parse(row);
      const at = prKey(key, checked.place, checked.number);
      const written = await store.put({ item: { ...at, entityType: "LESSON_REPOFILE_PR", row: json(checked) } as unknown as StoredDocument, condition: when.absent() });
      if (written.applied) return { claimed: true as const };
      const held = await store.get(at);
      const parsed = PrRowSchema.safeParse(held?.["row"]);
      // A held row that cannot be read is held from now: it is taken over only once it has aged.
      return { claimed: false as const, heldSince: parsed.success ? parsed.data.at : checked.at };
    },
    async delPr(key, place, number) {
      await store.delete({ key: prKey(key, place, number) });
    },
  };
}
