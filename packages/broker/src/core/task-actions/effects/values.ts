// S1: reading what a person gave in a form (`ActionValues`), the same way for every entry. Nothing here trusts a value: an entry checks each against the live spec or the engine's own schema.
import { agentXError, type ActionValues } from "@agentx/contracts";
import { plainLine } from "../../decisions/text.js";

/** A text value, trimmed ("" when the person gave none). */
export function textOf(values: ActionValues, id: string): string {
  const value = values[id];
  return typeof value === "string" ? value.trim() : "";
}

/** The chosen values of a pick-many field. */
export function listOf(values: ActionValues, id: string): string[] {
  const value = values[id];
  return Array.isArray(value) ? value : typeof value === "string" && value !== "" ? [value] : [];
}

/** A required text: refused with `needs_input` and nothing written when it is empty. */
export function requiredText(values: ActionValues, id: string, what: string): string {
  const text = textOf(values, id);
  if (text === "") throw agentXError("TASK_ACTION_NEEDS_INPUT", `${what} is needed`, { reason: "needs_input", writes: "none" });
  return text;
}

/** A line of untrusted text (a finding, a task title) made inert for a form or a confirm: one plain line, no markup the surface could read as a mention or link, cut to `max`. */
export const inert = (text: string, max: number): string => plainLine(text, max).replace(/[<>&]/gu, " ").replace(/\s+/gu, " ").trim();

/** The refusal an entry throws when the press names something the live task no longer has: nothing was written. */
export const staleRefusal = (message: string): Error => agentXError("TASK_ACTION_STALE", message, { reason: "stale", writes: "none" });
export const notOfferedRefusal = (message: string): Error => agentXError("TASK_ACTION_NOT_OFFERED", message, { reason: "not_offered", writes: "none" });
export const needsWebRefusal = (message: string): Error => agentXError("TASK_ACTION_NEEDS_WEB", message, { reason: "needs_web", writes: "none" });
