// TE-H1 browser evidence (plan: rovara-research briefs/browser-evidence-plan.md), the pure half. For a web-app change Rovara starts the app in its sandbox with the project's own start
// command, opens the changed pages in a headless Chromium on the base code and on the candidate, and attaches the before and after screenshots to the evidence. This file holds what
// every side agrees on: the project setting (off by default), the route recipe, which changed pages are picked, the masks, the caps, the fixed words, the evidence-pack check and the
// pull request's lines. Visual evidence only: the check's kind is `visual`, which never counts toward the change proof.
// Slice 4 adds video on failure: a video of a page that failed or showed errors, only for a project whose recipe says its app shows fixture data only (a video cannot be masked frame by frame), never
// for an app behind a login, kept under the evidence store's `webm` rules, and shown only as a download behind sign-in.
// Browser-safe and pure: nothing here imports a Node module.
import { z } from "zod";
import { ArtifactRefSchema, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_CHECKS_MAX, EVIDENCE_NOT_TESTED_MAX, type ArtifactRef, type EvidenceCheckV2, type EvidencePackV2 } from "./evidence.js";
import { matchPolicyGlob, validPolicyPath, POLICY_PATTERN_MAX } from "./policy-glob.js";
import { redactText } from "./redaction.js";

// ---- the setting

/** The project setting (a row of the policy registry, `POLICY_FIELDS`): `off` today and in every preset; only an explicit `on` runs anything. */
export const BROWSER_EVIDENCE_SETTING = "browser_evidence";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a resolved policy turns browser evidence on. Fails closed: anything but a `resolved` policy whose own value for the setting is exactly `on` is off. */
export function browserEvidenceOn(policy: unknown): boolean {
  if (!isRecord(policy) || policy["status"] !== "resolved" || !isRecord(policy["values"])) return false;
  const values = policy["values"];
  if (!Object.hasOwn(values, BROWSER_EVIDENCE_SETTING)) return false;
  const row = values[BROWSER_EVIDENCE_SETTING];
  return isRecord(row) && row["value"] === "on";
}

// ---- caps

/** One screenshot: the e2e capture cap (`CAPTURE_SCREENSHOT_MAX_BYTES`), which is the pack's own JPEG cap. */
export const BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES = EVIDENCE_ARTIFACT_MAX_BYTES.jpeg;
/** Everything one run keeps, before and after together. */
export const BROWSER_EVIDENCE_TOTAL_MAX_BYTES = 4 * 1_048_576;
/** Pages one run photographs (each twice: before and after). */
export const BROWSER_EVIDENCE_ROUTES_MAX = 5;
/** Changed files read to pick pages; a longer list is refused whole, never cut. */
export const BROWSER_EVIDENCE_CHANGED_FILES_MAX = 2_000;
/** Glob-matching work one pick may do (the matcher's own step count); more is refused whole. */
export const BROWSER_EVIDENCE_MATCH_STEPS_MAX = 10_000_000;
/** Routes listed as "not shown"; the rest are counted. */
export const BROWSER_EVIDENCE_NOT_SHOWN_MAX = 20;
/** One run, the app start included, and one page. */
export const BROWSER_EVIDENCE_RUN_MS = 120_000;
export const BROWSER_EVIDENCE_PAGE_MS = 15_000;
/** Text longer than this is masked whole rather than scanned. */
export const BROWSER_EVIDENCE_TEXT_SCAN_MAX = 200_000;
/** Video on failure (slice 4): one video, how many a run keeps, and all of them together. A video is of one page's own load, so it is also bounded by the page's time (`BROWSER_EVIDENCE_PAGE_MS`). */
export const BROWSER_EVIDENCE_VIDEO_MAX_BYTES = 2 * 1_048_576;
export const BROWSER_EVIDENCE_VIDEOS_MAX = 2;
export const BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES = 4 * 1_048_576;
/** The recording's frame size: small on purpose (it holds the size down; the pictures are the evidence, the video only shows what went wrong). */
export const BROWSER_EVIDENCE_VIDEO_SIZE = Object.freeze({ width: 640, height: 360 });
/** The first bytes of a WebM file (an EBML header). */
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
export const isWebm = (bytes: Uint8Array): boolean => bytes.byteLength >= WEBM_MAGIC.length && WEBM_MAGIC.every((value, index) => bytes[index] === value);

// ---- the recipe

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
/** A path on the app's own origin: starts with `/`, no query or fragment, no `.` or `..` segment, no empty segment, at most 80 characters (it is a pair's id). */
const ROUTE_PATH = /^\/(?:[A-Za-z0-9_~\-[\]][A-Za-z0-9._~\-[\]]*(?:\/[A-Za-z0-9_~\-[\]][A-Za-z0-9._~\-[\]]*)*\/?)?$/u;
export const BROWSER_EVIDENCE_ROUTE_MAX = 80;
export function isBrowserEvidenceRoute(value: unknown): value is string {
  return typeof value === "string" && value.length <= BROWSER_EVIDENCE_ROUTE_MAX && ROUTE_PATH.test(value);
}
const RouteSchema = z.string().refine(isBrowserEvidenceRoute, "a path on the app's own origin");
const GlobSchema = z.string().refine((value) => validPolicyPath(value, POLICY_PATTERN_MAX), "a repository glob");
const SelectorSchema = line(200);
export const BROWSER_EVIDENCE_RECIPE_ROUTES_MAX = 50;
export const BROWSER_EVIDENCE_MASK_SELECTORS_MAX = 20;

