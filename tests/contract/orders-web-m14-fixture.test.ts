import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EApiMockFixtureSchema } from "../../packages/contracts/src/e2e.js";
import { E2EApplicationProjectContractSchema } from "../../packages/contracts/src/e2e-application-accounts.js";
import { createE2EOpenApiFixtureDescriptor, validateE2EOpenApiFixtureResponse } from "../../packages/contracts/src/e2e-openapi-fixture.js";
import {
  FIXTURE_VARIANTS,
  parsePublishArguments,
  renderFixtureVariant,
  run,
} from "../../scripts/fixtures/publish-web-fixture.js";

const repositoryRoot = join(import.meta.dirname, "../..");
const LOCAL = "tests/fixtures/orders-web-m14";
const localDirectory = join(repositoryRoot, LOCAL);
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const readLocal = (path: string): string => readFileSync(join(localDirectory, path), "utf8");

/** Every file of the fixture directory as a relative POSIX path to its text, skipping local-only directories. */
function fixtureFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".owned" || entry === ".DS_Store") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(directory, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(directory);
  return files;
}

function writeTree(files: ReadonlyMap<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "orders-m14-"));
  temporary.push(directory);
  for (const [path, text] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

/** Distinctive fixture account addresses: none of their local parts can be an ordinary page word that redaction would hit. */
const OWNER_A = "kzr41@orders-fixture.test";
const VIEWER_A = "mvd58@orders-fixture.test";
const OWNER_B = "jxp23@orders-fixture.test";
const seed = {
  accounts: [
    { email: OWNER_A, passwordDigest: digest("pw-owner-a"), subjectId: "subject-a-1", tenantId: "tenant-a", role: "owner", displayName: "Rovara orders-owner" },
    { email: VIEWER_A, passwordDigest: digest("pw-viewer-a"), subjectId: "subject-a-2", tenantId: "tenant-a", role: "viewer", displayName: "Rovara orders-viewer" },
    { email: OWNER_B, passwordDigest: digest("pw-owner-b"), subjectId: "subject-b-1", tenantId: "tenant-b", role: "owner", displayName: "Rovara orders-owner-b" },
  ],
};
const passwords: Record<string, string> = { [OWNER_A]: "pw-owner-a", [VIEWER_A]: "pw-viewer-a", [OWNER_B]: "pw-owner-b" };

interface Reply { status: number; headers: Record<string, string>; body: string }
interface Application { handle: (request: { method: string; url: string; headers: Record<string, string>; body?: unknown }) => Promise<Reply> }
type Dependency = (originRef: string, path: string) => Promise<{ status: number; body: unknown }>;
async function loadServer(directory: string): Promise<{ createOrdersApplication: (input: { seed: unknown; orders: unknown; fetchDependency?: Dependency }) => Application }> {
  return await import(pathToFileURL(join(directory, "server.mjs")).href) as never;
}
const orders = (): unknown => JSON.parse(readLocal("fixtures/orders.json"));

/** The inventory-v1 mock as the executor serves it: exact method and path, the variant chosen by the orderId query. */
const inventory: Dependency = async (originRef, path) => {
  if (originRef !== "inventory-v1") return { status: 599, body: {} };
  const url = new URL(path, "http://inventory.invalid");
  if (url.pathname === "/health") return { status: 200, body: { healthy: true } };
  if (url.pathname !== "/v1/stock") return { status: 599, body: {} };
  const orderId = url.searchParams.get("orderId");
  if (orderId === "a1") return { status: 200, body: { status: "in-stock" } };
  if (orderId === "a2") return { status: 404, body: { error: "unknown order" } };
  if (orderId === "b1") return { status: 200, body: { status: 7 } };
  return { status: 599, body: {} };
};

async function signIn(app: Application, email: string): Promise<Record<string, string>> {
  const response = await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password: passwords[email] } });
  expect(response.status).toBe(200);
  return { cookie: String(response.headers["set-cookie"]).split(";")[0]! };
}

