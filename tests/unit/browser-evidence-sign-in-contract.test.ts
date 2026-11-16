// TE-H1 browser evidence, slice 3: the sign-in recipe and the recipe's new words (contracts). A recipe never holds a secret: only the form of the login and the NAME of the saved sign-in. The saved values are a user name and a
// password of a test account; this file checks the shapes, the references, the masks built from the values and the plan the capture program is given. Nothing here may put a value in a recipe, a plan or a line of words.
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_MASK_SELECTORS_MAX, BROWSER_EVIDENCE_NOT_RUN_REASONS, BROWSER_EVIDENCE_NOT_RUN_WORDS, BROWSER_EVIDENCE_SIGN_IN_REF_PATTERN, BrowserEvidenceRecipeSchema, BrowserEvidenceSignInSchema, BrowserEvidenceSignInValuesSchema,
  BrowserEvidenceSuggestionSchema, browserEvidenceLines, browserEvidenceMaskSelectors, browserEvidenceSecretMasks, browserEvidenceSignInRef, isBrowserEvidenceSignInRefOf, pickChangedRoutes, recipeMaskSelectors, withDefaultMasks,
  type BrowserEvidenceOutcome,
} from "../../packages/contracts/src/browser-evidence.js";
import {
  BROWSER_EVIDENCE_SIGN_IN_ENV, BROWSER_EVIDENCE_SIGN_IN_ENV_MAX, BrowserEvidenceExecutorLineSchema, BrowserEvidenceExecutorPlanSchema, BrowserEvidenceSignInAnswerSchema,
  decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceSignInEnv, encodeBrowserEvidenceExecutorPlan, encodeBrowserEvidenceSignInEnv,
} from "../../packages/contracts/src/browser-evidence-wire.js";

