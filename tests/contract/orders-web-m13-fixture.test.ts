import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateManifest } from "@agentx/contracts";
import { inspectE2ERepository, type VerifiedE2ESourceSnapshot } from "../../packages/broker/src/e2e/discovery.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EApiMockFixtureSchema } from "../../packages/contracts/src/e2e.js";
import { e2eApiSchemaComponentId } from "../../packages/contracts/src/e2e-application-services.js";
import { E2EApplicationProjectContractSchema } from "../../packages/contracts/src/e2e-application-accounts.js";
import { createE2EOpenApiFixtureDescriptor, validateE2EOpenApiFixtureResponse } from "../../packages/contracts/src/e2e-openapi-fixture.js";
import { FIXTURE_VARIANTS, renderFixtureVariant } from "../../scripts/fixtures/publish-web-fixture.js";

// Task 3.8: the M1.3 baseline of rovara-orders-web-fixture. It is the unchanged code of the live demo: the export button and route exist for every signed-in account (the
// `viewer-access` defect state), the orders table has no inventory column, and the inventory service has a contract and a mock but is not yet used for rows.
//
// Known consequence for 3.9 (review of 3.5, finding 7): an approved hosted mock is per target and every case on that target must consume it. In the baseline round the code
// never calls the inventory service, so a case such as `tenant-isolation-web` that shares a target with the approved mock is UNKNOWN there, not PASS.

const repositoryRoot = join(import.meta.dirname, "../..");
const LOCAL = "tests/fixtures/orders-web-m13";
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

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

/** Distinctive fixture account addresses: none of their local parts can be an ordinary page word that redaction would hit. */
const OWNER_A = "kzr41@orders-fixture.test";
const VIEWER_A = "mvd58@orders-fixture.test";
const OWNER_B = "jxp23@orders-fixture.test";
const PASSWORDS: Record<string, string> = { [OWNER_A]: "pw-owner-a-9q", [VIEWER_A]: "pw-viewer-a-7t", [OWNER_B]: "pw-owner-b-3w" };

/** The accounts file the Rovara host writes for a run (rovara-accounts/v1), with the distinctive addresses. */
const accountsFile = {
  schemaVersion: "rovara-accounts/v1",
  accounts: [
    { profileId: "orders-owner", email: OWNER_A, password: PASSWORDS[OWNER_A], tenantRef: "tenant-a", roleRef: "owner" },
    { profileId: "orders-viewer", email: VIEWER_A, password: PASSWORDS[VIEWER_A], tenantRef: "tenant-a", roleRef: "viewer" },
    { profileId: "orders-owner-b", email: OWNER_B, password: PASSWORDS[OWNER_B], tenantRef: "tenant-b", roleRef: "owner" },
  ],
};

interface Reply { status: number; headers: Record<string, string>; body: string }
interface Application { handle: (request: { method: string; url: string; headers: Record<string, string>; body?: unknown }) => Promise<Reply> }
type Dependency = (originRef: string, path: string) => Promise<{ status: number; body: unknown }>;
interface Seed { accounts: unknown[] }
async function loadServer(directory: string): Promise<{ createOrdersApplication: (input: { seed: unknown; orders: unknown; fetchDependency?: Dependency }) => Application }> {
  return await import(pathToFileURL(join(directory, "server.mjs")).href) as never;
}
const orders = (): unknown => JSON.parse(readLocal("fixtures/orders.json"));

/** Runs the recipe's seed command the way the host does: the accounts file in, the user records out in the data directory. */
function seedAccounts(directory: string): Seed {
  const work = scratch("orders-m13-seed-");
  const file = join(work, "accounts.json");
  const data = join(work, "data");
  writeFileSync(file, JSON.stringify(accountsFile));
  execFileSync(process.execPath, ["scripts/seed.mjs"], { cwd: directory, stdio: "pipe", env: { PATH: process.env.PATH ?? "", ROVARA_ACCOUNTS_FILE: file, ROVARA_DATA_DIR: data } });
  return JSON.parse(readFileSync(join(data, "users.json"), "utf8")) as Seed;
}

