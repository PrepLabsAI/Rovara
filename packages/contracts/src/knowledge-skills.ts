// K1 C4: skills that live in a project's meta repo.
//
// Rovara reads these itself, at the meta repo's pinned commit, and gives the session the text and nothing else: a skill grants no tools.
// The snapshot below is the reference stored with a stage's "what the agent loaded" record and, when the broker pins skills, the pin the
// worker checks: where the skill came from and the SHA-256 of the text the session was given. It never carries the skill's text.
import { z } from "zod";

/** The most meta-repo skills one stage lists. */
export const MAX_META_SKILLS = 32;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const CommitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const MetaSkillSnapshotSchema = z.object({
  source: z.literal("meta"),
  /** The meta repository's name in the project. */
  repo: z.string().min(1).max(200),
  /** The skill folder, relative to the repository (`.agents/skills/build-tool`). */
  path: z.string().min(1).max(400),
  /** The meta repo's commit the skill was read at: the task's `knowledgeCommit`. */
  commit: CommitId,
  /** SHA-256 of the skill text the session was given (after `!` lines are removed). */
  digest: Sha256,
}).strict();
export type MetaSkillSnapshot = z.infer<typeof MetaSkillSnapshotSchema>;

/** What the broker may send to pin skills: the folder and the digest it expects there. A mismatch leaves that skill out. */
export const MetaSkillPinSchema = z.object({ path: z.string().min(1).max(400), digest: Sha256 }).strict();
export type MetaSkillPin = z.infer<typeof MetaSkillPinSchema>;

export const MetaSkillSkipReasonSchema = z.enum([
  "bad_front_matter", "bad_name", "duplicate_name", "too_large", "over_cap", "digest_mismatch", "not_pinned", "unreadable", "symlink",
]);
export type MetaSkillSkipReason = z.infer<typeof MetaSkillSkipReasonSchema>;
