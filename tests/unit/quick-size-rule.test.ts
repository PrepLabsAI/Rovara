// SF-1a: "does a Quick plan look bigger than Quick?" Pure rule (core/decisions/quick-size.ts), the counting rule beside the tier's estimate, the split path predicates, the words and the tolerant reader.
// Every code fires on its example and does not fire on its counter-example (the examples are the plan's, SWITCH-TO-FULL-PLAN.md rev 3 section 2.2).
import { describe, expect, it } from "vitest";
import { DESIGN_REASONS, QUICK_SIZE_CODES, QUICK_SIZE_UNKNOWN_WORD, QUICK_SIZE_WORDS, quickSizeSentence, readQuickSize, type DesignReason, type PlanDocument, type QuickSizeReason } from "@agentx/contracts";
import { countedFilesOf, estimateTier, isTestOrFixturePath } from "../../packages/broker/src/core/decisions/change-tier.js";
import { isHostLikePath, quickSizeInputOf, quickSizeOf, quickSizeRecordOf, type QuickSizeInput } from "../../packages/broker/src/core/decisions/quick-size.js";
import { isBuildFilePath, isDataChangePath, isInfraChangePath, isInfraPath } from "../../packages/broker/src/core/decisions/risk-tier.js";
import { isAccessOrMoneyPath, isSensitivePath } from "../../packages/broker/src/core/decisions/sensitive-paths.js";
import { planDocument } from "../support/plan-documents.js";

