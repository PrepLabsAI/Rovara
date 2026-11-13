// Setup and test health SH31 (Go): the Go detector. Values are cited, a nested module or an unreadable workspace is asked about and never guessed, a JUnit report is proposed only when go.mod itself names gotestsum,
// and no per-test selection is proposed (go test takes packages; the selection template is filled with test files).
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema } from "@rovara-code/contracts";
import { boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { goDirectives, readGoModuleRoots } from "../../packages/worker/src/env-detect/go.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const mod = (extra = "", head = "module example.com/acme/match\n\ngo 1.22.3\n"): string => `${head}${extra}`;
const TESTS: Files = { "match/match.go": "package match\n", "match/match_test.go": "package match\n" };
const byId = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.checks.find((check) => check.value.id === id);

describe("one module", () => {
  it("proposes go mod download, go build and go test with a cover profile, each cited, and no selection", async () => {
    const detection = await detect({ "go.mod": mod(), "go.sum": "", ...TESTS });
    expect(detection.setupCommands.map((item) => [item.value.executable, item.value.args, item.source])).toEqual([
      ["go", ["mod", "download"], { path: "go.mod", line: 1 }],
      ["go", ["build", "./..."], { path: "go.mod", line: 1 }],
    ]);
    const unit = byId(detection, "unit")!;
    expect(unit.value).toMatchObject({ kind: "test", command: { cwd: "service", executable: "go", args: ["test", "-coverprofile=coverage.out", "./..."], timeoutSeconds: 1_800 }, coveragePath: "coverage.out", coverageSource: "detector:go" });
    expect(unit.value.reportPath).toBeUndefined();
    expect(unit.value.selectArgs).toBeUndefined();
    expect(unit.source).toEqual({ path: "go.mod", line: 1 });
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["go.mod", "go.sum"]));
    expect(detection.notes.join(" ")).toContain("go test writes no report file");
    expect(detection.notes.join(" ")).toContain("no per-test selection");
    expect(detection.questions).toEqual([]);
  });
  it("cites the go and toolchain lines for the version the environment must provide", async () => {
    const detection = await detect({ "go.mod": mod("toolchain go1.22.5\n"), ...TESTS });
    expect(detection.notes.join(" ")).toContain("Go 1.22.3 or newer (go.mod line 3), and suggests the go1.22.5 toolchain (line 4)");
    const bad = await detect({ "go.mod": mod("", "module m\n\ngo $(evil)\n"), ...TESTS });
    expect(bad.notes.join(" ")).not.toContain("asks for Go");
  });
  it("skips the dependency download when a vendor directory is present, and treats it as a full-suite path", async () => {
    const detection = await detect({ "go.mod": mod(), "vendor/modules.txt": "# x\n", ...TESTS });
    expect(detection.setupCommands.map((item) => item.value.args)).toEqual([["build", "./..."]]);
    expect(detection.notes.join(" ")).toContain("vendor directory");
    expect(detection.fullSuiteOn.map((item) => item.value)).toContain("vendor/**");
  });
  it("proposes a JUnit report only when go.mod directly requires gotestsum, run at the version go.mod pins", async () => {
    const direct = await detect({ "go.mod": mod("\nrequire (\n\tgithub.com/x/y v1.0.0\n\tgotest.tools/gotestsum v1.11.0\n)\n"), ...TESTS });
    const unit = byId(direct, "unit")!;
    expect(unit.value).toMatchObject({ command: { executable: "go", args: ["run", "gotest.tools/gotestsum", "--junitfile", "gotestsum-junit.xml", "--", "-coverprofile=coverage.out", "./..."] }, reportPath: "gotestsum-junit.xml", reportSource: { path: "go.mod", line: 7 } });
    expect(unit.source).toEqual({ path: "go.mod", line: 7 });
    const indirect = await detect({ "go.mod": mod("\nrequire gotest.tools/gotestsum v1.11.0 // indirect\n"), ...TESTS });
    expect(byId(indirect, "unit")?.value.command.executable).toBe("go");
    expect(byId(indirect, "unit")?.value.command.args[0]).toBe("test");
    const lookalike = await detect({ "go.mod": mod("\nrequire gotest.tools/gotestsum-fork v1.11.0\n"), ...TESTS });
    expect(byId(lookalike, "unit")?.value.reportPath).toBeUndefined();
    const tool = await detect({ "go.mod": mod("\ntool gotest.tools/gotestsum\n"), ...TESTS });
    expect(byId(tool, "unit")?.value.reportPath).toBe("gotestsum-junit.xml");
  });
  it("proposes golangci-lint when its config is there, and says Rovara does not install it", async () => {
    const detection = await detect({ "go.mod": mod(), ".golangci.yml": "run: {}\n", ...TESTS });
    expect(byId(detection, "lint")?.value).toMatchObject({ kind: "lint", command: { executable: "golangci-lint", args: ["run", "./..."] } });
    expect(byId(detection, "lint")?.source).toEqual({ path: ".golangci.yml", line: 1 });
    expect(detection.notes.join(" ")).toContain("not installed by Rovara");
    expect(byId(await detect({ "go.mod": mod(), ...TESTS }), "lint")).toBeUndefined();
  });
  it("proposes setup but no test command when there are no test files, ignoring vendor and testdata", async () => {
    const detection = await detect({ "go.mod": mod(), "main.go": "package main\n", "vendor/x/x_test.go": "", "testdata/a_test.go": "" });
    expect(detection.checks).toEqual([]);
    expect(detection.setupCommands).toHaveLength(2);
    expect(detection.notes.join(" ")).toContain("No Go test files");
    expect(detection.fullSuiteOn.map((item) => item.value)).toContain("**/testdata/**");
  });
  it("asks and proposes nothing from a replace directive that points outside the repository", async () => {
    const detection = await detect({ "go.mod": mod("replace example.com/lib => ../lib\nreplace example.com/ok => ./third_party/ok\n"), ...TESTS });
    expect(detection.notes.join(" ")).toContain("go.mod line 4");
    expect(detection.notes.join(" ")).not.toContain("line 5");
    expect(detection.questions.join(" ")).toContain("outside the repository");
  });
  it("makes a proposal that passes the environment schema, with the coverage citation attached", async () => {
    const detection = await detect({ "go.mod": mod(), ...TESTS });
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
    expect(draft.environment.repos[0]?.checks[0]).toMatchObject({ id: "unit", coveragePath: "coverage.out" });
    expect(draft.environment.repos[0]?.checks[0]).not.toHaveProperty("selectArgs");
    expect(draft.valueSources).toEqual(expect.arrayContaining([{ field: "repos[0].checks[0].coveragePath", source: "detector:go" }]));
  });
});