// ---- the sign-in recipe (slice 3)

/**
 * The name a project's saved sign-in has in the company's secret store: `be-<project>-signin`. A recipe holds this NAME and nothing else about the sign-in's values; the values (a user name and a password)
 * live only in the secret store, under the company's own path, and are read at the moment a run needs them. The name is derived from the project, so a recipe cannot point at another project's, another kind's
 * (a connection's or a registered server's) or another company's secret.
 */
export const BROWSER_EVIDENCE_SIGN_IN_REF_PATTERN = /^be-[a-z][a-z0-9-]{0,62}-signin$/u;
export function browserEvidenceSignInRef(project: unknown): string | undefined {
  if (typeof project !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(project)) return undefined;
  return `be-${project}-signin`;
}
/** Whether `ref` is exactly the reference of `project`'s own sign-in. */
export function isBrowserEvidenceSignInRefOf(project: unknown, ref: unknown): boolean {
  const expected = browserEvidenceSignInRef(project);
  return expected !== undefined && ref === expected;
}
/** The sign-in values' own limits (a test account's user name and password are short plain strings). */
export const BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN = 4;
export const BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX = 200;
/** The saved sign-in: exactly a user name and a password, both plain single lines (no control, format or line-break character). Never part of a recipe, a payload, a pack or a log. */
// At most 200 characters AND 200 UTF-8 bytes, so the values always fit the one environment variable that carries them (even with every quote or backslash escaped).
const signInValue = () => z.string().min(BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN).max(BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX).regex(NO_HIDDEN, "one plain line").refine((value) => new TextEncoder().encode(value).byteLength <= BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX, "too long");
export const BrowserEvidenceSignInValuesSchema = z.object({ username: signInValue(), password: signInValue() }).strict();
export type BrowserEvidenceSignInValues = z.infer<typeof BrowserEvidenceSignInValuesSchema>;

/**
 * How Rovara signs in to an app that sits behind a login: open the login page, fill the user name and the password fields, press the submit button, and wait until the page the app sends you to
 * (`successPath`) or an element only a signed-in page has (`successSelector`) is there. Selectors are CSS selectors the project names (a sign-in form is the project's own); the VALUES are never here:
 * `credentialRef` names the saved sign-in (`browserEvidenceSignInRef`). The two fields are painted over in every picture, like any password field.
 */
export const BrowserEvidenceSignInSchema = z.object({
  /** The login page, on the app's own origin. */
  path: RouteSchema,
  usernameSelector: SelectorSchema,
  passwordSelector: SelectorSchema,
  submitSelector: SelectorSchema,
  successPath: RouteSchema.optional(),
  successSelector: SelectorSchema.optional(),
  credentialRef: z.string().regex(BROWSER_EVIDENCE_SIGN_IN_REF_PATTERN, "the project's saved sign-in"),
}).strict().superRefine((signIn, context) => {
  if (signIn.successPath === undefined && signIn.successSelector === undefined) context.addIssue({ code: "custom", path: ["successPath"], message: "say how a signed-in page is told: a page or an element" });
  if (signIn.successPath !== undefined && signIn.successPath === signIn.path) context.addIssue({ code: "custom", path: ["successPath"], message: "the signed-in page is not the login page" });
});
export type BrowserEvidenceSignIn = z.infer<typeof BrowserEvidenceSignInSchema>;

/**
 * How Rovara shows a project's pages: the project's own start command and port (run in the sandbox), the page that says the app is up, an optional framework whose page files map to
 * routes by convention, the routes with the repository files that make each one, and extra elements to paint over. Kept in Rovara's settings, never in the repository.
 */
/** The part of a recipe the setup agent may suggest from the app's own files: how the app starts, on which port, and which pages which files make. Never a mask, a sign-in or anything secret. */
export const BrowserEvidenceSuggestionSchema = z.object({
  // A command that carries a secret-shaped value is no start command: a secret is never typed into a recipe.
  startCommand: line(500).refine((value) => redactText(value) === value, "no secret in the command"),
  port: z.number().int().min(1_024).max(65_535),
  readyPath: RouteSchema.optional(),
  framework: z.enum(["nextjs"]).optional(),
  routes: z.array(z.object({ path: RouteSchema, files: z.array(GlobSchema).min(1).max(20) }).strict()).max(BROWSER_EVIDENCE_RECIPE_ROUTES_MAX),
}).strict();
export type BrowserEvidenceSuggestion = z.infer<typeof BrowserEvidenceSuggestionSchema>;

/**
 * Slice 4, the admin's choice to keep a video of a page that failed. A screenshot is masked by reading and rewriting the page's text before the one picture is taken; a video records the live page from the first frame,
 * where nothing has been scrubbed, so it cannot be masked the same way. It is therefore allowed only when the recipe says, in so many words, that the app shows fixture data only (`fixtureDataOnly: true`). The setup agent
 * never proposes it (it is not part of `BrowserEvidenceSuggestionSchema`): it is the owner's own act on the recipe page.
 */
export const BrowserEvidenceVideoSchema = z.object({ fixtureDataOnly: z.literal(true) }).strict();
export type BrowserEvidenceVideo = z.infer<typeof BrowserEvidenceVideoSchema>;

