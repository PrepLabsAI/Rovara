import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedIdentity, BrokerRequest } from "@agentx/broker";
import type { Operation } from "@agentx/contracts";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";
import { createLocalBrokerHandler } from "../src/routes.js";
import { startLoopbackListener } from "../src/listener.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Disposable trust material for this test run only.
 *
 * Generated into a temporary directory and deleted afterwards. No key is committed, and
 * nothing here touches the system trust store: the client is pointed at this certificate
 * explicitly rather than the certificate being made globally trusted.
 */
async function disposableTls(directory: string): Promise<{ cert: string; key: string }> {
  const certPath = join(directory, "loopback-cert.pem");
  const keyPath = join(directory, "loopback-key.pem");
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ]);
  return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8") };
}


/**
 * One HTTPS call that trusts exactly the certificate it is given.
 *
 * Built on `node:https` rather than a new dependency, and `ca` is passed per request so
 * trust stays scoped to this client instead of the machine.
 */
function call(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; ca?: string },
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const requestOptions: RequestOptions = {
    method: options.method ?? "GET",
    host: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    headers: options.headers ?? {},
    ...(options.ca === undefined ? {} : { ca: options.ca, servername: "127.0.0.1" }),
  };
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(requestOptions, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () =>
        resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    outgoing.once("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

const identity: AuthenticatedIdentity = {
  issuer: "https://identity.example.test",
  subject: "alice",
  ownerKey: "alice".padEnd(64, "0"),
  isAdministrator: true,
  claims: {},
};

async function host() {
  const root = await mkdtemp(join(tmpdir(), "agentx-host-tls-"));
  roots.push(root);
  const database = openHostDatabase(join(root, "host.sqlite"));
  const registry = new SqliteRegistry(database);
  const operations = new SqliteOperationStore(database, registry);
  const memberships = [{ ownerKey: identity.ownerKey, project: "payments", role: "administrator" as const }];
  const timestamp = new Date().toISOString();
  const workspace = await registry.createDefault({
    id: randomUUID(), ownerKey: identity.ownerKey, projectName: "payments", projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT", runtimeSessionId: randomUUID(), deploymentMode: "demo-microvm",
    rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1,
    createdAt: timestamp, updatedAt: timestamp,
  });
  const conversationId = registry.createConversation(workspace.id, randomUUID());
  const handler = createLocalBrokerHandler({
    registry, operations, memberships, callbackSigningKey: randomBytes(32),
    resolveIdentity: async (request: BrokerRequest) => {
      if (request.headers["x-fixture-actor"] === "mallory") {
        return { ...identity, subject: "mallory", ownerKey: "mallory".padEnd(64, "0") };
      }
      return identity;
    },
  });
  const tls = await disposableTls(root);
  const listener = await startLoopbackListener({ handler, tls });
  return { database, registry, operations, workspace, conversationId, listener, tls };
}

describe("loopback TLS listener", () => {
  it("serves the host over https on loopback and carries a real task through it", async () => {
    const h = await host();
    try {
      expect(h.listener.url.startsWith("https://127.0.0.1:")).toBe(true);

      const requestId = randomUUID();
      // The client trusts exactly this certificate; the system trust store is untouched.
      const accepted = await call(`${h.listener.url}/v1/workspaces/${h.workspace.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, conversationId: h.conversationId, prompt: "Add a check" }),
        ca: h.tls.cert,
      });
      expect(accepted.status).toBe(202);
      const operation = (JSON.parse(accepted.body) as { operation: Operation }).operation;

      const recovered = await call(
        `${h.listener.url}/v1/workspaces/${h.workspace.id}/requests/${requestId}`,
        { ca: h.tls.cert },
      );
      expect(recovered.status).toBe(200);
      expect((JSON.parse(recovered.body) as { operation: Operation }).operation.id).toBe(operation.id);
    } finally {
      await h.listener.close();
      h.database.close();
    }
  });

  it("refuses a client that does not trust its certificate", async () => {
    const h = await host();
    try {
      // No `ca`, so the default trust store is used. It must not contain this
      // certificate, which is what "process-scoped trust" has to mean.
      await expect(call(`${h.listener.url}/v1/projects/payments/workspace`, {})).rejects.toThrow(
        /self-signed certificate|unable to verify/i,
      );
    } finally {
      await h.listener.close();
      h.database.close();
    }
  });

  it("still applies ownership over the transport", async () => {
    const h = await host();
    try {
      const response = await call(`${h.listener.url}/v1/projects/payments/workspace`, {
        headers: { "x-fixture-actor": "mallory" },
        ca: h.tls.cert,
      });
      expect(response.status).toBe(404);
    } finally {
      await h.listener.close();
      h.database.close();
    }
  });
});
