import { describe, expect, it, vi } from "vitest";
import type { TaskPeopleView } from "@agentx/contracts";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/tools.js";

const view: TaskPeopleView = {
  revision: 3, orphaned: false,
  people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Bailey", role: "commenter", effectiveRole: "commenter", you: false }],
  canManage: true, canTakeOwnership: false, addPeopleUrl: "/tasks/t/people/add",
};

describe("task People MCP tools", () => {
  it("publishes read, proposed role change, and proposed self-takeover without confirmation inputs", async () => {
    const tools = DEVELOPER_TOOLS;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "agentx_get_task_people", "agentx_set_task_person", "agentx_take_task_ownership",
      "agentx_get_task_people_request",
    ]));
    const role = tools.find((tool) => tool.name === "agentx_set_task_person")!;
    expect(Object.keys(role.inputSchema).sort()).toEqual(["expected_people_revision", "person_id", "request_id", "role", "task_id"]);
    expect(Object.keys(role.inputSchema)).not.toEqual(expect.arrayContaining(["confirmed", "actor", "authority"]));
    const client = {
      getTaskPeople: vi.fn(async () => view),
      setTaskPerson: vi.fn(async () => ({ status: "PENDING" as const, requestId: "44444444-4444-4444-8444-444444444444", confirmationUrl: "https://agentx.test/confirm", expiresAt: "2026-10-11T10:10:00.000Z" })),
      takeTaskOwnership: vi.fn(async () => ({ status: "COMMITTED" as const, view })),
      getTaskPeopleRequest: vi.fn(async () => ({ status: "COMMITTED" as const, view })),
    };
    const context = { client, newRequestId: () => "44444444-4444-4444-8444-444444444444", now: () => 0 } as never;
    const call = {} as never;
    await role.handler(context, { task_id: "11111111-1111-4111-8111-111111111111", person_id: view.people[0]!.personId, role: "owner", expected_people_revision: 3 }, call);
    expect(client.setTaskPerson).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", expect.objectContaining({ personId: view.people[0]!.personId, role: "owner", expectedPeopleRevision: 3 }));
    const poll = tools.find((tool) => tool.name === "agentx_get_task_people_request")!;
    await poll.handler(context, { task_id: "11111111-1111-4111-8111-111111111111", request_id: "44444444-4444-4444-8444-444444444444" }, call);
    expect(client.getTaskPeopleRequest).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444");
  });
});
