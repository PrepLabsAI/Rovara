// Setup and test health SH4 (design setup-test-health.md, section 7): the setup RECIPE (the confirmed, generic part of a setup that a company can offer to its other projects), and the FINGERPRINT that decides
// which projects a recipe fits.
//
// A recipe holds: the build systems, toolchain versions, command templates (paths as `{repo}`), update commands, report/coverage/SARIF paths, `selectArgs`, approved hosts and the dev container base image.
// It NEVER holds a repository name, a secret name or value, a data seed or an account, and the schema has no field for them. A recipe is only ever a PROPOSAL for a new project: it is still proved there and confirmed on
// the card (design 7.2); nothing here applies, runs or approves anything.
//
// The fingerprint is a hash of two closed or normalised sets: which known marker files a repository has (a fixed list of file names, so a stray file name cannot carry a repository name in) and which registry hosts it uses.
// Pure: no Node module, no clock, no network.
import { z } from "zod";
import { isAllowedDomain } from "./app-projects.js";
import { canonicalJson } from "./canonical-json.js";
import { CheckKindSchema } from "./evidence.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { sha256Hex } from "./web-hash.js";

export const SETUP_RECIPE_SCHEMA_VERSION = 1;
export const SETUP_FINGERPRINT_VERSION = 1;
export const SETUP_RECIPE_MAX_COMMANDS = 20;
export const SETUP_RECIPE_MAX_CHECKS = 32;
export const SETUP_RECIPE_MAX_HOSTS = 50;
export const SETUP_RECIPE_MAX_TOOLCHAINS = 16;
export const SETUP_RECIPE_MAX_BUILD_SYSTEMS = 8;
/** The most hosts a fingerprint covers. */
export const SETUP_FINGERPRINT_MAX_HOSTS = 32;

/** A recipe's id: `rcp_` and 20 hex characters. */
export const SetupRecipeIdSchema = z.string().regex(/^rcp_[a-f0-9]{20}$/u);
export type SetupRecipeId = z.infer<typeof SetupRecipeIdSchema>;

/** The value source a recipe-made value carries: `recipe:<id>@<revision>`. */
export type SetupRecipeSource = `recipe:${string}@${string}`;
export const setupRecipeSource = (id: string, revision: number): SetupRecipeSource => `recipe:${SetupRecipeIdSchema.parse(id)}@${String(z.number().int().min(1).parse(revision))}`;
export function parseSetupRecipeSource(source: string): { id: string; revision: number } | undefined {
  const match = /^recipe:(rcp_[a-f0-9]{20})@([1-9][0-9]{0,8})$/u.exec(source);
  return match === null ? undefined : { id: match[1] as string, revision: Number(match[2]) };
}

/**
 * The marker files a repository is recognised by: the files the detectors key on. A closed list, on purpose: a fingerprint input is never an arbitrary file name, so it cannot carry a repository's name.
 * Extend it with a detector (Go's `go.mod` and `go.work` are here already).
 */
export const SETUP_MARKER_FILES: readonly string[] = [
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "Config", "go.mod", "go.work", "Cargo.toml", "Gemfile", "composer.json", "devcontainer.json",
];
const MARKER_SET: ReadonlySet<string> = new Set(SETUP_MARKER_FILES);

/** The known marker files among a repository's paths, by file name (the directory is dropped), as a sorted set. */
export function markerFilesOf(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const filePath of paths) {
    const name = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (MARKER_SET.has(name)) found.add(name);
  }
  return [...found].sort();
}

/** An exact host (no wildcard, no IP literal, no public suffix), lower case. A wildcard would approve every site under a name, so a recipe never carries one. */
export const RecipeHostSchema = z.string().transform((value, context) => {
  const host = value.toLowerCase();
  if (!host.startsWith("*.") && !host.startsWith("*") && isAllowedDomain(host)) return host;
  context.addIssue({ code: "custom", message: "must be an exact host name such as registry.example.com" });
  return z.NEVER;
});

const IdWord = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const line = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u, "one line of text");

