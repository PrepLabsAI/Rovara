import {
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS, PLAN_QUALITY_LINTS, builtinFileCheckOf, notChangingReference, planQualityFinding, planQualityTargetReason,
  type PlanDocument, type PlanDocumentKind, type PlanQualityFinding, type PlanQualityLint, type WorkflowCheck,
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
  /** The most actions the request allows an AI navigation step; the route's own cap (8) when absent or higher. */
  maxActions?: number;
}

const PORTABLE_STEP_KINDS = new Set(["invoke-contract", "inspect-contract"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
/** Programs that only read: a check made of them cannot show that code runs. Further rules below for find, git, sed and awk. */
const PURE_READERS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "test", "[", "wc", "head", "tail", "ls", "stat", "diff", "cmp", "sort", "tr", "cut", "jq"]);
const FINDERS_THAT_RUN = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf"]);
const GIT_READERS = new Set(["grep", "diff", "show", "ls-files", "cat-file", "log", "status", "rev-parse"]);
const UNSAFE_AWK = /system\s*\(|getline|print\s*>|printf\s*>|\|\s*"|\|&/u;
const GREPS = new Set(["grep", "egrep", "fgrep"]);
/** Commands whose exit code does not say whether the text was found. */
const EXIT_INSENSITIVE = new Set(["sed", "awk", "gawk", "mawk", "wc", "head", "tail", "cut", "sort", "tr", "jq"]);
const ABSENCE_WORDS = /\b(?:no|not|never|without|absent|absence|removed?|missing|gone|lacks?|doesn'?t|does\s+not|isn'?t|dropped|eliminated|deleted|replaced|stops?|instead\s+of)\b/iu;
const HIDDEN_WORDS = /\b(?:hidden|hides?|not\s+(?:be\s+)?(?:shown|visible|displayed)|invisible|no\s+longer\s+(?:shown|visible|displayed)|disappear\w*|(?:must\s+not|cannot|can'?t|does\s+not|do\s+not|not)\s+see)\b/iu;
const CLAIM_FINDING_IDS_MAX = 32;
const SHELL_DEPTH_MAX = 3;
/** The most actions an AI navigation step may take (the route's own cap). */
const AGENT_ACTIONS_CAP = E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxActionsPerStep;

const baseName = (executable: string): string => executable.slice(executable.lastIndexOf("/") + 1);

interface Word { text: string; plain: boolean }

/**
 * The commands of a shell script, split only on operators outside quotes: `;`, `&&`, `||`, `|`, `&`, line breaks,
 * parentheses, `$(` and backticks. Understands single and double quotes and backslashes and nothing else (no variables,
 * here-documents or loops); anything it does not understand ends up as an ordinary word and so as a runtime command.
 */
function scanScript(script: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let current: Word | undefined;
  let quote: string | undefined;
  const endWord = () => { if (current !== undefined) words.push(current); current = undefined; };
  const endCommand = () => { endWord(); if (words.length > 0) commands.push(words); words = []; };
  const add = (char: string, plain: boolean) => { current ??= { text: "", plain: true }; current.text += char; if (!plain) current.plain = false; };
  const chars = Array.from(script);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && /["\\$`]/u.test(chars[index + 1] ?? "")) { add(chars[index + 1]!, false); index += 1; }
      else add(char, false);
    } else if (char === "'" || char === "\"") {
      quote = char;
      current ??= { text: "", plain: true };
      current.plain = false;
    } else if (char === "\\" && index + 1 < chars.length) {
      add(chars[index + 1]!, false);
      index += 1;
    } else if (char === ";" || char === "|" || char === "\n" || char === "`" || char === "(" || char === ")") {
      if (char === "(" && current?.text === "$") current = undefined;
      endCommand();
    } else if (char === "&" && chars[index - 1] !== ">" && !/\d/u.test(chars[index + 1] ?? "") ) {
      endCommand();
    } else if (/\s/u.test(char)) {
      endWord();
    } else {
      add(char, true);
    }
  }
  endCommand();
  return commands;
}

interface SimpleCommand { executable: string; args: string[]; negated: boolean; writes: boolean }

/** A command's words as a simple command: environment assignments, `!`, braces and redirections taken out. */
function simpleOf(words: readonly Word[]): SimpleCommand | undefined {
  let list = [...words];
  let negated = false;
  while (list.length > 0) {
    const first = list[0]!;
    if (first.plain && first.text === "!") { negated = !negated; list = list.slice(1); }
    else if (first.plain && (first.text === "{" || first.text === "}" || first.text === "then" || first.text === "do" || first.text === "if" || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(first.text))) list = list.slice(1);
    else break;
  }
  let writes = false;
  const kept: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index]!;
    if (word.plain && /^\d*>&\d$/u.test(word.text)) continue;
    if (word.plain && /^\d*>>?$/u.test(word.text)) { if (list[index + 1]?.text !== "/dev/null") writes = true; index += 1; continue; }
    if (word.plain && /^\d*>>?\S/u.test(word.text)) { if (!/^\d*>>?\/dev\/null$/u.test(word.text)) writes = true; continue; }
    if (word.plain && word.text === "<") { index += 1; continue; }
    if (word.plain && /^<[^<]/u.test(word.text)) continue;
    kept.push(word.text);
  }
  if (kept.length === 0) return undefined;
  let executable = baseName(kept[0]!);
  let args = kept.slice(1);
  if (executable === "git") {
    let at = 0;
    while (at < args.length && args[at]!.startsWith("-")) at += args[at] === "-C" || args[at] === "-c" ? 2 : 1;
    if (args[at] !== undefined) { executable = `git ${args[at]!}`; args = args.slice(at + 1); }
  }
  return { executable, args, negated, writes };
}

