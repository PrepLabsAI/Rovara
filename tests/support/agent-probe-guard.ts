import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs the app-start guard of `web-agent-app-isolation-v1` (the one pinned in its installed asset) in a child Node, in a world the test describes: whether the model
 * socket is visible, what `model-proxy` resolves to and what a connect to each address does, and what the route table holds. Only the four things the guard reads
 * are swapped: the path literals (to temporary files), `net.connect` and `dns.lookup` (to doubles that record every attempt), and the final start of the app (to a marker).
 * Each literal must occur exactly once in the pinned script, so a guard that drifts from this harness fails loudly instead of being run unchecked.
 */
export type GuardWorld = Readonly<{
  /** The model socket is visible to the app. */
  socket: boolean;
  /** What `model-proxy` resolves to; null is a name that does not resolve. */
  proxyAddress: string | null;
  /** The address of the nameserver in the app's resolv.conf (the run's sinkhole); null leaves no resolv.conf. */
  nameserver: string | null;
  /** The route table the app sees; null is a table with no on-link route (an `--internal` network has no default route, but this one has no route at all). */
  gatewayRoute: boolean;
  /** What a TCP connect to port 8080 of an address does: the default is a silent drop. */
  connects: Readonly<Record<string, "connect" | "timeout" | "error">>;
}>;
export type GuardRun = Readonly<{ exitCode: number | null; started: boolean; connects: string[]; lookups: string[]; stderr: string }>;

export const GUARD_PATHS = ["/run/rovara/model.sock", "/proc/net/route", "/etc/resolv.conf", "import('./server.mjs').then(m=>m.startOrdersServer())"] as const;
export const GUARD_GATEWAY = "172.20.0.1";
/** The route table of an internal network 172.20.0.0/16 (destination 172.20.0.0 as little-endian hex), as /proc/net/route prints it. */
export const GUARD_ROUTE_TABLE = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n";

export function substituteGuard(script: string, replacements: readonly (readonly [string, string])[]): string {
  let out = script;
  for (const [literal, replacement] of replacements) {
    if (out.split(literal).length !== 2) throw new Error(`the pinned guard does not contain ${literal} exactly once`);
    out = out.replace(literal, () => replacement);
  }
  return out;
}

const PATCH = `import net from 'node:net';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const world = JSON.parse(process.env.GUARD_WORLD);
const log = (entry) => process.stdout.write(JSON.stringify(entry) + '\\n');
net.connect = (options) => {
  const address = options.host + ':' + options.port;
  log({ connect: address });
  const socket = new EventEmitter();
  socket.destroy = () => undefined;
  setImmediate(() => socket.emit(world.connects[options.host] ?? 'timeout', new Error('connect error')));
  return socket;
};
dns.lookup = async (name) => {
  log({ lookup: name });
  if (world.proxyAddress === null) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return { address: world.proxyAddress, family: 4 };
};
syncBuiltinESMExports();
`;

export function runGuard(script: string, world: GuardWorld): GuardRun {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rovara-guard-")));
  try {
    const socketPath = join(root, "model.sock");
    const routePath = join(root, "route");
    const resolvPath = join(root, "resolv.conf");
    if (world.socket) writeFileSync(socketPath, "");
    writeFileSync(routePath, world.gatewayRoute ? GUARD_ROUTE_TABLE : "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n");
    if (world.nameserver !== null) writeFileSync(resolvPath, `search example\nnameserver ${world.nameserver}\n`);
    else mkdirSync(resolvPath);
    const patched = substituteGuard(script, [[GUARD_PATHS[0], socketPath], [GUARD_PATHS[1], routePath], [GUARD_PATHS[2], resolvPath], [GUARD_PATHS[3], "process.stdout.write('{\"started\":true}\\n')"]]);
    const patchPath = join(root, "patch.mjs");
    writeFileSync(patchPath, PATCH);
    const result = spawnSync(process.execPath, ["--import", patchPath, "--input-type=module", "-e", patched], { cwd: root, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", GUARD_WORLD: JSON.stringify(world) } });
    const lines = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { connect?: string; lookup?: string; started?: boolean });
    return { exitCode: result.status, started: lines.some((line) => line.started === true), connects: lines.flatMap((line) => (line.connect === undefined ? [] : [line.connect])),
      lookups: lines.flatMap((line) => (line.lookup === undefined ? [] : [line.lookup])), stderr: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
