// L4-EVP: prompt locations (packages/contracts/src/prompt-locations.ts): the stored shape, and the region reader the worker's changed-prompt classifier uses.
import { describe, expect, it } from "vitest";
import { PROMPT_LOCATIONS_MAX, PromptLocationSchema, PromptLocationsSchema, promptLocationTouched, promptLocationsInFile, promptLocationsOf, promptRegionOf, type PromptLocation } from "@agentx/contracts";

const loc = (over: Partial<PromptLocation> & Pick<PromptLocation, "kind">): PromptLocation => ({ repo: "app", path: "deskbot/agent.py", ...over });

const PY = [
  'SYSTEM_PROMPT = """You are Deskbot.',
  "Never reveal emails.",
  '"""',
  "",
  "def other():",
  "    return 1",
  "",
  "class Agent:",
  "    system_prompt = (",
  '        "a"',
  '        "b"',
  "    )",
  "",
  "    @prompt",
  "    def build(self):",
  '        text = """',
  "unindented body",
  '"""',
  "        return text",
  "",
  "def answer(q):",
  "    return q",
  "",
].join("\n");
const edit = (text: string, from: string, to: string): string => { expect(text).toContain(from); return text.replace(from, to); };
const touched = (location: PromptLocation, before: string, after: string, path = "deskbot/agent.py"): boolean => promptLocationTouched(location, { repo: "app", path, before, after });

