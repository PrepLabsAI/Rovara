// Setup run (design setup-test-health, sections 3.2-3.4, task SH2): the contract of the setup agent that RUNS things. "Set up this project" starts a live run (a task with purpose `setup_agent`) in
// a setup sandbox; the agent runs setup and test commands, reads the errors and tries again, inside fixed limits, and ends with a proposal. This file holds only the shapes and the pure rules around
// them, so the worker (session, journal, governor), the broker (start, stop, store) and the app (live view) read one definition. Browser-safe: nothing here imports a Node module.
//
// What the schemas guarantee, so no builder has to remember it:
//   - every limit has a default and a hard maximum; a project can lower a limit, a company lock can only lower it further (a lock never loosens a project, M8);
//   - a run stops with one of four fixed words when a limit is used up (`attempts_used`, `time_used`, `budget_used`, `hosts_waiting`), and keeps what it learned as a partial proposal;
//   - a journal entry holds a redacted command on one line, the exit, the time, the hosts that were blocked and at most 4 KiB of redacted output; nothing else of the command's output is kept;
//   - a host is a plain DNS name: an address literal never parses (the design refuses those without a card);
//   - where a value came from is one of `observed:<run>#<n>`, `recipe:<id>@<rev>` or `person`, besides the file-and-line, `model` and `detector:` sources the proposal already has.
import { z } from "zod";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

/** The task purpose of a setup run. The read-only draft keeps `setup_draft`; this is the run that has a shell. */
export const SETUP_AGENT_PURPOSE = "setup_agent" as const;

// ---- limits (design 3.2)

/** What a run may use, and the most a project or a company may allow. Money is whole cents so no limit is ever a float. */
export const SETUP_AGENT_LIMIT_NAMES = ["commands", "sameStepTries", "wallClockMin", "budgetCents", "hostAsks"] as const;
export type SetupAgentLimitName = (typeof SETUP_AGENT_LIMIT_NAMES)[number];

export const SETUP_AGENT_LIMITS_DEFAULT = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 } as const satisfies Record<SetupAgentLimitName, number>;
export const SETUP_AGENT_LIMITS_MAX = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2_000, hostAsks: 10 } as const satisfies Record<SetupAgentLimitName, number>;
/** Setup runs at once per project. Not a setting: it is 1. */
export const SETUP_AGENT_CONCURRENT_RUNS = 1 as const;
/** How long a run parks, waiting for an admin to answer a host ask, before it ends `hosts_waiting`. */
export const SETUP_HOST_WAIT_MAX_HOURS = 24 as const;
/** Blocked host names one run remembers (the DNS watch's bound). */
export const SETUP_BLOCKED_HOSTS_MAX = 50 as const;
/** Bytes of redacted output a journal entry keeps. */
export const SETUP_JOURNAL_TAIL_BYTES = 4_096 as const;
/** The most journal entries a run holds: the agent's commands plus a person's, with room over the largest command limit. */
export const SETUP_JOURNAL_MAX_ENTRIES = 400 as const;

const limitField = (name: SetupAgentLimitName) => z.number().int().min(1).max(SETUP_AGENT_LIMITS_MAX[name]);

export const SetupAgentLimitsSchema = z
  .object({
    commands: limitField("commands"),
    sameStepTries: limitField("sameStepTries"),
    wallClockMin: limitField("wallClockMin"),
    budgetCents: limitField("budgetCents"),
    hostAsks: limitField("hostAsks"),
  })
  .strict();
export type SetupAgentLimits = z.infer<typeof SetupAgentLimitsSchema>;

/** A project's setting, or a company's lock: any subset of the limits. */
export const SetupAgentLimitSettingSchema = SetupAgentLimitsSchema.partial().strict();
export type SetupAgentLimitSetting = z.infer<typeof SetupAgentLimitSettingSchema>;

/**
 * The limits a run uses: for each limit, the project's value (the default when it set none or its value is not valid), cut down to the company lock when there is one, and never above the
 * maximum. A lock only ever lowers: a lock above the project's value changes nothing. A lock that does not read gives the default for the limits it names wrongly, so a damaged lock
 * is stricter than none, never looser. Pure; never throws.
 */
export function effectiveSetupAgentLimits(project?: unknown, lock?: unknown): SetupAgentLimits {
  const valueOf = (source: unknown, name: SetupAgentLimitName): number | undefined => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
    const raw: unknown = (source as Record<string, unknown>)[name];
    if (raw === undefined) return undefined;
    const parsed = limitField(name).safeParse(raw);
    return parsed.success ? parsed.data : Number.NaN;
  };
  const out = { ...SETUP_AGENT_LIMITS_DEFAULT } as Record<SetupAgentLimitName, number>;
  for (const name of SETUP_AGENT_LIMIT_NAMES) {
    const own = valueOf(project, name);
    let value: number = own === undefined || Number.isNaN(own) ? SETUP_AGENT_LIMITS_DEFAULT[name] : own;
    const locked = valueOf(lock, name);
    if (locked !== undefined) value = Math.min(value, Number.isNaN(locked) ? SETUP_AGENT_LIMITS_DEFAULT[name] : locked);
    out[name] = Math.min(value, SETUP_AGENT_LIMITS_MAX[name]);
  }
  return SetupAgentLimitsSchema.parse(out);
}