export const BrowserEvidenceRecipeSchema = z.object({
  ...BrowserEvidenceSuggestionSchema.shape,
  mask: z.array(SelectorSchema).max(BROWSER_EVIDENCE_MASK_SELECTORS_MAX).optional(),
  /** Slice 3: the sign-in for an app behind a login. Absent: today's recipe, byte for byte. */
  signIn: BrowserEvidenceSignInSchema.optional(),
  /** Slice 4: keep a video of a page that fails. Absent: no video is ever recorded. */
  video: BrowserEvidenceVideoSchema.optional(),
}).strict().superRefine((recipe, context) => {
  // A sign-in types a saved account into the page, and the recording would hold it: no video for an app behind a login.
  if (recipe.video !== undefined && recipe.signIn !== undefined) context.addIssue({ code: "custom", path: ["video"], message: "no video for an app behind a login" });
  // The sign-in's two fields are added to the painted-over elements, so they share the run's selector cap.
  if (recipe.signIn !== undefined && (recipe.mask?.length ?? 0) + 2 > BROWSER_EVIDENCE_MASK_SELECTORS_MAX) context.addIssue({ code: "custom", path: ["mask"], message: "leave room for the sign-in's two fields" });
});
export type BrowserEvidenceRecipe = z.infer<typeof BrowserEvidenceRecipeSchema>;
/** Whether a recipe asks for video on failure. Fails closed: only a recipe that parses whole, with `video: { fixtureDataOnly: true }` and no sign-in, wants one. */
export function browserEvidenceVideoWanted(recipe: unknown): boolean {
  const parsed = BrowserEvidenceRecipeSchema.safeParse(recipe);
  return parsed.success && parsed.data.video !== undefined;
}

// ---- fixed reasons and words

/** Why a run, or one page of it, has no before and after pictures. Fixed words, never an error's own text. */
export const BROWSER_EVIDENCE_NOT_RUN_REASONS = ["no_recipe", "no_changed_page", "changes_unreadable", "too_many_changed_files", "app_did_not_start", "page_did_not_load", "capture_failed",
  "over_size_cap", "masked_content", "time_limit", "not_stored", "sign_in_not_set", "sign_in_failed"] as const;
export type BrowserEvidenceNotRunReason = (typeof BROWSER_EVIDENCE_NOT_RUN_REASONS)[number];
export const BROWSER_EVIDENCE_NOT_RUN_WORDS: Record<BrowserEvidenceNotRunReason, string> = {
  no_recipe: "no start command or pages are set for this project",
  no_changed_page: "no changed page found",
  changes_unreadable: "the changed files could not be read",
  too_many_changed_files: "too many changed files to pick pages from",
  app_did_not_start: "the app did not start",
  page_did_not_load: "the page did not load",
  capture_failed: "the screenshot could not be taken",
  over_size_cap: "over the size cap",
  masked_content: "withheld, it may show a secret or personal data",
  time_limit: "the time limit was reached",
  not_stored: "it could not be stored",
  sign_in_not_set: "no sign-in is saved for this project",
  sign_in_failed: "the sign-in did not work",
};
/** Why a video of a failed page is not kept. Fixed words, never an error's own text. */
export const BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS = ["over_size_cap", "withheld", "not_recorded", "not_stored"] as const;
export type BrowserEvidenceVideoNotKeptReason = (typeof BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS)[number];
export const BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS: Record<BrowserEvidenceVideoNotKeptReason, string> = {
  over_size_cap: "over the size cap",
  withheld: "withheld, a page may have shown a secret or personal data",
  not_recorded: "the recording could not be made",
  not_stored: "it could not be stored",
};
export const BROWSER_EVIDENCE_VIDEO_CHECK_ID = "browser_evidence_video";
const VIDEO_CHECK_LABEL = "Browser evidence video";
/**
 * The pages whose failure a video is kept for: one that did not load (a 404, a 500, no answer). Deliberately NOT `capture_failed` or `time_limit`, and never `masked_content`: for those the page's text was never read and
 * verified (the scrub could not finish, or the page never yielded), so nothing says it held no secret, and a recording of it would show whatever it held.
 */
const VIDEO_FAILURE_REASONS: readonly BrowserEvidenceNotRunReason[] = ["page_did_not_load"];
/** Whether a page's result is one a video may be kept for: a page that failed, or that showed console errors after the change. Nothing else is. */
export function browserEvidenceVideoEligible(result: { status: "not_run"; reason: BrowserEvidenceNotRunReason } | { status: "shown"; consoleErrors: { after: number } }): boolean {
  return result.status === "not_run" ? VIDEO_FAILURE_REASONS.includes(result.reason) : result.consoleErrors.after > 0;
}

