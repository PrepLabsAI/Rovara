import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs the app-start guard of `web-agent-app-isolation-v1` (the one pinned in its installed asset) in a child Node, in a world the test describes: whether the model socket is visible,
 * what `model-proxy` resolves to and what a connect to each address does, and what the route table holds. Only the four things the guard reads are swapped: the path literals (to
 * temporary files), `net.connect` and `dns.lookup` (to doubles that record every attempt), and the app it starts (a `server.mjs` beside it that serves one line and reports its port).
 * Each literal must occur exactly once in the pinned script, so a guard that drifts from this harness fails loudly instead of being run unchecked. The guard stays alive as the app does,
 * so a test drives it (requests, a socket that appears later) and stops it.
 */
export type GuardWorld = Readonly<{
  /** The model socket is visible to the app from the start. */
  socket: boolean;
  /** What `model-proxy` resolves to; null is a name that does not resolve. */
  proxyAddress: string | null;
  /** The address of the nameserver in the app's resolv.conf (the run's sinkhole); null leaves no readable resolv.conf. */
  nameserver: string | null;
  /** The route table holds the run's on-link route; false leaves it without one. */
  gatewayRoute: boolean;
  /** What a TCP connect to port 8080 of an address does: the default is a silent drop. */
  connects: Readonly<Record<string, "connect" | "timeout" | "error">>;
  /** Switches off the fast interval check of the socket, or the loop that repeats the full check, or both, so a test can tell the checks apart (the one at start and the one before each request stay). */
  intervalOff?: boolean;
  loopOff?: boolean;
}>;

export const GUARD_PATHS = ["/run/rovara/model.sock", "/proc/net/route", "/etc/resolv.conf"] as const;
export const GUARD_GATEWAY = "172.20.0.1";
/** The route table of an internal network 172.20.0.0/16 (destination 172.20.0.0 as little-endian hex), as /proc/net/route prints it. */
export const GUARD_ROUTE_TABLE = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n";
/** The page the guard serves itself, with the marker that says a request was checked before an earlier one was answered. */
export const GUARD_PAGE_PATH = "/__rovara-guard";
export const GUARD_MARKER = 'data-testid="guard-in-request-checks"';

export function substituteGuard(script: string, replacements: readonly (readonly [string, string])[]): string {
  let out = script;
  for (const [literal, replacement] of replacements) {
    if (out.split(literal).length !== 2) throw new Error(`the pinned guard does not contain ${literal} exactly once`);
    out = out.replace(literal, () => replacement);
  }
  return out;
}

export const GUARD_APP = `import { createServer } from 'node:http';
export function startOrdersServer() {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('app ' + req.url); });
  server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ started: true, port: server.address().port }) + '\\n'));
  return server;
}
`;

export const GUARD_PATCH = `import net from 'node:net';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
// The world is read again at every attempt, so a test can change it while the guard runs (a path that opens later).
const world = new Proxy({}, { get: (_, key) => JSON.parse(readFileSync(process.env.GUARD_WORLD_FILE, 'utf8'))[key] });
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
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const inert = { unref() { return this; } };
globalThis.setInterval = (fn, ms, ...rest) => (world.intervalOff ? inert : realSetInterval(fn, ms, ...rest));
globalThis.setTimeout = (fn, ms, ...rest) => (ms === 250 && world.loopOff ? inert : realSetTimeout(fn, ms, ...rest));
syncBuiltinESMExports();
`;

/** The files of one described world in `root`: the three paths the guard reads, the patch, the app. Returns the substituted script and the socket path to create later. */
export function prepareGuardWorld(script: string, world: GuardWorld, root: string, withApp = true): { patched: string; socketPath: string; patchPath: string } {
  const socketPath = join(root, "model.sock");
  const routePath = join(root, "route");
  const resolvPath = join(root, "resolv.conf");
  if (world.socket) writeFileSync(socketPath, "");
  writeFileSync(routePath, world.gatewayRoute ? GUARD_ROUTE_TABLE : "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n");
  if (world.nameserver !== null) writeFileSync(resolvPath, `search example\nnameserver ${world.nameserver}\n`);
  else mkdirSync(resolvPath);
  if (withApp) writeFileSync(join(root, "server.mjs"), GUARD_APP);
  const patchPath = join(root, "patch.mjs");
  writeFileSync(patchPath, GUARD_PATCH);
  return { patched: substituteGuard(script, [[GUARD_PATHS[0], socketPath], [GUARD_PATHS[1], routePath], [GUARD_PATHS[2], resolvPath]]), socketPath, patchPath };
}