describe("local Linux fixture (orders-web-m14)", () => {
  it("declares a parsable project contract with a matching recipe digest and three accounts in two tenants", () => {
    const manifest = JSON.parse(readLocal("package.json")) as { agentx: { e2e: unknown } };
    const contract = E2EApplicationProjectContractSchema.parse(manifest.agentx.e2e);
    const { recipeDigest, ...body } = contract.recipe;
    expect(createHash("sha256").update(canonicalJson(body)).digest("hex")).toBe(recipeDigest);
    expect(contract.accountProfiles.map((profile) => [profile.profileId, profile.tenantRef, profile.roleRef])).toEqual([
      ["orders-owner", "tenant-a", "owner"], ["orders-viewer", "tenant-a", "viewer"], ["orders-owner-b", "tenant-b", "owner"],
    ]);
    expect(contract.recipe.allowedOrigins).toEqual(["orders-api", "inventory-v1"]);
    expect(contract.service?.originBindings).toEqual([
      { originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }, { originRef: "inventory-v1", envName: "INVENTORY_ORIGIN" },
    ]);
    for (const baseTargetId of ["web-1", "api-1"]) {
      for (const profileId of ["orders-owner", "orders-viewer", "orders-owner-b"]) {
        expect(contract.targetAccounts).toContainEqual({ baseTargetId, profileId });
      }
    }
  });

  it("renames the export button and adds the invoices decoy", () => {
    const html = readLocal("public/index.html");
    expect(html).toMatch(/<button[^>]*data-testid="download-orders"[^>]*>Download orders<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="download-invoices"[^>]*>Download invoices<\/button>/);
    expect(html).not.toContain("export-csv");
    expect(html).not.toContain("Export CSV");
    expect(html).toContain('data-testid="orders-table"');
  });

  it("downloads the orders CSV for an owner, with the inventory column and tenant isolation", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const owner = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) });
    expect(owner.status).toBe(200);
    expect(owner.headers["content-type"]).toContain("text/csv");
    expect(owner.headers["content-disposition"]).toContain("orders.csv");
    expect(owner.body).toBe("id,customer,total,state,inventory\r\na1,Ada,12.5,ready,in-stock\r\na2,Grace,23,ready,unavailable\r\n");
    const other = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_B) });
    expect(other.body).toBe("id,customer,total,state,inventory\r\nb1,Lin,99,ready,unavailable\r\n");
    expect(other.body).not.toContain("a1");
  });

  it("downloads a different CSV from the decoy", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const headers = await signIn(app, OWNER_A);
    const invoices = await app.handle({ method: "GET", url: "/api/invoices.csv", headers });
    expect(invoices.status).toBe(200);
    expect(invoices.headers["content-disposition"]).toContain("invoices.csv");
    expect(invoices.body).toBe("invoice,customer,amount,status\r\ninv-a1,Ada,12.5,paid\r\ninv-a2,Grace,23,paid\r\n");
    const ordersCsv = await app.handle({ method: "GET", url: "/api/orders.csv", headers });
    expect(invoices.body).not.toBe(ordersCsv.body);
  });

  it("refuses the viewer on both exports and anonymous requests", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const viewer = await signIn(app, VIEWER_A);
    for (const url of ["/api/orders.csv", "/api/invoices.csv"]) {
      expect((await app.handle({ method: "GET", url, headers: viewer })).status).toBe(403);
      expect((await app.handle({ method: "GET", url, headers: {} })).status).toBe(401);
    }
  });

  it("lists a tenant's orders with the inventory status and refuses another tenant", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const headers = await signIn(app, VIEWER_A);
    const own = await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers });
    expect((JSON.parse(own.body) as { orders: Array<{ id: string; inventory: string }> }).orders.map((row) => [row.id, row.inventory]))
      .toEqual([["a1", "in-stock"], ["a2", "unavailable"]]);
    expect((await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers })).status).toBe(403);
  });

  it("neutralizes spreadsheet formulas in CSV cells and still quotes separators", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const hostile = { orders: [
      { id: "a1", tenantId: "tenant-a", customer: "=HYPERLINK(\"http://x\")", total: 1, state: "ready", placedOn: "2026-09-01" },
      { id: "a2", tenantId: "tenant-a", customer: "Doe, Jane", total: 2, state: "ready", placedOn: "2026-09-02" },
    ], state: { orders: "ready", version: 1 } };
    const app = createOrdersApplication({ seed, orders: hostile, fetchDependency: inventory });
    const csv = (await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) })).body;
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csv).toContain('"Doe, Jane"');
  });

  it("filters the orders CSV by from and to and refuses other queries", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const headers = await signIn(app, OWNER_A);
    const ranged = await app.handle({ method: "GET", url: "/api/orders.csv?from=2026-09-02&to=2026-09-02", headers });
    expect(ranged.body).toBe("id,customer,total,state,inventory\r\na2,Grace,23,ready,unavailable\r\n");
    expect((await app.handle({ method: "GET", url: "/api/orders.csv?from=nope", headers })).status).toBe(400);
    expect((await app.handle({ method: "GET", url: "/api/orders.csv?tenant=tenant-b", headers })).status).toBe(400);
    expect((await app.handle({ method: "GET", url: "/api/me?x=1", headers })).status).toBe(400);
  });

  it("never puts a signed-in account email into page text or API bodies", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    const headers = await signIn(app, OWNER_A);
    const bodies: string[] = [];
    for (const url of ["/", "/app.js", "/api/me", "/api/orders/state", "/api/tenants/tenant-a/orders", "/api/inventory/status", "/api/orders.csv", "/api/invoices.csv"]) {
      bodies.push((await app.handle({ method: "GET", url, headers })).body);
    }
    for (const body of bodies) {
      for (const email of [OWNER_A, VIEWER_A, OWNER_B]) {
        expect(body).not.toContain(email);
        expect(body).not.toContain(email.split("@")[0]!);
      }
    }
    expect(readLocal("public/app.js")).not.toMatch(/textContent\s*=[^;]*email/i);
  });

  it("uses account addresses with distinctive local parts, never a common word", () => {
    for (const email of [OWNER_A, VIEWER_A, OWNER_B]) {
      const local = email.split("@")[0]!;
      expect(local.length).toBeGreaterThanOrEqual(5);
      expect(local).toMatch(/\d/);
    }
    const common = /(?<![a-z0-9])(?:test|owner|viewer|admin|user|demo|info|orders|account|me)@/i;
    for (const [path, text] of fixtureFiles(localDirectory)) expect(text, path).not.toMatch(common);
  });

  it("keeps an inventory contract and a mock that validate against it", () => {
    const openapi = readFileSync(join(localDirectory, "inventory/openapi.json"));
    const descriptor = createE2EOpenApiFixtureDescriptor(new Uint8Array(openapi));
    expect(descriptor).toBeDefined();
    expect(descriptor!.operations.map((operation) => [operation.method, operation.path])).toEqual([["GET", "/v1/stock"]]);
    const mock = E2EApiMockFixtureSchema.parse(JSON.parse(readLocal("e2e/mocks/inventory-v1.json")));
    expect(mock.path).toBe("/v1/stock");
    expect(mock.inputField).toBe("orderId");
    const valid = (id: string): boolean => {
      const variant = mock.variants.find((item) => item.id === id)!;
      return validateE2EOpenApiFixtureResponse({ descriptor: descriptor!, method: "GET", path: mock.path, status: variant.status, body: variant.body });
    };
    expect(mock.variants.map((variant) => [variant.id, variant.inputValue, variant.status])).toEqual([["success", "a1", 200], ["refusal", "a2", 404], ["invalid-data", "b1", 200]]);
    expect(valid("success")).toBe(true);
    expect(valid("refusal")).toBe(true);
    expect(valid("invalid-data")).toBe(false);
  });

  it("describes both the local fixture and the live baseline in the README and keeps the node --test CI", () => {
    const readme = readLocal("README.md");
    expect(readme).toMatch(/live baseline/i);
    expect(readme).toMatch(/local Linux fixture/i);
    expect(readme).toContain("download-orders");
    expect(readme).toContain("export-csv");
    expect(readLocal(".github/workflows/ci.yml")).toContain("node --test");
  });

  it("passes its own node --test suite", () => {
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: localDirectory, stdio: "pipe" })).not.toThrow();
  });
});

