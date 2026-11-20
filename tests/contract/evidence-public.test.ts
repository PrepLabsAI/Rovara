/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- the test edits packs whose shape it breaks on purpose, the way a hostile or newer writer would */
// TE-B12 (O53): the public, redacted summary of an evidence pack. An ALLOW-LIST: counts, flags and fixed words only. Planted secrets and personal data never appear; a field or part a later writer adds is dropped;
// the not-sealed and trust words stay honest; free text, links, images, mentions, issue references, HTML and line-start markdown stay inert; a huge pack renders fast and bounded. Every planted secret is built at run time.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVIDENCE_ISOLATIONS, EVIDENCE_LEVELS, EVIDENCE_RESULTS, NEWER_EVIDENCE_WORDS, PUBLIC_CHANGE_TYPE_WORDS, PUBLIC_DETAILS_WORDS, PUBLIC_NOT_SEALED_WORDS, PUBLIC_WEAKEST_WORDS, PUBLIC_RENDER_LIMITS, publicDetailsUrl, publicEvidenceView, readEvidencePack, readEvidencePackText, renderEvidence, renderEvidencePublic, type EvidencePackV2 } from "../../packages/contracts/src/index.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
import { expectLinearScaling } from "../support/scaling.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const DETAILS = { origin: "https://app.example.test", taskId: "tsk_8fK2mQ9xLp3a" };
const DETAILS_LINK = "https://app.example.test/t/tsk_8fK2mQ9xLp3a";

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

  it("prints none of the planted values, in the text or in the view", () => {
    const out = renderEvidencePublic(planted(), { details: DETAILS });
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

});

describe("what it prints", () => {

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
    expect(out.body).toContain("Checks: 2 (1 not checked, 1 with newer evidence)");
    expect(out.body).toContain(NEWER_EVIDENCE_WORDS);
  });
});

describe("never 'sealed' or 'Real' when it is not true", () => {

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
      const out = renderEvidencePublic(raw as EvidencePackV2, { changeType: next() < 0.5 ? MARK : "refactor", details: next() < 0.5 ? { origin: `https://x.example/${MARK}`, taskId: `${MARK}/x` } : undefined });
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

  it("the sign-in link is built from ONE configured origin and an opaque task id, and nothing else", () => {
    expect(publicDetailsUrl(DETAILS.origin, DETAILS.taskId)).toBe(DETAILS_LINK);
    expect(publicDetailsUrl("https://app.example.test", "01HZX3K9M2Q7R8T5V6W4Y1Z0AB")).toBe("https://app.example.test/t/01HZX3K9M2Q7R8T5V6W4Y1Z0AB");
    const badOrigins = ["http://app.example.test", "https://10.0.0.5", "https://10.0.0.5:8443", "https://127.0.0.1", "https://[::1]", "https://[2001:db8::1]", "https://localhost", "https://intranet", "https://a..b", "https://a.b.", "https://.a.b", "https://app.example.test:8443", "https://app.example.test/", "https://app.example.test/acme", "https://app.example.test?x=1", "https://app.example.test#f", "https://user:pw@app.example.test", "https://app.example.test/x)[y](z", "https://app.example.test y", "https://app.example.test\nHello", "https://", "https://a.123", "https://1.2.3.4.5", "https://-a.example.test", "https://a-.example.test", "javascript:alert(1)", "//app.example.test", `https://${"a".repeat(64)}.example.test`, `https://${"a.".repeat(130)}com`, "https://rovara.internal.acme.com/acme/payments-team", 5, undefined, null];
    for (const bad of badOrigins) {
      expect(publicDetailsUrl(bad as string, DETAILS.taskId), `origin ${String(bad)}`).toBeUndefined();
      expect(renderEvidencePublic(v2Pack(), { details: { origin: bad as string, taskId: DETAILS.taskId } }).body.at(-1), String(bad)).toBe(`${PUBLIC_DETAILS_WORDS}: open in Rovara`);
    }
    const badIds = ["t/9", "acme/payments-team/t/9", "../x", "a b", "short", "", "x".repeat(65), "tsk_8fK2mQ9xLp3a?x=1", "tsk_8fK2mQ9xLp3a#f", "tsk_8fK2mQ9xLp3a\n", "tsk_8fK2mQ9xLp3a)", "tsk:8fK2mQ9xLp3a", "tsk.8fK2mQ9xLp3a", "tsk@8fK2mQ9xLp3a", "%2e%2e%2fadmin1234", 5, undefined, null];
    for (const bad of badIds) {
      expect(publicDetailsUrl(DETAILS.origin, bad as string), `id ${String(bad)}`).toBeUndefined();
      expect(renderEvidencePublic(v2Pack(), { details: { origin: DETAILS.origin, taskId: bad as string } }).body.at(-1), String(bad)).toBe(`${PUBLIC_DETAILS_WORDS}: open in Rovara`);
    }
    expect(PUBLIC_RENDER_LIMITS.linkMax).toBeGreaterThan(DETAILS_LINK.length);
  });
});

