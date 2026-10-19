import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { createAPIApplicationCliHost, executeE2EAPIApplicationScenario, type E2EApiRuntimePorts } from "../../packages/verifier/src/api-runtime.js";
import { createWebApplicationCliHost, executeWebSteps, type E2EWebRuntimePorts } from "../../packages/verifier/src/web-runtime.js";

// The registered capability lists are what planning will promise, so they are held against what the two runtimes accept and refuse.
const stepKinds = ["navigate", "fill", "click", "agent", "request", "invoke-contract", "inspect-contract", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"] as const;
const sha = "c".repeat(64);
const web = webApiRuntimeCapabilities("web", sha);
const api = webApiRuntimeCapabilities("api", sha);

const stepFor = (kind: string) => ({ kind, path: "/", testId: "t", value: "v", requestId: "r", method: "GET", body: {}, operationId: "o", input: {}, fixtureFileId: "f",
  direction: "up", url: "x", permission: "p", prompt: "p" });
const webPorts = { actionWindows: { begin: async () => ({ actionId: "w" }), finish: async () => ({ confirmed: true as const }) },
  evidence: { recordCaseEvidence: async ({ bytes, mediaType }: { bytes: Uint8Array; mediaType: string }) => ({ artifactId: "a", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType }) } } as unknown as E2EWebRuntimePorts;
const fixtures = { app: { open: async () => {} }, screen: { getByTestId: () => ({ click: async () => {}, fill: async () => {}, tap: async () => {} }) },
  browser: { goto: async () => {}, reload: async () => {}, waitForDownload: async () => { throw new Error("no download here"); } } } as never;

describe("registered web capabilities against the web runtime", () => {
  it.each(web.supportedSteps.filter((kind) => kind !== "choose-file"))("accepts the listed step %s", async (kind) => {
    const result = await executeWebSteps({ caseId: "case", scenario: { steps: [stepFor(kind)], assertions: [] } as never, fixtures, ports: webPorts,
      page: {} as never, signal: new AbortController().signal, origin: "http://127.0.0.1:43123" });
    expect(result.steps.map((step) => step.kind)).toEqual([kind]);
  });

  it.each(stepKinds.filter((kind) => !(web.supportedSteps as readonly string[]).includes(kind) && ["request", "invoke-contract", "inspect-contract", "deep-link", "set-permission"].includes(kind)))(
    "refuses the unlisted step %s", async (kind) => {
      await expect(executeWebSteps({ caseId: "case", scenario: { steps: [stepFor(kind)], assertions: [] } as never, fixtures, ports: webPorts,
        page: {} as never, signal: new AbortController().signal, origin: "http://127.0.0.1:43123" })).rejects.toThrow(/no installed fixed web driver/);
    });

  it("lists choose-file, which the runtime hands to its file-chooser path rather than refusing", () => {
    expect(web.supportedSteps).toContain("choose-file");
  });
});

const apiPorts = { actionWindows: { begin: async () => ({ actionId: "a" }), finish: async () => ({ confirmed: true as const }) } } as unknown as E2EApiRuntimePorts;
const binding = { assertionProducers: [{ assertionIndex: 0, producer: { lifecycleId: "life" } }], subject: "subject", sessionRef: "s", accountIdDigest: sha };
const apiRun = (scenario: unknown, plan: unknown = { expected: { assertionDigests: [] } }, observed: unknown = {}) => executeE2EAPIApplicationScenario({ caseId: "case", scenario: scenario as never,
  sessionRef: "s", origin: "http://127.0.0.1:43124", ports: apiPorts, plan: plan as never, binding: observed as never, signal: new AbortController().signal });

describe("registered API capabilities against the API runtime", () => {
  it("lists only the request step, and refuses every other step kind", async () => {
    expect(api.supportedSteps).toEqual(["request"]);
    for (const kind of stepKinds.filter((item) => item !== "request")) {
      await expect(apiRun({ steps: [stepFor(kind)], assertions: [] })).rejects.toThrow(/API target cannot execute .* steps/);
    }
  });

  it("does not refuse the listed http-status and json assertions as unsupported", async () => {
    for (const kind of ["http-status", "json"] as const) {
      expect(api.supportedAssertions).toContain(kind);
      const result = await apiRun({ steps: [], assertions: [{ kind, path: "/p", method: "GET", responseId: "r", schemaRef: "s", equals: 200 }] },
        { expected: { caseId: "case", assertionDigests: ["d".repeat(64)], accountContextId: "ctx", accountContextDigest: sha } }, binding);
      expect(result.assertions[0]!.reason, kind).not.toMatch(/unsupported/);
    }
  });

  it("refuses the assertion kinds it does not list as unsupported, and no listed kind as unsupported", async () => {
    const unlisted = ["text", "visible", "csv", "file"] as const;
    for (const kind of unlisted) expect(api.supportedAssertions).not.toContain(kind);
    for (const kind of unlisted) {
      const result = await apiRun({ steps: [], assertions: [{ kind, testId: "t", equals: "x", downloadName: "a.csv", columns: [], rows: [] }] },
        { expected: { caseId: "case", assertionDigests: ["d".repeat(64)], accountContextId: "ctx", accountContextDigest: sha } }, binding);
      expect(result.assertions.map((item) => [item.outcome, item.reason]), kind).toEqual([["unavailable", `unsupported-api-${kind}`]]);
    }
  });
});

describe("registered engines against the engines the runtimes present", () => {
  const sha64 = "b".repeat(64);
  const context = (target: Record<string, unknown>, profileId: string) => ({ schemaVersion: "e2e-application-cli-launch/v1", launchId: "00000000-0000-4000-8000-000000000001", shardId: "s",
    compiledInventoryDigest: sha64, groupCompiledInventoryDigest: sha64, bindingDigest: sha64, roundId: "00000000-0000-4000-8000-000000000002",
    runId: "00000000-0000-4000-8000-000000000003", cliHost: { profileId, descriptor: { entryPointId: "e", entryPointManifestDigest: sha64 } },
    selectedTarget: target, transportId: "t", transportCorrelationId: "00000000-0000-4000-8000-000000000004", deadlineAt: "2099-01-01T00:00:00.000Z" });
  const engineOf = (host: { engine?: unknown }) => host.engine as { name: string; version: string; spiVersion: number };

  it("registers the engine identity the web runtime actually constructs", () => {
    const host = createWebApplicationCliHost({ launchContext: context({ kind: "web", targetId: "web-target", applicationId: "app", runtimeProfileId: "p", accountProfileId: "o",
      browser: "chromium", viewport: { width: 1280, height: 720 } }, "p") as never, ports: { ...webPorts, resolveOwnedCdpEndpoint: async () => "wss://unused.invalid" },
    declaration: { preparedEnvironmentDigest: sha64, target: { targetId: "web-target", app: { identity: "app" } }, originByApplicationId: [{ applicationId: "app", origin: "http://127.0.0.1:43123" }], cases: [] } });
    expect(engineOf(host)).toMatchObject({ name: web.engine.name, version: web.engine.version, spiVersion: web.engine.spiVersion });
    expect("browsers" in web ? web.browsers : null).toEqual(["chromium"]);
  });

  it("registers the engine identity the API runtime actually constructs", () => {
    const host = createAPIApplicationCliHost({ launchContext: context({ kind: "api", targetId: "api-target", applicationId: "app", runtimeProfileId: "p", accountProfileId: "o",
      protocol: "http", originRef: "orders" }, "p") as never, ports: apiPorts,
    declaration: { preparedEnvironmentDigest: sha64, target: { targetId: "api-target", app: null }, originByApplicationId: [{ applicationId: "app", origin: "http://127.0.0.1:43124" }], cases: [] } });
    expect(engineOf(host)).toMatchObject({ name: api.engine.name, version: api.engine.version, spiVersion: api.engine.spiVersion });
    expect("protocols" in api ? api.protocols : null).toEqual(["http"]);
  });
});