/** The inventory-v1 mock as the executor serves it: exact method and path, the variant chosen by the orderId query. */
const inventory: Dependency = async (originRef, path) => {
  if (originRef !== "inventory-v1") return { status: 599, body: {} };
  const url = new URL(path, "http://inventory.invalid");
  if (url.pathname !== "/v1/stock") return { status: 599, body: {} };
  const orderId = url.searchParams.get("orderId");
  if (orderId === "a1") return { status: 200, body: { status: "in-stock" } };
  if (orderId === "a2") return { status: 404, body: { error: "unknown order" } };
  if (orderId === "b1") return { status: 200, body: { status: 7 } };
  return { status: 599, body: {} };
};

async function signIn(app: Application, email: string): Promise<Record<string, string>> {
  const response = await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password: PASSWORDS[email] } });
  expect(response.status).toBe(200);
  return { cookie: String(response.headers["set-cookie"]).split(";")[0]! };
}

async function application(spy?: string[]): Promise<Application> {
  const { createOrdersApplication } = await loadServer(localDirectory);
  const fetchDependency: Dependency = async (originRef, path) => { spy?.push(`${originRef} ${path}`); return inventory(originRef, path); };
  return createOrdersApplication({ seed: seedAccounts(localDirectory), orders: orders(), fetchDependency });
}

