import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildImportGraph, selectTests, type SelectionInput } from "../../packages/worker/src/verification/selection.js";

const now = new Date("2026-11-05T12:00:00.000Z");
const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  config: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  check: { id: "unit", selectArgs: ["{tests}"] }, changes: [], inventory: [],
  coverageMap: { builtAt: now.toISOString(), files: {} }, now, ...over,
});

function goldenPayload() {
  const inventory = ["tests/α.py::test_z", "tests/space name.py::test_a", "tests/dup.py::a", "tests/dup.py::b"];
  const selectionCases = [
    selectTests(input()),
    selectTests(input({ inventory: ["tests/one.py::test"], changes: [{ path: "tests/one.py", status: "added" }] })),
    selectTests(input({ inventory, changes: [{ path: "src/shared.py", status: "modified" }, { path: "src/odd #雪.py", status: "modified" }], coverageMap: { builtAt: now.toISOString(), files: { "src/shared.py": ["tests/dup.py::b", "tests/dup.py::a", "tests/dup.py::b", "elsewhere::gone"], "src/odd #雪.py": ["tests/α.py::test_z"] } } })),
    selectTests(input({ config: { method: "declared", alwaysRun: [], fullSuiteOn: [], declared: [{ glob: "src/**", tests: ["tests/dup.py"] }, { glob: "src/shared.py", tests: ["tests/α.py"] }] }, inventory, changes: [{ path: "src/shared.py", status: "modified" }] })),
    selectTests(input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, inventory: ["tests/test_1.py::x", "tests/test_2.py::x", "tests/test_3.py::x"], importGraph: buildImportGraph([{ path: "tests/test_1.py", text: "import a\n" }, { path: "tests/test_2.py", text: "import b\n" }, { path: "tests/test_3.py", text: "import c\n" }, { path: "a.py", text: "import b\n" }, { path: "b.py", text: "import a\n" }, { path: "c.py", text: "" }]), changes: [{ path: "a.py", status: "modified" }] })),
  ];
  const graph = buildImportGraph([
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
  return { selectionCases, graph: [...graph].map(([path, edges]) => [path, [...edges]]), largeGraph: [...largeGraph].map(([path, edges]) => [path, [...edges]]), largeSelection };
}

describe("selection output golden", () => {
  it("records exact results across selection and import graph edge cases", () => {
    const serialized = JSON.stringify(goldenPayload());
    expect(createHash("sha256").update(serialized).digest("hex")).toBe("90e7338c5636222bf0aa88e7d9acc2e2b19fe423d8188c014fbf86420e19ec13");
  });
});
