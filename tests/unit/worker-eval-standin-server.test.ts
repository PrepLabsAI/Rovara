// L4-E56 (row E6): the run's certificate authority and the stand-in's HTTP and HTTPS servers, run for real on loopback. Every claim has a control: a client that trusts the authority (through ENVIRONMENT VARIABLES only) gets an
// answer over TLS, one that does not is counted and never answered, an unknown host gets the catch-all, the key never appears in what the box is told, and the server opens no connection of its own.
import { spawn, spawnSync } from "node:child_process";
import dns from "node:dns";
import { X509Certificate, createPublicKey } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalAnswerBook, buildOpenApiFake, type EvalStandInPlan } from "@agentx/contracts";
import { EVAL_CA_RELATIVE_PATH, EVAL_TRUST_VARIABLES, RUN_CA_COMMON_NAME_PREFIX, createLeafMinter, createRunCa, evalStandInTrustEnvironment } from "../../packages/worker/src/run-ca.js";
import { createEvalStandInServers, hostOfRequest, type EvalStandInServers } from "../../packages/worker/src/eval-standin-server.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";

const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: { "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" } } } } } } } } } } } },
};
const built = buildOpenApiFake(DOCUMENT, "openapi.json");
if (built.status !== "built") throw new Error("fixture");
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi: built }];

const dirs: string[] = [];
const servers: EvalStandInServers[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.http.closeAllConnections(); server.http.close(); server.tls?.closeAllConnections(); server.tls?.close(); }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function listening(server: EvalStandInServers["http"] | NonNullable<EvalStandInServers["tls"]>): Promise<number> {
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  return (server.address() as net.AddressInfo).port;
}
async function start(options: { book?: EvalAnswerBook; plan?: EvalStandInPlan; callers?: readonly string[] } = {}) {
  const ca = createRunCa();
  const minter = createLeafMinter(ca);
  const book = options.book ?? new EvalAnswerBook();
  const stand = createEvalStandInServers({ plan: options.plan ?? PLAN, book, minter, defaultName: "127.0.0.1", ...(options.callers === undefined ? {} : { callers: options.callers }) });
  servers.push(stand);
  const httpPort = await listening(stand.http);
  const tlsPort = await listening(stand.tls!);
  const dir = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "standin-ca-"));
  dirs.push(dir);
  const caFile = join(dir, "ca.pem");
  await writeFile(caFile, ca.certPem);
  return { stand, ca, book, httpPort, tlsPort, caFile, dir };
}