describe("live baseline (--variant m14)", () => {
  const rendered = (): Map<string, string> => renderFixtureVariant("m14", fixtureFiles(localDirectory));

  it("keeps the original button and drops the decoy", () => {
    const files = rendered();
    const html = files.get("public/index.html")!;
    expect(html).toMatch(/<button[^>]*data-testid="export-csv"[^>]*>Export CSV<\/button>/);
    for (const [path, text] of files) {
      if (path === "README.md") continue;
      expect(text, path).not.toContain("download-invoices");
      expect(text, path).not.toContain("Download invoices");
      expect(text, path).not.toContain("/api/invoices.csv");
      expect(text, path).not.toContain("fixture-variant");
    }
    expect(html).not.toContain("download-orders");
    expect(files.has("test/invoices.test.mjs")).toBe(false);
  });

  it("is the M1.3 reference state: viewer refusal, tenant isolation and the inventory column are in place", async () => {
    const directory = writeTree(rendered());
    const { createOrdersApplication } = await loadServer(directory);
    const app = createOrdersApplication({ seed, orders: orders(), fetchDependency: inventory });
    expect((await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, VIEWER_A) })).status).toBe(403);
    const owner = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) });
    expect(owner.body).toBe("id,customer,total,state,inventory\r\na1,Ada,12.5,ready,in-stock\r\na2,Grace,23,ready,unavailable\r\n");
    expect((await app.handle({ method: "GET", url: "/api/invoices.csv", headers: await signIn(app, OWNER_A) })).status).toBe(404);
    const other = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_B) });
    expect(other.body).not.toContain("a1");
  });

  it("keeps the same project contract as the local fixture and passes its own node --test suite", () => {
    const files = rendered();
    expect(files.get("package.json")).toBe(readLocal("package.json"));
    const directory = writeTree(files);
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: directory, stdio: "pipe" })).not.toThrow();
  });

  it("refuses an edit whose text is missing or ambiguous instead of publishing a drifted baseline", () => {
    const files = fixtureFiles(localDirectory);
    files.set("public/index.html", files.get("public/index.html")!.replace("Download orders", "Fetch orders"));
    expect(() => renderFixtureVariant("m14", files)).toThrow(/exactly once/);
    expect(() => renderFixtureVariant("nope", fixtureFiles(localDirectory))).toThrow(/unknown variant/);
  });
});

