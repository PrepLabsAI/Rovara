// The two ends of "make this lesson a skill", joined (lessons phase 4 + L4-AK3). Graduation (`graduate.ts`) offers the target and asks for a draft through `SkillGraduation`; AK3's library (`skills.ts`) drafts it by CODE (no
// model call), needs TWO different eligible people to approve it, and when it goes live retires the lesson with `became` -> the skill (`recordBecame`). This file builds both from one company's runtime, so a route cannot be
// wired with one and not the other, and so a decision always reads phase 2's signals FRESH (`freshSignalsReader`), never a copy that may be old.
import type { OrgId } from "@agentx/contracts";
import type { SkillGraduation } from "./graduate.js";
import type { LessonsRuntime } from "./runtime.js";
import { freshSignalsReader } from "./signals.js";
import { draftSkillFromLesson, type SkillDeps } from "./skills.js";

type RuntimeParts = Pick<LessonsRuntime, "documents" | "store" | "directory" | "audit" | "access" | "vectors">;

/** The skills library's dependencies for ONE company: its store, its approver directory, its audit, and a fresh read of its own project signals. */
export function skillDepsOf(runtime: RuntimeParts, input: { companyId: OrgId; now: () => number; log?: SkillDeps["log"] }): SkillDeps {
  return {
    documents: runtime.documents, lessons: runtime.store, directory: runtime.directory, audit: runtime.audit, access: runtime.access, now: input.now, vectors: runtime.vectors,
    signals: freshSignalsReader(runtime.documents, input.companyId, input.now), ...(input.log === undefined ? {} : { log: input.log }),
  };
}

/** What graduation drafts a skill through: AK3's `draftSkillFromLesson` for this company. Nothing is retired by the draft; the lesson becomes the skill when its second approval takes it live. */
export function skillGraduationOf(deps: SkillDeps): SkillGraduation {
  return { draft: (key, input) => draftSkillFromLesson(deps, key, input) };
}
