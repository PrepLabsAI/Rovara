import {
  builtinFileCheckOf, planClaimIds, planQualityFinding, planQualityTargetReason,
  type PlanDocument, type PlanQualityFinding, type PlanQualityLint, type WorkflowCheck,
} from "@agentx/contracts";

/**
 * Plan self-check rules: pure functions of a parsed coding plan and what the planner was told about the project (the
 * feature E2E planning context). They take no task path: Quick and Full plans are held to the same standard.
 * Findings carry fixed codes and IDs only (see `planQualityFinding`); nothing here echoes model text.
 */

/** What the rules read of the planning context; `FeatureE2EPlanningContext` has all of it. */
export interface PlanQualityContext {
  targets: ReadonlyArray<{ targetId: string; kind: string }>;
  mockFixtures: ReadonlyArray<{ componentId: string; requestedTargetIds: readonly string[] }>;
  /** The step and assertion kinds a READY runtime runs per target kind; absent when the context does not say. */
  executableKinds?: ReadonlyArray<{ kind: string; steps: readonly string[]; assertions: readonly string[] }> | undefined;
  /** Targets that cannot run application scenarios now, each with the context's reason. */
  unavailableReasons?: ReadonlyArray<{ targetId: string; reason: string }> | undefined;
}

/** What the request itself calls for, when the caller can tell (for example AI navigation steps); not guessed here. */
export interface PlanQualityNeeds {
  stepKinds?: readonly string[];
  targetIds?: readonly string[];
}

const PORTABLE_STEP_KINDS = new Set(["invoke-contract", "inspect-contract"]);
/** Programs that only read files: a check made of them cannot show that code runs. */
const STATIC_READERS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "test", "find", "wc", "head"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
const FINDERS_THAT_RUN = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);
const GREPS = new Set(["grep", "egrep", "fgrep"]);
const ABSENCE_WORDS = /\b(?:no|not|never|without|absent|absence|removed?|missing|gone|lacks?|doesn'?t|does\s+not|isn'?t)\b/iu;
const CLAIM_FINDING_IDS_MAX = 32;

const baseName = (executable: string): string => executable.slice(executable.lastIndexOf("/") + 1);

/** Words of a shell script segment; understands single and double quotes and nothing else. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current: string | undefined;
  let quote: string | undefined;
  for (const char of segment) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current = (current ?? "") + char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      current ??= "";
    } else if (/\s/u.test(char)) {
      if (current !== undefined) words.push(current);
      current = undefined;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== undefined) words.push(current);
  return words;
}

interface SimpleCommand { executable: string; args: string[]; negated: boolean }

/** The simple commands a check runs: the command itself, or each command of an `sh -c` script (split on `;`, `&&`, `||`, `|` and line breaks). */
function simpleCommands(command: Pick<WorkflowCheck["command"], "executable" | "args">): SimpleCommand[] {
  const executable = baseName(command.executable);
  if (!SHELLS.has(executable)) return [{ executable, args: [...command.args], negated: false }];
  const scriptAt = command.args.indexOf("-c") + 1;
  const script = scriptAt > 0 ? command.args[scriptAt] : undefined;
  if (script === undefined) return [{ executable, args: [...command.args], negated: false }];
  return script.split(/&&|\|\||[;|\n]/u).flatMap((segment) => {
    const words = shellWords(segment);
    const negated = words[0] === "!";
    const rest = negated ? words.slice(1) : words;
    return rest.length === 0 ? [] : [{ executable: baseName(rest[0]!), args: rest.slice(1), negated }];
  });
}

/** True when a command only reads files (a built-in file check, `grep`, `cat`...): it cannot show that code ran. */
export function isStaticReaderCommand(command: Pick<WorkflowCheck["command"], "executable" | "args">): boolean {
  if (builtinFileCheckOf(command) !== undefined) return true;
  const commands = simpleCommands(command);
  return commands.length > 0 && commands.every((item) => STATIC_READERS.has(item.executable) && !(item.executable === "find" && item.args.some((arg) => FINDERS_THAT_RUN.has(arg))));
}

interface GrepShape { letters: Set<string>; patterns: string[] }

