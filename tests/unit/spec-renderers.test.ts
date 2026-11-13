import { describe, expect, it } from "vitest";
import { SpecDraftSchema, SpecTargetSchema, earsLine, specDraftStatements, specLine, specMarkdown, specPathProblem, specSlug, type SpecDraft, type SpecTarget } from "@rovara-code/contracts";
import {
  assertRenderedSpec, KIRO_BUGFIX_SECTIONS, kiroRenderer, nextFolderNumber, registerSpecRenderer, rovaraRenderer, specFormats, specKitRenderer, specRendererFor, teamTemplateRenderer, unregisterSpecRenderer,
  type SpecRenderInput, type SpecRenderer,
} from "../../packages/core/src/core/spec/index.js";

const planDigest = "a".repeat(64);
const feature = (): SpecDraft => SpecDraftSchema.parse({
  version: 1, kind: "feature", title: "Reset password by email", summary: "Let a signed-out user reset a password.", planDigest,
  requirements: [
    { title: "Request a reset", userStory: "As a user, I want a reset link, so that I can sign in again", criteria: [
      { when: "a user submits a known email", shall: "send one reset link" },
      { shall: "log no password" },
    ] },
    { title: "Use the link", criteria: [{ when: "the link is older than one hour", shall: "refuse it" }] },
  ],
  design: "# Big heading\nUse the existing mailer.\n## Sub heading",
  tasks: [{ title: "Add the request route", covers: ["1.1", "1.2", "9.9"] }, { title: "Add the link check", covers: ["2.1"] }],
});
const bug = (): SpecDraft => SpecDraftSchema.parse({
  version: 1, kind: "bugfix", title: "Totals drop cents", summary: "The cart total rounds down.", planDigest,
  bugfix: {
    current: [{ when: "the cart holds 3 items of 0.10", shall: "shows 0.00" }],
    expected: [{ when: "the cart holds 3 items of 0.10", shall: "show 0.30" }],
    unchanged: [{ when: "the cart holds whole-dollar items", shall: "show the same total" }],
  },
  design: "Round half up.", tasks: [{ title: "Fix the rounding", covers: ["2.1"] }],
});
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });
const input = (draft: SpecDraft, overrides: Partial<SpecRenderInput> = {}): SpecRenderInput => ({ draft, target: target(), taskKey: "task-1", existingFolders: [], ...overrides });