describe("project contract of orders-web-m13", () => {
  const manifest = (): { agentx: { e2e: unknown } } => JSON.parse(readLocal("package.json")) as { agentx: { e2e: unknown } };

  it("parses, has a recipe digest that matches its canonical body, and declares the generic seed and the form login", () => {
    const contract = E2EApplicationProjectContractSchema.parse(manifest().agentx.e2e);
    const { recipeDigest, ...body } = contract.recipe;
    expect(createHash("sha256").update(canonicalJson(body)).digest("hex")).toBe(recipeDigest);
    expect(contract.recipe.seedProfileId).toBe("rovara-accounts-file/v1");
    expect(contract.recipe.seed).toEqual({ program: "node", args: ["scripts/seed.mjs"], cwd: ".", timeoutMs: 30_000, env: {} });
    expect(existsSync(join(localDirectory, "scripts/seed.mjs"))).toBe(true);
    expect(contract.accountProfiles.map((profile) => [profile.profileId, profile.tenantRef, profile.roleRef, profile.authProfileId, profile.seedProfileId])).toEqual([
      ["orders-owner", "tenant-a", "owner", "rovara-form-login/v1", "rovara-accounts-file/v1"],
      ["orders-viewer", "tenant-a", "viewer", "rovara-form-login/v1", "rovara-accounts-file/v1"],
      ["orders-owner-b", "tenant-b", "owner", "rovara-form-login/v1", "rovara-accounts-file/v1"],
    ]);
    for (const profile of contract.accountProfiles) {
      expect(profile.login).toEqual({ kind: "form", path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" });
      expect(profile.identityProbeId).toBe("orders-identity/v1");
    }
    expect(contract.recipe.accountProfileIds).toEqual(["orders-owner", "orders-viewer", "orders-owner-b"]);
  });

  it("drops the synthetic account and covers web-1 and api-1 for all three accounts", () => {
    const contract = E2EApplicationProjectContractSchema.parse(manifest().agentx.e2e);
    expect(contract.accountProfiles.map((profile) => profile.profileId)).not.toContain("synthetic");
    expect(contract.targetAccounts).toHaveLength(6);
    for (const baseTargetId of ["web-1", "api-1"]) {
      for (const profileId of ["orders-owner", "orders-viewer", "orders-owner-b"]) expect(contract.targetAccounts).toContainEqual({ baseTargetId, profileId });
    }
  });

  it("binds the inventory origin to its OpenAPI contract and keeps the orders origin unbound", () => {
    const contract = E2EApplicationProjectContractSchema.parse(manifest().agentx.e2e);
    expect(contract.recipe.allowedOrigins).toEqual(["orders-api", "inventory-v1"]);
    expect(contract.service?.originBindings).toEqual([
      { originRef: "orders-api", envName: "ORDERS_SERVICE_ORIGIN" },
      { originRef: "inventory-v1", envName: "INVENTORY_ORIGIN", contractPath: "inventory/openapi.json" },
    ]);
  });

  /** Discovery of the fixture tree as a repository snapshot; `edit` changes the project contract first. */
  function discover(edit: (e2e: { targetAccounts: Array<{ baseTargetId: string; profileId: string }> }) => void = () => undefined) {
    const files = fixtureFiles(localDirectory);
    const parsed = JSON.parse(files.get("package.json")!) as { agentx: { e2e: { targetAccounts: Array<{ baseTargetId: string; profileId: string }> } } };
    edit(parsed.agentx.e2e);
    files.set("package.json", JSON.stringify(parsed));
    const sources = ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"].map((path) => ({ path, sha256: digest(files.get(path)!), bytes: Buffer.from(files.get(path)!), kind: "blob" as const }));
    const candidate = createCandidateManifest([{ repositoryId: "fixture/orders", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const snapshot: VerifiedE2ESourceSnapshot = { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path).sort(), sources };
    return inspectE2ERepository(snapshot, candidate).inspection;
  }
  const webOnly = (e2e: { targetAccounts: Array<{ baseTargetId: string; profileId: string }> }): void => { e2e.targetAccounts = e2e.targetAccounts.filter((item) => item.baseTargetId === "web-1"); };

  it("is found by discovery as read today (web account variants): the inventory/openapi.json edge and one web target per account", () => {
    const inspection = discover(webOnly);
    const application = inspection.applications[0]!;
    expect(inspection.dependencyEdges.map((edge) => [edge.fromApplicationId, edge.toComponentId, edge.contractRef])).toContainEqual([application.applicationId, e2eApiSchemaComponentId("inventory/openapi.json"), "inventory/openapi.json"]);
    // The base target keeps the placeholder account; the three declared accounts are bound as variants of it. The declared contract has no `synthetic` account of its own.
    expect(inspection.proposedTargets.filter((target) => target.kind === "web").map((target) => target.accountProfileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"]);
    expect(E2EApplicationProjectContractSchema.parse((JSON.parse(readLocal("package.json")) as { agentx: { e2e: unknown } }).agentx.e2e).accountProfiles.map((profile) => profile.profileId)).not.toContain("synthetic");
    expect(inspection.missingInputs.filter((input) => input.kind === "target-selection")).toEqual([]);
  });

  // KNOWN GAP (reported with Task 3.8): discovery gives a root package one base target, `web-1` (an `api-N` target exists only for a package with a server dependency or
  // under api/ or server/). The plan wants this one app to carry web-1 and api-1 for all three accounts, so with the declared contract the account variants do not bind and
  // discovery falls back to the `synthetic` web target with a blocking "target-selection" input. `it.fails` passes while that is so; it turns red when discovery proposes
  // the api-1 base target for the app, which is the moment to change it to a plain `it`.
  it.fails("is found by discovery with the contract as declared: a web and an api target per account", () => {
    const inspection = discover();
    for (const kind of ["web", "api"]) {
      expect(inspection.proposedTargets.filter((target) => target.kind === kind && target.accountProfileId !== "synthetic").map((target) => target.accountProfileId).sort(), kind).toEqual(["orders-owner", "orders-owner-b", "orders-viewer"]);
    }
  });

  it("pins the recipe digest that the accounts, the login form and the inventory binding produce", () => {
    const { recipeDigest } = E2EApplicationProjectContractSchema.parse(manifest().agentx.e2e).recipe;
    expect(recipeDigest).toBe(RECIPE_DIGEST);
    // The earlier orders contracts (built-in seed and login) keep their own digests: this fixture did not move them.
    expect(recipeDigest).not.toBe("22fe496a0adedb28849e2fce400eea3a84ee0d6c884ec3337a9b8819a7c038cb");
    expect(recipeDigest).not.toBe("17fd98a69f7e60cba236bd576ebceddf7d5b48ec5dd1ca1d1067aeaa8ccf2d52");
  });
});

/** The recorded digest of this fixture's recipe (Task 3.8). */
const RECIPE_DIGEST = "62f07dfd46a6f35d4cddaeaed5b481e2320db8fe43507efc882c7d6a622959c8";

describe("accounts seed (scripts/seed.mjs)", () => {
  it("builds the app's own user records from the accounts file and keeps the password out of them", () => {
    const seed = seedAccounts(localDirectory) as { accounts: Array<Record<string, string>> };
    expect(seed.accounts.map((account) => [account.email, account.tenantId, account.role, account.displayName])).toEqual([
      [OWNER_A, "tenant-a", "owner", "Rovara orders-owner"], [VIEWER_A, "tenant-a", "viewer", "Rovara orders-viewer"], [OWNER_B, "tenant-b", "owner", "Rovara orders-owner-b"],
    ]);
    expect(new Set(seed.accounts.map((account) => account.subjectId)).size).toBe(3);
    const text = JSON.stringify(seed);
    for (const password of Object.values(PASSWORDS)) expect(text).not.toContain(password);
    for (const account of seed.accounts) expect(account.passwordDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses an accounts file of another schema or with an incomplete record, writing nothing", () => {
    for (const broken of [{ ...accountsFile, schemaVersion: "other/v1" }, { ...accountsFile, accounts: [{ ...accountsFile.accounts[0], password: "" }] }, { ...accountsFile, accounts: [] }]) {
      const work = scratch("orders-m13-seed-bad-");
      writeFileSync(join(work, "accounts.json"), JSON.stringify(broken));
      expect(() => execFileSync(process.execPath, ["scripts/seed.mjs"], { cwd: localDirectory, stdio: "pipe",
        env: { PATH: process.env.PATH ?? "", ROVARA_ACCOUNTS_FILE: join(work, "accounts.json"), ROVARA_DATA_DIR: join(work, "data") } })).toThrow();
      expect(existsSync(join(work, "data/users.json"))).toBe(false);
    }
  });
});

describe("baseline behaviour (the viewer-access defect state)", () => {
  it("signs in through the seeded records and answers /api/me with the subject, tenant and role, never the email", async () => {
    const app = await application();
    const headers = await signIn(app, OWNER_A);
    const me = JSON.parse((await app.handle({ method: "GET", url: "/api/me", headers })).body) as Record<string, string>;
    expect(me).toMatchObject({ tenantId: "tenant-a", role: "owner" });
    expect(typeof me.subjectId).toBe("string");
    expect(Object.keys(me).sort()).toEqual(["displayName", "role", "subjectId", "tenantId"]);
    expect((await app.handle({ method: "GET", url: "/api/me", headers: {} })).status).toBe(401);
    expect((await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email: OWNER_A, password: "wrong" } })).status).toBe(401);
  });

  it("exports the tenant's orders as CSV without an inventory column, for the owner", async () => {
    const app = await application();
    const owner = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) });
    expect(owner.status).toBe(200);
    expect(owner.headers["content-type"]).toContain("text/csv");
    expect(owner.headers["content-disposition"]).toContain("orders.csv");
    expect(owner.body).toBe("id,customer,total,state\r\na1,Ada,12.5,ready\r\na2,Grace,23,ready\r\n");
  });

  it("lets a viewer download the export: the viewer check is the missing piece the request fixes", async () => {
    const app = await application();
    const viewer = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, VIEWER_A) });
    expect(viewer.status).toBe(200);
    expect(viewer.body).toBe("id,customer,total,state\r\na1,Ada,12.5,ready\r\na2,Grace,23,ready\r\n");
    expect((await app.handle({ method: "GET", url: "/api/orders.csv", headers: {} })).status).toBe(401);
  });

  it("keeps each tenant to its own orders on the list and the export", async () => {
    const app = await application();
    const viewer = await signIn(app, VIEWER_A);
    expect((await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers: viewer })).status).toBe(403);
    const own = JSON.parse((await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers: viewer })).body) as { orders: Array<Record<string, unknown>> };
    expect(own.orders.map((row) => Object.keys(row).sort())).toEqual([["customer", "id", "state", "total"], ["customer", "id", "state", "total"]]);
    const ownerB = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_B) });
    expect(ownerB.body).toBe("id,customer,total,state\r\nb1,Lin,99,ready\r\n");
    expect(ownerB.body).not.toContain("a1");
    expect((await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers: await signIn(app, OWNER_B) })).status).toBe(403);
  });

  it("reads the inventory origin but does not use it for rows: listing and export never call the service", async () => {
    const calls: string[] = [];
    const app = await application(calls);
    const headers = await signIn(app, OWNER_A);
    await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers });
    await app.handle({ method: "GET", url: "/api/orders.csv", headers });
    expect(calls).toEqual([]);
    expect(readLocal("server.mjs")).toContain("INVENTORY_ORIGIN");
  });

  it("neutralizes spreadsheet formulas in CSV cells and still quotes separators", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const hostile = { orders: [
      { id: "a1", tenantId: "tenant-a", customer: "=HYPERLINK(\"http://x\")", total: 1, state: "ready", placedOn: "2026-09-01" },
      { id: "a2", tenantId: "tenant-a", customer: "Doe, Jane", total: 2, state: "ready", placedOn: "2026-09-02" },
    ], state: { orders: "ready", version: 1 } };
    const app = createOrdersApplication({ seed: seedAccounts(localDirectory), orders: hostile, fetchDependency: inventory });
    const csv = (await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) })).body;
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csv).toContain('"Doe, Jane"');
  });

  it("filters the export by from and to and refuses other queries", async () => {
    const app = await application();
    const headers = await signIn(app, OWNER_A);
    expect((await app.handle({ method: "GET", url: "/api/orders.csv?from=2026-09-02&to=2026-09-02", headers })).body).toBe("id,customer,total,state\r\na2,Grace,23,ready\r\n");
    expect((await app.handle({ method: "GET", url: "/api/orders.csv?from=nope", headers })).status).toBe(400);
    expect((await app.handle({ method: "GET", url: "/api/orders.csv?tenant=tenant-b", headers })).status).toBe(400);
  });

  it("never puts a signed-in account email, or its local part, into page text or API bodies", async () => {
    const app = await application();
    const headers = await signIn(app, OWNER_A);
    for (const url of ["/", "/app.js", "/api/me", "/api/orders/state", "/api/tenants/tenant-a/orders", "/api/inventory/status", "/api/orders.csv"]) {
      const body = (await app.handle({ method: "GET", url, headers })).body;
      for (const email of [OWNER_A, VIEWER_A, OWNER_B]) {
        expect(body, url).not.toContain(email);
        expect(body, url).not.toContain(email.split("@")[0]!);
      }
    }
    expect(readLocal("public/app.js")).not.toMatch(/textContent\s*=[^;]*email/i);
  });

  it("uses account addresses with distinctive local parts, never a common word, in every file of the fixture", () => {
    for (const email of [OWNER_A, VIEWER_A, OWNER_B]) {
      const local = email.split("@")[0]!;
      expect(local.length).toBeGreaterThanOrEqual(5);
      expect(local).toMatch(/\d/);
    }
    const common = /(?<![a-z0-9])(?:test|owner|viewer|admin|user|demo|info|orders|account|me)@/i;
    for (const [path, text] of fixtureFiles(localDirectory)) expect(text, path).not.toMatch(common);
  });

  it("passes its own node --test suite", () => {
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: localDirectory, stdio: "pipe" })).not.toThrow();
  });
});