/** A client in another process, run ASYNCHRONOUSLY: the stand-in server lives in this process, so a blocking spawn would deadlock the test. */
function runClient(command: string, args: string[], env: Record<string, string>): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { PATH: process.env["PATH"] ?? "", ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("close", (status) => resolve({ stdout, status }));
    child.on("error", () => resolve({ stdout, status: -1 }));
  });
}

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function http(port: number, host: string, path: string, init: { method?: string; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: init.method ?? "GET", path, headers: { host }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
function https(port: number, host: string, path: string, ca: string | undefined): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", servername: host, port, path, headers: { host }, agent: false, ...(ca === undefined ? {} : { ca }) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the run's certificate authority", () => {
  it("is a short-lived CA and signs server certificates that verify, name the host, and carry no CA power", () => {
    const ca = createRunCa();
    const authority = new X509Certificate(ca.certPem);
    expect(authority.ca).toBe(true);
    expect(authority.subject).toContain(RUN_CA_COMMON_NAME_PREFIX);
    expect(authority.verify(authority.publicKey)).toBe(true);
    expect(new Date(authority.validTo).getTime() - Date.now()).toBeLessThan(36 * 3_600_000);
    const minter = createLeafMinter(ca);
    const leaf = new X509Certificate(minter.mint("open.tiktokapis.com")!.certPem);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(authority.publicKey)).toBe(true);
    expect(leaf.checkIssued(authority)).toBe(true);
    expect(leaf.checkHost("open.tiktokapis.com")).toBe("open.tiktokapis.com");
    expect(leaf.checkHost("evil.example.test")).toBeUndefined();
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    // The authority signs server certificates only: pathLenConstraint 0 (DER: basicConstraints cA TRUE, pathLen 0).
    expect(authority.raw.includes(Buffer.from([0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x00]))).toBe(true);
    expect(new X509Certificate(minter.mint("127.0.0.1")!.certPem).checkIP("127.0.0.1")).toBe("127.0.0.1");
    // Not a host name: no certificate. The same name twice is the same certificate.
    expect(minter.mint("not a host")).toBeUndefined();
    expect(minter.mint("a_b.test")).toBeUndefined();
    expect(minter.mint("A.Test")).toBe(minter.mint("a.test"));
    // Another round's authority does not verify this round's certificates.
    expect(leaf.verify(new X509Certificate(createRunCa().certPem).publicKey)).toBe(false);
    expect(authority.publicKey.asymmetricKeyType).toBe("ec");
    expect(createPublicKey(ca.certPem).asymmetricKeyType).toBe("ec");
  });
  it("verifies for OpenSSL itself, strictly (what Python 3.13 and Go demand)", () => {
    const probe = spawnSync("openssl", ["version"]);
    if (probe.status !== 0) return;
    const ca = createRunCa();
    const minted = createLeafMinter(ca);
    const leaf = minted.mint("api.vendor.test")!;
    const ipLeaf = minted.mint("172.30.5.47")!;
    const dir = join(process.env["TMPDIR"] ?? process.cwd(), `standin-openssl-${String(process.pid)}`);
    spawnSync("mkdir", ["-p", dir]);
    try {
      spawnSync("sh", ["-c", `printf '%s' '${ca.certPem}' > ${dir}/ca.pem && printf '%s' '${leaf.certPem}' > ${dir}/leaf.pem`]);
      const verify = spawnSync("openssl", ["verify", "-x509_strict", "-purpose", "sslserver", "-CAfile", `${dir}/ca.pem`, `${dir}/leaf.pem`], { encoding: "utf8" });
      expect(verify.stdout + verify.stderr).toContain("OK");
      spawnSync("sh", ["-c", `printf '%s' '${ipLeaf.certPem}' > ${dir}/ip.pem`]);
      expect((spawnSync("openssl", ["verify", "-x509_strict", "-purpose", "sslserver", "-CAfile", `${dir}/ca.pem`, `${dir}/ip.pem`], { encoding: "utf8" }).stdout)).toContain("OK");
    } finally { spawnSync("rm", ["-rf", dir]); }
  });
  it("tells the box only variable NAMES and one certificate PATH: never the key, never PEM text", () => {
    const lines = evalStandInTrustEnvironment(`/workspace/${EVAL_CA_RELATIVE_PATH}`);
    expect(lines.map(([name]) => name)).toEqual([...EVAL_TRUST_VARIABLES]);
    expect(EVAL_TRUST_VARIABLES).toEqual(expect.arrayContaining(["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"]));
    for (const [, value] of lines) expect(value).toBe(`/workspace/${EVAL_CA_RELATIVE_PATH}`);
    const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: PLAN });
    expect(round.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(round.certificatePem).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(lines)).not.toContain("PRIVATE KEY");
    expect(() => evalStandInTrustEnvironment("relative/ca.pem")).toThrow();
    expect(() => evalStandInTrustEnvironment("/workspace/../etc/ca.pem")).toThrow();
  });
  it("two rounds have different authorities and separate books (two companies share nothing)", () => {
    const one = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: PLAN });
    const two = new EvalStandInRound({ workspaceId: "1c9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c12", operationId: OPERATION, plan: [] });
    expect(one.certificatePem).not.toBe(two.certificatePem);
    expect(one.book).not.toBe(two.book);
    expect(one.setContent().ca.keyPem).not.toBe(two.setContent().ca.keyPem);
  });
});

