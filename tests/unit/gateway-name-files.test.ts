import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayNameFiles, gatewayResolvConf, gatewayResolverMount, gatewayWorkerDirectory, sweepGatewayNameFiles, verifyGatewayResolverFile } from "../../packages/worker/src/gateway-name-files.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const root = async () => { const path = await mkdtemp(join(tmpdir(), "gateway-names-")); roots.push(path); return path; };
const docker = (mounts: string[] = [], fail = false): DockerCli => ({ run: async args => ({ exitCode: fail ? 1 : 0, stderr: "", stdout: args[0] === "ps" ? mounts.length > 0 ? "container1\n" : "" : JSON.stringify(mounts.map(Source => ({ Source }))) }) });

describe("worker-owned gateway name files", () => {
  it("writes only the gateway resolver, creates a different run directory each time and keeps the directory private", async () => {
    const base = await root();
    const a = await createGatewayNameFiles("/worker/a", "172.28.250.2", base);
    const b = await createGatewayNameFiles("/worker/a", "172.28.250.2", base);
    expect(a.directory).not.toBe(b.directory);
    expect(await readFile(a.resolvConfPath, "utf8")).toBe("nameserver 172.28.250.2\noptions ndots:0 timeout:3 attempts:1\n");
    expect((await lstat(a.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(a.hostsPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(a.hostsPath, "utf8")).not.toMatch(/example|nameserver/u);
    expect(() => gatewayResolvConf("8.8.8.8\nnameserver 1.1.1.1")).toThrow();
    await expect(createGatewayNameFiles("/worker/a", "172.28.250.2", "/dev/null/no-directory")).rejects.toThrow();
  });

  it("sweeps only this worker's unmounted files, retaining other workers, unknown files, symlinks and stopped-container mounts", async () => {
    const base = await root();
    const stale = await createGatewayNameFiles("/worker/a", "172.28.250.2", base);
    const active = await createGatewayNameFiles("/worker/a", "172.28.250.2", base);
    const other = await createGatewayNameFiles("/worker/b", "172.28.250.2", base);
    const unknown = await createGatewayNameFiles("/worker/a", "172.28.250.2", base);
    await writeFile(join(unknown.directory, "keep"), "other owner data");
    const linked = join(gatewayWorkerDirectory("/worker/a", base), `run-${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}`);
    await symlink(other.directory, linked);
    expect(await sweepGatewayNameFiles("/worker/a", docker([active.hostsPath]), base)).toBe(1);
    await expect(lstat(stale.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [active.directory, other.directory, unknown.directory, linked]) expect(await lstat(path)).toBeDefined();
    await expect(sweepGatewayNameFiles("/worker/a", docker([], true), base)).rejects.toThrow();
    expect(await readdir(base)).toHaveLength(2);
    expect(await sweepGatewayNameFiles("/missing", docker(), base)).toBe(0);
  });

  it("verifies exact source, destination, readonly flag, label, worker namespace, file ownership and gateway contents for reuse", async () => {
    const directory = gatewayWorkerDirectory("/worker/a", await root());
    const source = join(directory, "devcontainer-abcdefghijkl", "resolv.conf");
    await mkdir(join(directory, "devcontainer-abcdefghijkl"), { recursive: true, mode: 0o700 });
    await writeFile(source, gatewayResolvConf("172.28.250.2"), { mode: 0o644 });
    const inspection = { Config: { Labels: { "rovara.egress.resolver": source } }, Mounts: [{ Type: "bind", Source: source, Destination: "/etc/resolv.conf", RW: false }] };
    expect(gatewayResolverMount(inspection, directory)).toBe(source);
    for (const change of [{ RW: true }, { RW: undefined }, { Source: "/etc/resolv.conf" }, { Destination: "/tmp/resolv.conf" }, { Type: "volume" }]) {
      // Deliberately malformed mounts (e.g. RW missing): a cast, because the inspected data is untrusted input.
      expect(gatewayResolverMount({ ...inspection, Mounts: [{ ...inspection.Mounts[0], ...change } as unknown as (typeof inspection.Mounts)[number]] }, directory)).toBeUndefined();
    }
    expect(gatewayResolverMount({ ...inspection, Mounts: [...inspection.Mounts, ...inspection.Mounts] }, directory)).toBeUndefined();
    expect(gatewayResolverMount(inspection, `${directory}-other`)).toBeUndefined();
    expect(gatewayResolverMount({ Mounts: inspection.Mounts }, directory)).toBeUndefined();
    await verifyGatewayResolverFile(source, "172.28.250.2");
    await writeFile(source, "nameserver 1.1.1.1\n");
    await expect(verifyGatewayResolverFile(source, "172.28.250.2")).rejects.toThrow("contents changed");
    await chmod(source, 0o666);
    await expect(verifyGatewayResolverFile(source, "172.28.250.2")).rejects.toThrow("worker-owned");
  });
});
