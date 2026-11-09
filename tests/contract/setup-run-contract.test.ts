// Setup run contract (design setup-test-health 3.2-3.4, SH2): limits and how a company lock combines with them, the stop words, the journal entry, host asks, and the new value sources.
import { describe, expect, it } from "vitest";
import {
  SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, SETUP_AGENT_LIMIT_NAMES, SETUP_AGENT_PURPOSE, SETUP_JOURNAL_MAX_ENTRIES, SETUP_PERSON_SOURCE, SETUP_RUN_END_WORDS, SETUP_RUN_LIMIT_STOPS,
  SetupAgentLimitSettingSchema, SetupAgentLimitsSchema, SetupHostAskSchema, SetupReplacementSchema, setupReplacementText, SetupHostSchema, SetupJournalEntrySchema, SetupRunSummarySchema, SetupValueSourceSchema,
  effectiveSetupAgentLimits, isSetupRunLimitStop, observedSource, recipeSource,
} from "../../packages/contracts/src/setup-run.js";
import { TestEnvironmentProposalSchema, TestEnvValueSourceSchema } from "../../packages/contracts/src/test-environment.js";

const entry = (over: Record<string, unknown> = {}) => ({ n: 1, source: "agent", command: "uv sync --frozen", exitCode: 0, durationMs: 48_000, timedOut: false, flagged: false, blockedHosts: [], tail: "ok\n", startedAt: "2026-11-01T10:00:00.000Z", ...over });

describe("limits", () => {
  it("matches the design's table: defaults and maximums", () => {
    expect(SETUP_AGENT_LIMITS_DEFAULT).toEqual({ commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 });
    expect(SETUP_AGENT_LIMITS_MAX).toEqual({ commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2_000, hostAsks: 10 });
    expect(SETUP_AGENT_PURPOSE).toBe("setup_agent");
  });
  it("accepts each maximum and refuses one above it, zero, fractions and unknown names", () => {
    expect(SetupAgentLimitsSchema.safeParse(SETUP_AGENT_LIMITS_MAX).success).toBe(true);
    for (const name of SETUP_AGENT_LIMIT_NAMES) {
      expect(SetupAgentLimitsSchema.safeParse({ ...SETUP_AGENT_LIMITS_DEFAULT, [name]: SETUP_AGENT_LIMITS_MAX[name] + 1 }).success, name).toBe(false);
      expect(SetupAgentLimitsSchema.safeParse({ ...SETUP_AGENT_LIMITS_DEFAULT, [name]: 0 }).success, name).toBe(false);
      expect(SetupAgentLimitsSchema.safeParse({ ...SETUP_AGENT_LIMITS_DEFAULT, [name]: 1.5 }).success, name).toBe(false);
    }
    expect(SetupAgentLimitsSchema.safeParse({ ...SETUP_AGENT_LIMITS_DEFAULT, extra: 1 }).success).toBe(false);
    expect(SetupAgentLimitSettingSchema.safeParse({ budgetCents: 100 }).success).toBe(true);
    expect(SetupAgentLimitSettingSchema.safeParse({ concurrentRuns: 2 }).success).toBe(false);
  });
  it("uses the defaults when nothing is set", () => {
    expect(effectiveSetupAgentLimits()).toEqual(SETUP_AGENT_LIMITS_DEFAULT);
    expect(effectiveSetupAgentLimits(undefined, undefined)).toEqual(SETUP_AGENT_LIMITS_DEFAULT);
  });
  it("lets a project raise a limit up to the maximum and no further", () => {
    expect(effectiveSetupAgentLimits({ commands: 120, budgetCents: 2_000 }).commands).toBe(120);
    expect(effectiveSetupAgentLimits({ commands: 121 }).commands).toBe(SETUP_AGENT_LIMITS_DEFAULT.commands);
    expect(effectiveSetupAgentLimits({ budgetCents: 999_999 }).budgetCents).toBe(SETUP_AGENT_LIMITS_DEFAULT.budgetCents);
  });
  it("never lets a company lock loosen a project: the lower of the two wins", () => {
    expect(effectiveSetupAgentLimits({ commands: 100 }, { commands: 60 }).commands).toBe(60);
    expect(effectiveSetupAgentLimits({ commands: 10 }, { commands: 60 }).commands).toBe(10);
    // A lock above the default does not raise a project that set nothing.
    expect(effectiveSetupAgentLimits(undefined, { commands: 100 }).commands).toBe(SETUP_AGENT_LIMITS_DEFAULT.commands);
    expect(effectiveSetupAgentLimits(undefined, { budgetCents: 100 }).budgetCents).toBe(100);
  });
  it("reads a damaged lock as stricter than none, never looser", () => {
    expect(effectiveSetupAgentLimits({ commands: 100 }, { commands: 9_999 }).commands).toBe(SETUP_AGENT_LIMITS_DEFAULT.commands);
    expect(effectiveSetupAgentLimits({ commands: 100 }, { commands: "lots" }).commands).toBe(SETUP_AGENT_LIMITS_DEFAULT.commands);
    expect(effectiveSetupAgentLimits({ commands: 100 }, "nonsense")).toEqual({ ...SETUP_AGENT_LIMITS_DEFAULT, commands: 100 });
    expect(effectiveSetupAgentLimits(["x"], null)).toEqual(SETUP_AGENT_LIMITS_DEFAULT);
  });
  it("always returns limits that pass the schema", () => {
    for (const project of [undefined, {}, { hostAsks: 10 }, { hostAsks: -1 }, { wallClockMin: 1 }, "x", 7]) for (const lock of [undefined, {}, { hostAsks: 2 }, { sameStepTries: 0 }]) {
      expect(SetupAgentLimitsSchema.safeParse(effectiveSetupAgentLimits(project, lock)).success).toBe(true);
    }
  });
});