describe("bounded and fast", () => {
  it("a pack of about 1 MB (thousands of checks with long labels, thousands of notes) renders in time that grows no faster than its size, in a few lines", () => {
    const long = "L".repeat(200);
    const packOf = (checks: number): Record<string, any> => {
      const pack = clone(plantedPack()) as unknown as Record<string, any>;
      pack.checks = Array.from({ length: checks }, (_, index) => ({ id: `c${String(index)}`, kind: "test", label: long, before: "passed", after: index % 3 === 0 ? "failed" : "passed", class: "passing", durationMs: 1, tests: { total: 5, passed: 5, failed: 0, skipped: 0, errored: 0, names: [{ name: long, status: "passed" }], newTests: [long] } }));
      pack.notTested = Array.from({ length: checks / 2 }, () => ({ what: long, reason: long }));
      pack.weakening.absentOnNew = Array.from({ length: checks / 2 }, () => long);
      return pack;
    };
    let out: ReturnType<typeof renderEvidencePublic> | undefined;
    // Linear work grows about 8x. A check is about 300 bytes with its notes, so N stays small (8N under 256 KiB, in CPU cache); the full 4,000 checks (about 1 MB) is rendered once below.
    expectLinearScaling((checks) => {
      const pack = packOf(checks);
      return () => { out = renderEvidencePublic(pack as unknown as EvidencePackV2); };
    }, { n: 100, unitBytes: 300, label: "rendering a large evidence pack" });
    const fullPack = packOf(4_000);
    const largest = JSON.stringify(fullPack);
    out = renderEvidencePublic(fullPack as unknown as EvidencePackV2);
    expect(largest.length).toBeGreaterThan(1_000_000);
    if (out === undefined) throw new Error("no render");
    expect(out.text.length).toBeLessThan(3_000);
    expect(out.body.length).toBeLessThan(30);
    expect(out.text).toContain("Checks: 4,000 (");
    expect(out.text).not.toContain(long);
  });

  it("a 3.5 MB stored pack read as text is rendered in time that grows no faster than its size too", () => {
    const textFor = (dependencies: number) => {
      const pack = clone(v2Pack()) as unknown as Record<string, any>;
      pack.notTested = Array.from({ length: dependencies / 15 }, () => ({ what: "w".repeat(300), reason: "r".repeat(100) }));
      pack.dependencies = Array.from({ length: dependencies }, (_, index) => ({ name: `dep${String(index)}`.padEnd(80, "x"), kind: "http", backing: "fake", label: "real", trust: "real" }));
      return JSON.stringify(pack);
    };
    const readAndRender = (text: string) => {
      const read = readEvidencePackText(text);
      return read.status === "v2" ? renderEvidencePublic(read.pack, { newer: read.newer }) : undefined;
    };
    // Linear work grows about 8x. A dependency is about 160 bytes with its notes, so N stays small (8N under 256 KiB, in CPU cache); the full 3,000 dependencies is read and rendered once below.
    expectLinearScaling((dependencies) => {
      const text = textFor(dependencies);
      return () => readAndRender(text);
    }, { n: 195, unitBytes: 160, label: "reading and rendering a large stored evidence pack" });
    const textOf = textFor(3_000);
    const out = readAndRender(textOf);
    expect(textOf.length).toBeGreaterThan(300_000);
    expect(out).toBeDefined();
    expect(out!.text.length).toBeLessThan(3_000);
  });

});

describe("review fixes (Opus review of B12)", () => {
  const withDeps = (dependencies: unknown[]) => renderEvidencePublic(v2Pack({ dependencies }));
  const depLine = (out: { body: string[] }) => out.body.find((entry) => entry.startsWith("Dependencies:"));

  it("L2: only a real calendar date counts, and the year is shown", () => {
    for (const bad of ["2026-13-99", "0000-00-00", "2026-02-30", "2026-00-10", "2026-04-31", "1999-12-31", "2026-11-02\n", "2026-1-2", "12 Nov 2026", ""]) {
      expect(depLine(withDeps([{ name: "x", kind: "http", backing: "fake", label: "recorded_fake", trust: "recorded", recordedOn: bad }])), bad).toBe("Dependencies: 1 (Recorded 1)");
    }
    expect(depLine(withDeps([{ trust: "recorded", recordedOn: "2024-02-29" }]))).toBe("Dependencies: 1 (Recorded 1 (oldest recorded 29 Feb 2024))");
    expect(depLine(withDeps([{ trust: "recorded", recordedOn: "2023-02-29" }]))).toBe("Dependencies: 1 (Recorded 1)");
    // the oldest valid date wins; an invalid older one is skipped
    expect(depLine(withDeps([{ trust: "recorded", recordedOn: "2026-11-12" }, { trust: "recorded", recordedOn: "2025-03-01" }, { trust: "recorded", recordedOn: "2020-13-01" }]))).toBe("Dependencies: 3 (Recorded 3 (oldest recorded 1 Mar 2025))");
  });

  it("L2: with today's date given, a recording over 90 days old says so (and one that is not does not)", () => {
    const old = renderEvidencePublic(v2Pack({ dependencies: [{ trust: "recorded", recordedOn: "2026-07-01" }] }), { today: "2026-11-13" });
    expect(depLine(old)).toBe("Dependencies: 1 (Recorded 1 (oldest recorded 1 Jul 2026, over 90 days old))");
    const edge = (day: string) => depLine(renderEvidencePublic(v2Pack({ dependencies: [{ trust: "recorded", recordedOn: day }] }), { today: "2026-11-13" }));
    expect(edge("2026-08-14")).toContain("over 90 days old"); // 91 days
    expect(edge("2026-08-15")).not.toContain("over 90 days old"); // exactly 90 days is not over
    for (const badToday of ["2026-13-01", "today", "", undefined]) expect(depLine(renderEvidencePublic(v2Pack({ dependencies: [{ trust: "recorded", recordedOn: "2020-01-01" }] }), { today: badToday as string }))).not.toContain("days old");
  });

});

describe("callers", () => {
  it("only the evidence body seam calls the public renderer outside contracts", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const found = spawnSync("git", ["grep", "--untracked", "-lwE", "renderEvidencePublic|renderPublicView|publicEvidenceView", "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root });
    expect([0, 1]).toContain(found.status);
    expect(found.stdout.split("\n").filter((entry) => entry !== "" && !entry.startsWith("packages/contracts/"))).toEqual(["packages/broker/src/core/proof/evidence-v2-lines.ts"]);
  });
});