const signIn = (extra: Record<string, unknown> = {}) => ({
  path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]", successPath: "/dashboard", credentialRef: "be-web-signin", ...extra,
});
const recipe = (extra: Record<string, unknown> = {}) => ({ startCommand: "npm run start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }], ...extra });
/** Values built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection. */
const VALUES = { username: ["tester", "example"].join("@") + ".test", password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };

describe("a recipe without a sign-in is exactly today's recipe", () => {
  it("parses to the same object and picks the same pages (golden)", () => {
    const given = recipe({ readyPath: "/health", framework: "nextjs", mask: ["#banner"] });
    expect(BrowserEvidenceRecipeSchema.parse(given)).toEqual(given);
    expect(pickChangedRoutes({ changedFiles: ["src/checkout/page.tsx"], recipe: given })).toMatchObject({ status: "picked", routes: ["/checkout"] });
    expect(browserEvidenceMaskSelectors(given)).toEqual(withDefaultMasks(["#banner"]));
  });
});

describe("the sign-in recipe", () => {
  it("is a login form and the name of the saved sign-in, nothing more", () => {
    const parsed = BrowserEvidenceRecipeSchema.parse(recipe({ signIn: signIn() }));
    expect(parsed.signIn).toEqual(signIn());
    expect(Object.keys(parsed.signIn!).sort()).toEqual(["credentialRef", "passwordSelector", "path", "submitSelector", "successPath", "usernameSelector"]);
    expect(BrowserEvidenceSignInSchema.safeParse(signIn({ successPath: undefined, successSelector: "#signed-in" })).success).toBe(true);
  });

  it("refuses a sign-in that is not whole, or that says something it should not (mutant: a refinement dropped)", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["no way to tell a signed-in page", signIn({ successPath: undefined })],
      ["the signed-in page is the login page", signIn({ successPath: "/login" })],
      ["a query on the login page", signIn({ path: "/login?next=/x" })],
      ["another origin", signIn({ path: "https://evil.example/login" })],
      ["a password field named by a value", signIn({ password: "hunter22" })],
      ["a user name field named by a value", signIn({ username: "someone" })],
      ["a hidden character in a selector", signIn({ usernameSelector: "#em\u0000ail" })],
      ["a selector over 200 characters", signIn({ submitSelector: "a".repeat(201) })],
      ["no credential reference", signIn({ credentialRef: undefined })],
    ];
    for (const [label, value] of bad) expect(BrowserEvidenceSignInSchema.safeParse(value).success, label).toBe(false);
  });

  it("names the saved sign-in only by the project's own reference, in a shape no connection or server can have", () => {
    expect(browserEvidenceSignInRef("web")).toBe("be-web-signin");
    expect(browserEvidenceSignInRef("Web")).toBeUndefined();
    expect(browserEvidenceSignInRef("../x")).toBeUndefined();
    expect(browserEvidenceSignInRef(undefined)).toBeUndefined();
    expect(isBrowserEvidenceSignInRefOf("web", "be-web-signin")).toBe(true);
    expect(isBrowserEvidenceSignInRefOf("web", "be-other-signin")).toBe(false);
    expect(isBrowserEvidenceSignInRefOf("other", "be-web-signin")).toBe(false);
    expect(isBrowserEvidenceSignInRefOf(undefined, "be-web-signin")).toBe(false);
    for (const ref of ["con_aaaaaaaaaaaaaaaaaaaa", "mcpabcdef1234", "be-web", "BE-web-signin", "be--signin", "be-web-signin/extra", "be-web-signin ", "../be-web-signin", "be-web-signin\n"]) {
      expect(BROWSER_EVIDENCE_SIGN_IN_REF_PATTERN.test(ref), ref).toBe(false);
      expect(BrowserEvidenceSignInSchema.safeParse(signIn({ credentialRef: ref })).success, ref).toBe(false);
    }
    // The longest project name still makes a reference of the pattern, and a secret name leaf (128 characters at most).
    const longest = `a${"b".repeat(62)}`;
    expect(browserEvidenceSignInRef(longest)).toMatch(BROWSER_EVIDENCE_SIGN_IN_REF_PATTERN);
    expect(browserEvidenceSignInRef(longest)!.length).toBeLessThanOrEqual(128);
  });

  it("shares the painted-over selectors with the recipe's own, and leaves room for the two fields", () => {
    const twenty = Array.from({ length: BROWSER_EVIDENCE_MASK_SELECTORS_MAX }, (_, index) => `.m${String(index)}`);
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ mask: twenty })).success).toBe(true);
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ mask: twenty, signIn: signIn() })).success).toBe(false);
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ mask: twenty.slice(0, 18), signIn: signIn() })).success).toBe(true);
    const parsed = BrowserEvidenceRecipeSchema.parse(recipe({ mask: ["#banner"], signIn: signIn() }));
    expect(recipeMaskSelectors(parsed)).toEqual(["#banner", "#email", "#password"]);
    // A selector given twice is painted once, and the sign-in's fields are painted over whatever the recipe's own list says.
    expect(recipeMaskSelectors(BrowserEvidenceRecipeSchema.parse(recipe({ mask: ["#email"], signIn: signIn() })))).toEqual(["#email", "#password"]);
    expect(browserEvidenceMaskSelectors(recipe({ signIn: signIn() }))).toEqual(expect.arrayContaining(["#email", "#password", 'input[type="password"]']));
    // A recipe that does not parse keeps the defaults and adds nothing of its sign-in.
    expect(browserEvidenceMaskSelectors({ signIn: signIn() })).toEqual(withDefaultMasks([]));
  });

  it("refuses a start command that carries a secret-shaped value (a recipe holds no secret, ever)", () => {
    const token = ["gh", "p_", "A".repeat(36)].join("");
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ startCommand: `TOKEN=${token} npm run start` })).success).toBe(false);
    expect(BrowserEvidenceSuggestionSchema.safeParse({ startCommand: `TOKEN=${token} npm run start`, port: 3000, routes: [] }).success).toBe(false);
    expect(BrowserEvidenceRecipeSchema.safeParse(recipe({ startCommand: "npm run start -- --port 3000" })).success).toBe(true);
  });

  it("holds the saved values to a user name and a password: plain single lines of 4 to 200 characters", () => {
    expect(BrowserEvidenceSignInValuesSchema.parse(VALUES)).toEqual(VALUES);
    for (const bad of [{ ...VALUES, username: "abc" }, { ...VALUES, password: "abc" }, { ...VALUES, password: "a".repeat(201) }, { ...VALUES, username: "line\nbreak" }, { ...VALUES, password: "tab\there" }, { ...VALUES, password: "zero​width" },
      { ...VALUES, extra: "x" }, { username: VALUES.username }, { password: VALUES.password }, null, "text"]) {
      expect(BrowserEvidenceSignInValuesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the masks made from the saved values", () => {
  const apply = (text: string, values = VALUES): string => browserEvidenceSecretMasks(values).reduce((out, mask) => out.replace(new RegExp(mask.source, mask.flags), "•••"), text);

  it("hide each value as written and in the spellings an app may echo it in", () => {
    const user = VALUES.username;
    const password = VALUES.password;
    const spellings = [user, user.toUpperCase(), encodeURIComponent(user), Buffer.from(user).toString("base64"), Buffer.from(password).toString("base64url"), Buffer.from(password).toString("hex"),
      password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password), password.toUpperCase()];
    for (const text of spellings) expect(apply(`Signed in as ${text}.`), text).not.toContain(text);
    expect(apply(`Signed in as ${user}.`)).toBe("Signed in as •••.");
    expect(apply("Nothing private here")).toBe("Nothing private here");
  });

  it("take a value with every regular-expression and markup character as plain text, never as a pattern", () => {
    const odd = { username: "a.b*c(1)[x]{2}|^$\\/+?", password: "p&w<\"x'>=Z9" };
    const masks = browserEvidenceSecretMasks(odd);
    expect(masks.length).toBeGreaterThan(0);
    for (const mask of masks) expect(() => new RegExp(mask.source, mask.flags)).not.toThrow();
    expect(apply(`user ${odd.username} and ${odd.password} and ${odd.password.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;").replace(/>/gu, "&gt;")}`, odd)).toBe("user ••• and ••• and •••");
    // A value only matches itself: "a.b" is not "any character between a and b".
    expect(apply("axb*c(1)", { username: "a.b*c(1)", password: VALUES.password })).toBe("axb*c(1)");
  });

  it("make no mask from values that are not a valid sign-in (a short value would blank a page)", () => {
    for (const bad of [undefined, null, {}, { username: "ab", password: VALUES.password }, { username: VALUES.username, password: "" }, "text"]) expect(browserEvidenceSecretMasks(bad), JSON.stringify(bad)).toEqual([]);
  });

  it("run in bounded time on a large page", () => {
    const page = `${"lorem ipsum ".repeat(50_000)}${VALUES.password}`;
    const started = Date.now();
    expect(apply(page)).not.toContain(VALUES.password);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("how the values reach the capture container", () => {
  it("are one environment variable of base64url letters that decodes to exactly the values, and nothing else decodes", () => {
    const text = encodeBrowserEvidenceSignInEnv(VALUES);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(text.length).toBeLessThanOrEqual(BROWSER_EVIDENCE_SIGN_IN_ENV_MAX);
    expect(BROWSER_EVIDENCE_SIGN_IN_ENV).toBe("ROVARA_BE_SIGNIN");
    expect(decodeBrowserEvidenceSignInEnv(text)).toEqual(VALUES);
    // The worst a valid sign-in can be (every character a quote or a backslash, which JSON doubles) still fits the one variable; a value over 200 UTF-8 bytes is no sign-in.
    const worst = { username: '"'.repeat(200), password: "\\".repeat(200) };
    expect(encodeBrowserEvidenceSignInEnv(worst).length).toBeLessThanOrEqual(BROWSER_EVIDENCE_SIGN_IN_ENV_MAX);
    expect(decodeBrowserEvidenceSignInEnv(encodeBrowserEvidenceSignInEnv(worst))).toEqual(worst);
    expect(BrowserEvidenceSignInValuesSchema.safeParse({ username: "é".repeat(101), password: VALUES.password }).success).toBe(false);
    expect(BrowserEvidenceSignInValuesSchema.safeParse({ username: "é".repeat(100), password: VALUES.password }).success).toBe(true);
    const longest = { username: "u".repeat(200), password: "p".repeat(200) };
    expect(encodeBrowserEvidenceSignInEnv(longest).length).toBeLessThanOrEqual(BROWSER_EVIDENCE_SIGN_IN_ENV_MAX);
    for (const bad of [undefined, "", "!!!", "a".repeat(BROWSER_EVIDENCE_SIGN_IN_ENV_MAX + 1), Buffer.from(JSON.stringify({ username: "ab", password: "cd" })).toString("base64url"), Buffer.from("not json").toString("base64url"), Buffer.from(JSON.stringify({ ...VALUES, extra: 1 })).toString("base64url"),
      // Values that are valid, padded with white space past the bound: the bound is the program's own, not only the schema's.
      Buffer.from(`${JSON.stringify(VALUES)}${" ".repeat(2_000)}`).toString("base64url")]) {
      expect(decodeBrowserEvidenceSignInEnv(bad), String(bad).slice(0, 20)).toBeUndefined();
    }
    expect(() => encodeBrowserEvidenceSignInEnv({ username: "ab", password: "cd" })).toThrow();
  });

  it("the capture plan carries the form and never a value or the reference (mutant: a value added to the plan)", () => {
    const plan = { port: 3000, routes: ["/checkout"], maskSelectors: ["#email", "#password"], runMs: 60_000, pageMs: 15_000, signIn: { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard" } };
    const argument = encodeBrowserEvidenceExecutorPlan(plan);
    expect(decodeBrowserEvidenceExecutorPlan(argument)).toEqual(plan);
    expect(Buffer.from(argument, "base64url").toString("utf8")).not.toMatch(/password":|username":|credentialRef|be-web-signin/u);
    for (const bad of [{ ...plan, signIn: { ...plan.signIn, username: VALUES.username } }, { ...plan, signIn: { ...plan.signIn, credentialRef: "be-web-signin" } }, { ...plan, signIn: { ...plan.signIn, successPath: undefined } },
      { ...plan, signIn: { ...plan.signIn, usernameSelector: "a\nb" } }]) {
      expect(BrowserEvidenceExecutorPlanSchema.safeParse(bad).success).toBe(false);
    }
    // No sign-in in the plan is today's plan, byte for byte.
    const { signIn: _ignored, ...plain } = plan;
    void _ignored;
    expect(decodeBrowserEvidenceExecutorPlan(encodeBrowserEvidenceExecutorPlan(plain))).toEqual(plain);
  });

  it("the capture program's app line may say the sign-in did not work, with no other word", () => {
    expect(BrowserEvidenceExecutorLineSchema.safeParse({ t: "app", status: "sign_in_failed" }).success).toBe(true);
    expect(BrowserEvidenceExecutorLineSchema.safeParse({ t: "app", status: "sign_in_failed", detail: "Invalid password for tester" }).success).toBe(false);
  });

  it("the broker's answer is the values or `not_set`, strictly", () => {
    expect(BrowserEvidenceSignInAnswerSchema.parse({ status: "ready", values: VALUES })).toEqual({ status: "ready", values: VALUES });
    expect(BrowserEvidenceSignInAnswerSchema.parse({ status: "not_set" })).toEqual({ status: "not_set" });
    for (const bad of [{ status: "not_set", values: VALUES }, { status: "ready" }, { status: "ready", values: { ...VALUES, extra: 1 } }, { status: "failed", message: "x" }, {}]) expect(BrowserEvidenceSignInAnswerSchema.safeParse(bad).success).toBe(false);
  });
});

describe("the new reasons", () => {
  it("are listed with fixed lower-case words that echo nothing, and a run that could not sign in says so", () => {
    expect(BROWSER_EVIDENCE_NOT_RUN_REASONS).toEqual(expect.arrayContaining(["sign_in_not_set", "sign_in_failed"]));
    for (const reason of ["sign_in_not_set", "sign_in_failed"] as const) expect(BROWSER_EVIDENCE_NOT_RUN_WORDS[reason]).toMatch(/^[a-z][a-z ,:-]+$/u);
    const outcome = (notRun: "sign_in_not_set" | "sign_in_failed"): BrowserEvidenceOutcome => ({ isolation: "sandbox", durationMs: 1, routes: [], notShown: [], moreNotShown: 0, notRun });
    expect(browserEvidenceLines(outcome("sign_in_failed"), {})).toEqual(["Browser evidence: Run by Rovara in its sandbox. Visual evidence only: it does not count as change proof.", "- Not run: the sign-in did not work"]);
    expect(browserEvidenceLines(outcome("sign_in_not_set"), {})).toContain("- Not run: no sign-in is saved for this project");
  });
});
