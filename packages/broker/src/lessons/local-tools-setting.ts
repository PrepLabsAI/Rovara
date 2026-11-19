// Lessons for local coding tools (decision 46b): the two switches and what they come to. The project's own ("local coding tools can fetch lessons": a maintainer) and the company's "lessons stay in Rovara" (an owner or
// admin). The default is ON for a project under the Standard preset and OFF under Regulated, whatever the project chose; the company's switch turns it off for every project. Every change is audited BEFORE it is made (the
// ledger records who and the new value; the stored item names no person), and every read here is live, never cached. The routes and the page that call these decide who may.
import type { LocalToolsState } from "@agentx/contracts";
import { requireAudit, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import type { LocalToolsSettingsReader, LocalToolsSettingsStore } from "./local-tools.js";

export type LocalToolsSetResult = { ok: true; changed: boolean } | { ok: false; code: "audit_unavailable" | "unreadable" };

/** What the settings come to for a project now: whether a local tool gets lessons as far as the settings go, and the first reason it does not. Throws when a stored value cannot be read. */
export async function readLocalToolsState(deps: { localTools: LocalToolsSettingsReader; settings: LearningSettingsReader }, workspaceId: string, project: string): Promise<LocalToolsState> {
  const local = await deps.localTools.read(workspaceId, project);
  const resolved = await resolveLearning(deps.settings, workspaceId, project);
  const reason = local.companyStays ? "company_stays" as const : resolved.preset === "regulated" ? "regulated" as const : local.projectOn === false ? "project_setting" as const : undefined;
  return { enabled: reason === undefined, ...(local.projectOn === undefined ? {} : { own: local.projectOn }), ...(reason === undefined ? {} : { reason }), preset: resolved.preset, companyStays: local.companyStays };
}

/** A maintainer's choice for one project. */
export async function setProjectLocalTools(deps: { localTools: LocalToolsSettingsStore; audit: LessonAuditSink; now: () => number }, input: { workspaceId: string; project: string; enabled: boolean; by: string }): Promise<LocalToolsSetResult> {
  let before;
  try { before = await deps.localTools.read(input.workspaceId, input.project); } catch { return { ok: false, code: "unreadable" }; }
  if (!await requireAudit(deps.audit, { action: "lesson.local_tools_switched", workspaceId: input.workspaceId, project: input.project, actor: input.by, facts: { scope: "project", enabled: input.enabled } })) return { ok: false, code: "audit_unavailable" };
  try { await deps.localTools.setProject(input.workspaceId, input.project, input.enabled, deps.now()); } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true, changed: (before.projectOn ?? true) !== input.enabled };
}

/** An owner's or admin's choice for the company: `stays` true keeps lessons inside Rovara, so local tools get none for any project. */
export async function setCompanyLocalTools(deps: { localTools: LocalToolsSettingsStore; audit: LessonAuditSink; now: () => number }, input: { workspaceId: string; stays: boolean; by: string }): Promise<LocalToolsSetResult> {
  let before: boolean;
  try { before = await deps.localTools.readCompany(input.workspaceId); } catch { return { ok: false, code: "unreadable" }; }
  if (!await requireAudit(deps.audit, { action: "lesson.local_tools_switched", workspaceId: input.workspaceId, project: "_workspace", actor: input.by, facts: { scope: "company", enabled: !input.stays } })) return { ok: false, code: "audit_unavailable" };
  try { await deps.localTools.setCompany(input.workspaceId, input.stays, deps.now()); } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true, changed: before !== input.stays };
}