describe("nested modules and workspaces", () => {
  it("lists nested modules the root pattern skips and asks which to test, ignoring fixtures under testdata", async () => {
    const detection = await detect({ "go.mod": mod(), ...TESTS, "tools/go.mod": "module t\n", "tools/t_test.go": "", "testdata/fixture/go.mod": "module f\n", "empty/go.mod": "module e\n" });
    expect(byId(detection, "unit")?.value.command.args).toEqual(["test", "-coverprofile=coverage.out", "./..."]);
    expect(detection.notes.join(" ")).toContain("2 nested modules (empty, tools)");
    expect(detection.questions.join(" ")).toContain("skips tools");
    expect(detection.questions.join(" ")).not.toContain("empty");
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["**/go.mod", "**/go.sum"]));
  });
  it("asks where the module is when go.mod files are only in subfolders", async () => {
    const detection = await detect({ "svc/go.mod": mod(), "svc/a.go": "package a\n" });
    expect(detection.checks).toEqual([]);
    expect(detection.setupCommands).toEqual([]);
    expect(detection.questions.join(" ")).toContain("Which folder is the Go module tested from");
    expect(await detect({ "svc/go.mod": mod(), "README.md": "" })).toMatchObject({ questions: [], notes: [] });
  });
  it("builds and tests one pattern per used directory of a workspace, with no dependency download", async () => {
    const files: Files = { "go.work": "go 1.22\n\nuse (\n\t./api\n\t./lib // shared\n)\nuse ./cmd\n", "api/go.mod": "module api\n", "api/a_test.go": "", "lib/go.mod": "module lib\n", "cmd/go.mod": "module cmd\n" };
    const detection = await detect(files);
    expect(detection.setupCommands.map((item) => [item.value.args, item.source])).toEqual([[["build", "./api/...", "./lib/...", "./cmd/..."], { path: "go.work", line: 4 }]]);
    expect(byId(detection, "unit")?.value.command.args).toEqual(["test", "-coverprofile=coverage.out", "./api/...", "./lib/...", "./cmd/..."]);
    expect(detection.notes.join(" ")).toContain("The workspace has 3 modules: api, lib, cmd");
    expect(detection.notes.join(" ")).toContain("Go 1.22 or newer (go.work line 1)");
    expect(detection.fullSuiteOn.map((item) => item.value)).toContain("go.work");
  });
  it("tests only the used directories that have tests, and says when a used directory has no go.mod", async () => {
    const detection = await detect({ "go.work": "go 1.22\nuse ./lib\nuse ./ghost\n", "lib/go.mod": "module lib\n", "lib/a_test.go": "" });
    expect(detection.notes.join(" ")).toContain("uses ghost but no go.mod");
    expect((await detect({ "go.work": "go 1.22\nuse ./lib\n", "lib/go.mod": "module lib\n", "other/b_test.go": "" })).checks).toEqual([]);
  });
  it("uses ./... for the root module of a workspace", async () => {
    const detection = await detect({ "go.work": "go 1.22\nuse .\nuse ./lib\n", "go.mod": mod(), "a_test.go": "", "lib/go.mod": "module lib\n" });
    expect(byId(detection, "unit")?.value.command.args).toEqual(["test", "-coverprofile=coverage.out", "./...", "./lib/..."]);
  });
  it("proposes nothing and asks when a workspace uses a directory outside the repository, an odd path, or too many", async () => {
    for (const work of ["go 1.22\nuse ../shared\n", "go 1.22\nuse ./a b\n", "go 1.22\nuse /abs\n", "go 1.22\n", `go 1.22\n${Array.from({ length: 21 }, (_, n) => `use ./m${String(n)}`).join("\n")}\n`]) {
      const detection = await detect({ "go.work": work, "m0/x_test.go": "" });
      expect(detection.checks, work).toEqual([]);
      expect(detection.setupCommands, work).toEqual([]);
      expect(detection.questions.join(" "), work).toContain("Which Go modules of this workspace");
    }
  });
});

