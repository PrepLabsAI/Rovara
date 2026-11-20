// Spec 025 A2, A3: GET /v1/admin/projects lists every project an admin can find without a scan.
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { registerRevision } from "../support/developer-task-broker.js";
import { projectKey } from "../../packages/broker/src/aws/project-records.js";

describe("GET /v1/admin/projects (FR-038, FR-030)", () => {

  it("writes the catalog row with the registration, and keeps its first registration time", async () => {
    const { db, handler } = await createAdminReadBroker();
    const first = db.get("PROJECT_CATALOG", "PROJECT#payments") as { firstRegisteredAt: string; latestRevision: number };
    expect(first).toMatchObject({ entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1 });
    await registerRevision(handler, 2, {});
    expect(db.get("PROJECT_CATALOG", "PROJECT#payments")).toMatchObject({ firstRegisteredAt: first.firstRegisteredAt, latestRevision: 2 });
    db.delete(projectKey("payments", 1).pk, projectKey("payments", 1).sk);
    await registerRevision(handler, 1, {});
    expect(db.get(projectKey("payments", 1).pk, projectKey("payments", 1).sk)).toBeDefined();
    expect(db.get("PROJECT_CATALOG", "PROJECT#payments")).toMatchObject({ firstRegisteredAt: first.firstRegisteredAt, latestRevision: 2 });
  });

  it("leaves out a catalog name whose project has no revision, and never scans", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#ghost", entityType: "PROJECT_CATALOG", name: "ghost", firstRegisteredAt: "2026-09-01T00:00:00.000Z" });
    const answer = await admin("GET", "/v1/admin/projects");
    expect((answer.body.projects as Array<{ name: string }>).map((project) => project.name)).toEqual(["payments"]);
    expect(db.commandNames()).not.toContain("ScanCommand");
  });

});
