// Spec 025 A2, A3: GET /v1/admin/projects lists every project an admin can find without a scan.
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { registerRevision } from "../support/developer-task-broker.js";

describe("GET /v1/admin/projects (FR-038, FR-030)", () => {
  it("lists a project with its latest revision, repositories, mode, connectors and task policy", async () => {
    const { admin, handler } = await createAdminReadBroker();
    await registerRevision(handler, 2, { share: "required" });
    const answer = await admin("GET", "/v1/admin/projects");
    expect(answer.status).toBe(200);
    expect(answer.body.projects).toEqual([{
      name: "payments", latestRevision: 2, registeredAt: expect.any(String) as unknown,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }],
      runtimeMode: "ec2-ebs", connectors: [],
      developerTasks: { enabled: true, share: "required", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true },
    }]);
  });

  it("writes the catalog row with the registration, and keeps its first registration time", async () => {
    const { db, handler } = await createAdminReadBroker();
    const first = db.get("PROJECT_CATALOG", "PROJECT#payments") as { firstRegisteredAt: string };
    expect(first).toMatchObject({ entityType: "PROJECT_CATALOG", name: "payments" });
    await registerRevision(handler, 2, {});
    expect(db.get("PROJECT_CATALOG", "PROJECT#payments")).toMatchObject({ firstRegisteredAt: first.firstRegisteredAt });
  });

  it("still finds a project registered before the catalog, through its binding or the admin's membership (A3)", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.delete("PROJECT_CATALOG", "PROJECT#payments");
    expect((await admin("GET", "/v1/admin/projects")).body.projects).toEqual([expect.objectContaining({ name: "payments" })]);
    // The binding alone: an admin with no membership row still finds it through the team's binding.
    expect((await admin("GET", "/v1/admin/projects", { subject: "another-admin" })).body.projects).toEqual([expect.objectContaining({ name: "payments" })]);
    // Unbound as well: only the registering admin's membership row names it now.
    for (const binding of db.find((item) => item.entityType === "SLACK_BINDING")) db.delete(String(binding.pk), String(binding.sk));
    expect((await admin("GET", "/v1/admin/projects")).body.projects).toEqual([expect.objectContaining({ name: "payments" })]);
    expect((await admin("GET", "/v1/admin/projects", { subject: "another-admin" })).body.projects).toEqual([]);
  });

  it("leaves out a catalog name whose project has no revision, and never scans", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#ghost", entityType: "PROJECT_CATALOG", name: "ghost", firstRegisteredAt: "2026-09-01T00:00:00.000Z" });
    const answer = await admin("GET", "/v1/admin/projects");
    expect((answer.body.projects as Array<{ name: string }>).map((project) => project.name)).toEqual(["payments"]);
    expect(db.commandNames()).not.toContain("ScanCommand");
  });

  it("refuses a caller without the admin claim, with FORBIDDEN (A2)", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/projects", { admin: false })).body.error).toEqual({ code: "FORBIDDEN", message: "administrator claim is required" });
  });

  it("keeps POST /v1/admin/projects as registration", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("POST", "/v1/admin/projects")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
