// What the worker checks in a plan's code citations before posting it: the files, the anchor lines and the line ranges.
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_DOCUMENT_INFO_STRING, type PlanDocument } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { checkCodeCitations, citedFileReader, withCorrectedRanges, type CitedFile } from "../../packages/worker/src/plan-citations.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const repositories = [{ path: "repo/app" }, { path: "repo/web" }];

function cite(item: { path?: string; startLine: number; endLine: number; anchor?: string }): PlanDocument {
  return planDocument({ claims: [{ id: "1", text: "A claim.", evidence: [{ kind: "code", path: "repo/app/README.md", ...item }] }] });
}

/** A reader over fixed files, keyed by the absolute path under /ws. */
function reader(files: Record<string, string[]>) {
  return async (path: string): Promise<CitedFile | undefined> => {
    const lines = files[path.replace("/ws/", "")];
    return lines === undefined ? undefined : { lineCount: lines.length, lines };
  };
}

/** A 271-line README whose License heading is on line 260. */
function readme(): string[] {
  const lines = Array.from({ length: 271 }, (_, index) => `line ${index + 1}`);
  lines[259] = "## License";
  return lines;
}

const range = (plan: PlanDocument) => {
  const item = plan.claims[0]!.evidence![0]!;
  return item.kind === "code" ? [item.startLine, item.endLine] : [];
};
const check = (plan: PlanDocument, files: Record<string, string[]> = { "repo/app/README.md": readme() }) => checkCodeCitations(plan, "/ws", repositories, reader(files));

describe("checkCodeCitations", () => {
  it("keeps a range whose anchor is inside it", async () => {
    const plan = cite({ startLine: 255, endLine: 270, anchor: "## License" });
    const result = await check(plan);
    expect(result.issues).toEqual([]);
    expect(result.plan).toEqual(plan);
  });

  it("matches a line with its trailing whitespace trimmed on both sides", async () => {
    const files = { "repo/app/README.md": ["alpha", "beta  ", "gamma"] };
    expect((await check(cite({ startLine: 1, endLine: 3, anchor: "beta" }), files)).issues).toEqual([]);
    expect((await check(cite({ startLine: 1, endLine: 3, anchor: "gamma \t" }), files)).issues).toEqual([]);
    expect((await check(cite({ startLine: 1, endLine: 3, anchor: " beta" }), files)).issues).toEqual([expect.stringContaining("the anchor line is not in the file")]);
  });

  it("matches the anchor of a tab-indented line, with its leading tabs and without trailing whitespace", async () => {
    const files = { "repo/app/README.md": ["func main() {", "\tif ok {", "\t\treturn", "\t}", "}"].map((line, index) => (index === 2 ? `${line}\t ` : line)) };
    const inside = await check(cite({ startLine: 1, endLine: 4, anchor: "\t\treturn" }), files);
    expect(inside).toEqual({ plan: cite({ startLine: 1, endLine: 4, anchor: "\t\treturn" }), issues: [] });
    const elsewhere = await check(cite({ startLine: 4, endLine: 5, anchor: "\t\treturn" }), files);
    expect(elsewhere.issues).toEqual([]);
    expect(range(elsewhere.plan)).toEqual([3, 4]);
    // The tabs are part of the line: the same words without them are not the line.
    expect((await check(cite({ startLine: 1, endLine: 4, anchor: "return" }), files)).issues).toEqual([expect.stringContaining("the anchor line is not in the file")]);
  });

  it("moves a range to its anchor when the anchor is on one other line, keeping the length (the License heading cited at 221-236)", async () => {
    const result = await check(cite({ startLine: 221, endLine: 236, anchor: "## License" }));
    expect(result.issues).toEqual([]);
    // 15 lines long and the file ends at 271, so the range ends there and still covers line 260.
    expect(range(result.plan)).toEqual([256, 271]);
    const early = await check(cite({ startLine: 10, endLine: 15, anchor: "## License" }));
    expect(range(early.plan)).toEqual([260, 265]);
  });

  it("names the citation when the anchor is not in the file", async () => {
    const result = await check(cite({ startLine: 221, endLine: 236, anchor: "## Licence" }));
    expect(result.issues).toEqual(["evidence 1#1 repo/app/README.md: the anchor line is not in the file; copy one exact line from the lines you cite"]);
    expect(range(result.plan)).toEqual([221, 236]);
  });

  it("names the citation when the anchor is on several lines and none is inside the range", async () => {
    const lines = readme();
    lines[9] = "## License";
    const result = await check(cite({ startLine: 100, endLine: 110, anchor: "## License" }), { "repo/app/README.md": lines });
    expect(result.issues).toEqual(["evidence 1#1 repo/app/README.md: the anchor line is not in the file; copy one exact line from the lines you cite"]);
    // With one of them inside the range, the range is right.
    const inside = await check(cite({ startLine: 255, endLine: 262, anchor: "## License" }), { "repo/app/README.md": lines });
    expect(inside.issues).toEqual([]);
    expect(range(inside.plan)).toEqual([255, 262]);
  });

  it("cuts an end past the last line to it, and asks again for a start past it", async () => {
    const clamped = await check(cite({ startLine: 260, endLine: 290 }));
    expect(clamped.issues).toEqual([]);
    expect(range(clamped.plan)).toEqual([260, 271]);
    const past = await check(cite({ startLine: 272, endLine: 280 }));
    expect(past.issues).toEqual(["evidence 1#1 repo/app/README.md: the file has 271 lines; cite lines inside it"]);
    // The anchor cannot rescue a start past the end.
    expect((await check(cite({ startLine: 272, endLine: 280, anchor: "## License" }))).issues).toHaveLength(1);
  });

  it("only cuts the end for a citation without an anchor", async () => {
    const result = await check(cite({ startLine: 5, endLine: 8 }));
    expect(result).toEqual({ plan: cite({ startLine: 5, endLine: 8 }), issues: [] });
  });

  it("says the file does not exist for a missing file or a path outside the repositories", async () => {
    const missing = await check(cite({ path: "repo/app/ABSENT.md", startLine: 1, endLine: 2 }));
    expect(missing.issues).toEqual(["evidence 1#1 repo/app/ABSENT.md: the file does not exist in the workspace"]);
    const outside = await check(cite({ path: "repo/application/README.md", startLine: 1, endLine: 2 }), { "repo/application/README.md": ["x"] });
    expect(outside.issues).toEqual(["evidence 1#1 repo/application/README.md: the file does not exist in the workspace"]);
    const elsewhere = await check(cite({ path: "payments/src/charge.ts", startLine: 1, endLine: 2 }));
    expect(elsewhere.issues).toEqual(["evidence 1#1 payments/src/charge.ts: the file does not exist in the workspace"]);
  });

  it("reaches citations in nested claims and keeps the evidence index", async () => {
    const plan = planDocument({ claims: [{ id: "1", text: "A.", children: [{ id: "1.1", text: "B.", evidence: [
      { kind: "quote", text: "q", author: "Sam" },
      { kind: "code", path: "repo/app/README.md", startLine: 1, endLine: 400 },
    ] }] }] });
    const result = await check(plan);
    expect(result.plan.claims[0]!.children![0]!.evidence![1]).toMatchObject({ startLine: 1, endLine: 271 });
    const bad = await check({ ...plan, claims: [{ ...plan.claims[0]!, children: [{ ...plan.claims[0]!.children![0]!, evidence: [
      plan.claims[0]!.children![0]!.evidence![0]!, { kind: "code", path: "repo/app/NOPE.md", startLine: 1, endLine: 2 },
    ] }] }] });
    expect(bad.issues).toEqual(["evidence 1.1#2 repo/app/NOPE.md: the file does not exist in the workspace"]);
  });
});

