// Company recipes as a PROPOSAL SOURCE (SH30, setup-test-health design section 7): when a repository fits a company recipe (the same marker files and the same private registry hosts, SH4), the recipe's setup
// commands and checks are added to what the detectors found. Nothing here applies, runs or approves anything: the result is a Detection like any other, so it becomes a sandbox-tier proposal, is PROVED in a fresh
// sandbox and is confirmed on the card.
//
// Rules:
//   - main branch only (ED-1): the fingerprint is computed from the reader the caller gives, which is the repository's default branch (the caller skips a checked-out pull request, test-env-detect.ts). Nothing
//     about which recipe fits comes from a branch, a ref or a SHA in task input, and a recipe can name none;
//   - the broker offers recipes (approved, offered to the project, within the company's locks); the worker picks the one that FITS by fingerprint, the newest first, and uses ONE recipe per repository;
//   - every value a recipe adds is cited `recipe:<id>@<revision>`, including its report, coverage and SARIF paths, so none reads as the model's;
//   - code first: a command a detector already proposed is kept as the detector's, and a check id a detector took is not taken from it (the recipe's check gets `<id>-recipe`), as for two detectors;
//   - a recipe command that downloads and runs code (`remoteCodeReason`) is left out, as for a detected or model command: an admin's approval of a recipe does not clear it;
//   - a recipe never changes the tier, the nightly run, services, accounts, data or capture: it adds commands and checks only;
//   - fail closed: a cut file list (the repository has more files than are read), an offer that does not parse, a fingerprint that cannot be computed, or no fit, adds nothing.
// Pure over a bounded reader: nothing is run, downloaded or written.
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, ProjectCommandSchema, RecipeHostSchema, SETUP_FINGERPRINT_MAX_HOSTS, SETUP_RECIPE_OFFERS_MAX, SetupRecipeBodySchema, formatCommandLine, markerFilesOf, parseSetupRecipeSource, recipeFits, remoteCodeReason,
  setupRecipeSource, type ProjectCommand, type RecipeCommand, type SetupRecipeBody, type SetupRecipeOffer,
} from "@agentx/contracts";
import { emptyDetection, type DetectedCheck, type DetectedSource, type Detection, type RepositoryReader } from "./types.js";

/** One recipe the broker offered to the project: its id and revision (the value source) and its body. */
export type RecipeOffer = SetupRecipeOffer;

/** The most offers read and the most registry configuration files read per repository. */
export const RECIPE_OFFERS_MAX = SETUP_RECIPE_OFFERS_MAX;
const REGISTRY_FILES_MAX = 20;
const MAX_CHECKS = 32;
const MAX_SETUP_COMMANDS = 20;

// ---- the repository's private registry hosts (half of the fingerprint)

const REGISTRY_FILE = /^(?:\.npmrc|\.yarnrc|\.yarnrc\.yml|pip\.conf|pip\.ini|uv\.toml|pyproject\.toml|settings\.xml|requirements[^/]*\.txt)$/u;
/** A line that names a package source. A URL elsewhere (a homepage, a link) is not one. */
const REGISTRY_LINE = /(?:registry|index-url|extra-index-url|index_url|find-links|npmRegistryServer|<url>|\burl\s{0,40}[=:])/iu;
/** `http(s)://<host>[:port]` followed by a delimiter. A URL with credentials (`user:token@host`) does not match: the user part is not a host, so nothing in it is read. */
const URL_HOST = /https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d{1,5})?(?=[/\s"'<>),;]|$)/giu;

const defaultHosts: ReadonlySet<string> = new Set(DEFAULT_AGENT_ALLOW_DOMAINS);

/**
 * The private registry hosts a repository's package-manager configuration names, as a sorted set: the files a package manager reads for its sources (`.npmrc`, `pip.conf`, `requirements*.txt`, `settings.xml`, ...),
 * the hosts of the URLs on lines that name a registry or an index, exact hosts only (no IP literal, no wildcard), minus the hosts every project may reach already (the default allow list: a public registry says
 * nothing about a company's setup). Credentials in a URL are never read. This is the host half of `setupFingerprint`; whoever writes a recipe's `match.registryHosts` means the same set.
 * Undefined when there are more hosts than a fingerprint covers (such a repository fits no recipe).
 */
export async function registryHostsOf(reader: RepositoryReader): Promise<string[] | undefined> {
  const hosts = new Set<string>();
  const files = reader.paths.filter((path) => REGISTRY_FILE.test(path.slice(path.lastIndexOf("/") + 1))).slice(0, REGISTRY_FILES_MAX);
  for (const path of files) {
    const text = await reader.read(path);
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      // The keyword must be in the line's own words, not inside a URL (`homepage=https://not-a-registry.example.com`).
      if (!REGISTRY_LINE.test(line.replace(/https?:\/\/\S*/giu, ""))) continue;
      for (const match of line.matchAll(URL_HOST)) {
        const parsed = RecipeHostSchema.safeParse(match[1]);
        if (parsed.success && !defaultHosts.has(parsed.data)) hosts.add(parsed.data);
      }
    }
  }
  return hosts.size > SETUP_FINGERPRINT_MAX_HOSTS ? undefined : [...hosts].sort();
}

// ---- turning a recipe into detections

const underRepository = (cwd: string, sub: string | undefined): string => (sub === undefined || sub === "" ? cwd : cwd === "." || cwd === "" ? sub : `${cwd}/${sub}`);

/** `{repo}` is the repository's directory in the workspace; `{repo}/x` is `x` inside it. */
function commandOf(command: RecipeCommand, cwd: string): ProjectCommand | undefined {
  const inside = command.cwd === "{repo}" ? undefined : command.cwd.slice("{repo}/".length);
  const parsed = ProjectCommandSchema.safeParse({ cwd: underRepository(cwd, inside), executable: command.executable, args: command.args, timeoutSeconds: command.timeoutSeconds });
  return parsed.success ? parsed.data : undefined;
}

/** `{repo}/reports/junit.xml` is `reports/junit.xml`: the detectors' paths are relative to the repository. */
const pathOf = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.slice("{repo}/".length));

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);

