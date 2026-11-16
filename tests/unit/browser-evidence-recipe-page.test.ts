// TE-H1 browser evidence, slice 3: the recipe page. It reads a form as a recipe whole-or-nothing, draws the recipe in force without ever drawing a saved value, takes a change only as one verified form in a page opened within the last ten
// minutes, and answers every post with a fixed notice. The laptop's actions (fresh page, config wins, two companies, the API's refusal) are tested against the real store and the real secret files.
import { mkdtemp, readdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orgProjectCatalogKey, type BrowserEvidenceRecipe } from "@agentx/contracts";
import { createLocalPagesServer, type BrowserEvidencePageAction, type BrowserEvidencePageView, type LocalActionResult, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { browserEvidenceRecipeFromForm } from "../../packages/broker/src/core/local-pages/browser-evidence-form.js";
import { createLocalConnectionSecrets } from "../../packages/broker/src/connections/local-secrets.js";
import { createLocalSecretStore } from "../../packages/broker/src/ports/secret-stores.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createBrowserEvidenceSignIn } from "../../packages/broker/src/core/proof/browser-evidence-sign-in.js";
import { readStoredRecipe, saveStoredRecipe } from "../../packages/broker/src/core/proof/browser-evidence-recipe.js";
import { BROWSER_EVIDENCE_ON_THE_PAGE, NEEDS_FRESH_PAGE, createLocalBrowserEvidence } from "../../packages/broker/src/local/app/browser-evidence-settings.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { fakeWorld, formBody, raw } from "../support/local-pages-fakes.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
/** Built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection. */
const VALUES = { username: ["tester", "example"].join("@") + ".test", password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
const LEAK = [VALUES.username, VALUES.password, encodeURIComponent(VALUES.password), Buffer.from(VALUES.password).toString("base64")];

const FIELDS = { startCommand: "npm run start", port: "3000", readyPath: "/health", framework: "", routes: "/checkout src/checkout/**, src/cart/**\n/settings src/settings/**", mask: ".banner\n#promo" };
const SIGN_IN_FIELDS = { signInOn: "yes", signInPath: "/login", signInUsername: "#email", signInPassword: "#password", signInSubmit: "button[type=submit]", signInSuccessPath: "/dashboard", signInSuccessSelector: "" };

describe("a form as a recipe", () => {
  it("reads the fields as the recipe they say, with the sign-in's reference made from the project and never from the form", () => {
    expect(browserEvidenceRecipeFromForm("web", FIELDS)).toEqual({
      startCommand: "npm run start", port: 3000, readyPath: "/health", routes: [{ path: "/checkout", files: ["src/checkout/**", "src/cart/**"] }, { path: "/settings", files: ["src/settings/**"] }], mask: [".banner", "#promo"],
    });
    const signed = browserEvidenceRecipeFromForm("web", { ...FIELDS, ...SIGN_IN_FIELDS, signInRef: "con_aaaaaaaaaaaaaaaaaaaa", credentialRef: "be-other-signin" });
    expect(signed?.["signIn"]).toEqual({ path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]", successPath: "/dashboard", credentialRef: "be-web-signin" });
    // A sign-in that is not asked for is not in the recipe, whatever else the form says about it.
    expect(browserEvidenceRecipeFromForm("web", { ...FIELDS, signInPath: "/login", signInOn: "no" })).not.toHaveProperty("signIn");
    expect(browserEvidenceRecipeFromForm("web", { ...FIELDS, framework: "nextjs" })?.["framework"]).toBe("nextjs");
  });

  it("is the whole recipe or none: a line that does not read, a number that is not one, a framework nobody offers, too many lines (mutant: a line quietly left out)", () => {
    const bad: Array<Record<string, string>> = [
      { ...FIELDS, port: "abc" }, { ...FIELDS, port: "" }, { ...FIELDS, port: "-3" }, { ...FIELDS, startCommand: "" }, { ...FIELDS, startCommand: "npm\u0000start" },
      { ...FIELDS, routes: "/checkout" }, { ...FIELDS, routes: "/checkout src/**\n/settings" }, { ...FIELDS, framework: "rails" },
      { ...FIELDS, routes: Array.from({ length: 51 }, (_, index) => `/p${String(index)} src/**`).join("\n") }, { ...FIELDS, mask: Array.from({ length: 21 }, (_, index) => `.m${String(index)}`).join("\n") },
    ];
    for (const fields of bad) expect(browserEvidenceRecipeFromForm("web", fields), JSON.stringify(fields).slice(0, 80)).toBeUndefined();
    expect(browserEvidenceRecipeFromForm("Not A Project", { ...FIELDS, ...SIGN_IN_FIELDS })).toBeUndefined();
    expect(browserEvidenceRecipeFromForm("web", {})).toBeUndefined();
  });

  it("hands the schema what it must judge: a sign-in with no way to tell a signed-in page is no recipe once saved", async () => {
    const store = new MemoryDocumentStore();
    const incomplete = browserEvidenceRecipeFromForm("web", { ...FIELDS, ...SIGN_IN_FIELDS, signInSuccessPath: "" });
    await expect(saveStoredRecipe(store, A, "web", incomplete, { expectedVersion: undefined, now: () => 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- the page, on the real server with a fake data source

const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 3000, readyPath: "/health", routes: [{ path: "/checkout", files: ["src/checkout/**"] }], mask: [".banner"] };
type Call = { input: BrowserEvidencePageAction; fresh: boolean };

describe("the recipe page", () => {
  let server: LocalPagesServer;
  let clock = 1_000_000;
  let view: BrowserEvidencePageView | undefined;
  const current = (): BrowserEvidencePageView => { if (view === undefined) throw new Error("no view"); return view; };
  let calls: Call[];
  let next: LocalActionResult;
  let token: string;
  let base: string;
  const host = () => new URL(server.origin).host;
  const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });
  const post = (path: string, fields: Record<string, string>) => raw(server.origin, { method: "POST", path, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });
  /** The hidden fields of the form on the page whose `op` is `op`, as the page drew them now (each form answers once). */
  const formOfOp = async (op: string, query = ""): Promise<{ action: string; fields: Record<string, string>; html: string }> => {
    const html = (await get(`${base}/browser-evidence/web${query}`)).body;
    const decode = (text: string) => text.replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
    for (const match of html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gu)) {
      const fields: Record<string, string> = {};
      for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
      if (fields["op"] === op) return { action: decode(match[1] ?? ""), fields, html };
    }
    throw new Error(`no form with op ${op}`);
  };
  const locationOf = (reply: { headers: Record<string, string | string[] | undefined> }): string => String(reply.headers["location"] ?? "");

  beforeEach(async () => {
    const world = fakeWorld();
    calls = [];
    next = { ok: true };
    view = { project: "web", source: "page", version: 2, recipe: RECIPE, signInSaved: false, canRun: true };
    server = await createLocalPagesServer({
      now: () => clock,
      data: { ...world.data, async listBrowserEvidenceProjects() { return ["web", "api"]; }, async getBrowserEvidencePage(project) { return project === "web" ? view : undefined; } },
      actions: { ...world.actions, async browserEvidence(input, context) { calls.push({ input, fresh: context.fresh }); return next; } },
    });
    token = server.sessions.mint({ ttlMs: 3_600_000 }).token;
    base = `/s/${token}`;
  });
  afterEach(async () => { await server.close(); });

  it("lists the projects, draws the recipe in force, and is not there for a project it does not know", async () => {
    const index = await get(`${base}/browser-evidence`);
    expect(index.status).toBe(200);
    expect(index.body).toContain('href="' + base + '/browser-evidence/web"');
    const page = await get(`${base}/browser-evidence/web`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Browser evidence is on for this project.");
    expect(page.body).toContain("Visual evidence only: it does not count as change proof.");
    expect(page.body).toContain('value="npm run start"');
    expect((await get(`${base}/browser-evidence/api`)).status).toBe(404);
    expect((await get(`${base}/browser-evidence/Nope!`)).status).toBe(404);
    // The recipe from the owner's config file is shown and not offered for change.
    view = { ...current(), source: "config" };
    const fromConfig = await get(`${base}/browser-evidence/web`);
    expect(fromConfig.body).toContain("your config file");
    expect(fromConfig.body).not.toContain('name="startCommand"');
    // No recipe at all says it is off.
    view = { project: "web", source: "none", signInSaved: false, canRun: false };
    const off = (await get(`${base}/browser-evidence/web`)).body;
    expect(off).toContain("Browser evidence is off for this project");
    expect(off).toContain("ROVARA_EXECUTOR_IMAGE");
  });

  it("is not on a server that has no such page", async () => {
    const bare = await createLocalPagesServer({ data: fakeWorld().data, actions: fakeWorld().actions });
    const t = bare.sessions.mint().token;
    try {
      for (const path of ["/browser-evidence", "/browser-evidence/web"]) expect((await raw(bare.origin, { path: `/s/${t}${path}`, headers: { host: new URL(bare.origin).host } })).status, path).toBe(404);
      const form = await raw(bare.origin, { method: "POST", path: `/s/${t}/browser-evidence/web/act`, body: formBody({ op: "turn-off", ft: "x" }), headers: { host: new URL(bare.origin).host, origin: bare.origin, "content-type": "application/x-www-form-urlencoded" } });
      expect(form.status).toBe(404);
    } finally { await bare.close(); }
  });

  it("never draws a saved value: only that a sign-in is saved, and the password box is empty and a password box", async () => {
    view = { ...current(), signInSaved: true, recipe: { ...RECIPE, signIn: { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard", credentialRef: "be-web-signin" } } };
    const html = (await get(`${base}/browser-evidence/web`)).body;
    expect(html).toContain("A sign-in is saved for this project. Its values are never shown.");
    expect(html).toContain("Replace the saved sign-in");
    expect(html).toContain("Remove the saved sign-in");
    expect(html).toMatch(/<input type="password" name="password"[^>]*autocomplete="new-password">/u);
    expect(html).not.toMatch(/name="(?:username|password)"[^>]*value=/u);
    expect(html).toContain('value="#email"');
    view = { ...current(), signInSaved: false };
    expect((await get(`${base}/browser-evidence/web`)).body).toContain("No sign-in is saved.");
  });

  it("shows the setup agent's suggestion as plain text, and starts the form from it only when asked (nothing is saved)", async () => {
    view = { project: "web", source: "none", signInSaved: false, canRun: true, suggestion: {
      recipe: { startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**", "<script>alert(1)</script>"] }] }, from: ["web/package.json:8"], verdict: "unchecked" } };
    const page = (await get(`${base}/browser-evidence/web`)).body;
    expect(page).toContain("What Rovara suggests");
    expect(page).toContain("not checked against the repository");
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The form is empty until the owner asks to start from the suggestion; asking changes nothing but the page.
    expect(page).not.toContain('value="npm run start"');
    expect((await get(`${base}/browser-evidence/web?suggestion=1`)).body).toContain('value="npm run start"');
    expect(calls).toEqual([]);
    const suggested = current().suggestion;
    if (suggested === undefined) throw new Error("no suggestion");
    view = { ...current(), suggestion: { ...suggested, verdict: "unverified" } };
    expect((await get(`${base}/browser-evidence/web`)).body).toContain("not found where it says");
  });

  it("saves the recipe from one verified form, in a fresh page, and the action gets the recipe as the form said it", async () => {
    const form = await formOfOp("save");
    const sent = { ...form.fields, ...FIELDS, ...SIGN_IN_FIELDS };
    const reply = await post(form.action, sent);
    expect(reply.status).toBe(303);
    expect(locationOf(reply)).toBe(`${base}/browser-evidence/web?n=bevsaved`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fresh: true, input: { op: "save", project: "web", expectedVersion: 2, recipe: { startCommand: "npm run start", port: 3000, signIn: { credentialRef: "be-web-signin" } } } });
  });

  it("refuses a form that does not read, with no call (mutant: a recipe sent on that did not parse)", async () => {
    const form = await formOfOp("save");
    const reply = await post(form.action, { ...form.fields, ...FIELDS, port: "x" });
    expect(locationOf(reply)).toBe(`${base}/browser-evidence/web?n=invalid`);
    expect(calls).toEqual([]);
  });

  it("takes a form once, only for its own operation and project, and only with its token (mutants: the token, its single use, its subject dropped)", async () => {
    const form = await formOfOp("save");
    expect(locationOf(await post(form.action, { ...form.fields, ft: "", ...FIELDS }))).toBe(`${base}/browser-evidence/web?n=form`);
    expect(locationOf(await post(form.action, { ...form.fields, ft: "forged", ...FIELDS }))).toBe(`${base}/browser-evidence/web?n=form`);
    expect(calls).toEqual([]);
    // A token drawn for one operation does not do for another.
    const off = await formOfOp("turn-off");
    expect(locationOf(await post(off.action, { ...off.fields, op: "clear-sign-in" }))).toBe(`${base}/browser-evidence/web?n=form`);
    expect(locationOf(await post(off.action, { ...off.fields, op: "save" }))).toBe(`${base}/browser-evidence/web?n=form`);
    // A token drawn for this project does not do for another.
    const other = await post(`${base}/browser-evidence/api/act`, { ...off.fields });
    expect(other.status === 404 || locationOf(other).includes("n=form")).toBe(true);
    expect(calls).toEqual([]);
    // It answers once.
    const first = await post(form.action, { ...form.fields, ...FIELDS });
    expect(locationOf(first)).toContain("n=bevsaved");
    expect(locationOf(await post(form.action, { ...form.fields, ...FIELDS }))).toBe(`${base}/browser-evidence/web?n=form`);
    expect(calls).toHaveLength(1);
    expect(locationOf(await post(form.action, { ...form.fields, op: "wipe", ...FIELDS }))).toBe(`${base}/browser-evidence/web?n=invalid`);
  });

  it("is not done in a page opened more than ten minutes ago, and the action is not even called (mutant: the age check dropped)", async () => {
    // The page session was opened at the start; the form is drawn and posted eleven minutes later, with its own fresh token.
    clock += 11 * 60 * 1000;
    const form = await formOfOp("save");
    const aged = await post(form.action, { ...form.fields, ...FIELDS });
    expect(aged.status).toBe(303);
    expect(locationOf(aged)).toBe(`${base}/browser-evidence/web?n=bevfresh`);
    const sign = await formOfOp("save-sign-in");
    expect(locationOf(await post(sign.action, { ...sign.fields, username: VALUES.username, password: VALUES.password }))).toBe(`${base}/browser-evidence/web?n=bevfresh`);
    expect(calls).toEqual([]);
    // The page itself is still there to read, and says it is too old to change anything.
    expect((await get(`${base}/browser-evidence/web`)).body).toContain("too old to change anything");
  });

  it("takes the sign-in's values from the form and shows them nowhere afterwards: not in the answer, the address, the notice or the next page", async () => {
    view = { ...current(), signInSaved: false };
    const form = await formOfOp("save-sign-in");
    const reply = await post(form.action, { ...form.fields, username: VALUES.username, password: VALUES.password });
    expect(reply.status).toBe(303);
    expect(locationOf(reply)).toBe(`${base}/browser-evidence/web?n=bevsignin`);
    expect(calls).toEqual([{ fresh: true, input: { op: "save-sign-in", project: "web", username: VALUES.username, password: VALUES.password } }]);
    for (const text of LEAK) { expect(reply.body).not.toContain(text); expect(JSON.stringify(reply.headers)).not.toContain(text); }
    const after = await get(`${base}/browser-evidence/web?n=bevsignin`);
    for (const text of LEAK) expect(after.body).not.toContain(text);
    expect(after.body).toContain("The sign-in is saved. Its values are not shown again.");
  });

  it("answers a refusal with a fixed notice, never the action's own words (which could hold a value)", async () => {
    next = { ok: false, reason: "refused", message: `The password ${VALUES.password} was refused` };
    const form = await formOfOp("save-sign-in");
    const reply = await post(form.action, { ...form.fields, username: VALUES.username, password: VALUES.password });
    expect(locationOf(reply)).toBe(`${base}/browser-evidence/web?n=refused`);
    for (const text of LEAK) { expect(locationOf(reply)).not.toContain(encodeURIComponent(text)); expect(reply.body).not.toContain(text); }
    next = { ok: false, reason: "stale", message: "x" };
    expect(locationOf(await post((await formOfOp("save")).action, { ...(await formOfOp("save")).fields, ...FIELDS }))).toBe(`${base}/browser-evidence/web?n=stale`);
  });

  it("needs both values to save a sign-in, and takes remove and turn-off as plain forms", async () => {
    const form = await formOfOp("save-sign-in");
    expect(locationOf(await post(form.action, { ...form.fields, username: VALUES.username, password: "" }))).toBe(`${base}/browser-evidence/web?n=invalid`);
    expect(calls).toEqual([]);
    view = { ...current(), signInSaved: true };
    const clear = await formOfOp("clear-sign-in");
    expect(locationOf(await post(clear.action, clear.fields))).toBe(`${base}/browser-evidence/web?n=bevsigninoff`);
    const off = await formOfOp("turn-off");
    expect(locationOf(await post(off.action, off.fields))).toBe(`${base}/browser-evidence/web?n=bevoff`);
    expect(calls.map((call) => call.input.op)).toEqual(["clear-sign-in", "turn-off"]);
  });
});

// ---- the laptop's actions, on the real store and the real secret files

describe("the recipe page's actions on a laptop", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

  async function world(options: { config?: Record<string, BrowserEvidenceRecipe> } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-be-page-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "connection-secrets");
    const store = new MemoryDocumentStore();
    for (const [orgId, name] of [[A, "web"], [A, "api"], [B, "other"]] as const) await store.put({ item: { ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const audited: Array<Record<string, unknown>> = [];
    const make = (orgId: string) => {
      const secrets = createLocalConnectionSecrets({ directory, secrets: createLocalSecretStore({ environment: {} }), companyId: orgId, env: "local", now: () => 1_700_000_000_000 });
      return createLocalBrowserEvidence({
        store, companyId: orgId, now: () => 1_700_000_000_000, signIn: createBrowserEvidenceSignIn({ secrets, env: "local" }), fromConfig: (project) => options.config?.[project], canRun: async () => true,
        audit: { async record(event) { audited.push(event as never); } },
      });
    };
    return { store, directory, audited, a: make(A), b: make(B) };
  }
  const files = async (directory: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) out.push(...(entry.isDirectory() ? (await files(join(directory, entry.name))).map((file) => join(entry.name, file)) : [entry.name]));
    return out;
  };

  it("changes nothing in a page that is not fresh, and says so in one fixed sentence (mutant: the freshness check dropped)", async () => {
    const w = await world();
    for (const input of [{ op: "save", project: "web", recipe: RECIPE }, { op: "turn-off", project: "web" }, { op: "save-sign-in", project: "web", ...VALUES }, { op: "clear-sign-in", project: "web" }] as const) {
      expect(await w.a.action(input as BrowserEvidencePageAction, { fresh: false }), input.op).toEqual({ ok: false, reason: "reauth", message: NEEDS_FRESH_PAGE });
    }
    expect(await readStoredRecipe(w.store, A, "web")).toBeUndefined();
    expect(await files(w.directory)).toEqual([]);
    expect(w.audited).toEqual([]);
  });

  it("saves, reads and removes the recipe and the sign-in for the project, writes an audit line with no value in it, and the page view holds no value", async () => {
    const w = await world();
    expect(await w.a.action({ op: "save", project: "web", recipe: { ...RECIPE, signIn: { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard", credentialRef: "be-web-signin" } } }, { fresh: true })).toEqual({ ok: true, message: "Saved." });
    expect(await w.a.action({ op: "save-sign-in", project: "web", username: VALUES.username, password: VALUES.password }, { fresh: true })).toEqual({ ok: true, message: "The sign-in is saved." });
    const page = await w.a.page("web");
    expect(page).toMatchObject({ project: "web", source: "page", version: 1, signInSaved: true, canRun: true });
    for (const text of LEAK) expect(JSON.stringify(page)).not.toContain(text);
    expect((await w.a.recipeFor("web"))?.signIn?.credentialRef).toBe("be-web-signin");
    expect(w.audited.map((event) => event["action"])).toEqual(["browser_evidence.recipe_saved", "browser_evidence.sign_in_saved"]);
    for (const event of w.audited) { for (const text of LEAK) expect(JSON.stringify(event)).not.toContain(text); expect(event["details"]).toEqual({ project: "web" }); }
    await w.a.action({ op: "clear-sign-in", project: "web" }, { fresh: true });
    expect((await w.a.page("web"))?.signInSaved).toBe(false);
    expect(await files(w.directory)).toEqual([]);
    await w.a.action({ op: "turn-off", project: "web" }, { fresh: true });
    expect(await w.a.recipeFor("web")).toBeUndefined();
    expect((await w.a.page("web"))?.source).toBe("none");
  });

  it("keeps company A's recipe and sign-in out of company B's, and B's project list out of A's (two-company)", async () => {
    const w = await world();
    await w.a.action({ op: "save", project: "web", recipe: RECIPE }, { fresh: true });
    await w.a.action({ op: "save-sign-in", project: "web", ...VALUES }, { fresh: true });
    expect(await w.b.recipeFor("web")).toBeUndefined();
    expect(await w.b.page("web")).toBeUndefined();
    expect(await w.b.projects()).toEqual(["other"]);
    expect(await w.b.action({ op: "save", project: "web", recipe: RECIPE }, { fresh: true })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await w.b.action({ op: "save-sign-in", project: "web", ...VALUES }, { fresh: true })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await w.b.signInReader.read(B, "web", "be-web-signin")).toBeUndefined();
    expect(await w.a.signInReader.read(A, "web", "be-web-signin")).toEqual(VALUES);
    expect(await w.a.projects()).toEqual(["api", "web"]);
  });

  it("answers a project it does not know, and a recipe or sign-in that is not valid, with one fixed sentence that holds no value", async () => {
    const w = await world();
    expect(await w.a.action({ op: "save", project: "ghost", recipe: RECIPE }, { fresh: true })).toEqual({ ok: false, reason: "not_found", message: "That project is not here." });
    const bad = await w.a.action({ op: "save", project: "web", recipe: { ...RECIPE, port: 80 } }, { fresh: true });
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    const otherProjectsSignIn = await w.a.action({ op: "save", project: "web", recipe: { ...RECIPE, signIn: { path: "/login", usernameSelector: "#e", passwordSelector: "#p", submitSelector: "b", successPath: "/d", credentialRef: "be-api-signin" } } }, { fresh: true });
    expect(otherProjectsSignIn).toMatchObject({ ok: false, reason: "invalid" });
    const short = await w.a.action({ op: "save-sign-in", project: "web", username: "ab", password: VALUES.password }, { fresh: true });
    expect(short).toMatchObject({ ok: false, reason: "invalid" });
    for (const text of LEAK) expect(JSON.stringify([bad, otherProjectsSignIn, short])).not.toContain(text);
    expect(await files(w.directory)).toEqual([]);
  });

  it("lets the owner's config file win: a project it names is not saved or turned off on the page, and it is the recipe a run uses", async () => {
    const w = await world({ config: { web: { ...RECIPE, port: 4000 } } });
    expect(await w.a.action({ op: "save", project: "web", recipe: RECIPE }, { fresh: true })).toEqual({ ok: false, reason: "refused", message: "This project's recipe is set in your config file. Change it there." });
    expect(await w.a.action({ op: "turn-off", project: "web" }, { fresh: true })).toMatchObject({ ok: false, reason: "refused" });
    expect((await w.a.recipeFor("web"))?.port).toBe(4000);
    expect((await w.a.page("web"))?.source).toBe("config");
    // The saved sign-in is still the page's to keep: a config recipe may name it.
    expect(await w.a.action({ op: "save-sign-in", project: "web", ...VALUES }, { fresh: true })).toMatchObject({ ok: true });
    // A project the config does not name is the page's.
    expect(await w.a.action({ op: "save", project: "api", recipe: RECIPE }, { fresh: true })).toMatchObject({ ok: true });
  });

  it("refuses the API token for every method on the recipe and sign-in addresses, with the page's own sentence, and leaves other addresses alone", async () => {
    const w = await world();
    for (const method of ["GET", "PUT", "POST", "DELETE", "PATCH"]) {
      for (const path of ["/v1/app/projects/web/browser-evidence", "/v1/app/projects/web/browser-evidence/sign-in", "/v1/app/projects/web/browser-evidence?x=1"]) {
        const reply = await w.a.routes({ method, path, headers: {}, body: JSON.stringify({ username: VALUES.username, password: VALUES.password }) });
        expect(reply?.statusCode, `${method} ${path}`).toBe(403);
        expect(JSON.parse(reply!.body ?? "{}")).toEqual({ error: { code: "FORBIDDEN", message: BROWSER_EVIDENCE_ON_THE_PAGE } });
        for (const text of LEAK) expect(reply!.body).not.toContain(text);
      }
    }
    for (const path of ["/v1/app/projects/web", "/v1/app/projects/web/browser-evidence/other", "/v1/app/projects/Web/browser-evidence", "/v1/dev/tasks"]) expect(await w.a.routes({ method: "GET", path, headers: {} }), path).toBeUndefined();
    expect(await files(w.directory)).toEqual([]);
  });

  it("keeps the saved values only in the owner's secret file, in the company's own folder", async () => {
    const w = await world();
    await w.a.action({ op: "save-sign-in", project: "web", ...VALUES }, { fresh: true });
    const found = await files(w.directory);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`^${A}/be-web-signin\\.`, "u"));
    expect(JSON.parse(await readFile(join(w.directory, found[0]!), "utf8"))).toEqual(VALUES);
    // Nothing else the page wrote holds a value: the document store has the recipe rows only.
    const rows = await w.store.query({ pk: `ORG#${A}#PROJECT#web` });
    for (const text of LEAK) expect(JSON.stringify(rows.items)).not.toContain(text);
  });
});
