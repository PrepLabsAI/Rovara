import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EApplicationReportSchema } from "../../packages/verifier/src/application-report-schema.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const runId = "11111111-1111-7111-8111-111111111111";
const at = "2026-10-17T12:00:00.000Z";

function report(stepOverrides: Record<string, unknown> = {}) {
  const step = { id: "step-1", index: 0, kind: "assertion", api: "assert.visible", label: "home visible",
    source: { file: ".agentx/e2e/generated-application.test.ts", line: 1, column: 1 }, status: "passed", startedAt: at,
    durationMs: 1, events: [], artifacts: [], ...stepOverrides };
  return { schemaVersion: "report-1", run: { id: runId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
    status: "passed", exitCode: 0, startedAt: at, finishedAt: "2026-10-17T12:00:01.000Z", project: { id: "rovara-application-e2e", configDigest: sha("config") },
    environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
    targets: [{ id: "web-target", index: 0, platform: "web", environment: "test", baseOrigin: "https://app.test",
      engine: { name: "playwright", version: "1.0.0", spiVersion: 1 }, capabilities: ["observation"], artifactCapabilities: [], stateCapability: false }],
    serialGroups: [], results: [{ id: sha("result"), testId: ".agentx/e2e/generated-application.test.ts::case-a", kind: "test", declarationIndex: 0,
      titlePath: ["case-a"], file: ".agentx/e2e/generated-application.test.ts", source: { file: ".agentx/e2e/generated-application.test.ts", line: 1, column: 1 },
      targetId: "web-target", platform: "web", agent: "default", repeat: 0, tags: [], selected: true, status: "passed",
      attempts: [{ id: runId, index: 0, status: "passed", startedAt: at, durationMs: 1, artifacts: [], appLog: [], secondaryErrors: [], cleanup: "complete", steps: [step] }] }],
    errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 },
    limits: { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 },
    usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
}

describe("application report parser", () => {
  it("accepts real nonempty 0.20 steps while the portable report contract remains separate", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.E2EApplicationReportSchema.safeParse(report()).success).toBe(true);
    const parsed = module.parseE2EApplicationReport(Buffer.from(JSON.stringify(report())));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.report.run.results[0]?.attempts[0]?.steps).toHaveLength(1);
  });

  it("preserves report-1's explicit engine-none provenance for an engine-less API target", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js");
    const api = E2EApplicationReportSchema.parse(report());
    api.run.targets[0] = { id: "api-target", index: 0, platform: "api", environment: "test",
      engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false };
    api.run.results[0]!.targetId = "api-target";
    api.run.results[0]!.platform = "api";
    expect(module.E2EApplicationReportSchema.safeParse(api).success).toBe(true);
    expect(module.parseE2EApplicationReport(Buffer.from(JSON.stringify(api))).kind).toBe("parsed");
  });

  it("accepts report-1 fractional estimated cost while keeping usage keys closed", () => {
    const fractional = report();
    Object.assign(fractional.run.usage, { estimatedCostUsd: 0.125 });
    expect(E2EApplicationReportSchema.safeParse(fractional).success).toBe(true);
    expect(E2EApplicationReportSchema.safeParse({ ...fractional, run: { ...fractional.run,
      usage: { ...fractional.run.usage, guessedCounter: 3 } } }).success).toBe(false);
  });

  it("rejects contradictory or unknown nested step data instead of stripping it", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.E2EApplicationReportSchema.safeParse(report({ unrecognized: "forged" })).success).toBe(false);
    expect(module.parseE2EApplicationReport(Buffer.from(JSON.stringify(report({ kind: "not-a-step-kind" })))).kind).toBe("unavailable");
  });

  it("keeps pinned report event discriminants closed at nested boundaries", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js");
    const malformed = report();
    Object.assign(malformed.run.results[0]!.attempts[0]!.steps[0]!, { events: [{ kind: "observation", startedAt: at, durationMs: 1, status: "passed", detail: "ok", invented: true }] });
    expect(module.E2EApplicationReportSchema.safeParse(malformed).success).toBe(false);
    const invalidLog = report();
    Object.assign(invalidLog.run.results[0]!.attempts[0]!, { appLog: [{ source: "provider", level: "info", text: "claimed", at }] });
    expect(module.E2EApplicationReportSchema.safeParse(invalidLog).success).toBe(false);
  });

  it("reads exactly the app log levels the pinned runner writes (info, warning, error), 'warning' (an HTTP 4xx the page got) included", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js");
    const parsedWith = (appLog: unknown[]) => {
      const withLog = report();
      Object.assign(withLog.run.results[0]!.attempts[0]!, { appLog });
      return module.parseE2EApplicationReport(Buffer.from(JSON.stringify(withLog))).kind;
    };
    const line = (extra: Record<string, unknown> = {}) => ({ source: "network", level: "warning", text: "GET http://127.0.0.1:4317/api/orders.csv 403 Forbidden", at, ...extra });
    for (const level of ["info", "warning", "error"]) expect(parsedWith([line({ level })]), level).toBe("parsed");
    // The pinned runner's report-v1 schema has no debug (or any other) level.
    for (const level of ["debug", "fatal"]) expect(parsedWith([line({ level })]), level).toBe("unavailable");
  });

  it("holds the app log to the pinned runner's limits: 300 lines, 300 characters of text and a millisecond UTC timestamp", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js");
    const parsedWith = (appLog: unknown[]) => {
      const withLog = report();
      Object.assign(withLog.run.results[0]!.attempts[0]!, { appLog });
      return module.parseE2EApplicationReport(Buffer.from(JSON.stringify(withLog))).kind;
    };
    const line = (extra: Record<string, unknown> = {}) => ({ source: "console", level: "info", text: "x", at, ...extra });
    expect(parsedWith(Array.from({ length: 300 }, () => line()))).toBe("parsed");
    expect(parsedWith(Array.from({ length: 301 }, () => line()))).toBe("unavailable");
    expect(parsedWith([line({ text: "x".repeat(300) })])).toBe("parsed");
    expect(parsedWith([line({ text: "x".repeat(301) })])).toBe("unavailable");
    expect(parsedWith([line({ at: "yesterday" })])).toBe("unavailable");
  });

  it("rejects invalid UTF-8 and report bytes over the application-specific hard bound", async () => {
    const module = await import("../../packages/verifier/src/application-report-schema.js");
    expect(module.parseE2EApplicationReport(Uint8Array.from([0xff, 0xfe])).kind).toBe("unavailable");
    expect(module.parseE2EApplicationReport(new Uint8Array(module.E2E_APPLICATION_REPORT_MAX_BYTES + 1)).kind).toBe("unavailable");
    const raw = Buffer.from(JSON.stringify(report()));
    const parsed = module.parseE2EApplicationReport(raw);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.rawSha256).toBe(sha(raw));
  });
});