/** Why a changed page was not opened at all. */
export const BROWSER_EVIDENCE_NOT_SHOWN_REASONS = ["over_route_cap", "dynamic_route"] as const;
export type BrowserEvidenceNotShownReason = (typeof BROWSER_EVIDENCE_NOT_SHOWN_REASONS)[number];
export const BROWSER_EVIDENCE_NOT_SHOWN_WORDS: Record<BrowserEvidenceNotShownReason, string> = {
  over_route_cap: "more changed pages than the cap",
  dynamic_route: "needs a route in the recipe",
};
/** Who ran it, from the pack's `producer.isolation` (O26: a laptop says so). */
export const BROWSER_EVIDENCE_ISOLATIONS = ["sandbox", "developer_machine"] as const;
export type BrowserEvidenceIsolation = (typeof BROWSER_EVIDENCE_ISOLATIONS)[number];
export const BROWSER_EVIDENCE_RUN_BY_WORDS: Record<BrowserEvidenceIsolation, string> = {
  sandbox: "Run by Rovara in its sandbox",
  developer_machine: "Ran on a developer machine",
};
export const BROWSER_EVIDENCE_NOT_PROOF_WORDS = "Visual evidence only: it does not count as change proof.";
export const BROWSER_EVIDENCE_CHECK_ID = "browser_evidence";
const CHECK_LABEL = "Browser evidence";

// ---- which changed pages are picked

export type BrowserEvidenceNotShown = { route: string; reason: BrowserEvidenceNotShownReason };
export type BrowserEvidencePick =
  | { status: "picked"; routes: string[]; notShown: BrowserEvidenceNotShown[]; moreNotShown: number }
  | { status: "not_run"; reason: Extract<BrowserEvidenceNotRunReason, "no_recipe" | "no_changed_page" | "changes_unreadable" | "too_many_changed_files"> };

const NEXT_PAGE_EXTENSION = /\.(?:tsx|ts|jsx|js|mdx)$/u;
/** The route a Next.js page file serves, `dynamic` for a `[segment]`, or undefined for a file that is not a page (an API route, `_app`, a layout, a private folder). */
function nextjsRouteOf(file: string): { route: string; dynamic: boolean } | undefined {
  const path = file.startsWith("src/") ? file.slice(4) : file;
  let segments: string[];
  if (path.startsWith("pages/")) {
    if (!NEXT_PAGE_EXTENSION.test(path) || path.startsWith("pages/api/")) return undefined;
    segments = path.slice("pages/".length).replace(NEXT_PAGE_EXTENSION, "").split("/");
    if (segments.some((segment) => segment.startsWith("_"))) return undefined;
    if (segments.at(-1) === "index") segments.pop();
  } else if (path.startsWith("app/")) {
    const parts = path.slice("app/".length).split("/");
    const name = parts.pop();
    if (name === undefined || !/^page\.(?:tsx|ts|jsx|js|mdx)$/u.test(name)) return undefined;
    if (parts.some((segment) => segment.startsWith("_") || segment.startsWith("@"))) return undefined;
    // A route group `(name)` is not part of the URL.
    segments = parts.filter((segment) => !/^\(.*\)$/u.test(segment));
  } else return undefined;
  const route = `/${segments.join("/")}`;
  if (!isBrowserEvidenceRoute(route)) return undefined;
  return { route, dynamic: segments.some((segment) => segment.includes("[")) };
}

/**
 * The pages a change touches, from the recipe's routes (a changed file matches one of a route's globs) and, when the recipe names it, the framework's page files. Bounded: a list over
 * `BROWSER_EVIDENCE_CHANGED_FILES_MAX` files, or more matching work than `BROWSER_EVIDENCE_MATCH_STEPS_MAX`, is refused whole (never picked from part of the list). At most
 * `BROWSER_EVIDENCE_ROUTES_MAX` routes are taken, recipe routes first, then the framework's in the order their files changed; the rest, and dynamic routes (never guessed), are "not shown".
 */
export function pickChangedRoutes(input: { changedFiles: unknown; recipe: unknown }): BrowserEvidencePick {
  const recipe = BrowserEvidenceRecipeSchema.safeParse(input.recipe);
  if (!recipe.success) return { status: "not_run", reason: "no_recipe" };
  const files = input.changedFiles;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) return { status: "not_run", reason: "changes_unreadable" };
  if (files.length > BROWSER_EVIDENCE_CHANGED_FILES_MAX) return { status: "not_run", reason: "too_many_changed_files" };
  const candidates: string[] = [];
  const dynamic: string[] = [];
  const seen = new Set<string>();
  let steps = 0;
  for (const route of recipe.data.routes) {
    if (seen.has(route.path)) continue;
    let hit = false;
    for (const file of files) {
      for (const glob of route.files) {
        const result = matchPolicyGlob(glob, file);
        steps += result.steps;
        if (steps > BROWSER_EVIDENCE_MATCH_STEPS_MAX) return { status: "not_run", reason: "too_many_changed_files" };
        if (result.matched) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) { seen.add(route.path); candidates.push(route.path); }
  }
  if (recipe.data.framework === "nextjs") {
    for (const file of files) {
      const page = nextjsRouteOf(file);
      if (page === undefined || seen.has(page.route)) continue;
      seen.add(page.route);
      (page.dynamic ? dynamic : candidates).push(page.route);
    }
  }
  if (candidates.length === 0 && dynamic.length === 0) return { status: "not_run", reason: "no_changed_page" };
  const notShownAll: BrowserEvidenceNotShown[] = [
    ...candidates.slice(BROWSER_EVIDENCE_ROUTES_MAX).map((route) => ({ route, reason: "over_route_cap" as const })),
    ...dynamic.map((route) => ({ route, reason: "dynamic_route" as const })),
  ];
  return {
    status: "picked",
    routes: candidates.slice(0, BROWSER_EVIDENCE_ROUTES_MAX),
    notShown: notShownAll.slice(0, BROWSER_EVIDENCE_NOT_SHOWN_MAX),
    moreNotShown: Math.max(0, notShownAll.length - BROWSER_EVIDENCE_NOT_SHOWN_MAX),
  };
}

