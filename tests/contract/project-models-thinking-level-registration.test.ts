// Spec 053 FR-003 (Ruling 5): saving a project's models refuses an approved thinking level the model
// does not support, listing the supported levels, on both save paths: the registration route and an
// admin change plan. A model the catalog does not know is accepted and checked at first use.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { adminCall, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

const sonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", thinkingLevel: "medium", label: "Sonnet" };
const glm = (thinkingLevel: string) => ({ provider: "openrouter", modelId: "z-ai/glm-5.3", thinkingLevel, label: "GLM 5.3" });

function definition(models: unknown, revision = 1): Record<string, unknown> {
  return {
    name: "payments", revision,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    models,
  };
}

const runtimeBinding = {
  deploymentMode: "ec2-ebs" as const,
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
  volumeSizeGiB: 20,
  volumeType: "gp3" as const,
};

function register(handler: AdminHandler, models: unknown) {
  return adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: definition(models), runtimeBinding } });
}

describe("registering a project's models", () => {
  it("refuses a level the model does not support, names the supported levels, and stores nothing", async () => {
    const { handler, db } = await createAdminBroker({});
    const refused = await register(handler, { default: sonnet, approved: [sonnet, glm("medium")] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({
      code: "CONFIG_INVALID",
      message: 'GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high',
    });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses off on a model that always reasons", async () => {
    const { handler } = await createAdminBroker({});
    const refused = await register(handler, { default: glm("off"), approved: [glm("off")] });
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining('does not support thinking level "off"; supported: low, high') as unknown });
  });

  it("accepts supported levels, unset levels and models the catalog does not know", async () => {
    const { handler, db } = await createAdminBroker({});
    const unknown = { provider: "openrouter", modelId: "example/not-in-catalog", thinkingLevel: "medium" };
    const accepted = await register(handler, { default: sonnet, approved: [sonnet, glm("high"), unknown, { provider: "openrouter", modelId: "moonshotai/kimi-k2.6" }] });
    expect(accepted.status).toBe(201);
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });
});

describe("planning a project revision", () => {
  it("refuses an unsupported level before the change is stored", async () => {
    const broker = await createAdminChangeBroker();
    const refused = await broker.propose({ kind: "register_project_revision", definition: definition({ default: sonnet, approved: [sonnet, glm("medium")] }, 2) });
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining('GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high') as unknown });
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE")).toEqual([]);
  });

  it("plans a revision whose levels are supported", async () => {
    const broker = await createAdminChangeBroker();
    const planned = await broker.propose({ kind: "register_project_revision", definition: definition({ default: sonnet, approved: [sonnet, glm("high")] }, 2) });
    expect(planned.status).toBe(201);
  });
});
