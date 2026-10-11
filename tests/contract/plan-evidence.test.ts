import { describe, expect, it, vi } from "vitest";
import { PlanEvidenceBundleSchema, type PlanClaim, type PlanDocument } from "@agentx/contracts";
import { resolvePlanEvidence } from "../../packages/broker/src/developer/plan-evidence.js";
import { planDocument } from "../support/plan-documents.js";

const COMMIT = "a".repeat(40);
const repositories = [
  { name: "app", path: "repo/app", url: "https://github.com/example/app.git" },
  { name: "lib", path: "repo/lib", url: "https://github.com/example/lib.git" },
];
const base = [{ repositoryId: "app", baseCommitSha: COMMIT }];

const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
const code = (path: string, startLine: number, endLine: number) => ({ kind: "code" as const, path, startLine, endLine });
const planWith = (...claims: PlanClaim[]): PlanDocument => planDocument({ claims, decisions: [] });
const one = (path: string, startLine = 1, endLine = 2) => planWith({ id: "1", text: "A claim.", evidence: [code(path, startLine, endLine)] });

describe("resolving the code a plan cites", () => {
  it("returns the cited lines and the commit they were read at", async () => {
    const readFile = vi.fn(async () => "one\ntwo\nthree\nfour\n");
    const bundle = await resolvePlanEvidence(one("repo/app/src/a.ts", 2, 3), { repositories, base, readFile });
    expect(bundle).toEqual({
      schemaVersion: 1,
      excerpts: [{ claimId: "1", index: 0, path: "repo/app/src/a.ts", startLine: 2, endLine: 3, status: "ok", commit: COMMIT, lines: ["two", "three"] }],
    });
    expect(readFile).toHaveBeenCalledWith("https://github.com/example/app.git", "src/a.ts", COMMIT, { untilLine: 3 });
    expect(PlanEvidenceBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("numbers each excerpt by its place in the claim's evidence, children included, skipping non-code evidence", async () => {
    const readFile = async () => "one\ntwo\nthree";
    const plan = planWith({
      id: "1", text: "Parent.",
      evidence: [{ kind: "quote", text: "q", author: "a" }, code("repo/app/a.ts", 1, 1)],
      children: [{ id: "1.1", text: "Child.", evidence: [code("repo/app/b.ts", 2, 3)] }],
    });
    const bundle = await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(bundle.excerpts.map(({ claimId, index, path }) => [claimId, index, path])).toEqual([["1", 1, "repo/app/a.ts"], ["1.1", 0, "repo/app/b.ts"]]);
  });

  it.each([
    ["a path outside every repository", "other/place/a.ts"],
    ["a path that climbs out", "repo/app/../lib/a.ts"],
    ["an absolute path", "/repo/app/a.ts"],
    ["a path that names only the repository", "repo/app"],
    ["a repository with no base commit", "repo/lib/a.ts"],
  ])("marks %s as not found without asking GitHub", async (_label, path) => {
    const readFile = vi.fn(async () => "x");
    const bundle = await resolvePlanEvidence(one(path), { repositories, base, readFile });
    expect(bundle.excerpts).toHaveLength(1);
    expect(bundle.excerpts[0]).toMatchObject({ status: "not_found" });
    expect(bundle.excerpts[0]).not.toHaveProperty("lines");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("marks a missing base as not found", async () => {
    const readFile = vi.fn(async () => "x");
    const bundle = await resolvePlanEvidence(one("repo/app/a.ts"), { repositories, base: undefined, readFile });
    expect(bundle.excerpts[0]).toMatchObject({ status: "not_found" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not mistake a sibling directory for the repository", async () => {
    const readFile = vi.fn(async () => "x");
    const bundle = await resolvePlanEvidence(one("repo/application/a.ts"), { repositories, base, readFile });
    expect(bundle.excerpts[0]).toMatchObject({ status: "not_found" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("marks a missing file as not found and shows a range that runs past the end through the last line", async () => {
    const files: Record<string, string> = { "present.ts": "one\ntwo\nthree" };
    const readFile = async (_url: string, path: string) => files[path];
    const plan = planWith(
      { id: "1", text: "Missing file.", evidence: [code("repo/app/absent.ts", 1, 2)] },
      { id: "2", text: "Runs past the end.", evidence: [code("repo/app/present.ts", 2, 4)] },
      { id: "3", text: "Last line.", evidence: [code("repo/app/present.ts", 3, 3)] },
    );
    const bundle = await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual(["not_found", "ok", "ok"]);
    expect(bundle.excerpts[1]).toMatchObject({ startLine: 2, endLine: 3, lines: ["two", "three"] });
    expect(bundle.excerpts[2]?.lines).toEqual(["three"]);
    // A real repository at a known base says which commit the place was missing from.
    expect(bundle.excerpts.map((excerpt) => excerpt.commit)).toEqual([COMMIT, COMMIT, COMMIT]);
  });

  it("gives no commit when the place was never looked up: no repository, a bad path or no base", async () => {
    for (const [path, withBase] of [["other/place/a.ts", base], ["repo/app/../lib/a.ts", base], ["repo/lib/a.ts", base], ["repo/app/a.ts", undefined]] as const) {
      const bundle = await resolvePlanEvidence(one(path), { repositories, base: withBase, readFile: async () => "x" });
      expect(bundle.excerpts[0]).toMatchObject({ status: "not_found" });
      expect(bundle.excerpts[0]).not.toHaveProperty("commit");
    }
  });

  it("marks a read that throws as unavailable and keeps the other excerpts", async () => {
    const readFile = async (_url: string, path: string) => {
      if (path === "boom.ts") throw new Error("GitHub is down");
      return "one\ntwo";
    };
    const plan = planWith(
      { id: "1", text: "Fails.", evidence: [code("repo/app/boom.ts", 1, 1)] },
      { id: "2", text: "Works.", evidence: [code("repo/app/fine.ts", 1, 2)] },
    );
    const bundle = await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual(["unavailable", "ok"]);
    expect(JSON.stringify(bundle)).not.toContain("GitHub is down");
  });

  it("skips excerpts after the 40th", async () => {
    const readFile = vi.fn(async () => "one\ntwo");
    const claims: PlanClaim[] = Array.from({ length: 21 }, (_, index) => ({
      id: String(index + 1), text: "A claim.",
      evidence: [code("repo/app/a.ts", 1, 1), code("repo/app/a.ts", 2, 2)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile });
    expect(bundle.excerpts).toHaveLength(42);
    expect(bundle.excerpts.filter((excerpt) => excerpt.status === "ok")).toHaveLength(40);
    expect(bundle.excerpts.slice(40).map((excerpt) => excerpt.status)).toEqual(["skipped", "skipped"]);
    expect(bundle.excerpts[41]).not.toHaveProperty("lines");
  });

  it("cuts a range of more than 80 lines to the first 80", async () => {
    const readFile = async () => numbered(200);
    const bundle = await resolvePlanEvidence(one("repo/app/a.ts", 11, 130), { repositories, base, readFile });
    const [excerpt] = bundle.excerpts;
    expect(excerpt?.lines).toHaveLength(80);
    expect(excerpt?.lines?.[0]).toBe("line 11");
    expect(excerpt?.lines?.[79]).toBe("line 90");
    expect(excerpt?.cut).toBe(true);
    const exact = await resolvePlanEvidence(one("repo/app/a.ts", 1, 80), { repositories, base, readFile });
    expect(exact.excerpts[0]?.lines).toHaveLength(80);
    expect(exact.excerpts[0]).not.toHaveProperty("cut");
  });

  it("cuts a long line to 300 characters ending in an ellipsis", async () => {
    const readFile = async () => `${"x".repeat(500)}\nshort`;
    const bundle = await resolvePlanEvidence(one("repo/app/a.ts", 1, 2), { repositories, base, readFile });
    const [first, second] = bundle.excerpts[0]?.lines ?? [];
    expect(first).toBe(`${"x".repeat(299)}…`);
    expect(first).toHaveLength(300);
    expect(second).toBe("short");
    expect(PlanEvidenceBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("reads a line ending of either kind and ignores the one at the end of the file", async () => {
    const readFile = async () => "one\r\ntwo\r\n";
    const bundle = await resolvePlanEvidence(one("repo/app/a.ts", 1, 2), { repositories, base, readFile });
    expect(bundle.excerpts[0]?.lines).toEqual(["one", "two"]);
  });

  it("reads each file at each commit once", async () => {
    const readFile = vi.fn(async () => "one\ntwo\nthree");
    const plan = planWith(
      { id: "1", text: "A.", evidence: [code("repo/app/a.ts", 1, 1), code("repo/app/a.ts", 2, 3)] },
      { id: "2", text: "B.", evidence: [code("repo/app/a.ts", 1, 3), code("repo/app/b.ts", 1, 1)] },
    );
    await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("asks for each file only up to the largest last line its excerpts cite, and builds every excerpt from that one read", async () => {
    const readFile = vi.fn<(url: string, path: string, commit: string, options: { untilLine: number }) => Promise<string | undefined>>(async () => numbered(40));
    const plan = planWith(
      { id: "1", text: "A.", evidence: [code("repo/app/a.ts", 1, 3), code("repo/app/a.ts", 10, 12)] },
      { id: "2", text: "B.", evidence: [code("repo/app/a.ts", 5, 6), code("repo/app/b.ts", 2, 4)] },
    );
    const bundle = await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(readFile.mock.calls.map(([, path, , options]) => [path, options.untilLine])).toEqual([["a.ts", 12], ["b.ts", 4]]);
    expect(bundle.excerpts.map((excerpt) => excerpt.lines)).toEqual([
      ["line 1", "line 2", "line 3"], ["line 10", "line 11", "line 12"], ["line 5", "line 6"], ["line 2", "line 3", "line 4"],
    ]);
  });

  it("marks a start past the end of the file as not found", async () => {
    const readFile = async () => "one\ntwo\nthree";
    const bundle = await resolvePlanEvidence(planWith({ id: "1", text: "Past.", evidence: [code("repo/app/present.ts", 4, 6)] }), { repositories, base, readFile });
    expect(bundle.excerpts[0]).toMatchObject({ status: "not_found", commit: COMMIT, startLine: 4, endLine: 6 });
    expect(bundle.excerpts[0]?.lines).toBeUndefined();
  });

  it("marks an excerpt past the end of a file that ended before the wanted line as not found", async () => {
    const readFile = vi.fn(async () => "one\ntwo");
    const bundle = await resolvePlanEvidence(planWith({ id: "1", text: "A.", evidence: [code("repo/app/a.ts", 1, 2), code("repo/app/a.ts", 5, 9)] }), { repositories, base, readFile });
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual(["ok", "not_found"]);
  });

  it("reads once even when the first read fails, and marks every excerpt of that file unavailable", async () => {
    const readFile = vi.fn(async () => { throw new Error("down"); });
    const plan = planWith({ id: "1", text: "A.", evidence: [code("repo/app/a.ts", 1, 1), code("repo/app/a.ts", 2, 2)] });
    const bundle = await resolvePlanEvidence(plan, { repositories, base, readFile });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual(["unavailable", "unavailable"]);
  });

  it("marks a read that never answers as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const readFile = () => new Promise<string | undefined>(() => undefined);
      const pending = resolvePlanEvidence(one("repo/app/a.ts"), { repositories, base, readFile });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await pending).excerpts[0]).toMatchObject({ status: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading when the time budget is spent and marks the rest unavailable", async () => {
    let clock = 1_000;
    const started: string[] = [];
    const readFile = async (_url: string, path: string) => {
      started.push(path);
      clock += 5_000;
      return "one\ntwo";
    };
    const claims: PlanClaim[] = Array.from({ length: 10 }, (_, index) => ({
      id: String(index + 1), text: "A claim.", evidence: [code(`repo/app/f${index}.ts`, 1, 1)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile, now: () => clock });
    expect(started).toHaveLength(4);
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual([...Array.from({ length: 4 }, () => "ok"), ...Array.from({ length: 6 }, () => "unavailable")]);
  });

  it("honours a different time budget", async () => {
    let clock = 0;
    const readFile = async () => { clock += 100; return "one"; };
    const claims: PlanClaim[] = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1), text: "A claim.", evidence: [code(`repo/app/f${index}.ts`, 1, 1)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile, now: () => clock, deadlineMs: 50 });
    expect(bundle.excerpts.map((excerpt) => excerpt.status)).toEqual(["ok", "ok", "ok", "ok", "unavailable", "unavailable"]);
  });

  it("reads at most four files at once", async () => {
    let active = 0;
    let peak = 0;
    const readFile = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "one";
    };
    const claims: PlanClaim[] = Array.from({ length: 12 }, (_, index) => ({
      id: String(index + 1), text: "A claim.", evidence: [code(`repo/app/f${index}.ts`, 1, 1)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile });
    expect(peak).toBe(4);
    expect(bundle.excerpts.every((excerpt) => excerpt.status === "ok")).toBe(true);
  });

  it("counts the bundle's size in bytes, not characters", async () => {
    const wide = Array.from({ length: 80 }, () => "日".repeat(99)).join("\n");
    const readFile = async () => wide;
    const claims: PlanClaim[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1), text: "A claim.", evidence: [code("repo/app/a.ts", 1, 80)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile });
    const json = JSON.stringify(bundle);
    expect(json.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(512 * 1024);
    const statuses = bundle.excerpts.map((excerpt) => excerpt.status);
    expect(statuses).toContain("ok");
    expect(statuses).toContain("skipped");
  });

  it("does not split a character when it cuts a long line", async () => {
    const readFile = async () => `${"x".repeat(298)}😀😀😀`;
    const bundle = await resolvePlanEvidence(one("repo/app/a.ts", 1, 1), { repositories, base, readFile });
    expect(bundle.excerpts[0]?.lines?.[0]).toBe(`${"x".repeat(298)}…`);
  });

  it("skips the excerpts that would take the bundle past 512 KB", async () => {
    const wide = Array.from({ length: 80 }, () => "y".repeat(299)).join("\n");
    const readFile = async () => wide;
    const claims: PlanClaim[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1), text: "A claim.", evidence: [code("repo/app/a.ts", 1, 80)],
    }));
    const bundle = await resolvePlanEvidence(planWith(...claims), { repositories, base, readFile });
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(512 * 1024);
    const statuses = bundle.excerpts.map((excerpt) => excerpt.status);
    expect(statuses).toContain("ok");
    const firstSkipped = statuses.indexOf("skipped");
    expect(firstSkipped).toBeGreaterThan(0);
    expect(statuses.slice(firstSkipped).every((status) => status === "skipped")).toBe(true);
    expect(bundle.excerpts).toHaveLength(30);
  });
});
