import "./mutation-spot-offline.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MeasuresFileEntrySchema } from "../../packages/contracts/src/measures-file.js";
import { MUTATION_SPOT_LIMITS, mutationMeasureEntry, mutationSentence, planMutants, type MutationSpotResult } from "../../packages/contracts/src/mutation-spot.js";

const all = (path: string) => [{ path, hunks: [[1, 100_000] as const] }];
const plan = (text: string, path = "src/value.ts") => planMutants([{ path, text }], all(path), "a".repeat(40));

describe("mutation spot planner", () => {
  it("mutates only worker-computed changed lines", () => {
    const result = planMutants([{ path: "a.ts", text: "const old = true;\nconst fresh = false;\n" }], [{ path: "a.ts", hunks: [[2, 2]] }], "seed");
    expect(result.mutants).toHaveLength(1);
    expect(result.mutants[0]).toMatchObject({ line: 2, replacement: "true", operator: "boolean" });
  });
  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])("lexes %s without touching strings, comments, regex, generics, JSX, decorators or type-only lines", (ext) => {
    const text = ['const quoted = "true && 1";', "// false || 2", "/* true", "false */", "const template = `x ${`nested ${true}`}`;", "const regex = /true|false/;", "const generic = f<T>(true);", "const jsx = <A enabled={true}/>;", "@decorate(true)", "type T = true | false;", "const ok = true;", "if (left < right && ready) return 2;"].join("\n");
    const result = plan(text, `source.${ext}`);
    expect(result.mutants.length).toBeGreaterThanOrEqual(4);
    expect(result.mutants.every((m) => m.line >= 11)).toBe(true);
  });
  it("lexes Python single, double, raw and triple strings and comments", () => {
    const text = ['a = "True and 1"', "b = r'True or 2'", 'c = """False', 'True"""', "# True and 1", "ready = True", "if a < b and ready: return 2"].join("\n");
    const result = plan(text, "value.py");
    expect(result.mutants.length).toBeGreaterThanOrEqual(4);
    expect(result.mutants.every((m) => m.line >= 6)).toBe(true);
  });
  it("conservatively skips Python f-string files and multiline type declarations", () => {
    expect(plan('s = f"{f\'inner {True}\'}"\nflag = True', "value.py").mutants).toEqual([]);
    expect(plan("interface T {\n flag: true;\n}\nconst yes = true;").mutants).toEqual([]);
  });
  it("spreads reproducible choices across files and operators, with 5-10 when available", () => {
    const files = Array.from({ length: 20 }, (_, n) => ({ path: `${n}.ts`, text: "const yes = true;\nif (a < b && ready) return 2;\n" }));
    const changed = files.map(({ path }) => all(path)[0]!);
    const first = planMutants(files, changed, "seed");
    expect(first).toEqual(planMutants([...files].reverse(), changed, "seed"));
    expect(first.mutants).toHaveLength(10);
    expect(new Set(first.mutants.map((m) => m.path)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(first.mutants.map((m) => m.operator)).size).toBeGreaterThanOrEqual(3);
  });
  it("enforces file, byte, line and mutant caps even with invalid overrides", () => {
    expect(plan("a".repeat(401) + " = true;").mutants).toEqual([]);
    expect(plan("// " + "a".repeat(MUTATION_SPOT_LIMITS.maxFileBytes) + "\nconst yes = true;").mutants).toEqual([]);
    const files = Array.from({ length: 21 }, (_, n) => ({ path: `${n}.ts`, text: "const yes = true;" }));
    const result = planMutants(files, files.map(({ path }) => all(path)[0]!), "seed", { maxMutants: Infinity, maxFiles: 100 });
    expect(result.mutants.length).toBeLessThanOrEqual(10);
    expect(result.filesScanned).toBeLessThanOrEqual(20);
  });
  it("refuses other languages", () => {
    expect(plan("flag = true", "value.go")).toMatchObject({ reason: "unsupported_language", mutants: [] });
  });
  it.each(["x".repeat(513), "secret\n.ts", "x\u202e.ts", "x\ufe0f.ts", "x\u200b.ts"])("fingerprints refused paths without echoing them", (path) => {
    const result = plan("const yes = true;", path);
    expect(result).toMatchObject({ reason: "path_refused", refusals: [{ fingerprint: createHash("sha256").update(path).digest("hex") }] });
    expect(JSON.stringify(result)).not.toContain(path);
  });
  it.each(["x".repeat(1024 * 1024), '"'.repeat(1_000_000), "`" + "${`".repeat(200_000)])("bounds adversarial lexing by a linear step counter", (text) => {
    const result = plan(text);
    expect(result.steps).toBeLessThanOrEqual(text.length * 4 + 1);
    expect(result.mutants).toEqual([]);
  });
  it("renders only finite bounded counts and accepts A4's measures entry", () => {
    const result: MutationSpotResult = { status: "completed", trustedAfter: true, caught: 7, counted: 8, mutants: [], refusals: [] };
    expect(mutationSentence(result)).toBe("new tests caught 7 of 8 changes");
    expect(MeasuresFileEntrySchema.parse(mutationMeasureEntry(result))).toEqual({ name: "mutants caught", unit: "mutants", value: 7, count: 8, direction: "up_good" });
    expect(mutationMeasureEntry({ ...result, caught: NaN })).toBeUndefined();
    expect(mutationMeasureEntry({ ...result, trustedAfter: false })).toBeUndefined();
    expect(mutationSentence({ ...result, status: "not_run", reason: "no_results", caught: 0, counted: 0 })).toBe("not run: no mutation produced a usable test result");
    expect(mutationSentence({ ...result, status: "not_run", reason: "unsupported_language" })).toBe("not run: the mutation spot check covers TypeScript, JavaScript and Python today");
  });
});
