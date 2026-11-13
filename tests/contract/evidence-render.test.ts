// TE-A2a: the pure evidence renderer (first line and body). Golden text for the five levels and each producer line; slots appear only when given; output stays bounded and inert; nothing outside contracts calls it yet.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ISOLATIONS, EVIDENCE_LEVELS, EVIDENCE_RENDER_LIMITS, NEWER_EVIDENCE_WORDS, evidencePackV1ToV2, inertEvidenceText, readEvidencePack, renderEvidence, renderEvidenceRead, type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withLevel = (reached: string, isolation = "sealed", result = "verified"): EvidencePackV2 => v2Pack({ level: { reached, required: [] }, producer: { edition: "cloud", isolation }, result });
const ZWJ = "‍";

describe("the first line, one golden per level", () => {
  it.each([
    ["rovara_real_run", "Verified · Real run by Rovara"],
    ["their_ci", "Verified · Checked by your CI"],
    ["sandbox_only", "Verified · Sandbox only, no sealed run"],
    ["no_ci", "Verified · No CI to check against"],
    ["ci_not_readable", "Verified · Your CI results could not be read"],
  ])("%s", (level, expected) => {
    expect(renderEvidence(withLevel(level)).firstLine).toBe(expected);
  });

  it("covers every level the schema knows", () => {
    for (const level of EVIDENCE_LEVELS) expect(renderEvidence(withLevel(level)).firstLine).not.toContain(NEWER_EVIDENCE_WORDS);
  });

  it("names the result axis and the weakest stage, and says 'not sealed' when the round ran in the sandbox", () => {
    const pack = v2Pack({ level: { reached: "sandbox_only", required: ["sealed"], weakest: { stageId: "sealed", words: "38 tests used recorded answers" } }, producer: { edition: "cloud", isolation: "sandbox" }, result: "partially_verified" });
    expect(renderEvidence(pack).firstLine).toBe("Partly verified · Sandbox only, no sealed run · weakest: 38 tests used recorded answers · not sealed");
    expect(renderEvidence(withLevel("rovara_real_run", "sealed", "code_failed")).firstLine).toBe("Code failed checks · Real run by Rovara");
    expect(renderEvidence(withLevel("rovara_real_run", "sealed", "blocked_by_environment")).firstLine).toBe("Blocked by the environment · Real run by Rovara");
  });

  it("says nothing better than the words it has for a level or result it does not know", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), level: { reached: "quantum", required: [] }, result: "mystery" });
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack, { newer: read.newer }).firstLine).toBe(`${NEWER_EVIDENCE_WORDS} · ${NEWER_EVIDENCE_WORDS}`);
  });
});

describe("the producer line", () => {
  it.each([
    ["developer_machine", "Ran on a developer machine"],
    ["sealed", "Checked in a sealed round"],
    ["sandbox", "Checked in the agent's sandbox (not sealed)"],
    ["imported", "Imported from your CI (not run by Rovara)"],
  ])("%s", (isolation, expected) => {
    expect(renderEvidence(withLevel("their_ci", isolation)).producerLine).toBe(expected);
    expect(renderEvidence(withLevel("their_ci", isolation)).body[0]).toBe(expected);
  });

  it("puts 'not sealed' in the first line for the sandbox and for nothing else that is honest about itself", () => {
    expect(renderEvidence(withLevel("sandbox_only", "sandbox")).firstLine.endsWith("not sealed")).toBe(true);
    for (const isolation of ["sealed", "developer_machine", "imported"]) expect(renderEvidence(withLevel("their_ci", isolation)).firstLine).not.toContain("not sealed");
  });
});

