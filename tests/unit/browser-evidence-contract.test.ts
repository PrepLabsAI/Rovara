// TE-H1 slice 1: browser evidence, the pure half (contracts). The setting, the route recipe, which changed pages are picked, the masks, the caps, the fixed words,
// the evidence-pack check and the pull request's lines. Visual evidence only: it never counts as change proof.
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_CHANGED_FILES_MAX, BROWSER_EVIDENCE_CHECK_ID, BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_NOT_PROOF_WORDS, BROWSER_EVIDENCE_NOT_RUN_WORDS,
  BROWSER_EVIDENCE_NOT_SHOWN_MAX, BROWSER_EVIDENCE_ROUTES_MAX, BROWSER_EVIDENCE_RUN_BY_WORDS, BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, BROWSER_EVIDENCE_SETTING, BROWSER_EVIDENCE_TOTAL_MAX_BYTES,
  BrowserEvidenceRecipeSchema, addBrowserEvidenceToPack, browserEvidenceCheck, browserEvidenceLines, browserEvidenceMaskSelectors, browserEvidenceOn, pickChangedRoutes, scrubVisibleText,
  type BrowserEvidenceOutcome,
} from "../../packages/contracts/src/browser-evidence.js";
import { checkKindInfo } from "../../packages/contracts/src/check-kinds.js";
import { EVIDENCE_ARTIFACT_MAX_BYTES, EvidencePackV2Schema, type ArtifactRef, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";
import { POLICY_FIELDS, resolvePolicy } from "../../packages/contracts/src/policy.js";
import { POLICY_PRESETS } from "../../packages/contracts/src/presets.js";
import { proofHolds, type TestProof } from "../../packages/contracts/src/test-proof.js";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "../../packages/verifier/src/executor/capture.js";

const sha = (c: string) => c.repeat(64);
const jpeg = (c: string, bytes = 1_000): ArtifactRef => ({ kind: "jpeg", sha256: sha(c), bytes, retentionClass: "evidence-std" });
const recipe = (extra: Record<string, unknown> = {}) => ({ startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }, { path: "/settings", files: ["src/settings/**", "src/shared/**"] }], ...extra });

