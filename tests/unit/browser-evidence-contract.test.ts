// TE-H1 slice 1: browser evidence, the pure half (contracts). The setting, the route recipe, which changed pages are picked, the masks, the caps, the fixed words,
// the evidence-pack check and the pull request's lines. Visual evidence only: it never counts as change proof.
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_CHANGED_FILES_MAX, BROWSER_EVIDENCE_CHECK_ID, BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_NOT_PROOF_WORDS, BROWSER_EVIDENCE_NOT_RUN_WORDS,
  BROWSER_EVIDENCE_NOT_SHOWN_MAX, BROWSER_EVIDENCE_ROUTES_MAX, BROWSER_EVIDENCE_RUN_BY_WORDS, BROWSER_EVIDENCE_SETTING,
  BrowserEvidenceRecipeSchema, addBrowserEvidenceToPack, browserEvidenceCheck, browserEvidenceLines, browserEvidenceMaskSelectors, browserEvidenceOn, pickChangedRoutes,
  type BrowserEvidenceOutcome,
} from "../../packages/contracts/src/browser-evidence.js";
import { EvidencePackV2Schema, type ArtifactRef, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

const sha = (c: string) => c.repeat(64);
const jpeg = (c: string, bytes = 1_000): ArtifactRef => ({ kind: "jpeg", sha256: sha(c), bytes, retentionClass: "evidence-std" });
const recipe = (extra: Record<string, unknown> = {}) => ({ startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }, { path: "/settings", files: ["src/settings/**", "src/shared/**"] }], ...extra });

describe("the setting", () => {
  it("fails closed on anything but a resolved policy whose value is exactly `on`", () => {
    for (const input of [undefined, null, {}, "on", { status: "refused", values: {} }, { status: "disabled", values: { browser_evidence: { value: "on", origin: "install_off" } } },
      { status: "resolved", values: { browser_evidence: { value: "ON", origin: "changed_here" } } }, { status: "resolved", values: { browser_evidence: { value: true, origin: "changed_here" } } },
      { status: "resolved", values: { browser_evidence: "on" } }, { status: "resolved", values: Object.create({ browser_evidence: { value: "on" } }) as unknown }]) {
      expect(browserEvidenceOn(input), JSON.stringify(input)).toBe(false);
    }
    expect(browserEvidenceOn(resolvePolicy({ project: { [BROWSER_EVIDENCE_SETTING]: "on" } }, { installOff: true }))).toBe(false);
  });
});

describe("the recipe", () => {
  it("accepts a start command, a port, routes with globs and masks; refuses unknown keys, odd routes, too many entries", () => {
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ mask: [".account-number"], readyPath: "/health", framework: "nextjs" })).success).toBe(true);
    for (const bad of [
      recipe({ extra: 1 }), recipe({ port: 80 }), recipe({ port: 70_000 }), recipe({ startCommand: "" }), recipe({ startCommand: "npm start\nrm -rf /" }),
      recipe({ routes: [{ path: "checkout", files: ["a"] }] }), recipe({ routes: [{ path: "//evil.example/x", files: ["a"] }] }), recipe({ routes: [{ path: "/a/../b", files: ["a"] }] }),
      recipe({ routes: [{ path: "/a?token=1", files: ["a"] }] }), recipe({ routes: [{ path: "/a", files: [] }] }), recipe({ routes: Array.from({ length: 51 }, (_, i) => ({ path: `/r${i}`, files: ["a"] })) }),
      recipe({ mask: Array.from({ length: 21 }, (_, i) => `.m${i}`) }), recipe({ readyPath: "http://x" }), recipe({ framework: "rails" }),
    ]) expect(BrowserEvidenceRecipeSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
  });
});

