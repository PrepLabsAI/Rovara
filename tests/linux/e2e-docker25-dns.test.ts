import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateWebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { WEB_API_BUILD_IMAGE, createWebApiProbeRunner } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { ciImage, ensureLocalImage } from "../support/ci-images.js";
import { DOCKER_25_DIND_IMAGE, startDind, type Dind } from "../support/linux-dind.js";
import { EXECUTOR_IMAGE } from "../support/linux-runtime.js";
import { collectOnThisHost } from "../support/linux-web-api-probes.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

// The AL2023 worker runs Docker 25.0.x, which does not forward the DNS queries of a container that is only on `--internal` networks to the `--dns` server it was given, even when that
// server (the run's sinkhole) is on the same network. CI's own daemon is newer and forwards, so everything else in tests/linux passes there while a Docker 25 runner fails
// `api-egress-denial-v1`. This file starts a Docker 25 daemon of its own (Docker-in-Docker, its own network namespace) and runs the production host against it. It runs where the other
// Linux tests run (ROVARA_DOCKER=1, with the executor image provided), and needs a Docker that can start a privileged container; elsewhere it skips.
const DIND_IMAGE = ciImage("docker-dind", DOCKER_25_DIND_IMAGE);
const BUILD_IMAGE = ciImage("node-build", WEB_API_BUILD_IMAGE);
describe.runIf(process.env.ROVARA_DOCKER === "1")("the production Docker host on a Docker 25 daemon", () => {
  let root = "";
  let dind: Dind;
  let runRoot = "";
  let evidenceRoot = "";

  beforeAll(async () => {
    // Not under /tmp: the dind image mounts a tmpfs of its own there, which would hide a directory shared at that path.
    root = await realpath(await mkdtemp(join("/var/tmp", "rovara-docker25-")));
    runRoot = join(root, "runs");
    evidenceRoot = join(root, "evidence");
    // The host refuses a run root that group or others can enter.
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await mkdir(evidenceRoot, { mode: 0o700 });
    await chmod(evidenceRoot, 0o700);
    // Nothing inside the dind daemon pulls from a registry: the runner pulled the dind image and the build image once (from the GHCR mirror, by digest; see scripts/ci-images.ts) and the
    // build image is copied in from the outer daemon. Each is checked against its pinned digest first.
    await ensureLocalImage(DIND_IMAGE, DOCKER_25_DIND_IMAGE);
    dind = await startDind(DIND_IMAGE, [{ path: root }, { path: dirname(installedExecutorSeccompProfilePath()), readOnly: true }]);
    await dind.load(EXECUTOR_IMAGE);
    await dind.load(BUILD_IMAGE, WEB_API_BUILD_IMAGE);
  }, 900_000);
  afterAll(async () => {
    await dind?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 120_000);

  const runner = () => createWebApiProbeRunner({ docker: dind.cli, executorImage: EXECUTOR_IMAGE, buildImage: BUILD_IMAGE, runRoot, evidenceRoot, challenge: webApiChallenge(Date.now()), collect: collectOnThisHost });

  it("is a Docker 25 daemon", () => {
    expect(dind.version).toMatch(/^25\./);
  });

  it("shows the premise: an internal-only container's lookup does not reach a --dns server on that network, but does through a mounted resolv.conf and a hosts entry", async () => {
    const network = "qd-internal";
    const dnsName = "qd-dns";
    // A UDP resolver on port 53 that answers every A query with 10.9.9.9 and logs the name and the asker.
    const server = "const d=require('dgram').createSocket('udp4');d.on('message',(m,r)=>{let i=12,n=[];while(m[i]){n.push(m.toString('latin1',i+1,i+1+m[i]));i+=m[i]+1}console.log('GOT',n.join('.'),'from',r.address);"
      + "const q=m.subarray(12,i+5);const h=Buffer.from(m.subarray(0,12));h[2]=0x81;h[3]=0x80;h.writeUInt16BE(1,4);h.writeUInt16BE(1,6);h.writeUInt16BE(0,8);h.writeUInt16BE(0,10);"
      + "d.send(Buffer.concat([h,q,Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,30,0,4,10,9,9,9])]),r.port,r.address)});d.bind(53,'0.0.0.0',()=>console.log('listening'))";
    const lookup = "for (const n of ['probe.example.com','mock-sink']) require('dns').lookup(n,(e,a)=>console.log('LOOKUP',n,e?e.code:a));setTimeout(()=>process.exit(0),12000)";
    const resolvConf = join(root, "premise-resolv.conf");
    try {
      await dind.docker("network", "create", "--internal", network);
      await dind.docker("run", "-d", "--name", dnsName, "--network", network, "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--user", "1000:1000", "--pull=never", EXECUTOR_IMAGE, "node", "-e", server);
      for (let attempt = 0; attempt < 40 && !(await dind.docker("logs", dnsName)).includes("listening"); attempt += 1) await new Promise((done) => setTimeout(done, 250));
      const address = await dind.docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", dnsName);
      const viaDns = await dind.docker("run", "--rm", "--network", network, "--dns", address, "--user", "1000:1000", "--pull=never", EXECUTOR_IMAGE, "node", "-e", lookup);
      // The documented Docker 25 behaviour the host works around: the query is dropped, and the sinkhole stand-in never sees it.
      expect(viaDns).toContain("LOOKUP probe.example.com EAI_AGAIN");
      expect(await dind.docker("logs", dnsName)).not.toContain("GOT probe.example.com");
      // The host's way: a read-only resolv.conf of its own and a hosts entry for the run's names.
      await writeFile(resolvConf, `nameserver ${address}\noptions ndots:0 timeout:2 attempts:2\n`, { mode: 0o644 });
      const viaFile = await dind.docker("run", "--rm", "--network", network, "--read-only", "-v", `${resolvConf}:/etc/resolv.conf:ro`, "--add-host", `mock-sink:${address}`, "--user", "1000:1000", "--pull=never",
        EXECUTOR_IMAGE, "node", "-e", lookup);
      expect(viaFile).toContain("LOOKUP probe.example.com 10.9.9.9");
      expect(viaFile).toContain(`LOOKUP mock-sink ${address}`);
      expect(await dind.docker("logs", dnsName)).toMatch(/GOT probe\.example\.com from 172\./);
    } finally {
      await dind.docker("rm", "-f", dnsName).catch(() => undefined);
      await dind.docker("network", "rm", network).catch(() => undefined);
    }
  }, 180_000);

  it("sends the app's lookup of an undeclared name to the sinkhole: api-egress-denial-v1 is UNKNOWN unmocked-external-call with exactly one sinkhole call", async () => {
    const run = await runner()("api-egress-denial-v1");
    expect(run.observation).toMatchObject({ collectorStatus: "UNKNOWN", runUnavailableReason: null, runReason: "unmocked-external-call", failedAssertionKinds: ["http-status"], unmockedCalls: { sinkhole: 1, mocked: 0 } });
    expect(evaluateWebApiProbeObservation("api-egress-denial-v1", run.observation)).toEqual({ ok: true });
  }, 300_000);

  // This probe drives Chromium, whose sandbox needs unprivileged user namespaces (the CI step before the Linux tests turns the runner's AppArmor restriction off). A host where that
  // cannot be done sets ROVARA_DOCKER25_NO_CHROMIUM=1; the premise test above still shows that a hosts entry resolves on a Docker 25 daemon.
  it.skipIf(process.env.ROVARA_DOCKER25_NO_CHROMIUM === "1")("still resolves a mock's alias for the app: web-mock-origin-v1 consumes the approved inventory mock once and calls nothing else", async () => {
    const run = await runner()("web-mock-origin-v1");
    expect(run.observation).toMatchObject({ collectorStatus: "PASS", runUnavailableReason: null, mockConsumptions: { success: 1, refusal: 0, invalidData: 0 }, unmockedCalls: { sinkhole: 0, mocked: 0 } });
    expect(evaluateWebApiProbeObservation("web-mock-origin-v1", run.observation)).toEqual({ ok: true });
  }, 300_000);

  it("leaves nothing of the runs in the daemon", async () => {
    expect(await dind.docker("ps", "-a", "--filter", "label=rovara.run", "--format", "{{.Names}}")).toBe("");
    expect(await dind.docker("network", "ls", "--filter", "label=rovara.run", "--format", "{{.Name}}")).toBe("");
  });
});