const files = (count: number, prefix = "src/feature/file"): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index)}.ts`);
const base: QuickSizeInput = { paths: [], setupChanges: [], design: undefined, designSkipped: false, designReviewOff: false };
const run = (input: Partial<QuickSizeInput>) => quickSizeOf({ ...base, ...input });
const codes = (input: Partial<QuickSizeInput>): string[] => run(input).reasons.map((reason) => reason.code);

describe("strong codes: one is enough to offer", () => {
  it("data_change: a migrations folder or a .sql file; not test data, not a document", () => {
    expect(run({ paths: ["db/migrations/0042_refunds.sql"] })).toMatchObject({ class: "strong", triggered: true });
    expect(codes({ paths: ["db/migrations/0042_refunds.sql"] })).toContain("data_change");
    expect(codes({ paths: ["scripts/seed.sql"] })).toContain("data_change");
    for (const path of ["tests/fixtures/seed.sql", "src/fixtures/seed.sql", "docs/migrations-guide.md", "db/migrations/README.md", "spec/db/seed.sql"]) {
      expect(codes({ paths: [path] }), path).not.toContain("data_change");
      expect(run({ paths: [path] }).class, path).toBe("none");
    }
  });

  it("infra_change: infra, terraform, cdk, iam, .tf, cdk.json, template.yaml; a Dockerfile is a line only", () => {
    for (const path of ["infra/stack.ts", "main.tf", "deploy/terraform/vpc.ts", "cdk.json", "template.yaml", "src/iam/policy.json"]) {
      expect(run({ paths: [path] }), path).toMatchObject({ class: "strong", triggered: true });
      expect(codes({ paths: [path] }), path).toContain("infra_change");
    }
    expect(run({ paths: ["Dockerfile"] })).toMatchObject({ class: "none", triggered: false });
    expect(codes({ paths: ["Dockerfile"] })).toEqual(["build_file"]);
    expect(run({ paths: ["src/billing/refund.ts"] }).class).toBe("none");
    expect(codes({ paths: ["infra/tests/stack.test.ts", "infra/README.md"] })).toEqual([]);
  });

  it("many_files: more than 15 COUNTED files; documents, locks, vendored and generated files and tests do not count", () => {
    expect(run({ paths: files(16) })).toMatchObject({ class: "strong", triggered: true, counts: { counted: 16 } });
    expect(codes({ paths: files(16) })).toEqual(["many_files"]);
    // Exactly 15 is not more than 15: it is a medium fact only.
    expect(run({ paths: files(15) })).toMatchObject({ class: "none", triggered: false });
    expect(codes({ paths: files(15) })).toEqual(["mid_size"]);
    const padding = [...files(10, "docs/guide/page"), ...files(10, "docs/more/page"), "package-lock.json", "yarn.lock", "node_modules/x/index.js", "src/generated/api.ts", ...files(6, "tests/unit/case")].map((path, index) => (path.startsWith("docs/") ? `${path.replace(/\.ts$/u, "")}-${String(index)}.md` : path));
    const twelve = run({ paths: [...files(12), ...padding] });
    expect(twelve).toMatchObject({ class: "none", triggered: false, counts: { counted: 12 } });
    expect(twelve.counts.named).toBeGreaterThan(40);
  });

  it("many_files counts across repositories: two repositories of nine files are one 18-file change", () => {
    const result = run({ paths: [...files(9, "service-a/src/file"), ...files(9, "service-b/src/file")] });
    expect(result).toMatchObject({ class: "strong", counts: { counted: 18, modules: 2 } });
    expect(codes({ paths: [...files(9, "service-a/src/file"), ...files(9, "service-b/src/file")] })).toEqual(["many_files"]);
  });

  it("new_service: a setup change of kind dependency or mock; a variable or a command is a line only", () => {
    const dependency = run({ setupChanges: [{ kind: "dependency", service: "Stripe" }] });
    expect(dependency).toMatchObject({ class: "strong", triggered: true });
    expect(dependency.reasons).toEqual([{ code: "new_service", names: ["Stripe"] }]);
    expect(run({ setupChanges: [{ kind: "mock", service: "Twilio" }] })).toMatchObject({ class: "strong" });
    for (const item of [{ kind: "variable" }, { kind: "command" }]) {
      expect(run({ setupChanges: [item] }), item.kind).toMatchObject({ class: "none", triggered: false });
      expect(codes({ setupChanges: [item] })).toEqual(["setup_small"]);
    }
    // Four services: three names kept, the total says four.
    const four = run({ setupChanges: ["A", "B", "C", "D"].map((service) => ({ kind: "dependency", service })) });
    expect(four.reasons[0]).toEqual({ code: "new_service", names: ["A", "B", "C"], total: 4 });
  });

  it("design_reading: Understand's high-risk reason codes; not for small or ordinary reasons, not after a Skip, not alone when the review cannot run", () => {
    const money: QuickSizeInput["design"] = { needed: true, reasons: ["money", "api_change"] };
    const fired = run({ design: money });
    expect(fired).toMatchObject({ class: "strong", triggered: true });
    // Only the high-risk codes are kept (api_change is not one).
    expect(fired.reasons).toEqual([{ code: "design_reading", names: ["money"] }]);
    for (const design of [{ needed: true, reasons: ["new_api", "small_change"] }, { needed: false, reasons: ["money"] }, undefined] as const) {
      expect(run({ design }), JSON.stringify(design)).toMatchObject({ class: "none", triggered: false });
    }
    for (const reason of ["data_model", "auth", "money", "pii", "cross_repo_or_service", "infrastructure"] as DesignReason[]) {
      expect(run({ design: { needed: true, reasons: [reason] } }).class, reason).toBe("strong");
    }
    // After a person's Skip: nothing.
    expect(run({ design: money, designSkipped: true })).toMatchObject({ class: "none", triggered: false, reasons: [] });
    // Under setting never (review cannot run): the line is shown, never counted, not alone.
    const never = run({ design: money, designReviewOff: true });
    expect(never).toMatchObject({ class: "none", triggered: false, designReviewOff: true });
    expect(never.reasons.map((reason) => reason.code)).toEqual(["design_reading"]);
    // ... but a plan-evidence code still offers, and the design line stays under it as a line.
    const withMigration = run({ design: money, designReviewOff: true, paths: ["db/migrations/0001_x.sql"] });
    expect(withMigration).toMatchObject({ class: "strong", triggered: true });
    expect(withMigration.reasons.map((reason) => reason.code)).toEqual(["data_change", "design_reading"]);
  });

  it("a typed quick: does not silence design_reading (owner O3): the rule has no input for it", () => {
    // `quick:` is stored as intent.pathFrom === "request" with path QUICK; the rule never reads it, so a Quick plan the person asked for is offered once.
    expect(Object.keys(base)).not.toContain("quick");
    expect(run({ design: { needed: true, reasons: ["pii"] } }).class).toBe("strong");
  });
});

describe("medium codes: two DIFFERENT ones offer, one alone never", () => {
  it("mid_size + sensitive_area: ten code files with one in src/auth/ offers", () => {
    const paths = [...files(9), "src/auth/session.ts"];
    const result = run({ paths });
    expect(result).toMatchObject({ class: "pair", triggered: true });
    expect(codes({ paths })).toEqual(["mid_size", "sensitive_area"]);
  });

  it("interface_file + sensitive_area: api/openapi.yaml with src/billing/charge.ts offers", () => {
    const paths = ["api/openapi.yaml", "src/billing/charge.ts"];
    expect(run({ paths })).toMatchObject({ class: "pair", triggered: true });
    expect(codes({ paths })).toEqual(["sensitive_area", "interface_file"]);
  });

  it("alone, none of them offers", () => {
    expect(run({ paths: ["src/auth/login.ts"] })).toMatchObject({ class: "none", triggered: false });
    expect(codes({ paths: ["src/auth/login.ts"] })).toEqual(["sensitive_area"]);
    expect(run({ paths: files(12) })).toMatchObject({ class: "none", triggered: false });
    expect(codes({ paths: files(12) })).toEqual(["mid_size"]);
    expect(run({ paths: ["schemas/user.ts"] })).toMatchObject({ class: "none", triggered: false });
    expect(codes({ paths: ["schemas/user.ts"] })).toEqual(["interface_file"]);
  });

  it("a test under a sensitive folder is not sensitive code (tests are not counted)", () => {
    expect(codes({ paths: ["tests/auth/login.test.ts", "src/auth/__tests__/session.ts", "tests/payments/charge.test.ts"] })).toEqual([]);
  });

  it("mid_size is more than 8 counted files: eight is nothing, nine is the fact", () => {
    expect(codes({ paths: files(8) })).toEqual([]);
    expect(codes({ paths: files(9) })).toEqual(["mid_size"]);
  });

  it("the same medium code twice is still one code (two paths in src/auth/ are not a pair)", () => {
    const result = run({ paths: ["src/auth/login.ts", "src/auth/session.ts", "src/payments/charge.ts"] });
    expect(result.reasons).toEqual([{ code: "sensitive_area", paths: ["src/auth/login.ts", "src/auth/session.ts", "src/payments/charge.ts"] }]);
    expect(result.class).toBe("none");
  });

  it("mid_size is not listed beside many_files (one fact, one line)", () => {
    expect(codes({ paths: files(16) })).not.toContain("mid_size");
  });

  it("a CI file named for security is a CI file, not sign-in code", () => {
    expect(codes({ paths: [...files(8), ".github/workflows/security.yml"] })).toEqual(["mid_size"]);
    expect(run({ paths: [...files(8), ".github/workflows/security.yml"] })).toMatchObject({ class: "none", counts: { ciFiles: 1 } });
  });

  it("sensitive_area reads the NARROW list: no iam, infra, migrations, ci; documents about auth are not auth code", () => {
    for (const path of ["src/auth/session.ts", "src/payments/charge.ts", "lib/billing/invoice.rb", "src/jwt.ts", "src/user-auth.ts", "app/secrets/store.py", "src/permissions/check.ts", "oauth/callback.ts"]) expect(isAccessOrMoneyPath(path), path).toBe(true);
    for (const path of ["src/iam/policy.json", "infra/stack.ts", "db/migrations/001.sql", ".github/workflows/ci.yml", "docs/auth/overview.md", "src/iam.ts", "src/iam-policy.ts", "src/author.ts", "src/secretsanta.ts", "ui/PlanCard.tsx", "src/session/list.ts", "src/roles.ts"]) expect(isAccessOrMoneyPath(path), path).toBe(false);
  });

  it("every narrow path is also on the plan card's sensitive list (the two never disagree where they overlap)", () => {
    const corpus = ["src/auth/session.ts", "src/payments/charge.ts", "src/jwt.ts", "src/user-auth.ts", "app/secrets/store.py", "oauth/callback.ts", "crypto/aes.ts", "security/headers.ts", "saml/sp.ts", "sso/login.ts", "credentials/vault.ts", "permissions/can.ts", "billing/plan.ts", "a/b/authz/c.ts"];
    for (const path of corpus) {
      expect(isAccessOrMoneyPath(path), path).toBe(true);
      expect(isSensitivePath(path), path).toBe(true);
    }
  });
});

describe("display-only lines never count", () => {
  it("three display-only facts are still zero: .env.example, .npmrc and AGENTS.md give no offer", () => {
    const result = run({ paths: [".env.example", ".npmrc", "AGENTS.md"] });
    expect(result).toMatchObject({ class: "none", triggered: false });
    expect(result.reasons.map((reason) => reason.code)).toEqual(["env_file", "package_source_setting", "instruction_file"]);
  });

  it("a test file or test data is never shown as a line either", () => {
    expect(run({ paths: ["tests/fixtures/.env", "tests/Dockerfile", "src/__tests__/AGENTS.md"] }).reasons).toEqual([]);
  });

  it("each display-only line fires on its example", () => {
    const cases: Array<[string, string]> = [["Dockerfile", "build_file"], [".env.local", "env_file"], [".gitmodules", "git_settings_file"], [".yarnrc.yml", "package_source_setting"], ["CLAUDE.md", "instruction_file"], [".husky/pre-commit", "hook_file"]];
    for (const [path, code] of cases) {
      const result = run({ paths: [path] });
      expect(result.reasons.map((reason) => reason.code), path).toContain(code);
      expect(result.class, path).toBe("none");
    }
  });

  it("no offer for: the broad tier words (PlanCard, a session list, roles), AGENTS.md, a docs-only plan, three plain files", () => {
    for (const paths of [["ui/PlanCard.tsx", "src/session/list.ts", "roles.ts"], ["AGENTS.md"], ["README.md", "docs/a.md", "docs/b.md", "CHANGELOG.md"], files(3)]) {
      expect(run({ paths }), paths.join(",")).toMatchObject({ class: "none", triggered: false });
    }
  });

  it("CI and code-owner files are in no list: they neither offer nor show; they are only counted", () => {
    const result = run({ paths: [".github/workflows/ci.yml", ".github/CODEOWNERS", "CODEOWNERS"] });
    expect(result).toMatchObject({ class: "none", triggered: false, reasons: [], counts: { ciFiles: 3 } });
  });

  it("an address pasted into the plan's text is not a file: an IAM docs link is no infra_change, a billing docs link is no sensitive_area", () => {
    const urls = ["docs.aws.amazon.com/iam/latest/UserGuide/reference.html", "stripe.com/docs/billing/subscriptions.html", "https://example.org/auth/login.html"];
    for (const url of urls) expect(isHostLikePath(url), url).toBe(true);
    expect(run({ paths: urls })).toMatchObject({ class: "none", triggered: false, reasons: [], counts: { counted: 0, named: 0 } });
    expect(codes({ paths: [...urls, ...files(9), "src/auth/session.ts"] })).toEqual(["mid_size", "sensitive_area"]);
    // The prose reader finds them in a work item's text too.
    const plan = planDocument({ workBreakdown: undefined, claims: [{ id: "1", text: "See docs.aws.amazon.com/iam/latest/UserGuide/reference.html for the rules." }] });
    const fromText = quickSizeOf(quickSizeInputOf({ plan, workflow: {}, designReviewOff: false }));
    expect(fromText.class).toBe("none");
    expect(fromText.counts.textOnly).toBe(0);
    // Real folders that only look dotted are paths.
    for (const path of ["src.old/iam/x.ts", ".github/workflows/ci.yml", "v1.2/api/x.ts", "next.config.js", "packages/app.io/x.ts"]) expect(isHostLikePath(path), path).toBe(false);
  });

  it("a plan's length is not an input: a 3,000-character plan over six plain files gives no offer", () => {
    const plan = planDocument({
      risks: ["A long risk. ".repeat(250)],
      claims: files(6).map((path, index) => ({ id: String(index + 1), text: `Change ${path}.`, evidence: [{ kind: "code" as const, path, startLine: 1, endLine: 2 }] })),
    });
    const input = quickSizeInputOf({ plan, workflow: {}, designReviewOff: false });
    expect(input.paths).toHaveLength(6);
    expect(quickSizeOf(input)).toMatchObject({ class: "none", triggered: false, counts: { counted: 6 } });
  });
});

describe("an unread plan, and how the record is built", () => {
  it("a plan that cannot be read gives no offer and says so", () => {
    const input = quickSizeInputOf({ plan: undefined, workflow: {}, designReviewOff: false });
    expect(quickSizeOf(input)).toMatchObject({ class: "none", triggered: false, unread: true, reasons: [] });
    const record = quickSizeRecordOf(quickSizeOf(input), { planDigest: "d".repeat(64), workflowRevision: 4, at: "2026-11-25T00:00:00.000Z" });
    expect(record).toMatchObject({ rulesVersion: 0, unread: true, triggered: false, class: "none" });
  });

  it("the record carries version 0, the plan it is for, the class, the counts and the reasons", () => {
    const record = quickSizeRecordOf(run({ paths: ["db/migrations/0042_refunds.sql", ...files(2)] }), { planDigest: "a".repeat(64), workflowRevision: 7, at: "2026-11-25T00:00:00.000Z" });
    expect(record).toMatchObject({ rulesVersion: 0, planDigest: "a".repeat(64), workflowRevision: 7, class: "strong", triggered: true, counts: { counted: 3, named: 3 } });
    expect(readQuickSize(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it("reads the plan's own files, setup changes and Understand's reading; a Skip on the workflow silences the design reading", () => {
    const plan: PlanDocument = planDocument({ setupChanges: [{ id: "s1", kind: "dependency", service: "Postgres", reason: "tests use a database" }] });
    const workflow = { intent: { assessment: { kind: "ready", design: { needed: true, reasons: ["money"], note: "x" } } }, designReview: undefined } as never;
    expect(quickSizeOf(quickSizeInputOf({ plan, workflow, designReviewOff: false })).reasons.map((reason) => reason.code)).toEqual(["new_service", "design_reading", "sensitive_area"]);
    const skipped = { intent: { assessment: { kind: "ready", design: { needed: true, reasons: ["money"], note: "x" } } }, designReview: { decidedBy: "person_skip" } } as never;
    expect(quickSizeOf(quickSizeInputOf({ plan, workflow: skipped, designReviewOff: false })).reasons.map((reason) => reason.code)).toEqual(["new_service", "sensitive_area"]);
  });

  it("counts how the plan names its files, for the two checks before the rules are frozen", () => {
    const plan = planDocument({
      claims: [{ id: "1", text: "Edit src/new/created-in-text.ts too.", evidence: [{ kind: "code", path: "src/a.ts", startLine: 1, endLine: 2 }, { kind: "code", path: "src/proof-only.ts", startLine: 1, endLine: 2 }] }],
      risks: ["Also src/other/mentioned.ts."],
    });
    const result = quickSizeOf(quickSizeInputOf({ plan, workflow: {}, designReviewOff: false }));
    // planFiles = the two cited files; neither is a work item path, so both are "cited only"; the two files only the prose names are "text only".
    expect(result.counts).toMatchObject({ counted: 2, named: 2, citedOnly: 2, textOnly: 2 });
  });
});

describe("the counting rule", () => {
  it("counts code and settings files once each; skips documents, other prose, locks, vendored and generated files, tests and test data", () => {
    const paths = [
      "src/a.ts", "src/a.ts", "pkg/b.py", "config/app.yaml", ".env.example", "Dockerfile",
      "README.md", "docs/guide.md", "CHANGELOG.md", "NOTES.txt", "AGENTS.md", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock",
      "node_modules/x/y.js", "vendor/lib/z.go", "third_party/q/r.c", "src/generated/types.ts", "src/__generated__/g.ts", "src/__snapshots__/a.snap",
      "tests/unit/a.test.ts", "src/a.spec.ts", "src/__tests__/b.ts", "spec/c.rb", "src/fixtures/seed.json", "pkg/testdata/in.json", "pkg/x_test.go",
    ];
    expect(countedFilesOf(paths)).toEqual(["src/a.ts", "pkg/b.py", "config/app.yaml", ".env.example", "Dockerfile"]);
  });

  it("shares the docs and lock tests with estimateTier: what the estimate skips as a document or a lock file is never counted", () => {
    const skipped = ["README.md", "docs/guide.md", "CHANGELOG.md", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock"];
    expect(countedFilesOf(skipped)).toEqual([]);
    // estimateTier counts none of them either: nine of them are not "more than 3 files".
    expect(estimateTier({ plannedPaths: skipped }, { at: "2026-11-25T00:00:00.000Z" }).reasons.map((reason) => reason.code)).not.toContain("more_than_files");
    // And its own count (which includes tests) is NOT changed: five tests are more than 3 files for the estimate, none for the counting rule.
    const tests = files(5, "tests/unit/case");
    expect(estimateTier({ plannedPaths: tests }, { at: "2026-11-25T00:00:00.000Z" }).reasons.map((reason) => reason.code)).toContain("more_than_files");
    expect(countedFilesOf(tests)).toEqual([]);
  });

  it("isTestPath does not cover fixtures outside a test folder; the rule's test-or-fixture test does", () => {
    expect(isTestOrFixturePath("tests/fixtures/seed.sql")).toBe(true);
    expect(isTestOrFixturePath("src/fixtures/seed.sql")).toBe(true);
    expect(isTestOrFixturePath("pkg/testdata/in.json")).toBe(true);
    expect(isTestOrFixturePath("src/seed.sql")).toBe(false);
  });
});

describe("the split path predicates leave the plan card's infrastructure rule unchanged", () => {
  // The regex isInfraPath was before it was split into data / infrastructure / build parts.
  const OLD = /(^|\/)(infra|infrastructure|terraform|cdk|iam|migrations)(\/|$)|\.(tf|sql)$|(^|\/)(cdk\.json|template\.ya?ml)$|(^|\/)dockerfile$/u;
  const oldInfra = (path: string): boolean => OLD.test(path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "").toLowerCase());
  const corpus = [
    "infra/a.ts", "Infra/A.ts", "src/infrastructure/x", "terraform/main.tf", "x.tf", "x.sql", "db\\migrations\\1.sql", "./migrations/1.js", "migrations", "src/migrationsx/a.ts", "a/iam/b.json", "iamx/a", "cdk.json", "x/cdk.json",
    "template.yaml", "template.yml", "x/template.yaml", "Dockerfile", "docker/Dockerfile", "Dockerfile.dev", "src/dockerfile", "src/a.ts", "README.md", "src/cdkish.ts", "my.sql.bak", "a/b/c.tf", ".github/workflows/x.yml",
  ];
  it("isInfraPath is the union of the three parts, exactly the old regex", () => {
    for (const path of corpus) {
      expect(isInfraPath(path), path).toBe(oldInfra(path));
      expect(isInfraPath(path), path).toBe(isDataChangePath(path) || isInfraChangePath(path) || isBuildFilePath(path));
    }
  });
  it("the three parts do not overlap on the plan's examples", () => {
    expect([isDataChangePath("db/migrations/1.sql"), isInfraChangePath("db/migrations/1.sql"), isBuildFilePath("db/migrations/1.sql")]).toEqual([true, false, false]);
    expect([isDataChangePath("infra/stack.ts"), isInfraChangePath("infra/stack.ts"), isBuildFilePath("infra/stack.ts")]).toEqual([false, true, false]);
    expect([isDataChangePath("Dockerfile"), isInfraChangePath("Dockerfile"), isBuildFilePath("Dockerfile")]).toEqual([false, false, true]);
  });
});

describe("the words: one table, code to sentence", () => {
  const reason = (code: string, extra: Partial<QuickSizeReason> = {}): QuickSizeReason => ({ code, ...extra });

  it("every code the rule can write has a sentence, none says risky, and every sentence is a plain line", () => {
    for (const code of QUICK_SIZE_CODES) {
      expect(QUICK_SIZE_WORDS[code], code).toBeDefined();
      expect(QUICK_SIZE_WORDS[code]!.toLowerCase(), code).not.toContain("risky");
      expect(QUICK_SIZE_WORDS[code], code).not.toMatch(/[\n\r]/u);
    }
    expect(Object.keys(QUICK_SIZE_WORDS).sort()).toEqual([...QUICK_SIZE_CODES].sort());
  });

  it("fills the table: paths (at most three, then and N more), the count, the service and the design phrase", () => {
    expect(quickSizeSentence(reason("data_change", { paths: ["db/migrations/1.sql"] }), { counted: 3 })).toBe("Changes the database: db/migrations/1.sql.");
    expect(quickSizeSentence(reason("infra_change", { paths: ["a.tf", "b.tf", "c.tf"], total: 5 }), { counted: 5 })).toBe("Changes infrastructure or permissions: a.tf, b.tf, c.tf and 2 more.");
    expect(quickSizeSentence(reason("many_files"), { counted: 18 })).toBe("Changes 18 code files. Quick is meant for smaller changes.");
    expect(quickSizeSentence(reason("mid_size"), { counted: 10 })).toBe("Changes 10 code files.");
    expect(quickSizeSentence(reason("new_service", { names: ["Stripe"] }), { counted: 1 })).toBe("Adds a service the code talks to: Stripe.");
    expect(quickSizeSentence(reason("design_reading", { names: ["money", "pii"] }), { counted: 1 })).toBe("From the request: this task touches money or billing and touches personal data.");
    expect(quickSizeSentence(reason("setup_small"), { counted: 1 })).toBe("Also changes the test setup.");
  });

  it("a code from a newer Code, a name that is not a design reason, and a line with no paths all read as the one generic sentence", () => {
    expect(quickSizeSentence(reason("something_new", { paths: ["x"] }), { counted: 1 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
    expect(quickSizeSentence(reason("constructor"), { counted: 1 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
    expect(quickSizeSentence(reason("design_reading", { names: ["constructor", "toString"] }), { counted: 1 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
    expect(quickSizeSentence(reason("data_change"), { counted: 1 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
  });

  it("plan text is a word, never a pattern: $& and {count} in a path come out as they are", () => {
    expect(quickSizeSentence(reason("data_change", { paths: ["db/$&/{count}.sql"] }), { counted: 9 })).toBe("Changes the database: db/$&/{count}.sql.");
  });

  it("every design reason code has a phrase the design_reading sentence can use", () => {
    for (const code of DESIGN_REASONS) expect(quickSizeSentence(reason("design_reading", { names: [code] }), { counted: 1 }), code).not.toBe(QUICK_SIZE_UNKNOWN_WORD);
  });
});

describe("the tolerant reader (arch rule 8, 9)", () => {
  const good = { rulesVersion: 0, planDigest: "f".repeat(64), workflowRevision: 3, at: "2026-11-25T00:00:00.000Z", class: "strong", triggered: true, counts: { counted: 18, named: 20, modules: 3 }, reasons: [{ code: "many_files" }] };

  it("reads a record", () => {
    expect(readQuickSize(good)).toEqual(good);
  });

  it("absent or not an object is no record", () => {
    for (const value of [undefined, null, 0, "x", [], [good], true]) expect(readQuickSize(value), JSON.stringify(value)).toBeUndefined();
  });

  it("no class, an unknown class, no plan digest or no time is no record: nothing is computed in its place", () => {
    for (const patch of [{ class: undefined }, { class: "huge" }, { class: 3 }, { planDigest: undefined }, { planDigest: "" }, { at: undefined }, { rulesVersion: "0" }, { rulesVersion: -1 }, { rulesVersion: 1.5 }]) {
      expect(readQuickSize({ ...good, ...patch }), JSON.stringify(patch)).toBeUndefined();
    }
  });

  it("reads member by member: unknown members are ignored, an unreadable count is zero, a reason with an unreadable code is dropped, an unknown code is kept", () => {
    const record = readQuickSize({
      ...good, future: { a: 1 }, counts: { counted: "many", named: 20, modules: -4, extra: 9, ciFiles: 2 },
      reasons: [{ code: "many_files", extra: 1 }, { code: 7 }, { code: "Not A Code" }, null, "x", { code: "brand_new", paths: ["a", 5, "", "b"], total: "x" }, { code: "data_change", paths: [] }],
    });
    expect(record?.counts).toEqual({ counted: 0, named: 20, modules: 0, ciFiles: 2 });
    expect(record?.reasons).toEqual([{ code: "many_files" }, { code: "brand_new", paths: ["a", "b"] }, { code: "data_change" }]);
  });

  it("reads a kept memory member by member and drops an unreadable one", () => {
    const kept = { codes: ["data_change", "Not A Code", 5], by: "p1", at: "2026-11-25T00:00:00.000Z", requestId: "r1" };
    expect(readQuickSize({ ...good, kept })?.kept).toEqual({ codes: ["data_change"], by: "p1", at: kept.at, requestId: "r1" });
    for (const bad of [{ ...kept, by: undefined }, { ...kept, requestId: "" }, { ...kept, codes: "data_change" }, "kept", 3]) expect(readQuickSize({ ...good, kept: bad })?.kept, JSON.stringify(bad)).toBeUndefined();
  });

  it("an unread record never offers, whatever else it says; a count that could not be read is not shown as 0 files", () => {
    expect(readQuickSize({ ...good, unread: true })).toMatchObject({ unread: true, triggered: false });
    expect(quickSizeSentence({ code: "many_files" }, { counted: 0 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
    expect(quickSizeSentence({ code: "mid_size" }, { counted: 0 })).toBe(QUICK_SIZE_UNKNOWN_WORD);
    expect(quickSizeSentence({ code: "setup_small" }, { counted: 0 })).toBe("Also changes the test setup.");
  });

  it("reads settingUnread and designReviewOff as two different facts", () => {
    expect(readQuickSize({ ...good, settingUnread: true })).toMatchObject({ settingUnread: true });
    expect(readQuickSize({ ...good, settingUnread: true })?.designReviewOff).toBeUndefined();
    expect(readQuickSize({ ...good, designReviewOff: true })?.settingUnread).toBeUndefined();
  });

  it("a version this release has never seen is still a record (the caller compares the version); triggered needs a class that offers", () => {
    expect(readQuickSize({ ...good, rulesVersion: 9 })?.rulesVersion).toBe(9);
    expect(readQuickSize({ ...good, class: "none", triggered: true })?.triggered).toBe(false);
    expect(readQuickSize({ ...good, triggered: "yes" })?.triggered).toBe(false);
  });

  it("keeps at most three paths per reason, sixteen reasons, and never throws on hostile shapes", () => {
    const many = readQuickSize({ ...good, reasons: Array.from({ length: 40 }, (_, index) => ({ code: `c${String(index)}`, paths: ["a", "b", "c", "d", "e"] })) });
    expect(many?.reasons).toHaveLength(16);
    expect(many?.reasons[0]?.paths).toEqual(["a", "b", "c"]);
    // Stored data is JSON: nothing in it can make the reader throw.
    expect(() => readQuickSize(JSON.parse('{"rulesVersion":0,"planDigest":"x","at":"t","class":"none","reasons":{"0":1},"counts":[1]}'))).not.toThrow();
  });
});
