// What the nightly passes remember between nights, one small item per company and pass in the document store (`LESSONSET#NIGHTLY#<pass>` in the company's partition, which a company erase wipes):
//   - `next`: where the pass starts tomorrow. Both passes walk the company's projects from a saved position, so when the time budget runs out the projects at the end are not the same ones every night.
//   - `projects` (the expiry pass): per project (a hash, never the name), when the sweep last ran for it and until when its pending lessons are held. A night that finds learning Off writes `off: true`; the first
//     night with learning On after that (or a project never seen) starts a grace window, so switching learning back on never expires the whole pending backlog on the first night. A project the rotation merely
//     reached late (the time budget) is not Off and opens no window.
// Nothing here names a person or a lesson. A read that fails is "no memory": the pass runs from the top with no grace written.
import { createHash } from "node:crypto";
import { teamRecordPk, type DocumentStore } from "@agentx/contracts";

export type NightlyPass = "expire" | "promote" | "repair";
export interface NightlyProjectState { seenAt: number; graceUntil?: number; /** The trial repair (`repair` pass): where in the project's sorted pending cards tomorrow's walk starts (a count, never a card or lesson id). */ cardsNext?: number; /** The night found learning Off for the project: its next night with learning On opens the grace window. */ off?: true }
export interface NightlyPassState { next: number; projects: Record<string, NightlyProjectState> }
export interface NightlyStateStore {
  /** Throws when the item cannot be read (the pass then neither rotates nor writes). */
  read(orgId: string, pass: NightlyPass): Promise<NightlyPassState>;
  write(orgId: string, pass: NightlyPass, state: NightlyPassState): Promise<void>;
}

/** How long a returning project's pending lessons are held. */
export const PENDING_GRACE_MS = 7 * 86_400_000;
const MAX_PROJECT_STATES = 400;

export const projectHash = (orgId: string, project: string): string => createHash("sha256").update(`${orgId}\u0000${project}`).digest("hex").slice(0, 12);
const keyOf = (orgId: string, pass: NightlyPass) => ({ pk: teamRecordPk(orgId, undefined), sk: `LESSONSET#NIGHTLY#${pass.toUpperCase()}` });

export function documentNightlyState(store: DocumentStore): NightlyStateStore {
  return {
    async read(orgId, pass) {
      const item = await store.get(keyOf(orgId, pass));
      if (item === undefined) return { next: 0, projects: {} };
      const next = typeof item["next"] === "number" && Number.isInteger(item["next"]) && item["next"] >= 0 ? item["next"] : 0;
      const projects: Record<string, NightlyProjectState> = {};
      if (typeof item["projects"] === "object" && item["projects"] !== null) {
        for (const [hash, value] of Object.entries(item["projects"] as Record<string, unknown>).slice(0, MAX_PROJECT_STATES)) {
          const v = value as { seenAt?: unknown; graceUntil?: unknown; off?: unknown; cardsNext?: unknown };
          if (typeof v?.seenAt === "number") projects[hash] = { seenAt: v.seenAt, ...(typeof v.graceUntil === "number" ? { graceUntil: v.graceUntil } : {}), ...(v.off === true ? { off: true as const } : {}), ...(typeof v.cardsNext === "number" && Number.isInteger(v.cardsNext) && v.cardsNext >= 0 ? { cardsNext: v.cardsNext } : {}) };
        }
      }
      return { next, projects };
    },
    async write(orgId, pass, state) {
      await store.put({ item: { ...keyOf(orgId, pass), entityType: "LESSON_NIGHTLY", next: state.next, projects: JSON.parse(JSON.stringify(state.projects)) as never } });
    },
  };
}

/** The projects in a fixed order (sorted) starting at `next`, wrapping round. */
export function rotated(projects: readonly string[], next: number): string[] {
  const sorted = [...new Set(projects)].sort();
  if (sorted.length === 0) return [];
  const start = next % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}
