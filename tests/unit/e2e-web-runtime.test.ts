import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { evaluateE2EApplicationRawAssertion } from "../../packages/verifier/src/application-services.js";
import { createWebApplicationCliHost, executeWebSteps, type E2EWebRuntimePorts } from "../../packages/verifier/src/web-runtime.js";
import { readE2EApplicationInstalledFileFixture } from "../../packages/verifier/src/application-runtime-assets.js";
import type { E2EApplicationCliLaunchContext } from "../../packages/verifier/src/application-runtime-bootstrap.js";

const sha = "a".repeat(64);
const launch = (browser: "chromium" | "firefox" = "chromium"): E2EApplicationCliLaunchContext => ({
  schemaVersion: "e2e-application-cli-launch/v1", launchId: "00000000-0000-4000-8000-000000000001", shardId: "web-shard",
  compiledInventoryDigest: sha, groupCompiledInventoryDigest: sha, bindingDigest: sha, roundId: "00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000003", cliHost: { profileId: "web-profile", descriptor: { entryPointId: "web", entryPointManifestDigest: sha } },
  selectedTarget: { kind: "web", targetId: "web-target", applicationId: "orders-app", runtimeProfileId: "web-profile", accountProfileId: "owner", browser,
    viewport: { width: 1280, height: 720 } }, transportId: "transport", transportCorrelationId: "00000000-0000-4000-8000-000000000004",
  deadlineAt: "2099-01-01T00:00:00.000Z",
});
const ports = (): E2EWebRuntimePorts => ({
  casePlans: { readCasePlan: async () => { throw new Error("not called by a construction-only test"); } },
  caseObservations: { readCaseObservationBinding: async () => { throw new Error("not called by a construction-only test"); } },
  evidence: { recordCaseEvidence: async () => { throw new Error("not called by a construction-only test"); } },
  actionWindows: { begin: async () => ({ actionId: "action-window" }), finish: async () => ({ confirmed: true as const }) },
  resolveOwnedCdpEndpoint: async () => { throw new Error("construction must remain effect-free"); },
  readOwnedDownload: async () => new Uint8Array(), readApprovedFileFixture: async () => { throw new Error("not called by a construction-only test"); },
  openCaseSession: async () => ({ sessionRef: "session", accountIdDigest: sha }),
  applyToOwnedBrowserContext: async () => {}, closeCaseSession: async () => ({ confirmed: true }), originFor: () => "http://127.0.0.1:43123",
});
const declaration = { preparedEnvironmentDigest: sha, target: { targetId: "web-target", app: { identity: "orders-app" } },
  originByApplicationId: [{ applicationId: "orders-app", origin: "http://127.0.0.1:43123" }], cases: [] };

