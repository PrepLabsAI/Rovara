// What the worker checks in a plan's code citations before posting it: the files, the anchor lines and the line ranges.
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
