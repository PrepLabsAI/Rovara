// #1612: init's company step makes the install's own company (named after the Slack workspace, the admin init made as its first owner) and moves what init made into it;
// doctor checks the company exists and nothing is left in the built-in company.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey } from "@agentx/contracts";
import { INSTALL_COMPANY_KEY } from "../../packages/broker/src/developer/install-company.js";
import { companyChecks } from "../../packages/cli/src/doctor/company.js";
import type { DoctorContext } from "../../packages/cli/src/doctor/checks.js";
import type { InitContext } from "../../packages/cli/src/init/context.js";
import type { ProgressHandle } from "../../packages/cli/src/init/steps.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

vi.mock("../../packages/cli/src/init/finish-steps.js", async (original) => ({ ...await original<object>(), requireSettings: async () => ({ region: "us-east-1", stacks: { "control-plane": "agentx-acme-control-plane" } }) }));
const { companyStep } = await import("../../packages/cli/src/init/company-step.js");

const at = "2026-11-27T12:00:00.000Z";
const outputs = { StateTableName: "state", DeveloperSignInTableName: "signin" };
const definition = { name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
function seeded() {
  const db = new FakeDynamoDb();
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition, registeredAt: at });
  db.set({ ...orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  return db;
}
const doctor = (db: FakeDynamoDb | undefined, stackOutputs: Record<string, string> = outputs) => ({
  env: "acme", settings: { stacks: { "control-plane": "agentx-acme-control-plane" } },
  services: { ...(db === undefined ? {} : { installCompanyClient: db }), now: () => Date.parse(at), stacks: { describe: async () => ({ outputs: stackOutputs, parameters: {}, status: "UPDATE_COMPLETE" }) } },
}) as unknown as DoctorContext;

describe("init's company step", () => {
  it("makes the company after the Slack workspace, with the init admin as owner, and moves the project into it", async () => {
    const db = seeded();
    const lines: string[] = [];
    const context = {
      env: "acme", now: () => Date.parse(at), write: (line: string) => lines.push(line), secrets: { get: async () => undefined },
      setup: { installCompanyClient: () => db, stackOutputs: async () => outputs, github: { listInstallations: async () => [] } },
    } as unknown as InitContext;
    const progress = { current: () => ({ admin: { username: "owner@example.test", mode: "cognito" }, slack: { appId: "A0APP", teamId: "T0TEAM1", botUserId: "U0BOT", teamName: "Acme Corp" } }), update: async () => undefined } as unknown as ProgressHandle;
    const outcome = await companyStep().run(context, progress);
    const setting = db.get(INSTALL_COMPANY_KEY.pk, INSTALL_COMPANY_KEY.sk)!;
    expect(outcome).toEqual({ status: "done", note: `company ${String(setting.companyId)}` });
    expect(setting).toMatchObject({ via: "created", ownerEmailHash: expect.any(String) as unknown });
    expect(db.get(`ORG#${String(setting.companyId)}#COMPANY`, "META")).toMatchObject({ name: "Acme Corp" });
    expect(lines.some((line) => line.includes("moved 1 projects"))).toBe(true);
    expect(await companyChecks(doctor(db))).toEqual([{ group: "sign-in", name: "company", status: "ok", detail: `company ${String(setting.companyId)}; nothing left in the built-in company` }]);
  });

  it("is skipped where the deployment gives no AWS client", async () => {
    const context = { env: "acme", setup: {} } as unknown as InitContext;
    expect(await companyStep().run(context, { current: () => ({}) } as unknown as ProgressHandle)).toEqual({ status: "done", note: "skipped: no AWS client for the company step" });
  });
});

describe("doctor's company check", () => {
  it("fails an install with no company of its own, and warns while the control plane names no sign-in table", async () => {
    expect(await companyChecks(doctor(seeded()))).toMatchObject([{ status: "fail", detail: "this install has no company of its own, so engine commands fail and model costs cannot be charged" }]);
    expect(await companyChecks(doctor(seeded(), { StateTableName: "state" }))).toMatchObject([{ status: "warn" }]);
    expect(await companyChecks(doctor(undefined))).toEqual([]);
  });

  it("fails while records are still in the built-in company", async () => {
    const db = seeded();
    db.set({ ...INSTALL_COMPANY_KEY, entityType: "INSTALL_COMPANY", companyId: "org_" + "c".repeat(20), via: "created", setAt: at });
    db.set({ pk: `ORG#org_${"c".repeat(20)}#COMPANY`, sk: "META", entityType: "COMPANY", companyId: "org_" + "c".repeat(20), name: "Acme", status: "active", createdAt: at, createdBy: "operator" });
    expect(await companyChecks(doctor(db))).toMatchObject([{ status: "fail", detail: `company org_${"c".repeat(20)}; 1 records are still in the built-in company` }]);
  });
});
