import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCoreBrowserBroker, JOURNEY_COMPANY, FOREIGN_COMPANY } from "../support/core-browser-journey.js";
import { applicationResultsPresentation, unavailableApplicationView } from "../../packages/broker/src/core-host/e2e-results.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";

async function fixture() {
  const h = await createCoreBrowserBroker({ developerExtra: { companies: {
    companyOf: async (personId: string): Promise<string | undefined> => companyMembershipFromDynamo(h.db, "signin").companyOf(personId),
  } } });
  const response = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Inspect the application", workflow: true, workflowPath: "QUICK" });
  expect(response.status).toBe(200);
  const taskId = String((response.body.task as { taskId: string }).taskId);
  const stranger = { developerId: "b".repeat(64), name: "Ungranted" };
  const sessions = new Map<string, string>();
  for (const [person, company] of [[MAYA, JOURNEY_COMPANY], [OMAR, FOREIGN_COMPANY], [stranger, JOURNEY_COMPANY]] as const) {
    h.db.set({ pk: `COMPANY_MEMBER#${person.developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person.developerId, companyId: company, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
    h.db.set({ pk: `DEVELOPER#${person.developerId}`, sk: "META", entityType: "DEVELOPER", developerId: person.developerId, displayName: person.name, provider: "oidc", revoked: false });
    const sessionId = randomUUID(); sessions.set(person.developerId, sessionId);
    h.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: person.developerId, companyId: company, installMethod: true, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
  }
  const get = (person: { developerId: string }, suffix = "") => h.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task${suffix}`, rawQueryString: "", headers: { host: "api.example.test", cookie: `__Host-agentx_review_session=${sessions.get(person.developerId)}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
  return { ...h, taskId, stranger, get };
}

describe("existing review-page routes for a core task", () => {
  it("answers the owner page, its state and an unknown screenshot as a route that does not exist (DEC 254zzz511: Code's own HTML task page is deleted)", async () => {
    const h = await fixture();
    expect((await h.get(MAYA)).statusCode).toBe(404);
    expect((await h.get(MAYA, "/api/state")).statusCode).toBe(404);
    expect((await h.get(MAYA, `/api/e2e/artifacts/${"f".repeat(64)}`)).statusCode).toBe(404);
  });
  it("returns 404 to an ungranted company member and a foreign member before data or lifecycle writes", async () => {
    const h = await fixture(); const before = JSON.stringify([...h.db.items.values()]);
    for (const person of [h.stranger, OMAR]) for (const suffix of ["", "/api/state", `/api/e2e/artifacts/${"f".repeat(64)}`]) {
      expect((await h.get(person, suffix)).statusCode).toBe(404);
    }
    expect(JSON.stringify([...h.db.items.values()])).toBe(before);
  });
});

it("projects a workflow through its current core result service", async () => {
  const h = await fixture();
  const presentation = applicationResultsPresentation(h.taskId, unavailableApplicationView());
  const read = vi.spyOn(h.runtime.flow.deps.applicationE2E!.results, "read").mockResolvedValue({ presentation });
  try {
    const answer = await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`);
    expect(answer.status).toBe(200);
    expect(answer.body.task).toMatchObject({ e2ePresentation: presentation });
    expect(read).toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

it("reads a non-workflow core task without consulting application results", async () => {
  const h = await fixture();
  const { workflow: _workflow, ...task } = h.db.get(`DEVTASK#${h.taskId}`, "META")!; void _workflow;
  h.db.set(task);
  const read = vi.spyOn(h.runtime.flow.deps.applicationE2E!.results, "read");
  try {
    expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`)).status).toBe(200);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});
