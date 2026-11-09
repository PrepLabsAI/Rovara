// The health probe's program (test services, TS14; service-helpers.ts): one question to one helper, asked from a container of its own on the run's services network. The worker cannot ask it: the boot firewall drops every
// packet that comes in from an `rvi*` bridge to the host, so a TCP answer would never come back. The probe is the worker's own image with no capability, no writable root and no route out, labelled like the run's helpers so
// the sweep finds it. Its only inputs are its own arguments, which the launcher builds from numbers (an address of the run's slot, a port and a path of the catalog entry). Not run by this build (no Docker).
//
// A control call can also be a GET (`--control get`), carry a body read from a file the launcher mounted read-only (`--body-file /rovara/<name>`, for the emulator's seed document), and print the answer's body to standard output
// (`--print`, at most 256 KiB, for the emulator's ledger summary). The token is always from the environment, never an argument; the body is never an argument either (it names repository resources).
//
// `--host <ipv4> --port <port>` is a TCP connect. With `--path <path>` it is a plain HTTP GET that must answer 2xx. With `--post` (and a path) it is a control call: a POST with the token from the environment (`ROVARA_CONTROL_TOKEN`) in a header, for a helper's reset (service-reset.ts). Exit 0 when the helper answered, 1 when not. The whole question has one hard wall-clock limit (default 2 s): a helper that trickles bytes cannot keep the probe alive.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect, isIP } from "node:net";

export interface ProbeOptions {
  host: string;
  port: number;
  path?: string;
  timeoutMs?: number;
  /** A control call: POST (no body) with this token in the `x-rovara-control-token` header, which must answer 2xx. Needs a path. The token is plain letters and digits, 8 to 64. */
  post?: { token: string };
  /** A control call with more options than `post`: GET or POST, an optional body, and the answer's body handed to `onBody` (2xx only, at most CONTROL_ANSWER_MAX_BYTES; a longer answer fails the call). Needs a path. */
  control?: { token: string; method: "GET" | "POST"; body?: Buffer; onBody?: (body: string) => void; /** Called once when the answer was past CONTROL_ANSWER_MAX_BYTES (the call is then false). */ onTooLarge?: () => void };
}

/** The most an answer's body may be for a call that prints it. */
export const CONTROL_ANSWER_MAX_BYTES = 256 * 1024;
/** The most a request body may be. */
export const CONTROL_BODY_MAX_BYTES = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 2_000;

/** True when the helper answered: a TCP connection was made, or (with a path) the GET came back 2xx. Never throws. */
export function probeService(options: ProbeOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (isIP(options.host) !== 4 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return Promise.resolve(false);
  if (options.path !== undefined && !/^\/[A-Za-z0-9._~/-]{0,127}$/u.test(options.path)) return Promise.resolve(false);
  if (options.post !== undefined && (options.path === undefined || !/^[A-Za-z0-9]{8,64}$/u.test(options.post.token))) return Promise.resolve(false);
  if (options.control !== undefined && (options.post !== undefined || options.path === undefined || !/^[A-Za-z0-9]{8,64}$/u.test(options.control.token) || (options.control.method === "GET" && options.control.body !== undefined) || (options.control.body?.length ?? 0) > CONTROL_BODY_MAX_BYTES)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let destroy: () => void = () => undefined;
    // A hard wall-clock limit for the whole question. The socket's own timeouts restart whenever a byte arrives, so a helper that trickles headers (or a byte at a time) would keep the probe, and the container it runs in, alive for ever.
    const hard = setTimeout(() => { destroy(); finish(false); }, timeoutMs);
    function finish(value: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      destroy();
      resolve(value);
    }
    if (options.path === undefined) {
      const socket = connect({ host: options.host, port: options.port });
      destroy = () => socket.destroy();
      socket.on("connect", () => finish(true));
      socket.on("error", () => finish(false));
      return;
    }
    const control = options.control ?? (options.post === undefined ? undefined : { token: options.post.token, method: "POST" as const });
    const body = options.control?.body;
    const headers: Record<string, string> = control === undefined ? { connection: "close" } : { connection: "close", "x-rovara-control-token": control.token };
    if (control?.method === "POST") headers["content-length"] = String(body?.length ?? 0);
    if (body !== undefined) headers["content-type"] = "application/json";
    const call = request({ host: options.host, port: options.port, path: options.path, method: control?.method ?? "GET", headers }, (response) => {
      const ok = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300;
      const onBody = options.control?.onBody;
      if (onBody === undefined || !ok) {
        response.resume();
        finish(ok);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > CONTROL_ANSWER_MAX_BYTES) { if (!settled) options.control?.onTooLarge?.(); finish(false); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        onBody(Buffer.concat(chunks).toString("utf8"));
        finish(true);
      });
      response.on("error", () => finish(false));
    });
    destroy = () => call.destroy();
    call.on("error", () => finish(false));
    if (body !== undefined) call.end(body);
    else call.end();
  });
}

