import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, canonicalJson, evaluateWebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { createWebApiProbeRunner } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { LocalExecutorDocker } from "../support/local-executor-docker.js";
import { WEB_API_FIXTURE_NOW, webApiChallenge } from "../support/web-api-qualification.js";

// The production probe runner around the real executor running on this machine (real Chromium, real fixture app, real collector), with no Docker.
// It needs the built verifier and a Playwright Chromium, so it only runs on request:
//   ROVARA_LOCAL_BROWSER=1 npx vitest run tests/unit/web-api-probe-runner-local.test.ts
// Run it on its own: the executor serves the app on a fixed loopback port, so it cannot overlap the other local-browser test.
// With ROVARA_WRITE_PROBE_EVIDENCE=1 it also rewrites tests/fixtures/web-api-probe-evidence, the committed evidence the registrar tests use.
const enabled = process.env.ROVARA_LOCAL_BROWSER === "1";
const dirs: string[] = [];
const dockers: LocalExecutorDocker[] = [];
afterAll(async () => { dockers.forEach((docker) => docker.stop()); await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const fixtures = join(import.meta.dirname, "../fixtures/web-api-probe-evidence");

describe.runIf(enabled)("production probe runner around the real executor (local, no Docker)", () => {
  it.each(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId))("%s runs to its expected outcome and derives from its own evidence", async (probeId) => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "web-api-local-"))); dirs.push(root);
    const docker = new LocalExecutorDocker(); dockers.push(docker);
    if (probeId === "build-imds-denial-v1") docker.failOn("build", 7);
    const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
    const evidenceRoot = join(root, "evidence"); await mkdir(evidenceRoot, { mode: 0o700 });
    const runner = createWebApiProbeRunner({ docker, executorImage: "rovara-executor:local", buildImage: "node:build-test", runRoot: join(root, "runs"), evidenceRoot, challenge });
    const run = await runner(probeId);
    if (process.env.ROVARA_DEBUG_PROBE === "1") process.stdout.write(`${JSON.stringify(run.observation)} ${run.evidence.kind === "unavailable" ? JSON.stringify(run.evidence) : ""}\n${docker.calls.length} docker calls\n${docker.appOutput}\n`);
    expect(evaluateWebApiProbeObservation(probeId, run.observation)).toEqual({ ok: true });
    expect(verifyWebApiProbeRecord({ challenge, probeId, observation: run.observation, evidence: run.evidence })).toEqual({ ok: true });
    const bytes = Buffer.byteLength(canonicalJson(run.evidence));
    process.stdout.write(`probe evidence ${probeId}: ${run.evidence.kind} ${bytes} bytes\n`);
    if (process.env.ROVARA_WRITE_PROBE_EVIDENCE === "1") await writeFile(join(fixtures, `${probeId}.json`), `${canonicalJson(run.evidence)}\n`);
  }, 600_000);
});
