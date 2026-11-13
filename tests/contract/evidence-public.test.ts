/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the test edits packs whose shape it breaks on purpose, the way a hostile or newer writer would */
// TE-B12 (O53): the public, redacted summary of an evidence pack. An ALLOW-LIST: counts, flags and fixed words only. Planted secrets and personal data never appear; a field or part a later writer adds is dropped;
// the not-sealed and trust words stay honest; free text, links, images, mentions, issue references, HTML and line-start markdown stay inert; a huge pack renders fast and bounded. Every planted secret is built at run time.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ISOLATIONS, EVIDENCE_LEVELS, EVIDENCE_RESULTS, EVIDENCE_TRUST_CLASSES, NEWER_EVIDENCE_WORDS, PUBLIC_CHANGE_TYPE_WORDS, PUBLIC_DETAILS_WORDS, PUBLIC_NOT_SEALED_WORDS, PUBLIC_WEAKEST_WORDS,
  isPublicDetailsUrl, publicEvidenceView, readEvidencePack, readEvidencePackText, renderEvidence, renderEvidencePublic, type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ZWJ = "‍";

// ---- the planted values, all built at run time (the public repo refuses key-shaped literals)
const rand = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pieces = (...parts: string[]) => parts.join("");
const CANARIES = {
  email: pieces("jane.doe", "@", "customer-corp", ".example"),
  token: pieces("gh", "p_", "Q".repeat(6), "z".repeat(6), "7".repeat(24)),
  customerInTestName: pieces("tests/billing.py::test_refund_for_", "Initech", "Holdings"),
  url: pieces("https", "://", "internal-admin.", "customer-corp.example", "/reports/q4?token=", "abc123"),
  pathOutsideDiff: pieces("/home/", "deploy", "/secrets/", "prod-config.yaml"),
  screenshot: pieces("screens/", "checkout-", "page-before", ".jpg"),
  endpoint: pieces("POST /v1/", "internal-orders", "/refund"),
  outputTail: pieces("Traceback: connection refused to ", "db-primary", ".corp.example"),
  command: pieces("pytest -q --customer=", "Initech"),
  label: pieces("Run ", "Initech", " billing suite"),
  dependency: pieces("payments-", "ledger", "-service"),
  actor: pieces("user_", "9f31c2", "_jdoe"),
  reason: pieces("Approved by ", "VP-Finance", " for the launch"),
  measure: pieces("p95 of ", "checkout-api"),
  notTested: pieces("refund flow for ", "Initech", " tier-1 accounts"),
  weakest: pieces("41 tests used ", "Initech", " recordings"),
  flagPath: pieces("src/", "billing/", "CLAUDE.md"),
  unknownPart: pieces("hologram-", "payload-", "7731"),
  unknownKind: pieces("zk_", "custom", "_kind"),
  mockLink: pieces("/v1/app/", "mocks/", "ledger-set"),
  branch: pieces("feature/", "initech-", "refund"),
};
const CANARY_VALUES = Object.values(CANARIES);
const leaks = (text: string): string[] => CANARY_VALUES.filter((value) => text.includes(value));