export interface RecipeApplied {
  detection: Detection;
  /** The recipe that was used (its value source is on every value it added); undefined when none fit. */
  used?: { recipeId: string; revision: number; source: DetectedSource };
  /** Recipes that fit but were not used (an older one with the same fingerprint, or invalid). */
  notUsed: number;
}

/**
 * Adds the fitting recipe's setup commands and checks to a detection (a new Detection; the argument is not changed). `reader` must be the repository's default branch; `cwd` is its directory in the workspace.
 * See the file comment for the rules. A recipe command left out for downloading and running code is said in a note.
 */
export async function applyRecipe(detection: Detection, offers: readonly RecipeOffer[], reader: RepositoryReader, cwd: string): Promise<RecipeApplied> {
  const unchanged: RecipeApplied = { detection, notUsed: 0 };
  if (offers.length === 0) return unchanged;
  // A cut file list cannot prove which marker files the repository has, so no recipe is matched on it.
  if (reader.truncated === true) return { detection: { ...detection, notes: [...detection.notes, "This repository has more files than Rovara reads, so no company recipe was matched."] }, notUsed: 0 };
  const hosts = await registryHostsOf(reader);
  if (hosts === undefined) return unchanged;
  const repository = { markerFiles: markerFilesOf(reader.paths), registryHosts: hosts };
  const fitting: Array<{ offer: RecipeOffer; body: SetupRecipeBody }> = [];
  for (const offer of offers.slice(0, RECIPE_OFFERS_MAX)) {
    const body = SetupRecipeBodySchema.safeParse(offer.body);
    if (!body.success || !Number.isInteger(offer.revision) || offer.revision < 1 || parseSetupRecipeSource(`recipe:${offer.recipeId}@${String(offer.revision)}`) === undefined) continue;
    if (recipeFits(body.data, repository)) fitting.push({ offer, body: body.data });
  }
  const chosen = fitting[0];
  if (chosen === undefined) return unchanged;

  const source: DetectedSource = setupRecipeSource(chosen.offer.recipeId, chosen.offer.revision);
  const merged: Detection = { ...emptyDetection(), ...detection, setupCommands: [...detection.setupCommands], checks: [...detection.checks], notes: [...detection.notes] };
  let leftOut = 0;
  const allowed = (command: ProjectCommand): boolean => {
    if (remoteCodeReason(formatCommandLine(command)) === undefined) return true;
    leftOut += 1;
    return false;
  };

  for (const raw of chosen.body.setupCommands) {
    const command = commandOf(raw, cwd);
    if (command === undefined || !allowed(command)) continue;
    if (merged.setupCommands.some((existing) => sameCommand(existing.value, command)) || merged.setupCommands.length >= MAX_SETUP_COMMANDS) continue;
    merged.setupCommands.push({ value: command, source });
  }
  const ids = new Set(merged.checks.map((check) => check.value.id));
  for (const raw of chosen.body.checks) {
    const command = commandOf(raw.command, cwd);
    if (command === undefined || !allowed(command)) continue;
    // Code first: a check a detector already proposes (same program, arguments and directory) stays the detector's.
    if (merged.checks.some((existing) => sameCommand(existing.value.command, command)) || merged.checks.length >= MAX_CHECKS) continue;
    const id = freeId(raw.id, ids);
    ids.add(id);
    const reportPath = pathOf(raw.reportPath);
    const coveragePath = pathOf(raw.coveragePath);
    const sarifPath = pathOf(raw.sarifPath);
    const check: DetectedCheck = {
      id, label: raw.label, command, kind: raw.kind,
      ...(reportPath === undefined ? {} : { reportPath, reportSource: source }),
      ...(coveragePath === undefined ? {} : { coveragePath, coverageSource: source }),
      ...(sarifPath === undefined ? {} : { sarifPath, sarifSource: source }),
      ...(raw.selectArgs === undefined ? {} : { selectArgs: [...raw.selectArgs] }),
    };
    merged.checks.push({ value: check, source });
  }
  if (leftOut > 0) merged.notes.push("A command in the company recipe downloads and runs code, so it was left out. Add it yourself if you want it.");
  if (chosen.body.devcontainerBaseImage !== undefined) merged.notes.push(`The company recipe uses the dev container image ${chosen.body.devcontainerBaseImage}. Adding a dev container is a separate step that a person approves.`);
  merged.notes.push("This setup started from your company's recipe. It is still proved in a fresh sandbox and confirmed by a person before anything uses it.");
  return { detection: merged, used: { recipeId: chosen.offer.recipeId, revision: chosen.offer.revision, source }, notUsed: fitting.length - 1 };
}

/** `unit` taken becomes `unit-recipe`, then `unit-recipe-2`: always a valid, unused check id (a recipe's check is kept, not silently replaced). */
function freeId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  const base = `${id}-recipe`.slice(0, 64);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
