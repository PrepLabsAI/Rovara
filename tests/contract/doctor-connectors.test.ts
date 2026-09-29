import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { connectorChecks } from "../../packages/cli/src/doctor/connectors.js";
import { environmentProjectFiles, writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { doctorContext, doctorServices, PROGRESS, SECRETS } from "../support/doctor-fakes.js";
import { memoryInitSecrets } from "../support/init-fakes.js";
import { fakeVendors } from "../support/setup-fakes.js";

const LINEAR_KEY = "lin_api_SECRETlinearKEY0123";
const JIRA_TOKEN = "ATATT3xSECRETjiraTOKEN";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const binding = (launchTemplateId: string) => ({ deploymentMode: "ec2-ebs", launchTemplateId, subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: "20", volumeType: "gp3" }) as never;

/** Project files written by agentx's own writer, so the header these tests parse is the real one. */
async function projectDir(files: Array<{ env: string; definition: Record<string, unknown> }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-doctor-projects-"));
  dirs.push(dir);
  for (const file of files) await writeProjectFile(dir, file.definition as unknown as ProjectDefinition, { env: file.env, binding: binding("lt-0123456789abcdef0") });
  return dir;
}

const payments = (connectors: unknown[], extra: Record<string, unknown> = {}) => ({ name: "payments", revision: 3, integrations: { connectors, ...extra } });
const linear = { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: TEAM }], tools: [] };
const jira = { name: "jira", type: "jira", credentialRef: "jira", scopes: [{ alias: "pay", cloudId: "0f1e2d3c-4b5a-4968-8776-655443322110", projectKey: "PAY" }], tools: [] };
const asana = { name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: "pay", projectGid: "1200000000000001" }], tools: [] };
const connectorSecrets = {
  ...SECRETS,
  "agentx/staging/connectors/linear": JSON.stringify({ apiKey: LINEAR_KEY }),
  "agentx/staging/connectors/jira": JSON.stringify({ apiKey: JIRA_TOKEN }),
  "agentx/staging/connectors/asana": JSON.stringify({ clientId: "c", clientSecret: "SECRETasanaCLIENT", refreshToken: "SECRETrefresh" }),
};

async function run(input: { connectors: unknown[]; extra?: Record<string, unknown>; secrets?: Record<string, string>; vendors?: ReturnType<typeof fakeVendors>; progress?: typeof PROGRESS }) {
  const configDir = await projectDir([{ env: "staging", definition: payments(input.connectors, input.extra) }, { env: "staging-eu", definition: { name: "other", revision: 1, integrations: { connectors: [linear] } } }]);
  const services = doctorServices({ configDir, secrets: memoryInitSecrets(input.secrets ?? connectorSecrets), vendors: input.vendors ?? fakeVendors() });
  return connectorChecks(doctorContext({ services, progress: input.progress ?? PROGRESS }));
}

describe("environmentProjectFiles", () => {
  it("finds only this environment's project files, by the header agentx writes", async () => {
    const dir = await projectDir([{ env: "staging", definition: payments([]) }, { env: "staging-eu", definition: { name: "eu", revision: 1 } }, { env: "prod", definition: { name: "prod-app", revision: 1 } }]);
    const found = await environmentProjectFiles(dir, "staging");
    expect(found.map((file) => [file.name, file.launchTemplateId])).toEqual([["payments", "lt-0123456789abcdef0"]]);
  });

  it("answers an empty list for a directory that does not exist", async () => {
    expect(await environmentProjectFiles("/nonexistent-agentx-projects", "staging")).toEqual([]);
  });
});

describe("doctor: connectors (FR-050, the 15d2 decision on saved warnings)", () => {
  it("passes Linear and Jira with a real read, and Asana with its stored sign-in, never showing a credential", async () => {
    const vendors = fakeVendors({ jiraInside: ["PAY-1"] });
    const checks = await run({ connectors: [linear, jira, asana], vendors });
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([
      ["Linear (project payments)", "ok"], ["Jira (project payments)", "ok"], ["Asana (project payments)", "ok"],
    ]);
    expect(vendors.calls).toContain("linearTeams");
    expect(vendors.calls).toContain("jiraSearch project = PAY max 1");
    expect(vendors.calls).not.toContain("asanaAccessToken");
    expect(JSON.stringify(checks)).not.toMatch(/SECRET/);
  });

  it("fails a connector whose credentials are missing", async () => {
    const secrets: Record<string, string> = { ...connectorSecrets };
    delete secrets["agentx/staging/connectors/linear"];
    expect((await run({ connectors: [linear], secrets }))[0]).toMatchObject({ status: "fail", detail: "credentials missing: no secret agentx/staging/connectors/linear", fix: "agentx --env staging connector add linear --project payments" });
  });

  it("fails an expired or revoked key, and never repeats what the vendor said", async () => {
    const refused = await run({ connectors: [linear], vendors: fakeVendors({ linearRefuses: true }) });
    expect(refused[0]).toMatchObject({ status: "fail", detail: "Linear refused the stored key: it expired or was revoked" });
    const echoing = { ...fakeVendors(), linearTeams: async () => { throw new Error(`bad key ${LINEAR_KEY}`); } };
    const failed = await run({ connectors: [linear], vendors: echoing });
    expect(failed[0]).toMatchObject({ status: "fail", detail: "could not reach Linear to test the key" });
    expect(JSON.stringify(failed)).not.toContain(LINEAR_KEY);
  });

  it("fails when the key no longer sees the connected team", async () => {
    const checks = await run({ connectors: [linear], vendors: fakeVendors({ linearTeams: [{ id: "00000000-0000-4000-8000-000000000000", key: "OPS", name: "Ops" }] }) });
    expect(checks[0]).toMatchObject({ status: "fail", detail: "the key no longer sees team pay" });
  });

  it("warns when Jira finds no issue in the connected project", async () => {
    expect((await run({ connectors: [jira], vendors: fakeVendors({ jiraInside: [] }) }))[0]).toMatchObject({ status: "warn", detail: "the API token works, but finds no issue in PAY" });
  });

  it("fails an Asana credential with no refresh token: the bot never finished signing in", async () => {
    const secrets = { ...connectorSecrets, "agentx/staging/connectors/asana": JSON.stringify({ clientId: "c", clientSecret: "s" }) };
    expect((await run({ connectors: [asana], secrets }))[0]).toMatchObject({ status: "fail", detail: "the Asana bot never finished signing in (no refresh token is stored)" });
  });

  it("warns about the older integrations.githubMcp setting and a warning init saved", async () => {
    const progress = { ...PROGRESS, connectors: [{ type: "jira" as const, ref: "jira", warning: "the Jira service account can also see issues in HR, FIN" }] };
    const checks = await run({ connectors: [], extra: { githubMcp: { tools: [] } }, progress });
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "project payments", status: "warn", detail: "uses the older integrations.githubMcp setting" }),
      expect.objectContaining({ name: "Jira warning", status: "warn", detail: "the Jira service account can also see issues in HR, FIN" }),
    ]));
    // Ruling F25: the fix points at the project configuration contract that exists.
    expect(checks.find((entry) => entry.name === "project payments")?.fix).toContain("specs/013-connector-gateway/contracts/project-config.md");
  });

  it("says so when there are no connectors", async () => {
    expect(await run({ connectors: [] })).toEqual([expect.objectContaining({ name: "connectors", status: "ok", detail: "no connectors are set up" })]);
  });
});
