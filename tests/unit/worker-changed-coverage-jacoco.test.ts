// Java reports J2: the JaCoCo XML reader (`target/site/jacoco/jacoco.xml`, `build/reports/jacoco/test/jacocoTestReport.xml`) into the same per-file line coverage the Go reader gives, and its use in the
// format-neutral changed-line intersection. Fail closed: a report it cannot read completely is "not measured"; a file it cannot place in exactly one source root is listed, not guessed.
import { describe, expect, it } from "vitest";
import { EvidenceCoverageSchema } from "../../packages/contracts/src/evidence.js";
import { changedLineCoverage, javaSourceRoots, looksLikeJacocoXml, parseJacocoXml, parseLineCoverage, JACOCO_XML_MAX_BYTES } from "../../packages/worker/src/verification/changed-coverage.js";

const DOCTYPE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">';
// What JaCoCo 0.8 writes: classes and methods carry counters; each source file lists its lines (nr, missed/covered instructions, missed/covered branches).
const line = (nr: number, mi: number, ci: number, mb = 0, cb = 0): string => `<line nr="${String(nr)}" mi="${String(mi)}" ci="${String(ci)}" mb="${String(mb)}" cb="${String(cb)}"/>`;
const sourcefile = (name: string, ...lines: string[]): string => `<sourcefile name="${name}">${lines.join("")}<counter type="LINE" missed="1" covered="2"/></sourcefile>`;
const pkg = (name: string, ...files: string[]): string => `<package name="${name}"><class name="${name}/X" sourcefilename="X.java"><method name="m" desc="()V" line="3"><counter type="LINE" missed="0" covered="1"/></method></class>${files.join("")}<counter type="LINE" missed="1" covered="2"/></package>`;
const report = (...packages: string[]): string => `${DOCTYPE}<report name="match"><sessioninfo id="host-1" start="1" dump="2"/>${packages.join("")}<counter type="LINE" missed="1" covered="2"/></report>`;
const changed = (entries: Record<string, number[]>): ReadonlyMap<string, readonly number[]> => new Map(Object.entries(entries));
const ROOTS = ["src/main/java"];

const MATCH = report(
  pkg("com/acme/match", sourcefile("Matcher.java", line(10, 0, 3), line(11, 2, 0), line(12, 1, 1, 1, 1), line(14, 0, 0), line(20, 0, 1)), sourcefile("Other.java", line(5, 4, 0))),
  pkg("com/acme/util", sourcefile("Strings.java", line(3, 0, 2))),
  pkg("", sourcefile("Main.java", line(1, 0, 1))),
);