describe("withCorrectedRanges", () => {
  it("writes the corrected ranges into the last agentx-plan block and leaves the rest of the answer, checks included", async () => {
    const plan = cite({ startLine: 221, endLine: 236, anchor: "## License" });
    const answer = planAnswer(plan, { checks: { checks: [{ label: "Tests", cwd: "workspace/app", executable: "npm", args: ["test"], proves: ["1"] }] } });
    const corrected = (await check(plan)).plan;
    const next = withCorrectedRanges(`${answer}\nThat is all.`, corrected);
    expect(next).toContain("Here is the plan.");
    expect(next.endsWith("\n```\n\nThat is all.")).toBe(true);
    const block = new RegExp(`\`\`\`${PLAN_DOCUMENT_INFO_STRING}\\n([\\s\\S]*?)\\n\`\`\``, "u").exec(next)![1]!;
    const json = JSON.parse(block) as { claims: Array<{ evidence: Array<{ startLine: number; endLine: number; anchor: string }> }>; checks: unknown };
    expect(json.claims[0]!.evidence[0]).toMatchObject({ startLine: 256, endLine: 271, anchor: "## License" });
    expect(json.checks).toMatchObject({ checks: [{ label: "Tests" }] });
  });
});

describe("citedFileReader", () => {
  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "agentx-citations-"));
    await mkdir(join(root, "repo/app"), { recursive: true });
    return root;
  }

  it("counts lines the way the evidence page does, and refuses a path that leaves the workspace", async () => {
    const root = await workspace();
    await writeFile(join(root, "repo/app/a.txt"), "one\r\ntwo\nthree\n");
    await writeFile(join(root, "repo/app/empty.txt"), "");
    await writeFile(join(tmpdir(), "agentx-citations-outside.txt"), "secret\n");
    await symlink(join(tmpdir(), "agentx-citations-outside.txt"), join(root, "repo/app/link.txt"));
    const read = citedFileReader(root);
    expect(await read(join(root, "repo/app/a.txt"))).toEqual({ lineCount: 3, lines: ["one", "two", "three"] });
    expect(await read(join(root, "repo/app/empty.txt"))).toEqual({ lineCount: 0, lines: [] });
    expect(await read(join(root, "repo/app/link.txt"))).toBeUndefined();
    expect(await read(join(root, "repo/app/missing.txt"))).toBeUndefined();
    expect(await read(join(root, "repo/app"))).toBeUndefined();
  });

  it("counts the lines of a file over 2 MB without holding it, and gives no lines to check", async () => {
    const root = await workspace();
    const line = `${"x".repeat(1023)}\n`;
    await writeFile(join(root, "repo/app/big.txt"), `${line.repeat(2_100)}tail`);
    expect(await citedFileReader(root)(join(root, "repo/app/big.txt"))).toEqual({ lineCount: 2_101, lines: undefined });
  });
});