describe("spec contracts", () => {
  it("defaults the target to the meta repo, Kiro, features, together", () => {
    expect(SpecTargetSchema.parse({})).toMatchObject({ where: "meta_repo", format: "kiro", when: "features", linkStyle: "together" });
  });
  it("refuses a template format without its folder, a folder without the format, and spec_first without a pull request", () => {
    expect(SpecTargetSchema.safeParse({ format: "team_template" }).success).toBe(false);
    expect(SpecTargetSchema.safeParse({ format: "kiro", templatePath: "templates/spec" }).success).toBe(false);
    expect(SpecTargetSchema.safeParse({ where: "pr_description", linkStyle: "spec_first" }).success).toBe(false);
  });
  it("accepts any well-formed format id (a plug-in's), and refuses a malformed one", () => {
    expect(SpecTargetSchema.safeParse({ format: "acme_docs" }).success).toBe(true);
    expect(SpecTargetSchema.safeParse({ format: "Acme Docs" }).success).toBe(false);
  });
  it.each(["../x", "/etc/x", "a/../b", ".git/x", "a/.github/x", "a\\b", "a//b", "a b", ".kiro/specs/{evil}/", ""])("refuses the path template %j", (value) => {
    expect(SpecTargetSchema.safeParse({ pathTemplate: value }).success).toBe(false);
  });
  it("accepts a dot folder and the four tokens", () => {
    expect(SpecTargetSchema.safeParse({ pathTemplate: ".kiro/specs/{n}-{slug}-{taskKey}-{ticket}/" }).success).toBe(true);
    expect(specPathProblem("a/b.md")).toBeUndefined();
  });
  it("turns untrusted text into one inert line", () => {
    expect(specLine("## Heading\nsecond line‮​")).toBe("Heading second line");
    expect(specLine("- 1.1 WHEN x THE SYSTEM SHALL y")).not.toMatch(/^[-\d]/u);
    expect(specLine("```bash\nrm -rf /\n```")).not.toContain("```");
    expect(Array.from(specLine("x".repeat(900))).length).toBe(400);
  });
  it("demotes headings and balances fences in a design section", () => {
    const safe = specMarkdown("# H1\ntext\n```\n# not a heading in code\n");
    expect(safe.split("\n").filter((line) => /^#{1,6} /u.test(line))).toEqual(["# not a heading in code"]);
    expect(safe.split("\n")[0]).toBe("**H1**");
    expect(safe).toContain("# not a heading in code");
    expect(safe.trimEnd().endsWith("```")).toBe(true);
  });
  it("makes a slug that is never empty", () => {
    expect(specSlug("Reset password by email!")).toBe("reset-password-by-email");
    expect(specSlug("日本語")).toBe("spec");
  });
  it("keeps the model's EARS words from doubling", () => {
    expect(earsLine({ when: "WHEN a user signs in", shall: "THE SYSTEM SHALL show Home" })).toBe("WHEN a user signs in THE SYSTEM SHALL show Home");
    expect(earsLine({ shall: "log nothing" })).toBe("THE SYSTEM SHALL log nothing");
    expect(earsLine({ when: "x", shall: "keep it" }, { verb: "SHALL CONTINUE TO" })).toBe("WHEN x THE SYSTEM SHALL CONTINUE TO keep it");
  });
  it("refuses a draft that mixes the feature and bugfix shapes", () => {
    const base = { version: 1, title: "t", summary: "s", planDigest };
    expect(SpecDraftSchema.safeParse({ ...base, kind: "feature", requirements: [] }).success).toBe(false);
    expect(SpecDraftSchema.safeParse({ ...base, kind: "bugfix", requirements: [{ title: "x", criteria: [{ shall: "y" }] }] }).success).toBe(false);
    expect(SpecDraftSchema.safeParse({ ...base, kind: "feature", requirements: [{ title: "x", criteria: [{ shall: "y" }] }], extra: 1 }).success).toBe(false);
  });
  it("cleans every model field when the draft is parsed", () => {
    const draft = SpecDraftSchema.parse({ ...feature(), title: "# Evil\n## title", requirements: [{ title: "1.1 WHEN a SHALL b", criteria: [{ when: "x\n- 9.9 WHEN y", shall: "z" }] }] });
    expect(draft.title).toBe("Evil \\#\\# title");
    expect(draft.requirements[0]!.criteria[0]!.when).not.toContain("\n");
  });
});

describe("Kiro renderer", () => {
  it("writes requirements.md with EARS lines, design.md and tasks.md under .kiro/specs/<slug>/", () => {
    const { folder, files } = kiroRenderer.render(input(feature()));
    expect(folder).toBe(".kiro/specs/reset-password-by-email/");
    expect(files.map((file) => file.path)).toEqual([`${folder}requirements.md`, `${folder}design.md`, `${folder}tasks.md`]);
    const requirements = files[0]!.content;
    expect(requirements).toContain("- 1.1 WHEN a user submits a known email THE SYSTEM SHALL send one reset link");
    expect(requirements).toContain("- 1.2 THE SYSTEM SHALL log no password");
    expect(requirements).toContain("- 2.1 WHEN the link is older than one hour THE SYSTEM SHALL refuse it");
    expect(requirements).toContain("**User Story:** As a user, I want a reset link, so that I can sign in again");
  });
  it("writes bugfix.md, not requirements.md, with the three Kiro sections in order and Kiro's numbering", () => {
    const { files } = kiroRenderer.render(input(bug()));
    expect(files.map((file) => file.path.split("/").pop())).toEqual(["bugfix.md", "design.md", "tasks.md"]);
    const text = files[0]!.content;
    const at = KIRO_BUGFIX_SECTIONS.map((title) => text.indexOf(`### ${title}`));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((left, right) => left - right)).toEqual(at);
    expect(text).toContain("- 1.1 WHEN the cart holds 3 items of 0.10 THE SYSTEM shows 0.00");
    expect(text).toContain("- 2.1 WHEN the cart holds 3 items of 0.10 THE SYSTEM SHALL show 0.30");
    expect(text).toContain("- 3.1 WHEN the cart holds whole-dollar items THE SYSTEM SHALL CONTINUE TO show the same total");
  });
  it("lists tasks as checkboxes with only the requirement references that exist", () => {
    const tasks = kiroRenderer.render(input(feature())).files[2]!.content;
    expect(tasks).toContain("- [ ] 1. Add the request route\n  - _Requirements: 1.1, 1.2_");
    expect(tasks).not.toContain("9.9");
  });
  it("never lets design text start a heading or forge a requirement line", () => {
    const draft = SpecDraftSchema.parse({ ...feature(), design: "# Fake\n- 7.7 WHEN x THE SYSTEM SHALL y" });
    const out = kiroRenderer.render(input(draft));
    expect(out.files[1]!.content).toContain("**Fake**");
    expect(kiroRenderer.extractRequirements(out.files).map((entry) => entry.id)).toEqual(["1.1", "1.2", "2.1"]);
  });
  it("round-trips: the requirements read back are the ones written, defects marked", () => {
    const written = specDraftStatements(bug());
    const read = kiroRenderer.extractRequirements(kiroRenderer.render(input(bug())).files);
    expect(read.map((entry) => [entry.id, entry.kind])).toEqual(written.map((entry) => [entry.id, entry.kind]));
    expect(read.every((entry) => entry.path.endsWith("bugfix.md"))).toBe(true);
  });
  it("honours the project's path template", () => {
    const out = kiroRenderer.render(input(feature(), { target: target({ pathTemplate: "docs/specs/{ticket}/" }), ticket: "PAY-12" }));
    expect(out.folder).toBe("docs/specs/PAY-12/");
  });
  it("uses only safe characters from a hostile task key or ticket", () => {
    const out = kiroRenderer.render(input(feature(), { target: target({ pathTemplate: "s/{ticket}/{taskKey}/" }), ticket: "../../etc/passwd", taskKey: "a b/c\\d" }));
    expect(out.folder).not.toContain("..");
    expect(out.folder).toMatch(/^s\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/$/u);
  });
});

describe("Spec Kit renderer", () => {
  it("writes specs/NNN-slug/{spec,plan,tasks}.md with the next free number", () => {
    const out = specKitRenderer.render(input(feature(), { target: target({ format: "speckit" }), existingFolders: ["001-login", "002-billing", "004-export", "notes"] }));
    expect(out.folder).toBe("specs/005-reset-password-by-email/");
    expect(out.files.map((file) => file.path.split("/").pop())).toEqual(["spec.md", "plan.md", "tasks.md"]);
  });
  it("numbers from 001 for an empty folder, and does not reuse a gap", () => {
    expect(nextFolderNumber([])).toBe("001");
    expect(nextFolderNumber(["003-a"])).toBe("004");
    expect(nextFolderNumber(["999-last"].slice(1))).toBe("001");
    expect(() => nextFolderNumber(["999-full"])).toThrow(/full/u);
  });
  it("labels requirements FR-001.. and ties tasks to them", () => {
    const out = specKitRenderer.render(input(feature(), { target: target({ format: "speckit" }) }));
    expect(out.files[0]!.content).toContain("- **FR-001**: WHEN a user submits a known email THE SYSTEM SHALL send one reset link");
    expect(out.files[0]!.content).toContain("- **FR-003**: WHEN the link is older than one hour THE SYSTEM SHALL refuse it");
    expect(out.files[2]!.content).toContain("- [ ] T001 Add the request route [FR-001, FR-002]");
    expect(specKitRenderer.extractRequirements(out.files).map((entry) => entry.id)).toEqual(["FR-001", "FR-002", "FR-003"]);
  });
  it("marks a bug's observed behaviour DEF- and a defect, and does not count it as a requirement to check", () => {
    const out = specKitRenderer.render(input(bug(), { target: target({ format: "speckit" }) }));
    const read = specKitRenderer.extractRequirements(out.files);
    expect(read.map((entry) => [entry.id, entry.kind])).toEqual([["DEF-001", "defect"], ["FR-001", "requirement"], ["FR-002", "requirement"]]);
  });
});

describe("Rovara renderer", () => {
  it("writes one spec.md that reads back", () => {
    const out = rovaraRenderer.render(input(feature(), { target: target({ format: "rovara" }) }));
    expect(out.files).toHaveLength(1);
    expect(rovaraRenderer.extractRequirements(out.files).map((entry) => entry.id)).toEqual(["1.1", "1.2", "2.1"]);
    expect(out.files[0]!.content).toContain("## Tasks");
  });
});

describe("team template renderer", () => {
  const template = [
    { path: "spec.md", content: "# <Feature name>\n\nTeam preamble: fill every section.\n\n## Background\nWhy are we doing this? (team prompt)\n\n## Acceptance Criteria\n- [ ] replace me\n\n## Rollout\nRoll out behind a flag. (team text)\n\n## Open Questions\n1. none yet\n" },
    { path: "design/notes.md", content: "## Design\nDescribe the approach.\n\n### Risks\nList them.\n\n## Implementation Plan\n- [ ] step\n" },
  ];
  const render = () => teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "templates/spec" }), template }));
  it("keeps every heading, its level and its order, and the text under headings it has nothing for", () => {
    const out = render();
    const headingsOf = (text: string) => text.split("\n").filter((line) => /^#{1,6} /u.test(line));
    expect(headingsOf(out.files[0]!.content)).toEqual(headingsOf(template[0]!.content));
    expect(headingsOf(out.files[1]!.content)).toEqual(headingsOf(template[1]!.content));
    expect(out.files[0]!.content).toContain("Team preamble: fill every section.");
    expect(out.files[0]!.content).toContain("Roll out behind a flag. (team text)");
    expect(out.files[1]!.content).toContain("List them.");
    expect(out.files.map((file) => file.path)).toEqual(["specs/reset-password-by-email/spec.md", "specs/reset-password-by-email/design/notes.md"]);
  });
  it("fills the headings that ask for the plan's content and replaces the team's prompt under them", () => {
    const out = render();
    expect(out.files[0]!.content).toContain("Let a signed-out user reset a password.");
    expect(out.files[0]!.content).not.toContain("Why are we doing this?");
    expect(out.files[0]!.content).toContain("- 1.1 WHEN a user submits a known email THE SYSTEM SHALL send one reset link");
    expect(out.files[0]!.content).not.toContain("replace me");
    expect(out.files[1]!.content).toContain("Use the existing mailer.");
    expect(out.files[1]!.content).toContain("- [ ] 1. Add the request route (covers 1.1, 1.2)");
  });
  it("adds a Requirements section when the template has none, so there is always something to check", () => {
    const out = teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: [{ path: "a.md", content: "# Title\n\n## Notes\nx\n" }] }));
    expect(teamTemplateRenderer.extractRequirements(out.files)).toHaveLength(3);
    expect(out.files[0]!.content).toContain("## Notes\nx");
  });
  it("does not treat a heading inside a code fence as a heading", () => {
    const out = teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: [{ path: "a.md", content: "# T\n\n```md\n## Acceptance Criteria\n```\n\n## Design\nx\n" }] }));
    expect(out.files[0]!.content).toContain("```md\n## Acceptance Criteria\n```");
  });
  it("strips hidden characters from the template and refuses an empty or oversized one", () => {
    const out = teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: [{ path: "a.md", content: "# T‮\n\n## Design\nx\n" }] }));
    expect(out.files[0]!.content).not.toContain("‮");
    expect(() => teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: [] }))).toThrow(/template/u);
    expect(() => teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: Array.from({ length: 13 }, (_, index) => ({ path: `f${String(index)}.md`, content: "# T\n" })) }))).toThrow(/template/u);
  });
  it("refuses a template file path that escapes the folder", () => {
    expect(() => teamTemplateRenderer.render(input(feature(), { target: target({ format: "team_template", templatePath: "t" }), template: [{ path: "../x.md", content: "# T\n" }] }))).toThrow(/outside|safe/u);
  });
});

