// vitest: fresh-modules (this file spies on console and runs the pipeline script as a process)
// L14 review: extra leak and fail-closed probes. Names are INVENTED and assembled at run time.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithAwsCli, runPipelineGuard } from "../../scripts/port-guard-pipeline.js";
import { PORT_GUARD_NAMES_PARAMETER_VARIABLE } from "../../infra/lib/port-guard-step.js";

const SECRET_NAME = ["qorv", "elland"].join("");
const PARAM = "/example/port-guard/names";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "port-guard-review-"));
  roots.push(dir);
  return dir;
};

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void out.push(args.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

/** A fake aws that succeeds, prints `value` on stdout and also the secret on stderr (stderr must be dropped). */
function fakeAws(value: string): string {
  const bin = scratch();
  writeFileSync(join(bin, "list.txt"), value);
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "warning ${SECRET_NAME}" >&2\ncat "${join(bin, "list.txt")}"\n`);
  chmodSync(join(bin, "aws"), 0o755);
  return bin;
}

describe("L14 review probes", () => {
  it("a whitespace-only list fails closed without starting the guard", () => {
    const guard = vi.fn(() => 0);
    for (const value of ["   \n\t\n", " # c\n  \n", "  None  \n"]) {
      expect(runPipelineGuard({ argv: [], env: { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM }, fetch: () => value, guard })).toBe(2);
    }
    expect(guard).not.toHaveBeenCalled();
  });

  it("a successful fetch drops the CLI's stderr", () => {
    const bin = fakeAws("abc\n");
    expect(fetchWithAwsCli(PARAM, { PATH: `${bin}:${process.env.PATH ?? ""}` })).toBe("abc\n");
  });

  it("a list line that is not a regular expression exits 2, never prints the line, and leaves no temp file", () => {
    const bin = fakeAws(`${SECRET_NAME}(unclosed\n`);
    const lane = scratch();
    const run = (...args: string[]): void => void spawnSync("git", args, { cwd: lane, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.invalid");
    run("config", "user.name", "t");
    writeFileSync(join(lane, "a.md"), "a\n");
    run("add", "a.md");
    run("commit", "-q", "-m", "a");
    const tmp = scratch();
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/port-guard-pipeline.ts"), "--range", "HEAD..HEAD"], {
      cwd: lane,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "", TMPDIR: tmp, [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: PARAM },
    });
    const text = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(2);
    expect(text).toContain("not a regular expression");
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain("clean");
    expect(readdirSync(tmp)).toEqual([]);
  });
});