describe("stop words", () => {
  it("has the four limit words, and a limit stop is always a partial proposal", () => {
    expect(SETUP_RUN_LIMIT_STOPS).toEqual(["attempts_used", "time_used", "budget_used", "hosts_waiting"]);
    for (const word of SETUP_RUN_LIMIT_STOPS) {
      expect(isSetupRunLimitStop(word)).toBe(true);
      const summary = { stop: word, commandsRun: 3, spendCents: 120, elapsedMs: 5_000, hostAsks: 1 };
      expect(SetupRunSummarySchema.safeParse({ ...summary, partial: true }).success, word).toBe(true);
      expect(SetupRunSummarySchema.safeParse({ ...summary, partial: false }).success, word).toBe(false);
    }
    expect(SETUP_RUN_END_WORDS).toEqual(expect.arrayContaining(["proposed", "stopped_by_person", "needs_code_change", "changed_repository_files", "infrastructure"]));
    expect(isSetupRunLimitStop("proposed")).toBe(false);
    expect(SetupRunSummarySchema.safeParse({ stop: "proposed", commandsRun: 3, spendCents: 1, elapsedMs: 1, hostAsks: 0, partial: false }).success).toBe(true);
    expect(SetupRunSummarySchema.safeParse({ stop: "because I felt like it", commandsRun: 3, spendCents: 1, elapsedMs: 1, hostAsks: 0, partial: true }).success).toBe(false);
  });
});

describe("journal entry", () => {
  it("accepts a normal entry and refuses unknown fields", () => {
    expect(SetupJournalEntrySchema.safeParse(entry()).success).toBe(true);
    expect(SetupJournalEntrySchema.safeParse(entry({ extra: 1 })).success).toBe(false);
  });
  it("keeps the command on one plain line and bounded", () => {
    expect(SetupJournalEntrySchema.safeParse(entry({ command: "a\nb" })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ command: "a‮b" })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ command: "" })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ command: "x".repeat(2_001) })).success).toBe(false);
  });
  it("bounds the tail to 4 KiB of bytes and to plain text", () => {
    expect(SetupJournalEntrySchema.safeParse(entry({ tail: "x".repeat(4_096) })).success).toBe(true);
    expect(SetupJournalEntrySchema.safeParse(entry({ tail: "x".repeat(4_097) })).success).toBe(false);
    // 2,049 two-byte characters are under 4,096 characters and over 4,096 bytes.
    expect(SetupJournalEntrySchema.safeParse(entry({ tail: "é".repeat(2_049) })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ tail: "line\n\tindented" })).success).toBe(true);
    expect(SetupJournalEntrySchema.safeParse(entry({ tail: "bell\u0007" })).success).toBe(false);
  });
  it("bounds the position, the exit, the time and the blocked hosts", () => {
    expect(SetupJournalEntrySchema.safeParse(entry({ n: 0 })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ n: SETUP_JOURNAL_MAX_ENTRIES + 1 })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ exitCode: null, timedOut: true })).success).toBe(true);
    expect(SetupJournalEntrySchema.safeParse(entry({ exitCode: 256 })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ durationMs: -1 })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ blockedHosts: Array.from({ length: 50 }, (_, i) => `h${String(i)}.example.com`) })).success).toBe(true);
    expect(SetupJournalEntrySchema.safeParse(entry({ blockedHosts: Array.from({ length: 51 }, (_, i) => `h${String(i)}.example.com`) })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ source: "model" })).success).toBe(false);
    expect(SetupJournalEntrySchema.safeParse(entry({ source: "person" })).success).toBe(true);
  });
});

