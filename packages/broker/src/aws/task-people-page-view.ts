import { redactText } from "@agentx/contracts";
import type { TaskPeopleView } from "../developer/task-people.js";
import { escapeHtml } from "./web-session.js";

export type TaskPeopleConfirmationView = {
  taskId: string;
  requestId: string;
  expiresAt: string;
} & (
  | { kind: "role"; personName: string; role: TaskPeopleView["people"][number]["role"] }
  | { kind: "takeOwnership" }
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_THREAD_URL = /^https:\/\/slack\.com\/archives\/[CG][A-Z0-9]{2,31}\/p\d{16}$/;
const unavailable = '<section class="task-people" id="task-people" aria-labelledby="task-people-heading"><h2 id="task-people-heading">People unavailable</h2><p>Try again later.</p></section>';

function roleLabel(role: TaskPeopleView["people"][number]["role"]): string {
  switch (role) {
    case "owner": return "Owner";
    case "commenter": return "Commenter";
    case "viewer": return "Viewer";
    case "denied": return "Removed access";
  }
}

function boundedName(value: string): string {
  const safe = redactText(value).replace(/[\p{Cc}\s]+/gu, " ").trim();
  return Array.from(safe).slice(0, 80).join("") || "Task member";
}

function addPeopleLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SLACK_THREAD_URL.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "slack.com" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
    return url.toString();
  } catch { return undefined; }
}

function roleForm(person: TaskPeopleView["people"][number], revision: number): string {
  if (!UUID.test(person.personId)) return "";
  const name = boundedName(person.name);
  const personId = escapeHtml(person.personId);
  const controlId = `task-people-role-${personId}`;
  const options: Array<{ value: TaskPeopleView["people"][number]["role"]; label: string }> = [
    { value: "owner", label: "Owner" },
    { value: "commenter", label: "Commenter" },
    { value: "viewer", label: "Viewer" },
    { value: "denied", label: "Remove access" },
  ];
  const renderedOptions = options.map((option) => `<option value="${option.value}"${person.role === option.value ? " selected" : ""}>${option.label}</option>`).join("");
  return `<form class="task-people-role" data-people-role-form data-person-id="${personId}" data-people-revision="${revision}"><label for="${controlId}">Access for ${escapeHtml(name)}</label><select id="${controlId}" name="role" disabled>${renderedOptions}</select><button type="button" disabled>Review role change</button><span class="task-people-status" role="status" aria-live="polite"></span></form>`;
}

export function renderTaskPeoplePanel(taskId: string, view: TaskPeopleView): string {
  if (!UUID.test(taskId) || !Number.isSafeInteger(view.revision) || view.revision < 0 || !Array.isArray(view.people)) return unavailable;
  const people = view.people.map((person) => {
    if (!person || typeof person.personId !== "string" || !UUID.test(person.personId)) return "";
    const name = boundedName(person.name);
    const role = roleLabel(person.role);
    const current = person.effectiveRole === null ? "No access" : roleLabel(person.effectiveRole);
    const effective = person.effectiveRole !== person.role ? `<p class="task-people-current">Current access: ${escapeHtml(current)}</p>` : "";
    const you = person.you ? '<span class="task-people-you">You</span>' : "";
    const controls = view.canManage ? roleForm(person, view.revision) : "";
    return `<li class="task-people-person"><h3>${escapeHtml(name)} ${you}</h3><p class="task-people-role-label">${escapeHtml(role)}</p>${effective}${controls}</li>`;
  }).join("");
  const addUrl = view.canManage ? addPeopleLink(view.addPeopleUrl) : undefined;
  const add = addUrl === undefined ? "" : `<p><a class="task-people-add" href="${escapeHtml(addUrl)}">Add people in Slack</a></p>`;
  const takeover = view.canTakeOwnership
    ? `<form class="task-people-takeover" data-people-take-ownership-form data-people-revision="${view.revision}"><p>Taking ownership does not restart work.</p><button type="button" disabled>Take ownership</button><span class="task-people-status" role="status" aria-live="polite"></span></form>`
    : "";
  return `<section class="task-people" id="task-people" aria-labelledby="task-people-heading"><h2 id="task-people-heading">People</h2><ul class="task-people-list">${people}</ul>${add}${takeover}</section>`;
}

export function renderTaskPeopleUnavailable(): string {
  return unavailable;
}

export function renderTaskPeopleConfirmation(view: TaskPeopleConfirmationView): string {
  if (!UUID.test(view.taskId) || !UUID.test(view.requestId) || typeof view.expiresAt !== "string") return unavailable;
  const effect = view.kind === "takeOwnership"
    ? "Take ownership of this task."
    : `Change ${boundedName(view.personName)} to ${roleLabel(view.role)}.`;
  const cancelHref = `/review/${view.taskId}/task#task-people`;
  return `<section class="task-people-confirmation" aria-labelledby="task-people-confirmation-heading"><h2 id="task-people-confirmation-heading">Review People change</h2><p>${escapeHtml(effect)}</p><p>Expires <time datetime="${escapeHtml(view.expiresAt)}">${escapeHtml(view.expiresAt)}</time>.</p><button type="button" data-people-confirm="${escapeHtml(view.requestId)}" disabled>Confirm</button><a href="${escapeHtml(cancelHref)}">Cancel</a><p class="task-people-status" role="status" aria-live="polite"></p></section>`;
}
