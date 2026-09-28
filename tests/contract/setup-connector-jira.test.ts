// FR-036 to FR-039: agentx connector add jira. The token's own search for an issue inside the
// project is the test read (FR-038); issues found outside the project do not stop it (owner
// decision 6, 2026-09-28): the connector is saved with a warning naming those projects. The
// project gets a new revision, only once the control plane confirms the connector is connected.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addJira, JIRA_GUIDE, jiraSiteUrl, projectKeys, widerAccessWarning } from "../../packages/cli/src/setup/connectors/jira.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { memoryInitSecrets, scriptedPrompter } from "../support/init-fakes.js";
import { fakeControlPlane, fakeVendors } from "../support/setup-fakes.js";

const TOKEN = `ATATT${"t".repeat(187)}`; // about 192 characters, as Atlassian's are
const CLOUD = "0f1e2d3c-4b5a-4968-8776-655443322110";
const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" };
const session = { controlPlaneUrl: "https://cp.example.test", accessToken: "admin-token" };
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
  await writeProjectFile(configDir, {
    name: "payments-api", revision: 1,
    repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
  });
});
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

function input(overrides: {
  script?: Array<string | boolean>;
  plane?: ReturnType<typeof fakeControlPlane>;
  vendors?: ReturnType<typeof fakeVendors>;
  lines?: string[];
  secrets?: ReturnType<typeof memoryInitSecrets>;
} = {}) {
  const plane = overrides.plane ?? fakeControlPlane();
  return {
    env: "staging", session, projectName: "payments-api", secrets: overrides.secrets ?? memoryInitSecrets(),
    prompter: scriptedPrompter(overrides.script ?? []),
    processEnv: {}, write: (line: string) => { overrides.lines?.push(line); },
    services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION, vendors: overrides.vendors ?? fakeVendors() },
    flags: {},
  };
}

