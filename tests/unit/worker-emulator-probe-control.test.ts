// Slice 2, s2-emulator-run: the probe program's control calls (service-probe.ts) against a real HTTP server that behaves like the fork's control gate (FORK-CTRL-1): every /_rovara/* path but health answers 403 without
// the run's token in `x-rovara-control-token`. This is the worker's half of "a sandbox cannot call the control paths": a request with no token (what a sandbox could send) is refused, one with the run's token
// (only the worker's own call container has it, from its env file) is answered, and the token and the body never come from an argument.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_ANSWER_MAX_BYTES, probeCli, probeService } from "../../packages/worker/src/service-probe.js";

const TOKEN = ["tk", "Vb4Nq8Wz2Kd7Ms6Jf3Xa9Pe5"].join("");
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }))); });

interface Seen { method: string; path: string; token: string | undefined; body: string }
async function emulator(handler?: (request: IncomingMessage, response: ServerResponse, body: string) => boolean): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const token = request.headers["x-rovara-control-token"];
      seen.push({ method: request.method ?? "", path: request.url ?? "", token: typeof token === "string" ? token : undefined, body });
      if (request.url === "/_rovara/health") { response.writeHead(200).end("{}"); return; }
      // The fork's gate: a control path without the right token is a 403, whatever the method.
      if (request.url?.startsWith("/_rovara/") === true && token !== TOKEN) { response.writeHead(403).end('{"error":"control paths are closed"}'); return; }
      if (handler?.(request, response, body) === true) return;
      if (request.url === "/_rovara/seed" && request.method === "POST") { response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"failed":0,"steps":[]}'); return; }
      if (request.url === "/_rovara/ledger/summary" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }).end('{"s3":{"calls":1,"unsupported":0,"errors":0,"operations":{}}}'); return; }
      response.writeHead(200).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, seen };
}

describe("a request with no token (all a sandbox can send) is refused; the worker's call, with the run's token, is answered", () => {
  it("every control path and method answers false for the sandbox's request, and the open health path still answers", async () => {
    const { port, seen } = await emulator();
    for (const [method, path] of [["GET", "/_rovara/ledger/summary"], ["POST", "/_rovara/seed"], ["POST", "/_rovara/reset"], ["GET", "/_rovara/ledger"], ["GET", "/_rovara/tick"]] as const) {
      // What a sandbox's program can do: a plain request (the probe's own GET is the closest this module has), with no token or a guess.
      expect(await probeService({ host: "127.0.0.1", port, path }), `${method} ${path}`).toBe(false);
      expect(await probeService({ host: "127.0.0.1", port, path, control: { token: "guessguessguess1", method } }), `${method} ${path} guess`).toBe(false);
    }
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/health" })).toBe(true);
    expect(seen.filter((entry) => entry.token === TOKEN)).toHaveLength(0);
  });
  it("the worker's control call sends the token as a header, a GET with no body and a POST with its body, and hands back the answer", async () => {
    const { port, seen } = await emulator();
    let printed = "";
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/ledger/summary", control: { token: TOKEN, method: "GET", onBody: (text) => { printed = text; } } })).toBe(true);
    expect(JSON.parse(printed)).toHaveProperty("s3");
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/_rovara/ledger/summary", token: TOKEN, body: "" });
    let answer = "";
    const body = Buffer.from(JSON.stringify({ region: "us-east-1", s3: { buckets: [{ name: "orders-archive" }] } }));
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", control: { token: TOKEN, method: "POST", body, onBody: (text) => { answer = text; } } })).toBe(true);
    expect(JSON.parse(answer)).toMatchObject({ ok: true });
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/_rovara/seed", token: TOKEN, body: body.toString() });
  });
  it("a non-2xx answer (a 422 seed report, a 403, a 500) is false and prints nothing", async () => {
    for (const status of [403, 422, 500]) {
      const { port } = await emulator((_request, response) => { response.writeHead(status).end('{"ok":false,"steps":[{"error":"secret detail"}]}'); return true; });
      let printed = "";
      expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", control: { token: TOKEN, method: "POST", body: Buffer.from("{}"), onBody: (text) => { printed = text; } } }), String(status)).toBe(false);
      expect(printed).toBe("");
    }
  });
  it("an answer past the limit fails the call (never a truncated answer that looks whole)", async () => {
    const { port } = await emulator((_request, response) => { response.writeHead(200).end("x".repeat(CONTROL_ANSWER_MAX_BYTES + 1)); return true; });
    let printed = "";
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/ledger/summary", control: { token: TOKEN, method: "GET", onBody: (text) => { printed = text; } } })).toBe(false);
    expect(printed).toBe("");
  });
  it("a hard wall-clock limit ends a server that never answers", async () => {
    const { port } = await emulator(() => true);
    const started = Date.now();
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/ledger/summary", timeoutMs: 300, control: { token: TOKEN, method: "GET", onBody: () => undefined } })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it("refuses locally, without a connection: a token that is not plain, a GET with a body, a control call combined with --post, a body past the limit, a host that is not an IPv4 address", async () => {
    const { port, seen } = await emulator();
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", control: { token: "bad token", method: "POST" } })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", control: { token: TOKEN, method: "GET", body: Buffer.from("{}") } })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", post: { token: TOKEN }, control: { token: TOKEN, method: "POST" } })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/seed", control: { token: TOKEN, method: "POST", body: Buffer.alloc(256 * 1024 + 1) } })).toBe(false);
    expect(await probeService({ host: "localhost", port, path: "/_rovara/seed", control: { token: TOKEN, method: "POST" } })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port, control: { token: TOKEN, method: "POST" } })).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it("the existing --post reset call is unchanged: a POST with a zero-length body and the token", async () => {
    const { port, seen } = await emulator();
    expect(await probeService({ host: "127.0.0.1", port, path: "/_rovara/reset", post: { token: TOKEN } })).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/_rovara/reset", token: TOKEN, body: "" });
  });
});