describe("which changed pages are picked", () => {
  it("says Not run when nothing changed is a page, when there is no recipe, and refuses input that is not a file list", () => {
    expect(pickChangedRoutes({ changedFiles: ["README.md"], recipe: recipe() })).toEqual({ status: "not_run", reason: "no_changed_page" });
    expect(pickChangedRoutes({ changedFiles: [], recipe: recipe() })).toEqual({ status: "not_run", reason: "no_changed_page" });
    expect(pickChangedRoutes({ changedFiles: ["src/checkout/a.ts"], recipe: undefined })).toEqual({ status: "not_run", reason: "no_recipe" });
    expect(pickChangedRoutes({ changedFiles: ["src/checkout/a.ts"], recipe: { ...recipe(), port: "3000" } })).toEqual({ status: "not_run", reason: "no_recipe" });
    for (const changedFiles of [undefined, "src/checkout/a.ts", [1], ["src/checkout/a.ts", null]]) expect(pickChangedRoutes({ changedFiles, recipe: recipe() })).toEqual({ status: "not_run", reason: "changes_unreadable" });
  });
  it("refuses the whole pick above the changed-file cap instead of picking from part of the list", () => {
    const many = Array.from({ length: BROWSER_EVIDENCE_CHANGED_FILES_MAX + 1 }, (_, i) => `src/checkout/f${i}.ts`);
    expect(pickChangedRoutes({ changedFiles: many, recipe: recipe() })).toEqual({ status: "not_run", reason: "too_many_changed_files" });
    expect(pickChangedRoutes({ changedFiles: many.slice(0, BROWSER_EVIDENCE_CHANGED_FILES_MAX), recipe: recipe() }).status).toBe("picked");
  });
  it("takes at most five routes and lists the rest as not shown, with a bounded list and a count", () => {
    const routes = Array.from({ length: 40 }, (_, i) => ({ path: `/p${i}`, files: [`src/p${i}/**`] }));
    const got = pickChangedRoutes({ changedFiles: routes.map((_, i) => `src/p${i}/x.ts`), recipe: recipe({ routes }) });
    expect(got.status).toBe("picked");
    if (got.status !== "picked") return;
    expect(got.routes).toEqual(["/p0", "/p1", "/p2", "/p3", "/p4"]);
    expect(got.routes).toHaveLength(BROWSER_EVIDENCE_ROUTES_MAX);
    expect(got.notShown).toHaveLength(BROWSER_EVIDENCE_NOT_SHOWN_MAX);
    expect(got.notShown[0]).toEqual({ route: "/p5", reason: "over_route_cap" });
    expect(got.notShown.length + got.moreNotShown).toBe(35);
  });
  it("maps Next.js pages only when the recipe names the framework, and never guesses a dynamic segment", () => {
    const files = ["app/billing/page.tsx", "pages/about.tsx", "pages/index.tsx", "app/orders/[id]/page.tsx", "app/page.tsx", "pages/api/hook.ts", "app/billing/layout.tsx", "pages/_app.tsx"];
    expect(pickChangedRoutes({ changedFiles: files, recipe: recipe({ routes: [{ path: "/x", files: ["nothing/**"] }] }) })).toEqual({ status: "not_run", reason: "no_changed_page" });
    const got = pickChangedRoutes({ changedFiles: files, recipe: recipe({ framework: "nextjs", routes: [{ path: "/x", files: ["nothing/**"] }] }) });
    expect(got).toEqual({ status: "picked", routes: ["/billing", "/about", "/", ], notShown: [{ route: "/orders/[id]", reason: "dynamic_route" }], moreNotShown: 0 });
  });
  it("finishes a customer-sized input within a bounded time", () => {
    const routes = Array.from({ length: 50 }, (_, i) => ({ path: `/r${i}`, files: Array.from({ length: 20 }, (_, j) => `src/**/m${i}-${j}/**/*.tsx`) }));
    const changedFiles = Array.from({ length: BROWSER_EVIDENCE_CHANGED_FILES_MAX }, (_, i) => `src/${"deep/".repeat(20)}file-${i}.ts`);
    const started = performance.now();
    expect(pickChangedRoutes({ changedFiles, recipe: recipe({ routes, framework: "nextjs" }) }).status).toBe("not_run");
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("masking", () => {
  it("paints over passwords, card and code fields, email and phone inputs and marked elements by default, plus the recipe's own selectors", () => {
    for (const selector of ['input[type="password"]', 'input[name*="password" i]', 'input[autocomplete$="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="one-time-code"]', 'input[type="email"]', 'input[type="tel"]', "[data-rovara-mask]", "[data-private]", "canvas"]) {
      expect(BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, selector).toContain(selector);
    }
    expect(browserEvidenceMaskSelectors(undefined)).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS]);
    expect(browserEvidenceMaskSelectors(recipe({ mask: [".iban", "[data-private]"] }))).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, ".iban"]);
    // A recipe that does not parse keeps the defaults: masking never turns off because of a bad recipe.
    expect(browserEvidenceMaskSelectors({ mask: 3 })).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS]);
  });
});

