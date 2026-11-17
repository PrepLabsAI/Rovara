// Web task channel (Q7): the task view names the task's own person ({ developerId, name }) so Cloud never guesses the owner from People, and each person of the People view says how they sign in
// (`method`, a label for the client). Both come from stored rows only; neither echoes an issuer, a subject or an address.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema, IMPLICIT_COMPANY_ID, TaskPeopleViewSchema, type OrgId } from "@agentx/contracts";
import { TASK_OWNER_UNNAMED, taskOwnerView } from "../../packages/broker/src/developer/task-owner-view.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const HEX = "a".repeat(64);

describe("taskOwnerView", () => {
  it("is the task's own person, from the stored id and name", () => {
    expect(taskOwnerView({ developerId: HEX, developerName: "Maya Chen" })).toStrictEqual({ developerId: HEX, name: "Maya Chen" });
  });

  it("cleans and caps the name like a People name: no address, at most 80 characters, a fixed word when nothing readable is left", () => {
    expect(taskOwnerView({ developerId: HEX, developerName: "x".repeat(300) })!.name.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(taskOwnerView({ developerId: HEX, developerName: "maya@example.com" }))).not.toContain("@");
    // An address the cap would cut in half is hidden whole before the cap, never left as a half address.
    expect(JSON.stringify(taskOwnerView({ developerId: HEX, developerName: `${"x".repeat(72)} maya@example.com` }))).not.toContain("@");
    expect(taskOwnerView({ developerId: HEX, developerName: "   " })).toStrictEqual({ developerId: HEX, name: TASK_OWNER_UNNAMED });
    expect(taskOwnerView({ developerId: HEX, developerName: 7 })).toStrictEqual({ developerId: HEX, name: TASK_OWNER_UNNAMED });
  });

  it("redacts a secret-shaped word in the name (the token is built at runtime)", () => {
    const token = ["ghp", "a".repeat(36)].join("_");
    const view = taskOwnerView({ developerId: HEX, developerName: `Maya ${token}` });
    expect(JSON.stringify(view)).not.toContain(token);
  });

  it.each([
    ["no id", {}],
    ["an id that is not a string", { developerId: 7 }],
    ["an empty id", { developerId: "" }],
    ["an id with a separator", { developerId: "a#b" }],
    ["a system owner (no person)", { developerId: `sysowner_${HEX}` }],
  ])("shows no owner for %s, never a made-up one", (_label, task) => {
    expect(taskOwnerView({ developerName: "Maya", ...task })).toBeUndefined();
  });

  it("is what the contract accepts, and the contract refuses extra keys and an empty name", () => {
    const shape = DeveloperTaskViewSchema.shape.owner;
    expect(shape.safeParse(taskOwnerView({ developerId: HEX, developerName: "Maya" })).success).toBe(true);
    expect(shape.safeParse({ developerId: HEX, name: "Maya", issuer: "https://id.example" }).success).toBe(false);
    expect(shape.safeParse({ developerId: HEX, name: "" }).success).toBe(false);
    expect(shape.safeParse(undefined).success).toBe(true);
  });
});

describe("the core's task view", () => {
  async function started(companyId: OrgId) {
    const h = createHarness({ companyId });
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a retry" });
    return { h, task };
  }

  it("names the owner from the stored task, on the read and on the start's answer", async () => {
    const { h, task } = await started(COMPANY_A_ID);
    const stored = (await h.store.get(taskKey(task.taskId))) as unknown as TaskRecord;
    const expected = taskOwnerView(stored);
    expect(expected).toBeDefined();
    expect(expected!.developerId).toBe(h.owner.principal.personId);
    expect((await h.flow.get(h.owner, task.taskId)).owner).toStrictEqual(expected);
    expect(task.owner).toStrictEqual(expected);
  });

  it("names each company's own owner for its own task: the same flow in two companies never mixes them", async () => {
    const a = await started(COMPANY_A_ID);
    const b = await started(COMPANY_B_ID);
    const storedB = (await b.h.store.get(taskKey(b.task.taskId))) as unknown as TaskRecord;
    expect((await b.h.flow.get(b.h.owner, b.task.taskId)).owner).toStrictEqual(taskOwnerView(storedB));
    // A task of company A is not readable from company B's flow at all (no owner leak through the read).
    await expect(b.h.flow.get(b.h.owner, a.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("shows no owner when the stored record has no person owner", async () => {
    const { h, task } = await started(IMPLICIT_COMPANY_ID as OrgId);
    const stored = (await h.store.get(taskKey(task.taskId)))!;
    await h.store.put({ item: { ...stored, developerId: `sysowner_${HEX}` } });
    const view = await h.flow.get({ ...h.owner, principal: { ...h.owner.principal, personId: `sysowner_${HEX}` } }, task.taskId).catch(() => undefined);
    // Whether or not the system id may read, the answer never carries a made-up owner.
    expect(view?.owner).toBeUndefined();
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