describe("inventory contract and mock", () => {
  it("keeps one operation and a mock whose success and refusal validate against it, and whose invalid-data does not", () => {
    const openapi = readFileSync(join(localDirectory, "inventory/openapi.json"));
    const descriptor = createE2EOpenApiFixtureDescriptor(new Uint8Array(openapi));
    expect(descriptor).toBeDefined();
    expect(descriptor!.operations.map((operation) => [operation.method, operation.path])).toEqual([["GET", "/v1/stock"]]);
    const mock = E2EApiMockFixtureSchema.parse(JSON.parse(readLocal("e2e/mocks/inventory-v1.json")));
    expect(mock.schemaVersion).toBe("source-backed-api-fixtures/v1");
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
});

/** The page the server renders for a request carrying `cookie` (none for a visitor who is not signed in). */
async function pageFor(signedInAs: string | null): Promise<string> {
  const app = await application();
  const headers = signedInAs === null ? {} : await signIn(app, signedInAs);
  const reply = await app.handle({ method: "GET", url: "/", headers });
  expect(reply.status).toBe(200);
  expect(reply.headers["content-type"]).toContain("text/html");
  return reply.body;
}
const testIds = (html: string): string[] => [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1]!);

describe("the server-rendered page (complete when it loads, so a visible assertion never races a fetch)", () => {
  it("shows an owner its identity, the export button and its tenant's rows, with no inventory column, and no sign-in form", async () => {
    const html = await pageFor(OWNER_A);
    expect(html).toContain('<p data-testid="identity">Rovara orders-owner (owner)</p>');
    expect(testIds(html)).toEqual(expect.arrayContaining(["identity", "export-csv", "orders-table", "order-row-a1", "order-row-a2", "orders-export-status", "orders-access-error"]));
    expect(testIds(html)).not.toContain("order-row-b1");
    expect(testIds(html)).not.toContain("email");
    expect(html).toMatch(/<button data-testid="export-csv" data-download="\/api\/orders\.csv"[^>]*>Export CSV<\/button>/);
    expect(html).not.toMatch(/\bhidden\b/);
    expect(html.match(/<th>/g)).toHaveLength(4);
    expect(html).not.toMatch(/inventory/i);
  });

  it("shows a viewer the export button too (the baseline defect)", async () => {
    const html = await pageFor(VIEWER_A);
    expect(html).toContain("Rovara orders-viewer (viewer)");
    expect(testIds(html)).toContain("export-csv");
  });

  it("gives the other tenant's owner only its own rows", async () => {
    const html = await pageFor(OWNER_B);
    expect(testIds(html).filter((id) => id.startsWith("order-row-"))).toEqual(["order-row-b1"]);
  });

  it("shows a visitor who is not signed in the form and nothing else: no identity, no table, no export button", async () => {
    const html = await pageFor(null);
    expect(testIds(html)).toEqual(expect.arrayContaining(["email", "password", "login-submit"]));
    for (const id of ["identity", "export-csv", "orders-table"]) expect(testIds(html), id).not.toContain(id);
  });

  it("escapes order text, and never prints an email or its local part", async () => {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const hostile = { orders: [{ id: "a1", tenantId: "tenant-a", customer: "<img src=x onerror=alert(1)>", total: 1, state: "ready", placedOn: "2026-09-01" }], state: { orders: "ready", version: 1 } };
    const app = createOrdersApplication({ seed: seedAccounts(localDirectory), orders: hostile, fetchDependency: inventory });
    const html = (await app.handle({ method: "GET", url: "/", headers: await signIn(app, OWNER_A) })).body;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    for (const email of [OWNER_A, VIEWER_A, OWNER_B]) { expect(html).not.toContain(email); expect(html).not.toContain(email.split("@")[0]!); }
  });
});

// A DOM-free harness for public/app.js: the sign-in form and the export button, with fetch answered by the real request handler.
type Listener = (event: { preventDefault: () => void; currentTarget?: unknown }) => unknown;
class Element {
  textContent = "";
  value = "";
  download = "";
  href = "";
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener>();
  elements: Record<string, Element> = {};
  form: Element | undefined;
  constructor(private readonly onClick: (element: Element) => void = () => undefined) {}
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, listener); }
  click(): void { this.onClick(this); }
}