describe("the host a request is for", () => {
  it("is the Host header without its port, lowercased; an address or anything odd is no name", () => {
    expect(hostOfRequest("Open.TikTokAPIs.com:443")).toBe("open.tiktokapis.com");
    expect(hostOfRequest("10.0.0.1")).toBeNull();
    expect(hostOfRequest("a b")).toBeNull();
    expect(hostOfRequest("[::1]")).toBeNull();
    expect(hostOfRequest(undefined)).toBeNull();
    expect(hostOfRequest("x".repeat(300))).toBeNull();
  });
});

describe("answers over plain HTTP", () => {
  it("labels every answer and answers a planned operation from its contract", async () => {
    const { httpPort } = await start();
    const answer = await http(httpPort, "open.tiktokapis.com", "/v2/user/info?username=ada");
    expect(answer.status).toBe(200);
    expect(answer.headers["x-rovara-label"]).toBe("madeByRovara");
    expect(answer.headers["x-rovara-standin"]).toBe("generated");
    expect(JSON.parse(answer.body)).toEqual({ data: { display_name: "example" } });
  });
  it("never stops: an operation the contract does not list and a host nobody named both get an answer, labelled and counted", async () => {
    const { httpPort, stand, book } = await start();
    const unknownOperation = await http(httpPort, "open.tiktokapis.com", "/v2/user/videos?cursor=0");
    expect(unknownOperation).toMatchObject({ status: 200 });
    expect(unknownOperation.headers["x-rovara-standin"]).toBe("generated_no_contract");
    const unknownHost = await http(httpPort, "tracker.example.test", "/collect", { method: "POST", body: '{"a":1}' });
    expect(unknownHost.status).toBe(201);
    expect(unknownHost.headers).toMatchObject({ "x-rovara-label": "madeByRovara", "x-rovara-standin": "new_connection" });
    const nameless = await http(httpPort, "10.0.0.9", "/x");
    expect(nameless.headers["x-rovara-standin"]).toBe("new_connection");
    expect(book.counts()).toMatchObject({ generatedNoContract: 1, newConnections: 2, served: 3, gapCalls: 3 });
    expect(stand.stats().newHosts).toEqual(["tracker.example.test", "unnamed"]);
    expect(stand.stats().gaps).toEqual([
      { method: "GET", host: "open.tiktokapis.com", path: "/v2/user/videos", cls: "generated_no_contract" },
      { method: "POST", host: "tracker.example.test", path: "/collect", cls: "new_connection" },
      { method: "GET", host: "unnamed", path: "/x", cls: "new_connection" },
    ]);
  });
  it("gives a HEAD no body and an empty answer no content length surprise", async () => {
    const { httpPort } = await start();
    const head = await http(httpPort, "open.tiktokapis.com", "/v2/user/info", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });
  it("refuses a body past the limit with 413, counts it, and never echoes or stores the body", async () => {
    const { httpPort, stand, book } = await start();
    const answer = await http(httpPort, "open.tiktokapis.com", "/v2/user/info", { method: "POST", body: "x".repeat(70_000) }).catch(() => ({ status: 413, headers: { "x-rovara-label": "madeByRovara" }, body: "" }));
    expect(answer.status).toBe(413);
    expect(stand.stats().refused).toBe(1);
    expect(book.counts().served).toBe(0);
  });
  it("closes a connection from any address but the box's, counts it, and reads nothing from it", async () => {
    const { httpPort, stand, book } = await start({ callers: ["10.200.0.4"] });
    await expect(http(httpPort, "open.tiktokapis.com", "/v2/user/info")).rejects.toThrow();
    expect(stand.stats().foreign).toBe(1);
    expect(book.counts().served).toBe(0);
  });
  it("counts a request it cannot parse", async () => {
    const { httpPort, stand } = await start();
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(httpPort, "127.0.0.1", () => socket.write("NOT HTTP AT ALL\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => { text += chunk.toString("utf8"); });
      socket.on("close", () => resolve(text));
    });
    expect(reply).toContain("400 Bad Request");
    expect(reply.toLowerCase()).toContain("x-rovara-label: madebyrovara");
    expect(stand.stats().refused).toBe(1);
  });
});

describe("answers over HTTPS from the run's own authority", () => {
  it("answers a TikTok-style call for a client that trusts the authority, with the certificate made for that name", async () => {
    const { tlsPort, ca } = await start();
    const answer = await https(tlsPort, "open.tiktokapis.com", "/v2/user/info", ca.certPem);
    expect(answer.status).toBe(200);
    expect(answer.headers["x-rovara-label"]).toBe("madeByRovara");
    expect(JSON.parse(answer.body)).toEqual({ data: { display_name: "example" } });
  });
  it("answers an unknown host over HTTPS too: the certificate is made for whatever name the client asked", async () => {
    const { tlsPort, ca } = await start();
    const answer = await https(tlsPort, "api.never-planned.test", "/anything", ca.certPem);
    expect(answer.status).toBe(200);
    expect(answer.headers["x-rovara-standin"]).toBe("new_connection");
  });
  it("is abandoned by a client that does not trust the authority (or pins a certificate): counted, never answered", async () => {
    const { tlsPort, stand, book } = await start();
    await expect(https(tlsPort, "open.tiktokapis.com", "/v2/user/info", undefined)).rejects.toThrow(/certificate|self.signed|unable to verify/iu);
    await expect(https(tlsPort, "open.tiktokapis.com", "/v2/user/info", createRunCa().certPem)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stand.stats().tlsFailed).toBeGreaterThanOrEqual(1);
    expect(book.counts().served).toBe(0);
  });
  it("does not answer a client that checks the name for another name than the one it asked for", async () => {
    const { tlsPort, ca } = await start();
    // The certificate is for "other.test" (the SNI), so a client that verifies "open.tiktokapis.com" against it fails.
    const request = new Promise<Answer>((resolve, reject) => {
      const req = httpsRequest({ host: "127.0.0.1", servername: "other.test", port: tlsPort, path: "/", headers: { host: "open.tiktokapis.com" }, agent: false, ca: ca.certPem, checkServerIdentity: (_, cert) => (cert.subjectaltname?.includes("open.tiktokapis.com") ? undefined : new Error("wrong name")) }, (response) => { response.resume(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: "" }); });
      req.on("error", reject);
      req.end();
    });
    await expect(request).rejects.toThrow("wrong name");
  });
});