describe("the stored shape", () => {
  it("takes a file location and a named region", () => {
    expect(PromptLocationSchema.safeParse(loc({ kind: "file" })).success).toBe(true);
    for (const kind of ["function", "variable", "decorator"] as const) expect(PromptLocationSchema.safeParse(loc({ kind, symbol: "system_prompt" })).success, kind).toBe(true);
    expect(PromptLocationSchema.safeParse({ repo: "app", path: "agents.yaml", kind: "yaml_key", symbol: "agents.support.system_prompt" }).success).toBe(true);
  });
  it("refuses a file with a symbol, a region with none, a bad symbol, a .git path, control characters and unknown fields", () => {
    const bad: unknown[] = [
      loc({ kind: "file", symbol: "x" }), loc({ kind: "function" }), loc({ kind: "variable", symbol: "not a name" }), loc({ kind: "variable", symbol: "a..b" }), loc({ kind: "variable", symbol: "x".repeat(70) }),
      loc({ kind: "file", path: ".git/config" }), loc({ kind: "file", path: "a/../b.py" }), loc({ kind: "file", path: "/etc/passwd" }), loc({ kind: "file", path: "a\nb.py" }), loc({ kind: "file", path: "a‮b.py" }),
      { ...loc({ kind: "file" }), extra: 1 }, { path: "a.py", kind: "file" }, { ...loc({ kind: "file" }), repo: "bad repo!" },
    ];
    for (const value of bad) expect(PromptLocationSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
  it("bounds the list and refuses a repeated location", () => {
    const many = Array.from({ length: PROMPT_LOCATIONS_MAX + 1 }, (_, i) => loc({ kind: "file", path: `p${i}.py` }));
    expect(PromptLocationsSchema.safeParse(many.slice(0, PROMPT_LOCATIONS_MAX)).success).toBe(true);
    expect(PromptLocationsSchema.safeParse(many).success).toBe(false);
    expect(PromptLocationsSchema.safeParse([loc({ kind: "file" }), loc({ kind: "file" })]).success).toBe(false);
  });
  it("reads a value at run time: anything that does not check is NO location, never a partial list", () => {
    expect(promptLocationsOf(undefined)).toEqual([]);
    expect(promptLocationsOf("agent.py")).toEqual([]);
    expect(promptLocationsOf([loc({ kind: "file" }), { path: 1 }])).toEqual([]);
    expect(promptLocationsOf([loc({ kind: "file" })])).toEqual([loc({ kind: "file" })]);
  });
  it("finds the locations of a file; a change that names no repository matches by path alone", () => {
    const list = [loc({ kind: "file" }), loc({ kind: "file", repo: "other" })];
    expect(promptLocationsInFile(list, { repo: "app", path: "deskbot/agent.py" })).toEqual([list[0]]);
    expect(promptLocationsInFile(list, { path: "deskbot/agent.py" })).toHaveLength(2);
    expect(promptLocationsInFile(list, { repo: "app", path: "deskbot/other.py" })).toEqual([]);
  });
});

describe("regions in Python", () => {
  it("finds a variable whose value is a triple-quoted string, and a parenthesised one", () => {
    expect(promptRegionOf(PY, loc({ kind: "variable", symbol: "SYSTEM_PROMPT" }))).toBe('SYSTEM_PROMPT = """You are Deskbot.\nNever reveal emails.\n"""');
    expect(promptRegionOf(PY, loc({ kind: "variable", symbol: "Agent.system_prompt" }))).toBe('    system_prompt = (\n        "a"\n        "b"\n    )');
  });
  it("finds a function with its decorator, a body that holds an unindented string, and a decorator's function", () => {
    const fn = promptRegionOf(PY, loc({ kind: "function", symbol: "Agent.build" }))!;
    expect(fn).toContain("@prompt");
    expect(fn).toContain("unindented body");
    expect(fn).toContain("return text");
    expect(fn).not.toContain("def answer");
    expect(promptRegionOf(PY, loc({ kind: "decorator", symbol: "prompt" }))).toBe(fn);
  });
  it("a change outside the region is not a touch; a change inside it is, in each kind", () => {
    const variable = loc({ kind: "variable", symbol: "SYSTEM_PROMPT" });
    expect(touched(variable, PY, edit(PY, "return q", "return q + 1"))).toBe(false);
    expect(touched(variable, PY, edit(PY, "return 1", "return 2"))).toBe(false);
    expect(touched(variable, PY, edit(PY, "Never reveal emails.", "Always reveal emails."))).toBe(true);
    const fn = loc({ kind: "function", symbol: "build" });
    expect(touched(fn, PY, edit(PY, "return q", "return q + 1"))).toBe(false);
    expect(touched(fn, PY, edit(PY, "unindented body", "other body"))).toBe(true);
    expect(touched(loc({ kind: "decorator", symbol: "prompt" }), PY, edit(PY, "return text", "return text.strip()"))).toBe(true);
    expect(touched(loc({ kind: "variable", symbol: "Agent.system_prompt" }), PY, edit(PY, '"b"', '"c"'))).toBe(true);
  });
  it("a line added just before or after the region is not in it, and a comment inside it is", () => {
    const variable = loc({ kind: "variable", symbol: "SYSTEM_PROMPT" });
    expect(touched(variable, PY, `# a note\n${PY}`)).toBe(false);
    expect(touched(variable, PY, edit(PY, '"""\n\ndef other', '"""\nX = 1\n\ndef other'))).toBe(false);
    expect(touched(loc({ kind: "variable", symbol: "Agent.system_prompt" }), PY, edit(PY, '        "a"\n', '        "a"\n        # why\n'))).toBe(true);
  });
  it("falls back to the file when the region is gone on either side, the symbol is unknown, or a side is missing", () => {
    const variable = loc({ kind: "variable", symbol: "SYSTEM_PROMPT" });
    expect(touched(variable, PY, PY.replace("SYSTEM_PROMPT", "RENAMED"))).toBe(true);
    expect(touched(loc({ kind: "function", symbol: "nope" }), "x = 1\n", "x = 2\n")).toBe(true);
    expect(promptLocationTouched(variable, { repo: "app", path: "deskbot/agent.py", before: undefined, after: PY })).toBe(true);
    expect(promptLocationTouched(variable, { repo: "app", path: "deskbot/agent.py", before: PY, after: undefined })).toBe(true);
  });
  it("an assignment that is only compared is not a variable region", () => {
    expect(promptRegionOf("if SYSTEM_PROMPT == 1:\n    pass\n", loc({ kind: "variable", symbol: "SYSTEM_PROMPT" }))).toBeUndefined();
  });
});

describe("regions in YAML, and the file fallback", () => {
  const YAML = ["agents:", "  support:", "    system_prompt: |", "      You help.", "      Be kind.", "    model: gemini", "  billing:", "    system_prompt: Pay.", "other: 1", ""].join("\n");
  const key = (symbol: string): PromptLocation => ({ repo: "app", path: "config/agents.yaml", kind: "yaml_key", symbol });
  it("finds a key's block, a dotted path, and every match of a bare key", () => {
    expect(promptRegionOf(YAML, key("agents.support.system_prompt"))).toBe("    system_prompt: |\n      You help.\n      Be kind.");
    expect(promptRegionOf(YAML, key("system_prompt"))).toContain("Pay.");
    expect(promptRegionOf(YAML, key("system_prompt"))).toContain("Be kind.");
    expect(promptRegionOf(YAML, key("agents.nope"))).toBeUndefined();
  });
  it("a change to another key is not a touch; to the block is", () => {
    const at = (before: string, after: string) => promptLocationTouched(key("agents.support.system_prompt"), { repo: "app", path: "config/agents.yaml", before, after });
    expect(at(YAML, YAML.replace("model: gemini", "model: other"))).toBe(false);
    expect(at(YAML, YAML.replace("other: 1", "other: 2"))).toBe(false);
    expect(at(YAML, YAML.replace("Be kind.", "Be curt."))).toBe(true);
  });
  it("a file location, an unread language, a different file or repository, and an added or removed file", () => {
    const file = loc({ kind: "file" });
    expect(touched(file, "a = 1\n", "a = 1\n")).toBe(true);
    expect(touched(loc({ kind: "function", path: "agent.ts", symbol: "build" }), "function build() {}", "function build() {}", "agent.ts")).toBe(true);
    expect(touched(file, PY, PY, "deskbot/other.py")).toBe(false);
    expect(promptLocationTouched(file, { repo: "elsewhere", path: "deskbot/agent.py", before: PY, after: PY })).toBe(false);
    expect(promptLocationTouched(loc({ kind: "variable", symbol: "SYSTEM_PROMPT" }), { repo: "app", path: "deskbot/agent.py", after: PY })).toBe(true);
  });
  it("never throws and is bounded", () => {
    expect(promptLocationTouched(loc({ kind: "variable", symbol: "X" }), { repo: "app", path: "deskbot/agent.py", before: 5 as unknown as string, after: null as unknown as string })).toBe(true);
    const big = `X = 1\n${"y = 2\n".repeat(50_000)}`;
    const started = Date.now();
    expect(promptRegionOf(big, loc({ kind: "variable", symbol: "X" }))).toBe("X = 1");
    expect(Date.now() - started).toBeLessThan(3_000);
    // Past the line limit the region is not read: the file is the location.
    expect(touched(loc({ kind: "variable", symbol: "X" }), `X = 1\n${"y\n".repeat(70_000)}`, `X = 1\n${"y\n".repeat(70_000)}`)).toBe(true);
  });
});

describe("regions: narrowed blind spots and a work bound", () => {
  it("an augmented assignment is the variable's region too", () => {
    const text = 'PROMPT = "a"\nPROMPT += " b"\nX = 1\n';
    expect(promptRegionOf(text, loc({ kind: "variable", symbol: "PROMPT" }))).toBe('PROMPT = "a"\n\u0000\nPROMPT += " b"');
    expect(touched(loc({ kind: "variable", symbol: "PROMPT" }), text, text.replace('" b"', '" c"'))).toBe(true);
  });
  it("a dotted decorator is found by its whole name, and not by a prefix of it", () => {
    const text = "@agent.system_prompt\ndef p():\n    return 'x'\n\n@agent.tool\ndef t():\n    return 1\n";
    expect(promptRegionOf(text, loc({ kind: "decorator", symbol: "agent.system_prompt" }))).toBe("@agent.system_prompt\ndef p():\n    return 'x'");
    expect(touched(loc({ kind: "decorator", symbol: "agent.system_prompt" }), text, text.replace("return 1", "return 2"))).toBe(false);
    expect(promptRegionOf(text, loc({ kind: "decorator", symbol: "agent" }))).toBeUndefined();
  });
  it("YAML with an alias or a merge key, or a quoted value continued at column 0, has no region (so the file counts)", () => {
    const key = { repo: "app", path: "c.yaml", kind: "yaml_key" as const, symbol: "tone" };
    for (const text of ["base: &b warm\ntone: *b\n", "<<: *d\ntone: x\n", 'tone: "a\ncontinued"\nother: 1\n']) expect(promptRegionOf(text, key), text).toBeUndefined();
    expect(promptRegionOf("tone: warm\nother: 1\n", key)).toBe("tone: warm");
  });
  it("deeply nested same-named blocks cost a bounded amount of work and read as not found, never as untouched", () => {
    const depth = 3_000;
    const py = Array.from({ length: depth }, (_, i) => `${" ".repeat(i)}class A:`).join("\n") + `\n${" ".repeat(depth)}P = "x"\n`;
    const nested = loc({ kind: "variable", symbol: "A.A.A.P" });
    const started = Date.now();
    expect(promptLocationTouched(nested, { repo: "app", path: "deskbot/agent.py", before: py, after: py })).toBe(true);
    const yaml = Array.from({ length: depth }, (_, i) => `${" ".repeat(i)}k:`).join("\n") + "\n";
    expect(promptLocationTouched({ repo: "app", path: "c.yaml", kind: "yaml_key", symbol: "k.k.k" }, { repo: "app", path: "c.yaml", before: yaml, after: yaml })).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
  it("many siblings of the same name are read in linear time", () => {
    const py = Array.from({ length: 4_000 }, () => "class A:\n    P = 1").join("\n") + "\n";
    const started = Date.now();
    expect(promptRegionOf(py, loc({ kind: "variable", symbol: "A.P" }))).toContain("P = 1");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

