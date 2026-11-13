// attaching a native read-only connector (Sentry, Datadog, CloudWatch, Grafana, Vercel, PagerDuty, GitHub Actions) to a project goes
// through the registration preflight, and each of them declares NO item argument (`itemArguments: []`: they never write). The preflight read that as "declare 1 to 16 item argument
// paths" and refused every one of them, so no project could attach one through the app. A read-only native connector that declares none is as it should be; a connector that can
// write and declares none, or a malformed or duplicated declaration, is still refused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { resolveConnectors } from "../../packages/core/src/aws/connector-types.js";
import { sentryConnectorType } from "../../packages/core/src/connectors/native/sentry-connector-type.js";
import { preflightConnectors } from "../../packages/core/src/aws/registration-preflight.js";
import { orgCredentialRegistry } from "../../packages/core/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/core/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakeSentry } from "../support/fake-vendor-apis.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const TOKEN = "sntrys_PREFLIGHTTOKEN0123456789";

beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used"); }); });
afterEach(() => { vi.unstubAllGlobals(); });

async function sentryConnector() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets("staging");
  const deps = { store: db, env: "staging", secrets, now: () => Date.now() };
  await new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined }).put({ orgId: ORG, connection: { connectionId: CON, type: "sentry", label: "Sentry", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: TOKEN }, by: "a".repeat(64) });
  const project = ProjectDefinitionSchema.parse({
    name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "x",
    integrations: { connectors: [{ name: "errors", type: "sentry", credentialRef: CON, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }] }] },
  });
  const [connector] = resolveConnectors(project, { credentialRegistry: orgCredentialRegistry(deps, ORG), nativeFetch: routeFetch(fakeSentry({ token: TOKEN }).handler) }, { sentry: sentryConnectorType });
  return { connector: connector!, project };
}

describe("the registration preflight of a native read-only connector", () => {
  it("accepts a Sentry connector, which declares no item argument, and reports its tools as offered", async () => {
    const { connector, project } = await sentryConnector();
    const outcome = await preflightConnectors([connector], project, "owner-key");
    expect(outcome.refusals).toEqual([]);
    expect(outcome.report.connectors).toEqual([expect.objectContaining({ name: "errors", status: "connected" })]);
    expect(outcome.report.connectors[0]!.offered).toEqual(expect.arrayContaining(["errors__list_issues", "errors__get_issue"]));
  });

  it("still refuses a native connector whose declaration is malformed or duplicated", async () => {
    const { connector, project } = await sentryConnector();
    for (const declared of [["id", "id"], ["bad path!"]]) {
      const real = connector.definition.bind(connector);
      const bent = { ...connector, definition: async () => ({ ...(await real() as object), itemArguments: declared }) } as unknown as typeof connector;
      const outcome = await preflightConnectors([bent], project, "owner-key");
      expect(outcome.refusals.length, JSON.stringify(declared)).toBeGreaterThan(0);
    }
  });

  it("still refuses a connector of a type that can write when it declares none", async () => {
    const { connector, project } = await sentryConnector();
    const real = connector.definition.bind(connector);
    const writer = { ...connector, type: "linear", definition: async () => ({ ...(await real() as object), itemArguments: [] }) } as unknown as typeof connector;
    const outcome = await preflightConnectors([writer], project, "owner-key");
    expect(outcome.refusals).toEqual(["connector errors: declare 1 to 16 item argument paths"]);
  });
});
