import { describe, expect, it } from "vitest";
import { createReaderRegistry } from "../../packages/worker/src/knowledge/registry.js";
import type { FormatParseResult } from "../../packages/worker/src/knowledge/model.js";

const registry = createReaderRegistry();
const parse = (path: string, text: string, nested = false): FormatParseResult => {
  const reader = registry.readerFor(path);
  if (reader === undefined) throw new Error(`no reader for ${path}`);
  return reader.parse(path, text, { nested, scopeDir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" });
};
const ok = (result: FormatParseResult) => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
};

describe("Kiro steering", () => {
  it("defaults to always, with or without front matter", () => {
    expect(ok(parse(".kiro/steering/product.md", "Product text"))).toMatchObject({ activation: "always", body: "Product text" });
    expect(ok(parse(".kiro/steering/product.md", "---\ninclusion: always\n---\nText"))).toMatchObject({ activation: "always", body: "Text" });
  });

  it("reads fileMatch with a string and with an array", () => {
    expect(ok(parse(".kiro/steering/py.md", '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.py"\n---\nB'))).toMatchObject({ activation: "fileMatch", patterns: ["**/*.py"] });
    expect(ok(parse(".kiro/steering/web.md", '---\ninclusion: fileMatch\nfileMatchPattern: ["components/**/*.tsx", "**/*.css"]\n---\nB'))).toMatchObject({ patterns: ["components/**/*.tsx", "**/*.css"] });
  });

  it("does not split a Kiro pattern on commas (a string is one pattern)", () => {
    expect(ok(parse(".kiro/steering/a.md", '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.{ts,tsx}"\n---\nB'))).toMatchObject({ patterns: ["**/*.{ts,tsx}"] });
  });

  it("takes the #name of a manual file from its file name and an auto file's from its front matter", () => {
    expect(ok(parse(".kiro/steering/oncall.md", "---\ninclusion: manual\n---\nB"))).toMatchObject({ activation: "manual", name: "oncall" });
    expect(ok(parse(".kiro/steering/x.md", "---\ninclusion: auto\nname: api-design\ndescription: REST rules\n---\nB"))).toMatchObject({ activation: "auto", name: "api-design", description: "REST rules" });
  });

  it("refuses an auto file with no name or description, a fileMatch with no pattern and an unknown inclusion", () => {
    expect(parse(".kiro/steering/x.md", "---\ninclusion: auto\nname: only-name\n---\nB")).toEqual({ ok: false, reason: "bad_front_matter" });
    expect(parse(".kiro/steering/x.md", "---\ninclusion: fileMatch\n---\nB")).toEqual({ ok: false, reason: "bad_front_matter" });
    expect(parse(".kiro/steering/x.md", "---\ninclusion: sometimes\n---\nB")).toEqual({ ok: false, reason: "bad_front_matter" });
  });

  it("reads front matter only when it is first: a later block is text and the file stays always-on", () => {
    const result = ok(parse(".kiro/steering/late.md", "# Title\n\n---\ninclusion: manual\n---\nB"));
    expect(result.activation).toBe("always");
    expect(result.body).toContain("inclusion: manual");
  });

  it("follows file references", () => {
    expect(ok(parse(".kiro/steering/a.md", "x")).imports).toBe("kiro");
  });
});

describe("AGENTS.md and CLAUDE.md", () => {
  it("are always on at the root and apply to their own folder when nested", () => {
    expect(ok(parse("AGENTS.md", "root"))).toMatchObject({ activation: "always" });
    expect(ok(parse("src/match/AGENTS.md", "nested", true))).toMatchObject({ activation: "fileMatch", patterns: ["src/match/**"] });
    expect(ok(parse("src/CLAUDE.md", "nested", true))).toMatchObject({ activation: "fileMatch", patterns: ["src/**"], imports: "claude" });
    expect(ok(parse("AGENTS.override.md", "o"))).toMatchObject({ activation: "always" });
  });

  it("does not treat a leading --- block in AGENTS.md as front matter (no inclusion modes)", () => {
    const value = ok(parse("AGENTS.md", "---\ninclusion: manual\n---\nText"));
    expect(value.activation).toBe("always");
    expect(value.body).toContain("inclusion: manual");
  });

  it("reads .claude/CLAUDE.md as always on", () => {
    expect(ok(parse(".claude/CLAUDE.md", "x"))).toMatchObject({ activation: "always", imports: "claude" });
  });
});

describe("Cursor rules", () => {
  it("maps alwaysApply, globs, description and neither", () => {
    expect(ok(parse(".cursor/rules/a.mdc", "---\nalwaysApply: true\n---\nB"))).toMatchObject({ activation: "always" });
    expect(ok(parse(".cursor/rules/ui.mdc", "---\nglobs: src/ui/**, **/*.css\nalwaysApply: false\n---\nB"))).toMatchObject({ activation: "fileMatch", patterns: ["src/ui/**", "**/*.css"] });
    expect(ok(parse(".cursor/rules/b.mdc", "---\ndescription: When writing SQL\n---\nB"))).toMatchObject({ activation: "auto", name: "b", description: "When writing SQL" });
    expect(ok(parse(".cursor/rules/c.mdc", "---\nalwaysApply: false\n---\nB"))).toMatchObject({ activation: "manual", name: "c" });
    expect(ok(parse(".cursor/rules/d.mdc", "no front matter"))).toMatchObject({ activation: "manual", name: "d" });
  });

  it("refuses an alwaysApply that is not a boolean", () => {
    expect(parse(".cursor/rules/a.mdc", '---\nalwaysApply: "yes"\n---\nB')).toEqual({ ok: false, reason: "bad_front_matter" });
  });
});

describe("Copilot instructions", () => {
  it("makes the repository file always on and applyTo a file match", () => {
    expect(ok(parse(".github/copilot-instructions.md", "---\nnot front matter here\n---\nx"))).toMatchObject({ activation: "always" });
    expect(ok(parse(".github/instructions/ts.instructions.md", '---\napplyTo: "**/*.ts,**/*.tsx"\n---\nB'))).toMatchObject({ activation: "fileMatch", patterns: ["**/*.ts", "**/*.tsx"] });
  });

  it("maps excludeAgent to the stages it leaves out", () => {
    expect(ok(parse(".github/instructions/a.instructions.md", '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nB')).excludeStages).toEqual(["plan_check", "review"]);
    expect(ok(parse(".github/instructions/a.instructions.md", '---\napplyTo: "**"\nexcludeAgent: "cloud-agent"\n---\nB')).excludeStages).toEqual(["build"]);
    expect(parse(".github/instructions/a.instructions.md", '---\napplyTo: "**"\nexcludeAgent: "other"\n---\nB')).toEqual({ ok: false, reason: "bad_front_matter" });
  });

  it("treats a file with no applyTo as manual, named without .instructions", () => {
    expect(ok(parse(".github/instructions/db.instructions.md", "B"))).toMatchObject({ activation: "manual", name: "db" });
  });
});

describe("Claude rules", () => {
  it("is always on without paths and a file match with them", () => {
    expect(ok(parse(".claude/rules/a.md", "B"))).toMatchObject({ activation: "always", imports: "claude" });
    expect(ok(parse(".claude/rules/api.md", "---\npaths:\n  - src/api/**\n  - \"**/*.sql\"\n---\nB"))).toMatchObject({ activation: "fileMatch", patterns: ["src/api/**", "**/*.sql"] });
  });
});

describe("the registry", () => {
  it("owns each path with one reader and lists where to look", () => {
    expect(registry.readerFor(".kiro/steering/a.md")?.id).toBe("kiro_steering");
    expect(registry.readerFor("docs/readme.md")).toBeUndefined();
    expect(registry.directories()).toEqual(expect.arrayContaining([".kiro/steering", ".cursor/rules", ".github/instructions", ".claude/rules"]));
    expect(registry.nestedNames()).toEqual(expect.arrayContaining(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]));
  });

  it("takes another reader without changing the rest", () => {
    const extra = {
      id: "windsurf",
      discovery: { directories: [".windsurf/rules"] },
      accepts: (path: string) => path.startsWith(".windsurf/rules/"),
      parse: (_path: string, text: string) => ({ ok: true as const, value: { activation: "always" as const, body: text, imports: "none" as const } }),
    };
    const extended = createReaderRegistry([...registry.readers, extra]);
    expect(extended.readerFor(".windsurf/rules/x.md")?.id).toBe("windsurf");
    expect(extended.directories()).toContain(".windsurf/rules");
  });
});