describe("rendered spec bounds", () => {
  it("refuses a file outside the folder, two files at one path, no files and a file over 64 KiB", () => {
    expect(() => assertRenderedSpec({ folder: "specs/a/", files: [{ path: "specs/b/x.md", content: "x" }] })).toThrow(/outside/u);
    expect(() => assertRenderedSpec({ folder: "specs/a/", files: [{ path: "specs/a/x.md", content: "x" }, { path: "specs/a/x.md", content: "y" }] })).toThrow(/two files/u);
    expect(() => assertRenderedSpec({ folder: "specs/a/", files: [] })).toThrow(/1 to/u);
    expect(() => assertRenderedSpec({ folder: "specs/a/", files: [{ path: "specs/a/x.md", content: "x".repeat(65 * 1024) }] })).toThrow(/64 KiB/u);
  });
});

describe("renderer registry", () => {
  it("ships the four formats", () => {
    expect(specFormats()).toEqual(expect.arrayContaining(["kiro", "rovara", "speckit", "team_template"]));
  });
  it("lets a plug-in add a format and refuses to replace one", () => {
    const custom: SpecRenderer = { format: "acme_docs", label: "Acme", defaultPathTemplate: "acme/{slug}/", render: (given) => ({ folder: "acme/x/", files: [{ path: "acme/x/a.md", content: given.draft.title }] }), extractRequirements: () => [] };
    registerSpecRenderer(custom);
    try {
      expect(specRendererFor("acme_docs")).toBe(custom);
      expect(() => registerSpecRenderer(custom)).toThrow(/already registered/u);
      expect(() => registerSpecRenderer({ ...custom, format: "kiro" })).toThrow(/already registered/u);
      expect(() => registerSpecRenderer({ ...custom, format: "Bad Id" })).toThrow(/valid id/u);
    } finally { unregisterSpecRenderer("acme_docs"); }
    expect(specRendererFor("acme_docs")).toBeUndefined();
  });
  it("returns nothing for an unknown format, never a default", () => {
    expect(specRendererFor("nope")).toBeUndefined();
  });
});