describe("the program (probeCli): the token only from the environment, the body only from a file under /rovara", () => {
  it("a GET control call with --print exits 0 and prints the answer; the token came from the environment", async () => {
    const { port, seen } = await emulator();
    const result = await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/ledger/summary", "--control", "get", "--print"], { ROVARA_CONTROL_TOKEN: TOKEN });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty("s3");
    expect(seen.at(-1)?.token).toBe(TOKEN);
  });
  it("without --print nothing is printed, and with no token in the environment (a sandbox's environment) the call fails", async () => {
    const { port } = await emulator();
    const argv = ["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/ledger/summary", "--control", "GET"];
    expect(await probeCli(argv, { ROVARA_CONTROL_TOKEN: TOKEN })).toEqual({ exitCode: 0, stdout: "" });
    expect(await probeCli([...argv, "--print"], {})).toEqual({ exitCode: 1, stdout: "" });
    expect(await probeCli([...argv, "--print"], { ROVARA_CONTROL_TOKEN: "x" })).toEqual({ exitCode: 1, stdout: "" });
  });
  it("a token given as an argument is ignored (there is no such option): the call fails when the environment has none", async () => {
    const { port, seen } = await emulator();
    const result = await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/ledger/summary", "--control", "GET", "--token", TOKEN, "--print"], {});
    expect(result.exitCode).toBe(1);
    expect(seen.every((entry) => entry.token !== TOKEN)).toBe(true);
  });
  it("a POST reads its body from the mounted file and sends exactly that; a body path outside /rovara, a bad method and a bad timeout exit 1 without a connection", async () => {
    const { port, seen } = await emulator();
    const reads: string[] = [];
    const readBody = (path: string): Buffer => { reads.push(path); return Buffer.from('{"region":"us-east-1"}'); };
    const argv = ["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/seed", "--control", "POST", "--print"];
    expect((await probeCli([...argv, "--body-file", "/rovara/body.json"], { ROVARA_CONTROL_TOKEN: TOKEN }, readBody)).exitCode).toBe(0);
    expect(reads).toEqual(["/rovara/body.json"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: '{"region":"us-east-1"}', token: TOKEN });
    const before = seen.length;
    for (const bad of [["--body-file", "/etc/passwd"], ["--body-file", "/rovara/../etc/passwd"], ["--body-file", "relative.json"], ["--timeout-ms", "5"], ["--timeout-ms", "999999"], ["--timeout-ms", "abc"]]) {
      expect((await probeCli([...argv, ...bad], { ROVARA_CONTROL_TOKEN: TOKEN }, readBody)).exitCode, bad.join(" ")).toBe(1);
    }
    expect((await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/seed", "--control", "DELETE"], { ROVARA_CONTROL_TOKEN: TOKEN }, readBody)).exitCode).toBe(1);
    expect(seen).toHaveLength(before);
    expect(reads).toEqual(["/rovara/body.json"]);
    // A body file that cannot be read is a failure, not an empty body.
    expect((await probeCli([...argv, "--body-file", "/rovara/body.json"], { ROVARA_CONTROL_TOKEN: TOKEN }, () => { throw new Error("ENOENT"); })).exitCode).toBe(1);
  });
  it("the health question and --post behave as before", async () => {
    const { port } = await emulator();
    expect((await probeCli(["--host", "127.0.0.1", "--port", String(port)], {})).exitCode).toBe(0);
    expect((await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/health"], {})).exitCode).toBe(0);
    expect((await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/reset", "--post"], { ROVARA_CONTROL_TOKEN: TOKEN })).exitCode).toBe(0);
    expect((await probeCli(["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/reset", "--post"], {})).exitCode).toBe(1);
    expect((await probeCli([], {})).exitCode).toBe(1);
  });
});