describe("publisher --variant m14", () => {
  it("parses the variant and rejects unknown ones", () => {
    expect(parsePublishArguments(["--repo", "o/n", "--variant", "m14"]).variant).toBe("m14");
    expect(parsePublishArguments(["--repo", "o/n"]).variant).toBeUndefined();
    expect(() => parsePublishArguments(["--repo", "o/n", "--variant", "m99"])).toThrow(/unknown variant/);
    expect(() => parsePublishArguments(["--repo", "o/n", "--variant"])).toThrow(/--variant/);
    expect(Object.keys(FIXTURE_VARIANTS).sort()).toEqual(["m14", "starter"]);
  });

  it("dry-runs the committed m14 files with the baseline file list", () => {
    const root = mkdtempSync(join(tmpdir(), "m14-repo-"));
    temporary.push(root);
    const git = (...args: string[]): void => { execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@orders-fixture.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" }); };
    git("init", "--quiet", "-b", "main");
    mkdirSync(join(root, LOCAL), { recursive: true });
    cpSync(localDirectory, join(root, LOCAL), { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes(".owned") });
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    const lines: string[] = [];
    expect(run(["--repo", "owner/name", "--variant", "m14", "--dry-run"], (line) => lines.push(line), root)).toBe(0);
    expect(lines[0]).toContain(LOCAL);
    expect(lines[0]).toContain("https://github.com/owner/name");
    const listed = lines.slice(1).map((line) => line.trim());
    expect(listed).toContain("public/index.html");
    expect(listed).toContain(".github/workflows/ci.yml");
    expect(listed).toContain("inventory/openapi.json");
    expect(listed).toContain("e2e/mocks/inventory-v1.json");
    expect(listed).not.toContain("test/invoices.test.mjs");
    expect(existsSync(join(root, LOCAL, "test/invoices.test.mjs"))).toBe(true);
  });
});
