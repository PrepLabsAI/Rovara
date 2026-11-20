// Web task channel (Q7): the task view names the task's own person ({ developerId, name }) so Cloud never guesses the owner from People, and each person of the People view says how they sign in
// (`method`, a label for the client). Both come from stored rows only; neither echoes an issuer, a subject or an address.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema, TaskPeopleViewSchema } from "@agentx/contracts";
import { TASK_OWNER_UNNAMED, taskOwnerView } from "../../packages/broker/src/developer/task-owner-view.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const HEX = "a".repeat(64);

describe("taskOwnerView", () => {

  it("cleans and caps the name like a People name: no address, at most 80 characters, a fixed word when nothing readable is left", () => {
    expect(taskOwnerView({ developerId: HEX, developerName: "x".repeat(300) })!.name.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(taskOwnerView({ developerId: HEX, developerName: "maya@example.com" }))).not.toContain("@");
    // An address the cap would cut in half is hidden whole before the cap, never left as a half address.
    expect(JSON.stringify(taskOwnerView({ developerId: HEX, developerName: `${"x".repeat(72)} maya@example.com` }))).not.toContain("@");
    expect(taskOwnerView({ developerId: HEX, developerName: "   " })).toStrictEqual({ developerId: HEX, name: TASK_OWNER_UNNAMED });
    expect(taskOwnerView({ developerId: HEX, developerName: 7 })).toStrictEqual({ developerId: HEX, name: TASK_OWNER_UNNAMED });
  });


});

describe("the broker's own task view (legacy tasks)", () => {
  it("names the task's own person on the read, and the contract takes the whole view", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const task = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { owner?: unknown };
    expect(task.owner).toStrictEqual({ developerId: MAYA.developerId, name: MAYA.name });
    expect(DeveloperTaskViewSchema.shape.owner.safeParse(task.owner).success).toBe(true);
  });
});

describe("the People view's sign-in method", () => {
  const person = { personId: "11111111-1111-4111-8111-111111111111", name: "Maya", role: "owner", you: true, effectiveRole: "owner" };
  const view = (people: unknown[]) => ({ revision: 1, orphaned: false, people, canManage: true, canTakeOwnership: false });

  it("takes a built-in method, and a view without one (an older server)", () => {
    for (const method of ["slack", "github", "oidc", "cloud", "saml"]) expect(TaskPeopleViewSchema.safeParse(view([{ ...person, method }])).success, method).toBe(true);
    expect(TaskPeopleViewSchema.safeParse(view([person])).success).toBe(true);
  });

  it("refuses a method that is not a built-in one, and any other new key (no issuer, subject or address)", () => {
    expect(TaskPeopleViewSchema.safeParse(view([{ ...person, method: "mystery" }])).success).toBe(false);
    expect(TaskPeopleViewSchema.safeParse(view([{ ...person, method: "github", issuer: "https://github.com" }])).success).toBe(false);
    expect(TaskPeopleViewSchema.safeParse(view([{ ...person, method: "github", subject: "gh-1" }])).success).toBe(false);
  });
});