const BODY_FILE = /^\/rovara\/[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * The program's whole behaviour for one argument list and environment: the exit code and what is printed. `readBody` is the file seam (the real `readFileSync` in the container). A control call's token is read from
 * `env.ROVARA_CONTROL_TOKEN`; no argument can carry it. Anything it does not understand exits 1.
 */
export async function probeCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, readBody: (path: string) => Buffer = readFileSync): Promise<{ exitCode: 0 | 1 | 2; stdout: string }> {
  const argument = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    const value = at < 0 ? undefined : argv[at + 1];
    return value === undefined || value.startsWith("--") ? undefined : value;
  };
  const fail = { exitCode: 1 as const, stdout: "" };
  const host = argument("host");
  const port = Number(argument("port"));
  const path = argument("path");
  // A control call may be given longer than a health question (a seed creates resources), up to 30 s; the default stays 2 s.
  const wait = argument("timeout-ms") === undefined ? undefined : Number(argument("timeout-ms"));
  if (wait !== undefined && !(Number.isInteger(wait) && wait >= 100 && wait <= 30_000)) return fail;
  const timeoutMs = wait === undefined ? {} : { timeoutMs: wait };
  const token = env["ROVARA_CONTROL_TOKEN"] ?? "";
  // A control call: the token comes from the environment (an env file the launcher mounted), never from an argument.
  const method = argument("control")?.toUpperCase();
  if (method !== undefined) {
    if (method !== "GET" && method !== "POST") return fail;
    const bodyFile = argument("body-file");
    let body: Buffer | undefined;
    if (bodyFile !== undefined) {
      try {
        if (!BODY_FILE.test(bodyFile)) return fail;
        body = readBody(bodyFile);
      } catch { return fail; }
    }
    let printed = "";
    let tooLarge = false;
    const control: NonNullable<ProbeOptions["control"]> = { token, method, ...(body === undefined ? {} : { body }), ...(argv.includes("--print") ? { onBody: (text: string) => { printed = text; }, onTooLarge: () => { tooLarge = true; } } : {}) };
    const ok = host !== undefined && (await probeService({ host, port, ...timeoutMs, ...(path === undefined ? {} : { path }), control }));
    // Exit 2 says one thing: the answer was past its limit (the emulator's ledger summary has no cap of its own; a program that makes many different calls can grow it).
    return ok ? { exitCode: 0, stdout: printed } : tooLarge ? { exitCode: 2, stdout: "" } : fail;
  }
  const post = argv.includes("--post") ? { token } : undefined;
  const ok = host !== undefined && (await probeService({ host, port, ...timeoutMs, ...(path === undefined ? {} : { path }), ...(post === undefined ? {} : { post }) }));
  return ok ? { exitCode: 0, stdout: "" } : fail;
}

export async function main(): Promise<void> {
  const result = await probeCli(process.argv.slice(2), process.env);
  if (result.stdout !== "") process.stdout.write(result.stdout, () => process.exit(result.exitCode));
  else process.exit(result.exitCode);
}

if (process.argv[1]?.endsWith("service-probe.js")) void main();