/** The simple commands a check runs. A shell's `-c` script (`-c`, `-ec`, `-lc`...) is read too, up to three shells deep. */
function simpleCommands(command: Pick<WorkflowCheck["command"], "executable" | "args">, depth = 0): SimpleCommand[] {
  const executable = baseName(command.executable);
  if (SHELLS.has(executable)) {
    const flag = command.args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
    const script = flag < 0 ? undefined : command.args[flag + 1];
    if (script === undefined || depth >= SHELL_DEPTH_MAX) return [{ executable, args: [...command.args], negated: false, writes: false }];
    return scanScript(script).flatMap((words) => {
      const simple = simpleOf(words);
      if (simple === undefined) return [];
      return SHELLS.has(simple.executable) ? simpleCommands(simple, depth + 1) : [simple];
    });
  }
  const simple = simpleOf([{ text: command.executable, plain: true }, ...command.args.map((text) => ({ text, plain: false }))]);
  return simple === undefined ? [] : [simple];
}

function isStaticSimple(item: SimpleCommand): boolean {
  if (item.writes) return false;
  const { executable, args } = item;
  if (PURE_READERS.has(executable)) return true;
  if (executable === "find") return !args.some((arg) => FINDERS_THAT_RUN.has(arg));
  if (executable.startsWith("git ")) return GIT_READERS.has(executable.slice(4));
  if (executable === "sed") return !args.some((arg) => /^-[A-Za-z]*[iI]/u.test(arg) || arg.startsWith("--in-place")) && !args.some((arg) => !arg.startsWith("-") && /(?:^|[;{}\s])[we]\s/u.test(arg));
  if (executable === "awk" || executable === "gawk" || executable === "mawk") return !args.some((arg) => UNSAFE_AWK.test(arg));
  return false;
}

