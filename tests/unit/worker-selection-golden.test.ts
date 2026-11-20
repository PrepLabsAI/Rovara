import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildImportGraph, selectTests, type SelectionInput } from "../../packages/worker/src/verification/selection.js";

const now = new Date("2026-11-05T12:00:00.000Z");
const inventory = Array.from({ length: 12 }, (_, index) => `tests/test_${String(index)}.py::test`);
const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  config: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  check: { id: "unit", selectArgs: ["{tests}"] }, changes: [], inventory,
  coverageMap: { builtAt: now.toISOString(), files: {} }, now, ...over,
});
const importInput = (importGraph: SelectionInput["importGraph"], path: string, testInventory = inventory) =>
  input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, coverageMap: undefined, importGraph, inventory: testInventory, changes: [{ path, status: "modified" }] });

function goldenPayload() {
  const duplicateCoverage = selectTests(input({
    changes: [{ path: "src/shared.py", status: "modified" }],
    coverageMap: { builtAt: now.toISOString(), files: { "src/shared.py": [inventory[1]!, inventory[0]!, inventory[1]!, "elsewhere::gone"] } },
  }));

  const tieGraph = buildImportGraph([
    { path: "tests/test_2.py", text: "import util\n" },
    { path: "a/util.py", text: "" },
    { path: "b/util.py", text: "" },
  ]);
  const initGraph = buildImportGraph([
    { path: "tests/test_3.py", text: "import pkg\n" },
    { path: "vendor/pkg/__init__.py", text: "" },
  ]);
  const srcRootGraph = buildImportGraph([
    { path: "tests/test_4.py", text: "import target\n" },
    { path: "src/target.py", text: "" },
  ]);
  const srcFallbackGraph = buildImportGraph([
    { path: "tests/test_5.py", text: "import src.target\n" },
    { path: "src/target.py", text: "" },
  ]);
  const cycleGraph = buildImportGraph([
    { path: "tests/test_6.py", text: "import a\n" },
    { path: "tests/test_7.py", text: "import unrelated\n" },
    { path: "a.py", text: "import b\n" },
    { path: "b.py", text: "import a\n" },
    { path: "unrelated.py", text: "" },
  ]);

  // The old path predicate also finds `/c.py` inside `c.pyx`, so lib/c.py wins over the importing file's own root.
  const extensionGraph = buildImportGraph([
    { path: "lib/c.pyx", text: "" },
    { path: "café/x y/c.py", text: "import c\n" },
    { path: "lib/c.py", text: "" },
    { path: "tests/test_8.py", text: "import c\n" },
  ]);
  const stubGraph = buildImportGraph([
    { path: "stubs/widget.pyi", text: "" },
    { path: "tests/test_9.py", text: "import widget\n" },
    { path: "src/widget.py", text: "" },
  ]);
  const pycGraph = buildImportGraph([
    { path: "lib/cache.pyc", text: "" },
    { path: "tests/test_10.py", text: "import cache\n" },
    { path: "lib/cache.py", text: "" },
  ]);
  const backupGraph = buildImportGraph([
    { path: "lib/backup.py.bak", text: "" },
    { path: "tests/test_11.py", text: "import backup\n" },
    { path: "lib/backup.py", text: "" },
  ]);
  const leadingSlashGraph = buildImportGraph([
    { path: "/pkg/b/util/__init__.py", text: "" },
    { path: "tests/test_0.py", text: "import util\n" },
    { path: "repo/util.py", text: "" },
  ]);

  const selectionCases = [
    duplicateCoverage,
    selectTests(importInput(tieGraph, "a/util.py", [inventory[2]!, ...inventory.filter((_, index) => index !== 2)])),
    selectTests(importInput(initGraph, "vendor/pkg/__init__.py")),
    selectTests(importInput(srcRootGraph, "src/target.py")),
    selectTests(importInput(srcFallbackGraph, "src/target.py")),
    selectTests(importInput(cycleGraph, "b.py")),
    selectTests(importInput(extensionGraph, "lib/c.py")),
    selectTests(importInput(stubGraph, "src/widget.py")),
    selectTests(importInput(pycGraph, "lib/cache.py")),
    selectTests(importInput(backupGraph, "lib/backup.py")),
    selectTests(importInput(leadingSlashGraph, "/pkg/b/util/__init__.py")),
  ];

  const oddGraph = buildImportGraph([
    { path: "src/a.py", text: "from . import b\nfrom pkg import leaf\n" },
    { path: "src/b.py", text: "import café.helper\n" },
    { path: "vendor/café/helper.py", text: "" },
    { path: "pkg/__init__.py", text: "" },
    { path: "pkg/leaf.py", text: "" },
    { path: "a+b.py", text: "" },
    { path: "src/odd #雪.ts", text: 'import { x } from "./a+b.js";\n' },
    { path: "src/a+b.ts", text: "" },
  ]);
  const chain = Array.from({ length: 3_000 }, (_, index) => ({ path: `m${String(index)}.py`, text: index === 0 ? "" : `import m${String(index - 1)}\n` }));
  const largeGraph = buildImportGraph(chain);
  const largeSelection = selectTests(input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, inventory: chain.map(({ path }) => `${path}::t`), importGraph: largeGraph, changes: [{ path: "m0.py", status: "modified" }] }));
  return { selectionCases, oddGraph: [...oddGraph].map(([path, edges]) => [path, [...edges]]), largeGraph: [...largeGraph].map(([path, edges]) => [path, [...edges]]), largeSelection };
}

