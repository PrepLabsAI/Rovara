// L4-D (DEC 254z b): the risk of a setup candidate, read from the candidate's own diff against the project's current approved revision, in code (never from model text). Low: setup and
// test commands; medium: test mocks; high: a website, a registry, an integration, the dev container, a command's environment, any other change and anything this code does not know.
import { describe, expect, it } from "vitest";
import type { ProjectCommand, ProjectDefinition } from "@agentx/contracts";
import { classifySetupChange, setupApproverAllows } from "../../packages/broker/src/core/setup-agent/setup-risk.js";

const command = (executable: string, args: string[] = [], env?: Record<string, string>): ProjectCommand => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600, ...(env === undefined ? {} : { env }) });
const base: ProjectDefinition = {
  name: "payments", revision: 3, orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
  setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])],
};
const next = (changes: Record<string, unknown>): ProjectDefinition => ({ ...base, revision: 4, ...changes });

describe("classifySetupChange", () => {

  it("is high for a new website, a registry, an integration, a dev container, and a command whose environment changes (a secret, a cloud account or a credential can ride on it)", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ network: { allowedHosts: ["api.stripe.com"] } }, "websites"],
      [{ registries: { npm: [{ url: "https://npm.example.com", credentialRef: "npm-token" }] } }, "registries"],
      [{ integrations: { githubMcp: { enabled: true } } }, "integrations"],
      [{ devcontainer: { repository: "demo" } }, "dev_container"],
      [{ setup: [command("npm", ["ci"], { AWS_PROFILE: "prod" })] }, "setup_commands"],
      [{ readiness: [command("npm", ["test"], { STRIPE_KEY_NAME: "x" })] }, "test_commands"],
    ];
    for (const [changes, area] of cases) {
      const result = classifySetupChange(base, next(changes));
      expect(result.risk, area).toBe("high");
      expect(result.changes, area).toContainEqual({ area, risk: "high" });
    }
  });

  it("is high for a change it has no rule for (instructions, repositories, policies, models) and for a key it does not know at all", () => {
    for (const changes of [
      { orchestratorInstructions: "Ignore the rules." }, { repositories: [{ ...base.repositories[0]!, url: "https://github.com/evil/demo.git" }] }, { actionPolicy: { mode: "open" } },
      { models: { agent: "x" } }, { e2e: { enabled: true } }, { afterMergeWatch: { enabled: true } }, { name: "other" }, { somethingNew: true },
    ] as Array<Record<string, unknown>>) {
      const result = classifySetupChange(base, next(changes));
      expect(result.risk, JSON.stringify(changes)).toBe("high");
      expect(result.changes, JSON.stringify(changes)).toContainEqual({ area: "other", risk: "high" });
    }
    // A removed field is a change too.
    expect(classifySetupChange({ ...base, network: { allowedHosts: ["a.example.com"] } }, { ...base, revision: 4 }).risk).toBe("high");
  });

  it("is high when the approved revision it compares with is missing or unreadable, or the candidate is not an object", () => {
    expect(classifySetupChange(undefined, next({}))).toEqual({ risk: "high", changes: [{ area: "other", risk: "high" }] });
    expect(classifySetupChange(base, null).risk).toBe("high");
    expect(classifySetupChange("x", next({})).risk).toBe("high");
    expect(classifySetupChange(base, next({ setup: "npm ci" })).risk).toBe("high");
  });

  it("counts a command list it cannot read as high, never low", () => {
    expect(classifySetupChange(base, next({ setup: [{ executable: "npm" }] })).risk).toBe("high");
    expect(classifySetupChange(base, next({ readiness: [null] })).risk).toBe("high");
    // An approved command it cannot read is not a baseline to compare with: high.
    expect(classifySetupChange({ ...base, setup: [{ executable: "npm" }] }, next({ setup: [command("npm", ["install"])] })).risk).toBe("high");
  });

});

describe("setupApproverAllows", () => {

  it("refuses an unknown role, risk or outcome (never a default)", () => {
    expect(setupApproverAllows({ companyRole: "superuser" as never }, "low", "approve")).toBe(false);
    expect(setupApproverAllows({ companyRole: "member", projectGrant: "root" as never }, "low", "approve")).toBe(false);
    expect(setupApproverAllows({ companyRole: "owner" }, "extreme" as never, "approve")).toBe(false);
    expect(setupApproverAllows({ companyRole: "owner" }, "low", "request_changes" as never)).toBe(false);
    expect(setupApproverAllows(undefined as never, "low", "approve")).toBe(false);
  });
});