/** True when a command only reads files (a built-in file check, `grep`, `git grep`, `sed -n`...): it cannot show that code ran. Anything not recognised counts as running code. */
export function isStaticReaderCommand(command: Pick<WorkflowCheck["command"], "executable" | "args">): boolean {
  if (builtinFileCheckOf(command) !== undefined) return true;
  const commands = simpleCommands(command);
  return commands.length > 0 && commands.every(isStaticSimple);
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

/**
 * The first known-bad form of a proposed check's command, or undefined. Command semantics decide; the wording of the
 * check's label and of the claims it proves (`wording`) only says whether the check is meant to prove absence.
 * A built-in file check has no bad form: its meaning is fixed.
 */
function lintOf(check: WorkflowCheck, wording: string): PlanQualityLint | undefined {
  if (builtinFileCheckOf(check.command) !== undefined) return undefined;
  const commands = simpleCommands(check.command);
  const found = new Set<PlanQualityLint>();
  const absence = ABSENCE_WORDS.test(wording);
  for (const item of commands.filter((entry) => GREPS.has(entry.executable) || entry.executable === "git grep")) {
    const { letters, patterns } = grepShape(item.args);
    if (letters.has("L") && letters.has("c")) found.add("grep-files-without-match-count");
    else if (letters.has("L")) found.add("grep-files-without-match");
    else if (letters.has("v")) found.add("grep-invert-match");
    else if (letters.has("c") && absence) found.add("grep-count-absence");
    else if (!letters.has("c") && absence && !item.negated) found.add("grep-absence");
    if (letters.has("c")) found.add("grep-count");
    if (patterns.some(hasQuote)) found.add("quoted-literal");
  }
  const last = commands.at(-1);
  if (last !== undefined && EXIT_INSENSITIVE.has(last.executable)) {
    const text = last.args.join(" ");
    const decides = (last.executable === "sed" && /[qQ]\s*\d/u.test(text)) || (last.executable.endsWith("awk") && /\bexit\b/u.test(text))
      || (last.executable === "jq" && last.args.some((arg) => /^-[A-Za-z]*e/u.test(arg) || arg === "--exit-status"));
    if (!decides) found.add("exit-ignores-match");
  }
  return PLAN_QUALITY_LINTS.find((lint) => found.has(lint));
}

/** `check-command-lint`: one finding per proposed check whose command has a known-bad form. */
function commandLintFindings(plan: PlanDocument): PlanQualityFinding[] {
  const claimText = new Map<string, string>();
  const visit = (claims: PlanDocument["claims"]) => { for (const claim of claims) { claimText.set(claim.id, claim.text); visit(claim.children ?? []); } };
  visit(plan.claims);
  const textOf = (id: string): string => {
    const position = notChangingReference(id);
    return position === undefined ? (claimText.get(id) ?? "") : (plan.notChanging[position - 1] ?? "");
  };
  return (plan.checks?.proposed ?? []).flatMap((check) => {
    const wording = [check.label, ...(plan.checks?.proves[check.id] ?? []).map(textOf)].join(" ");
    const lint = lintOf(check, wording);
    return lint === undefined ? [] : [planQualityFinding({ code: "check-command-lint", checkIds: [check.id], lint })];
  });
}

/** True when a scenario drives the app (anything but a source-interface or contract call alone). */
const scenarioRunsApp = (scenario: { steps: ReadonlyArray<{ kind: string }> }): boolean => scenario.steps.length === 0 || scenario.steps.some((step) => !PORTABLE_STEP_KINDS.has(step.kind));

/** The IDs of the mocks a plan selects for a target. */
const mockedOn = (plan: PlanDocument, targetId: string): string[] => (plan.e2e?.mockFixtureRefs ?? []).filter((ref) => ref.requestedTargetId === targetId).map((ref) => ref.componentId);

/** Scenarios that drive the app on a target. */
const appScenariosOn = (plan: PlanDocument, targetId: string) => (plan.e2e?.scenarios ?? []).filter((scenario) => scenarioRunsApp(scenario) && scenario.requestedTargetIds.includes(targetId));

/**
 * `mock-missing-for-target`: a target whose scenarios run the app, a mock offered for it, and no mock selected for it in the plan.
 * A component a scenario on the target lists as real is not offered: asking for its mock would make the approval refuse the plan.
 */
function mockFindings(plan: PlanDocument, context: PlanQualityContext): PlanQualityFinding[] {
  const intent = plan.e2e;
  if (intent === undefined) return [];
  const targetIds = intent.requestedTargetIds.filter((targetId) => appScenariosOn(plan, targetId).length > 0);
  return targetIds.flatMap((targetId) => {
    const real = new Set(appScenariosOn(plan, targetId).flatMap((scenario) => scenario.requiredRealComponentIds));
    const offered = context.mockFixtures.filter((fixture) => fixture.requestedTargetIds.includes(targetId) && !real.has(fixture.componentId)).map((fixture) => fixture.componentId);
    return mockedOn(plan, targetId).length > 0 || offered.length === 0 ? [] : [planQualityFinding({ code: "mock-missing-for-target", targetIds: [targetId], fixtureIds: [...new Set(offered)] })];
  });
}

/** `real-component-mocked`: a component both mocked and required real on one target (the approval refuses it). Needs no planning context. */
function realComponentFindings(plan: PlanDocument): PlanQualityFinding[] {
  return (plan.e2e?.requestedTargetIds ?? []).flatMap((targetId) => {
    const mocked = new Set(mockedOn(plan, targetId));
    const clashing = appScenariosOn(plan, targetId).filter((scenario) => scenario.requiredRealComponentIds.some((componentId) => mocked.has(componentId)));
    if (clashing.length === 0) return [];
    const components = [...new Set(clashing.flatMap((scenario) => scenario.requiredRealComponentIds.filter((componentId) => mocked.has(componentId))))];
    return [planQualityFinding({ code: "real-component-mocked", targetIds: [targetId], fixtureIds: components, scenarioIds: clashing.map((scenario) => scenario.scenarioId) })];
  });
}

/** `agent-budget-exceeded`: an AI navigation step above the request's number of actions, or the route's own cap. Needs no planning context. */
function agentBudgetFindings(plan: PlanDocument, needs: PlanQualityNeeds): PlanQualityFinding[] {
  const limit = Math.min(needs.maxActions ?? AGENT_ACTIONS_CAP, AGENT_ACTIONS_CAP);
  const over = (plan.e2e?.scenarios ?? []).filter((scenario) => scenario.steps.some((step) => step.kind === "agent" && step.maxActions > limit));
  return over.length === 0 ? [] : [planQualityFinding({ code: "agent-budget-exceeded", scenarioIds: over.map((scenario) => scenario.scenarioId), limit })];
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

/** The claims with no children, in document order. */
function leafClaimIds(claims: PlanDocument["claims"]): string[] {
  return claims.flatMap((claim) => ((claim.children ?? []).length === 0 ? [claim.id] : leafClaimIds(claim.children ?? [])));
}

/** Every claim (any depth) with its text, in document order. */
function allClaims(claims: PlanDocument["claims"]): Array<{ id: string; text: string }> {
  return claims.flatMap((claim) => [{ id: claim.id, text: claim.text }, ...allClaims(claim.children ?? [])]);
}

/**
 * `claim-not-covered`, `claim-static-only`, `hidden-assertion-missing` and `checks-waived`. Every leaf claim and every
 * Not changing entry needs a check that runs (a proof of a child also covers its ancestors, never the reverse). A
 * scenario with no assertion proves nothing. A claim that says something is hidden needs a scenario asserting it is not visible.
 */
function coverageFindings(plan: PlanDocument): PlanQualityFinding[] {
  const scenarios = plan.e2e?.scenarios ?? [];
  const subjects = [...leafClaimIds(plan.claims), ...plan.notChanging.map((_, index) => `nc${index + 1}`)];
  // A plan that says no check applies, and proposes none, is not revised for it; the owner still sees that its claims have no proof.
  if (plan.checks?.noneReason !== undefined && plan.checks.proposed.length === 0 && scenarios.length === 0) {
    return [planQualityFinding({ code: "checks-waived", claimIds: subjects.slice(0, CLAIM_FINDING_IDS_MAX), count: subjects.length })];
  }
  const runtime = new Set<string>();
  const reading = new Set<string>();
  const scenariosProving = new Map<string, Array<(typeof scenarios)[number]>>();
  for (const [scenarioId, proves] of Object.entries(plan.scenarioProves ?? {})) {
    const scenario = scenarios.find((item) => item.scenarioId === scenarioId);
    if (scenario === undefined || scenario.assertions.length === 0) continue;
    const runs = scenarioRunsApp(scenario);
    for (const id of proves.flatMap(withAncestors)) {
      (runs ? runtime : reading).add(id);
      if (runs) scenariosProving.set(id, [...(scenariosProving.get(id) ?? []), scenario]);
    }
  }
  for (const check of plan.checks?.proposed ?? []) {
    for (const id of (plan.checks?.proves[check.id] ?? []).flatMap(withAncestors)) (isStaticReaderCommand(check.command) ? reading : runtime).add(id);
  }
  const open = subjects.filter((id) => !runtime.has(id));
  const notCovered = open.filter((id) => !reading.has(id)).slice(0, CLAIM_FINDING_IDS_MAX);
  const staticOnly = open.filter((id) => reading.has(id)).slice(0, CLAIM_FINDING_IDS_MAX);
  // Proved by scenarios, yet none of them asserts that the thing is gone from the page.
  const hidden = allClaims(plan.claims).filter((claim) => HIDDEN_WORDS.test(claim.text) && (scenariosProving.get(claim.id) ?? []).length > 0
    && !(scenariosProving.get(claim.id) ?? []).some((scenario) => scenario.assertions.some((assertion) => assertion.kind === "visible" && assertion.equals === false))).map((claim) => claim.id);
  return [
    ...(notCovered.length === 0 ? [] : [planQualityFinding({ code: "claim-not-covered", claimIds: notCovered })]),
    ...(staticOnly.length === 0 ? [] : [planQualityFinding({ code: "claim-static-only", claimIds: staticOnly })]),
    ...(hidden.length === 0 ? [] : [planQualityFinding({ code: "hidden-assertion-missing", claimIds: hidden.slice(0, CLAIM_FINDING_IDS_MAX) })]),
  ];
}

/**
 * The plan quality findings for a parsed coding plan, in a fixed order: what the project cannot run (shown first), then
 * mock mistakes, AI step budgets, bad check commands, and claims no running check proves. Only a coding plan (`kind: "plan"`)
 * is judged. Without a `context` (the planning context was unknown) the rules that need it are skipped. The same plan and
 * context give the same findings on every path.
 */
export function planQualityFindings(plan: PlanDocument, input: { kind: PlanDocumentKind; context?: PlanQualityContext | undefined; needs?: PlanQualityNeeds | undefined }): PlanQualityFinding[] {
  if (input.kind !== "plan") return [];
  const { context, needs = {} } = input;
  return [
    ...(context === undefined ? [] : gapFindings(plan, context, needs)),
    ...realComponentFindings(plan),
    ...(context === undefined ? [] : mockFindings(plan, context)),
    ...agentBudgetFindings(plan, needs),
    ...commandLintFindings(plan),
    ...coverageFindings(plan),
  ];
}