describe("goDirectives", () => {
  it("reads single-line and block forms with their lines, drops comments, and remembers // indirect", () => {
    const text = "module a // c\nrequire (\n\tx v1 // indirect\n\ty v2\n)\nrequire z v3\n// require nope v4\n";
    expect(goDirectives(text, "require")).toEqual([{ value: "x v1", line: 3, indirect: true }, { value: "y v2", line: 4, indirect: false }, { value: "z v3", line: 6, indirect: false }]);
    expect(goDirectives(text, "module")).toEqual([{ value: "a", line: 1, indirect: false }]);
    expect(goDirectives("godebug default=go1.21\n", "go")).toEqual([]);
  });
});

describe("a repository with no Go", () => {
  it("says nothing", async () => {
    expect(await detect({ "README.md": "hello" })).toMatchObject({ checks: [], setupCommands: [], questions: [], notes: [] });
  });
});

describe("readGoModuleRoots", () => {
  const roots = async (files: Files) => readGoModuleRoots(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader);
  it("gives the root module, or every used module of a workspace, with its directory", async () => {
    expect(await roots({ "go.mod": mod() })).toEqual([{ path: "example.com/acme/match", dir: "." }]);
    expect(await roots({ "go.work": "go 1.22\nuse (\n\t./api\n\t./lib\n)\n", "api/go.mod": "module example.com/acme/api\n", "lib/go.mod": 'module "example.com/acme/lib" // c\n' })).toEqual([{ path: "example.com/acme/api", dir: "api" }, { path: "example.com/acme/lib", dir: "lib" }]);
  });
  it("leaves out a module it cannot read, with an odd path, or a directory outside the repository; and reads nothing without go.mod or go.work", async () => {
    expect(await roots({ "go.work": "go 1.22\nuse ../x\nuse ./bad\nuse ./none\n", "bad/go.mod": "module has space\n" })).toEqual([]);
    expect(await roots({ "README.md": "" })).toEqual([]);
  });
});