// ---- masking

/** Painted over before every screenshot (Playwright's `mask`): secrets and personal data in form fields, and anything the app marks private. */
export const BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS: readonly string[] = Object.freeze([
  'input[type="password"]',
  // A "show password" toggle turns the field into type=text: these still find it.
  'input[name*="password" i]',
  'input[autocomplete$="password"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  // A canvas can draw any text and no text scrub reaches it.
  "canvas",
  "[data-rovara-mask]",
  "[data-private]",
]);
const selectorOk = (value: unknown): value is string => SelectorSchema.safeParse(value).success;
/** The defaults, then the given extra selectors that are valid, each once. Masking never shrinks below the defaults, whatever is passed. */
export function withDefaultMasks(extra: unknown): string[] {
  const out = [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS];
  if (!Array.isArray(extra)) return out;
  for (const selector of extra.slice(0, BROWSER_EVIDENCE_MASK_SELECTORS_MAX)) if (selectorOk(selector) && !out.includes(selector)) out.push(selector);
  return out;
}
/** The selectors a recipe asks to mask, after the defaults. A recipe that does not parse keeps the defaults: a bad recipe never turns masking off. The sign-in's own two fields are always among them. */
export function browserEvidenceMaskSelectors(recipe: unknown): string[] {
  const parsed = BrowserEvidenceRecipeSchema.safeParse(recipe);
  return withDefaultMasks(parsed.success ? recipeMaskSelectors(parsed.data) : undefined);
}
/** What a valid recipe asks to paint over beyond the defaults: its own selectors, then its sign-in's user name and password fields (a profile page shows them too). */
export function recipeMaskSelectors(recipe: Pick<BrowserEvidenceRecipe, "mask" | "signIn">): string[] {
  return [...new Set([...(recipe.mask ?? []), ...(recipe.signIn === undefined ? [] : [recipe.signIn.usernameSelector, recipe.signIn.passwordSelector])])];
}

/**
 * The saved sign-in's two values as text masks for the page: each value literally (case-insensitively), and the encodings an app may write it in (percent-encoded, base64, base64url, hex, JSON-escaped,
 * HTML-escaped), so a page that echoes the account it is signed in as never shows it. Nothing here is a pattern the value could be recovered from: the sources are the values themselves and are used only in the
 * capture container that already holds them. A value that is not a valid sign-in value yields no mask (the sign-in is refused before this is used).
 */
export function browserEvidenceSecretMasks(values: unknown): Array<{ source: string; flags: string }> {
  const parsed = BrowserEvidenceSignInValuesSchema.safeParse(values);
  if (!parsed.success) return [];
  const literal = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
  const spellings = new Set<string>();
  for (const value of [parsed.data.username, parsed.data.password]) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    for (const spelling of [value, encodeURIComponent(value), encodeURI(value), base64, base64.replace(/=+$/u, ""), base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""), hex, JSON.stringify(value).slice(1, -1),
      value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;")]) {
      if (spelling.length >= BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN) spellings.add(spelling);
    }
  }
  return [...spellings].map((spelling) => ({ source: literal(spelling), flags: "giu" }));
}

/**
 * Text masks, applied to the page's visible text and form values before every screenshot (and by `scrubVisibleText`). Each is a bounded pattern: emails, JWTs, prefixed API keys,
 * long hex or base64 runs, card-like digit runs and phone numbers. Kept as sources so the page and Node apply the same list.
 */