// M4: the first line never says "Real" for a pack that did not run in a sealed round or that rests on scripted AI replies.
describe("the first line is never better than where the checks ran", () => {
  it("words a 'real run' claimed outside a sealed round as what it was", () => {
    const first = renderEvidence(withLevel("rovara_real_run", "sandbox")).firstLine;
    expect(first).toBe("Verified · Run by Rovara, not sealed");
    expect(first).not.toMatch(/real/iu);
  });

  // TE-A2b review M3: only a sealed round or the agent's sandbox is a Rovara run; a stored pack (read tolerantly) that says otherwise is worded as where it really ran.
  it.each([
    ["developer_machine", "Verified · Ran on a developer machine"],
    ["imported", "Verified · Imported, not run by Rovara"],
    ["teleport", "Verified · Where the checks ran is not known"],
  ])("a 'real run' claimed with isolation %s is not worded as a Rovara run", (isolation, expected) => {
    const read = readEvidencePack({ ...clone(withLevel("rovara_real_run")), producer: { edition: "code", isolation } });
    expect(read.status).toBe("v2");
    if (read.status !== "v2") return;
    const first = renderEvidence(read.pack, { newer: read.newer }).firstLine;
    expect(first.startsWith(expected)).toBe(true);
    expect(first).not.toContain("Run by Rovara");
    expect(first).not.toMatch(/real/iu);
  });

  // TE-A2b review L1: a laptop report whose CI has not finished says where it ran (O26), never "Sandbox only, no sealed run".
  it("a developer machine with the CI still running says it ran on a developer machine", () => {
    const first = renderEvidence(withLevel("sandbox_only", "developer_machine")).firstLine;
    expect(first).toBe("Verified · Ran on a developer machine");
    expect(first).not.toContain("Sandbox only");
    expect(renderEvidence(withLevel("sandbox_only", "imported")).firstLine).toBe("Verified · Imported, not run by Rovara");
    expect(renderEvidence(withLevel("sandbox_only", "sandbox")).firstLine).toContain("Sandbox only, no sealed run");
  });

  it("words a scripted-AI proof as such and the change proof line says so", () => {
    const pack = withLevel("rovara_real_run");
    Object.assign(pack.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "simulated" });
    const out = renderEvidence(pack);
    expect(out.firstLine).toBe("Verified · Run against scripted AI replies");
    expect(out.firstLine).not.toMatch(/real/iu);
    expect(out.body).toContain("Change proof: 1 proven with scripted AI replies");
    expect(renderEvidence(v2Pack()).body).toContain("Change proof: 1 proven");
  });

  it("says 'Real' only for a real run in a sealed round", () => {
    for (const level of EVIDENCE_LEVELS) {
      for (const isolation of EVIDENCE_ISOLATIONS) {
        const first = renderEvidence(withLevel(level, isolation)).firstLine;
        expect(/real/iu.test(first), `${level} ${isolation}`).toBe(level === "rovara_real_run" && isolation === "sealed");
      }
    }
  });
});