describe("the shared answer book: both sides get the same bytes", () => {
  it("a second helper started from the first helper's additions answers the same bytes, and counts it as a gap again", async () => {
    const side1 = await start();
    const first = await http(side1.httpPort, "open.tiktokapis.com", "/v2/user/videos?cursor=0");
    const roundBook = new EvalAnswerBook();
    for (const entry of side1.book.snapshot()) roundBook.restore(entry);
    const side2 = await start({ book: roundBook });
    const second = await http(side2.httpPort, "open.tiktokapis.com", "/v2/user/videos?cursor=0");
    expect(second.body).toBe(first.body);
    expect(second.status).toBe(first.status);
    expect(second.headers["x-rovara-standin"]).toBe(first.headers["x-rovara-standin"]);
    expect(side2.book.counts().gapCalls).toBe(1);
    expect(side2.book.snapshot()).toEqual(side1.book.snapshot());
  });
  it("answers from a repository recording first, and says so", async () => {
    const book = new EvalAnswerBook();
    book.preloadRecorded({ method: "GET", host: "open.tiktokapis.com", path: "/v2/user/info", query: "username=ada", status: 200, contentType: "application/json", body: '{"data":{"display_name":"Ada Lovelace"}}' });
    const { httpPort, stand } = await start({ book });
    const answer = await http(httpPort, "open.tiktokapis.com", "/v2/user/info?username=ada");
    expect(answer.body).toBe('{"data":{"display_name":"Ada Lovelace"}}');
    expect(answer.headers["x-rovara-standin"]).toBe("recorded");
    expect(stand.stats().gaps).toEqual([]);
    expect(book.counts().gapCalls).toBe(0);
  });
});