type TextMask = { source: string; flags: string; label?: true };
export const BROWSER_EVIDENCE_TEXT_MASKS: ReadonlyArray<Readonly<TextMask>> = Object.freeze(([
  { source: "[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,8}\\.[A-Za-z]{2,24}", flags: "gu" },
  { source: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", flags: "gu" },
  { source: "\\b(?:(?:sk|pk|rk)[-_]|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}", flags: "gu" },
  { source: "\\b[A-Fa-f0-9]{32,}\\b", flags: "gu" },
  { source: "[A-Za-z0-9+/_-]{40,}={0,2}", flags: "gu" },
  { source: "\\b\\d(?:[ -]?\\d){12,18}\\b", flags: "gu" },
  { source: "\\+\\d{1,3}(?:[ .-]?\\d{2,4}){2,5}\\b", flags: "gu" },
  { source: "\\(?\\b\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}\\b", flags: "gu" },
  // A US social security number, an IBAN (all its groups), GitLab and Twilio keys, a bearer token, and a labelled secret (`password: ...`, `api_key=...`).
  { source: "\\b\\d{3}-\\d{2}-\\d{4}\\b", flags: "gu" },
  { source: "\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\\b", flags: "gu" },
  { source: "glpat-[A-Za-z0-9_-]{20,}", flags: "gu" },
  { source: "\\bSK[a-f0-9]{32}\\b", flags: "gu" },
  { source: "\\bbearer\\s+[A-Za-z0-9._~+/-]{8,}=*", flags: "giu" },
  // Labelled secrets (`label`): the label, then the value on the same line or alone at the start of the next line. Over a page these run on its "label view" (the driver's), where
  // links and buttons are lines of their own and form fields are marker lines, and a value made only of dots or asterisks (already masked) is not one; so "API key: abcd1234 [Copy]" is caught and a "Password:" label beside its field and a "Sign in" button or "Forgot?" link is not.
  { source: "(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[ _-]?key)[^\\S\\n]*[:=][^\\S\\n]*(?=[^\\s]*[^\\s•*●·∙.])[^\\s]{4,}", flags: "giu", label: true },
  { source: "(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[ _-]?key)[^\\S\\n]*[:=][^\\S\\n]*\\n[^\\S\\n]*(?=[^\\s]*[^\\s•*●·∙.])[^\\s]{4,}[^\\S\\n]*(?=\\n|$)", flags: "giu", label: true },
] satisfies TextMask[]).map((mask) => Object.freeze(mask)));
export const BROWSER_EVIDENCE_TEXT_MASK = "•••";
const TEXT_MASKS = BROWSER_EVIDENCE_TEXT_MASKS.map((mask) => new RegExp(mask.source, mask.flags));
/** `text` with every text mask applied. Text longer than `BROWSER_EVIDENCE_TEXT_SCAN_MAX` is masked whole. */
export function scrubVisibleText(text: string): string {
  if (typeof text !== "string") return "";
  if (text.length > BROWSER_EVIDENCE_TEXT_SCAN_MAX) return BROWSER_EVIDENCE_TEXT_MASK;
  let out = text;
  for (const mask of TEXT_MASKS) out = out.replace(mask, BROWSER_EVIDENCE_TEXT_MASK);
  return out;
}

// ---- what a run produced

type Count = number;
/** The runner's result, with the screenshots' bytes (the verifier writes it, the broker stores the bytes and turns it into an outcome). */
export type BrowserEvidenceShot = { sha256: string; bytes: Uint8Array };
/** Slice 4: a page that failed (or showed errors after the change) may carry the video of its load, or the fixed reason there is none. Never both; never on any other page. */
type VideoOf<Video> = { video?: Video; videoNotKept?: BrowserEvidenceVideoNotKeptReason };
export type BrowserEvidenceRouteResult<Shot, Video = Shot> =
  | ({ route: string; status: "shown"; before: Shot; after: Shot; consoleErrors: { before: Count; after: Count } } & VideoOf<Video>)
  | ({ route: string; status: "not_run"; reason: BrowserEvidenceNotRunReason } & VideoOf<Video>);
type RunResult<Shot, Video = Shot> = {
  isolation: BrowserEvidenceIsolation;
  durationMs: number;
  routes: Array<BrowserEvidenceRouteResult<Shot, Video>>;
  notShown: BrowserEvidenceNotShown[];
  moreNotShown: number;
  /** The whole run did not happen (no page was opened). */
  notRun?: BrowserEvidenceNotRunReason;
};
export type BrowserEvidenceCaptured = RunResult<BrowserEvidenceShot>;
/** What the pack and the pull request are written from: the screenshots (and videos) as stored refs. */
export type BrowserEvidenceOutcome = RunResult<ArtifactRef>;

const CountSchema = z.number().int().min(0).max(1_000_000);
const JpegRefSchema = ArtifactRefSchema.refine((ref) => ref.kind === "jpeg", "a screenshot is a JPEG");
const WebmRefSchema = ArtifactRefSchema.refine((ref) => ref.kind === "webm" && ref.bytes > 0 && ref.bytes <= BROWSER_EVIDENCE_VIDEO_MAX_BYTES, "a video is a WebM within the video cap");
const NotKeptSchema = z.enum(BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS);
const OutcomeBaseSchema = z.object({
  isolation: z.enum(BROWSER_EVIDENCE_ISOLATIONS),
  durationMs: z.number().int().min(0).max(86_400_000),
  routes: z.array(z.discriminatedUnion("status", [
    z.object({ route: RouteSchema, status: z.literal("shown"), before: JpegRefSchema, after: JpegRefSchema, consoleErrors: z.object({ before: CountSchema, after: CountSchema }).strict(), video: WebmRefSchema.optional(), videoNotKept: NotKeptSchema.optional() }).strict(),
    z.object({ route: RouteSchema, status: z.literal("not_run"), reason: z.enum(BROWSER_EVIDENCE_NOT_RUN_REASONS), video: WebmRefSchema.optional(), videoNotKept: NotKeptSchema.optional() }).strict(),
  ])).max(BROWSER_EVIDENCE_ROUTES_MAX),
  notShown: z.array(z.object({ route: RouteSchema, reason: z.enum(BROWSER_EVIDENCE_NOT_SHOWN_REASONS) }).strict()).max(BROWSER_EVIDENCE_NOT_SHOWN_MAX),
  moreNotShown: CountSchema,
  notRun: z.enum(BROWSER_EVIDENCE_NOT_RUN_REASONS).optional(),
}).strict();
const OutcomeSchema = OutcomeBaseSchema.superRefine((outcome, context) => {
  if (new Set(outcome.routes.map((row) => row.route)).size !== outcome.routes.length) context.addIssue({ code: "custom", message: "routes are unique" });
  if (outcome.notRun !== undefined && outcome.routes.length > 0) context.addIssue({ code: "custom", message: "a run that did not happen has no routes" });
  if (outcome.routes.some((row) => row.video !== undefined && row.videoNotKept !== undefined)) context.addIssue({ code: "custom", message: "a page has a video or a reason there is none, not both" });
  if (outcome.routes.filter((row) => row.video !== undefined).length > BROWSER_EVIDENCE_VIDEOS_MAX) context.addIssue({ code: "custom", message: "a run keeps at most the run's number of videos" });
  if (outcome.routes.reduce((sum, row) => sum + (row.video?.bytes ?? 0), 0) > BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES) context.addIssue({ code: "custom", message: "a run keeps at most the run's video byte budget" });
});

const INVALID = "browser evidence outcome is not valid";

const ShotSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES) }).strict();
const VideoShotSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= BROWSER_EVIDENCE_VIDEO_MAX_BYTES && isWebm(bytes)) }).strict();
const CapturedSchema = OutcomeBaseSchema.extend({
  routes: z.array(z.discriminatedUnion("status", [
    z.object({ route: RouteSchema, status: z.literal("shown"), before: ShotSchema, after: ShotSchema, consoleErrors: z.object({ before: CountSchema, after: CountSchema }).strict(), video: VideoShotSchema.optional(), videoNotKept: NotKeptSchema.optional() }).strict(),
    z.object({ route: RouteSchema, status: z.literal("not_run"), reason: z.enum(BROWSER_EVIDENCE_NOT_RUN_REASONS), video: VideoShotSchema.optional(), videoNotKept: NotKeptSchema.optional() }).strict(),
  ])).max(BROWSER_EVIDENCE_ROUTES_MAX),
}).superRefine((captured, context) => {
  if (new Set(captured.routes.map((row) => row.route)).size !== captured.routes.length) context.addIssue({ code: "custom", message: "routes are unique" });
  if (captured.notRun !== undefined && captured.routes.length > 0) context.addIssue({ code: "custom", message: "a run that did not happen has no routes" });
  const total = captured.routes.reduce((sum, row) => sum + (row.status === "shown" ? row.before.bytes.byteLength + row.after.bytes.byteLength : 0), 0);
  if (total > BROWSER_EVIDENCE_TOTAL_MAX_BYTES) context.addIssue({ code: "custom", message: "a run keeps at most the run's byte budget" });
  if (captured.routes.some((row) => row.video !== undefined && row.videoNotKept !== undefined)) context.addIssue({ code: "custom", message: "a page has a video or a reason there is none, not both" });
  const videos = captured.routes.flatMap((row) => (row.video === undefined ? [] : [row.video.bytes.byteLength]));
  if (videos.length > BROWSER_EVIDENCE_VIDEOS_MAX) context.addIssue({ code: "custom", message: "a run keeps at most the run's number of videos" });
  if (videos.reduce((sum, size) => sum + size, 0) > BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES) context.addIssue({ code: "custom", message: "a run keeps at most the run's video byte budget" });
  // A video is kept only for a page that failed or showed errors (never a healthy page, never one withheld for what it showed): the producer's own rule, held again here.
  if (captured.routes.some((row) => (row.video !== undefined || row.videoNotKept !== undefined) && !browserEvidenceVideoEligible(row))) context.addIssue({ code: "custom", message: "a video is kept only for a page that failed" });
});
/** The runner's result checked whole before anything of it is stored: the shape, every shot within the screenshot cap, and all of them within the run's budget. Throws otherwise. */
export function checkedBrowserEvidenceCaptured(captured: unknown): BrowserEvidenceCaptured {
  const parsed = CapturedSchema.safeParse(captured);
  if (!parsed.success) throw new Error(INVALID);
  return parsed.data as BrowserEvidenceCaptured;
}
function checkedOutcome(outcome: unknown): BrowserEvidenceOutcome {
  const parsed = OutcomeSchema.safeParse(outcome);
  if (!parsed.success) throw new Error(INVALID);
  return parsed.data as BrowserEvidenceOutcome;
}