/** The option letters and patterns of a `grep` argument list (short clusters, a few long options, `-e`, `--`). */
function grepShape(args: readonly string[]): GrepShape {
  const letters = new Set<string>();
  const patterns: string[] = [];
  const withValue = new Set(["e", "f", "m", "A", "B", "C", "d", "D"]);
  const longLetters: Record<string, string> = { "--count": "c", "--files-without-match": "L", "--invert-match": "v", "--quiet": "q", "--silent": "q" };
  let optionsEnded = false;
  let sawExplicitPattern = false;
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith("--")) {
      const letter = longLetters[arg];
      if (letter !== undefined) letters.add(letter);
      const regexp = /^--regexp=(.*)$/u.exec(arg);
      if (regexp !== null) { patterns.push(regexp[1]!); sawExplicitPattern = true; }
    } else if (!optionsEnded && arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at]!;
        if (withValue.has(letter)) {
          const value = at + 1 < arg.length ? arg.slice(at + 1) : args[(index += 1)];
          if (letter === "e" && value !== undefined) { patterns.push(value); sawExplicitPattern = true; }
          if (letter === "f") sawExplicitPattern = true;
          break;
        }
        letters.add(letter);
      }
    } else {
      positional += 1;
      if (positional === 1 && !sawExplicitPattern) patterns.push(arg);
    }
  }
  return { letters, patterns };
}

