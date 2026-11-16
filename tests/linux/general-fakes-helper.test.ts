import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENERAL_FAKES_HELPER_PORT, GENERAL_FAKES_RUN_DIR, buildOpenApiFake, type GeneralFakeServiceFake } from "@agentx/contracts";
import { generalFakesRunId, startGeneralFakesHelper } from "../../packages/worker/src/general-fakes-hosted.js";
import { createDockerCli } from "../../packages/worker/src/swebench/containers.js";
import { assertFirewallInstalled, docker, reachScript } from "../support/linux-network-walls.js";
import { APP_NODE_IMAGE, EXECUTOR_IMAGE } from "../support/linux-runtime.js";

// General fakes slice 2b (owner decision 252a): the hosted fake-helper container, for real. This is the FIRST real proof of the launcher (packages/worker/src/general-fakes-hosted.ts): nothing about it had been run
// against Docker before this test, because the lane that wrote it starts no Docker. It runs only in CI's `linux-runtime` job (ROVARA_DOCKER=1, the executor image built there, and the container firewall boot.sh installs);
// elsewhere it skips. It builds a derived image from the executor image (which carries node and this checkout's built contracts) plus the worker's built helper program, then:
//   - starts the helper through the production launcher (network, container, readiness, the sandbox joining) with a tiny fixture app, a node container standing in for the task sandbox;
//   - shows the app gets labelled answers from the fake over the run network, and only the app does (a second container on the same network is closed unread and counted);
//   - shows the container is what the design says: one internal network, every capability dropped, no privilege, a read-only root, one read-only mount, bounded memory, cpus and pids, no environment of the worker's,
//     no way out of the network, no way to write the set;
//   - shows stop() leaves nothing behind (no container, no network, the sandbox back on its own network, the run files gone).
// Every claim has a control: the same container can write where it is meant to, and the app does get an answer.
const REPO = resolve(import.meta.dirname, "../..");
const PREFIX = `rovara-gf-linux-${String(process.pid)}`;
const TEST_IMAGE = `rovara-gf-helper-test:${String(process.pid)}`;
const SANDBOX = `${PREFIX}-sandbox`;
const INTRUDER = `${PREFIX}-intruder`;
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "pets", version: "1" },
  paths: {
    "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } },
    "/odd": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "string", enum: ["a"] } } } } } } },
  },
};
const RUN_WS = "0123456789abcdef";
const WORKSPACE_FILTER = `label=rovara.run-network.workspace=${RUN_WS}`;
const WORKSPACE_ID = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION_ID = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });

