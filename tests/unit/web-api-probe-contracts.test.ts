import { describe, expect, it } from "vitest";
import { E2ERunBindingSchema, WEB_API_CHALLENGE_LIFETIME_MS, WEB_API_PROBE_PROPOSAL_MAX_BYTES, WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, runtimeInstallChallengeDigest,
  webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const now = Date.parse("2026-10-19T12:00:00.000Z");

describe("web/API probe run binding", () => {
  it("derives a stable UUID run id from the challenge and the probe", () => {
    const challenge = webApiChallenge(now);
    const ids = WEB_API_REQUIRED_PROBES.map((probe) => webApiProbeRunId(challenge, probe.probeId));
    expect(new Set(ids).size).toBe(WEB_API_REQUIRED_PROBES.length);
    expect(ids.every((id) => E2ERunBindingSchema.shape.runId.safeParse(id).success)).toBe(true);
    expect(ids).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => webApiProbeRunId(structuredClone(challenge), probe.probeId)));
  });

  it("changes with any part of the challenge, so evidence from another challenge never binds", () => {
    const challenge = webApiChallenge(now);
    const base = webApiProbeRunId(challenge, "web-csv-positive-v1");
    expect(webApiProbeRunId({ ...challenge, challengeId: "11111111-1111-4111-8111-111111111111" }, "web-csv-positive-v1")).not.toBe(base);
    expect(webApiProbeRunId({ ...challenge, challengeSecret: `${"C".repeat(43)}=` }, "web-csv-positive-v1")).not.toBe(base);
    expect(runtimeInstallChallengeDigest(challenge)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("pins what each probe ran: a scenario digest for collected probes and the build command digest for the build probe", () => {
    for (const probe of WEB_API_REQUIRED_PROBES) {
      if (probe.kind === "build") expect([probe.probeId, probe.buildCommandDigest, probe.scenarioDigest]).toEqual([probe.probeId, expect.stringMatching(/^[a-f0-9]{64}$/), null]);
      else expect([probe.probeId, probe.scenarioDigest, probe.buildCommandDigest]).toEqual([probe.probeId, expect.stringMatching(/^[a-f0-9]{64}$/), null]);
    }
  });

  it("pins the bundle each collected probe runs under", () => {
    for (const probe of WEB_API_REQUIRED_PROBES) expect([probe.probeId, probe.bundleDigest]).toEqual([probe.probeId, probe.kind === "build" ? null : expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it("gives a web/API challenge an hour, long enough for six container runs", () => {
    expect(WEB_API_CHALLENGE_LIFETIME_MS).toBe(60 * 60_000);
  });

  it("holds build evidence to its own shape: the source copy (command 0) has no command, a recipe command (1 and up) always has one", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const build = (commandIndex: number, command: Record<string, unknown> | null) => WebApiProbeEvidenceSchema.safeParse({ kind: "unavailable", runId, reason: "build-failed", build: { commandIndex, exitCode: 7, command } }).success;
    expect(build(0, null)).toBe(true);
    expect(build(1, { program: "node" })).toBe(true);
    expect(build(0, { program: "node" })).toBe(false);
    expect(build(1, null)).toBe(false);
  });

  it("bounds the whole proposal at 5 MiB", () => {
    expect(WEB_API_PROBE_PROPOSAL_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("accepts collected and unavailable evidence and refuses anything else", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "collected", runId, scenarioBundle: {}, collection: {}, oracle: {}, blockedRequestsBase64: null }).success).toBe(true);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "unavailable", runId, reason: "build-failed", build: { commandIndex: 1, exitCode: 7, command: { program: "node" } } }).success).toBe(true);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "unavailable", runId, reason: "app-exited", build: null }).success).toBe(true);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "collected", runId: "not-a-uuid", scenarioBundle: {}, collection: {}, oracle: {}, blockedRequestsBase64: null }).success).toBe(false);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "collected", runId, scenarioBundle: {}, collection: [], oracle: {}, blockedRequestsBase64: null }).success).toBe(false);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "collected", runId, scenarioBundle: {}, collection: {}, oracle: {}, blockedRequestsBase64: null, extra: 1 }).success).toBe(false);
    expect(WebApiProbeEvidenceSchema.safeParse({ kind: "other", runId }).success).toBe(false);
  });
});
