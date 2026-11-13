// Test environment (wire-testenv): the worker's half of "Rovara proposes the project's test environment". A SETUP_DRAFT run that was asked to detect (`testEnvDetect`) runs the environment detectors (env-detect/) over
// each repository of the workspace and reports ONE draft environment with the source of every value. Nothing is run: detectors read files and a draft is only a proposal. The broker reads it again, refuses anything
// but the safest tier, and a maintainer proves and approves it.
//
// Rules (owner decision "Setup reads the main branch only", ED-1):
//   - only the repositories as the setup draft cloned them: their default branch. A repository with a pull request head checked out (`checkedOut`) is skipped, so a pull request cannot change how Rovara sets a project
//     up or which commands the test drive runs;
//   - a link is never followed: every part of a path is `lstat`ed, a link or a special file is skipped, and a file is opened with O_NOFOLLOW;
//   - bounded: at most 5,000 files listed per repository (env-detect's own cap), a file over 256 KiB is not read, depth 8, and a total of 4 MiB per repository;
//   - the setup agent's own commands are added only through `proposalFromDraft` (it drops a flagged command, a download-and-run command, and one the detectors already propose);
//   - the dependencies the detectors found (test services D1-D7) ride in the draft as CANDIDATES (`TestEnvDraft.dependencies`), never in its environment: the broker chooses a backing and a person approves. A candidate is a
//     family, a kind, fixed words, numbers, variable NAMES and repository paths, never a value read from a file. One that cannot be listed (the contract refuses it, or it has no usable sighting) is left out with a fixed
//     sentence, and the candidates as a whole are left out, not the draft, when they would make it too large: a dependency can never cost the draft it travels in.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { TEST_ENV_CANDIDATE_MAX, TEST_ENV_DRAFT_MAX_BYTES, TEST_ENV_DRAFT_NONE_KEY, type TestEnvDraftNoneReason, TEST_ENV_SEED_COMMANDS_MAX, TestEnvDependencyCandidateSchema, TestEnvDraftSchema, type SetupDraft, type SetupProposal, type TestEnvDependencyCandidate, type TestEnvDraft, type TestEnvironmentBody } from "@rovara-code/contracts";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_PATHS, boundedReader, buildEnvironmentDraft, proposalFromDraft } from "./env-detect/index.js";
import { runDetectorsGuarded } from "./env-detect/guarded.js";
import type { WorkerLogSink } from "./worker-log.js";
import { applyRecipe, type RecipeOffer } from "./env-detect/recipes.js";
import { joinInside, mergeCandidates } from "./env-detect/dependency-candidates.js";
import type { DependencyCandidate } from "./env-detect/types.js";

export interface DetectRepository { name: string; path: string; defaultBranch: string; checkedOut?: unknown }

/** Folders that never hold a project's own build or test setup. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".gradle", ".mvn-cache"]);
const MAX_DEPTH = 8;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The plain files of a directory, as repository-relative POSIX paths, without following any link. Bounded by the file count and the depth. */
export async function listRepositoryFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (found.length > ENV_DETECT_MAX_PATHS || depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = (await readdir(join(directory, relative))).sort(); } catch { return; }
    for (const name of entries) {
      if (found.length > ENV_DETECT_MAX_PATHS) return;
      if (SKIP_DIRECTORIES.has(name)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      let info;
      try { info = await lstat(join(directory, path)); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) found.push(path);
    }
  };
  await walk("", 0);
  return found;
}