/** The parts of `docker inspect` this test reads. */
interface Inspected {
  HostConfig: { Privileged: boolean; CapDrop: string[] | null; CapAdd: string[] | null; SecurityOpt: string[] | null; ReadonlyRootfs: boolean; Memory: number; MemorySwap: number; NanoCpus: number; PidsLimit: number; Dns: string[] | null; PortBindings: object | null; NetworkMode: string; PidMode: string | null; Devices: unknown[] | null; Binds: string[] | null; Tmpfs: Record<string, string> | null };
  Mounts: { Type: string; Destination: string; RW: boolean }[];
  Config: { User: string; Env: string[]; Labels: Record<string, string> };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  Internal?: boolean;
  Options?: Record<string, string>;
}

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the hosted fake helper, on a real Docker host", () => {
  const cli = createDockerCli();
  const folders: string[] = [];
  let imageId = "";
  let runParent = "";
  let helperName = "";
  let networkName = "";
  let helperIp = "";
  let started: Awaited<ReturnType<typeof startGeneralFakesHelper>> | undefined;
  const fakes: GeneralFakeServiceFake[] = [{ status: "built", fake: buildOpenApiFake(DOCUMENT, "openapi.json") }];

  const inspect = async (name: string): Promise<Inspected> => {
    const result = await docker("inspect", name);
    expect(result.code, result.stderr).toBe(0);
    return (JSON.parse(result.stdout) as Inspected[])[0]!;
  };
  /** What the fixture app sees when it calls its base-URL variable: one JSON line. */
  const callFromApp = async (container: string, base: string, path: string, method = "GET"): Promise<{ status?: number; label?: string | null; body?: string; error?: string }> => {
    const script = "fetch(process.env.PETS_API_URL + process.env.CALL_PATH,{method:process.env.CALL_METHOD,signal:AbortSignal.timeout(5000)}).then(async r=>{console.log(JSON.stringify({status:r.status,label:r.headers.get('x-rovara-label'),body:await r.text()}))},e=>{console.log(JSON.stringify({error:String((e&&e.cause&&e.cause.code)||(e&&e.name))}))})";
    const result = await docker("exec", "--env", `PETS_API_URL=${base}`, "--env", `CALL_PATH=${path}`, "--env", `CALL_METHOD=${method}`, container, "node", "-e", script);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { status?: number; label?: string | null; body?: string; error?: string };
  };

  beforeAll(async () => {
    await assertFirewallInstalled();
    for (const file of ["general-fakes-helper.js", "general-fakes-server.js"]) if (!existsSync(join(REPO, "packages/worker/dist", file))) throw new Error(`packages/worker/dist/${file} is missing: the job runs npm run build before the tests`);
    // The derived image: the executor image (node, this checkout's built contracts under /opt/agentx) plus the worker's built helper program at the path the launcher runs.
    const context = await mkdtemp(join(tmpdir(), "rovara-gf-image-"));
    folders.push(context);
    await mkdir(join(context, "helper"));
    for (const file of ["general-fakes-helper.js", "general-fakes-server.js"]) await copyFile(join(REPO, "packages/worker/dist", file), join(context, "helper", file));
    await copyFile(join(REPO, "packages/worker/package.json"), join(context, "package.json"));
    await writeFile(join(context, "Dockerfile"), `FROM ${EXECUTOR_IMAGE}\nCOPY package.json /opt/agentx/packages/worker/package.json\nCOPY helper/ /opt/agentx/packages/worker/dist/\n`);
    const built = await docker("build", "--quiet", "-t", TEST_IMAGE, context);
    if (built.code !== 0) throw new Error(`could not build the helper test image: ${built.stderr}`);
    // The launcher takes the worker's image as a digest or an image id; a local test image has the id.
    const id = await docker("image", "inspect", "--format", "{{.Id}}", TEST_IMAGE);
    imageId = id.stdout.trim();
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    runParent = await mkdtemp(join(tmpdir(), "rovara-gf-run-"));
    folders.push(runParent);
    // The stand-in for the task sandbox: node, an unprivileged user, no capability, on a network of its own (the real one is `agentx-task`), like a TaskSandbox.
    expect((await docker("network", "create", `${PREFIX}-task`)).code).toBe(0);
    const sandbox = await docker("run", "--detach", "--pull=never", "--name", SANDBOX, "--network", `${PREFIX}-task`, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "sleep", APP_NODE_IMAGE, "infinity");
    expect(sandbox.code, sandbox.stderr).toBe(0);
  }, 600_000);

  afterAll(async () => {
    await started?.stop();
    await docker("rm", "--force", SANDBOX, INTRUDER);
    await docker("network", "rm", `${PREFIX}-task`);
    await docker("rmi", "--force", TEST_IMAGE);
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  }, 120_000);

  it("starts through the production launcher: the network, the helper, the readiness check and the sandbox joining", async () => {
    started = await startGeneralFakesHelper({
      docker: cli, image: imageId, workspaceKey: RUN_WS, workspaceId: WORKSPACE_ID, operationId: OPERATION_ID, round: 1, sandboxName: SANDBOX, fakes, variables: ["PETS_API_URL"], scratchParent: runParent, roundBudgetMs: 600_000,
      environment: { AGENTX_GENERAL_FAKES_HELPER: "1", AGENTX_WORKER_IMAGE: imageId, AGENTX_TEST_SERVICES_RUN_DIR: runParent, AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS },
    });
    const base = started.environment.PETS_API_URL!;
    expect(base).toMatch(new RegExp(`^http://172\\.30\\.\\d+\\.16:${String(GENERAL_FAKES_HELPER_PORT)}/s/0$`, "u"));
    helperIp = /^http:\/\/([\d.]+):/u.exec(base)![1]!;
    const listed = await docker("ps", "--filter", WORKSPACE_FILTER, "--format", "{{.Names}}");
    helperName = listed.stdout.split("\n").find((name) => name.endsWith("-fakes")) ?? "";
    expect(helperName).toMatch(/^rovara-svc-[0-9a-f]{12}-fakes$/u);
    networkName = helperName.slice(0, -"-fakes".length);
    expect(generalFakesRunId(OPERATION_ID, 1)).toMatch(/^gf-/u);
  }, 180_000);

  it("the app gets an answer from the fake over the run network, and every answer is labelled madeByRovara (control: the answers differ)", async () => {
    const base = started!.environment.PETS_API_URL!;
    const served = await callFromApp(SANDBOX, base, "/pets/4");
    expect(served).toMatchObject({ status: 200, label: "madeByRovara" });
    expect(JSON.parse(served.body!)).toEqual({ id: 5 });
    const cannot = await callFromApp(SANDBOX, base, "/odd");
    expect(cannot).toMatchObject({ status: 501, label: "madeByRovara" });
    expect(JSON.parse(cannot.body!)).toEqual({ error: "rovara_fake_cannot_answer" });
    const unknown = await callFromApp(SANDBOX, base, "/nothing");
    expect(unknown).toMatchObject({ status: 501, label: "madeByRovara" });
    const unrouted = await callFromApp(SANDBOX, `http://${helperIp}:${String(GENERAL_FAKES_HELPER_PORT)}`, "/pets/4");
    expect(unrouted).toMatchObject({ status: 404, label: "madeByRovara" });
  }, 120_000);

  it("the worker reads what the helper answered by `docker exec`, bound to this company and task", async () => {
    const calls = await started!.drain();
    expect(calls).toBeDefined();
    expect(calls).toMatchObject({ served: 1, unrouted: 1, foreign: 0, cannotAnswer: { operation_unsupported: 1, operation_unknown: 1 } });
    // Nothing new since: the second read is a delta, not a total.
    expect(await started!.drain()).toMatchObject({ served: 0, unrouted: 0 });
  }, 60_000);

  it("serves only the sandbox's address: another container on the same network is closed unread and counted as foreign", async () => {
    const subnet = helperIp.split(".").slice(0, 3).join(".");
    const intruder = await docker("run", "--detach", "--pull=never", "--name", INTRUDER, "--network", networkName, "--ip", `${subnet}.5`, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "sleep", APP_NODE_IMAGE, "infinity");
    expect(intruder.code, intruder.stderr).toBe(0);
    const refused = await callFromApp(INTRUDER, started!.environment.PETS_API_URL!, "/pets/4");
    expect(refused.status).toBeUndefined();
    expect(refused.error).toBeDefined();
    const afterIntruder = await started!.drain();
    expect(afterIntruder).toMatchObject({ served: 0 });
    expect(afterIntruder!.foreign).toBeGreaterThanOrEqual(1);
    // Control: the sandbox is still answered.
    expect(await callFromApp(SANDBOX, started!.environment.PETS_API_URL!, "/pets/4")).toMatchObject({ status: 200 });
    await docker("rm", "--force", INTRUDER);
  }, 120_000);

  it("is what the design says: one internal network, no capability, no privilege, a read-only root, one read-only mount, bounded, no environment of the worker's", async () => {
    const helper = await inspect(helperName);
    const host = helper.HostConfig;
    expect(host.Privileged).toBe(false);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd ?? []).toEqual([]);
    expect(host.SecurityOpt).toEqual([expect.stringMatching(/^no-new-privileges(?::true)?$/u)]);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Memory).toBe(192 * 1024 * 1024);
    expect(host.MemorySwap).toBe(192 * 1024 * 1024);
    expect(host.NanoCpus).toBe(500_000_000);
    expect(host.PidsLimit).toBe(64);
    expect(host.Dns).toEqual(["127.0.0.1"]);
    expect(host.PortBindings ?? {}).toEqual({});
    expect(host.NetworkMode).toBe(networkName);
    expect(host.PidMode ?? "").toBe("");
    expect(host.Devices ?? []).toEqual([]);
    expect((host.Binds ?? []).map((bind) => bind.split(":").slice(1).join(":"))).toEqual([`${GENERAL_FAKES_RUN_DIR}:ro`]);
    // The bind mount is listed in Mounts; a `--tmpfs` is listed in HostConfig.Tmpfs (and, on some Docker versions, also in Mounts): exactly one tmpfs either way.
    expect(helper.Mounts.filter((mount) => mount.Type === "bind").map((mount) => [mount.Destination, mount.RW])).toEqual([[GENERAL_FAKES_RUN_DIR, false]]);
    expect(helper.Mounts.filter((mount) => mount.Type !== "bind" && mount.Type !== "tmpfs")).toEqual([]);
    expect([...new Set([...Object.keys(host.Tmpfs ?? {}), ...helper.Mounts.filter((mount) => mount.Type === "tmpfs").map((mount) => mount.Destination)])]).toEqual(["/rovara/ledger"]);
    expect(helper.Config.User).toBe("1000:1000");
    expect(Object.keys(helper.NetworkSettings.Networks)).toEqual([networkName]);
    expect(helper.NetworkSettings.Networks[networkName]?.IPAddress).toBe(helperIp);
    // The network is internal and carries the `rvi` bridge name the boot firewall walls.
    const network = await inspect(networkName);
    expect(network.Internal).toBe(true);
    expect(network.Options?.["com.docker.network.bridge.name"]).toMatch(/^rvi[0-9a-f]{8}$/u);
    // None of the worker's own variables (the container's environment is the image's own).
    const names = helper.Config.Env.map((entry) => entry.split("=")[0]!);
    expect(names.filter((name) => /^(?:AGENTX_|AWS_|PI_|GIT_|ROVARA_)|TOKEN|SECRET|KEY/u.test(name))).toEqual([]);
    expect(Object.keys(helper.Config.Labels)).toEqual(expect.arrayContaining(["rovara.run-network", "rovara.run-network.created", "rovara.run-network.expires", "rovara.run-network.workspace"]));
  }, 60_000);

  it("inside: no effective capability, no way to write the root or the set (control: its own tmpfs is writable), and no way out of the network", async () => {
    const inHelper = (script: string) => docker("exec", helperName, "node", "-e", script);
    const caps = await inHelper("const s=require('fs').readFileSync('/proc/self/status','utf8');console.log(/^CapEff:\\s*0+$/m.test(s)&&/^NoNewPrivs:\\s*1$/m.test(s)?'no-caps':'caps')");
    expect(caps.stdout.trim()).toBe("no-caps");
    const writes = await inHelper("const fs=require('fs');const t=(p)=>{try{fs.writeFileSync(p,'x');return 'wrote'}catch(e){return e.code}};console.log(JSON.stringify([t('/probe'),t('/rovara/fakes/probe'),t('/tmp/probe'),t('/rovara/ledger/probe')]))");
    expect(JSON.parse(writes.stdout.trim())).toEqual(["EROFS", "EROFS", "EROFS", "wrote"]);
    // The set cannot be changed by the helper: the mount is read-only and the file is not its own to rewrite.
    const set = await inHelper("const fs=require('fs');try{fs.appendFileSync('/rovara/fakes/set.json','x');console.log('appended')}catch(e){console.log(e.code)}");
    expect(set.stdout.trim()).toBe("EROFS");
    // The only network is the internal one: its gateway, a public address and the metadata address are all unreachable (none is "open").
    const reach = await inHelper(reachScript([["bridge", 8080], ["bridge", 22], ["8.8.8.8", 53], ["169.254.169.254", 80]]));
    const outcomes = JSON.parse(reach.stdout.trim().split("\n").at(-1)!) as string[];
    expect(outcomes).toHaveLength(4);
    expect(outcomes).not.toContain("open");
    // Control: the helper does reach its own address from itself, so a connect that works would show as "open".
    const self = await inHelper(`const n=require('net');const s=n.connect({host:'${helperIp}',port:${String(GENERAL_FAKES_HELPER_PORT)},timeout:3000});s.on('connect',()=>{console.log('open');s.destroy()}).on('error',e=>console.log(e.code)).on('timeout',()=>console.log('timeout'))`);
    expect(self.stdout.trim()).toBe("open");
  }, 120_000);

  it("the sandbox keeps its own network and joined the run's at .3 only for the round", async () => {
    const sandbox = await inspect(SANDBOX);
    const networks = sandbox.NetworkSettings.Networks;
    expect(Object.keys(networks).sort()).toEqual([`${PREFIX}-task`, networkName].sort());
    expect(networks[networkName]!.IPAddress).toBe(`${helperIp.split(".").slice(0, 3).join(".")}.3`);
  }, 60_000);

  it("stop() leaves nothing behind: no container, no network, the sandbox back on its own network, the run files gone", async () => {
    await started!.stop();
    expect((await docker("ps", "--all", "--filter", WORKSPACE_FILTER, "--format", "{{.Names}}")).stdout.trim()).toBe("");
    expect((await docker("network", "ls", "--filter", WORKSPACE_FILTER, "--format", "{{.Name}}")).stdout.trim()).toBe("");
    const sandbox = await inspect(SANDBOX);
    expect(Object.keys(sandbox.NetworkSettings.Networks)).toEqual([`${PREFIX}-task`]);
    expect(await readdir(runParent)).toEqual([]);
    // Idempotent, and the helper cannot be read any more (a closed round answers nothing).
    await started!.stop();
    expect(await started!.drain()).toBeUndefined();
  }, 120_000);
});