/**
 * The evidence-pack check (v2) and its not-tested rows. Always kind `visual`, run by Rovara in the sandbox stage, so it never counts toward the change proof (check-kinds.ts). One pair per shown
 * route. A run that showed nothing is `not_run` with no pairs. Throws on an outcome it does not understand rather than writing a guess.
 */
export function browserEvidenceCheck(outcome: BrowserEvidenceOutcome): { check: EvidenceCheckV2; videoCheck?: EvidenceCheckV2; notTested: EvidencePackV2["notTested"] } {
  const checked = checkedOutcome(outcome);
  const shown = checked.routes.filter((row): row is Extract<BrowserEvidenceRouteResult<ArtifactRef>, { status: "shown" }> => row.status === "shown");
  const any = shown.length > 0;
  const check: EvidenceCheckV2 = {
    // `class` is neutral (a picture is not a pass); the stage is the sandbox only when it ran there (a laptop has no stage of its own: the producer says where).
    id: BROWSER_EVIDENCE_CHECK_ID, kind: "visual", label: CHECK_LABEL, ...(checked.isolation === "sandbox" ? { stage: "sandbox" as const } : {}), runBy: "rovara",
    before: any ? "passed" : "not_run", after: any ? "passed" : "not_run", class: "not_rerun", durationMs: checked.durationMs,
    ...(any ? { pairs: shown.map((row) => ({ id: row.route, before: row.before, after: row.after })) } : {}),
  };
  // Slice 4: the videos of failed pages are a check of their own (the same `visual` kind, so never proof): one pair per kept video, the video as its `after`. Neither outcome is claimed (`unknown`): a recording is not a result.
  const videos = checked.routes.flatMap((row) => (row.video === undefined ? [] : [{ id: row.route, after: row.video }]));
  const videoCheck: EvidenceCheckV2 | undefined = videos.length === 0 ? undefined : {
    id: BROWSER_EVIDENCE_VIDEO_CHECK_ID, kind: "visual", label: VIDEO_CHECK_LABEL, ...(checked.isolation === "sandbox" ? { stage: "sandbox" as const } : {}), runBy: "rovara",
    before: "not_run", after: "unknown", class: "not_rerun", durationMs: checked.durationMs, pairs: videos,
  };
  const notTested: EvidencePackV2["notTested"] = [
    ...(checked.notRun === undefined ? [] : [{ what: CHECK_LABEL, reason: `Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[checked.notRun]}` }]),
    ...checked.routes.flatMap((row) => (row.status === "not_run" ? [{ what: `${CHECK_LABEL}: ${row.route}`, reason: `Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[row.reason]}` }] : [])),
    ...checked.notShown.map((row) => ({ what: `${CHECK_LABEL}: ${row.route}`, reason: `Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}` })),
    ...(checked.moreNotShown > 0 ? [{ what: `${CHECK_LABEL}: ${String(checked.moreNotShown)} more changed pages`, reason: `Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS.over_route_cap}` }] : []),
    ...checked.routes.flatMap((row) => (row.videoNotKept === undefined ? [] : [{ what: `${VIDEO_CHECK_LABEL}: ${row.route}`, reason: `Not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS[row.videoNotKept]}` }])),
  ];
  return { check, ...(videoCheck === undefined ? {} : { videoCheck }), notTested };
}