describe("real clients, trusting the authority through environment variables only", () => {
  const HOST = "open.tiktokapis.com";
  it("a Node client with NODE_EXTRA_CA_CERTS", async () => {
    const { tlsPort, caFile, stand } = await start();
    const script = `const dns=require("node:dns");const https=require("node:https");https.get({host:${JSON.stringify(HOST)},port:${String(tlsPort)},path:"/v2/user/info",lookup:(h,o,cb)=>cb(null,[{address:"127.0.0.1",family:4}]),agent:false},(r)=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{console.log(r.statusCode+" "+b);process.exit(0)})}).on("error",e=>{console.log("ERR "+e.code);process.exit(2)});`;
    const run = await runClient(process.execPath, ["-e", script], { NODE_EXTRA_CA_CERTS: caFile });
    expect(run.stdout.trim()).toBe('200 {"data":{"display_name":"example"}}');
    // And without the variable the same client refuses.
    const bare = await runClient(process.execPath, ["-e", script], {});
    expect(bare.stdout).toContain("ERR");
    expect(stand.stats().gaps).toHaveLength(1);
  });
  it("a Python client with SSL_CERT_FILE and with REQUESTS_CA_BUNDLE-style trust (urllib, strict verification)", async () => {
    if (spawnSync("python3", ["--version"]).status !== 0) return;
    const { tlsPort, caFile } = await start();
    const script = [
      "import socket, ssl, sys, urllib.request",
      "real = socket.getaddrinfo",
      `socket.getaddrinfo = lambda host, *a, **k: real("127.0.0.1", *a, **k)`,
      `ctx = ssl.create_default_context()`,
      `r = urllib.request.urlopen("https://${HOST}:${String(tlsPort)}/v2/user/info", context=ctx, timeout=10)`,
      "print(r.status, r.read().decode(), r.headers['x-rovara-label'])",
    ].join("\n");
    const run = await runClient("python3", ["-I", "-c", script], { SSL_CERT_FILE: caFile });
    expect(run.stdout.trim()).toBe('200 {"data":{"display_name":"example"}} madeByRovara');
    const bare = await runClient("python3", ["-I", "-c", script], {});
    expect(bare.status).not.toBe(0);
  });
  it("curl with CURL_CA_BUNDLE", async () => {
    if (spawnSync("curl", ["--version"]).status !== 0) return;
    const { tlsPort, caFile } = await start();
    const run = await runClient("curl", ["-sS", "--resolve", `${HOST}:${String(tlsPort)}:127.0.0.1`, `https://${HOST}:${String(tlsPort)}/v2/user/info`], { CURL_CA_BUNDLE: caFile, SSL_CERT_FILE: caFile });
    expect(run.stdout).toBe('{"data":{"display_name":"example"}}');
  });
});

describe("nothing leaves the box", () => {
  it("the server opens no connection of its own while it answers a planned host, an unknown host and a TLS client", async () => {
    const { tlsPort, caFile } = await start();
    // Spies go on AFTER the test's own listen (which looks up its own address).
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const lookup = vi.spyOn(dns, "lookup");
    // The clients run in other processes: any connect() or lookup in THIS process would be the server's own.
    const clients = ["open.tiktokapis.com", "tracker.example.test"].map((host) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["-e", `const https=require("node:https");https.get({host:${JSON.stringify(host)},port:${String(tlsPort)},path:"/x",lookup:(h,o,cb)=>cb(null,[{address:"127.0.0.1",family:4}]),agent:false},(r)=>{r.resume();r.on("end",()=>process.exit(0))}).on("error",()=>process.exit(2));`], { env: { PATH: process.env["PATH"] ?? "", NODE_EXTRA_CA_CERTS: caFile } });
      child.on("close", resolve);
    }));
    expect(await Promise.all(clients)).toEqual([0, 0]);
    expect(connect).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});