/** A rich pack that carries every canary in a place a writer or a repository could put it. */
function plantedPack(): EvidencePackV2 {
  const base = clone(v2Pack());
  const artifact = (kind: "jpeg" | "log_txt", seed: string) => ({ kind, sha256: seed.repeat(64).slice(0, 64), bytes: 100, retentionClass: "evidence-std" });
  const pack = {
    ...base,
    level: { reached: "rovara_real_run", required: ["sealed"], weakest: { stageId: "sealed", words: CANARIES.weakest } },
    checks: [
      {
        id: "unit", kind: "test", label: CANARIES.label, command: CANARIES.command, stage: "sealed", before: "failed", after: "passed", class: "fixed", runBy: "rovara", durationMs: 4_000, exitCode: 0, attribution: "per_test",
        tests: { total: 120, passed: 118, failed: 1, skipped: 0, errored: 1, names: [{ name: CANARIES.customerInTestName, status: "failed" }, { name: "tests/a.py::one", status: "passed" }], newTests: [CANARIES.customerInTestName, "tests/a.py::two"] },
        coverage: { linesChanged: 40, linesCovered: 30, files: [{ path: CANARIES.pathOutsideDiff, uncovered: [4, 5] }] },
        outputTailRef: artifact("log_txt", "a"),
        trust: "simulated",
      },
      {
        id: "visual", kind: "visual", label: CANARIES.screenshot, stage: "confirm", before: "passed", after: "failed", class: "regression", runBy: "rovara", durationMs: 9_000,
        pairs: [{ id: CANARIES.screenshot, before: artifact("jpeg", "b"), after: artifact("jpeg", "c") }],
      },
      {
        id: "bench", kind: "benchmark", label: "render time", stage: "confirm", before: "passed", after: "passed", class: "passing", runBy: "rovara", durationMs: 9_000,
        measures: [{ name: CANARIES.measure, unit: "ms", base: 120, head: 118, direction: "down_good" }],
      },
    ],
    proof: { verdicts: [{ checkId: "unit", testId: CANARIES.customerInTestName, verdict: "proves_change" }], provenCount: 4, loadFailureOnOld: 1, heldDraft: true, override: { actorId: CANARIES.actor, at: "2026-11-12T10:00:00.000Z", reason: CANARIES.reason } },
    weakening: { removedTests: [CANARIES.customerInTestName], absentOnNew: [CANARIES.customerInTestName, "tests/b.py::gone"], absentOnNewCount: 7, changedTestConfig: [CANARIES.pathOutsideDiff], changedSnapshots: [CANARIES.flagPath, "a.snap"], changedFixtures: [], skipRise: { before: 1, after: 4 } },
    flags: { instructionFiles: [CANARIES.flagPath], ciExecutedFiles: [CANARIES.pathOutsideDiff, "Makefile"] },
    dependencies: [
      { name: CANARIES.dependency, kind: "http", backing: "fake", label: "recorded_fake", trust: "recorded", recordedOn: "2026-11-12", protocol: CANARIES.endpoint, spec: CANARIES.url, mock: { setId: CANARIES.mockLink, version: 1, branch: CANARIES.branch, madeIn: "this_task", store: "rovara", link: CANARIES.mockLink } },
      { name: "postgres", kind: "database", backing: "local", label: "real", trust: "real" },
    ],
    meters: { modelUsd: 12.34, machineMinutes: 99, machineUsd: 5.67, caps: { modelUsd: 50, machineMinutes: 100 } },
    notTested: [{ what: CANARIES.notTested, reason: CANARIES.email }, { what: "other", reason: CANARIES.token }],
    environment: { tier: "sandbox", envRevision: 3, services: [{ name: CANARIES.dependency, mode: "mocked", recordedAt: "2026-11-12T10:00:00.000Z" }], data: "synthetic", accounts: [] },
    api: [{ scenarioId: CANARIES.endpoint, samples: [{ method: "POST", path: CANARIES.endpoint, status: 200, requestSample: CANARIES.email, responseSample: CANARIES.token }], diff: "none", changedPaths: [CANARIES.pathOutsideDiff] }],
    browser: [],
  };
  return pack as unknown as EvidencePackV2;
}
const planted = () => plantedPack();

