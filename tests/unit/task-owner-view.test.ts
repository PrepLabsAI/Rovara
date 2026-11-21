import { describe, expect, it } from "vitest";
import { TaskPeopleViewSchema } from "@agentx/contracts";
import { TASK_OWNER_UNNAMED, taskOwnerView } from "../../packages/broker/src/developer/task-owner-view.js";

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