/** What a recipe matches on. */
export const SetupRecipeMatchSchema = z.object({
  markerFiles: z.array(z.enum(SETUP_MARKER_FILES as [string, ...string[]])).min(1).max(SETUP_MARKER_FILES.length),
  registryHosts: z.array(RecipeHostSchema).max(SETUP_FINGERPRINT_MAX_HOSTS),
}).strict();
export type SetupRecipeMatch = z.infer<typeof SetupRecipeMatchSchema>;

/** `{repo}` is the repository's own directory; the rest is a path inside it. */
export const REPO_PLACEHOLDER = "{repo}";
const RecipeCwdSchema = z.string().refine((value) => {
  if (value === REPO_PLACEHOLDER) return true;
  return value.startsWith(`${REPO_PLACEHOLDER}/`) && RelativeWorkspacePathSchema.safeParse(value.slice(REPO_PLACEHOLDER.length + 1)).success;
}, "a working directory is {repo} or {repo}/<path inside it>");

/** A path inside the repository, written `{repo}/<path>`. A report, coverage or SARIF path is relative to the repository like a command's directory, so the workspace layout never shows. */
export const RecipePathSchema = z.string().refine((value) => value.startsWith(`${REPO_PLACEHOLDER}/`) && RelativeWorkspacePathSchema.safeParse(value.slice(REPO_PLACEHOLDER.length + 1)).success, "a path is {repo}/<path inside it>");

/** The text `selectArgs` must hold exactly once: the same marker the test environment uses. */
export const RECIPE_SELECT_PLACEHOLDER = "{tests}";

/** A command template. It has no `env` field: variables stay with the project, and a recipe never carries one that could hold a secret. */
export const RecipeCommandSchema = z.object({
  cwd: RecipeCwdSchema,
  executable: z.string().min(1).max(256),
  args: z.array(z.string().max(8_192)).max(256),
  timeoutSeconds: z.number().int().positive().max(86_400),
}).strict();
export type RecipeCommand = z.infer<typeof RecipeCommandSchema>;

export const RecipeCheckSchema = z.object({
  id: IdWord,
  label: line(80),
  command: RecipeCommandSchema,
  kind: CheckKindSchema,
  reportPath: RecipePathSchema.optional(),
  coveragePath: RecipePathSchema.optional(),
  sarifPath: RecipePathSchema.optional(),
  selectArgs: z.array(z.string().min(1).max(256)).max(8).optional(),
}).strict().superRefine((check, context) => {
  if (check.selectArgs !== undefined && check.selectArgs.filter((arg) => arg === RECIPE_SELECT_PLACEHOLDER).length !== 1) context.addIssue({ code: "custom", path: ["selectArgs"], message: "selectArgs holds {tests} exactly once" });
  if (check.selectArgs !== undefined && check.kind !== "test") context.addIssue({ code: "custom", path: ["selectArgs"], message: "only a test check selects tests" });
});
export type RecipeCheck = z.infer<typeof RecipeCheckSchema>;

const IMAGE_REFERENCE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/u;

export const SetupRecipeBodySchema = z.object({
  schemaVersion: z.literal(SETUP_RECIPE_SCHEMA_VERSION),
  /** The admin's name for the recipe. It is checked for repository names like the rest of the body. */
  label: line(80),
  /** Detector or build-system ids (`python`, `node`, `java`, `go`, ...). */
  buildSystems: z.array(IdWord).min(1).max(SETUP_RECIPE_MAX_BUILD_SYSTEMS),
  toolchains: z.array(z.object({ tool: IdWord, version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/u) }).strict()).max(SETUP_RECIPE_MAX_TOOLCHAINS),
  setupCommands: z.array(RecipeCommandSchema).max(SETUP_RECIPE_MAX_COMMANDS),
  updateCommands: z.array(RecipeCommandSchema).max(SETUP_RECIPE_MAX_COMMANDS),
  checks: z.array(RecipeCheckSchema).max(SETUP_RECIPE_MAX_CHECKS),
  approvedHosts: z.array(RecipeHostSchema).max(SETUP_RECIPE_MAX_HOSTS),
  devcontainerBaseImage: z.string().max(256).regex(IMAGE_REFERENCE, "an image reference").optional(),
  match: SetupRecipeMatchSchema,
}).strict().superRefine((body, context) => {
  const ids = new Set<string>();
  body.checks.forEach((check, index) => {
    if (ids.has(check.id)) context.addIssue({ code: "custom", path: ["checks", index, "id"], message: "check ids are unique" });
    ids.add(check.id);
  });
});
export type SetupRecipeBody = z.infer<typeof SetupRecipeBodySchema>;