const hasQuote = (text: string): boolean => /["'`]/u.test(text);

/** The first known-bad form of a proposed check's command, or undefined. The label is read only for absence wording. */
function lintOf(check: WorkflowCheck): PlanQualityLint | undefined {
  const builtin = builtinFileCheckOf(check.command);
  if (builtin !== undefined) return hasQuote(builtin.text) ? "quoted-literal" : undefined;
  const greps = simpleCommands(check.command).filter((item) => GREPS.has(item.executable));
  const found = new Set<PlanQualityLint>();
  const absenceLabel = ABSENCE_WORDS.test(check.label);
  for (const item of greps) {
    const { letters, patterns } = grepShape(item.args);
    if (letters.has("L") && letters.has("c")) found.add("grep-files-without-match-count");
    else if (letters.has("L")) found.add("grep-files-without-match");
    else if (absenceLabel && !item.negated && !letters.has("v")) found.add(letters.has("c") ? "grep-count-absence" : "grep-absence");
    if (patterns.some(hasQuote)) found.add("quoted-literal");
  }
  return (["grep-files-without-match-count", "grep-files-without-match", "grep-count-absence", "grep-absence", "quoted-literal"] as const).find((lint) => found.has(lint));
}

/** `check-command-lint`: one finding per proposed check whose command has a known-bad form. */
function commandLintFindings(plan: PlanDocument): PlanQualityFinding[] {
  return (plan.checks?.proposed ?? []).flatMap((check) => {
    const lint = lintOf(check);
    return lint === undefined ? [] : [planQualityFinding({ code: "check-command-lint", checkIds: [check.id], lint })];
  });
}

/** True when a scenario drives the app (anything but a source-interface or contract call alone). */
const scenarioRunsApp = (scenario: { steps: ReadonlyArray<{ kind: string }> }): boolean => scenario.steps.length === 0 || scenario.steps.some((step) => !PORTABLE_STEP_KINDS.has(step.kind));

/** `mock-missing-for-target`: a target whose scenarios run the app, a mock offered for it, and no mock selected for it in the plan. */
function mockFindings(plan: PlanDocument, context: PlanQualityContext): PlanQualityFinding[] {
  const intent = plan.e2e;
  if (intent === undefined) return [];
  const selected = new Set((intent.mockFixtureRefs ?? []).map((ref) => ref.requestedTargetId));
  const targetIds = intent.requestedTargetIds.filter((targetId) => intent.scenarios.some((scenario) => scenarioRunsApp(scenario) && scenario.requestedTargetIds.includes(targetId)));
  return targetIds.flatMap((targetId) => {
    const offered = context.mockFixtures.filter((fixture) => fixture.requestedTargetIds.includes(targetId)).map((fixture) => fixture.componentId);
    return selected.has(targetId) || offered.length === 0 ? [] : [planQualityFinding({ code: "mock-missing-for-target", targetIds: [targetId], fixtureIds: [...new Set(offered)] })];
  });
}

/** `e2e-kind-unavailable` and `e2e-target-unavailable`: what the plan or the request needs and the pinned project revision does not offer. Not revisable. */
function gapFindings(plan: PlanDocument, context: PlanQualityContext, needs: PlanQualityNeeds): PlanQualityFinding[] {
  const intent = plan.e2e;
  const unavailable = new Map((context.unavailableReasons ?? []).map((item) => [item.targetId, item.reason]));
  const kindOf = new Map(context.targets.map((target) => [target.targetId, target.kind]));
  const missingKinds = new Set<string>();
  if (context.executableKinds !== undefined) {
    const offered = context.executableKinds;
    const anySteps = new Set(offered.flatMap((entry) => entry.steps));
    for (const kind of needs.stepKinds ?? []) if (!anySteps.has(kind)) missingKinds.add(kind);
    for (const scenario of intent?.scenarios ?? []) {
      if (!scenarioRunsApp(scenario)) continue;
      for (const targetId of scenario.requestedTargetIds) {
        const targetKind = kindOf.get(targetId);
        if (targetKind === undefined || unavailable.has(targetId)) continue;
        const entry = offered.find((item) => item.kind === targetKind);
        for (const step of scenario.steps) if (!PORTABLE_STEP_KINDS.has(step.kind) && !(entry?.steps ?? []).includes(step.kind)) missingKinds.add(step.kind);
        for (const assertion of scenario.assertions) if (!(entry?.assertions ?? []).includes(assertion.kind)) missingKinds.add(assertion.kind);
      }
    }
  }
  const findings: PlanQualityFinding[] = missingKinds.size === 0 ? [] : [planQualityFinding({ code: "e2e-kind-unavailable", kinds: [...missingKinds].sort() })];
  const wanted = new Set([
    ...(intent?.requestedTargetIds ?? []), ...(needs.targetIds ?? []),
    ...(intent?.schemaVersion === 2 ? (intent.unavailableTargetRefs ?? []).map((ref) => ref.targetId) : []),
  ]);
  const byReason = new Map<ReturnType<typeof planQualityTargetReason>, string[]>();
  for (const targetId of [...wanted].sort()) {
    const reason = unavailable.has(targetId) ? planQualityTargetReason(unavailable.get(targetId)) : (needs.targetIds ?? []).includes(targetId) && !kindOf.has(targetId) ? "not-offered" : undefined;
    if (reason !== undefined) byReason.set(reason, [...(byReason.get(reason) ?? []), targetId]);
  }
  for (const [targetReason, targetIds] of byReason) findings.push(planQualityFinding({ code: "e2e-target-unavailable", targetIds, targetReason }));
  return findings;
}

/** The ID and every ancestor of a claim ID: `1.2.3` is also `1.2` and `1`; a Not changing reference stands alone. */
function withAncestors(id: string): string[] {
  if (!/^[1-9][0-9]*(\.[1-9][0-9]*)*$/u.test(id)) return [id];
  const parts = id.split(".");
  return parts.map((_, index) => parts.slice(0, index + 1).join("."));
}

/** `claim-not-covered` and `claim-static-only`: every top-level claim and Not changing entry needs a check that runs. */
function coverageFindings(plan: PlanDocument): PlanQualityFinding[] {
  const scenarios = plan.e2e?.scenarios ?? [];
  // A plan that says no check applies, and proposes none, is left alone: there is nothing to cover.
  if (plan.checks?.noneReason !== undefined && plan.checks.proposed.length === 0 && scenarios.length === 0) return [];
  const runtime = new Set<string>();
  const reading = new Set<string>();
  for (const [scenarioId, proves] of Object.entries(plan.scenarioProves ?? {})) {
    const scenario = scenarios.find((item) => item.scenarioId === scenarioId);
    if (scenario === undefined) continue;
    for (const id of proves.flatMap(withAncestors)) (scenarioRunsApp(scenario) ? runtime : reading).add(id);
  }
  for (const check of plan.checks?.proposed ?? []) {
    for (const id of (plan.checks?.proves[check.id] ?? []).flatMap(withAncestors)) (isStaticReaderCommand(check.command) ? reading : runtime).add(id);
  }
  const subjects = [...plan.claims.map((claim) => claim.id), ...plan.notChanging.map((_, index) => `nc${index + 1}`)];
  const known = new Set(planClaimIds(plan));
  const open = subjects.filter((id) => (known.has(id) || /^nc[1-9][0-9]*$/u.test(id)) && !runtime.has(id));
  const notCovered = open.filter((id) => !reading.has(id)).slice(0, CLAIM_FINDING_IDS_MAX);
  const staticOnly = open.filter((id) => reading.has(id)).slice(0, CLAIM_FINDING_IDS_MAX);
  return [
    ...(notCovered.length === 0 ? [] : [planQualityFinding({ code: "claim-not-covered", claimIds: notCovered })]),
    ...(staticOnly.length === 0 ? [] : [planQualityFinding({ code: "claim-static-only", claimIds: staticOnly })]),
  ];
}

/**
 * The plan quality findings for a parsed coding plan, in a fixed order: what the project cannot run (shown first), then
 * missing mocks, bad check commands, and claims no running check proves. Without a `context` (the planning context was
 * unknown) the rules that need it are skipped. The same plan and context give the same findings on every path.
 */
export function planQualityFindings(plan: PlanDocument, input: { context?: PlanQualityContext | undefined; needs?: PlanQualityNeeds | undefined } = {}): PlanQualityFinding[] {
  const { context, needs = {} } = input;
  return [
    ...(context === undefined ? [] : gapFindings(plan, context, needs)),
    ...(context === undefined ? [] : mockFindings(plan, context)),
    ...commandLintFindings(plan),
    ...coverageFindings(plan),
  ];
}
