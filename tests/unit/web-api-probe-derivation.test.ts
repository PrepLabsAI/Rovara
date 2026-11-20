import { describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, e2eScenarioBundleDigest, webApiProbeRunId, type E2EScenarioBundle, type WebApiProbeEvidence } from "../../packages/contracts/src/index.js";
import { deriveWebApiProbeObservation } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { fixtureEvidence, webApiChallenge, WEB_API_FIXTURE_NOW } from "../support/web-api-qualification.js";

const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
/** Loose view of the collected evidence the tests edit; the schemas under test decide what is valid. */
type Collected = Extract<WebApiProbeEvidence, { kind: "collected" }> & { collection: { shards: { rawReport: { bytesBase64: string } }[] }; oracle: { binding: { runId: string } } };
const collected = (probeId: string) => structuredClone(fixtureEvidence(probeId)) as Collected;
const derive = (probeId: string, evidence: unknown, pins?: Parameters<typeof deriveWebApiProbeObservation>[0]["pins"]) =>
  deriveWebApiProbeObservation({ challenge, probeId, evidence, ...(pins ? { pins } : {}) });
const blocked = (evidence: Collected) => JSON.parse(Buffer.from(evidence.blockedRequestsBase64!, "base64").toString("utf8")) as Record<string, unknown>;
const withBlocked = (evidence: Collected, patch: Record<string, unknown>): Collected => ({ ...evidence, blockedRequestsBase64: Buffer.from(JSON.stringify({ ...blocked(evidence), ...patch })).toString("base64") });