// ---- fingerprint

export interface SetupFingerprintInput { markerFiles: readonly string[]; registryHosts: readonly string[] }

/**
 * The fingerprint of a repository, or of a recipe's `match`: sha256 of the marker files and registry hosts as sorted sets. Two projects fit the same recipe when their fingerprints are equal (same marker files, same
 * registry hosts). A marker file outside the closed list throws (a caller passes `markerFilesOf(paths)`); a host is lower-cased and must be an exact host; a repeated entry counts once.
 */
export function setupFingerprint(input: SetupFingerprintInput): string {
  const match = SetupRecipeMatchSchema.parse({ markerFiles: [...new Set(input.markerFiles)], registryHosts: [...new Set(input.registryHosts.map((host) => host.toLowerCase()))] });
  return sha256Hex(canonicalJson({
    kind: "rovara.setup-fingerprint",
    version: SETUP_FINGERPRINT_VERSION,
    markerFiles: [...match.markerFiles].sort(),
    registryHosts: [...new Set(match.registryHosts)].sort(),
  }));
}

/** Whether a recipe fits a repository: equal fingerprints. A repository with no known marker file, or a host that does not parse, fits nothing (false, never a throw). */
export function recipeFits(recipe: Pick<SetupRecipeBody, "match">, repository: SetupFingerprintInput): boolean {
  try { return setupFingerprint(recipe.match) === setupFingerprint(repository); } catch { return false; }
}

// ---- no repository names

/** Every string value in a JSON value (keys are the schema's words, not the admin's, and the `{repo}` placeholder is stripped by the caller). */
function stringValuesOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValuesOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringValuesOf);
  return [];
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether any of the given repository names (full names like `owner/name`, short names, directory names) appears in the recipe, as a whole word, in any case: the recipe is generic, so a hit means a person must remove it.
 * `owner/name` counts as the name and the owner both. Empty and one-character names are ignored (they would match every word).
 */
export function recipeNamesRepository(body: SetupRecipeBody, repositoryNames: readonly string[]): boolean {
  const text = stringValuesOf(body).join("\n").replaceAll(REPO_PLACEHOLDER, " ");
  const names = new Set<string>();
  for (const full of repositoryNames) {
    names.add(full);
    for (const part of full.split("/")) names.add(part);
  }
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    // `orders-api`, `orders_api`, `orders.api` and `orders api` are the same name here.
    const pattern = trimmed.split(/[-_. ]+/u).map(escapeRegExp).join("[-_. ]+");
    if (new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "iu").test(text)) return true;
  }
  return false;
}

/** sha256 of the recipe body: what a revision approves. Two recipes with the same content in a different key order have the same digest. */
export function setupRecipeDigest(body: SetupRecipeBody): string {
  return sha256Hex(canonicalJson(SetupRecipeBodySchema.parse(body)));
}

// ---- offers (SH30)

/** The most recipes one setup run is offered, and the most bytes of their bodies: the broker offers one recipe per fingerprint, newest first, and stops at either bound. */
/** A worker that lists this runs a setup draft that is offered company recipes (`testEnvRecipes`, switch `sp`); the broker sends the field only to such a worker, never dropped. */
export const SETUP_RECIPES_FEATURE = "task.setupRecipes.v1" as const;
export const SETUP_RECIPE_OFFERS_MAX = 30;
export const SETUP_RECIPE_OFFERS_MAX_BYTES = 262_144;

/**
 * One approved recipe the broker offers a project's setup run (the run reads the repository's default branch, finds which offer FITS by fingerprint, and proposes from that one). The id and revision are the value
 * source `recipe:<id>@<revision>` of everything the recipe adds. It carries the body only: no company id, no approver, no scope.
 */
export const SetupRecipeOfferSchema = z.object({
  recipeId: SetupRecipeIdSchema,
  revision: z.number().int().min(1).max(999_999_999),
  body: SetupRecipeBodySchema,
}).strict();
export type SetupRecipeOffer = z.infer<typeof SetupRecipeOfferSchema>;
