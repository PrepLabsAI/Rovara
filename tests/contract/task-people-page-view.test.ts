import { describe, expect, it } from "vitest";
import {
  renderTaskPeopleConfirmation,
  renderTaskPeoplePanel,
  renderTaskPeopleUnavailable,
  type TaskPeopleConfirmationView,
} from "../../packages/broker/src/aws/task-people-page-view.js";
import type { TaskPeopleView } from "../../packages/broker/src/developer/task-people.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const view = (overrides: Partial<TaskPeopleView> = {}): TaskPeopleView => ({
  revision: 7,
  orphaned: false,
  people: [
    { personId: OWNER_ID, name: "Avery Owner", role: "owner", you: true, effectiveRole: "owner" },
    { personId: MEMBER_ID, name: "Morgan Member", role: "viewer", you: false, effectiveRole: "viewer" },
  ],
  canManage: false,
  canTakeOwnership: false,
  addPeopleUrl: `/v1/tasks/${TASK_ID}/people/add`,
  ...overrides,
});

describe("task People page presentation", () => {
  it("shows a read-only People list without controls or opaque identifiers", () => {
    const html = renderTaskPeoplePanel(TASK_ID, view());
    expect(html).toContain("<h2");
    expect(html).toContain("People");
    expect(html).toContain("Avery Owner");
    expect(html).toContain("Morgan Member");
    expect(html).toContain("Owner");
    expect(html).toContain("Viewer");
    expect(html).not.toContain("data-person-id");
    expect(html).not.toContain("data-people-role-form");
    expect(html).not.toContain(OWNER_ID);
    expect(html).not.toContain(MEMBER_ID);
    expect(html).not.toContain("people/add");
  });

  it("provides the same anchor targeted by confirmation Cancel", () => {
    const panel = renderTaskPeoplePanel(TASK_ID, view());
    const unavailable = renderTaskPeopleUnavailable();
    const confirmation = renderTaskPeopleConfirmation({ kind: "takeOwnership", taskId: TASK_ID, requestId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-10-11T12:10:00.000Z" });
    const href = confirmation.match(/<a href="([^"]+)">Cancel<\/a>/)?.[1] ?? "";
    const target = href.split("#")[1] ?? "";
    expect(target).toBe("task-people");
    expect(panel).toContain(`id="${target}"`);
    expect(unavailable).toContain(`id="${target}"`);
  });

  it("renders only existing-person role controls for managers and leaves them disabled", () => {
    const html = renderTaskPeoplePanel(TASK_ID, view({ canManage: true, addPeopleUrl: "https://slack.com/archives/C0PEOPLE1/p1791720000123456" }));
    expect(html).toContain('data-people-role-form');
    expect(html).toContain(`data-person-id="${OWNER_ID}"`);
    expect(html).toContain(`data-person-id="${MEMBER_ID}"`);
    expect(html).toContain('data-people-revision="7"');
    expect(html).toContain('name="role"');
    expect(html).toContain('value="owner"');
    expect(html).toContain('value="commenter"');
    expect(html).toContain('value="viewer"');
    expect(html).toContain('value="denied"');
    expect(html).toContain("Review role change");
    expect(html).toContain('disabled');
    expect(html).toContain('href="https://slack.com/archives/C0PEOPLE1/p1791720000123456"');
    expect(html).toContain("Add people in Slack");
    expect(html).not.toMatch(/<input\b/i);
    expect(html).not.toMatch(/\b(?:action|method|onclick)=/i);
  });

  it("shows a distinct takeover hint and no restart promise", () => {
    const html = renderTaskPeoplePanel(TASK_ID, view({ orphaned: true, canTakeOwnership: true }));
    expect(html).toContain('data-people-take-ownership-form');
    expect(html).toContain('data-people-revision="7"');
    expect(html).toContain("Take ownership");
    expect(html).toMatch(/Take ownership[^<]*does not restart work|Taking ownership[^<]*does not restart work/i);
    expect(html).toContain('disabled');
    expect(html).not.toContain('data-people-role-form');
    expect(html).not.toContain("Add people in Slack");
    expect(html).not.toMatch(/\b(?:action|method|onclick)=/i);
  });

  it("omits absent, placeholder, malformed, non-Slack, and noncanonical Slack links", () => {
    const absentView = view({ canManage: true });
    delete absentView.addPeopleUrl;
    const absent = renderTaskPeoplePanel(TASK_ID, absentView);
    expect(absent).not.toContain("Add people in Slack");
    expect(absent).not.toContain('class="task-people-add"');
    for (const addPeopleUrl of [
      "",
      `/v1/tasks/${TASK_ID}/people/add`,
      "ftp://example.invalid/people",
      "https://evil.example/archives/C0PEOPLE1/p1791720000123456",
      "https://slack.com.evil.example/archives/C0PEOPLE1/p1791720000123456",
      "https://slack.com/archives/C0PEOPLE1/p1791720000123456?next=https://evil.example",
      "https://slack.com/archives/C0PEOPLE1/pnot-a-timestamp",
    ]) {
      const html = renderTaskPeoplePanel(TASK_ID, view({ canManage: true, addPeopleUrl }));
      expect(html).not.toContain("Add people in Slack");
      expect(html).not.toContain(`href="${addPeopleUrl}`);
    }
  });

  it("renders bounded redacted names as inert escaped text", () => {
    const longName = `<b>${"A".repeat(110)}</b>`;
    const html = renderTaskPeoplePanel(TASK_ID, view({ people: [
      { personId: MEMBER_ID, name: longName, role: "viewer", you: false, effectiveRole: "commenter" },
    ] }));
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("onerror");
    const heading = html.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "";
    const visibleName = heading.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim();
    expect(visibleName).not.toBe("");
    expect(Array.from(visibleName).length).toBe(80);
    expect(html).toContain("Current access: Commenter");
  });

  it("renders a role proposal summary with exact request control and local cancel only", () => {
    const proposal: TaskPeopleConfirmationView = {
      kind: "role",
      taskId: TASK_ID,
      requestId: "44444444-4444-4444-8444-444444444444",
      expiresAt: "2026-10-11T12:10:00.000Z",
      personName: "Morgan Member",
      role: "viewer",
    };
    const html = renderTaskPeopleConfirmation(proposal);
    expect(html).toContain("Morgan Member");
    expect(html).toContain("Viewer");
    expect(html).toContain("2026-10-11T12:10:00.000Z");
    expect(html).toContain(`data-people-confirm="${proposal.requestId}"`);
    expect(html).toContain('href="/review/' + TASK_ID + '/task#task-people"');
    expect(html).toContain("Cancel");
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/<form\b|\b(?:action|method|onclick)=/i);
  });

  it("keeps takeover confirmation free of a named target or role", () => {
    const proposal: TaskPeopleConfirmationView = {
      kind: "takeOwnership",
      taskId: TASK_ID,
      requestId: "44444444-4444-4444-8444-444444444444",
      expiresAt: "2026-10-11T12:10:00.000Z",
    };
    const html = renderTaskPeopleConfirmation(proposal);
    expect(html).toContain("Take ownership of this task");
    expect(html).toContain(`data-people-confirm="${proposal.requestId}"`);
    expect(html).not.toContain("Morgan Member");
    expect(html).not.toMatch(/\b(?:Owner|Commenter|Viewer|Remove access)\b/);
    expect(html).toContain('href="/review/' + TASK_ID + '/task#task-people"');
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/<form\b|\b(?:action|method|onclick)=/i);
  });

  it("renders an unavailable state without an empty list or permission controls", () => {
    const html = renderTaskPeopleUnavailable();
    expect(html).toContain("People unavailable");
    expect(html).toContain("Try again later");
    expect(html).not.toContain("data-people-role-form");
    expect(html).not.toContain("data-people-take-ownership-form");
    expect(html).not.toContain("No people");
  });
});
