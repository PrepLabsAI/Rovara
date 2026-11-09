// Trust and audience: who a piece of text can be believed from, and who may see a row (learning v2, design 2026-10-30 section 4.2). Lessons read these shapes; the
// Team record that fills them is a Cloud plug-in (decision 41), so they live here without it. Decision 51: the source of a permission snapshot is any adapter's id
// (`slack`, `github`, `codehost:examplehost`, a tracker or a chat channel adapter), not a fixed list, so a second provider plugs in with no change here. Cloud's
// team-record.ts imports these from here and narrows `source` to the adapters it knows.
import { z } from "zod";

/**
 * Who a piece of text can be believed from, lowest first.
 * - `outsider`: Slack-only people, Slack Connect externals, non-member GitHub users, unknown MCP authors. Never read by a model.
 * - `system`: customer-system fields (CI log text, ticket metadata, bot text). Data, never advice.
 * - `member`: a company member with a live project role.
 * - `rovara`: Rovara's own structured signals (CI result, merge, revert, diff stats). No free text from people.
 */
export const TRUST_CLASSES = ["outsider", "system", "member", "rovara"] as const;
export const TrustClassSchema = z.enum(TRUST_CLASSES);
export type TrustClass = z.infer<typeof TrustClassSchema>;

export const TRUST_RANK: Readonly<Record<TrustClass, number>> = { outsider: 0, system: 1, member: 2, rovara: 3 };

/** The lowest trust of the given classes. Derivation never raises trust: a row built from several inputs carries this. An empty list is `outsider` (fail closed). */
export function minTrust(...classes: readonly TrustClass[]): TrustClass {
  let lowest: TrustClass | undefined;
  for (const trust of classes) if (lowest === undefined || TRUST_RANK[trust] < TRUST_RANK[lowest]) lowest = trust;
  return lowest ?? "outsider";
}

/** Any adapter's source id: a plain name (`slack`), or a plug-in kind and name (`codehost:examplehost`). */
export const RecordSourceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,40}(?::[a-z][a-z0-9-]{0,40})?$/);
export type RecordSourceId = z.infer<typeof RecordSourceIdSchema>;

export const ACL_PRINCIPALS_MAX = 500;
/** The permission snapshot taken at capture. `principals` are source-native ids (chat user ids, code host numeric ids) for private scopes. */
export const AclSnapshotSchema = z.object({
  source: RecordSourceIdSchema,
  scope: z.string().min(1).max(300),
  principals: z.array(z.string().min(1).max(100)).max(ACL_PRINCIPALS_MAX).optional(),
  groups: z.array(z.string().min(1).max(100)).max(50).optional(),
  capturedAt: z.string().datetime(),
  /** `on_read`: when shown to a person, re-check at the source (cached 15 minutes). */
  liveCheck: z.enum(["none", "on_read"]),
}).strict();
export type AclSnapshot = z.infer<typeof AclSnapshotSchema>;

/** A group id a permission filter reads as "the maintainers of this project": the fail-closed audience of a source whose admin has not said "visible to all project members". */
export const MAINTAINERS_GROUP = "project:maintainers";

/** Who may see a row: every project member, or only the principals the snapshot names. */
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("restricted"), acl: AclSnapshotSchema }).strict(),
]);
export type Audience = z.infer<typeof AudienceSchema>;

/** A project name (the AgentX name pattern). */
export const RecordProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
