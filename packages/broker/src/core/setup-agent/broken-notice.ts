// L4-U5: the ONE message the project's admins get when its setup broke (design 3c: "one card for the project, not one per task"). It rides the attention queue the nightly upkeep notice uses (`core/notify/attention.ts`): a
// pending row per admin, delivered to the chats and the email they chose, in fixed words, only while they still administer the project and the setup is still broken. This file is the identity of the notice and the marker
// that makes it once:
//   - one notice per (company, project, re-check): the marker row `REPAIR_TOLD#<re-check key>` in the project's setup partition is written first and only while absent, so a second reader of the same break writes nothing;
//   - the subject id of the pending row is `setup-<16 hex of the re-check key>-<project>`, which no session id and no upkeep subject looks like;
//   - who is told is the host's recipient read (the project's admins and the company's owners and admins, live), re-checked at delivery; nobody to tell, or a failed read, gives the marker back so a later read tries again.
import { AGENTX_NAME_PATTERN, type DocumentKey, type OrgId } from "@agentx/contracts";
import { upkeepExpiryOf } from "../upkeep/keys.js";
import { setupPartition } from "./keys.js";

const KEY = /^[0-9a-f]{16,64}$/u;

export function repairToldKey(orgId: OrgId, project: string, recheckKey: string): DocumentKey {
  if (!KEY.test(recheckKey)) throw new Error("not a re-check key");
  return { pk: setupPartition(orgId, project), sk: `REPAIR_TOLD#${recheckKey}` };
}
/** The marker lives 62 days, as long as the re-check rows and the upkeep notice markers (the same expiry helper, so the store's expiry attribute is named in one place). */
export const repairToldExpiryOf = upkeepExpiryOf;

/** The pending row's subject id for this notice (the place a session id has on a task's row). */
export function setupBrokenSubjectId(parts: { project: string; recheckKey: string }): string {
  if (!AGENTX_NAME_PATTERN.test(parts.project) || !KEY.test(parts.recheckKey)) throw new Error("not a setup notice identity");
  return `setup-${parts.recheckKey.slice(0, 16)}-${parts.project}`;
}
const SUBJECT = /^setup-([0-9a-f]{16})-(.+)$/u;
/** The parts of a setup notice's subject id, or undefined when it is not one (a session id and an upkeep subject are never read as one). */
export function setupBrokenSubjectOf(subjectId: string): { prefix: string; project: string } | undefined {
  const match = SUBJECT.exec(subjectId);
  if (match === null || !AGENTX_NAME_PATTERN.test(match[2]!)) return undefined;
  return { prefix: match[1]!, project: match[2]! };
}
export const SETUP_BROKEN_KIND = "setup_broken" as const;