export type GuardRun = Readonly<{
  /** Whether the guard started the app, and the port the app listens on (null if it did not). */
  started: boolean; port: number | null;
  /** The exit code once the guard has exited (null while it runs). */
  exitCode(): number | null;
  /** Waits for the guard to exit, up to `ms`; resolves to the code, or null if it is still running. */
  exited(ms: number): Promise<number | null>;
  /** Everything the doubles recorded so far. */
  connects(): string[];
  lookups(): string[];
  /** A request to the app through the guard. */
  get(path: string): Promise<{ status: number; body: string }>;
  /** The model socket appears (a late mount). */
  mountSocket(): void;
  /** Changes the world the doubles answer from while the guard runs. */
  setWorld(change: Partial<GuardWorld>): void;
  stderr(): string;
  stop(): void;
}>;

/** Starts the pinned guard in `world` and waits until it has started the app or exited. */
export async function startGuard(script: string, world: GuardWorld): Promise<GuardRun> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rovara-guard-")));
  const prepared = prepareGuardWorld(script, world, root);
  const worldFile = join(root, "world.json");
  writeFileSync(worldFile, JSON.stringify(world));
  const child: ChildProcess = spawn(process.execPath, ["--import", prepared.patchPath, "--input-type=module", "-e", prepared.patched], { cwd: root, env: { PATH: process.env.PATH ?? "", GUARD_WORLD_FILE: worldFile }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = ""; let code: number | null = null; let done = false;
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const closed = new Promise<void>((resolve) => child.on("close", (status) => { code = status ?? -1; done = true; resolve(); }));
  const lines = () => out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { connect?: string; lookup?: string; started?: boolean; port?: number });
  const deadline = Date.now() + 15_000;
  while (!done && !lines().some((line) => line.started === true) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const started = lines().some((line) => line.started === true);
  const port = lines().find((line) => line.started === true)?.port ?? null;
  const stop = () => { child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); };
  return { started, port, exitCode: () => code, stderr: () => err,
    exited: async (ms) => { await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, ms))]); return code; },
    connects: () => lines().flatMap((line) => (line.connect === undefined ? [] : [line.connect])), lookups: () => lines().flatMap((line) => (line.lookup === undefined ? [] : [line.lookup])),
    get: (path) => new Promise((resolve, reject) => {
      if (port === null) { reject(new Error("the guard did not start the app")); return; }
      const req = request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject); req.end();
    }),
    mountSocket: () => writeFileSync(prepared.socketPath, ""),
    setWorld: (change) => { const next = { ...world, ...change, connects: { ...world.connects, ...change.connects } }; writeFileSync(worldFile, JSON.stringify(next)); },
    stop };
}

/**
 * For the local executor double (macOS has no /proc/net/route): the guard's command as it runs here, with the same swapped seams and an isolated world, in a directory the caller owns.
 * The app it starts is the real one the double staged.
 */
export function localGuardInvocation(script: string, root: string): { args: string[]; env: Record<string, string> } {
  const world: GuardWorld = { socket: false, proxyAddress: "172.20.0.2", nameserver: "172.20.0.2", gatewayRoute: true, connects: {} };
  const prepared = prepareGuardWorld(script, world, root, false);
  const worldFile = join(root, "world.json");
  writeFileSync(worldFile, JSON.stringify(world));
  return { args: ["--import", prepared.patchPath, "--input-type=module", "-e", prepared.patched], env: { GUARD_WORLD_FILE: worldFile } };
}