describe("deriving a probe's observation from its retained evidence", () => {

  it("calls evidence of another run or challenge unbound, wherever the run id is carried", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    expect(derive("web-csv-positive-v1", { ...collected("web-csv-positive-v1"), runId: other })).toEqual({ ok: false, reason: "probe-evidence-unbound:web-csv-positive-v1" });
    const inner = collected("api-state-positive-v1"); inner.oracle.binding.runId = other;
    expect(derive("api-state-positive-v1", inner)).toEqual({ ok: false, reason: "probe-evidence-unbound:api-state-positive-v1" });
    expect(derive("api-state-positive-v1", fixtureEvidence("web-csv-positive-v1"))).toEqual({ ok: false, reason: "probe-evidence-unbound:api-state-positive-v1" });
    const another = webApiChallenge(WEB_API_FIXTURE_NOW, { generation: 4 });
    for (const probe of WEB_API_REQUIRED_PROBES) {
      expect(deriveWebApiProbeObservation({ challenge: another, probeId: probe.probeId, evidence: fixtureEvidence(probe.probeId) })).toEqual({ ok: false, reason: `probe-evidence-unbound:${probe.probeId}` });
    }
    expect(fixtureEvidence("web-csv-positive-v1").runId).toBe(webApiProbeRunId(challenge, "web-csv-positive-v1"));
  });

  it("never reads a verdict out of collector bytes that do not hold together", () => {
    const edited = collected("web-csv-negative-v1");
    const shard = edited.collection.shards[0]!;
    shard.rawReport.bytesBase64 = Buffer.from(Buffer.from(shard.rawReport.bytesBase64, "base64").toString("utf8").replace("failed", "passed")).toString("base64");
    expect(derive("web-csv-negative-v1", edited)).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-negative-v1" });
    const dropped = collected("web-csv-negative-v1") as unknown as { collection: Record<string, unknown> };
    delete dropped.collection.shards;
    expect(derive("web-csv-negative-v1", dropped)).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-negative-v1" });
  });

  it("holds the evidence to the scenario pinned for the probe, and a build probe to its pinned command", () => {
    const pins = (patch: (probe: (typeof WEB_API_REQUIRED_PROBES)[number]) => Record<string, unknown>) => WEB_API_REQUIRED_PROBES.map((probe) => ({ ...probe, ...patch(probe) })) as unknown as typeof WEB_API_REQUIRED_PROBES;
    expect(derive("web-csv-positive-v1", fixtureEvidence("web-csv-positive-v1"), pins((probe) => (probe.probeId === "web-csv-positive-v1" ? { scenarioDigest: "f".repeat(64) } : {})))).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
    expect(derive("build-imds-denial-v1", fixtureEvidence("build-imds-denial-v1"), pins((probe) => (probe.probeId === "build-imds-denial-v1" ? { buildCommandDigest: "f".repeat(64) } : {})))).toEqual({ ok: false, reason: "probe-evidence-mismatch:build-imds-denial-v1" });
    expect(derive("web-csv-positive-v1", fixtureEvidence("web-csv-positive-v1"), pins((probe) => (probe.probeId === "web-csv-positive-v1" ? { bundleDigest: "f".repeat(64) } : {})))).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
    // A collected run for a probe that pins no scenario (the build probe) is not a run of it.
    expect(derive("build-imds-denial-v1", { ...collected("web-csv-positive-v1"), runId: webApiProbeRunId(challenge, "build-imds-denial-v1") })).toEqual({ ok: false, reason: "probe-evidence-mismatch:build-imds-denial-v1" });
  });

  it("ties the embedded scenario bundle to the run the oracle describes", () => {
    // A self-consistent bundle holding the very scenario that is pinned, but not the bundle this run was admitted with.
    const evidence = collected("web-csv-positive-v1");
    const { bundleDigest: _old, ...body } = evidence.scenarioBundle as E2EScenarioBundle;
    void _old;
    const other = { ...body, planDigest: "d".repeat(64), bundleDigest: "0".repeat(64) } as E2EScenarioBundle;
    other.bundleDigest = e2eScenarioBundleDigest(other);
    expect(derive("web-csv-positive-v1", { ...evidence, scenarioBundle: other })).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
    // The cases the oracle expects name the scenario that was pinned.
    const renamed = collected("web-csv-positive-v1") as unknown as { oracle: { expectedCases: { scenarioId: string }[] } };
    renamed.oracle.expectedCases[0]!.scenarioId = "another-scenario";
    expect(derive("web-csv-positive-v1", renamed)).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
  });

  it("accepts a blocked-requests file only when it names this run, its group and its upstream runs", () => {
    const evidence = collected("web-egress-denial-v1");
    expect(blocked(evidence).runId).toBe(evidence.runId);
    expect(derive("web-egress-denial-v1", evidence)).toMatchObject({ ok: true });
    for (const patch of [{ runId: "11111111-1111-4111-8111-111111111111" }, { groupId: "other-group" }, { shards: [] }, { shards: [{ shardId: "x", upstreamRunId: "22222222-2222-4222-8222-222222222222" }] },
      { schemaVersion: "e2e-executor-blocked-requests/v2" }, { blocked: "none" }, { blocked: [{ host: 7 }] }]) {
      expect(derive("web-egress-denial-v1", withBlocked(evidence, patch)), JSON.stringify(patch)).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-egress-denial-v1" });
    }
    expect(derive("web-egress-denial-v1", { ...evidence, blockedRequestsBase64: Buffer.from("not json").toString("base64") })).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-egress-denial-v1" });
    // No file at all means no blocked host was shown, which is a fact the oracle then judges, not a reason to refuse the evidence.
    expect(derive("web-egress-denial-v1", { ...evidence, blockedRequestsBase64: null })).toMatchObject({ ok: true, observation: { blockedHosts: [] } });
  });

  it("refuses a probe the profile does not require, and evidence of no known shape", () => {
    expect(derive("web-auth-viewer-refusal-v1", fixtureEvidence("web-csv-positive-v1"))).toEqual({ ok: false, reason: "unknown-probe:web-auth-viewer-refusal-v1" });
    expect(derive("web-csv-positive-v1", { kind: "collected" })).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
    expect(derive("web-csv-positive-v1", null)).toEqual({ ok: false, reason: "probe-evidence-mismatch:web-csv-positive-v1" });
  });
});
