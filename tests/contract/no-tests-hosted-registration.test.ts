// DEC 254zzz495 (N3): the hosted `POST /v1/admin/projects` never takes the no-automated-tests fact from its body. The fact is not a definition field, so the strict definition refuses it and nothing is stored; the same
// request without it registers as usual and stores none.
import { describe, expect, it } from "vitest";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const runtimeBinding = {
  deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
};
const definition = (extra: Record<string, unknown> = {}) => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work (revision 1).",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], ...extra,
});

describe("hosted project registration and the no-automated-tests fact", () => {
  it("refuses a definition that names the fact and stores no revision", async () => {
    const { handler, db } = await createAdminBroker({});
    const fact = { at: "2026-11-24T00:00:00.000Z", looked: ["makefile"] };
    const refused = await adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: definition({ noAutomatedTests: fact }), runtimeBinding } });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });
  it("registers a request that carries the fact beside the definition, and stores none on the row or in the definition", async () => {
    const { handler, db } = await createAdminBroker({});
    const fact = { at: "2026-11-24T00:00:00.000Z", looked: ["makefile"] };
    const registered = await adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: definition(), runtimeBinding, noAutomatedTests: fact } });
    expect(registered.status).toBe(201);
    const row = db.get("PROJECT#payments", "REV#000000000001") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("noAutomatedTests");
    expect(row["definition"]).not.toHaveProperty("noAutomatedTests");
    expect(JSON.stringify(row)).not.toContain("makefile");
  });
});
