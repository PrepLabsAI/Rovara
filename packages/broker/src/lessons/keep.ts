// L4-LP12b: the answer to the weekly list's "No task has needed it for a long time. Keep it?" card (`weekly-order.ts` cause `asked_to_keep`; the question is the fade row's `askedAt`, `expiry.ts`).
// A person who decides lessons here (the same eligibility `approve.ts` asks of an approval, a rejection or a retirement, read live) presses Keep: the lesson is renewed for a whole window and its fade state starts again
// (`keepQuietLesson`). Nothing else changes: not its text, its approvals, its counters, nor a retire proposal or a review mark it carries.
//
//   - Only while a question stands: the lesson is active and its fade state says a person was asked. A lesson nobody asked about is not renewed by this (so the route cannot be used to stretch any lesson's life), and a second
//     press after an answer finds no question: "not waiting".
//   - Only for a lesson the person may read (the access records now), as for a rejection.
//   - Audited BEFORE the write: no record, no change (`lesson.kept`, the lesson and the person; no words).
//   - Fail closed: an unreadable eligibility, fade state or lesson is a refusal that changes nothing.
import { keepQuietLesson } from "./expiry.js";
import type { ApproveDeps, ApprovalFailure } from "./approve.js";
import type { EvidenceSink } from "./evidence.js";
import { requireAudit, resolveLearning } from "./policy.js";
import { readVisible } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { idIn } from "./types.js";

export type KeepResult = { ok: true } | { ok: false; code: ApprovalFailure };

export async function keepByPerson(deps: ApproveDeps & { evidence: Pick<EvidenceSink, "readFade" | "writeFade"> }, input: { workspaceId: string; project: string; lessonId: string; actorId: string }): Promise<KeepResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (lesson.status !== "active") return { ok: false, code: "not_pending" };
  // The person's own standing and the access records NOW (a restricted lesson is read only by someone who could see its source), as for a rejection; no answer is a no.
  const mayRead = await readVisible({ access: deps.access, key, viewer: await deps.directory.identity(key.workspaceId, input.actorId), lessons: [lesson], where: "approve", log: deps.log }).then((shown) => shown.length === 1, () => false).catch(() => false);
  if (!mayRead) return { ok: false, code: "not_permitted" };
  const fade = await deps.evidence.readFade(key, lesson.id);
  // A fade state that cannot be read is not "no question": nothing is changed.
  if (fade === "unreadable") return { ok: false, code: "eligibility_unavailable" };
  if (fade?.askedAt === undefined) return { ok: false, code: "not_pending" };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project).catch(() => undefined);
  if (resolved === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!(await requireAudit(deps.audit, { action: "lesson.kept", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.actorId, facts: {} }))) return { ok: false, code: "audit_unavailable" };
  return (await keepQuietLesson(deps, deps.store, deps.evidence, key, lesson.id, resolved.expiryDays)) ? { ok: true } : { ok: false, code: "conflict" };
}