/** A file's text, or undefined when it is a link, too large, not UTF-8 text or unreadable. */
export async function readRepositoryFile(directory: string, path: string): Promise<string | undefined> {
  let handle;
  try {
    // O_NOFOLLOW covers the last part of the path only: a link in the middle (a folder that points elsewhere) is caught by checking where the path really ends up.
    const [base, real] = await Promise.all([realpath(directory), realpath(join(directory, path))]);
    if (!real.startsWith(`${base}${sep}`)) return undefined;
    handle = await open(join(directory, path), READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > ENV_DETECT_MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, ENV_DETECT_MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The commands the setup agent proposed for one repository, as the draft the environment builder fills its gaps from. */
function agentDraftFor(proposal: SetupProposal | undefined, repository: string): SetupDraft {
  const commands = (items: SetupProposal["setup"]) => items.filter((item) => item.value.repo === repository).flatMap((item) => item.value.commands).slice(0, 20);
  return {
    basedOnRevision: proposal?.basedOnRevision ?? 0,
    setupCommands: proposal === undefined ? [] : commands(proposal.setup),
    testCommands: proposal === undefined ? [] : commands(proposal.tests),
    allowedDomains: [], secretsNeeded: [],
    flaggedCommands: (proposal?.flaggedCommands ?? []).map((item) => ({ command: item.command, reason: item.reason })).slice(0, 40),
    notes: "",
  };
}

/** `unit` already taken by another repository becomes `unit-2`, `unit-3`: every check id of the environment is unique. */
function uniqueId(id: string, taken: Set<string>): string {
  let candidate = id;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${String(n)}`;
    candidate = `${id.slice(0, 64 - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * The draft environment of a workspace: the detectors' findings for every repository (default branch only), merged into one sandbox-tier environment, with the setup agent's commands added where code found none.
 * Undefined when there is nothing to propose (no repository was readable, or no detector found a check) or the merged environment is not valid: a draft that cannot be proposed is not reported.
 */
export async function detectTestEnvironment(input: { rootPath: string; repositories: readonly DetectRepository[]; setupProposal?: SetupProposal | undefined; recipes?: readonly RecipeOffer[] | undefined; detectTimeoutMs?: number | undefined; log?: WorkerLogSink | undefined }): Promise<TestEnvDraft | undefined> {
  const environments: TestEnvironmentBody[] = [];
  const valueSources: TestEnvDraft["valueSources"] = [];
  const pending: TestEnvDraft["pendingServices"] = [];
  const notes: string[] = [];
  const questions: string[] = [];
  const takenIds = new Set<string>();
  const found: DependencyCandidate[] = [];
  const seeds: NonNullable<TestEnvDraft["seedCommands"]> = [];
  const seedFiles: NonNullable<TestEnvDraft["seedFiles"]> = [];
  let notPlaced = 0;
  for (const repository of input.repositories) {
    if (repository.checkedOut !== undefined) { notes.push(`A pull request's files were checked out in ${repository.name}; only the default branch is read, so it was left out.`); continue; }
    const directory = join(input.rootPath, repository.path);
    const paths = await listRepositoryFiles(directory);
    const { reader } = boundedReader(paths, (path) => readRepositoryFile(directory, path));
    const detected = await runDetectorsGuarded(reader, repository.path, { timeoutMs: input.detectTimeoutMs, log: input.log });
    // Company recipes (SH30, switch `sp`): offered only when the broker's switch is on. A recipe adds commands and checks the detectors did not find, each cited `recipe:<id>@<revision>`, from the same default-branch
    // reader as the detectors; it never fails the draft.
    const detection = input.recipes === undefined || input.recipes.length === 0 ? detected : await applyRecipe(detected, input.recipes, reader, repository.path).then((applied) => applied.detection, () => detected);
    const placed = inWorkspace(detection.dependencies, repository.path);
    found.push(...placed.candidates);
    notPlaced += placed.dropped;
    const draft = buildEnvironmentDraft(detection, { repositoryId: repository.name, nightlyBranch: repository.defaultBranch });
    if ("ok" in draft) { notes.push(`The setup of ${repository.name} could not be put together from what was found.`); continue; }
    // The setup agent fills only the gaps: its commands go through the same schema, and a flagged one is dropped.
    const filled = proposalFromDraft(draft, agentDraftFor(input.setupProposal, repository.name), { cwd: repository.path });
    for (const seed of filled.ok ? filled.seedCommands : draft.seedCommands) if (seeds.length < TEST_ENV_SEED_COMMANDS_MAX) seeds.push(seed);
    // TS-UX-1 item 9: SQL seed files, offered (with a database) as the database's file seed, workspace-relative like a seed's fixturePath.
    if (draft.routesSeeds) for (const file of detection.seedFiles ?? []) if (seedFiles.length < TEST_ENV_SEED_COMMANDS_MAX) seedFiles.push({ path: `${repository.path}/${file.value}`, source: typeof file.source === "string" ? "detector:seed-files" : file.source });
    const environment = filled.ok ? filled.proposal.environment : draft.environment;
    const sources = filled.ok ? filled.proposal.valueSources : draft.valueSources;
    const index = environments.length;
    // Check ids are unique across repositories; the fields that name a check by position keep their meaning.
    const renamed = new Map<string, string>();
    const repoEnv: TestEnvironmentBody = {
      ...environment,
      repos: environment.repos.map((repo) => ({ ...repo, checks: repo.checks.map((check) => { const id = uniqueId(check.id, takenIds); renamed.set(check.id, id); return id === check.id ? check : { ...check, id }; }) })),
    };
    repoEnv.selection = { ...repoEnv.selection, alwaysRun: repoEnv.selection.alwaysRun.map((id) => renamed.get(id) ?? id) };
    environments.push(repoEnv);
    for (const item of sources) valueSources.push({ field: item.field.replace(/^repos\[0\]/u, `repos[${String(index)}]`), source: item.source });
    pending.push(...draft.pendingServices.map((service) => ({ kind: service.kind, target: service.target })));
    notes.push(...draft.notes);
    questions.push(...draft.questions);
  }
  const first = environments[0];
  if (first === undefined) return undefined;
  const merged: TestEnvironmentBody = {
    ...first,
    repos: environments.flatMap((environment) => environment.repos),
    selection: {
      method: environments.some((environment) => environment.selection.method === "coverage_map") ? "coverage_map" : "full",
      alwaysRun: [...new Set(environments.flatMap((environment) => environment.selection.alwaysRun))],
      fullSuiteOn: [...new Set(environments.flatMap((environment) => environment.selection.fullSuiteOn))].slice(0, 100),
    },
  };
  if (merged.repos.every((repo) => repo.checks.length === 0)) return undefined;
  const base = {
    environment: merged,
    valueSources: valueSources.slice(0, 400),
    pendingServices: dedupe(pending, (service) => `${service.kind}:${service.target}`).slice(0, 32),
    notes: [...new Set(notes)].map(plainLine).filter((line) => line !== "").slice(0, 60),
    questions: [...new Set(questions)].map(plainLine).filter((line) => line !== "").slice(0, 60),
    ...(seeds.length === 0 ? {} : { seedCommands: seeds }),
    ...(seedFiles.length === 0 ? {} : { seedFiles }),
  };
  // The dependencies are tried on top of today's draft; if they do not fit or do not parse, today's draft stands.
  const listed = listableDependencies(found, notPlaced);
  if (listed.dependencies.length > 0) {
    const withDependencies = TestEnvDraftSchema.safeParse({ ...base, dependencies: listed.dependencies, notes: addNote(base.notes, listed.note) });
    if (withDependencies.success && draftFitsCap(withDependencies.data)) return withDependencies.data;
    base.notes = addNote(base.notes, "The dependencies the detectors found were left out to keep the draft small.");
  } else if (listed.note !== undefined) {
    base.notes = addNote(base.notes, listed.note);
  }
  const reported = TestEnvDraftSchema.safeParse(base);
  // A draft the broker would refuse for its size is not reported (the setup draft's result stays small).
  return reported.success && draftFitsCap(reported.data) ? reported.data : undefined;
}

/** The note list with one more fixed sentence, within the draft's limit (60). */
function addNote(notes: readonly string[], note: string | undefined): string[] {
  return note === undefined || notes.includes(note) ? [...notes] : [...notes, note].slice(0, 60);
}

/**
 * The detectors' candidates of one repository with their paths relative to the workspace (a person opens `svc/docker-compose.yml`, not `docker-compose.yml`). A path that would leave the repository is dropped, and a
 * candidate left with no sighting is dropped and counted; the contract still has the final say (`listableDependencies`). Anything that is not a list gives none.
 */
function inWorkspace(candidates: unknown, repositoryPath: string): { candidates: DependencyCandidate[]; dropped: number } {
  if (!Array.isArray(candidates)) return { candidates: [], dropped: 0 };
  const base = repositoryPath === "." ? "" : repositoryPath;
  // Inside the repository first (a `..` may not climb out of it into a sibling), then under its folder of the workspace.
  const placed = (path: unknown): string | undefined => {
    const inside = typeof path === "string" ? joinInside("", path) : undefined;
    return inside === undefined || base === "" ? inside : `${base}/${inside}`;
  };
  const kept: DependencyCandidate[] = [];
  let dropped = 0;
  for (const item of candidates as DependencyCandidate[]) {
    const evidence = typeof item === "object" && item !== null && Array.isArray(item.evidence)
      ? item.evidence.flatMap((entry) => { const path = placed(entry?.path); return path === undefined ? [] : [{ path, line: entry.line }]; })
      : [];
    if (evidence.length === 0) { dropped += 1; continue; }
    const hints = typeof item.hints === "object" && item.hints !== null ? { ...item.hints } : {};
    if (Array.isArray(hints.initFiles)) hints.initFiles = hints.initFiles.flatMap((path) => { const placedPath = placed(path); return placedPath === undefined ? [] : [placedPath]; });
    kept.push({ ...item, evidence, hints });
  }
  return { candidates: kept, dropped };
}

/**
 * A candidate as the wire carries it: its resources are a kind, a name and a table's key schema. What the worker reads again at run time (a topic's queues, a parameter's literal default, a rule's pattern) stays out of
 * the draft: the broker has no use for it, and a parameter's value is the repository's text.
 */
function forWire(item: DependencyCandidate): DependencyCandidate {
  const resources = item.hints?.resources;
  if (!Array.isArray(resources)) return item;
  return { ...item, hints: { ...item.hints, resources: resources.map(({ kind, name, keySchema }) => ({ kind, name, ...(keySchema === undefined ? {} : { keySchema }) })) } };
}

/** The merged candidates the contract accepts, at most TEST_ENV_CANDIDATE_MAX, and a fixed sentence when some were left out. */
function listableDependencies(candidates: readonly DependencyCandidate[], notPlaced: number): { dependencies: TestEnvDependencyCandidate[]; note?: string } {
  if (candidates.length === 0 && notPlaced === 0) return { dependencies: [] };
  const merged = mergeCandidates(candidates);
  const dependencies: TestEnvDependencyCandidate[] = [];
  let refused = 0;
  for (const item of merged) {
    const parsed = TestEnvDependencyCandidateSchema.safeParse(forWire(item));
    if (parsed.success && dependencies.length < TEST_ENV_CANDIDATE_MAX) dependencies.push(parsed.data);
    else refused += 1;
  }
  const lost = refused + notPlaced;
  return lost === 0 ? { dependencies } : { dependencies, note: `${String(lost)} ${lost === 1 ? "dependency" : "dependencies"} the detectors found could not be listed.` };
}

/** Whether a draft weighs no more than the broker keeps. */
export const draftFitsCap = (draft: TestEnvDraft): boolean => Buffer.byteLength(JSON.stringify(draft), "utf8") <= TEST_ENV_DRAFT_MAX_BYTES;

const plainLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 400);
function dedupe<T>(list: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * What a SETUP_DRAFT run adds to its result when it was asked to detect (`testEnvDetect`): the draft environment under `testEnvironmentDraft`, or nothing. NEVER throws and never fails the run: the setup proposal is
 * the run's product, the environment draft is an addition.
 */
export async function testEnvDraftResult(input: { rootPath: string; repositories: readonly DetectRepository[]; setupProposal?: SetupProposal | undefined; recipes?: readonly RecipeOffer[] | undefined }): Promise<{ testEnvironmentDraft?: TestEnvDraft; testEnvironmentDraftNone?: TestEnvDraftNoneReason }> {
  try {
    const draft = await detectTestEnvironment(input);
    // TS-UX-1 item 6: detection ran and made nothing, said with a fixed reason so the page can tell it from a worker that never ran it.
    return draft === undefined ? { [TEST_ENV_DRAFT_NONE_KEY]: "no_test_command" } : { testEnvironmentDraft: draft };
  } catch {
    return { [TEST_ENV_DRAFT_NONE_KEY]: "failed" };
  }
}
