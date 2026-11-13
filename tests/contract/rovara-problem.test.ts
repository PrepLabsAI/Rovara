// TE-B8 (O22): the "Rovara problem" line says what went wrong, what was already tried, and the next step, by what is live today. The table is data (one row per kind) so a later lane flips `liveToday`; every kind has words, a
// next step and a button label; every word a repository, a person or a model wrote goes through the inert-text function; numbers are checked before they are printed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ROVARA_PROBLEM_KINDS, ROVARA_PROBLEM_UNKNOWN, ROVARA_PROBLEM_WORDS, renderEvidence, renderEvidenceRead, readEvidencePack, rovaraProblem, type RovaraProblemFacts,
} from "../../packages/contracts/src/index.js";
import { v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const HEAD = "Held back: Rovara problem, not your code: ";
const facts = (kind: string, more: Partial<RovaraProblemFacts> = {}): RovaraProblemFacts => ({ kind, retries: 1, ...more });

describe("every kind has words, a next step and a button", () => {
  it("covers the eight kinds, in a table with no gaps", () => {
    expect([...ROVARA_PROBLEM_KINDS]).toEqual(["out_of_memory", "round_time_ran_out", "service_did_not_start", "machine_lost", "image_pull_failed", "code_host_unreachable", "model_provider_error", "budget_reached"]);
    for (const kind of [...ROVARA_PROBLEM_KINDS, "unknown" as const]) {
      const row = kind === "unknown" ? ROVARA_PROBLEM_UNKNOWN : ROVARA_PROBLEM_WORDS[kind];
      expect(row, kind).toBeDefined();
      expect(row.cause({}).trim().length, `${kind} cause`).toBeGreaterThan(10);
      for (const part of [row.nextBefore, row.next, row.buttonBefore, row.button]) expect(part.trim().length, `${kind} words`).toBeGreaterThan(2);
      expect(typeof row.liveToday, kind).toBe("boolean");
      expect(Number.isInteger(row.autoRetries) && row.autoRetries >= 0, kind).toBe(true);
    }
  });

  it.each(ROVARA_PROBLEM_KINDS.map((kind) => [kind]))("%s makes a whole line with a cause, what was tried and a next step", (kind) => {
    const out = rovaraProblem(facts(kind));
    expect(out.line.startsWith(HEAD)).toBe(true);
    expect(out.line).toMatch(/ Retried once\. Next: .+\.$/u);
    expect(out.line).not.toMatch(/infrastructure problem/iu);
    expect(out.button.length).toBeGreaterThan(2);
  });
});

describe("golden lines, by what is live today", () => {
  it.each<[string, RovaraProblemFacts, string, string]>([
    ["out_of_memory", facts("out_of_memory", { check: "the full suite", usedGb: 3.1, limitGb: 3 }), `${HEAD}the test machine ran out of memory in the full suite (3.1 of 3 GB). Retried once. Next: ask a maintainer to pick a larger machine.`, "Retry now"],
    ["round_time_ran_out", facts("round_time_ran_out", { check: "the browser round", minutes: 20 }), `${HEAD}the browser round did not finish in the 20-minute limit. Retried once. Next: re-run with a longer round.`, "Retry now"],
    ["service_did_not_start", facts("service_did_not_start", { service: "postgres", step: "health check" }), `${HEAD}postgres did not start (health check). Retried once. Next: ask a maintainer to check the service's setup.`, "Open setup"],
    ["machine_lost", facts("machine_lost", { retries: 0 }), `${HEAD}the test machine stopped responding. Not retried yet. Next: retrying on a new machine.`, "Retry now"],
    ["image_pull_failed", facts("image_pull_failed"), `${HEAD}the setup image could not be fetched. Retried once. Next: try again in a few minutes.`, "Retry now"],
    ["code_host_unreachable", facts("code_host_unreachable"), `${HEAD}the code host did not answer. Retried once. Next: try again in a few minutes.`, "Retry now"],
    ["model_provider_error", facts("model_provider_error", { code: "overloaded_error" }), `${HEAD}the model provider refused or failed (overloaded_error). Retried once. Next: try again in a few minutes.`, "Retry now"],
    ["budget_reached model", facts("budget_reached", { budget: "model", used: 4.8, cap: 5 }), `${HEAD}the task reached its model budget ($4.80 of $5.00). Retried once. Next: ask someone who sets budgets to raise it.`, "Raise budget"],
    ["budget_reached machine", facts("budget_reached", { budget: "machine", used: 120, cap: 120 }), `${HEAD}the task reached its machine budget (120 of 120 machine minutes). Retried once. Next: ask someone who sets budgets to raise it.`, "Raise budget"],
  ])("%s", (_name, input, line, button) => {
    expect(rovaraProblem(input)).toEqual({ line, button });
  });

  it("an unknown kind says 'an unexpected Rovara fault' with its id, and what to do", () => {
    expect(rovaraProblem(facts("tape_jam_7"))).toEqual({ line: `${HEAD}an unexpected Rovara fault (tape_jam_7). Retried once. Next: tell a maintainer, and try again.`, button: "Retry now" });
    for (const kind of [undefined, 42, null, {}, "__proto__", "constructor", "toString"]) expect(rovaraProblem({ kind, retries: 0 }).line).toMatch(/^Held back: Rovara problem, not your code: an unexpected Rovara fault \(/u);
  });

  it("an id that is not a plain word is not printed", () => {
    expect(rovaraProblem(facts("a b\n# c <b>@x")).line).toContain("an unexpected Rovara fault (unknown).");
    expect(rovaraProblem(facts("x".repeat(500))).line).toContain("(unknown).");
  });
});

describe("a row is flipped by its flag alone", () => {
  const flipped = { ...ROVARA_PROBLEM_WORDS, out_of_memory: { ...ROVARA_PROBLEM_WORDS.out_of_memory, liveToday: true } } as typeof ROVARA_PROBLEM_WORDS;
  it("worded as the later step once live, with a time when one is given", () => {
    const at = Date.UTC(2026, 10, 13, 14, 20, 59);
    expect(rovaraProblem(facts("out_of_memory", { check: "the full suite", usedGb: 3.1, limitGb: 3, retries: 0, nextAtMs: at }), flipped).line).toBe(`${HEAD}the test machine ran out of memory in the full suite (3.1 of 3 GB). Not retried yet. Next: retrying once on the next machine size at 14:20 UTC.`);
    expect(rovaraProblem(facts("out_of_memory", { retries: 0 }), flipped).line).toContain("Next: retrying once on the next machine size.");
  });
  it("is never worded as a step that already used up its retries", () => {
    expect(rovaraProblem(facts("out_of_memory", { retries: 1, nextAtMs: 1 }), flipped).line).toMatch(/ Next: it is waiting for you to retry it\.$/u);
    expect(rovaraProblem(facts("machine_lost", { retries: 1, nextAtMs: 1 })).line).toMatch(/ Next: it is waiting for you to retry it\.$/u);
    expect(rovaraProblem(facts("machine_lost", { retries: 2 })).line).toMatch(/ Retried 2 times\. Next: it is waiting for you to retry it\.$/u);
  });
  it("a row that is not live today never promises a retry or a time", () => {
    for (const kind of ROVARA_PROBLEM_KINDS) {
      if (ROVARA_PROBLEM_WORDS[kind].liveToday) continue;
      const line = rovaraProblem(facts(kind, { retries: 0, nextAtMs: Date.UTC(2026, 10, 13, 14, 20) })).line;
      expect(line, kind).not.toMatch(/ at \d\d:\d\d UTC/u);
      expect(line, kind).not.toMatch(/Next: retrying/u);
    }
  });
  it("only a retry that exists today is live today: a lost run", () => {
    expect(ROVARA_PROBLEM_KINDS.filter((kind) => ROVARA_PROBLEM_WORDS[kind].liveToday)).toEqual(["machine_lost"]);
  });
  it("machine_lost says the time only when it is known", () => {
    expect(rovaraProblem(facts("machine_lost", { retries: 0, nextAtMs: Date.UTC(2026, 10, 13, 9, 5) })).line).toBe(`${HEAD}the test machine stopped responding. Not retried yet. Next: retrying on a new machine at 09:05 UTC.`);
  });
});

describe("what was tried", () => {
  it("says so when it is not known, never a number that was not given", () => {
    for (const retries of [undefined, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, "2" as unknown as number]) {
      expect(rovaraProblem({ kind: "image_pull_failed", retries }).line, String(retries)).toContain(" What was tried is not recorded. Next:");
    }
    expect(rovaraProblem({ kind: "image_pull_failed", retries: 0 }).line).toContain(" Not retried yet. Next:");
    expect(rovaraProblem({ kind: "image_pull_failed", retries: 3 }).line).toContain(" Retried 3 times. Next:");
    expect(rovaraProblem({ kind: "image_pull_failed", retries: 5_000 }).line).toContain(" Retried more than 99 times. Next:");
  });
});

describe("numbers are checked before they are printed", () => {
  it.each([Number.NaN, -3, Number.POSITIVE_INFINITY, 1e12, "3" as unknown as number, undefined])("memory %s prints '?'", (value) => {
    expect(rovaraProblem(facts("out_of_memory", { check: "tests", usedGb: value, limitGb: value })).line).toContain("in tests (? of ? GB).");
  });
  it("prints a small number once, with one decimal at most", () => {
    expect(rovaraProblem(facts("out_of_memory", { usedGb: 3.14159, limitGb: 4 })).line).toContain("(3.1 of 4 GB)");
  });
  it.each([Number.NaN, -1, 0.5, 1e9, undefined])("minutes %s prints '?'", (value) => {
    expect(rovaraProblem(facts("round_time_ran_out", { check: "a", minutes: value })).line).toContain("did not finish in the ?-minute limit");
  });
  it("budget numbers past their bounds print '?'", () => {
    expect(rovaraProblem(facts("budget_reached", { budget: "model", used: -2, cap: 1e12 })).line).toContain("model budget ($? of $?)");
    expect(rovaraProblem(facts("budget_reached", { budget: "machine", used: Number.NaN })).line).toContain("machine budget (? of ? machine minutes)");
  });
  it("a bad time is left out", () => {
    for (const nextAtMs of [Number.NaN, -1, 1e20, Number.POSITIVE_INFINITY, "x" as unknown as number]) expect(rovaraProblem(facts("machine_lost", { retries: 0, nextAtMs })).line, String(nextAtMs)).toMatch(/Next: retrying on a new machine\.$/u);
  });
  it("a budget of no known kind is the task's budget", () => {
    expect(rovaraProblem(facts("budget_reached", { budget: "oops", used: 1, cap: 2 })).line).toContain("the task reached its budget (1 of 2).");
  });
});

describe("words from a repository, a person or a model are inert", () => {
  const hostile = "![x](http://evil.example/p.png) [a](http://evil.example) @octocat Fixes #12 ENG-42 <img src=x onerror=1> `tick`\n# heading";
  it("the check, the service, the step and the code never carry a link, image, mention, issue or HTML", () => {
    const lines = [
      rovaraProblem(facts("out_of_memory", { check: hostile })).line,
      rovaraProblem(facts("round_time_ran_out", { check: hostile, minutes: 5 })).line,
      rovaraProblem(facts("service_did_not_start", { service: hostile, step: hostile })).line,
      rovaraProblem(facts("model_provider_error", { code: hostile })).line,
    ];
    for (const text of lines) {
      expect(text).not.toMatch(/\]\(|!\[|<img|<[a-z]|\n/iu);
      expect(text).not.toMatch(/(^|[^\u200D])@octocat/u);
      expect(text).not.toMatch(/(^|[^\u200D])#12/u);
      expect(text).not.toMatch(/ENG-42/u);
      expect(text.startsWith(HEAD)).toBe(true);
    }
  });
  it("a name is escaped once, not twice", () => {
    expect(rovaraProblem(facts("service_did_not_start", { service: "a&b", step: "c" })).line).toContain("a&amp;b did not start (c)");
  });
  it("hidden and variation-selector characters are gone", () => {
    const line = rovaraProblem(facts("service_did_not_start", { service: `db\u202E\u200B\uFE0F\u{E0100}x`, step: "s" })).line;
    for (const hidden of ["\u202E", "\u200B", "\uFE0F", "\u{E0100}"]) expect(line).not.toContain(hidden);
    expect(line).toContain("did not start (s)");
  });
  it("a 1 MB input is cheap and the line stays within its bound", () => {
    const started = Date.now();
    const line = rovaraProblem(facts("out_of_memory", { check: "a ".repeat(500_000) })).line;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Array.from(line).length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/Next: .+\.$/u);
  });
  it("a blank name falls back to a plain word", () => {
    expect(rovaraProblem(facts("out_of_memory", { check: "  \u200B " })).line).toContain("memory in a check (");
    expect(rovaraProblem(facts("service_did_not_start", { service: "" })).line).toContain("a service did not start.");
  });
});

describe("the renderer prints it", () => {
  it("in the full and the compact form, after the flags, and gives the button label apart from the text", () => {
    const input = facts("out_of_memory", { check: "the full suite", usedGb: 3.1, limitGb: 3 });
    const full = renderEvidence(v2Pack(), { rovaraProblem: input });
    expect(full.body[1]).toBe(rovaraProblem(input).line);
    expect(full.rovaraProblemButton).toBe("Retry now");
    expect(full.text).not.toContain("[");
    const compact = renderEvidence(v2Pack(), { rovaraProblem: input, compact: true });
    expect(compact.body[1]).toBe(rovaraProblem(input).line);
    expect(compact.rovaraProblemButton).toBe("Retry now");
  });
  it("makes each piece inert once in the rendered text too (an & is escaped once)", () => {
    const text = renderEvidence(v2Pack(), { rovaraProblem: facts("service_did_not_start", { service: "a&b", step: "c" }) }).text;
    expect(text).toContain("a&amp;b did not start (c)");
    expect(text).not.toContain("&amp;amp;");
  });
  it("prints nothing, and no button, when no problem is given; a loose line still works", () => {
    const plain = renderEvidence(v2Pack());
    expect(plain.text).not.toContain("Rovara problem");
    expect("rovaraProblemButton" in plain).toBe(false);
    expect(renderEvidence(v2Pack(), { rovaraProblemLine: "Held back: Rovara problem, not your code" }).body[1]).toBe("Held back: Rovara problem, not your code");
  });
  it("the structured problem wins over a loose line", () => {
    expect(renderEvidence(v2Pack(), { rovaraProblem: facts("machine_lost", { retries: 0 }), rovaraProblemLine: "something else" }).text).not.toContain("something else");
  });
  it("old packs still render without the line", () => {
    const read = readEvidencePack(JSON.parse(JSON.stringify(v1Pack())));
    expect(renderEvidenceRead(read).text).toBe("Evidence from an older Rovara, open in Rovara for the level");
    expect(renderEvidenceRead({ status: "v2", pack: v2Pack(), newer: { unknownParts: [], unknownKinds: [], unknownValues: false, unreadableChecks: 0 } } as never, { rovaraProblem: facts("machine_lost", { retries: 0 }) }).body.some((entry) => entry.startsWith(HEAD))).toBe(true);
  });
});

describe("callers", () => {
  it("only contracts uses the table yet: the classifier wiring waits for the pin (7a)", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const found = spawnSync("git", ["grep", "--untracked", "-lwE", "-e", "rovaraProblem", "-e", "ROVARA_PROBLEM_WORDS", "-e", "ROVARA_PROBLEM_KINDS", "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root });
    expect([0, 1]).toContain(found.status);
    expect(found.stdout.split("\n").filter((entry) => entry !== "" && !entry.startsWith("packages/contracts/"))).toEqual([]);
  });
});
