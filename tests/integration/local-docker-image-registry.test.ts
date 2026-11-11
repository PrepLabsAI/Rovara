// The local Docker image registry against a real Docker daemon: the container it makes is its own (labelled), on loopback only, a real push is listed and deleted by digest through the API, and everything
// it made is removed at the end. It runs only when ROVARA_LOCAL_REGISTRY_IMAGE names the registry image and it is already on this machine (nothing is pulled). Colima and Docker Desktop share the home
// folder with the VM only, so the state folder is made under the home folder.
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { savedEnvRepositoryName } from "@agentx/contracts";
import { createDockerImageRegistry } from "../../packages/broker/src/local/docker-image-registry.js";
import { createDockerRunner } from "../../packages/broker/src/local/docker-runner.js";

const IMAGE = process.env.ROVARA_LOCAL_REGISTRY_IMAGE;
const run = promisify(execFile);
function dockerHasImage(): boolean {
  try { execFileSync("docker", ["image", "inspect", IMAGE ?? ""], { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; }
}
const enabled = IMAGE !== undefined && IMAGE !== "" && dockerHasImage();
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!enabled)("the local registry on a real Docker", () => {
  let stateDirectory = "";
  let registry: ReturnType<typeof createDockerImageRegistry>;
  const repository = savedEnvRepositoryName({ env: "test", orgId: "org_00000000000000000000", projectId: "integration" });
  const call = { companyId: "org_00000000000000000000", repository };

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(homedir(), ".rovara-registry-test-"));
    registry = createDockerImageRegistry({ docker: createDockerRunner(), stateDirectory, image: IMAGE! });
  });
  afterAll(async () => {
    if (stateDirectory === "") return;
    // only the container this test's own state folder made (its name carries the state folder's hash)
    await run("docker", ["rm", "--force", "--volumes", `rovara-image-registry-${hashOfState(stateDirectory)}`]).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("starts its own labelled container on loopback only, and the API answers", async () => {
    const address = await registry.address();
    expect(address).toMatch(/^127\.0\.0\.1:\d+$/u);
    const response = await fetch(`http://${address}/v2/`);
    expect(response.status).toBe(200);
    const name = `rovara-image-registry-${hashOfState(stateDirectory)}`;
    const { stdout } = await run("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}} {{index .Config.Labels \"rovara.local.registry\"}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}}", name]);
    expect(stdout).toContain('"HostIp":"127.0.0.1"');
    expect(stdout).not.toContain('"HostIp":""');
    expect(stdout).toContain(" 1 true ");
    expect(stdout).toContain('["ALL"]');
  });

  it("is absent before a push; a real push is listed, and deleting by digest removes it", async () => {
    expect(await registry.inspect(call)).toBe("absent");
    expect(await registry.list(call)).toBe("absent");
    const login = await registry.login({ ...call, access: "push", maxSeconds: 120 });
    // a tiny image with nothing in it, pushed to the loopback registry the way a worker would
    const local = `rovara-registry-test-${Date.now()}:t1`;
    const remote = `${login.auth.registry}/${repository}:t1`;
    execFileSync("sh", ["-c", `tar -cf - -T /dev/null | docker import - ${local}`], { stdio: "ignore" });
    try {
      await run("docker", ["tag", local, remote]);
      await run("docker", ["push", remote]);
      const listed = await registry.list(call);
      expect(listed).not.toBe("absent");
      const images = listed as Array<{ digest: string; tags: string[] }>;
      expect(images).toHaveLength(1);
      expect(images[0]!.tags).toEqual(["t1"]);
      expect(await registry.inspect(call)).toBe("matches");
      await registry.deleteImages({ ...call, digests: [images[0]!.digest] });
      expect(await registry.list(call)).toBe("absent");
      expect(await registry.deleteRepository(call)).toBe("absent");
    } finally {
      await run("docker", ["rmi", "--force", remote, local]).catch(() => undefined);
    }
  });
});

function hashOfState(path: string): string {
  return execFileSync("node", ["-e", `process.stdout.write(require("crypto").createHash("sha256").update(${JSON.stringify(path)}).digest("hex").slice(0,12))`]).toString();
}
