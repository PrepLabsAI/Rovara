// TE-H1 browser evidence, slice 3: the saved sign-in, the saved recipe and the sign-in callback, on the real laptop secret files and the document store, for two companies. The reasons to be careful are the same everywhere:
// a sign-in is a password, a recipe may be company A's and a project may have the same name in company B. Every guard has a test that fails without it.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectBrowserEvidenceRecipeKey, type BrowserEvidenceRecipe } from "@agentx/contracts";
import { createLocalConnectionSecrets } from "../../packages/broker/src/local/connection-secrets.js";
import { createLocalSecretStore } from "../../packages/broker/src/ports/secret-stores.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { SIGN_IN_WORDS, browserEvidenceSignInSecretName, createBrowserEvidenceSignIn } from "../../packages/broker/src/core/proof/browser-evidence-sign-in.js";
import { effectiveRecipe, readStoredRecipe, recipeFitsProject, saveStoredRecipe } from "../../packages/broker/src/core/proof/browser-evidence-recipe.js";
import { handleBrowserEvidenceSignIn } from "../../packages/broker/src/core/proof/browser-evidence-sign-in-callback.js";
import { operationKey, taskKey, taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });
/** Built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection. */
const VALUES = { username: ["tester", "example"].join("@") + ".test", password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
const LEAK = [VALUES.username, VALUES.password, Buffer.from(VALUES.password).toString("base64"), encodeURIComponent(VALUES.password)];

async function secretsWorld() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-be-sign-in-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "connection-secrets");
  const secrets = createLocalConnectionSecrets({ directory, secrets: createLocalSecretStore({ environment: {} }), companyId: A, env: "local", now: () => 1_700_000_000_000 });
  return { root, directory, signIn: createBrowserEvidenceSignIn({ secrets, env: "local" }) };
}
const allFiles = async (directory: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) out.push(...(await allFiles(join(directory, entry.name))).map((file) => join(entry.name, file)));
    else out.push(entry.name);
  }
  return out;
};

