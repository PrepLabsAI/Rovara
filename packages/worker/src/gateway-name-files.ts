// Worker-owned name files for Docker 25's internal-network resolver workaround. Never under a checkout.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import type { DockerCli } from "./swebench/containers.js";

export const GATEWAY_RESOLVER_DIRECTORY = "/var/lib/rovara-egress/runs";
export const GATEWAY_RESOLVER_LABEL = "rovara.egress.resolver";
export function gatewayWorkerDirectory(rootPath: string, base = GATEWAY_RESOLVER_DIRECTORY): string {
  return join(base, createHash("sha256").update(resolve(rootPath)).digest("hex").slice(0, 16));
}
export function gatewayResolvConf(dns: string): string {
  if (isIP(dns) !== 4) throw new Error("the gateway resolver must be one IPv4 address");
  return `nameserver ${dns}\noptions ndots:0 timeout:3 attempts:1\n`;
}
export async function createGatewayNameFiles(rootPath: string, dns: string, base?: string) {
  const directory = join(gatewayWorkerDirectory(rootPath, base), `run-${randomUUID()}`);
  const resolvConfPath = join(directory, "resolv.conf");
  const hostsPath = join(directory, "hosts");
  const resolver = gatewayResolvConf(dns);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(resolvConfPath, resolver, { flag: "wx", mode: 0o644 });
    await writeFile(hostsPath, "127.0.0.1 localhost\n::1 localhost ip6-localhost\n", { flag: "wx", mode: 0o644 });
    return { directory, resolvConfPath, hostsPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Check the exact worker-labelled source, destination and read-only bit before a devcontainer is restarted. */
export function gatewayResolverMount(inspection: {
  Config?: { Labels?: Readonly<Record<string, string>> | null };
  Mounts?: ReadonlyArray<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | null;
}, directory: string): string | undefined {
  const source = inspection.Config?.Labels?.[GATEWAY_RESOLVER_LABEL];
  if (source === undefined || !source.startsWith(`${directory}/`)
    || !/^devcontainer-[A-Za-z0-9]{8,}\/resolv\.conf$/u.test(source.slice(directory.length + 1))) return undefined;
  const mounts = (inspection.Mounts ?? []).filter(mount => mount.Destination === "/etc/resolv.conf");
  return mounts.length === 1 && mounts[0]!.Type === "bind" && mounts[0]!.Source === source && mounts[0]!.RW === false ? source : undefined;
}
export async function verifyGatewayResolverFile(source: string, dns: string): Promise<void> {
  for (const path of [source.slice(0, source.lastIndexOf("/")), source]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("the gateway resolver is not worker-owned");
  }
  if (await readFile(source, "utf8") !== gatewayResolvConf(dns)) throw new Error("the gateway resolver contents changed");
}

/** Only our namespace, uid and exact file names. Keep every file still mounted by any container (including stopped devcontainers). */
export async function sweepGatewayNameFiles(rootPath: string, docker: DockerCli, base?: string): Promise<number> {
  const directory = gatewayWorkerDirectory(rootPath, base);
  const listed = await docker.run(["ps", "--all", "--quiet"], { timeoutMs: 60_000 });
  if (listed.exitCode !== 0) throw new Error("could not list containers for the gateway file sweep");
  const ids = listed.stdout.trim().split(/\s+/u).filter(Boolean);
  const mounted = new Set<string>();
  if (ids.length > 0) {
    const inspected = await docker.run(["inspect", "--format", "{{json .Mounts}}", ...ids], { timeoutMs: 60_000 });
    if (inspected.exitCode !== 0) throw new Error("could not inspect mounts for the gateway file sweep");
    const lines = inspected.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== ids.length) throw new Error("incomplete container mounts for the gateway file sweep");
    for (const line of lines) {
      const mounts = JSON.parse(line) as Array<{ Source?: string }>;
      for (const mount of mounts) if (mount.Source !== undefined) mounted.add(mount.Source);
    }
  }
  const parent = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (parent === undefined || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) return 0;
  let removed = 0;
  for (const entry of await readdir(directory)) {
    if (!/^(?:run-[a-f0-9-]{36}|devcontainer-[A-Za-z0-9]{8,})$/u.test(entry)) continue;
    const path = join(directory, entry);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) continue;
    const names = await readdir(path);
    if (names.some(name => name !== "resolv.conf" && name !== "hosts")) continue;
    if (names.some(name => mounted.has(join(path, name)))) continue;
    const files = await Promise.all(names.map(name => lstat(join(path, name))));
    if (files.some(file => !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.())) continue;
    // No recursive walk: an unexpected file or link is never followed or removed.
    for (const name of names) await rm(join(path, name));
    await rmdir(path);
    removed += 1;
  }
  return removed;
}