describe("selection output golden", () => {
  it("records readable results across selection and import graph edge cases", () => {
    const { selectionCases, oddGraph, largeGraph, largeSelection } = goldenPayload();
    expect(selectionCases).toEqual([
      { mode: "selected", tests: [inventory[0], inventory[1]], selection: { method: "coverage_map", selected: 2, total: 12, mapAgeHours: 0 } },
      { mode: "selected", tests: [inventory[2]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[3]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[4]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[5]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[6]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[8]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[9]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[10]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[11]], selection: { method: "import_graph", selected: 1, total: 12 } },
      { mode: "selected", tests: [inventory[0]], selection: { method: "import_graph", selected: 1, total: 12 } },
    ]);
    expect(oddGraph).toEqual([
      ["src/a.py", ["src/b.py", "pkg/__init__.py", "pkg/leaf.py"]],
      ["src/b.py", []], // `café.helper` is not resolved as a root-relative import by this static resolver.
      ["vendor/café/helper.py", []],
      ["pkg/__init__.py", []],
      ["pkg/leaf.py", []],
      ["a+b.py", []],
      ["src/odd #雪.ts", ["src/a+b.ts"]],
      ["src/a+b.ts", []],
    ]);
    expect(createHash("sha256").update(JSON.stringify(largeGraph)).digest("hex")).toBe("f1649abe2c4127b43a609a9bb6361d1951136fad4fce275ef5af8e6833a3e893");
    expect(largeSelection).toEqual({ mode: "selected", tests: ["m0.py::t"], selection: { method: "import_graph", selected: 1, total: 3000 } });
  });
});

describe("rare source-root shapes (REVIEW-1 re-check Lows), recorded from the original selection.ts (a389a040d)", () => {
  const edgesOf = (files: Array<{ path: string; text: string }>, from: string) => [...(buildImportGraph(files).get(from) ?? [])].sort();
  it("a module named twice in one path counts only its first occurrence", () => {
    expect(edgesOf([{ path: "tests/test_9.py", text: "import b\nimport pkg\n" }, { path: "a/b.py/b.py", text: "" }, { path: "a/a.pyx/pkg.pyi/pkg.py", text: "" }, { path: "b.py", text: "" }], "tests/test_9.py")).toEqual(EXPECTED_TWICE);
  });
});
const EXPECTED_TWICE = ["b.py"];
