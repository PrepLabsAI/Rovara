// A task's spec on hold as a decision card's item. The card says the broker's fixed sentence and opens the task page, where the owner's buttons are (a held spec is answered on the
// page, as a question or a checks choice is). The decision-card sources (`decisions/routes.ts`, `DecisionSources.list`) include these items for the task's owner; that source is mounted by the
// install wiring.
import { specGate, type SpecState } from "./state.js";
import type { DecisionItem } from "../decisions/project.js";
import { taskOpenPath } from "../decisions/open-path.js";

/** The item for a task whose spec is on hold and has something for the owner to choose; nothing otherwise. */
export function specChoiceItemOf(input: { taskId: string; project: string; sessionId?: string | undefined; title: string; state: SpecState | undefined; corrupt?: boolean | undefined; now: string }): DecisionItem | undefined {
  const gate = specGate(input.state, input.corrupt === true, input.now);
  if (gate.action !== "hold" || gate.ownerActions.length === 0) return undefined;
  return {
    kind: "spec_choice", subjectId: input.taskId, taskId: input.taskId, project: input.project, title: input.title, createdAt: input.state?.updatedAt ?? input.now,
    openPath: taskOpenPath(input), contentVersion: `${String(input.state?.revision ?? 0)}`, message: gate.message,
  };
}