describe("the Jira site", () => {
  it("accepts a bare site name, a host or a URL, and returns https://<site>.atlassian.net", () => {
    expect(jiraSiteUrl("acme")).toBe("https://acme.atlassian.net");
    expect(jiraSiteUrl("Acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(jiraSiteUrl("https://acme.atlassian.net/jira/software/projects/PAY/boards/1")).toBe("https://acme.atlassian.net");
    expect(() => jiraSiteUrl("jira.acme.com")).toThrow("Jira Cloud sites are https://<site>.atlassian.net");
  });
});

describe("agentx connector add jira (FR-036 to FR-039)", () => {
  it("proves the token sees the project before storing it, then scopes it with siteUrl", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: [] });
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    // site, token, project key
    expect(await addJira(input({ plane, vendors, secrets, lines, script: ["acme", TOKEN, "PAY"] }))).toEqual({ ref: "jira", revision: 2 });
    expect(lines[0]).toBe(JIRA_GUIDE);
    expect(vendors.calls).toEqual(["jiraCloudId https://acme.atlassian.net", "jiraSearch project = PAY max 5", "jiraSearch project not in (PAY) max 50"]);
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/jira")!)).toEqual({ apiKey: TOKEN });
    const registered = plane.registered.at(-1) as { definition: { integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.integrations.connectors[0]).toMatchObject({
      name: "jira", type: "jira", credentialRef: "jira",
      scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY", siteUrl: "https://acme.atlassian.net" }],
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("saves a service account that can see other projects, with a warning naming them (owner decision 6)", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: ["HR-4", "FIN-2", "HR-9"] });
    const result = await addJira(input({ plane, vendors, secrets, lines, script: ["acme", TOKEN, "PAY"] }));
    const warning = "the Jira service account can also see issues in HR and FIN, so AgentX will be able to read issues in those projects too. Narrow the account to PAY in each other project's permission scheme (docs/connectors/jira.md, Step 4)";
    expect(result).toEqual({ ref: "jira", revision: 2, warning });
    expect(lines).toContain(`Warning: ${warning}`);
    // Saved all the same: the secret, the credential and the revision.
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/jira")!)).toEqual({ apiKey: TOKEN });
    expect(plane.credentials).toContainEqual({ ref: "jira", type: "static-secret", secretName: "agentx/staging/connectors/jira" });
    expect(plane.registered).toHaveLength(1);
    // The outside search reads enough issues to name several projects.
    expect(vendors.calls).toContain("jiraSearch project not in (PAY) max 50");
  });

  it("names the first five other projects and counts the rest", () => {
    expect(widerAccessWarning("PAY", ["HR", "FIN", "OPS", "LEGAL", "SALES", "IT", "QA"])).toBe(
      "the Jira service account can also see issues in HR, FIN, OPS, LEGAL, SALES and 2 more, so AgentX will be able to read issues in those projects too. Narrow the account to PAY in each other project's permission scheme (docs/connectors/jira.md, Step 4)",
    );
    expect(widerAccessWarning("PAY", ["HR"])).toContain("can also see issues in HR, so AgentX");
    expect(widerAccessWarning("PAY", ["A".repeat(10), "B".repeat(10), "C".repeat(10), "D".repeat(10), "E".repeat(10), "F"]).length).toBeLessThanOrEqual(300);
  });

  it("finds project keys from issue keys, once each", () => {
    expect(projectKeys(["HR-4", "FIN-2", "HR-9", "OPS_2-1"])).toEqual(["HR", "FIN", "OPS_2"]);
  });

  it("asks nothing more under --yes when the account sees other projects: the same warning, saved", async () => {
    const lines: string[] = [];
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: ["HR-4"] });
    const env = { TOKEN_ENV: TOKEN };
    const base = input({ vendors, lines, script: [] });
    const result = await addJira({ ...base, processEnv: env, flags: { jiraSite: "acme", jiraProject: "PAY", jiraToken: { envName: "TOKEN_ENV" } } });
    expect(result.warning).toContain("can also see issues in HR");
    expect(lines.some((line) => line.startsWith("Warning: the Jira service account can also see issues in HR"))).toBe(true);
  });

  it("says nothing extra when the account sees only the connected project", async () => {
    const result = await addJira(input({ vendors: fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: [] }), script: ["acme", TOKEN, "PAY"] }));
    expect(result).toEqual({ ref: "jira", revision: 2 });
  });

  it("refuses a project that still uses the older integrations.githubMcp setting, before the token is stored", async () => {
    // Same bug class as Linear's (fixed in 55b0bab): the refusal must happen before anything is
    // read or stored, not only once the control plane rejects the mixed githubMcp/connectors
    // definition. No site lookup, no token prompt, no search, no secret.
    const legacyDir = await mkdtemp(join(tmpdir(), "agentx-projects-legacy-"));
    try {
      await writeProjectFile(legacyDir, {
        name: "payments-api", revision: 1,
        repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
        integrations: { githubMcp: { tools: [{ name: "list_issues", access: "read" }] } },
      });
      const secrets = memoryInitSecrets();
      const vendors = fakeVendors({ jiraCloudId: CLOUD });
      const testInput = input({ secrets, vendors, script: ["acme", TOKEN, "PAY"] });
      await expect(addJira({ ...testInput, services: { ...testInput.services, configDir: legacyDir } })).rejects.toThrow(
        "project payments-api uses the older integrations.githubMcp setting; move it to integrations.connectors (see docs/project-configuration.md) before adding connectors",
      );
      expect(secrets.values.size).toBe(0);
      expect(vendors.calls).toEqual([]);
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("asks for one issue in an empty project, so an empty answer is not mistaken for a blind one", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: [], jiraOutside: [] });
    await expect(addJira(input({ plane, secrets, vendors, script: ["acme", TOKEN, "PAY"] }))).rejects.toThrow("the search found no issue in PAY; if the project is empty, create one issue in it and run this again. If it has issues, the service account cannot see them: add it to the project (Step 4)");
    // One Jira read, not two: the outside search never runs once the inside search comes back empty.
    expect(vendors.calls).toEqual(["jiraCloudId https://acme.atlassian.net", "jiraSearch project = PAY max 5"]);
    expect(secrets.values.size).toBe(0);
    expect(plane.credentials).toHaveLength(1); // only the built-in github credential; none registered
  });

  it("explains a refused token: API token authentication off, a missing scope, or the /v1 endpoint", async () => {
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraRefuses: true });
    await expect(addJira(input({ vendors, script: ["acme", TOKEN, "PAY"] }))).rejects.toThrow("Atlassian refused the API token; check that Rovo MCP's Allow API token authentication is on (Step 1) and the token has all six scopes (Step 5). Nothing was stored");
  });

  it("refuses a project key that is not one", async () => {
    await expect(addJira(input({ vendors: fakeVendors({ jiraCloudId: CLOUD }), script: ["acme", TOKEN, "pay project"] }))).rejects.toThrow("a Jira project key is capital letters and digits, such as PAY");
  });

  it("refuses a one-letter project key before storing the token (F4: the schema's own pattern)", async () => {
    const secrets = memoryInitSecrets();
    const vendors = fakeVendors({ jiraCloudId: CLOUD });
    await expect(addJira(input({ vendors, secrets, script: ["acme", TOKEN, "P"] }))).rejects.toThrow("a Jira project key is capital letters and digits, such as PAY");
    expect(secrets.values.size).toBe(0);
    expect(vendors.calls).toEqual(["jiraCloudId https://acme.atlassian.net"]);
  });
});
