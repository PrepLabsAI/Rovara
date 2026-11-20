import { describe, expect, it } from "vitest";
import { evaluateWebApiProbeObservation, type WebApiProbeEvidence } from "../../packages/contracts/src/index.js";
import { deriveWebApiProbeObservation } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { fixtureEvidence, webApiChallenge, WEB_API_FIXTURE_NOW } from "../support/web-api-qualification.js";

const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
const PROBE = "chromium-sandbox-v1";
type Collected = Extract<WebApiProbeEvidence, { kind: "collected" }>;
const collected = (probeId = PROBE) => structuredClone(fixtureEvidence(probeId)) as Collected;
const attestationOf = (evidence: Collected) => JSON.parse(Buffer.from(evidence.chromiumSandboxBase64!, "base64").toString("utf8")) as {
  runId: string; groupId: string; browser: { pid: number; nsPidDepth: number; seccompFilters: number; uidMap: string }; renderers: { pid: number; nsPidDepth: number; seccompFilters: number; uidMap: string }[] };
const withAttestation = (evidence: Collected, edit: (attestation: ReturnType<typeof attestationOf>) => void): Collected => {
  const attestation = attestationOf(evidence); edit(attestation);
  return { ...evidence, chromiumSandboxBase64: Buffer.from(JSON.stringify(attestation)).toString("base64") };
};
const derive = (evidence: unknown, probeId = PROBE) => deriveWebApiProbeObservation({ challenge, probeId, evidence });
const mismatch = { ok: false, reason: `probe-evidence-mismatch:${PROBE}` };

describe("the chromium-sandbox-v1 qualification probe", () => {

  it("refuses evidence with no attestation, since a run that never looked at the sandbox shows nothing about it", () => {
    expect(derive({ ...collected(), chromiumSandboxBase64: null })).toEqual(mismatch);
    const { chromiumSandboxBase64: _removed, ...without } = collected();
    void _removed;
    expect(derive(without)).toEqual(mismatch);
  });

  it.each([
    ["a renderer without its own seccomp filter", (a: ReturnType<typeof attestationOf>) => { a.renderers[0]!.seccompFilters = a.browser.seccompFilters; }],
    ["a renderer in the browser's PID namespace", (a: ReturnType<typeof attestationOf>) => { a.renderers[0]!.nsPidDepth = a.browser.nsPidDepth; }],
    ["a renderer in the browser's user namespace", (a: ReturnType<typeof attestationOf>) => { a.renderers[0]!.uidMap = a.browser.uidMap; }],
    ["no renderer at all", (a: ReturnType<typeof attestationOf>) => { a.renderers = []; }],
    ["another run's attestation", (a: ReturnType<typeof attestationOf>) => { a.runId = "11111111-1111-4111-8111-111111111111"; }],
    ["another group's attestation", (a: ReturnType<typeof attestationOf>) => { a.groupId = "another-group"; }],
  ])("refuses %s", (_label, edit) => {
    expect(derive(withAttestation(collected(), edit))).toEqual(mismatch);
  });

  it("refuses an attestation that is not the executor's shape or not JSON, and one that carries a verdict of its own", () => {
    expect(derive({ ...collected(), chromiumSandboxBase64: Buffer.from("not json").toString("base64") })).toEqual(mismatch);
    expect(derive(withAttestation(collected(), (attestation) => { Object.assign(attestation, { sandboxed: true }); }))).toEqual(mismatch);
  });

  it("is unavailable, and so not a pass, when the executor refused to run in an unsandboxed browser", () => {
    const refused: WebApiProbeEvidence = { kind: "unavailable", runId: collected().runId, reason: "executor-failed", build: null };
    const derived = derive(refused);
    expect(derived).toMatchObject({ ok: true, observation: { collectorStatus: null, runUnavailableReason: "executor-failed" } });
    if (!derived.ok) throw new Error("not derived");
    expect(evaluateWebApiProbeObservation(PROBE, derived.observation)).toEqual({ ok: false, reason: `positive-probe-failed:${PROBE}` });
  });

});