describe("the redaction fixture: nothing planted reaches the public output", () => {
  it("positive control: the fixture is read as a pack, and the FULL renderer keeps what it keeps today", () => {
    const full = renderEvidence(planted()).text;
    // These are what the full mode prints today; if it stopped, this test would no longer prove the public mode removes them.
    expect(full).toContain(inertLabel(CANARIES.label));
    expect(full).toContain(inertLabel(CANARIES.dependency));
    expect(full).toContain(inertLabel(CANARIES.weakest));
    expect(full).toContain(inertLabel(CANARIES.reason));
    expect(full).toContain(inertLabel(CANARIES.actor));
    expect(full).toContain("refund flow for Initech");
    expect(full).toContain("$12.34");
    expect(full).toContain("Initech");
  });

  it("prints none of the planted values, in the text or in the view", () => {
    const out = renderEvidencePublic(planted(), { detailsUrl: "https://app.example.test/tasks/t1" });
    expect(leaks(out.text)).toEqual([]);
    expect(leaks(JSON.stringify(publicEvidenceView(planted())))).toEqual([]);
    // also no name, address, amount or file name in any other form
    for (const word of ["Initech", "initech", "customer-corp", "ledger", "jdoe", "VP-Finance", "12.34", "99 machine", ".jpg", ".yaml", "CLAUDE.md", "Makefile", "tests/", "src/", "POST", "Traceback"]) expect(out.text, word).not.toContain(word);
  });

  it("prints none of them either when the pack is read tolerantly with newer parts and an unknown kind added", () => {
    const raw = { ...clone(planted()), [CANARIES.unknownPart]: { secret: CANARIES.email }, hologram: CANARIES.token } as Record<string, unknown>;
    (raw.checks as Record<string, unknown>[]).push({ id: "z", kind: CANARIES.unknownKind, label: CANARIES.label, before: "passed", after: "passed", class: "passing", durationMs: 1, extra: CANARIES.token });
    const read = readEvidencePack(raw);
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    const out = renderEvidencePublic(read.pack, { newer: read.newer });
    expect(leaks(out.text)).toEqual([]);
    expect(out.body).toContain(NEWER_EVIDENCE_WORDS);
    // the full mode still shows the label of the unknown check, so this is a real difference
    expect(renderEvidence(read.pack, { newer: read.newer }).text).toContain("Initech");
  });

  it("the view holds no free text: every string in it is a fixed word, a table member or a date", () => {
    const allowed = new Set<string>([...EVIDENCE_RESULTS, ...EVIDENCE_LEVELS, ...EVIDENCE_ISOLATIONS, ...EVIDENCE_TRUST_CLASSES, "newer", "ci_none", "ci_unreadable", "other", "2026-11-12"]);
    const strings: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") strings.push(`${path}=${value}`);
      else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      else if (typeof value === "object" && value !== null) for (const [key, entry] of Object.entries(value)) { expect(["result", "reached", "isolation", "scripted", "weakest", "checks", "dependencies", "proof", "weakening", "notTested", "newer", "total", "byOutcome", "tests", "coverage", "byTrust", "oldestRecordedOn", "failed", "added", "linesChanged", "linesCovered", "proven", "loadFailureOnOld", "heldDraft", "markedReadyAnyway", "instructionFiles", "ciExecutedFiles", "absentOnNew", "skipRise", "removedTests", "changedTestConfig", "changedSnapshots", "changedFixtures", ...["passed", "timed_out", "unknown", "not_run"], ...EVIDENCE_TRUST_CLASSES, "newer"]).toContain(key); walk(entry, `${path}.${key}`); }
    };
    walk(publicEvidenceView(planted()), "view");
    for (const entry of strings) expect(allowed.has(entry.slice(entry.indexOf("=") + 1)), entry).toBe(true);
    expect(strings.length).toBeGreaterThan(4);
  });
});
const inertLabel = (value: string) => value.replace("@", `@${ZWJ}`).replace("://", `://${ZWJ}`);