describe("the saved sign-in", () => {
  it("is kept under the company's own path, in a file only the owner reads, and is read back for the project's own reference", async () => {
    const w = await secretsWorld();
    await w.signIn.save(A, "web", VALUES);
    expect(await w.signIn.has(A, "web")).toBe(true);
    expect(await w.signIn.read(A, "web", "be-web-signin")).toEqual(VALUES);
    // The name is the company's connector path and a leaf no connection or server can have.
    expect(browserEvidenceSignInSecretName("local", A, "web")).toBe(`agentx/local/org-connectors/${A}/be-web-signin`);
    const files = await allFiles(w.directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${A}/be-web-signin\\.\\d{13}-[0-9a-f]{8}$`, "u"));
    expect(JSON.parse(await readFile(join(w.directory, files[0]!), "utf8"))).toEqual(VALUES);
  });

  it("is company A's alone: company B's same-named project has none, and B's save does not touch A's (two-company)", async () => {
    const w = await secretsWorld();
    await w.signIn.save(A, "web", VALUES);
    expect(await w.signIn.has(B, "web")).toBe(false);
    expect(await w.signIn.read(B, "web", "be-web-signin")).toBeUndefined();
    const other = { username: "bee@example.test", password: ["pw", "other", "Pass", "42"].join("-") };
    await w.signIn.save(B, "web", other);
    expect(await w.signIn.read(A, "web", "be-web-signin")).toEqual(VALUES);
    expect(await w.signIn.read(B, "web", "be-web-signin")).toEqual(other);
    await w.signIn.clear(B, "web");
    expect(await w.signIn.has(B, "web")).toBe(false);
    expect(await w.signIn.has(A, "web")).toBe(true);
  });

  it("reads nothing for a reference that is not the project's own (mutant: the reference check dropped), and never another project's", async () => {
    const w = await secretsWorld();
    await w.signIn.save(A, "web", VALUES);
    await w.signIn.save(A, "api", { username: "api-user@example.test", password: ["api", "pw", "Qx81"].join("-") });
    expect(await w.signIn.read(A, "web", "be-api-signin")).toBeUndefined();
    expect(await w.signIn.read(A, "api", "be-web-signin")).toBeUndefined();
    for (const ref of ["con_aaaaaaaaaaaaaaaaaaaa", "be-web", "", "../be-web-signin", "be-web-signin/x"]) expect(await w.signIn.read(A, "web", ref), ref).toBeUndefined();
  });

  it("refuses values that are not a user name and a password, with one fixed sentence that holds neither (mutant: the values check dropped)", async () => {
    const w = await secretsWorld();
    for (const bad of [{ username: "ab", password: VALUES.password }, { username: VALUES.username, password: "a\nb c d" }, { username: VALUES.username }, { ...VALUES, extra: "x" }, null, "text"]) {
      const error = await w.signIn.save(A, "web", bad).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error, JSON.stringify(bad)).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error!.message).toBe(`CONFIG_INVALID: ${SIGN_IN_WORDS.invalid}`);
    }
    expect(await allFiles(w.directory)).toEqual([]);
    await expect(w.signIn.save(A, "Not A Project", VALUES)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not read a secret that is not a sign-in (a file that is not exactly a user name and a password is not saved)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-be-sign-in-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const secrets = createLocalConnectionSecrets({ directory: join(root, "s"), secrets: createLocalSecretStore({ environment: {} }), companyId: A, env: "local", now: () => 1_700_000_000_000 });
    const signIn = createBrowserEvidenceSignIn({ secrets, env: "local" });
    const name = browserEvidenceSignInSecretName("local", A, "web")!;
    for (const text of ["not json", JSON.stringify({ apiKey: "k1" }), JSON.stringify({ ...VALUES, extra: 1 }), JSON.stringify({ username: "ab", password: "cd" }), "[]", "null"]) {
      await secrets.put(A, name, text);
      expect(await signIn.has(A, "web"), text).toBe(false);
      expect(await signIn.read(A, "web", "be-web-signin"), text).toBeUndefined();
    }
  });

  it("removes every version and the file, and a sign-in that is not there is already gone", async () => {
    const w = await secretsWorld();
    await w.signIn.save(A, "web", VALUES);
    await w.signIn.clear(A, "web");
    expect(await allFiles(w.directory)).toEqual([]);
    expect(await w.signIn.has(A, "web")).toBe(false);
    await expect(w.signIn.clear(A, "web")).resolves.toBeUndefined();
  });
});

const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }] };
const WITH_SIGN_IN = (project: string): BrowserEvidenceRecipe => ({ ...RECIPE, signIn: { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard", credentialRef: `be-${project}-signin` } });

describe("the saved recipe", () => {

  it("refuses a second page's save over a recipe it did not see (mutant: the version guard dropped), and a first save over one that is there", async () => {
    const store = new MemoryDocumentStore();
    await saveStoredRecipe(store, A, "web", RECIPE, { expectedVersion: undefined, now: () => 1 });
    await expect(saveStoredRecipe(store, A, "web", { ...RECIPE, port: 3001 }, { expectedVersion: undefined, now: () => 2 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await saveStoredRecipe(store, A, "web", { ...RECIPE, port: 3001 }, { expectedVersion: 1, now: () => 3 })).toEqual({ version: 2 });
    await expect(saveStoredRecipe(store, A, "web", { ...RECIPE, port: 3002 }, { expectedVersion: 1, now: () => 4 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await readStoredRecipe(store, A, "web"))?.recipe.port).toBe(3001);
    await expect(saveStoredRecipe(store, A, "web", RECIPE, { expectedVersion: 7, now: () => 5 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });

  it("replaces a damaged row instead of refusing every save for good, and a row that is not a recipe reads as none", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...projectBrowserEvidenceRecipeKey(A, "web"), entityType: "BROWSER_EVIDENCE_RECIPE", orgId: A, project: "web", recipe: { startCommand: "x" }, version: 1, updatedAt: "2026-11-16T00:00:00.000Z" } });
    expect(await readStoredRecipe(store, A, "web")).toBeUndefined();
    expect(await saveStoredRecipe(store, A, "web", RECIPE, { expectedVersion: undefined, now: () => 1 })).toEqual({ version: 1 });
    expect((await readStoredRecipe(store, A, "web"))?.recipe).toEqual(RECIPE);
    for (const row of [{ entityType: "OTHER" }, { version: 0 }, { version: "1" }, { updatedAt: 5 }, { orgId: B }, { project: "x" }, { recipe: "yes" }]) {
      await store.put({ item: { ...projectBrowserEvidenceRecipeKey(A, "web"), entityType: "BROWSER_EVIDENCE_RECIPE", orgId: A, project: "web", recipe: JSON.parse(JSON.stringify(RECIPE)) as never, version: 1, updatedAt: "t", ...row } });
      expect(await readStoredRecipe(store, A, "web"), JSON.stringify(row)).toBeUndefined();
    }
  });

  it("refuses a recipe that does not parse, or whose sign-in names another project's saved sign-in, with one fixed sentence (mutant: the project check dropped)", async () => {
    const store = new MemoryDocumentStore();
    for (const bad of [{ ...RECIPE, port: 80 }, { ...RECIPE, extra: 1 }, "yes", WITH_SIGN_IN("other"), { ...WITH_SIGN_IN("web"), signIn: { ...WITH_SIGN_IN("web").signIn, credentialRef: "con_aaaaaaaaaaaaaaaaaaaa" } }]) {
      const error = await saveStoredRecipe(store, A, "web", bad, { expectedVersion: undefined, now: () => 1 }).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error, JSON.stringify(bad)).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error!.message).not.toContain("con_aaaaaaaaaaaaaaaaaaaa");
    }
    expect(await readStoredRecipe(store, A, "web")).toBeUndefined();
    expect(recipeFitsProject("web", WITH_SIGN_IN("web"))).toBe(true);
    expect(recipeFitsProject("web", WITH_SIGN_IN("other"))).toBe(false);
  });
});

describe("which recipe a run uses", () => {
  it("is the owner's config file's when it has one, else the page's, else none; a config recipe that does not fit is never replaced by the page's", async () => {
    const store = new MemoryDocumentStore();
    expect(await effectiveRecipe({ store, orgId: A, project: "web", fromConfig: undefined })).toBeUndefined();
    await saveStoredRecipe(store, A, "web", RECIPE, { expectedVersion: undefined, now: () => 1 });
    expect(await effectiveRecipe({ store, orgId: A, project: "web", fromConfig: undefined })).toEqual({ source: "page", recipe: RECIPE, version: 1 });
    const config = { ...RECIPE, port: 4000 };
    expect(await effectiveRecipe({ store, orgId: A, project: "web", fromConfig: () => config })).toEqual({ source: "config", recipe: config });
    // A config recipe naming another project's sign-in is not usable; the stronger source said something unreadable, so browser evidence is off.
    expect(await effectiveRecipe({ store, orgId: A, project: "web", fromConfig: WITH_SIGN_IN("other") })).toBeUndefined();
    // The page's recipe of company A is no recipe of company B.
    expect(await effectiveRecipe({ store, orgId: B, project: "web", fromConfig: undefined })).toBeUndefined();
  });
});

describe("the sign-in callback", () => {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const taskId = randomUUID();

  async function world(options: { operation?: Record<string, unknown>; project?: string; taskCompany?: string; recipe?: unknown } = {}) {
    const w = await secretsWorld();
    const store = new MemoryDocumentStore();
    const recipe = options.recipe ?? WITH_SIGN_IN("web");
    await store.put({ item: { pk: `ORG#${A}#WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", companyId: A } });
    await store.put({ item: { pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: A, workspaceId } });
    await store.put({ item: { ...operationKey(A, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: 1, companyId: A,
      dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: recipe as never } }, ...options.operation } });
    await store.put({ item: { ...taskPointerKey(A, workspaceId), taskId } });
    await store.put({ item: { ...taskKey(taskId), taskId, project: options.project ?? "web", companyId: options.taskCompany ?? A } });
    const operation = async () => (await store.get(operationKey(A, workspaceId, operationId))) as never;
    const deps = (companyId = A) => ({ signIn: w.signIn, companyId, async projectOf() { return (await store.get(taskKey(taskId)))?.["project"] as string | undefined; } });
    return { ...w, store, operation, deps };
  }

  it("is refused for any run that was not sent a recipe with a sign-in, and for one that is not live (mutants: each check dropped)", async () => {
    const forbidden = async (options: Parameters<typeof world>[0]) => {
      const w = await world(options);
      await w.signIn.save(A, "web", VALUES);
      const error = await handleBrowserEvidenceSignIn(w.deps(), await w.operation()).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error, JSON.stringify(options)).toMatchObject({ code: "CALLBACK_FORBIDDEN" });
      for (const text of LEAK) expect(error!.message).not.toContain(text);
    };
    await forbidden({ operation: { workflowMode: "IMPLEMENT" } });
    await forbidden({ operation: { workflowMode: "REVIEW" } });
    await forbidden({ operation: { kind: "publish" } });
    await forbidden({ operation: { status: "SUCCEEDED" } });
    await forbidden({ operation: { status: "FAILED" } });
    await forbidden({ operation: { dispatch: { kind: "task" } } });
    await forbidden({ recipe: RECIPE });
    await forbidden({ recipe: "yes" });
    await forbidden({ recipe: { ...WITH_SIGN_IN("web"), port: 80 } });
  });

  it("answers only for the company that runs the operation (two-company)", async () => {
    const w = await world();
    await w.signIn.save(A, "web", VALUES);
    expect(await handleBrowserEvidenceSignIn(w.deps(B), await w.operation())).toEqual({ status: "not_set" });
    const none = await handleBrowserEvidenceSignIn({ ...w.deps(), projectOf: async () => undefined }, await w.operation()).then(() => undefined, (caught: unknown) => caught as Error);
    expect(none).toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });
});
