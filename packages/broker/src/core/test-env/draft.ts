// Test environment: the draft environment a setup draft run reports, read again by the broker and kept for the maintainer's "propose".
//
// The worker's draft is UNTRUSTED (the run read repository files and talked to a model). So the broker, not the worker, decides what it accepts:
//   - it must parse as a draft (bounded, strict) and describe the SAFEST environment: the sandbox tier, no services, no accounts, no seeds, no preview or shared block, no video or traces, no nightly run,
//     round budget at its floor, no unrecorded-request answers. A draft that asks for anything more is refused as a whole: more access is a person's decision on a card, never a detector's;
//   - a command that downloads and runs code (`remoteCodeReason`), or that the redactor would change (it holds something secret-shaped), is dropped from the setup commands and checks with a fixed note;
//     the id of a dropped check also leaves `alwaysRun`;
//   - what is shown to people (notes, questions, services) is one plain line each.
// The draft is stored under the project, keyed by the setup draft's task (a newer setup draft makes an older one stale), and expires with the proposal's own life.
import { z } from "zod";
import {
  SETUP_RECIPE_OFFERS_MAX,
  SetupRecipeIdSchema,
  parseSetupRecipeSource,
  TEST_ENV_DRAFT_MAX_BYTES,
  TEST_ENV_DRAFT_NONE_KEY,
  TEST_ENV_DRAFT_RESULT_KEY,
  TEST_ENV_ROUND_BUDGET_MIN,
  TestEnvDraftSchema,
  projectPk,
  queryAll,
  redactText,
  testEnvLessSafeChanges,
  type OrgId,
  type TransactItem,
  type TestEnvDependencyCandidate,
  type TestEnvDraft,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { TEST_ENV_PROPOSAL_TTL_MS } from "./environment.js";
import { documentOf, expired, expiryOf, type StoreOnly } from "./deps.js";
import { checkSelectionIsSafe, SAFE_SELECTION_METHODS } from "./prove-from-setup-check.js";
import { testEnvironmentEnabled } from "./switch.js";
import { refusedCommand } from "./refused-command.js";
import { testServicesEnabled } from "./test-services-switch.js";
import { proposeDependencies, type DependencyProposalContext } from "./dependency-proposal.js";
import { attachDraftSeeds, sameCommand, type RoutedSeed } from "./seed-routing.js";


export const DRAFT_SELECTION_NOTE = "A way of narrowing the tests that Rovara does not accept was left out; that check runs in full.";
export const DRAFT_TOO_LARGE_NOTE = "The environment Rovara found was too large to keep, so none is proposed.";
export const DRAFT_LEFT_OUT_NOTE = "A command that downloads and runs code, or that holds a secret, was left out of the proposal.";

/**
 * why a look at the repositories left no test environment draft, one fixed note each (recorded at the end of the setup draft, `TEST_ENV_DRAFT_REFUSED`). Never the worker's words.
 *   no_test_command  the detectors ran and found no command that runs the tests
 *   detect_failed    the detectors ran and failed
 *   no_detection     the worker that ran the look does not run the detectors (an older worker)
 *   too_large / unreadable / not_safest / no_checks_left   the draft was refused when it was stored, for that reason
 */
export const DRAFT_ABSENCE_REASONS = ["no_test_command", "detect_failed", "no_detection", "too_large", "unreadable", "not_safest", "no_checks_left"] as const;
export type DraftAbsence = (typeof DRAFT_ABSENCE_REASONS)[number];
export const DRAFT_ABSENCE_NOTES: Record<DraftAbsence, string> = {
  no_test_command: "Rovara looked at your default branch and found no command that runs your tests (a test script in package.json, pytest, and the like), so it could not draft a test environment. Add the test command in the setup above, then look again.",
  detect_failed: "Rovara looked at your default branch, but reading it for a test environment failed part way, so nothing was drafted. Look again; if it fails again, set the test command in the setup above.",
  no_detection: "The machine that looked at your repositories runs an older Rovara that does not draft a test environment, so none was drafted. Look again once the machines are updated (an administrator can tell you when).",
  too_large: DRAFT_TOO_LARGE_NOTE,
  unreadable: "Rovara drafted a test environment but it could not be read when it was kept, so it was refused and none is proposed. Look again.",
  not_safest: "Rovara drafted a test environment that asked for more than the sandbox (a service, an account, a recording or a nightly run), so it was refused: a draft only ever proposes the safest setup. Look again; a person adds anything more.",
  no_checks_left: "Every command Rovara found to run your tests downloads and runs code or holds something secret, so all were left out and no test environment is proposed. Add a plain test command in the setup above, then look again.",
};
/** The note when a look left no draft and no reason was recorded (a look made before the reasons were kept). */
export const DRAFT_ABSENCE_UNKNOWN_NOTE = "Rovara looked at your repositories but kept no test environment from that look, and this look did not record why. Look again to find out.";

const RecordedOffersSchema = z.array(z.object({ recipeId: SetupRecipeIdSchema, revision: z.number().int().min(1) }).strict()).max(SETUP_RECIPE_OFFERS_MAX);
const draftKey = (orgId: OrgId, project: string, taskId: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#DRAFT#${taskId}` });

// `refusedCommand` lives in ./refused-command.ts (a leaf module); re-exported here for the callers that always had it from this file.
export { refusedCommand };

/**
 * The safest environment, and nothing beyond: the draft is refused (undefined) when it asks for more. A worker never proposes a backing: the draft's own `environment.dependencies` must be empty (the broker adds
 * the dependencies it proposes itself, from the candidates, after this check).
 */
function isSafestEnvironment(body: TestEnvironmentBody): boolean {
  return body.tier === "sandbox" && (body.dependencies === undefined || body.dependencies.length === 0) && body.services.length === 0 && body.accounts.length === 0 && body.data.seeds.length === 0
    && body.preview === undefined && body.shared === undefined && !body.capture.video && !body.capture.traces && body.capture.screenshots === "failed"
    && SAFE_SELECTION_METHODS.includes(body.selection.method) && body.selection.declared === undefined
    && !body.nightly.enabled && body.roundBudgetMin === TEST_ENV_ROUND_BUDGET_MIN.min
    && body.prodDeny.accountIds.length === 0 && body.prodDeny.hosts.length === 0 && body.prodDeny.arnPrefixes.length === 0
    && testEnvLessSafeChanges(undefined, body).length === 0;
}

const plain = (text: string): string => redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 400);

/**
 * What `sanitizeTestEnvDraft` needs for test services. `env` reads the install switch (default: the process environment). `propose` is given only by a reader that has the signed catalog and wants the
 * dependencies the broker proposes from the candidates; the write at the end of a setup draft gives none and keeps the validated candidates only.
 */
export interface DraftDependencyOptions { env?: NodeJS.ProcessEnv; propose?: { catalog: DependencyProposalContext["catalog"]; edition: DependencyProposalContext["edition"]; projectId: string } }

/**
 * The draft as the broker keeps it, or undefined when the worker's report is not a safe draft. Never throws.
 * Test services: with the switch `tx` off the candidates are dropped and the draft is exactly what it was. With it on they are carried through, validated (bounded, strict: `TestEnvDraftSchema`), and when
 * `options.propose` is given the broker turns them into the draft environment's `dependencies` (`proposeDependencies`). A draft whose own environment lists dependencies is refused whole by the schema: a worker
 * never proposes a backing.
 */
export function sanitizeTestEnvDraft(raw: unknown, options?: DraftDependencyOptions): TestEnvDraft | undefined {
  return sanitizeWithRouting(raw, options)?.draft;
}

/** `sanitizeTestEnvDraft`, and the seed commands the database dependency actually took (empty when it took none: test services off, no database to hold them, or refused). Those, and only those, are not setup commands. */
export function sanitizeWithRouting(raw: unknown, options?: DraftDependencyOptions): { draft: TestEnvDraft; routed: RoutedSeed[] } | undefined {
  const outcome = sanitizeOrRefuse(raw, options);
  return "refused" in outcome ? undefined : outcome;
}

/** Why the sanitizer refuses a worker's draft , or undefined when it keeps it. */
export function draftRefusalOf(raw: unknown, options?: DraftDependencyOptions): Extract<DraftAbsence, "too_large" | "unreadable" | "not_safest" | "no_checks_left"> | undefined {
  const outcome = sanitizeOrRefuse(raw, options);
  return "refused" in outcome ? outcome.refused : undefined;
}

function sanitizeOrRefuse(raw: unknown, options?: DraftDependencyOptions): { draft: TestEnvDraft; routed: RoutedSeed[] } | { refused: "too_large" | "unreadable" | "not_safest" | "no_checks_left" } {
  if (Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8") > TEST_ENV_DRAFT_MAX_BYTES) return { refused: "too_large" };
  const parsed = TestEnvDraftSchema.safeParse(raw);
  if (!parsed.success) return { refused: "unreadable" };
  const servicesOn = testServicesEnabled(options?.env);
  // An empty list is the same as none; no key is kept.
  const { dependencies: _empty, ...withoutDependencies } = parsed.data.environment;
  void _empty;
  if (!isSafestEnvironment(withoutDependencies)) return { refused: "not_safest" };
  const { dependencies: candidates, seedCommands, seedFiles, ...rest } = parsed.data;
  // the seed commands (and item 9: the seed files) travel with the candidates (test services on) and are attached to the database dependency when the draft is read with the catalog.
  const draft: TestEnvDraft = { ...rest, environment: withoutDependencies, ...(servicesOn && candidates !== undefined ? { dependencies: candidates } : {}), ...(servicesOn && seedCommands !== undefined && seedCommands.length > 0 ? { seedCommands } : {}), ...(servicesOn && seedFiles !== undefined && seedFiles.length > 0 ? { seedFiles } : {}) };
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > TEST_ENV_DRAFT_MAX_BYTES) return { refused: "too_large" };
  let leftOut = false;
  let narrowingDropped = false;
  const kept = new Set<string>();
  const repos = draft.environment.repos.map((repo) => {
    const setupCommands = repo.setupCommands.filter((command) => { const refused = refusedCommand(command); leftOut ||= refused; return !refused; });
    const checks = repo.checks.filter((check) => { const refused = refusedCommand(check.command); leftOut ||= refused; if (!refused) kept.add(check.id); return !refused; })
      // A narrowing argument other than the approved placeholder, or the placeholder on a command that is not a test runner taking test ids, is dropped (the check then runs in full), never carried.
      .map((check) => { if (checkSelectionIsSafe(check)) return check; narrowingDropped = true; const { selectArgs: _dropped, ...whole } = check; void _dropped; return whole; });
    return { ...repo, setupCommands, checks };
  });
  if (repos.every((repo) => repo.checks.length === 0)) return { refused: "no_checks_left" };
  const environment: TestEnvironmentBody = {
    ...draft.environment,
    repos,
    selection: { ...draft.environment.selection, alwaysRun: draft.environment.selection.alwaysRun.filter((id) => kept.has(id)) },
  };
  // Test services: the BROKER proposes dependencies from the candidates (through `chooseBacking`, real catalog software only). Only when it has the catalog to do it with; a draft kept without one (the write at the end of
  // a setup draft) holds just the candidates, and the proposal is made when the draft is read.
  let dependencyNotes: string[] = [];
  let routed: RoutedSeed[] = [];
  if (servicesOn && options?.propose !== undefined && draft.dependencies !== undefined && draft.dependencies.length > 0) {
    const proposed = proposeDependencies(draft.dependencies, { catalog: options.propose.catalog, edition: options.propose.edition, projectId: options.propose.projectId, prodDeny: environment.prodDeny });
    const seeded = attachDraftSeeds(proposed.dependencies, draft.seedCommands, draft.seedFiles);
    if (seeded.dependencies.length > 0) environment.dependencies = seeded.dependencies;
    dependencyNotes = [...proposed.notes, ...seeded.notes];
    // Each routed command belongs to the repository whose setup holds it, or else whose commands run in its directory.
    routed = seeded.routed.map((command) => {
      const home = environment.repos.find((repo) => repo.setupCommands.some((setup) => sameCommand(command, setup))) ?? environment.repos.find((repo) => [...repo.setupCommands, ...repo.checks.map((check) => check.command)].some((other) => other.cwd === command.cwd));
      return { command, ...(home === undefined ? {} : { repositoryId: home.repositoryId }) };
    });
  }
  // a seed or migration command is taken out of the setup commands ONLY when the dependency took it as its seed. The worker leaves every such command where it found it.
  const removedAt = new Map<number, Set<number>>();
  if (routed.length > 0) {
    environment.repos = environment.repos.map((repo, at) => {
      const gone = new Set(repo.setupCommands.flatMap((command, position) => (routed.some((seed) => seed.repositoryId === repo.repositoryId && sameCommand(seed.command, command)) ? [position] : [])));
      if (gone.size === 0) return repo;
      removedAt.set(at, gone);
      return { ...repo, setupCommands: repo.setupCommands.filter((_, position) => !gone.has(position)) };
    });
  }
  // A value source names a field by position: those of a dropped command would now point at another value, so the sources of a draft that lost something are kept only where they still line up (none).
  // A setup command taken out as a seed loses its source, and the ones after it move up.
  const moved = (field: string): string | undefined => {
    const at = /^repos\[(\d+)\]\.setupCommands\[(\d+)\]$/u.exec(field);
    const gone = at === null ? undefined : removedAt.get(Number(at[1]));
    if (at === null || gone === undefined) return field;
    const position = Number(at[2]);
    return gone.has(position) ? undefined : `repos[${at[1]!}].setupCommands[${String(position - [...gone].filter((other) => other < position).length)}]`;
  };
  const valueSources = leftOut || narrowingDropped ? [] : draft.valueSources.flatMap((item) => { const field = moved(item.field); return field === undefined ? [] : [{ ...item, field }]; });
  const result: TestEnvDraft = {
    environment, valueSources,
    pendingServices: draft.pendingServices.map((service) => ({ kind: service.kind, target: plain(service.target) })).filter((service) => service.target !== ""),
    ...(servicesOn && draft.dependencies !== undefined ? { dependencies: draft.dependencies } : {}),
    ...(draft.seedCommands === undefined ? {} : { seedCommands: draft.seedCommands }),
    ...(draft.seedFiles === undefined ? {} : { seedFiles: draft.seedFiles }),
    notes: [...draft.notes.map(plain), ...(leftOut ? [DRAFT_LEFT_OUT_NOTE] : []), ...(narrowingDropped ? [DRAFT_SELECTION_NOTE] : []), ...dependencyNotes].filter((line) => line !== "").slice(0, 60),
    questions: draft.questions.map(plain).filter((line) => line !== "").slice(0, 60),
  };
  return { draft: result, routed };
}

/**
 * a value source that cites a company recipe (`recipe:<id>@<revision>`) stays only if the BROKER offered exactly that recipe and revision to this run (the operation's record at dispatch). A worker's report is a claim:
 * a citation of a recipe it was not offered (another recipe of the company, another revision, an id it made up) is dropped before the draft is stored, so no later reader, card or host mark can rely on it. Other sources are untouched.
 */
export function onlyOfferedRecipeSources<T extends { source: unknown }>(valueSources: readonly T[], offers: ReadonlyArray<{ recipeId: string; revision: number }> | undefined): T[] {
  return valueSources.filter(({ source }) => {
    if (typeof source !== "string" || !source.startsWith("recipe:")) return true;
    const cited = parseSetupRecipeSource(source);
    return cited !== undefined && (offers ?? []).some((offer) => offer.recipeId === cited.id && offer.revision === cited.revision);
  });
}

/**
 * The item that keeps a setup draft's environment draft, for the transaction of the setup draft's terminal result. Nothing while the switch is off, for a task that is not a setup draft, for a run that did not
 * succeed, or for a report that is not a safe draft: the setup draft's own result is never touched by this.
 */
export function testEnvDraftEndItems(
  task: Pick<DeveloperTaskRecord, "taskId" | "project"> & { orgId?: OrgId | undefined; /** `setup_draft` for the task that looks at a repository to propose a test environment. */ purpose?: string | undefined },
  operation: { kind: string; workflowMode?: string | undefined; /** the recipes (id and revision) the BROKER offered this run at dispatch, copied from its own operation record. */ setupRecipeOffers?: ReadonlyArray<{ recipeId: string; revision: number }> | undefined },
  outcome: { status: string; result: unknown },
  nowIso: string,
  env: NodeJS.ProcessEnv = process.env,
): TransactItem[] {
  if (!testEnvironmentEnabled(env) || task.purpose !== "setup_draft" || task.orgId === undefined) return [];
  if (operation.kind !== "task" || operation.workflowMode !== "SETUP_DRAFT" || outcome.status !== "SUCCEEDED") return [];
  const result = typeof outcome.result === "object" && outcome.result !== null ? outcome.result as Record<string, unknown> : {};
  const reported = result[TEST_ENV_DRAFT_RESULT_KEY];
  // no draft, and why, as a small marker the page reads back as one fixed note (the setup draft's own write is never put at risk by a big item). The worker's reason is read from a fixed list only.
  const marker = (reason: DraftAbsence): TransactItem[] => [{ kind: "put", item: documentOf({ ...draftKey(task.orgId!, task.project, task.taskId), entityType: "TEST_ENV_DRAFT_REFUSED", orgId: task.orgId, project: task.project, taskId: task.taskId, reason, at: nowIso, ...expiryOf(Date.parse(nowIso) + TEST_ENV_PROPOSAL_TTL_MS) }) }];
  if (reported === undefined) {
    const none = result[TEST_ENV_DRAFT_NONE_KEY];
    return marker(none === "no_test_command" ? "no_test_command" : none === "failed" ? "detect_failed" : "no_detection");
  }
  // Test services: the validated candidates are kept with the draft (the dependencies are proposed when the draft is read, with the catalog).
  const sanitized = sanitizeTestEnvDraft(reported, { env });
  const draft = sanitized === undefined ? undefined : { ...sanitized, valueSources: onlyOfferedRecipeSources(sanitized.valueSources, operation.setupRecipeOffers) };
  if (draft === undefined) return marker(draftRefusalOf(reported, { env }) ?? "unreadable");
  return [{ kind: "put", item: documentOf({ ...draftKey(task.orgId, task.project, task.taskId), entityType: "TEST_ENV_DRAFT", orgId: task.orgId, project: task.project, taskId: task.taskId, draft, at: nowIso,
      ...(operation.setupRecipeOffers === undefined || operation.setupRecipeOffers.length === 0 ? {} : { recipeOffers: operation.setupRecipeOffers.map(({ recipeId, revision }) => ({ recipeId, revision })) }), ...expiryOf(Date.parse(nowIso) + TEST_ENV_PROPOSAL_TTL_MS) }) }];
}

/** The stored draft of a setup draft task, read again through the sanitizer (a damaged or unsafe item is "none"), or undefined. */
export async function readTestEnvDraft(client: StoreOnly, orgId: OrgId, project: string, taskId: string, nowMs: number, options?: DraftDependencyOptions): Promise<{ draft: TestEnvDraft; at: string; /** The seed commands the database dependency took (never in the setup commands); empty when it took none. */ routedSeeds: RoutedSeed[]; /** The recipes the broker offered the run that made this draft (id and revision); empty when none. */ recipeOffers: Array<{ recipeId: string; revision: number }> } | undefined> {
  const stored = (await client.store.get(draftKey(orgId, project, taskId))) as Record<string, unknown> | undefined;
  if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId || typeof stored["at"] !== "string") return undefined;
  if (expired(stored, nowMs)) return undefined;
  if (stored["entityType"] !== "TEST_ENV_DRAFT") return undefined;
  const sanitized = sanitizeWithRouting(stored["draft"], options);
  if (sanitized === undefined) return undefined;
  const offers = RecordedOffersSchema.safeParse(stored["recipeOffers"]);
  return { draft: sanitized.draft, routedSeeds: sanitized.routed, at: stored["at"], recipeOffers: offers.success ? offers.data : [] };
}