describe("what it prints", () => {
  it("is this golden for the planted pack", () => {
    const out = renderEvidencePublic(planted(), { changeType: "bug_fix", detailsUrl: "https://app.example.test/tasks/t1" });
    expect(out.firstLine).toBe("Verified · Real run by Rovara · weakest stage: open in Rovara");
    expect(out.body).toEqual([
      "Checked in a sealed round",
      "Change type: Bug fix",
      "1 Rovara instruction file changed (a flag, not an approval)",
      "2 files that CI runs changed (a flag, not an approval)",
      "Checks: 3 (2 passed, 1 failed)",
      "Tests: 120 tests run, 2 failed, 2 new",
      "75% of changed lines covered",
      "Checks by trust: Simulated 1",
      "Change proof: 4 proven, 1 could not load on the old code",
      "Held as a draft until the change is proven",
      "Marked ready anyway by a person",
      "Tests may be weaker:",
      "- 7 tests ran before and not now",
      "- 3 more tests skipped than before",
      "- 1 test removed",
      "- 1 test config file changed",
      "- 2 snapshot files changed",
      "Dependencies: 2 (Real 1 · Recorded 1 (oldest recorded 12 Nov))",
      "Not tested: 2 items (the list is in Rovara)",
      `${PUBLIC_DETAILS_WORDS}: [Open in Rovara](https://app.example.test/tasks/t1)`,
    ]);
  });

  it("the plain pack: first line, producer, checks, trust and the pointer, and no 'None' or empty sections", () => {
    const out = renderEvidencePublic(v2Pack());
    expect(out.text).toBe([
      "Verified · Real run by Rovara",
      "Checked in a sealed round",
      "Checks: 2 (2 passed)",
      "Tests: 3 tests run, 0 failed, 1 new",
      "90% of changed lines covered",
      "Change proof: 1 proven",
      "Dependencies: 2 (Real 1 · Recorded 1 (oldest recorded 12 Nov))",
      "Not tested: 1 item (the list is in Rovara)",
      `${PUBLIC_DETAILS_WORDS}: open in Rovara`,
    ].join("\n"));
  });

  it("names the change type only from the fixed list", () => {
    for (const [type, words] of Object.entries(PUBLIC_CHANGE_TYPE_WORDS)) expect(renderEvidencePublic(v2Pack(), { changeType: type }).body).toContain(`Change type: ${words}`);
    for (const bad of [CANARIES.email, "Bug fix", "__proto__", "constructor", "toString", "", "feature "]) expect(renderEvidencePublic(v2Pack(), { changeType: bad }).text, bad).not.toContain("Change type");
  });

  it("prints the two fixed weakest-stage phrases word for word, and only says there is another stage for any other words", () => {
    const withWeakest = (words: string) => renderEvidencePublic(v2Pack({ level: { reached: "rovara_real_run", required: [], weakest: { stageId: "ci", words } } })).firstLine;
    expect(withWeakest(PUBLIC_WEAKEST_WORDS[0]!)).toBe("Verified · Real run by Rovara · weakest: No CI on this repository");
    expect(withWeakest(PUBLIC_WEAKEST_WORDS[1]!)).toBe("Verified · Real run by Rovara · weakest: CI not readable");
    expect(withWeakest("No CI on this repository, see Initech")).toBe("Verified · Real run by Rovara · weakest stage: open in Rovara");
  });

  it("counts a v2 pack's checks as 'not checked' or 'newer evidence' the way the full renderer does", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), checks: [{ id: "a", kind: "test", label: "x", before: "passed", after: "unknown", class: "passing", durationMs: 1 }, { id: "b", kind: "test", label: "y", before: "passed", after: "quantum", class: "passing", durationMs: 1 }] });
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    const out = renderEvidencePublic(read.pack, { newer: read.newer });
    expect(out.body).toContain("Checks: 2 (1 not checked, 1 newer evidence, open in rovara)");
    expect(out.body).toContain(NEWER_EVIDENCE_WORDS);
  });
});