describe("the setting", () => {
  it("is a policy field that is off today, off in every preset, and only an explicit `on` turns it on", () => {
    const field = POLICY_FIELDS.find((row) => row.id === BROWSER_EVIDENCE_SETTING);
    expect(field).toMatchObject({ kind: "ordered_enum", order: ["off", "on"], today: "off", compatibility: true });
    for (const preset of Object.values(POLICY_PRESETS)) expect((preset as Record<string, unknown>)[BROWSER_EVIDENCE_SETTING]).toBe("off");
    expect(browserEvidenceOn(resolvePolicy({}))).toBe(false);
    expect(browserEvidenceOn(resolvePolicy({ project: { preset_level: "careful" } }))).toBe(false);
    expect(browserEvidenceOn(resolvePolicy({ project: { [BROWSER_EVIDENCE_SETTING]: "on" } }))).toBe(true);
    expect(browserEvidenceOn(resolvePolicy({ project: { [BROWSER_EVIDENCE_SETTING]: "off" } }))).toBe(false);
  });
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
  it("picks the recipe routes whose globs match a changed file, in recipe order, each once", () => {
    expect(pickChangedRoutes({ changedFiles: ["src/shared/x.ts", "src/checkout/pay.tsx", "README.md"], recipe: recipe() })).toEqual({ status: "picked", routes: ["/checkout", "/settings"], notShown: [], moreNotShown: 0 });
    expect(pickChangedRoutes({ changedFiles: ["src/settings/a.ts", "src/settings/b.ts"], recipe: recipe() })).toEqual({ status: "picked", routes: ["/settings"], notShown: [], moreNotShown: 0 });
  });
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
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("masking", () => {
  it("paints over passwords, card and code fields, email and phone inputs and marked elements by default, plus the recipe's own selectors", () => {
    for (const selector of ['input[type="password"]', 'input[name*="password" i]', 'input[autocomplete$="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="one-time-code"]', 'input[type="email"]', 'input[type="tel"]', "[data-rovara-mask]", "[data-private]"]) {
      expect(BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, selector).toContain(selector);
    }
    expect(browserEvidenceMaskSelectors(undefined)).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS]);
    expect(browserEvidenceMaskSelectors(recipe({ mask: [".iban", "[data-private]"] }))).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, ".iban"]);
    // A recipe that does not parse keeps the defaults: masking never turns off because of a bad recipe.
    expect(browserEvidenceMaskSelectors({ mask: 3 })).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS]);
  });
  it("replaces emails, tokens, card numbers and phone numbers in visible text, and leaves ordinary words, dates and prices", () => {
    const token = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
    const jwt = ["ey", "J"].join("") + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
    const hex = "0123456789abcdef".repeat(3);
    const text = `Signed in as ada.lovelace+test@example.co.uk. Key ${token}. Session ${jwt}. Id ${hex}. Card 4111 1111 1111 1111. Call +44 20 7946 0958 or (415) 555-0123.`;
    const out = scrubVisibleText(text);
    for (const secret of ["ada.lovelace+test@example.co.uk", token, jwt, hex, "4111 1111 1111 1111", "+44 20 7946 0958", "(415) 555-0123", "555-0123"]) expect(out, secret).not.toContain(secret);
    const gitlab = ["glp", "at-"].join("") + "x".repeat(10) + "Y1z2".repeat(4);
    const twilio = ["S", "K"].join("") + "0123456789abcdef".repeat(2);
    const bearer = `${["Bear", "er"].join("")} abc.DEF-123_xyz~987`;
    const more = scrubVisibleText(`SSN 123-45-6789. IBAN GB82 WEST 1234 5698 7654 32. ${gitlab} ${twilio}. Authorization: ${bearer}. password: Hunter2! api_key=abc123.`);
    for (const secret of ["123-45-6789", "WEST 1234 5698 7654 32", gitlab, twilio, "abc.DEF-123_xyz~987", "Hunter2!", "abc123"]) expect(more, secret).not.toContain(secret);
    expect(out).toContain("Signed in as");
    expect(scrubVisibleText("Order 12 shipped on 2026-11-15 for $1,299.00. Total: 3 items.")).toBe("Order 12 shipped on 2026-11-15 for $1,299.00. Total: 3 items.");
  });
  it("is bounded: very long text is masked whole, and a hostile text finishes fast", () => {
    expect(scrubVisibleText("a".repeat(200_001))).toBe("•••");
    // Text no pattern would touch is still masked whole once it is too long to scan.
    expect(scrubVisibleText("ab ".repeat(66_667))).toBe("•••");
    expect(scrubVisibleText("ab ".repeat(66_666))).toBe("ab ".repeat(66_666));
    const started = performance.now();
    scrubVisibleText(`${"a.".repeat(40_000)}@${"1 ".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("caps", () => {
  it("reuses the e2e screenshot cap and the pack's JPEG cap, and bounds a run", () => {
    expect(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES).toBe(CAPTURE_SCREENSHOT_MAX_BYTES);
    expect(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES).toBe(EVIDENCE_ARTIFACT_MAX_BYTES.jpeg);
    expect(BROWSER_EVIDENCE_TOTAL_MAX_BYTES).toBe(4 * 1_048_576);
    expect(BROWSER_EVIDENCE_ROUTES_MAX).toBe(5);
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
  it("a run that showed nothing is `not_run` with no pairs, and a whole-run reason becomes one not-tested row", () => {
    const { check, notTested } = browserEvidenceCheck({ isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "app_did_not_start" });
    expect(check).toMatchObject({ kind: "visual", before: "not_run", after: "not_run", class: "not_rerun" });
    expect(check.pairs).toBeUndefined();
    expect(notTested).toEqual([{ what: "Browser evidence", reason: "Not run: the app did not start" }]);
  });
  it("NEVER counts toward the proof: the kind is visual, the registry says so, and the hold rule ignores a passing visual check", () => {
    expect(browserEvidenceCheck(shown).check.kind).toBe("visual");
    expect(checkKindInfo("visual")?.countsTowardProof).toBe(false);
    const proof: TestProof = { schemaVersion: 1, candidateDigest: sha("d"), status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 10,
      items: [{ checkId: BROWSER_EVIDENCE_CHECK_ID, label: "Browser evidence", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }] };
    // Positive control: the same entry under a kind that counts is a proven change.
    expect(proofHolds({ facts: { proof, checkKinds: { [BROWSER_EVIDENCE_CHECK_ID]: "e2e" } }, mode: "hold" }).provenCount).toBe(1);
    expect(proofHolds({ facts: { proof, checkKinds: { [BROWSER_EVIDENCE_CHECK_ID]: browserEvidenceCheck(shown).check.kind } }, mode: "hold" }).provenCount).toBe(0);
  });
  it("refuses an outcome it does not understand rather than writing a guess", () => {
    for (const bad of [{ ...shown, isolation: "imported" }, { ...shown, routes: [{ route: "/a", status: "maybe" }] }, { ...shown, routes: [{ route: "/a", status: "not_run", reason: "because" }] },
      { ...shown, routes: Array.from({ length: 6 }, (_, i) => ({ route: `/r${i}`, status: "not_run", reason: "page_did_not_load" })) }, { ...shown, routes: [{ route: "/a", status: "shown", before: jpeg("a", EVIDENCE_ARTIFACT_MAX_BYTES.jpeg + 1), after: jpeg("b") }] }]) {
      expect(() => browserEvidenceCheck(bad as never), JSON.stringify(bad).slice(0, 100)).toThrow("browser evidence outcome is not valid");
    }
  });
});

describe("the pull request's lines", () => {
  it("use the owner's exact words for who ran it and for never-proof", () => {
    expect(BROWSER_EVIDENCE_RUN_BY_WORDS).toEqual({ sandbox: "Run by Rovara in its sandbox", developer_machine: "Ran on a developer machine" });
    expect(BROWSER_EVIDENCE_NOT_PROOF_WORDS).toBe("Visual evidence only: it does not count as change proof.");
    expect(browserEvidenceLines(shown, {})[0]).toBe("Browser evidence: Run by Rovara in its sandbox. Visual evidence only: it does not count as change proof.");
  });
  it("say who ran it and that it is not proof, list each route, and never carry an image or a public link", () => {
    const lines = browserEvidenceLines(shown, { taskLink: "https://rovara.example/tasks/t-1" });
    expect(lines).toEqual([
      `Browser evidence: ${BROWSER_EVIDENCE_RUN_BY_WORDS.sandbox}. ${BROWSER_EVIDENCE_NOT_PROOF_WORDS}`,
      "- `/checkout`: before and after screenshots, 2 console errors after (view behind sign-in: https://rovara.example/tasks/t-1)",
      "- `/settings`: Not run: the page did not load",
      "- `/orders/[id]`: Not shown: needs a route in the recipe",
    ]);
    expect(lines.join("\n")).not.toMatch(/!\[|<img|\.jpe?g|sha256|X-Amz|Signature=/iu);
  });
  it("say Ran on a developer machine on a laptop, and fall back to the task page words with no or a bad link", () => {
    const laptop = browserEvidenceLines({ ...shown, isolation: "developer_machine" }, {});
    expect(laptop[0]).toBe(`Browser evidence: Ran on a developer machine. ${BROWSER_EVIDENCE_NOT_PROOF_WORDS}`);
    expect(laptop[1]).toBe("- `/checkout`: before and after screenshots, 2 console errors after (on the task page, behind sign-in)");
    for (const taskLink of ["javascript:alert(1)", "http://rovara.example/t", "https://x.example/a b", "https://x.example/(a)", `https://x.example/${"a".repeat(400)}`]) {
      expect(browserEvidenceLines(shown, { taskLink })[1], taskLink).toContain("(on the task page, behind sign-in)");
    }
  });
  it("a run that did not happen says Not run with its fixed reason, and the words never echo input", () => {
    expect(browserEvidenceLines({ isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "no_changed_page" }, {})).toEqual([
      `Browser evidence: ${BROWSER_EVIDENCE_RUN_BY_WORDS.sandbox}. ${BROWSER_EVIDENCE_NOT_PROOF_WORDS}`,
      "- Not run: no changed page found",
    ]);
    for (const words of Object.values(BROWSER_EVIDENCE_NOT_RUN_WORDS)) expect(words).toMatch(/^[a-z][a-z ,:-]+$/u);
    expect(() => browserEvidenceLines({ ...shown, routes: [{ route: "/a`<script>", status: "not_run", reason: "page_did_not_load" }] } as never, {})).toThrow("browser evidence outcome is not valid");
  });
  it("count the routes beyond the not-shown list", () => {
    expect(browserEvidenceLines({ ...shown, routes: [], notShown: [], moreNotShown: 7 }, {}).at(-1)).toBe("- 7 more changed pages not shown: more changed pages than the cap");
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
  it("adding it never touches the other checks or rows", () => {
    const pack = basePack();
    const before = JSON.stringify(pack);
    const added = addBrowserEvidenceToPack(pack, shown);
    expect(JSON.stringify(pack)).toBe(before);
    expect(added.checks.slice(0, 1)).toEqual(pack.checks);
    expect(added.checks).toHaveLength(2);
    expect(added.result).toBe(pack.result);
    expect(added.level).toEqual(pack.level);
  });
  it("refuses to add it twice, or to a pack whose producer says another place than the outcome", () => {
    expect(() => addBrowserEvidenceToPack(addBrowserEvidenceToPack(basePack(), shown), shown)).toThrow("browser evidence outcome is not valid");
    expect(() => addBrowserEvidenceToPack({ ...basePack(), producer: { edition: "code", isolation: "developer_machine" } }, shown)).toThrow("browser evidence outcome is not valid");
  });
});