describe("the full text of a complete pack", () => {
  it("is this golden", () => {
    expect(renderEvidence(v2Pack()).text).toBe([
      "Verified · Real run by Rovara",
      "Checked in a sealed round",
      "Checks: 2 (2 passed)",
      "- Tests: pytest -q: passed, 3 tests (1 new), 90% of changed lines covered",
      "- Benchmark: render time: passed, p95 118 ms (was 120 ms)",
      "Change proof: 1 proven",
      "Dependencies: Real · Recorded (12 Nov)",
      "- stripe: Recorded (12 Nov)",
      "- postgres: Real",
      "Spent: $0.40 model, 12 machine minutes ($0.10)",
      "Not tested:",
      "- refund flow (no test)",
    ].join("\n"));
  });

  it("renders a v1 pack upgraded with its context", () => {
    const upgraded = evidencePackV1ToV2(v1Pack(), { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" });
    const out = renderEvidence(upgraded);
    expect(out.firstLine).toBe("Verified · Checked by your CI");
    expect(out.producerLine).toBe("Ran on a developer machine");
    expect(out.text).toContain("- Tests: pytest -q: passed, 3 tests (1 new), 90% of changed lines covered");
  });
});

describe("slots", () => {
  it("shows the time-target line and the Rovara-problem line only when given", () => {
    const plain = renderEvidence(v2Pack());
    expect(plain.text).not.toContain("Time target");
    const slotted = renderEvidence(v2Pack(), { timeTargetLine: "Time target: ready in 40 min (p75 of 20 runs)", rovaraProblemLine: "Held back: Rovara problem, not your code" });
    expect(slotted.body.slice(0, 3)).toEqual(["Checked in a sealed round", "Held back: Rovara problem, not your code", "Time target: ready in 40 min (p75 of 20 runs)"]);
    expect(renderEvidence(v2Pack(), { timeTargetLine: "   " }).text).toBe(plain.text);
  });

  it("makes a slot line inert, including a line that would open a heading", () => {
    const out = renderEvidence(v2Pack(), { rovaraProblemLine: "# Heading @octocat" });
    expect(out.body[1]).toBe(`${ZWJ}# Heading @${ZWJ}octocat`);
  });
});

describe("trust and proof words", () => {
  it("shows a scripted-AI proof as 'proven with scripted AI replies', never Real", () => {
    const pack = clone(v2Pack());
    Object.assign(pack.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "simulated" });
    const out = renderEvidence(pack).text;
    expect(out).toContain("proven with scripted AI replies");
    const line = out.split("\n").find((entry) => entry.startsWith("- Tests"))!;
    expect(line).not.toMatch(/Real/u);
  });

  it("counts Made by Rovara mocks by when they were made", () => {
    const pack = clone(v2Pack());
    pack.dependencies = [
      { name: "a", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m1", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "b", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m2", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "c", kind: "http", backing: "none", label: "faked_by_tests", trust: "no_outside_calls" },
    ];
    expect(renderEvidence(pack).text).toContain("Dependencies: Made by Rovara (2 made during this task) · No outside calls");
  });
});

describe("newer evidence", () => {
  it("adds one line when the reader met parts it did not know, and a first-line stand-in for a later version", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), hologram: 1 });
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack, { newer: read.newer }).body.at(-1)).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead(readEvidencePack({ schemaVersion: 3 })).firstLine).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead({ status: "unreadable", reason: "not_a_pack" }).firstLine).toBe("Evidence could not be read, open in Rovara");
    expect(renderEvidenceRead({ status: "v1", pack: v1Pack() }).firstLine).toBe("Evidence from an older Rovara, open in Rovara for the level");
  });

  it("shows the newer-evidence line for a check outcome the build does not know, and an ordinary 'not checked' for the real outcome 'unknown'", () => {
    const flaky = clone(v2Pack());
    flaky.checks[0]!.after = "flaky" as never;
    const read = readEvidencePack(flaky);
    expect(read.status === "v2" && renderEvidenceRead(read).text).toContain(`pytest -q: ${NEWER_EVIDENCE_WORDS}`);
    const real = clone(v2Pack());
    real.checks[0]!.after = "unknown";
    const known = readEvidencePack(real);
    expect(known.status === "v2" && renderEvidenceRead(known).text).toContain("pytest -q: not checked");
  });
});

