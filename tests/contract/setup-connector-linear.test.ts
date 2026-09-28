// FR-036 to FR-039: agentx connector add linear. The key's own team list is the test read
// (FR-038); the engineer picks the team from it; the project gets a new revision, only once the
// control plane confirms the connector is connected (F17).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLinear, LINEAR_GUIDE } from "../../packages/cli/src/setup/connectors/linear.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { memoryInitSecrets, scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeVendors } from "../support/setup-fakes.js";

const KEY = `lin_api_${"k".repeat(150)}`; // longer than 128: must be stored whole
const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
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

function input(overrides: { script?: Array<string | boolean>; plane?: ReturnType<typeof fakeControlPlane>; vendors?: ReturnType<typeof fakeVendors>; lines?: string[]; secrets?: ReturnType<typeof memoryInitSecrets>; flags?: { linearTeam?: string } } = {}) {
  const plane = overrides.plane ?? fakeControlPlane();
  return {
    env: "staging", session, projectName: "payments-api", secrets: overrides.secrets ?? memoryInitSecrets(),
    prompter: scriptedPrompter(overrides.script ?? [KEY, "c408e946-78aa-4db8-923e-f78053dd954f"]),
    processEnv: {}, write: (line: string) => { overrides.lines?.push(line); },
    services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION, vendors: overrides.vendors ?? fakeVendors() },
    flags: overrides.flags ?? {},
  };
}

/** Rewrites the control plane's registration response so its preflight names no connector at all
 * (F17: a missing or unparseable preflight report must not be read as success). */
function withNoPreflight(plane: ReturnType<typeof fakeControlPlane>): ReturnType<typeof fakeControlPlane> {
  const real = plane.fetch;
  plane.fetch = async (url, init) => {
    const response = await real(url, init);
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (parsed.pathname !== "/v1/admin/projects" || (init?.method ?? "GET") !== "POST") return response;
    const body = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, preflight: { connectors: [] } }), { status: response.status, headers: { "content-type": "application/json" } });
  };
  return plane;
}

describe("agentx connector add linear (FR-036 to FR-039)", () => {
  it("prints the guide, lists the key's teams as its test read, then stores, registers and scopes it", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors({ linearTeams: [{ id: "c408e946-78aa-4db8-923e-f78053dd954f", key: "PAY", name: "Payments" }, { id: "d0000000-0000-4000-8000-000000000001", key: "OPS", name: "Ops" }] });
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    expect(await addLinear(input({ plane, vendors, secrets, lines }))).toEqual({ ref: "linear", revision: 2 });
    expect(lines[0]).toBe(LINEAR_GUIDE);
    expect(lines.join("\n")).toContain("The key can see 2 teams: PAY (Payments), OPS (Ops).");
    expect(vendors.calls).toEqual(["linearTeams"]);
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/linear")!)).toEqual({ apiKey: KEY });
    expect(plane.credentials).toContainEqual({ ref: "linear", type: "static-secret", secretName: "agentx/staging/connectors/linear" });
    const registered = plane.registered.at(-1) as { definition: { revision: number; integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.revision).toBe(2);
    expect(registered.definition.integrations.connectors[0]).toMatchObject({ name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }] });
    const file = await readFile(join(configDir, "payments-api.yaml"), "utf8");
    expect(file).toContain("revision: 2");
    expect(file).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("stores nothing when Linear refuses the key", async () => {
    const secrets = memoryInitSecrets();
    const vendors = fakeVendors({ linearRefuses: true });
    await expect(addLinear(input({ vendors, secrets }))).rejects.toThrow("Linear refused the API key; check you copied all of it and that it is not revoked (Settings, Account, Security & Access). Nothing was stored");
    expect(secrets.values.size).toBe(0);
  });

  it("refuses a team the key cannot see", async () => {
    // F3: the unknown team goes through flags.linearTeam. Scripting it into choose would throw
    // "has no choice not-a-team" first, so the real refusal message would never be reached.
    await expect(addLinear(input({ script: [KEY], flags: { linearTeam: "not-a-team" } }))).rejects.toThrow("the key cannot see team not-a-team");
  });

  it("fails the step when the preflight does not report the connector connected, keeping the revision", async () => {
    const plane = fakeControlPlane();
    plane.preflight.linear = { status: "not_connected", problem: "Linear rejected the credential twice" };
    await expect(addLinear(input({ plane }))).rejects.toThrow("revision 2 of payments-api is registered, but the linear connector is not_connected: Linear rejected the credential twice. Fix it, then run agentx connector add linear --project payments-api again");
  });

  it("fails the step when the control plane's preflight names no connector, keeping the revision confirmed as unregistered (F17)", async () => {
    const plane = withNoPreflight(fakeControlPlane());
    await expect(addLinear(input({ plane }))).rejects.toThrow(/could not be confirmed/);
  });

  it("replaces an earlier linear connector instead of adding a second one", async () => {
    const plane = fakeControlPlane();
    await addLinear(input({ plane }));
    await addLinear(input({ plane }));
    const last = plane.registered.at(-1) as { definition: { revision: number; integrations: { connectors: unknown[] } } };
    expect(last.definition.revision).toBe(3);
    expect(last.definition.integrations.connectors).toHaveLength(1);
  });
});