describe("public/app.js", () => {
  async function load(signedIn: boolean) {
    const { createOrdersApplication } = await loadServer(localDirectory);
    const app = createOrdersApplication({ seed: seedAccounts(localDirectory), orders: orders(), fetchDependency: inventory });
    let session: string | null = signedIn ? (await signIn(app, OWNER_A))["cookie"]! : null;
    const downloads: Array<{ filename: string; content: string }> = [];
    const blobs = new Map<string, string>();
    const login = new Element();
    login.elements = { email: new Element(), password: new Element() };
    const submit = new Element();
    submit.form = login;
    const exportButton = new Element();
    exportButton.dataset = { download: "/api/orders.csv", filename: "orders.csv", done: "Orders exported" };
    const status = new Element();
    const failure = new Element();
    const byTestId: Record<string, Element> = { "login-submit": submit, "export-csv": exportButton, "orders-export-status": status, "orders-access-error": failure };
    let reloads = 0;
    const document = {
      querySelector: (selector: string): Element | null => byTestId[/^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1] ?? ""] ?? null,
      querySelectorAll: (selector: string): Element[] => selector === "[data-download]" ? [exportButton] : [],
      createElement: (): Element => new Element((element) => { downloads.push({ filename: element.download, content: blobs.get(element.href) ?? "" }); }),
    };
    let counter = 0;
    const url = { createObjectURL: (blob: string): string => { counter += 1; blobs.set(`blob:${counter}`, blob); return `blob:${counter}`; }, revokeObjectURL: (): void => undefined };
    const fetchStub = async (path: string, init?: { method?: string; body?: string }) => {
      const reply = await app.handle({ method: init?.method ?? "GET", url: path, headers: session === null ? {} : { cookie: session }, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
      const setCookie = reply.headers["set-cookie"];
      if (setCookie !== undefined) session = setCookie.split(";")[0]!;
      return { ok: reply.status < 400, status: reply.status, blob: async () => reply.body };
    };
    const AsyncFunction = (Object.getPrototypeOf(async () => undefined) as { constructor: unknown }).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<void>;
    await new AsyncFunction("document", "fetch", "URL", "location", readLocal("public/app.js"))(document, fetchStub, url, { reload: () => { reloads += 1; } });
    return { login, submit, exportButton, status, failure, downloads, reloads: () => reloads };
  }

  it("signs in through the form and reloads, so the server renders the signed-in page", async () => {
    const page = await load(false);
    page.login.elements["email"]!.value = OWNER_A;
    page.login.elements["password"]!.value = PASSWORDS[OWNER_A]!;
    await page.login.listeners.get("submit")!({ preventDefault: () => undefined, currentTarget: page.login });
    expect(page.reloads()).toBe(1);
    expect(page.failure.textContent).toBe("");
  });

  it("says so and does not reload when the sign-in is refused", async () => {
    const page = await load(false);
    page.login.elements["email"]!.value = OWNER_A;
    page.login.elements["password"]!.value = "wrong";
    await page.login.listeners.get("submit")!({ preventDefault: () => undefined, currentTarget: page.login });
    expect(page.reloads()).toBe(0);
    expect(page.failure.textContent).toBe("Unable to sign in");
  });

  it("downloads the orders CSV when the export button is clicked", async () => {
    const page = await load(true);
    await page.exportButton.listeners.get("click")!({ preventDefault: () => undefined });
    expect(page.downloads.map((item) => [item.filename, item.content.split("\r\n")[0]])).toEqual([["orders.csv", "id,customer,total,state"]]);
    expect(page.status.textContent).toBe("Orders exported");
  });
});

describe("publishing variant m13", () => {
  it("is the local directory as it is, with no decoy markers and no files held back", () => {
    expect(FIXTURE_VARIANTS["m13"]).toMatchObject({ directory: LOCAL, exclude: [], renames: {}, localOnlyBlocks: null });
    const files = fixtureFiles(localDirectory);
    expect([...renderFixtureVariant("m13", files).keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, text] of files) expect(text, path).not.toContain("fixture-variant");
  });

  it("refuses a render in which a variant marker is left behind", () => {
    const files = fixtureFiles(localDirectory);
    files.set("server.mjs", `${files.get("server.mjs")!}\n// fixture-variant:local-only:begin\n`);
    expect(() => renderFixtureVariant("m13", files)).toThrow(/fixture-variant/);
  });

  it("describes the page, the API, the inventory service and the seed in the README, and keeps the node --test CI", () => {
    const readme = readLocal("README.md");
    for (const part of ["export-csv", "orders-table", "/api/orders.csv", "/api/me", "inventory/openapi.json", "INVENTORY_ORIGIN", "scripts/seed.mjs", "ROVARA_ACCOUNTS_FILE", "ROVARA_DATA_DIR"]) expect(readme, part).toContain(part);
    expect(readLocal(".github/workflows/ci.yml")).toContain("node --test");
    expect(readLocal(".gitignore")).toContain(".owned/");
  });

  it("is ignored by eslint like the other fixture trees", () => {
    expect(readFileSync(join(repositoryRoot, "eslint.config.js"), "utf8")).toContain('"tests/fixtures/orders-web-m13/**"');
  });
});

describe("derivation of orders-web-m14 from orders-web-m13 (declared patch)", () => {
  const PATCH = join(repositoryRoot, "tests/fixtures/orders-web-m13-to-m14.patch");

  function derive(): string {
    const target = scratch("orders-m14-derived-");
    cpSync(localDirectory, target, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes(".owned") });
    execFileSync("git", ["apply", "--whitespace=nowarn", PATCH], { cwd: target, stdio: "pipe" });
    return target;
  }

  it("applies cleanly and yields the M1.3 reference state with the renamed button, the decoy and the inventory column", async () => {
    const derived = derive();
    const files = fixtureFiles(derived);
    expect(files.get("server.mjs")).toMatch(/<button[^>]*data-testid="download-orders"[^>]*>Download orders<\/button>/);
    expect(files.get("server.mjs")).toMatch(/data-testid="download-invoices"/);
    expect(files.has("test/invoices.test.mjs")).toBe(true);
    expect(files.has("README.baseline.md")).toBe(true);
    const { createOrdersApplication } = await loadServer(derived);
    const app = createOrdersApplication({ seed: seedAccounts(derived), orders: JSON.parse(readFileSync(join(derived, "fixtures/orders.json"), "utf8")), fetchDependency: inventory });
    expect((await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, VIEWER_A) })).status).toBe(403);
    const owner = await app.handle({ method: "GET", url: "/api/orders.csv", headers: await signIn(app, OWNER_A) });
    expect(owner.body).toBe("id,customer,total,state,inventory\r\na1,Ada,12.5,ready,in-stock\r\na2,Grace,23,ready,unavailable\r\n");
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: derived, stdio: "pipe" })).not.toThrow();
  });

  it("keeps the generic accounts, the form login and the inventory contract binding of m13 in the derived project contract", () => {
    const derived = JSON.parse(readFileSync(join(derive(), "package.json"), "utf8")) as { agentx: { e2e: unknown } };
    const contract = E2EApplicationProjectContractSchema.parse(derived.agentx.e2e);
    const { recipeDigest, ...body } = contract.recipe;
    expect(createHash("sha256").update(canonicalJson(body)).digest("hex")).toBe(recipeDigest);
    expect(contract.recipe.seedProfileId).toBe("rovara-accounts-file/v1");
    expect(contract.accountProfiles.every((profile) => profile.authProfileId === "rovara-form-login/v1")).toBe(true);
    expect(contract.service?.originBindings.find((binding) => binding.originRef === "inventory-v1")?.contractPath).toBe("inventory/openapi.json");
  });

  it("equals the M1.4 fixture directory whenever that directory is present (M1.4 must carry m13 plus this patch)", () => {
    const m14 = join(repositoryRoot, "tests/fixtures/orders-web-m14");
    if (!existsSync(m14)) return;
    const derived = fixtureFiles(derive());
    const actual = fixtureFiles(m14);
    expect([...actual.keys()].sort()).toEqual([...derived.keys()].sort());
    for (const [path, text] of derived) expect(actual.get(path), path).toBe(text);
  });
});