describe("bounds", () => {
  const big = () => {
    const pack = clone(v2Pack());
    pack.checks = Array.from({ length: 64 }, (_unused, index) => ({ id: `c${String(index)}`, kind: "test", label: "L".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1, tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } }));
    pack.notTested = Array.from({ length: 200 }, (_unused, index) => ({ what: "W".repeat(300), reason: `R${String(index)}` }));
    pack.dependencies = Array.from({ length: 24 }, (_unused, index) => ({ name: `${"D".repeat(70)}${String(index)}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    return renderEvidence(pack);
  };

  it("stays inside the character limit and says how many it left out, for 64 checks with long labels and 200 not-tested rows", () => {
    const out = big();
    expect(out.text.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.textMax);
    expect(out.firstLine.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    for (const line of out.text.split("\n")) expect(Array.from(line).length, line.slice(0, 40)).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    expect(out.text).toContain(`and ${String(64 - EVIDENCE_RENDER_LIMITS.checksListed)} more checks`);
    expect(out.text).toContain(`and ${String(200 - EVIDENCE_RENDER_LIMITS.notTestedListed)} more`);
  });

  it("lists exactly the capped number of checks, dependencies and not-tested rows, never more", () => {
    const lines = big().text.split("\n");
    expect(lines.filter((line) => line.startsWith("- Tests:"))).toHaveLength(EVIDENCE_RENDER_LIMITS.checksListed);
    expect(lines.filter((line) => line.startsWith("- ") && line.includes(": not available"))).toHaveLength(EVIDENCE_RENDER_LIMITS.dependenciesListed);
    expect(lines).toContain("- and 16 more dependencies");
    expect(lines.filter((line) => line.startsWith("- W") && line.includes("(R"))).toHaveLength(EVIDENCE_RENDER_LIMITS.notTestedListed);
  });

  it("prints '?' for a count or an amount that is not a finite number, and never throws on one", () => {
    const pack = clone(v2Pack()) as unknown as Record<string, Record<string, unknown>>;
    pack.proof!.provenCount = "![x](//evil.example/p.png)";
    pack.meters = { modelUsd: "boom", machineMinutes: Number.NaN, machineUsd: null, caps: {} };
    const out = renderEvidence(pack as unknown as EvidencePackV2).text;
    expect(out).toContain("Change proof: ? proven");
    expect(out).toContain("Spent: $? model, ? machine minutes ($?)");
    expect(out).not.toContain("evil");
  });
});

describe("inert text", () => {
  const inert = (text: string) => inertEvidenceText(text, 300);

  it("drops an image and reduces a link to its text, so each strip matters", () => {
    expect(inert("x ![alt](http://e.co/p.png) y")).toBe("x y");
    expect(inert("[click](http://e.co)")).toBe("click");
  });

  it("neutralises an image or a link with brackets inside its text (nested brackets)", () => {
    expect(inert("![a[b]c](//evil.example/x.png)")).toBe("");
    expect(inert("[Verified[1]](//evil.example)")).toBe("Verified(1)");
  });

  it("neutralises reference-style images, links and definitions: no bracket survives", () => {
    for (const text of ["![a][r]", "[a][r]", "[r]: //evil.example/x.png", "[r]: <http://evil.example>", "![a]", "[a]"]) expect(inert(text), text).not.toMatch(/[[\]]/u);
  });

  it("puts a joiner before anything that would open a block at the start of the line", () => {
    for (const text of ["# Heading", "## Heading", "> quote", "---", "===", "```", "~~~", "| a | b |", "1. item", "2) item", "- item", "+ item", "* item", "___"]) expect(inert(text), text).toBe(`${ZWJ}${text}`);
    for (const text of ["12 tests", "ordinary line", "a # b", "(a)"]) expect(inert(text), text).toBe(text);
  });

  it("removes variation selectors", () => {
    expect(inert("a️b\u{E0100}c\u{E01EF}d︀")).toBe("abcd");
  });

  it("cuts its input before processing, so a hostile megabyte costs as much as a short line", () => {
    const started = Date.now();
    for (const text of ["![".repeat(500_000), "[](".repeat(500_000), "<".repeat(1_000_000), "&".repeat(1_000_000), "a".repeat(1_000_000)]) expect(Array.from(inert(text)).length).toBeLessThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stays linear for a large max: the largest allowed max is capped, so a million '<' finishes at once", () => {
    const started = Date.now();
    for (const max of [2_000, 1_000_000_000]) {
      const out = inertEvidenceText("<".repeat(1_000_000), max);
      expect(Array.from(out).length).toBeLessThanOrEqual(2_000);
      expect(Array.from(inertEvidenceText("[](".repeat(400_000), max)).length).toBeLessThanOrEqual(2_000);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reads at most 256 KiB of raw input", () => {
    expect(inertEvidenceText(`${"x".repeat(10)}${" ".repeat(300_000)}tail`, 300)).toBe("xxxxxxxxxx");
    expect(inertEvidenceText(`${"x".repeat(10)} tail`, 300)).toBe("xxxxxxxxxx tail");
  });

  it("redacts a secret even when the cut would split it: no fragment of a token is ever printed", () => {
    const token = `gh${"p"}_${"a".repeat(36)}`;
    // Whitespace collapses, so the token ends up inside the output even though it starts past 4 x max characters of raw input.
    const out = inertEvidenceText(`${" ".repeat(1190)}${token}`, 300);
    expect(out).toBe("(REDACTED)");
    expect(out).not.toContain("ghp_");
    // Markup that is stripped afterwards shrinks the text, so the secret can start inside the working window and end outside it: it is redacted before the window is cut, not after.
    expect(inertEvidenceText(`${"<b>".repeat(396)}${token}`, 300)).toBe("(REDACTED)");
    // A secret that straddles the hard cap on the raw input is dropped with its whole last word, not left as a fragment.
    const straddle = inertEvidenceText(`${" ".repeat(262_144 - 20)}${token} end`, 300);
    expect(straddle).not.toMatch(/g(?:h(?:p(?:_a*)?)?)?$/u);
    expect(straddle).not.toContain("ghp");
  });

  it("redacts a secret-shaped token (built here at run time, never written out)", () => {
    const token = `gh${"p"}_${"a".repeat(36)}`;
    const out = inert(`token ${token} end`);
    expect(out).not.toContain(token);
    expect(out).toContain("(REDACTED)");
  });

  it("breaks a mention, a link, a bare www address (any case), an issue reference, a Linear key and a tag", () => {
    expect(inert("@octocat")).toBe(`@${ZWJ}octocat`);
    expect(inert("https://evil.example")).toBe(`https://${ZWJ}evil.example`);
    expect(inert("www.evil.example")).toBe(`www${ZWJ}.evil.example`);
    expect(inert("WWW.EVIL.EXAMPLE")).toBe(`WWW${ZWJ}.EVIL.EXAMPLE`);
    expect(inert("Fixes owner/repo#12")).toBe(`Fixes owner/repo#${ZWJ}12`);
    expect(inert("Fixes ENG-42")).toBe(`Fixes ENG-${ZWJ}42`);
    expect(inert("<img src=x onerror=alert(1)>")).toBe("");
    expect(inert("a < b")).toBe("a &lt; b");
    expect(inert("a & b")).toBe("a &amp; b");
  });

  it("makes every word from a repository inert in a rendered pack", () => {
    const pack = clone(v2Pack());
    pack.checks[0]!.label = "![x](http://evil.test/a.png) @octocat see https://evil.test #123 Fixes ENG-42‮ <!-- hide";
    pack.notTested = [{ what: "<script>alert(1)</script> [click](http://e.co)", reason: "line\nbreak" }];
    const text = renderEvidence(pack).text;
    expect(text).not.toMatch(/[‮]/u);
    expect(text).not.toMatch(/!\[/u);
    expect(text).not.toMatch(/@octocat/u);
    expect(text).not.toMatch(/:\/\/(?!‍)/u);
    expect(text).not.toMatch(/#123/u);
    expect(text).not.toMatch(/ENG-42/u);
    expect(text).not.toContain("<");
  });
});

describe("callers", () => {
  it("only the broker's evidence writer, reader and pull request description (TE-A2b) use an export the evidence pack v2 lane added", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const source = (file: string) => readFileSync(`${root}/packages/contracts/src/${file}`, "utf8");
    const exported = (text: string) => [...text.matchAll(/^export (?:declare )?(?:const|function|type|interface|class) ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]!);
    const v2Start = (text: string) => text.slice(text.indexOf("// ---- evidence pack v2 (TE-A2a"));
    const newerStart = (text: string) => text.slice(text.indexOf("// ---- newer evidence (TE-A2)"));
    const names = [
      ...exported(source("check-kinds.ts")), ...exported(source("evidence-render.ts")), ...exported(source("evidence-inert.ts")), ...exported(v2Start(source("evidence.ts"))), ...exported(newerStart(source("forward-reader.ts"))),
    ];
    expect(names.length).toBeGreaterThan(60);
    expect(names).toEqual(expect.arrayContaining(["renderEvidence", "readEvidencePack", "inertEvidenceText", "tolerantRead", "isRegisteredCheckKind", "EvidencePackV2Schema"]));
    const found = spawnSync("git", ["grep", "--untracked", "-lw", ...names.flatMap((name) => ["-e", name]), "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root, env: isolatedGitEnvironment(root) });
    expect([0, 1]).toContain(found.status);
    const hits = found.stdout.split("\n").filter((entry) => entry !== "");
    // TE-A2b is the first caller (the writer, the readers and the description's Evidence block); any other caller has to be named here on purpose.
    expect(hits.filter((file) => !file.startsWith("packages/contracts/")).sort()).toEqual([
      "packages/broker/src/core/proof/evidence-guard.ts",
      "packages/broker/src/core/proof/evidence-keep.ts",
      "packages/broker/src/core/proof/evidence-lines.ts",
      "packages/broker/src/core/proof/evidence-pack.ts",
      "packages/broker/src/core/proof/evidence-v2-lines.ts",
      "packages/broker/src/core/proof/weakening-flags.ts",
    ]);
    // B3 may share inert text only; the other v2 exports remain confined to the A2b callers.
    const others = spawnSync("git", ["grep", "--untracked", "-lw", ...names.filter((name) => name !== "inertEvidenceText").flatMap((name) => ["-e", name]), "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root, env: isolatedGitEnvironment(root) });
    expect([0, 1]).toContain(others.status);
    expect(others.stdout.split("\n").filter((file) => file !== "" && !file.startsWith("packages/contracts/")).sort()).toEqual([
      "packages/broker/src/core/proof/evidence-guard.ts",
      "packages/broker/src/core/proof/evidence-keep.ts",
      "packages/broker/src/core/proof/evidence-lines.ts",
      "packages/broker/src/core/proof/evidence-pack.ts",
      "packages/broker/src/core/proof/evidence-v2-lines.ts",
    ]);
  });
});

// TE-A2b review L2: version 2 is off everywhere until the Cloud half and the TE-A1 gate turn it on. Nothing in a package may set the description's writer to 2, give `keepEvidence` a writer, or read a pack with `loadEvidenceRead` but the files named here.
describe("nothing turns the version 2 writer on yet", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const grep = (...args: string[]) => {
    const found = spawnSync("git", ["grep", "--untracked", ...args, "--", ":(glob)packages/*/src/**"], { encoding: "utf8", cwd: root, env: isolatedGitEnvironment(root) });
    expect([0, 1]).toContain(found.status);
    return found.stdout.split("\n").filter((entry) => entry !== "");
  };
  it("no package sets `evidenceWriter: 2`", () => {
    expect(grep("-nE", "evidenceWriter[[:space:]]*:[[:space:]]*2")).toEqual([]);
  });
  it("only the writer's own file and the local wiring name keepEvidence, and the wiring gives it no writer", () => {
    expect(grep("-lE", "keepEvidence\\(").sort()).toEqual(["packages/broker/src/core/proof/evidence-keep.ts", "packages/broker/src/local/app/evidence.ts"]);
    expect(readFileSync(`${root}/packages/broker/src/local/app/evidence.ts`, "utf8")).not.toMatch(/\bwriter\b/u);
    expect(grep("-nE", "writer[[:space:]]*:[[:space:]]*\\{[[:space:]]*version[[:space:]]*:[[:space:]]*2")).toEqual([]);
  });
  it("only the evidence keep file and a comment in the evidence lines name loadEvidenceRead", () => {
    expect(grep("-lw", "loadEvidenceRead").sort()).toEqual(["packages/broker/src/core/proof/evidence-keep.ts", "packages/broker/src/core/proof/evidence-lines.ts"]);
  });
});