describe("looksLikeJacocoXml", () => {
  it("tells a JaCoCo report from a Go profile, LCOV and other XML", () => {
    expect(looksLikeJacocoXml(MATCH)).toBe(true);
    expect(looksLikeJacocoXml('<report name="x"><package name="a"/></report>')).toBe(true);
    expect(looksLikeJacocoXml("mode: set\nexample.com/a/b.go:1.1,2.2 1 1\n")).toBe(false);
    expect(looksLikeJacocoXml("SF:src/a.js\nDA:1,1\nend_of_record\n")).toBe(false);
    expect(looksLikeJacocoXml('<coverage line-rate="1"><packages/></coverage>')).toBe(false);
    expect(looksLikeJacocoXml('<testsuite name="x"/>')).toBe(false);
  });
  it("accepts comments before and after the DOCTYPE, a byte-order mark and leading space, and refuses an unclosed comment, a DOCTYPE with an internal subset and a root that is not <report>", () => {
    expect(looksLikeJacocoXml(`\uFEFF  <?xml version="1.0"?>\n<!-- one -->\n<!-- two -->${DOCTYPE.slice(DOCTYPE.indexOf("<!DOCTYPE"))}<!-- three --> <report name="x"/>`)).toBe(true);
    expect(looksLikeJacocoXml("<!-- a --><report>")).toBe(true);
    expect(looksLikeJacocoXml("<!-- never closed <report>")).toBe(false);
    expect(looksLikeJacocoXml('<!DOCTYPE report [<!ENTITY x "y">]><report>')).toBe(false);
    expect(looksLikeJacocoXml("<reports/>")).toBe(false);
    expect(looksLikeJacocoXml("<!-- a --> text <report>")).toBe(false);
    expect(looksLikeJacocoXml('<?xml version="1.0" <report>')).toBe(false);
  });
  it("answers a hostile file of empty comments in linear time (the old pattern took about 30 seconds for 30 comments)", () => {
    for (const hostile of ["<!---->".repeat(1000) + "x", "<!---->".repeat(30) + "x", "<!-- -->".repeat(1000), `${"<!---->".repeat(500)}<report>`.slice(0, 4096) + "<!--"]) {
      const started = performance.now();
      looksLikeJacocoXml(hostile);
      expect(performance.now() - started).toBeLessThan(50);
    }
    expect(looksLikeJacocoXml("<!---->".repeat(1000) + "x")).toBe(false);
    expect(looksLikeJacocoXml("<!---->".repeat(500) + "<report>")).toBe(true);
    // The reader that calls it takes the same time: a coverage file made only of comments is "not measured", at once.
    const started = performance.now();
    expect(parseLineCoverage("<!---->".repeat(1000) + "x", { javaSourceRoots: ROOTS })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("parseJacocoXml", () => {
  it("reads package and source file into repository paths under the source root, statements are lines with instructions, covered when any ran", () => {
    const read = parseJacocoXml(MATCH, { sourceRoots: ROOTS })!;
    expect([...read.files.keys()].sort()).toEqual(["src/main/java/Main.java", "src/main/java/com/acme/match/Matcher.java", "src/main/java/com/acme/match/Other.java", "src/main/java/com/acme/util/Strings.java"]);
    expect(read.files.get("src/main/java/com/acme/match/Matcher.java")).toEqual({ statements: [[10, 12], [20, 20]], covered: [[10, 10], [12, 12], [20, 20]] });
    expect(read.unmappedBlocks).toBe(0);
  });
  it("picks the one root that has the file when the repository file list is given, per module", () => {
    const paths = ["svc/a/src/main/java/com/acme/A.java", "svc/b/src/main/java/com/acme/B.java", "svc/b/src/main/kotlin/com/acme/K.kt"];
    const text = report(pkg("com/acme", sourcefile("A.java", line(1, 0, 1)), sourcefile("B.java", line(2, 1, 0)), sourcefile("K.kt", line(3, 0, 1)), sourcefile("Gone.java", line(4, 0, 1))));
    const read = parseJacocoXml(text, { sourceRoots: javaSourceRoots(paths), repoPaths: paths })!;
    expect([...read.files.keys()].sort()).toEqual(["svc/a/src/main/java/com/acme/A.java", "svc/b/src/main/java/com/acme/B.java", "svc/b/src/main/kotlin/com/acme/K.kt"]);
    expect(read.unmappedBlocks).toBe(1);
  });
  it("does not guess: a file that exists under two roots, or a name repeated in the report, is listed as ambiguous and dropped; several roots with no file list are all ambiguous", () => {
    const paths = ["a/src/main/java/com/acme/Same.java", "b/src/main/java/com/acme/Same.java", "a/src/main/java/com/acme/Own.java"];
    const text = report(pkg("com/acme", sourcefile("Same.java", line(1, 0, 1)), sourcefile("Own.java", line(2, 0, 1))));
    const read = parseJacocoXml(text, { sourceRoots: javaSourceRoots(paths), repoPaths: paths })!;
    expect([...read.files.keys()]).toEqual(["a/src/main/java/com/acme/Own.java"]);
    expect(read.ambiguousFiles).toEqual(["com/acme/Same.java"]);
    const twice = report(pkg("com/acme", sourcefile("Dup.java", line(1, 0, 1))), pkg("com/acme", sourcefile("Dup.java", line(1, 1, 0))), pkg("com/acme", sourcefile("Fine.java", line(1, 0, 1))));
    const dup = parseJacocoXml(twice, { sourceRoots: ROOTS })!;
    expect([...dup.files.keys()]).toEqual(["src/main/java/com/acme/Fine.java"]);
    expect(dup.ambiguousFiles).toEqual(["com/acme/Dup.java"]);
    expect(parseJacocoXml(MATCH, { sourceRoots: ["a/src/main/java", "b/src/main/java"] })).toBeUndefined();
  });
  it("is not measured for text it cannot read completely", () => {
    const good = report(pkg("com/acme", sourcefile("A.java", line(1, 0, 1))));
    expect(parseJacocoXml(good, { sourceRoots: ROOTS })).toBeDefined();
    for (const bad of [
      "", "not xml", "<report name='x'></report>", '<coverage/>',
      report(pkg("com/acme", sourcefile("A.java", '<line nr="0" mi="0" ci="1"/>'))),
      report(pkg("com/acme", sourcefile("A.java", '<line nr="x" mi="0" ci="1"/>'))),
      report(pkg("com/acme", sourcefile("A.java", '<line nr="3" mi="-1" ci="1"/>'))),
      report(pkg("com/acme", sourcefile("A.java", '<line nr="3" ci="1"/>'))),
      report(pkg("com/acme", sourcefile("A.java", '<line nr="99999999999" mi="0" ci="1"/>'))),
      good.replace("</report>", ""),
      good.replace("<package", "<!-- never closed <package"),
      good.replace("<!DOCTYPE report PUBLIC", '<!DOCTYPE report [<!ENTITY x "y">]> <!DOCTYPE report PUBLIC'),
      `${DOCTYPE}<report><sourcefile name="A.java">${line(1, 0, 1)}</sourcefile></report>`,
    ]) expect(parseJacocoXml(bad, { sourceRoots: ROOTS }), bad.slice(0, 80)).toBeUndefined();
    expect(parseJacocoXml(good, { sourceRoots: [] })).toBeUndefined();
    expect(parseJacocoXml(`${good}${" ".repeat(JACOCO_XML_MAX_BYTES)}`, { sourceRoots: ROOTS })).toBeUndefined();
  });
  it("drops names that leave the source root or hold odd characters, and counts them; a report with no placeable file is not measured", () => {
    const text = report(pkg("com/acme", sourcefile("A.java", line(1, 0, 1))), pkg("../escape", sourcefile("B.java", line(1, 0, 1))), pkg("com/acme", sourcefile("../C.java", line(1, 0, 1))), pkg("com\\acme", sourcefile("D.java", line(1, 0, 1))));
    const read = parseJacocoXml(text, { sourceRoots: ROOTS })!;
    expect([...read.files.keys()]).toEqual(["src/main/java/com/acme/A.java"]);
    expect(read.unmappedBlocks).toBe(3);
    expect(parseJacocoXml(report(pkg("../escape", sourcefile("B.java", line(1, 0, 1)))), { sourceRoots: ROOTS })).toBeUndefined();
  });
  it("sends package and file names through the data guard: a name with a secret or a control character is never stored or listed, and its file counts as not placed", () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const text = report(
      pkg("com/acme", sourcefile("A.java", line(1, 0, 1)), sourcefile(`${token}.java`, line(1, 0, 1)), sourcefile("Evil&#x202E;gnp.java", line(1, 0, 1)), sourcefile("Tab&#9;Name.java", line(1, 0, 1))),
      pkg(`com/${token}`, sourcefile("B.java", line(1, 0, 1))),
      pkg("com/acme", sourcefile("Dup.java", line(1, 0, 1))), pkg("com/acme", sourcefile("Dup.java", line(1, 0, 1))),
    );
    const read = parseJacocoXml(text, { sourceRoots: ROOTS })!;
    expect([...read.files.keys()]).toEqual(["src/main/java/com/acme/A.java"]);
    expect(read.unmappedBlocks).toBe(4);
    expect(read.ambiguousFiles).toEqual(["com/acme/Dup.java"]);
    expect(JSON.stringify([...read.files.keys(), read.ambiguousFiles])).not.toContain(token);
    // With the repository's file list as well: nothing a report invented is placed, and nothing is listed.
    const paths = ["src/main/java/com/acme/A.java"];
    const listed = parseJacocoXml(text, { sourceRoots: ROOTS, repoPaths: paths })!;
    expect(JSON.stringify(listed.ambiguousFiles)).not.toContain(token);
    // A name the guard leaves alone is untouched.
    expect(parseJacocoXml(report(pkg("com/acme/util", sourcefile("Strings$Inner_2.java", line(1, 0, 1)))), { sourceRoots: ROOTS })!.files.has("src/main/java/com/acme/util/Strings$Inner_2.java")).toBe(true);
  });
  it("is not fooled by package or line elements inside comments or CDATA", () => {
    const text = report(pkg("com/acme", sourcefile("A.java", line(1, 0, 1)))).replace("</report>", '<!-- <package name="com/fake"><sourcefile name="F.java"><line nr="1" mi="0" ci="1"/></sourcefile></package> --></report>');
    expect([...parseJacocoXml(text, { sourceRoots: ROOTS })!.files.keys()]).toEqual(["src/main/java/com/acme/A.java"]);
  });
  it("reads a large report in one pass", () => {
    const lines = Array.from({ length: 50_000 }, (_, n) => line(n + 1, n % 2, (n + 1) % 2)).join("");
    const read = parseJacocoXml(report(pkg("com/acme", `<sourcefile name="Big.java">${lines}</sourcefile>`)), { sourceRoots: ROOTS })!;
    expect(read.files.get("src/main/java/com/acme/Big.java")?.statements).toEqual([[1, 50_000]]);
  });
});

describe("javaSourceRoots", () => {
  it("finds src/main/java and src/main/kotlin roots from the file list, per module, sorted and bounded", () => {
    expect(javaSourceRoots(["pom.xml", "src/main/java/a/A.java", "core/src/main/java/b/B.java", "core/src/main/kotlin/c/C.kt", "core/src/test/java/b/BTest.java", "docs/readme.md", "src/main/resources/x.properties"])).toEqual(["core/src/main/java", "core/src/main/kotlin", "src/main/java"]);
    expect(javaSourceRoots(["README.md"])).toEqual(["src/main/java"]);
    expect(javaSourceRoots(Array.from({ length: 200 }, (_, n) => `m${String(n)}/src/main/java/A.java`))).toHaveLength(100);
  });
});

describe("changedLineCoverage with JaCoCo coverage", () => {
  const read = parseJacocoXml(MATCH, { sourceRoots: ROOTS })!;
  it("counts the changed lines that are statements and lists the uncovered ones, in the evidence's shape", () => {
    const { coverage } = changedLineCoverage(read, changed({ "src/main/java/com/acme/match/Matcher.java": [9, 10, 11, 12, 13, 14, 20], "src/main/java/com/acme/match/Other.java": [5, 6] }));
    // statements among the changed lines: 10 12 20 (ran), 11 (never) in Matcher; 5 (never) in Other. 14 has no instructions.
    expect(coverage).toEqual({ linesChanged: 5, linesCovered: 3, files: [{ path: "src/main/java/com/acme/match/Matcher.java", uncovered: [11] }, { path: "src/main/java/com/acme/match/Other.java", uncovered: [5] }] });
    expect(EvidenceCoverageSchema.safeParse(coverage).success).toBe(true);
  });
  it("names changed Java and Kotlin source files the report does not mention, but not tests, resources or other languages", () => {
    const { unmeasured } = changedLineCoverage(read, changed({
      "src/main/java/com/acme/New.java": [1], "core/src/main/kotlin/Z.kt": [1], "src/test/java/com/acme/NewTest.java": [1], "src/main/resources/a.properties": [1], "src/main/java/com/acme/match/Matcher.java": [10], "tool.py": [1],
    }));
    expect(unmeasured).toEqual(["core/src/main/kotlin/Z.kt", "src/main/java/com/acme/New.java"]);
  });
});

describe("parseLineCoverage", () => {
  it("chooses the reader from the content", () => {
    const go = parseLineCoverage("mode: set\nexample.com/acme/match/a.go:1.1,2.2 1 1\n", { goModules: [{ path: "example.com/acme/match", dir: "." }] });
    expect(go?.format).toBe("go");
    expect([...go!.coverage.files.keys()]).toEqual(["a.go"]);
    const java = parseLineCoverage(MATCH, { javaSourceRoots: ROOTS });
    expect(java?.format).toBe("jacoco");
    expect(java?.coverage.files.size).toBe(4);
  });
  it("is not measured for a format it does not know, or when the options for the format are missing", () => {
    expect(parseLineCoverage("SF:a.js\nDA:1,1\nend_of_record\n", { javaSourceRoots: ROOTS })).toBeUndefined();
    expect(parseLineCoverage(MATCH, {})).toBeUndefined();
    expect(parseLineCoverage("mode: set\nexample.com/a/b.go:1.1,2.2 1 1\n", { javaSourceRoots: ROOTS })).toBeUndefined();
  });
});