/**
 * The dependency candidates (a family and a major version each, with where they were seen) of the project's NEWEST kept setup draft, read again through the sanitizer; none when there is no draft, it expired, or test services
 * are off (the candidates are dropped then). Test services use this to PROPOSE the images a project asks for: reading it approves nothing.
 */
export async function latestDraftCandidates(client: StoreOnly, orgId: OrgId, project: string, nowMs: number, env: NodeJS.ProcessEnv = process.env): Promise<TestEnvDependencyCandidate[]> {
  const rows = await queryAll(client.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: "TESTENV#DRAFT#" } });
  const drafts = rows
    .filter((row) => row["entityType"] === "TEST_ENV_DRAFT" && row["orgId"] === orgId && row["project"] === project && typeof row["at"] === "string" && !expired(row, nowMs))
    .sort((a, b) => ((a["at"] as string) < (b["at"] as string) ? 1 : -1));
  const newest = drafts[0];
  if (newest === undefined) return [];
  return sanitizeTestEnvDraft(newest["draft"], { env })?.dependencies ?? [];
}

/**
 * The fixed note for why the task's look left no draft : the recorded reason's note; for a kept draft that can no longer be read (for example test services were switched since), the "unreadable" note;
 * for nothing recorded at all (a look made before the reasons were kept), the unknown note. A marker written before the reasons existed holds `too_large`, which still reads.
 */
export async function readTestEnvDraftNote(client: StoreOnly, orgId: OrgId, project: string, taskId: string, nowMs: number): Promise<string> {
  const stored = (await client.store.get(draftKey(orgId, project, taskId))) as Record<string, unknown> | undefined;
  if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId) return DRAFT_ABSENCE_UNKNOWN_NOTE;
  if (expired(stored, nowMs)) return DRAFT_ABSENCE_UNKNOWN_NOTE;
  if (stored["entityType"] === "TEST_ENV_DRAFT") return DRAFT_ABSENCE_NOTES.unreadable;
  if (stored["entityType"] !== "TEST_ENV_DRAFT_REFUSED") return DRAFT_ABSENCE_UNKNOWN_NOTE;
  const reason = stored["reason"];
  return typeof reason === "string" && (DRAFT_ABSENCE_REASONS as readonly string[]).includes(reason) ? DRAFT_ABSENCE_NOTES[reason as DraftAbsence] : DRAFT_ABSENCE_UNKNOWN_NOTE;
}