describe("web application runtime", () => {
  it("reads only the package-pinned bounded upload fixture and rejects caller-selected IDs", async () => {
    const fixture = await readE2EApplicationInstalledFileFixture("orders-upload-v1");
    expect(fixture).toMatchObject({ fixtureFileId: "orders-upload-v1", name: "agentx-orders-upload-v1.csv", mimeType: "text/csv" });
    expect(fixture.bytes.byteLength).toBe(25);
    expect(fixture.sha256).toBe("09eef384eb7581fd1c257640db7cf7d99697f2c81fdf17afd79105c797fec991");
    await expect(readE2EApplicationInstalledFileFixture("../outside.csv")).rejects.toThrow(/unavailable/);
  });

  it("constructs a lazy Chromium engine from the exact selected viewport without resolving its owned endpoint", () => {
    let called = false;
    const injected = { ...ports(), resolveOwnedCdpEndpoint: async () => { called = true; return "wss://not-used.invalid"; } };
    const host = createWebApplicationCliHost({ launchContext: launch(), declaration, ports: injected });
    expect(host.engine).toBeDefined();
    expect(host.profileId).toBe("web-profile");
    expect(called).toBe(false);
  });

  it("refuses Firefox instead of substituting Chromium", () => {
    expect(() => createWebApplicationCliHost({ launchContext: launch("firefox"), declaration, ports: ports() })).toThrow(/Chromium/);
  });

  it("uses actual downloaded CSV bytes for positive and negative execution outcomes", () => {
    const assertion = { kind: "csv", downloadName: "orders.csv", columns: ["id", "tenant", "total"],
      rows: [["a1", "alpha", "19.00"], ["a2", "alpha", "21.00"]] };
    const good = evaluateE2EApplicationRawAssertion({ assertion, downloadName: "orders.csv",
      bytes: Buffer.from('id,tenant,total\na1,alpha,19.00\na2,alpha,21.00\n') });
    const defect = evaluateE2EApplicationRawAssertion({ assertion, downloadName: "orders.csv",
      bytes: Buffer.from('id,tenant,total\na1,alpha,19.00\na2,alpha,21.00\na3,alpha,5.00\n') });
    expect(good).toMatchObject({ supported: true, passed: true });
    expect(defect).toMatchObject({ supported: true, passed: false });
  });

  it("arms the same page file chooser around its exact preceding click and records selected bytes", async () => {
    const calls: string[] = [];
    const fixture = await readE2EApplicationInstalledFileFixture("orders-upload-v1");
    let selected: { name: string; mimeType: string; bytesBase64: string } | null = null;
    const page: { waitForEvent: (event: string, options: { timeout: number }) => Promise<unknown> } = { waitForEvent: async () => undefined };
    const chooser = {
      page: () => page,
      isMultiple: () => false,
      setFiles: async (value: { name: string; mimeType: string; buffer: Buffer }) => {
        calls.push(`set:${value.name}:${value.mimeType}`);
        selected = { name: value.name, mimeType: value.mimeType, bytesBase64: value.buffer.toString("base64") };
      },
      element: () => ({ evaluate: async (fn: ((element: unknown, maximum: number) => unknown) & { name: string }, maximum: number) => {
        calls.push(`readback:${fn.name}:${maximum}`);
        return selected && { ...selected, byteLength: Buffer.from(selected.bytesBase64, "base64").byteLength };
      } }),
    };
    Object.assign(page, { waitForEvent: async (event: string, options: { timeout: number }) => {
      calls.push(`wait:${event}:${options.timeout}`);
      if (event !== "filechooser") throw new Error("unexpected page event");
      return chooser;
    } });
    const fixtures = { app: { open: async () => {} }, screen: { getByTestId: (id: string) => ({
      click: async () => { calls.push(`click:${id}`); }, tap: async () => { calls.push(`tap:${id}`); }, fill: async () => {},
    }) }, browser: { goto: async () => {}, reload: async () => {}, waitForDownload: async () => { throw new Error("unexpected download"); } } } as never;
    const refs: Array<{ sha256: string; byteLength: number; mediaType: string }> = [];
    const casePorts = { ...ports(), evidence: { recordCaseEvidence: async ({ bytes, mediaType }: { bytes: Uint8Array; mediaType: string }) => {
      const ref = { artifactId: `file-${refs.length}`, sha256: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex")), byteLength: bytes.byteLength, mediaType };
      refs.push(ref); return ref;
    } }, actionWindows: {
      begin: async (action: { actionIndex: number }) => { calls.push(`begin:${action.actionIndex}`); return { actionId: `window-${action.actionIndex}` }; },
      finish: async (action: { actionIndex: number }) => { calls.push(`finish:${action.actionIndex}`); return { confirmed: true as const }; },
    }, readApprovedFileFixture: async (input: { fixtureFileId: string; actionIndex: number; actionWindowId: string }) => {
      calls.push(`fixture:${input.fixtureFileId}:${input.actionIndex}`);
      return { fixture, casePlanDigest: "c".repeat(64), browserContextId: "owned-context-1" };
    },
  } as unknown as E2EWebRuntimePorts;
    const result = await executeWebSteps({ caseId: "case-1", scenario: { steps: [
      { kind: "click", testId: "choose-upload" }, { kind: "choose-file", fixtureFileId: "orders-upload-v1" },
    ], assertions: [] } as never, fixtures, ports: casePorts, page, signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 } as never);
    expect(calls[0]).toBe("begin:0");
    expect(calls[1]).toMatch(/^wait:filechooser:(?:9\d{3}|10000)$/u);
    expect(calls.slice(2)).toEqual(["click:choose-upload", "finish:0", "begin:1", "fixture:orders-upload-v1:1",
      "set:agentx-orders-upload-v1.csv:text/csv", "readback:readSelectedFileFromOwnedChooser:65536", "finish:1"]);
    expect(refs).toHaveLength(3);
    expect(refs[1]?.mediaType).toBe("application/octet-stream");
    expect(result.steps[1]?.evidenceRefs).toHaveLength(2);
    expect(result.steps[1]?.outcome).toBe("completed");
  });

  it("runs earlier approved clicks normally and binds the CSV waiter only to the final click", async () => {
    const calls: string[] = [];
    let actionIndex = 0;
    const fixtures = {
      app: { open: async () => { calls.push("open"); } }, screen: { getByTestId: (id: string) => ({
        click: async () => { calls.push(`click:${id}`); }, tap: async () => { calls.push(`tap:${id}`); }, fill: async () => {},
      }) }, browser: { goto: async () => {}, reload: async () => {}, waitForDownload: async (operation: () => Promise<void>) => {
        calls.push("wait:start"); await operation(); calls.push("wait:end"); return { suggestedFilename: "orders.csv", path: "/protected/download" };
      },
      },
    } as never;
    const evidence = { recordCaseEvidence: async ({ bytes, mediaType }: { bytes: Uint8Array; mediaType: string }) => ({
      artifactId: `artifact-${calls.length}`, sha256: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex")),
      byteLength: bytes.byteLength, mediaType,
    }) };
    const casePorts = { ...ports(), evidence, actionWindows: {
      begin: async (action: { actionIndex: number }) => { calls.push(`begin:${action.actionIndex}`); actionIndex = action.actionIndex; return { actionId: `window-${actionIndex}` }; },
      finish: async (action: { actionIndex: number }) => { calls.push(`finish:${action.actionIndex}`); return { confirmed: true as const }; },
    }, readOwnedDownload: async () => Buffer.from("id\na1\n") } as E2EWebRuntimePorts;
    const result = await executeWebSteps({ caseId: "case-1", scenario: { steps: [
      { kind: "click", testId: "open-orders" }, { kind: "fill", testId: "search", value: "a1" }, { kind: "click", testId: "export" },
    ], assertions: [{ kind: "csv", downloadName: "orders.csv", columns: ["id"], rows: [["a1"]] }] } as never,
      fixtures, ports: casePorts, signal: new AbortController().signal } as never);
    expect(calls).toEqual(["begin:0", "click:open-orders", "finish:0", "begin:1", "finish:1",
      "begin:2", "wait:start", "click:export", "wait:end", "finish:2"]);
    expect(result.download?.suggestedFilename).toBe("orders.csv");
    expect(result.steps.map((step) => step.declaredStepIndex)).toEqual([0, 1, 2]);
  });

  it("requires an installed canonical JSON schema and validates the observed body against it", () => {
    const assertion = { kind: "json", responseId: "orders-state", schemaRef: "orders-state-v1", equals: { version: 1, ids: ["a1", "a2"] } };
    const schema = Buffer.from(canonicalJson({ type: "object", required: ["version", "ids"], additionalProperties: false,
      properties: { version: { type: "integer" }, ids: { type: "array", items: { type: "string" } } } }));
    const good = evaluateE2EApplicationRawAssertion({ assertion, schemaBytes: schema, bytes: Buffer.from('{"version":1,"ids":["a1","a2"]}') });
    const malformed = evaluateE2EApplicationRawAssertion({ assertion, schemaBytes: schema, bytes: Buffer.from('{"version":"1","ids":["a1","a2"]}') });
    expect(good).toMatchObject({ supported: true, passed: true });
    expect(malformed).toMatchObject({ supported: true, passed: false });
  });
});