describe("hosts", () => {
  it("accepts DNS names and refuses address literals, paths, schemes, wildcards and upper case", () => {
    for (const ok of ["artifactory.corp.example", "pypi.org", "a-b.c-d.example.io", "xn--bcher-kva.example"]) expect(SetupHostSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["10.0.0.1", "169.254.169.254", "::1", "[::1]", "2001:db8::1", "localhost", "https://pypi.org", "pypi.org/simple", "pypi.org:443", "*.pypi.org", "PyPI.org", "user@pypi.org", "a..b.com", "-a.example.com", "example.123", ""]) {
      expect(SetupHostSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("makes a host ask with an optional pointer to the command and the file line", () => {
    expect(SetupHostAskSchema.safeParse({ host: "artifactory.corp.example", status: "open", journalN: 4, from: { path: "pip.conf", line: 2 } }).success).toBe(true);
    expect(SetupHostAskSchema.safeParse({ host: "10.1.2.3", status: "open" }).success).toBe(false);
    expect(SetupHostAskSchema.safeParse({ host: "pypi.org", status: "maybe" }).success).toBe(false);
    expect(SetupHostAskSchema.safeParse({ host: "pypi.org", status: "open", extra: 1 }).success).toBe(false);
  });
});

describe("value sources", () => {
  it("builds and reads observed, recipe and person sources", () => {
    expect(observedSource("run-1", 7)).toBe("observed:run-1#7");
    expect(recipeSource("python-uv", 3)).toBe("recipe:python-uv@3");
    for (const source of [observedSource("run-1", 7), recipeSource("python-uv", 3), SETUP_PERSON_SOURCE]) expect(SetupValueSourceSchema.safeParse(source).success, source).toBe(true);
  });
  it("refuses malformed or out-of-range sources", () => {
    for (const bad of ["observed:#7", "observed:run-1#0", "observed:run-1#401", "observed:RUN#1", "observed:run-1", "recipe:x@0", "recipe:@1", "recipe:Bad@1", "recipe:x@1.5", "People", "persona"]) {
      expect(SetupValueSourceSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(() => observedSource("Bad Id", 1)).toThrow();
    expect(() => observedSource("run-1", 401)).toThrow();
    expect(() => recipeSource("x", 0)).toThrow();
  });
  it("round-trips through the proposal's source union, beside the sources it already had", () => {
    for (const source of [observedSource("run-1", 7), recipeSource("python-uv", 3), "person", "model", "detector:python", { path: "pyproject.toml", line: 3 }]) {
      const parsed = TestEnvValueSourceSchema.parse(source);
      expect(parsed).toEqual(source);
      expect(TestEnvValueSourceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(source);
    }
    expect(TestEnvValueSourceSchema.safeParse("observed:run-1#0").success).toBe(false);
    expect(TestEnvValueSourceSchema.safeParse("detector:BAD").success).toBe(false);
    expect(TestEnvValueSourceSchema.safeParse("recipe:x").success).toBe(false);
  });
  it("is accepted in a proposal's valueSources", () => {
    const shape = TestEnvironmentProposalSchema.shape.valueSources.element.shape.source;
    expect(shape.safeParse(observedSource("run-9", 12)).success).toBe(true);
  });
});

describe("replacements", () => {
  const replacement = { field: "repos[0].setupCommands[0]", detected: "uv sync --frozen", replacedBy: "uv sync", failedAtN: 7, workedAtN: 9 };
  it("accepts a replacement and writes the card's sentence in fixed words around the two commands", () => {
    expect(SetupReplacementSchema.safeParse(replacement).success).toBe(true);
    expect(SetupReplacementSchema.safeParse({ ...replacement, workedAtN: undefined }).success).toBe(true);
    expect(setupReplacementText(SetupReplacementSchema.parse(replacement))).toBe("detected uv sync --frozen, replaced by uv sync because uv sync --frozen failed (journal #7)");
  });
  it("is strict, one line, and bounded to the journal", () => {
    for (const bad of [{ ...replacement, extra: 1 }, { ...replacement, detected: "a\nb" }, { ...replacement, replacedBy: "" }, { ...replacement, failedAtN: 0 }, { ...replacement, failedAtN: 401 }, { ...replacement, workedAtN: 401 }, { ...replacement, detected: "x".repeat(1_025) }]) {
      expect(SetupReplacementSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });
});
