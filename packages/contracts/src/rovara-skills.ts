// Lead 4 L4-AK3: skills that live in Rovara (owner decision 2026-11-17), next to the meta repo's. A skill is a procedure the team proved, written as a SKILL.md, stored as versioned rows in Rovara's store (company and
// project scoped), approved by TWO people, and served to a step through the same `read_skill` path the meta repo's skills use. Text only: a skill grants nothing (`allowed-tools` is never read and a pre-run line never
// runs; the worker removes both when it loads one, as for a meta-repo skill). Where a Rovara skill and a meta-repo skill share a name, the meta repo's wins and the worker says so.
import { z } from "zod";

/** The feature a worker lists when it can take `rovaraSkills` on a step (the broker sends them to no other worker). */
export const ROVARA_SKILLS_FEATURE = "task.rovaraSkills.v1" as const;

/** The same slug as every skill's name. */
export const ROVARA_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** One skill's text is at most the meta-repo skills' limit (32 KB). Over this, a skill is refused. */
export const ROVARA_SKILL_TEXT_MAX_BYTES = 32_768;
/** Above this a person is told, gently, that the skill is long (the text is kept, nothing is refused). */
export const ROVARA_SKILL_LONG_NOTE_BYTES = 8_192;
export const ROVARA_SKILL_LONG_NOTE = "This skill is long. Consider splitting it into smaller skills.";
/** Two different people approve a skill before it is used. */
export const ROVARA_SKILL_APPROVERS_REQUIRED = 2;
/** At most this many Rovara skills go to one step, and at most this many bytes of skill text in all (a step's payload has a limit): skills past either are not offered, so none is half-sent. */
export const ROVARA_SKILLS_PER_STEP_MAX = 8;
export const ROVARA_SKILLS_PAYLOAD_BYTES_MAX = 98_304;
/** A skill's one-line description (what it is for and when to use it). */
export const ROVARA_SKILL_DESCRIPTION_MAX = 200;
/** A skill is offered ("Make this a skill?") only for a procedure lesson that has proved itself: used in at least this many tasks, over at least this many days, never marked wrong, anchors valid, two people or one person and a measured result. Start values. */
export const ROVARA_SKILL_PROVEN = { tasks: 10, days: 30 } as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** One Rovara skill as the broker sends it to a worker: the text, its version and the digest of exactly that text. */
export const RovaraSkillFileSchema = z.object({
  name: z.string().regex(ROVARA_SKILL_NAME),
  description: z.string().min(1).max(ROVARA_SKILL_DESCRIPTION_MAX),
  version: z.number().int().min(1),
  digest: Sha256,
  content: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= ROVARA_SKILL_TEXT_MAX_BYTES, `a skill is at most ${String(ROVARA_SKILL_TEXT_MAX_BYTES)} bytes`),
}).strict();
export type RovaraSkillFile = z.infer<typeof RovaraSkillFileSchema>;

export const RovaraSkillsPayloadSchema = z.array(RovaraSkillFileSchema).max(ROVARA_SKILLS_PER_STEP_MAX)
  .refine((skills) => skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, "utf8"), 0) <= ROVARA_SKILLS_PAYLOAD_BYTES_MAX, "too much skill text for one step")
  .refine((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length, "two skills with one name");