// The task controls the cited files. In a devcontainer project its code can run while the plan
// is checked and flip one between a real file and a link to a worker file; the read must never follow that link. The walk
// needs /proc/self/fd, so this runs on Linux (CI).
(process.platform === "linux" ? describe : describe.skip)("citedFileReader on files the task flips to links", () => {
  async function workspace() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-citations-flip-")));
    await mkdir(join(root, "repo/app/src"), { recursive: true });
    await mkdir(join(root, "repo/web"), { recursive: true });
    return root;
  }

  it("never reads a worker file, however the flips fall", async () => {
    const root = await workspace();
    const secret = join(root, "worker-secret.txt");
    await writeFile(secret, Array.from({ length: 7 }, (_, index) => `WORKER-SECRET ${index + 1}`).join("\n"));
    const target = join(root, "repo/app/src/x.ts");
    const real = "real line 1\nreal line 2\nreal line 3\n";
    await writeFile(target, real);
    let flipping = true;
    const flipper = (async () => {
      let toSecret = true;
      while (flipping) {
        const temporary = join(root, "repo/app/src/x.ts.flip");
        await rm(temporary, { force: true });
        if (toSecret) await symlink(secret, temporary); else await writeFile(temporary, real);
        await rename(temporary, target).catch(() => undefined);
        toSecret = !toSecret;
        await new Promise<void>((done) => { const wait = Math.random() * 2; if (wait < 0.4) setImmediate(done); else setTimeout(done, wait); });
      }
    })();
    // The control: the plain filesystem API does reach the secret while it flips.
    let naiveLeaks = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await readFile(target, "utf8").catch(() => "")).startsWith("WORKER-SECRET")) naiveLeaks += 1;
    }
    expect(naiveLeaks).toBeGreaterThan(0);
    const read = citedFileReader(root, repositories);
    const results: Array<CitedFile | undefined> = [];
    const readable = () => results.filter((result) => result !== undefined).length;
    for (let attempt = 0; attempt < 5_000 && (attempt < 300 || readable() < 3); attempt += 1) results.push(await read(target));
    flipping = false;
    await flipper;
    expect(JSON.stringify(results)).not.toContain("WORKER-SECRET");
    for (const result of results) if (result !== undefined) expect(result).toEqual({ lineCount: 3, lines: ["real line 1", "real line 2", "real line 3"] });
    // Some reads got the real file and some were refused: the flips really fell both ways.
    expect(readable()).toBeGreaterThan(0);
    expect(results.some((result) => result === undefined)).toBe(true);
  }, 60_000);

  it("reads only within the repository that holds the file: a link out, into a sibling repository, or a repository folder made a link", async () => {
    const root = await workspace();
    await writeFile(join(root, "repo/web/y.ts"), "web line\n");
    await writeFile(join(root, "repo/app/src/ok.ts"), "ok line\n");
    await symlink("../../web/y.ts", join(root, "repo/app/src/to-sibling.ts"));
    await symlink("src/ok.ts", join(root, "repo/app/inside.ts"));
    const read = citedFileReader(root, repositories);
    expect(await read(join(root, "repo/app/src/ok.ts"))).toEqual({ lineCount: 1, lines: ["ok line"] });
    expect(await read(join(root, "repo/app/inside.ts"))).toEqual({ lineCount: 1, lines: ["ok line"] });
    expect(await read(join(root, "repo/app/src/to-sibling.ts"))).toBeUndefined();
    expect(await read(join(root, "repo/app"))).toBeUndefined();
    expect(await read(join(root, "elsewhere/file.ts"))).toBeUndefined();
    await rm(join(root, "repo/web"), { recursive: true });
    await mkdir(join(root, "outside-repo"));
    await writeFile(join(root, "outside-repo/y.ts"), "outside\n");
    await symlink(join(root, "outside-repo"), join(root, "repo/web"));
    expect(await read(join(root, "repo/web/y.ts"))).toBeUndefined();
  });

  it("counts the lines of a file over 2 MB by streaming, through the same walk, and checks citations with it", async () => {
    const root = await workspace();
    const line = `${"x".repeat(1023)}\n`;
    await writeFile(join(root, "repo/app/big.txt"), `${line.repeat(2_100)}tail`);
    await writeFile(join(root, "repo/app/README.md"), Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
    expect(await citedFileReader(root, repositories)(join(root, "repo/app/big.txt"))).toEqual({ lineCount: 2_101, lines: undefined });
    const checked = await checkCodeCitations(cite({ startLine: 3, endLine: 99 }), root, repositories);
    expect(checked.issues).toEqual([]);
    expect(range(checked.plan)).toEqual([3, 12]);
  });
});