// ---- stop words (design 3.2)

/**
 * Why a run stopped because a limit was used up, in fixed words. `attempts_used`: the commands limit, or the tries of one failing step. `time_used`: the wall clock. `budget_used`: the model spend.
 * `hosts_waiting`: the host asks limit, or a host ask that nobody answered in 24 hours with nothing else left to do.
 */
export const SETUP_RUN_LIMIT_STOPS = ["attempts_used", "time_used", "budget_used", "hosts_waiting"] as const;
export type SetupRunLimitStop = (typeof SETUP_RUN_LIMIT_STOPS)[number];
/** How a run ends. The limit words, then: it gave a proposal; a person stopped it; setup needs a change in the code; setup changed tracked files; the run could not go on (a sandbox or model fault). */
export const SETUP_RUN_END_WORDS = [...SETUP_RUN_LIMIT_STOPS, "proposed", "stopped_by_person", "needs_code_change", "changed_repository_files", "infrastructure"] as const;
export const SetupRunEndWordSchema = z.enum(SETUP_RUN_END_WORDS);
export type SetupRunEndWord = z.infer<typeof SetupRunEndWordSchema>;

export function isSetupRunLimitStop(word: string): word is SetupRunLimitStop {
  return (SETUP_RUN_LIMIT_STOPS as readonly string[]).includes(word);
}

// ---- hosts

/** A host name as DNS has it: lower-case labels, at least two, the last starting with a letter, so an IPv4 or IPv6 literal never parses. */
const HOST_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const SetupHostSchema = z.string().regex(HOST_PATTERN, "a host name");

// ---- the journal (design 3.2)

export const SETUP_COMMAND_SOURCES = ["agent", "person"] as const;

/** One command the run ran. The command is redacted and on one line; the tail is the last bytes of redacted output. Nothing about the command's own words decides anything. */
export const SetupJournalEntrySchema = z
  .object({
    n: z.number().int().min(1).max(SETUP_JOURNAL_MAX_ENTRIES),
    source: z.enum(SETUP_COMMAND_SOURCES),
    command: line(2_000),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    durationMs: z.number().int().min(0).max(7_200_000),
    timedOut: z.boolean(),
    /** The command downloads code and runs it. It ran only in the setup sandbox, and it is never turned into an approved command without the item consent card. */
    flagged: z.boolean(),
    blockedHosts: z.array(SetupHostSchema).max(SETUP_BLOCKED_HOSTS_MAX),
    /** Set on an AGENT command that ran after a person's command (the position of the latest one before it): the sandbox may hold what that command changed, so what this command shows is evidence of the run, not of the repository alone. */
    afterPersonCommandN: z.number().int().min(1).max(SETUP_JOURNAL_MAX_ENTRIES).optional(),
    /** Plain text, no control characters other than newline and tab. */
    tail: z.string().max(SETUP_JOURNAL_TAIL_BYTES).regex(/^[\P{Cc}\n\t]*$/u, "plain text"),
    startedAt: z.string().datetime(),
  })
  .strict()
  .refine((entry) => utf8ByteLength(entry.tail) <= SETUP_JOURNAL_TAIL_BYTES, { message: "the tail is at most 4 KiB", path: ["tail"] });
export type SetupJournalEntry = z.infer<typeof SetupJournalEntrySchema>;