describe("an allow-list, not a deny-list: what a newer writer adds is dropped", () => {
  it("drops an unknown part and an unknown field on a check or a dependency, and says only that there is newer evidence", () => {
    const base = renderEvidencePublic(plantedPack());
    const raw = clone(plantedPack()) as unknown as Record<string, unknown>;
    raw.holograms = [{ note: CANARIES.email }];
    raw.futureSection = { summary: CANARIES.token };
    (raw.checks as Record<string, unknown>[])[0]!.secretField = CANARIES.url;
    (raw.dependencies as Record<string, unknown>[])[0]!.owner = CANARIES.actor;
    const read = readEvidencePack(raw);
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    const out = renderEvidencePublic(read.pack, { newer: read.newer });
    expect(leaks(out.text)).toEqual([]);
    expect(out.body).toEqual([...base.body.slice(0, -1), NEWER_EVIDENCE_WORDS, base.body.at(-1)]);
  });

  it("is not changed by a field that is added to a pack object directly, whatever its name", () => {
    const pack = clone(plantedPack()) as unknown as Record<string, unknown>;
    const before = renderEvidencePublic(pack as unknown as EvidencePackV2).text;
    for (const key of ["label", "command", "name", "what", "reason", "actorId", "words", "branch", "samples", "summary", "customerName"]) pack[key] = CANARIES.email;
    (pack.checks as Record<string, unknown>[]).forEach((check) => { check.summary = CANARIES.token; check.notes = [CANARIES.url]; });
    expect(renderEvidencePublic(pack as unknown as EvidencePackV2).text).toBe(before);
  });
});

describe("never 'sealed' or 'Real' when it is not true", () => {
  const pack = (reached: string, isolation: string, extra: Record<string, unknown> = {}) => v2Pack({ level: { reached, required: [] }, producer: { edition: "cloud", isolation }, ...extra });
  it("says 'not sealed' in the first line and gives the fixed residual line for a sandbox run", () => {
    const out = renderEvidencePublic(pack("sandbox_only", "sandbox"));
    expect(out.firstLine.endsWith("not sealed")).toBe(true);
    expect(out.body).toContain("Checked in the agent's sandbox (not sealed)");
    expect(out.body).toContain(PUBLIC_NOT_SEALED_WORDS);
    const real = renderEvidencePublic(pack("rovara_real_run", "sandbox"));
    expect(real.firstLine).toBe("Verified · Run by Rovara, not sealed");
    expect(real.text).not.toMatch(/real run/iu);
    expect(real.body).toContain(PUBLIC_NOT_SEALED_WORDS);
  });

  it("a sealed round gets neither", () => {
    const out = renderEvidencePublic(pack("rovara_real_run", "sealed"));
    expect(out.text).not.toContain("not sealed");
    expect(out.text).not.toContain(PUBLIC_NOT_SEALED_WORDS);
  });

  it("scripted AI replies are never 'Real', in the first line, the proof line or the trust words", () => {
    const scripted = clone(v2Pack());
    scripted.checks[0] = { ...scripted.checks[0]!, proofBasis: "scripted_ai_replies", trust: "simulated" };
    const out = renderEvidencePublic({ ...scripted, level: { reached: "rovara_real_run", required: [] } });
    expect(out.firstLine).toBe("Verified · Run against scripted AI replies");
    expect(out.body).toContain("Change proof: 1 proven with scripted AI replies");
    expect(out.body).toContain("Checks by trust: 1 check proven with scripted AI replies");
    // "Real" is a trust class of a dependency here; nothing about the scripted proof says it
    expect(out.firstLine).not.toMatch(/real/iu);
    expect(out.body.filter((entry) => !entry.startsWith("Dependencies:")).join("\n")).not.toMatch(/\bReal\b/u);
    // a stored pack that wrongly marks such a check Real still says scripted
    const wrong = { ...scripted, checks: [{ ...scripted.checks[0], trust: "real" }] } as unknown as EvidencePackV2;
    expect(renderEvidencePublic(wrong).body).toContain("Checks by trust: 1 check proven with scripted AI replies");
  });

  it("a laptop or an imported result is never worded as a Rovara run or a sealed round", () => {
    for (const isolation of ["developer_machine", "imported", "teleport"]) {
      const read = readEvidencePack({ ...clone(pack("rovara_real_run", "sealed")), producer: { edition: "code", isolation } });
      expect(read.status).toBe("v2");
      if (read.status !== "v2") continue;
      const out = renderEvidencePublic(read.pack, { newer: read.newer });
      expect(out.text, isolation).not.toMatch(/sealed round|Run by Rovara|Real run/u);
    }
  });

  it("property: whatever the pack says, 'sealed round' and 'Real run' appear only for a sealed producer (and Real run never with scripted replies)", () => {
    const next = rand(11);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    for (let index = 0; index < 400; index += 1) {
      const isolation = pick([...EVIDENCE_ISOLATIONS, "teleport"]);
      const scripted = next() < 0.3;
      const raw = clone(v2Pack({ level: { reached: pick([...EVIDENCE_LEVELS, "quantum"]), required: [] }, producer: { edition: "cloud", isolation: "sealed" }, result: pick([...EVIDENCE_RESULTS, "mystery"]) })) as unknown as Record<string, unknown>;
      raw.producer = { edition: "cloud", isolation };
      if (scripted) (raw.checks as Record<string, unknown>[])[0]!.proofBasis = "scripted_ai_replies";
      const read = readEvidencePack(raw);
      if (read.status !== "v2") continue;
      const out = renderEvidencePublic(read.pack, { newer: read.newer }).text;
      if (isolation !== "sealed") expect(out, `${isolation} ${JSON.stringify(raw.level)}`).not.toMatch(/sealed round|Real run by Rovara/u);
      if (scripted) expect(out).not.toContain("Real run by Rovara");
      if (isolation === "sandbox") expect(out).toContain(PUBLIC_NOT_SEALED_WORDS);
    }
  });
});

