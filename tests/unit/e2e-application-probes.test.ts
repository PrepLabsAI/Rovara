import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createE2EApplicationRuntimeProbeManifest } from "../../packages/verifier/src/application-runtime-probes.js";

const digest = "b".repeat(64);
const names = (items: readonly { probeId: string }[]) => items.map(({ probeId }) => probeId).sort();
describe("installed application runtime probes", () => {
  it("selects the fixed web positive and negative probes and binds their installed assets", () => {
    const manifest = createE2EApplicationRuntimeProbeManifest({ kind: "web", capabilities: ["web", "download", "auth-refusal", "network-denial"], installedManifestDigest: digest });
    expect(names(manifest.positiveProbes)).toEqual(["web-auth-viewer-refusal/v1", "web-csv-positive/v1"]);
    expect(names(manifest.negativeProbes)).toEqual(["web-csv-negative/v1", "web-egress-denial/v1"]);
    expect(manifest.installedManifestDigest).toBe(digest);
    expect(manifest.positiveProbes.every((probe) => /^[a-f0-9]{64}$/.test(probe.assetDigest))).toBe(true);
    expect(manifest.positiveProbes.find((probe) => probe.probeId === "web-csv-positive/v1")?.oracle).toMatchObject({
      kind: "csv", downloadName: "orders.csv", rows: [["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]],
    });
    expect(manifest.negativeProbes.find((probe) => probe.probeId === "web-egress-denial/v1")?.oracle.kind).toBe("protected-network-denial");
  });

  it("keeps API probes distinct and rejects capabilities outside the matching host profile", () => {
    const manifest = createE2EApplicationRuntimeProbeManifest({ kind: "api", capabilities: ["http", "auth-refusal", "state-read", "tenant-refusal", "network-denial"], installedManifestDigest: digest });
    expect(names(manifest.positiveProbes)).toEqual(["api-auth-viewer-refusal/v1", "api-state-positive/v1"]);
    expect(names(manifest.negativeProbes)).toEqual(["api-egress-denial/v1", "api-tenant-negative/v1"]);
    expect(manifest.positiveProbes.find((probe) => probe.probeId === "api-state-positive/v1")?.oracle).toMatchObject({ kind: "json-state", path: "/api/orders/state", expected: { version: 1 } });
    expect(() => createE2EApplicationRuntimeProbeManifest({ kind: "api", capabilities: ["web", "download"], installedManifestDigest: digest })).toThrow();
  });
});

describe("source fixture auth and causal behaviors", () => {
  const serverUrl = new URL("../../tests/fixtures/e2e-web-api-app/server.mjs", import.meta.url).href;
  const ordersPath = fileURLToPath(new URL("../../tests/fixtures/e2e-web-api-app/fixtures/orders.json", import.meta.url));
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
  const passwordDigest = (password: string) => createHash("sha256").update(password).digest("hex");
  const seed = { accounts: [
    { email: "owner@example.test", passwordDigest: passwordDigest("owner-pass"), subjectId: "owner-a", tenantId: "tenant-a", role: "owner", displayName: "Owner" },
    { email: "viewer@example.test", passwordDigest: passwordDigest("viewer-pass"), subjectId: "viewer-a", tenantId: "tenant-a", role: "viewer", displayName: "Viewer" },
    { email: "other@example.test", passwordDigest: passwordDigest("other-pass"), subjectId: "other-b", tenantId: "tenant-b", role: "owner", displayName: "Other" },
  ] };
  async function application(defect: unknown = null, fetchDependency: (ref: string, path: string) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: { healthy: true } })) {
    const { createOrdersApplication } = await import(serverUrl) as { createOrdersApplication: (input: unknown) => { handle(request: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }>; sessionCount(): number } };
    return createOrdersApplication({ seed, orders: readJson(ordersPath), defect, fetchDependency });
  }
  async function login(app: Awaited<ReturnType<typeof application>>, email: string, password: string) {
    return app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password } });
  }
  const cookie = (result: { headers: Record<string, string> }) => result.headers["set-cookie"]!.split(";")[0];

  it("authenticates distinct owner/viewer sessions and applies server-side role and tenant checks", async () => {
    const app = await application();
    const owner = await login(app, "owner@example.test", "owner-pass");
    const viewer = await login(app, "viewer@example.test", "viewer-pass");
    const other = await login(app, "other@example.test", "other-pass");
    expect(owner.status).toBe(200); expect(viewer.status).toBe(200); expect(other.status).toBe(200);
    expect(cookie(owner)).not.toBe(cookie(viewer));
    expect((await app.handle({ method: "GET", url: "/api/me", headers: { cookie: cookie(owner) } })).body).toContain('"role":"owner"');
    expect((await app.handle({ method: "GET", url: "/api/orders.csv", headers: { cookie: cookie(owner) } })).body).toContain("a1,Ada,12.5,ready");
    const csv = await app.handle({ method: "GET", url: "/api/orders.csv", headers: { cookie: cookie(owner) } });
    expect(csv.body).toContain("a2,Grace,23,ready");
    expect(csv.body).not.toContain("b1"); expect(csv.body).not.toContain("a3");
    expect((await app.handle({ method: "GET", url: "/api/orders.csv", headers: { cookie: cookie(viewer) } })).status).toBe(403);
    expect((await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers: { cookie: cookie(owner) } })).status).toBe(403);
    expect((await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers: { cookie: cookie(other) } })).status).toBe(200);
  });

  it("refuses wrong credentials and executes each fixed defect as changed application behavior", async () => {
    const normal = await application();
    expect((await login(normal, "owner@example.test", "wrong-pass")).status).toBe(401);
    const extra = await application({ defectId: "extra-order/v1", mutation: "append-order", order: { id: "a3", tenantId: "tenant-a", customer: "Katherine", total: 31, state: "ready" } });
    const extraOwner = cookie(await login(extra, "owner@example.test", "owner-pass"));
    expect((await extra.handle({ method: "GET", url: "/api/orders.csv", headers: { cookie: extraOwner } })).body).toContain("a3,Katherine,31,ready");
    const viewerDefect = await application({ defectId: "viewer-access/v1", mutation: "allow-viewer-export" });
    const viewerCookie = cookie(await login(viewerDefect, "viewer@example.test", "viewer-pass"));
    expect((await viewerDefect.handle({ method: "GET", url: "/api/orders.csv", headers: { cookie: viewerCookie } })).status).toBe(200);
    const stateDefect = await application({ defectId: "state-contract/v1", mutation: "change-state-version", version: 2 });
    const stateCookie = cookie(await login(stateDefect, "owner@example.test", "owner-pass"));
    expect((await stateDefect.handle({ method: "GET", url: "/api/orders/state", headers: { cookie: stateCookie } })).body).toContain('"version":2');
    let requestedPath = "";
    const dependencyDefect = await application({ defectId: "dependency-route/v1", mutation: "request-wrong-health-path", path: "/internal/admin" }, async (_ref: string, path: string) => { requestedPath = path; return { status: 404, body: {} }; });
    const dependencyCookie = cookie(await login(dependencyDefect, "owner@example.test", "owner-pass"));
    expect((await dependencyDefect.handle({ method: "GET", url: "/api/inventory/status", headers: { cookie: dependencyCookie } })).status).toBe(502);
    expect(requestedPath).toBe("/internal/admin");
  });
});
