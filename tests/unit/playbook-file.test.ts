// "How we work" in Code is the file `.rovara/playbook.yaml`. These tests read it the way the broker does: strictly, as data from a repository.
import { describe, expect, it } from "vitest";
import { PLAYBOOK_FILE_MAX_BYTES, PLAYBOOK_FILE_TEMPLATE, PLAYBOOK_RULE_TEXT_MAX, type PlaybookFile } from "@agentx/contracts";
import { PLAYBOOK_TAG_MESSAGE, designReviewOfPlaybook, overlayOfPlaybook, parsePlaybookText, playbookIsEmpty } from "../../packages/broker/src/core/playbook/file.js";
import { RULE_TEXT_MAX } from "../../packages/broker/src/core/playbook/inert-rule-text.js";

const ok = (text: string): PlaybookFile => {
  const parsed = parsePlaybookText(text);
  if (!parsed.ok) throw new Error(`expected a playbook, got ${JSON.stringify(parsed.problems)}`);
  return parsed.file;
};
const problems = (text: string) => {
  const parsed = parsePlaybookText(text);
  if (parsed.ok) throw new Error("expected problems");
  return parsed.problems;
};

describe("reading the playbook file", () => {

  it("the template `rovara playbook init` writes is a valid, empty playbook", () => {
    const file = ok(PLAYBOOK_FILE_TEMPLATE);
    expect(playbookIsEmpty(file)).toBe(true);
    expect(overlayOfPlaybook(file)).toEqual({});
  });

  it("refuses a text over the limit, counted in characters after the hidden ones are removed", () => {
    expect(RULE_TEXT_MAX).toBe(PLAYBOOK_RULE_TEXT_MAX);
    expect(ok(`version: 1\nrules: "${"x".repeat(PLAYBOOK_RULE_TEXT_MAX)}"`).rules).toHaveLength(PLAYBOOK_RULE_TEXT_MAX);
    expect(problems(`version: 1\nrules: "${"x".repeat(PLAYBOOK_RULE_TEXT_MAX + 1)}"`)).toEqual([{ path: "rules", message: "must be at most 4,000 characters" }]);
    expect(ok(`version: 1\nrules: "${"😀".repeat(PLAYBOOK_RULE_TEXT_MAX)}"`).rules).toBeDefined();
    expect(problems(`version: 1\nstages:\n  build:\n    instructions: "${"y".repeat(PLAYBOOK_RULE_TEXT_MAX + 1)}"`)[0]).toEqual({ path: "stages.build.instructions", message: "must be at most 4,000 characters" });
  });

  it("is data, not code: aliases are capped, merge keys and duplicate keys are refused, nothing in a parse error quotes the file", () => {
    // Aliases inside a field that takes text: nine are read, the tenth is refused (a file of aliases cannot grow into a bomb).
    const aliases = (count: number) => `version: 1\nrules: [&a "x", ${Array.from({ length: count }, () => "*a").join(", ")}]`;
    expect(ok(aliases(9)).rules).toBe(Array.from({ length: 10 }, () => "x").join("\n"));
    expect(problems(aliases(10))[0]).toMatchObject({ path: "(file)" });
    // A merge key is an ordinary key named `<<` here, so it is not text: the rules are refused.
    expect(problems("version: 1\nbase: &b {x: 1}\nrules:\n  <<: *b")[0]).toEqual({ path: "rules", message: "must be text, or a list of lines of text" });
    // The merge key is a refusal even where it would give a stage its text: the rules a file spells out are the rules it has.
    expect(problems("version: 1\nstages:\n  plan: &p\n    instructions: X\n  build:\n    <<: *p")[0]).toMatchObject({ path: expect.stringContaining("build") as string });
    expect(problems("version: 1\nrules: a\nrules: b")[0]).toEqual({ path: "(file)", message: "the file is not valid YAML (line 3)" });
    // A fault says where it is, never what the file said there.
    const quoted = problems("version: 1\nrules: [unterminated SECRET-TEXT")[0]!;
    expect(quoted.message).toMatch(/^the file is not valid YAML( \(line \d+\))?$/u);
    expect(JSON.stringify(quoted)).not.toContain("SECRET-TEXT");
    // The easy mistake: a colon and a space inside an unquoted text.
    expect(problems("version: 1\nrules: Note: mention the ticket")[0]).toEqual({ path: "(file)", message: "the file is not valid YAML (line 2)" });
    expect(problems("")[0]?.path).toBe("(file)");
    expect(problems("just words")[0]?.path).toBe("(file)");
  });

  it("refuses a custom YAML tag, in words, and never reads the text under it", () => {
    const refused = problems("version: 1\nrules: !custom hello");
    expect(refused).toEqual([{ path: "(file)", message: PLAYBOOK_TAG_MESSAGE }]);
    expect(problems("version: 1\nstages:\n  plan:\n    instructions: !!binary aGk=").length).toBeGreaterThan(0);
  });

  it("refuses a file over the size cap before it reads it", () => {
    const big = `version: 1\nrules: |\n${"  x\n".repeat(PLAYBOOK_FILE_MAX_BYTES / 4)}`;
    expect(problems(big)[0]?.message).toContain("larger than");
  });

  it("carries a design review setting as Cloud stores it, and holds who approves to the maintainers", () => {
    const text = (approver: string) => `version: 1\ndesignReview:\n  mode: always\n  tier: thorough\n  allowSkip: false\n  capUsdPerTask: 20\n  highRiskApprover: ${approver}`;
    expect(designReviewOfPlaybook(ok(text("{ kind: maintainers }")))).toEqual({ mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 20, highRiskApprover: { kind: "maintainers" } });
    expect(problems(text("{ kind: people, memberIds: [a] }"))[0]?.path).toBe("designReview.highRiskApprover");
    expect(problems(text("{ kind: group, groupId: g }"))[0]?.path).toBe("designReview.highRiskApprover");
    expect(problems("version: 1\ndesignReview:\n  mode: sometimes")[0]?.path).toMatch(/^designReview/u);
    expect(problems(text("{ kind: maintainers }").replace("capUsdPerTask: 20", "capUsdPerTask: 5000"))[0]?.path).toBe("designReview.capUsdPerTask");
  });
});