describe("property: random packs never leak a marked canary", () => {
  const MARK = "CANARY";
  /** Every string in the pack (a value or a key) becomes a marked canary in some runs; other runs keep the enum words and canary only the free text. Random extra keys, wrong types and hostile numbers are added. */
  function mutate(value: unknown, next: () => number, all: boolean, depth = 0): unknown {
    if (typeof value === "string") return all || next() < 0.5 ? `${MARK}_${String(Math.floor(next() * 1e9))}@x.example https://x.example/${MARK} [a](${MARK}) ![i](${MARK}) # ${MARK}` : value;
    if (Array.isArray(value)) {
      const out = value.map((entry) => mutate(entry, next, all, depth + 1));
      if (next() < 0.3) out.push(`${MARK}_extra`, { [`${MARK}_k`]: `${MARK}_v` }, null, 7, NaN);
      return out;
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(value)) out[all && next() < 0.2 ? `${MARK}_${key}` : key] = mutate(entry, next, all, depth + 1);
      if (depth < 4 && next() < 0.5) out[`${MARK}_field`] = `${MARK}_value`;
      if (next() < 0.1) Object.defineProperty(out, "__proto__", { value: { [MARK]: MARK }, enumerable: true, configurable: true, writable: true });
      return out;
    }
    if (typeof value === "number" && next() < 0.2) return pickBad(next);
    if (typeof value === "boolean" && next() < 0.2) return MARK;
    return value;
  }
  const pickBad = (next: () => number): unknown => [Number.NaN, Number.POSITIVE_INFINITY, -5, 1.5, 1e300, MARK, null, {}, []][Math.floor(next() * 9)];

  it("300 random packs: no canary, no marked key, every line within the limit, and the output is stable", () => {
    const next = rand(20_261_113);
    for (let index = 0; index < 300; index += 1) {
      const raw = mutate(clone(plantedPack()), next, index % 2 === 0);
      const view = (() => { try { return publicEvidenceView(raw as EvidencePackV2); } catch (error) { throw new Error(`view threw on run ${String(index)}`, { cause: error }); } })();
      const out = renderEvidencePublic(raw as EvidencePackV2, { changeType: next() < 0.5 ? MARK : "refactor", detailsUrl: next() < 0.5 ? `https://x.example/${MARK}?t=${MARK}` : undefined });
      expect(out.text, `run ${String(index)}`).not.toContain(MARK);
      expect(JSON.stringify(view)).not.toContain(MARK);
      expect(renderEvidencePublic(raw as EvidencePackV2, { changeType: "refactor" }).text).toBe(renderEvidencePublic(raw as EvidencePackV2, { changeType: "refactor" }).text);
      for (const line of out.text.split("\n")) expect(Array.from(line).length).toBeLessThanOrEqual(300);
      expect(out.text).not.toMatch(/NaN|Infinity|undefined|\[object/u);
    }
  });

  it("random packs through the tolerant reader (random unknown keys at random depths) are the same", () => {
    const next = rand(7);
    let rendered = 0;
    for (let index = 0; index < 150; index += 1) {
      const raw = mutate(clone(plantedPack()), next, false) as Record<string, unknown>;
      // keep the core strictly readable so the reader gives a pack; the rest is what the tolerant reader keeps or drops
      raw.schemaVersion = 2;
      raw.candidate = clone(v2Pack().candidate);
      raw.producer = { edition: "cloud", isolation: EVIDENCE_ISOLATIONS[index % 4] };
      raw.level = { reached: EVIDENCE_LEVELS[index % 5], required: [] };
      raw.result = EVIDENCE_RESULTS[index % 4];
      const read = readEvidencePack(raw);
      if (read.status !== "v2") continue;
      expect(renderEvidencePublic(read.pack, { newer: read.newer }).text, `run ${String(index)}`).not.toContain(MARK);
      rendered += 1;
    }
    // not vacuous: most random packs were readable and rendered
    expect(rendered).toBeGreaterThan(100);
  });
});