const shown: BrowserEvidenceOutcome = {
  isolation: "sandbox",
  durationMs: 4_200,
  routes: [{ route: "/checkout", status: "shown", before: jpeg("a"), after: jpeg("b"), consoleErrors: { before: 0, after: 2 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }],
  notShown: [{ route: "/orders/[id]", reason: "dynamic_route" }],
  moreNotShown: 0,
};
const basePack = (): EvidencePackV2 => ({
  schemaVersion: 2,
  candidate: { digest: sha("c"), repositories: [] },
  producer: { edition: "code", isolation: "sandbox" },
  level: { reached: "sandbox_only", required: [] },
  result: "verified",
  checks: [{ id: "unit", kind: "test", label: "Unit tests", before: "failed", after: "passed", class: "fixed", durationMs: 10 }],
  notTested: [],
});

describe("the evidence-pack check", () => {
  it("is a `visual` check run by Rovara in the sandbox, with one before/after pair per shown route, and a not-tested row for every route not shown", () => {
    const { check, notTested } = browserEvidenceCheck(shown);
    expect(check).toEqual({ id: BROWSER_EVIDENCE_CHECK_ID, kind: "visual", label: "Browser evidence", stage: "sandbox", runBy: "rovara", before: "passed", after: "passed", class: "not_rerun", durationMs: 4_200,
      pairs: [{ id: "/checkout", before: jpeg("a"), after: jpeg("b") }] });
    expect(notTested).toEqual([
      { what: "Browser evidence: /settings", reason: "Not run: the page did not load" },
      { what: "Browser evidence: /orders/[id]", reason: "Not shown: needs a route in the recipe" },
    ]);
    expect(EvidencePackV2Schema.safeParse(addBrowserEvidenceToPack(basePack(), shown)).success).toBe(true);
    // A laptop run has no sandbox stage: the producer says where it ran.
    expect(browserEvidenceCheck({ ...shown, isolation: "developer_machine" }).check.stage).toBeUndefined();
  });
});

describe("the pull request's lines", () => {
  it("a run that did not happen says Not run with its fixed reason, and the words never echo input", () => {
    expect(browserEvidenceLines({ isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "no_changed_page" }, {})).toEqual([
      `Browser evidence: ${BROWSER_EVIDENCE_RUN_BY_WORDS.sandbox}. ${BROWSER_EVIDENCE_NOT_PROOF_WORDS}`,
      "- Not run: no changed page found",
    ]);
    for (const words of Object.values(BROWSER_EVIDENCE_NOT_RUN_WORDS)) expect(words).toMatch(/^[a-z][a-z ,:-]+$/u);
    expect(() => browserEvidenceLines({ ...shown, routes: [{ route: "/a`<script>", status: "not_run", reason: "page_did_not_load" }] } as never, {})).toThrow("browser evidence outcome is not valid");
  });
});

describe("absent = today's behaviour, byte for byte", () => {
  it("with no browser evidence the pack is the same object, the same bytes, and the PR gets no line", () => {
    const pack = basePack();
    const before = JSON.stringify(pack);
    expect(addBrowserEvidenceToPack(pack, undefined)).toBe(pack);
    expect(JSON.stringify(addBrowserEvidenceToPack(pack, undefined))).toBe(before);
    expect(browserEvidenceLines(undefined, {})).toEqual([]);
  });
  it("refuses to add it twice, or to a pack whose producer says another place than the outcome", () => {
    expect(() => addBrowserEvidenceToPack(addBrowserEvidenceToPack(basePack(), shown), shown)).toThrow("browser evidence outcome is not valid");
    expect(() => addBrowserEvidenceToPack({ ...basePack(), producer: { edition: "code", isolation: "developer_machine" } }, shown)).toThrow("browser evidence outcome is not valid");
  });
});
