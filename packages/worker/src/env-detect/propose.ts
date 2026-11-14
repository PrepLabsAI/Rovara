// From detections to a proposal (E2): the detectors' findings become a valid sandbox-tier `TestEnvironmentBody` with the source of each value, and the read-only setup agent's draft fills only what code could not
// find. Nothing here is approved or run: it is a PROPOSAL, proved by the Prove run and approved by a maintainer.
//
// Rules:
//   - code first: a model-proposed command is added only when no detected check runs the same program with the same arguments, and a command the draft FLAGGED (downloads and runs code) is never turned into a check;
//   - the proposal is always the safest tier (sandbox) with no pre-prod, no shared environment, no video or traces and no unrecorded-request answers: a person turns those on, on a card that says so;
//   - services found in the code are listed as `pendingServices`, not put in the environment: a mocked service needs a recorded fixture set first (the Prove run's recorder makes it);
//   - the environment must pass the contract's own schema, or the proposal is not produced (and the reason is a fixed word).
import {
  isDatabaseSeedCommand,
  TestEnvironmentBodySchema,
  TestEnvironmentProposalSchema,
  parseCommandLine,
  type ProjectCommand,
  type SetupDraft,
  type TestEnvValueSource,
  type TestEnvironmentBody,
  type TestEnvironmentProposal,
} from "@agentx/contracts";
import { coverageSpecsOf } from "../verification/cobertura-lcov-coverage.js";
import type { Detection, DetectedSource, Located } from "./types.js";

export interface PendingService { kind: "sagemaker_runtime" | "http"; target: string; source: TestEnvValueSource }
export interface EnvironmentDraft {
  environment: TestEnvironmentBody;
  valueSources: Array<{ field: string; source: TestEnvValueSource }>;
  pendingServices: PendingService[];
  /**
   * Commands that fill or migrate a database (TS-UX-1), offered as the database dependency's seed: the broker attaches them to the dependency it proposes and, only then, takes them out of the setup commands (setup runs
   * on a fresh machine with no database). They are ALSO still in the setup commands here. Empty when no database was found: with none, nothing says the command needs one.
   */
  seedCommands: Array<{ command: ProjectCommand; source: TestEnvValueSource }>;
  /** A database dependency was found, so a seed or migration command is routed (also for the setup agent's own commands). */
  routesSeeds: boolean;
  /** TS-UX-1 item 7: the package.json scripts whose program reads a database setting (`detection.databaseScripts`): a command that runs one is routed like a seed (the setup agent's too, kept as the agent's). */
  databaseScripts: string[];
  iac: Detection["iac"];
  notes: string[];
  questions: string[];
}

const sourceOf = (source: DetectedSource): TestEnvValueSource => source;
const COMMON_FULL_SUITE = [".github/**", ".gitlab-ci.yml", "Makefile"];
const sameProgram = (left: ProjectCommand, right: ProjectCommand): boolean => left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);

/** Whether a command runs one of the named package.json scripts: `npm run <name>`, `npm run-script <name>`, `pnpm|yarn|bun run <name>`, or `pnpm|yarn <name>`. */
export function runsScriptOf(command: Pick<ProjectCommand, "executable" | "args">, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  const program = command.executable.split("/").pop() ?? command.executable;
  const [first, second] = command.args;
  if (program === "npm") return (first === "run" || first === "run-script") && second !== undefined && names.has(second);
  if (program === "pnpm" || program === "yarn" || program === "bun") return first === "run" ? second !== undefined && names.has(second) : first !== undefined && program !== "bun" && names.has(first);
  return false;
}

