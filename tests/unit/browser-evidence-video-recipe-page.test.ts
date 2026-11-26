// TE-H1 slice 4: the admin's choice to keep a video of a page that fails. It is one box on the owner's own recipe page (a verified form in a page opened within the last ten minutes, audited), it says plainly that a video cannot be
// masked and what that means, it is refused together with a sign-in, it is never something the setup agent proposes, a config file's recipe that mixes it with a login is no recipe, and one company's choice never reaches another's.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserEvidenceSuggestionSchema, orgProjectCatalogKey, type BrowserEvidenceRecipe } from "@agentx/contracts";
import { createLocalPagesServer, type BrowserEvidencePageView, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { browserEvidenceRecipeFromForm } from "../../packages/broker/src/core/local-pages/browser-evidence-form.js";
import { createLocalConnectionSecrets } from "../../packages/broker/src/local/connection-secrets.js";
import { createLocalSecretStore } from "../../packages/broker/src/ports/secret-stores.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createBrowserEvidenceSignIn } from "../../packages/broker/src/core/proof/browser-evidence-sign-in.js";
import { readStoredRecipe } from "../../packages/broker/src/core/proof/browser-evidence-recipe.js";
import { createLocalBrowserEvidence } from "../../packages/broker/src/local/app/browser-evidence-settings.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { fakeWorld, raw } from "../support/local-pages-fakes.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const FIELDS = { startCommand: "npm run start", port: "3000", readyPath: "/health", framework: "", routes: "/checkout src/checkout/**", mask: "" };
const SIGN_IN_FIELDS = { signInOn: "yes", signInPath: "/login", signInUsername: "#email", signInPassword: "#password", signInSubmit: "button[type=submit]", signInSuccessPath: "/dashboard", signInSuccessSelector: "" };
const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }] };

describe("the form's video box", () => {
  it("is a recipe's `video: { fixtureDataOnly: true }` only when the box is ticked, exactly", () => {
    expect(browserEvidenceRecipeFromForm("web", { ...FIELDS, videoOn: "yes" })?.["video"]).toEqual({ fixtureDataOnly: true });
    for (const value of ["", "no", "on", "true", "YES", "yes "]) {
      const recipe = browserEvidenceRecipeFromForm("web", { ...FIELDS, videoOn: value });
      // ("yes " is trimmed by the form reader like every field; every other spelling is no.)
      if (value === "yes ") expect(recipe?.["video"]).toEqual({ fixtureDataOnly: true });
      else expect(recipe, value).not.toHaveProperty("video");
    }
    expect(browserEvidenceRecipeFromForm("web", FIELDS)).not.toHaveProperty("video");
  });
  it("is refused with a sign-in: the form does not read at all, whole or nothing", () => {
    expect(browserEvidenceRecipeFromForm("web", { ...FIELDS, ...SIGN_IN_FIELDS, videoOn: "yes" })).toBeUndefined();
    expect(browserEvidenceRecipeFromForm("web", { ...FIELDS, ...SIGN_IN_FIELDS })).toBeDefined();
  });
});

describe("the page", () => {
  let server: LocalPagesServer;
  let view: BrowserEvidencePageView;
  let base: string;
  const get = (path: string) => raw(server.origin, { path, headers: { host: new URL(server.origin).host } });
  beforeEach(async () => {
    const world = fakeWorld();
    view = { project: "web", source: "page", version: 2, recipe: RECIPE, signInSaved: false, canRun: true };
    server = await createLocalPagesServer({ data: { ...world.data, async listBrowserEvidenceProjects() { return ["web"]; }, async getBrowserEvidencePage() { return view; } }, actions: world.actions });
    base = `/s/${server.sessions.mint({ ttlMs: 3_600_000 }).token}`;
  });
  afterEach(async () => { await server.close(); });

  it("draws the box unticked for a recipe without video and ticked for one with it, with the warning in plain words beside it", async () => {
    const off = (await get(`${base}/browser-evidence/web`)).body;
    expect(off).toMatch(/<input type="checkbox" name="videoOn" value="yes">/u);
    view = { ...view, recipe: { ...RECIPE, video: { fixtureDataOnly: true } } };
    const on = (await get(`${base}/browser-evidence/web`)).body;
    expect(on).toMatch(/<input type="checkbox" name="videoOn" value="yes" checked>/u);
    for (const words of ["cannot be hidden", "before anything is painted over", "test data only", "not available when the app is behind a login", "drops every video of the run if it finds any", "14 days", "download on the task page, behind your sign-in", "never put on GitHub"]) expect(on, words).toContain(words);
  });
});

describe("the laptop's actions", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });
  async function world() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-be-video-page-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new MemoryDocumentStore();
    for (const [orgId, name] of [[A, "web"], [B, "web"]] as const) await store.put({ item: { ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const audited: Array<Record<string, unknown>> = [];
    const make = (orgId: string) => {
      const secrets = createLocalConnectionSecrets({ directory: join(root, "connection-secrets"), secrets: createLocalSecretStore({ environment: {} }), companyId: orgId, env: "local", now: () => 1_700_000_000_000 });
      return createLocalBrowserEvidence({ store, companyId: orgId, now: () => 1_700_000_000_000, signIn: createBrowserEvidenceSignIn({ secrets, env: "local" }), fromConfig: () => undefined, canRun: async () => true, audit: { async record(event) { audited.push(event as never); } } });
    };
    return { store, audited, a: make(A), b: make(B) };
  }

  it("saves a recipe with video on a fresh page, records that the choice was made, and reads it back as the recipe a run uses; a page that is not fresh changes nothing", async () => {
    const w = await world();
    const recipe = { ...RECIPE, video: { fixtureDataOnly: true } };
    expect(await w.a.action({ op: "save", project: "web", recipe, expectedVersion: undefined } as never, { fresh: false })).toMatchObject({ ok: false, reason: "reauth" });
    expect(await readStoredRecipe(w.store, A, "web")).toBeUndefined();
    expect(await w.a.action({ op: "save", project: "web", recipe } as never, { fresh: true })).toMatchObject({ ok: true });
    expect((await w.a.recipeFor("web"))?.video).toEqual({ fixtureDataOnly: true });
    expect(w.audited.map((event) => [event["action"], JSON.stringify(event["details"])])).toEqual([["browser_evidence.recipe_saved", JSON.stringify({ project: "web", video: "on" })]]);
    // A recipe saved without it leaves the record exactly as before (no `video` key).
    const plain = await world();
    await plain.a.action({ op: "save", project: "web", recipe: RECIPE } as never, { fresh: true });
    expect(plain.audited.map((event) => JSON.stringify(event["details"]))).toEqual([JSON.stringify({ project: "web" })]);
  });
});

describe("where else a recipe comes from", () => {
  it("the setup agent can never propose it: a suggestion with a video does not parse", () => {
    expect(BrowserEvidenceSuggestionSchema.safeParse({ startCommand: "npm start", port: 3000, routes: [] }).success).toBe(true);
    expect(BrowserEvidenceSuggestionSchema.safeParse({ startCommand: "npm start", port: 3000, routes: [], video: { fixtureDataOnly: true } }).success).toBe(false);
  });
});