/** UTF-8 length without a Node import (this file is browser-safe). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A host the run needs: one card per host per project. `journalN` is the command that led to it, `from` the repository line that named it; both are optional and only point. */
export const SetupHostAskSchema = z
  .object({
    host: SetupHostSchema,
    status: z.enum(["open", "approved", "refused"]),
    journalN: z.number().int().min(1).max(SETUP_JOURNAL_MAX_ENTRIES).optional(),
    from: z.object({ path: line(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
  })
  .strict();
export type SetupHostAsk = z.infer<typeof SetupHostAskSchema>;

// ---- what the run changed from the detectors (design 3.2: "Code first still holds")

/**
 * A detected value the run replaced because running it failed. Shown on the confirm card as "detected X, replaced by Y because X failed (journal #n)". The two commands are the repository's and the
 * run's own text, redacted and on one line, shown as quoted text and never read as instructions. `failedAtN` is the journal position of the failed run of the detected command; `workedAtN`, of the
 * run of the replacement that worked.
 */
export const SetupReplacementSchema = z
  .object({
    field: line(200),
    detected: line(1_024),
    replacedBy: line(1_024),
    failedAtN: z.number().int().min(1).max(SETUP_JOURNAL_MAX_ENTRIES),
    workedAtN: z.number().int().min(1).max(SETUP_JOURNAL_MAX_ENTRIES).optional(),
  })
  .strict();
export type SetupReplacement = z.infer<typeof SetupReplacementSchema>;

/** The card's sentence for a replacement. Fixed words around the two commands. */
export function setupReplacementText(replacement: SetupReplacement): string {
  return `detected ${replacement.detected}, replaced by ${replacement.replacedBy} because ${replacement.detected} failed (journal #${String(replacement.failedAtN)})`;
}

// ---- what a run reports at its end

export const SetupRunSummarySchema = z
  .object({
    stop: SetupRunEndWordSchema,
    commandsRun: z.number().int().min(0).max(SETUP_JOURNAL_MAX_ENTRIES),
    spendCents: z.number().int().min(0).max(1_000_000),
    elapsedMs: z.number().int().min(0).max(24 * 3_600_000),
    hostAsks: z.number().int().min(0).max(SETUP_AGENT_LIMITS_MAX.hostAsks),
    /** True when the run stopped before it finished: the proposal holds what the run learned so far. A limit stop is always partial. */
    partial: z.boolean(),
  })
  .strict()
  .refine((summary) => !isSetupRunLimitStop(summary.stop) || summary.partial, { message: "a limit stop keeps a partial proposal", path: ["partial"] });
export type SetupRunSummary = z.infer<typeof SetupRunSummarySchema>;

// ---- where a value came from (design 1.1, 3.2, 7.2)

const RUN_ID = "[a-z0-9][a-z0-9_-]{0,63}";
const OBSERVED_PATTERN = new RegExp(`^observed:(${RUN_ID})#([1-9][0-9]{0,2})$`, "u");
const RECIPE_PATTERN = new RegExp(`^recipe:([a-z][a-z0-9_-]{0,63})@([1-9][0-9]{0,5})$`, "u");

/** The value worked when the setup run ran it: command number `n` of the run's journal. */
export function observedSource(setupRunId: string, n: number): `observed:${string}#${number}` {
  const text = `observed:${setupRunId}#${String(n)}`;
  if (!OBSERVED_PATTERN.test(text) || n > SETUP_JOURNAL_MAX_ENTRIES) throw new RangeError("not a setup run journal position");
  return text as `observed:${string}#${number}`;
}
/** The value came from a company recipe, at the revision the proposal started from. */
export function recipeSource(recipeId: string, revision: number): `recipe:${string}@${number}` {
  const text = `recipe:${recipeId}@${String(revision)}`;
  if (!RECIPE_PATTERN.test(text)) throw new RangeError("not a recipe revision");
  return text as `recipe:${string}@${number}`;
}
/** A person typed or chose the value. */
export const SETUP_PERSON_SOURCE = "person" as const;

/** The three sources a setup run adds to a proposal's value sources, as strings the proposal's source union also accepts (`TestEnvValueSourceSchema`). */
export const SetupValueSourceSchema = z.union([
  z.string().regex(OBSERVED_PATTERN).refine((text) => Number(text.slice(text.lastIndexOf("#") + 1)) <= SETUP_JOURNAL_MAX_ENTRIES, "a journal position"),
  z.string().regex(RECIPE_PATTERN),
  z.literal(SETUP_PERSON_SOURCE),
]);
export type SetupValueSource = z.infer<typeof SetupValueSourceSchema>;

// ---- on the wire to the worker (SH14)

/** A worker that lists this checks a prepare invocation's `pins` against the default-branch head it resolves, and refuses the preparation on any difference (P1). */
export const PREPARE_PINS_FEATURE = "prepare.pins.v1" as const;

/**
 * P1: the commit the BROKER read as each repository's default-branch head when it built a setup run's prepare invocation. The worker resolves the head itself and refuses the preparation if it is not exactly
 * this commit (or a repository has no pin), so the preparation the run reads is the one the broker pinned, never one the worker chose.
 */
export const PreparePinsSchema = z.array(z.object({ repository: z.string().min(1).max(200), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }).strict()).min(1).max(32)
  .refine((pins) => new Set(pins.map((pin) => pin.repository)).size === pins.length, "pinned repositories must be unique");
export type PreparePins = z.infer<typeof PreparePinsSchema>;

/** A worker that lists this runs a setup run (`workflowMode: "SETUP_AGENT"`); the broker sends one only to such a worker. */
export const SETUP_AGENT_FEATURE = "task.setupAgent.v1" as const;

/**
 * What the broker tells the worker about a setup run: the limits the run started with (the project's setting cut down to the company's lock, fixed at start). Nothing else: the repositories and the
 * commit each is read at come from the preparation manifest the broker wrote (the default branch's head as the broker resolved it), never from a field of this payload. The payload's `commits` are only a
 * cross-check the worker holds the manifest to (P1): they can never add or change what the run reads.
 */
export const SetupAgentWireSchema = z.object({
  limits: SetupAgentLimitsSchema,
  /**
   * P1: the commit each repository was prepared at, as the broker recorded it from the prepare's report (`preparedBase`). The worker compares the preparation manifest with this and refuses the run on any
   * difference, a missing repository or a missing list. Optional only so that an older broker's payload still parses (the worker then refuses it); the current broker always sends it when it has it.
   */
  commits: z.array(z.object({ repository: z.string().min(1).max(200), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }).strict()).min(1).max(32).optional(),
}).strict();
export type SetupAgentWire = z.infer<typeof SetupAgentWireSchema>;