export function buildEnvironmentDraft(detection: Detection, input: { repositoryId: string; nightlyBranch?: string }): EnvironmentDraft | { ok: false; reason: "invalid_environment" } {
  const valueSources: EnvironmentDraft["valueSources"] = [];
  const checks = detection.checks.slice(0, 32);
  const routesSeeds = Array.isArray(detection.dependencies) && detection.dependencies.some((item) => item.kind === "database");
  const databaseScripts = new Set((detection.databaseScripts ?? []).map((item) => item.value));
  const isSeed = (item: Located<ProjectCommand>): boolean => routesSeeds && (isDatabaseSeedCommand(item.value) || runsScriptOf(item.value, databaseScripts));
  // A seed or migration found among the setup commands stays one here and is ALSO reported as a seed: the worker cannot know whether the broker will propose a database to hold it (services off, no catalog, nothing to
  // run on), and a command that lands nowhere must not vanish from setup. The broker takes it out of setup once a dependency has taken it.
  const setup = detection.setupCommands.slice(0, 20);
  const seedCommands: EnvironmentDraft["seedCommands"] = [];
  if (routesSeeds) {
    for (const item of [...detection.setupCommands.filter(isSeed), ...(detection.seedCommands ?? [])]) {
      if (seedCommands.length < 8 && !seedCommands.some((existing) => sameProgram(existing.command, item.value))) seedCommands.push({ command: item.value, source: sourceOf(item.source) });
    }
  }
  const fullSuiteOn = [...new Set([...detection.fullSuiteOn.map((item) => item.value), ...COMMON_FULL_SUITE])].slice(0, 100);
  setup.forEach((item, index) => valueSources.push({ field: `repos[0].setupCommands[${String(index)}]`, source: sourceOf(item.source) }));
  checks.forEach((item, index) => valueSources.push({ field: `repos[0].checks[${String(index)}]`, source: sourceOf(item.source) }));
  checks.forEach((item, index) => {
    if (item.value.reportPath !== undefined && item.value.reportSource !== undefined) valueSources.push({ field: `repos[0].checks[${String(index)}].reportPath`, source: sourceOf(item.value.reportSource) });
    if (item.value.coveragePath !== undefined && item.value.coverageSource !== undefined) valueSources.push({ field: `repos[0].checks[${String(index)}].coveragePath`, source: sourceOf(item.value.coverageSource) });
    if (item.value.sarifPath !== undefined && item.value.sarifSource !== undefined) valueSources.push({ field: `repos[0].checks[${String(index)}].sarifPath`, source: sourceOf(item.value.sarifSource) });
  });
  detection.fullSuiteOn.forEach((item, index) => { if (index < fullSuiteOn.length) valueSources.push({ field: `selection.fullSuiteOn[${String(index)}]`, source: sourceOf(item.source) }); });
  const environment = TestEnvironmentBodySchema.safeParse({
    tier: "sandbox",
    repos: [{
      repositoryId: input.repositoryId,
      setupCommands: setup.map((item) => item.value),
      checks: checks.map((item) => ({ id: item.value.id, label: item.value.label, command: item.value.command, kind: item.value.kind, ...optionalPaths(item.value) })),
    }],
    roundBudgetMin: 30,
    selection: { method: checks.some((item) => item.value.coveragePath !== undefined) ? "coverage_map" : "full", alwaysRun: checks.filter((item) => item.value.kind === "smoke").map((item) => item.value.id), fullSuiteOn },
    // OFF by default: a nightly run is a full run of the suite, paid for by the project, so a person turns it on (a less-safe change, second person).
    nightly: { enabled: false, cronUtc: "0 6 * * *", branch: input.nightlyBranch ?? "main" },
    services: [],
    data: { seeds: [], generator: "faker_seeded", seed: 1 },
    accounts: [],
    prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
    capture: { screenshots: "failed", video: false, traces: false },
  });
  if (!environment.success) return { ok: false, reason: "invalid_environment" };
  return {
    environment: environment.data,
    valueSources,
    seedCommands,
    routesSeeds,
    databaseScripts: [...databaseScripts],
    pendingServices: detection.services.map((item) => ({ kind: item.value.kind, target: item.value.target, source: sourceOf(item.source) })),
    iac: detection.iac,
    notes: [...detection.notes, ...unnamedCoverageNotes(detection)],
    questions: [...detection.questions],
  };
}

/**
 * A coverage report counts only when the check's command line names it or the approved setup gives its `coveragePath` (no default file name is guessed), so each test check with neither is named here: the maintainer
 * can add the report to the command or set the path before approving. A detector that already said coverage will show as not measured is not repeated.
 */