describe("free text stays inert (and is not printed at all)", () => {
  it("links, images, mentions, issue references, HTML and line-start markdown in every free field give no markup in the output", () => {
    const nasty = ["[click](https://evil.example/x)", "![img](https://evil.example/p.png)", "![a[b]c](https://evil.example)", "[ref][1]\n\n[1]: https://evil.example", "@octocat @here", "Fixes #123 closes ENG-42", "<script>alert(1)</script><img src=x onerror=alert(1)>", "# heading", "> quote", "---", "```\ncode\n```", "~~~", "1. item", "www.evil.example", "\u202Ehidden\uFE0F\u200B"];
    const pack = clone(plantedPack()) as unknown as Record<string, any>;
    pack.checks.forEach((check: Record<string, any>, index: number) => { check.label = nasty[index % nasty.length]; if (check.tests !== undefined) check.tests.names = nasty.map((name) => ({ name, status: "passed" })); });
    pack.notTested = nasty.map((what) => ({ what, reason: what }));
    pack.level.weakest.words = nasty.join(" ");
    pack.dependencies[0].name = nasty[0];
    const out = renderEvidencePublic(pack as unknown as EvidencePackV2, { detailsUrl: "https://app.example.test/tasks/t1" });
    const withoutLink = out.text.replace("[Open in Rovara](https://app.example.test/tasks/t1)", "");
    expect(withoutLink).not.toMatch(/evil|octocat|#123|ENG-42|<|>|!\[|\]\(|\[|^#|^>|^---|^```|^~~~|www\.|@/mu);
    expect(out.text.includes("\u202E") || out.text.includes("\uFE0F") || out.text.includes("\u200B")).toBe(false);
  });

  it("every line it prints is already what the shared inert function would give it (the words are fixed), except the one sign-in link", () => {
    const out = renderEvidencePublic(plantedPack(), { detailsUrl: "https://app.example.test/tasks/t1" });
    for (const line of out.text.split("\n")) {
      if (line.includes("](")) continue;
      const content = line.startsWith("- ") ? line.slice(2) : line;
      expect(content.startsWith(ZWJ), line).toBe(false);
      expect(content).not.toMatch(/[<>[\]@&]|:\/\//u);
    }
  });

  it("the sign-in link is used only when it is a plain https address", () => {
    expect(isPublicDetailsUrl("https://app.example.test/tasks/t1")).toBe(true);
    expect(isPublicDetailsUrl("https://app.example.test:8443/a/b_c-d.e~f")).toBe(true);
    for (const bad of ["http://app.example.test/x", "javascript:alert(1)", "//app.example.test/x", "https://user:pass@app.example.test/x", "https://app.example.test/x?sig=abc", "https://app.example.test/x#frag", "https://app.example.test/x)[y](z", "https://app.example.test/x y", "https://app.example.test/<x>", "https://app.example.test/x\nHello", "https://", `https://app.example.test/${"a".repeat(400)}`, "data:text/html,x", 5, undefined, null]) {
      expect(isPublicDetailsUrl(bad), String(bad)).toBe(false);
      expect(renderEvidencePublic(v2Pack(), { detailsUrl: bad as string }).body.at(-1)).toBe(`${PUBLIC_DETAILS_WORDS}: open in Rovara`);
    }
  });
});

describe("bounded and fast", () => {
  it("a pack of about 1 MB (thousands of checks with long labels, thousands of notes) renders at once, in a few lines", () => {
    const pack = clone(plantedPack()) as unknown as Record<string, any>;
    const long = "L".repeat(200);
    pack.checks = Array.from({ length: 4_000 }, (_, index) => ({ id: `c${String(index)}`, kind: "test", label: long, before: "passed", after: index % 3 === 0 ? "failed" : "passed", class: "passing", durationMs: 1, tests: { total: 5, passed: 5, failed: 0, skipped: 0, errored: 0, names: [{ name: long, status: "passed" }], newTests: [long] } }));
    pack.notTested = Array.from({ length: 2_000 }, () => ({ what: long, reason: long }));
    pack.weakening.absentOnNew = Array.from({ length: 2_000 }, () => long);
    expect(JSON.stringify(pack).length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const out = renderEvidencePublic(pack as unknown as EvidencePackV2);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.text.length).toBeLessThan(3_000);
    expect(out.body.length).toBeLessThan(30);
    expect(out.text).toContain("Checks: 4,000 (");
    expect(out.text).not.toContain(long);
  });

  it("a 3.5 MB stored pack read as text is rendered at once too", () => {
    const pack = clone(v2Pack()) as unknown as Record<string, any>;
    pack.notTested = Array.from({ length: 200 }, () => ({ what: "w".repeat(300), reason: "r".repeat(100) }));
    pack.dependencies = Array.from({ length: 3_000 }, (_, index) => ({ name: `dep${String(index)}`.padEnd(80, "x"), kind: "http", backing: "fake", label: "real", trust: "real" }));
    const textOf = JSON.stringify(pack);
    expect(textOf.length).toBeGreaterThan(300_000);
    const started = performance.now();
    const read = readEvidencePackText(textOf);
    const out = read.status === "v2" ? renderEvidencePublic(read.pack, { newer: read.newer }) : undefined;
    expect(out).toBeDefined();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(out!.text.length).toBeLessThan(3_000);
  });

  it("garbage counts print as zero or a fixed word, never NaN, and never throw", () => {
    const pack = clone(v2Pack()) as unknown as Record<string, any>;
    pack.checks[0].tests = { total: "many", failed: -3, errored: Number.NaN, newTests: "x" };
    pack.checks[0].coverage = { linesChanged: Number.POSITIVE_INFINITY, linesCovered: "x" };
    pack.proof = { provenCount: null, loadFailureOnOld: {}, heldDraft: "yes" };
    pack.notTested = "none";
    pack.dependencies = [null, 3, "x", { trust: ["real"] }];
    pack.checks.push(null, 7);
    const out = renderEvidencePublic(pack as unknown as EvidencePackV2);
    expect(out.text).not.toMatch(/NaN|Infinity|undefined|null|\[object/u);
  });
});

describe("callers", () => {
  it("nothing outside the contracts package and the tests calls the public renderer yet", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const found = spawnSync("git", ["grep", "--untracked", "-lwE", "renderEvidencePublic|renderPublicView|publicEvidenceView", "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root });
    expect([0, 1]).toContain(found.status);
    expect(found.stdout.split("\n").filter((entry) => entry !== "" && !entry.startsWith("packages/contracts/"))).toEqual([]);
  });
});
