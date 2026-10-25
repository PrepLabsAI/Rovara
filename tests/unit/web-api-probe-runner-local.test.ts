import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, WebApiRuntimeInstallProposalSchema, canonicalJson, evaluateWebApiProbeObservation, webApiRuntimeInstallProposalSha256 } from "../../packages/contracts/src/index.js";
import { registerRuntimeInstallation } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { main as qualificationCli } from "../../packages/verifier/src/install-qualification-cli.js";
import { createWebApiProbeRunner } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { createScriptedQualificationModelChannel } from "../../packages/worker/src/e2e-qualification-model-channel.js";
import { verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { LocalExecutorDocker } from "../support/local-executor-docker.js";
import { createFakeRuntimeRegistry } from "../support/runtime-registry-fakes.js";
import { WEB_API_FIXTURE_NOW, fakeLinuxEnvironment, webApiChallenge } from "../support/web-api-qualification.js";

// The production probe runner around the real executor running on this machine (real Chromium, real fixture app, real collector), with no Docker.
// It needs the built verifier and a Playwright Chromium, so it only runs on request:
//   ROVARA_LOCAL_BROWSER=1 npx vitest run tests/unit/web-api-probe-runner-local.test.ts
// Run it on its own: the executor serves the app on a fixed loopback port, so it cannot overlap the other local-browser test.
// The root is short on purpose: the model socket of an agent probe sits under it, and a unix socket path holds 103 bytes.
// With ROVARA_WRITE_PROBE_EVIDENCE=1 it also rewrites tests/fixtures/web-api-probe-evidence, the committed evidence the registrar tests use.
const enabled = process.env.ROVARA_LOCAL_BROWSER === "1";
const dirs: string[] = [];
const dockers: LocalExecutorDocker[] = [];
afterAll(async () => { dockers.forEach((docker) => docker.stop()); await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const fixtures = join(import.meta.dirname, "../fixtures/web-api-probe-evidence");

describe.runIf(enabled)("production probe runner around the real executor (local, no Docker)", () => {
  it.each(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId))("%s runs to its expected outcome and derives from its own evidence", async (probeId) => {
    const root = realpathSync(await mkdtemp("/tmp/rvqa-")); dirs.push(root);
    const docker = new LocalExecutorDocker(); dockers.push(docker);
    if (probeId.startsWith("build-")) docker.failOn("build", 7);
    const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
    const evidenceRoot = join(root, "evidence"); await mkdir(evidenceRoot, { mode: 0o700 });
    const runner = createWebApiProbeRunner({ docker, executorImage: "rovara-executor:local", buildImage: "node:build-test", runRoot: join(root, "runs"), evidenceRoot, challenge,
      modelChannelFor: (request) => createScriptedQualificationModelChannel(request) });
    const run = await runner(probeId);
    if (process.env.ROVARA_DEBUG_PROBE === "1") process.stdout.write(`${JSON.stringify(run.observation)} ${run.evidence.kind === "unavailable" ? JSON.stringify(run.evidence) : ""}\n${docker.calls.length} docker calls\n${docker.appOutput}\n`);
    expect(evaluateWebApiProbeObservation(probeId, run.observation)).toEqual({ ok: true });
    expect(verifyWebApiProbeRecord({ challenge, probeId, observation: run.observation, evidence: run.evidence })).toEqual({ ok: true });
    const bytes = Buffer.byteLength(canonicalJson(run.evidence));
    process.stdout.write(`probe evidence ${probeId}: ${run.evidence.kind} ${bytes} bytes\n`);
    if (process.env.ROVARA_WRITE_PROBE_EVIDENCE === "1") await writeFile(join(fixtures, `${probeId}.json`), `${canonicalJson(run.evidence)}\n`);
  }, 600_000);

  it("qualifies through the CLI, registers both rows from the proposal file, and refuses it after one flipped byte", async () => {
    const root = realpathSync(await mkdtemp("/tmp/rvqc-")); dirs.push(root);
    const docker = new LocalExecutorDocker(); dockers.push(docker);
    docker.failOn("build", 7);
    const now = Date.now();
    const challenge = webApiChallenge(now);
    const evidenceRoot = join(root, "evidence"); await mkdir(evidenceRoot, { mode: 0o700 });
    await writeFile(join(root, "challenge.json"), canonicalJson(challenge));
    const proposalFile = join(root, "proposal.json");
    await qualificationCli(["--profile", "linux-arm64-web-api-v1", "--challenge-file", join(root, "challenge.json"), "--evidence-root", evidenceRoot, "--out", proposalFile], {
      environment: { EXECUTOR_IMAGE: "rovara-executor:local" }, host: { platform: "linux", arch: "arm64" }, config: { runRoot: join(root, "runs") },
      qualificationEnvironment: fakeLinuxEnvironment(now), createProbeRunner: (input) => createWebApiProbeRunner({ ...input, docker, modelChannelFor: (request) => createScriptedQualificationModelChannel(request) }) });
    const bytes = await readFile(proposalFile);
    process.stdout.write(`proposal ${bytes.byteLength} bytes\n`);
    const proposal = WebApiRuntimeInstallProposalSchema.parse(JSON.parse(bytes.toString("utf8")));
    const admin: AuthenticatedIdentity = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };
    const registry = createFakeRuntimeRegistry(Date.now()); registry.seedChallenge(challenge);
    await expect(registerRuntimeInstallation(registry.deps, admin, { proposal, proposalSha256: webApiRuntimeInstallProposalSha256(proposal) })).resolves.toMatchObject({ featureRevisions: { web: 1, api: 1 } });
    // All fourteen probes were run and accepted, so the registered web row lists AI navigation and its model channel; the API row never does.
    expect(proposal.probes).toHaveLength(14);
    const rows = (registry.transactions[0]! as Array<{ Put?: { Item?: Record<string, unknown> } }>).flatMap((write) => (write.Put?.Item?.entityType === "E2E_FEATURE_VERIFIER" ? [write.Put.Item as { capabilities: { kind: string; supportedSteps: string[] } }] : []));
    expect(rows.find((row) => row.capabilities.kind === "web")!.capabilities).toMatchObject({ supportedSteps: ["navigate", "fill", "click", "choose-file", "agent"], modelChannel: "rovara-e2e-model-channel/v1" });
    expect(rows.find((row) => row.capabilities.kind === "api")!.capabilities.supportedSteps).not.toContain("agent");
    const flipped = JSON.parse(bytes.toString("utf8")) as { probes: { evidence: { collection: { shards: { rawReport: { bytesBase64: string } }[] } } }[] };
    const report = flipped.probes[1]!.evidence.collection.shards[0]!.rawReport;
    report.bytesBase64 = `${report.bytesBase64[0] === "A" ? "B" : "A"}${report.bytesBase64.slice(1)}`;
    const second = createFakeRuntimeRegistry(Date.now()); second.seedChallenge(challenge);
    await expect(registerRuntimeInstallation(second.deps, admin, { proposal: flipped, proposalSha256: "a".repeat(64) })).rejects.toThrow(/probe-evidence-mismatch:web-csv-negative-v1/);
    expect(second.transactions).toHaveLength(0);
  }, 900_000);
});