function unnamedCoverageNotes(detection: Detection): string[] {
  if (detection.notes.some((note) => note.includes("changed-line coverage will show as not measured"))) return [];
  return detection.checks.filter((item) => item.value.kind === "test" && item.value.coveragePath === undefined && coverageSpecsOf(item.value.command).length === 0)
    .map((item) => `The test check "${item.value.id}" names no coverage report (neither on its command line nor as a coverage path), so changed-line coverage will show as not measured for it.`);
}

function optionalPaths(check: Located<{ reportPath?: string; coveragePath?: string; sarifPath?: string; selectArgs?: string[] }>["value"]) {
  return {
    ...(check.reportPath === undefined ? {} : { reportPath: check.reportPath }),
    ...(check.coveragePath === undefined ? {} : { coveragePath: check.coveragePath }),
    ...(check.sarifPath === undefined ? {} : { sarifPath: check.sarifPath }),
    ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }),
  };
}

/**
 * Adds what the setup agent found that code did not, then builds the proposal (the agent's draft with the environment and the source of each value). A command from the draft that cannot be read, is flagged, or
 * duplicates a detected one is dropped, and the draft's own flags stay on the draft.
 */
export function proposalFromDraft(draft: EnvironmentDraft, setupDraft: SetupDraft, input: { cwd: string; timeoutSeconds?: number }): { ok: true; proposal: TestEnvironmentProposal; dropped: number; /** The draft's seed commands and the agent's own, none of them in the setup commands. */ seedCommands: EnvironmentDraft["seedCommands"] } | { ok: false; reason: "invalid_proposal" } {
  const flagged = new Set(setupDraft.flaggedCommands.map((item) => item.command));
  const environment = structuredClone(draft.environment);
  const repo = environment.repos[0]!;
  const sources = [...draft.valueSources];
  const seedCommands = [...draft.seedCommands];
  let dropped = 0;
  const take = (line: string, kind: "setup" | "test"): ProjectCommand | undefined => {
    if (flagged.has(line)) { dropped += 1; return undefined; }
    try { return parseCommandLine(line, input.cwd, input.timeoutSeconds ?? (kind === "setup" ? 900 : 1_800)); } catch { dropped += 1; return undefined; }
  };
  for (const line of setupDraft.setupCommands) {
    const command = take(line, "setup");
    if (command === undefined || repo.setupCommands.some((existing) => sameProgram(existing, command)) || repo.setupCommands.length >= 20) continue;
    // A seed or migration needs the database, which exists only inside the test environment: it is offered as the dependency's seed too, and the broker takes it out of setup once a dependency has taken it.
    if (draft.routesSeeds && (isDatabaseSeedCommand(command) || runsScriptOf(command, new Set(draft.databaseScripts))) && seedCommands.length < 8 && !seedCommands.some((existing) => sameProgram(existing.command, command))) seedCommands.push({ command, source: "model" });
    sources.push({ field: `repos[0].setupCommands[${String(repo.setupCommands.length)}]`, source: "model" });
    repo.setupCommands.push(command);
  }
  let counter = 0;
  for (const line of setupDraft.testCommands) {
    const command = take(line, "test");
    if (command === undefined || repo.checks.some((existing) => sameProgram(existing.command, command)) || repo.checks.length >= 32) continue;
    counter += 1;
    let id = `model-${String(counter)}`;
    while (repo.checks.some((existing) => existing.id === id)) { counter += 1; id = `model-${String(counter)}`; }
    sources.push({ field: `repos[0].checks[${String(repo.checks.length)}]`, source: "model" });
    repo.checks.push({ id, label: `Test command ${String(counter)}`, command, kind: "test" });
  }
  const proposal = TestEnvironmentProposalSchema.safeParse({ ...setupDraft, environment, valueSources: sources.slice(0, 400) });
  return proposal.success ? { ok: true, proposal: proposal.data, dropped, seedCommands } : { ok: false, reason: "invalid_proposal" };
}