/**
 * The pack with the browser-evidence check added. No outcome: the very same pack object (absent = today's behaviour, byte for byte). Refuses a pack that already has the check, or whose
 * producer says another place than the outcome, or that would go over the pack's own limits.
 */
export function addBrowserEvidenceToPack(pack: EvidencePackV2, outcome: BrowserEvidenceOutcome | undefined): EvidencePackV2 {
  if (outcome === undefined) return pack;
  const { check, videoCheck, notTested } = browserEvidenceCheck(outcome);
  const added = videoCheck === undefined ? [check] : [check, videoCheck];
  if (pack.checks.some((entry) => entry.id === BROWSER_EVIDENCE_CHECK_ID || entry.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID) || pack.producer.isolation !== outcome.isolation
    || pack.checks.length + added.length > EVIDENCE_CHECKS_MAX || pack.notTested.length + notTested.length > EVIDENCE_NOT_TESTED_MAX) throw new Error(INVALID);
  return { ...pack, checks: [...pack.checks, ...added], notTested: [...pack.notTested, ...notTested] };
}

// ---- the pull request

/** A link to the task page, as the PR may carry it: https, a host, a plain path; nothing a reader could mistake for other markup. */
const TASK_LINK = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/u;
const TASK_LINK_MAX = 300;

/**
 * The pull request's lines (O27): text only. Who ran it and that it is not proof, then each route with "before and after screenshots" and a link to the task page behind sign-in, or "Not run"
 * with its fixed reason. No image, no artifact address, no digest is ever written. No outcome: no line (absent = today's behaviour).
 */
export function browserEvidenceLines(outcome: BrowserEvidenceOutcome | undefined, options: { taskLink?: string | undefined }): string[] {
  if (outcome === undefined) return [];
  const checked = checkedOutcome(outcome);
  const link = typeof options.taskLink === "string" && options.taskLink.length <= TASK_LINK_MAX && TASK_LINK.test(options.taskLink) ? options.taskLink : undefined;
  const where = link === undefined ? " (on the task page, behind sign-in)" : ` (view behind sign-in: ${link})`;
  const errors = (count: number) => (count === 0 ? "" : `, ${String(count)} console error${count === 1 ? "" : "s"} after`);
  // Slice 4: a failed page's video, said in words only (kept, behind sign-in; or the fixed reason it is not). Where the file is, and its digest, are never written.
  const video = (row: { video?: unknown; videoNotKept?: BrowserEvidenceVideoNotKeptReason }) => (row.video !== undefined ? " Video of the failure: kept (download behind sign-in)."
    : row.videoNotKept !== undefined ? ` Video of the failure: Not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS[row.videoNotKept]}.` : "");
  return [
    `${CHECK_LABEL}: ${BROWSER_EVIDENCE_RUN_BY_WORDS[checked.isolation]}. ${BROWSER_EVIDENCE_NOT_PROOF_WORDS}`,
    ...(checked.notRun === undefined ? [] : [`- Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[checked.notRun]}`]),
    ...checked.routes.map((row) => (row.status === "shown"
      ? `- \`${row.route}\`: before and after screenshots${errors(row.consoleErrors.after)}${where}${video(row)}`
      : `- \`${row.route}\`: Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[row.reason]}${video(row)}`)),
    ...checked.notShown.map((row) => `- \`${row.route}\`: Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}`),
    ...(checked.moreNotShown > 0 ? [`- ${String(checked.moreNotShown)} more changed pages not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS.over_route_cap}`] : []),
  ];
}
