// Decisions D1: the pure card projector and the deterministic risk tiers. Every touchpoint row of the design becomes a card; tiers only go up; friction follows the tier; links are same-origin.
import { describe, expect, it } from "vitest";
import { DecisionCardSchema, DECISION_KINDS, type DecisionKind, type DecisionRisk } from "@agentx/contracts";
import { projectDecisionCards, cardOfItem, type DecisionItem, type ItemBase } from "../../packages/broker/src/core/decisions/project.js";
import { isInfraPath, riskTierOf } from "../../packages/broker/src/core/decisions/risk-tier.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, revealMoney: true, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const proof = { proven: 3, passed: 1, failed: 0, notTested: 0 };

const ITEMS: Record<DecisionKind, DecisionItem> = {
  approve_plan: { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 3, untestedClaims: 0, cost: { lowUsd: 1.2, highUsd: 3.1, minutes: { low: 12, high: 25 } } },
  approve_requirements: { ...base("req1"), kind: "approve_requirements", claims: 4 },
  approve_design: { ...base("des1"), kind: "approve_design", files: ["src/retry.ts"] },
  merge: { ...base("pr1"), kind: "merge", prRisk: "low", prReasons: [], proof, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false },
  answer_question: { ...base("q1"), kind: "answer_question", question: "Which gateway do refunds use?", index: 1, of: 2 },
  choose_checks: { ...base("ck1"), kind: "choose_checks", defaultLabels: ["unit"] },
  approve_dependency: { ...base("dep1"), kind: "approve_dependency", packages: 1, newInstallScripts: false },
  approve_e2e_plan: { ...base("e2e1"), kind: "approve_e2e_plan", scenarios: 3, usesAiNavigation: false },
  review_feedback: { ...base("fb1"), kind: "review_feedback", comments: 2, touchesSensitivePaths: false },
  autofix_ask: { ...base("af1"), kind: "autofix_ask", reasonWords: "the same check failed twice", attempts: 2 },
  approve_setting: { ...base("set1"), kind: "approve_setting", settingLabel: "Allow video capture", secondPerson: true },
  approve_spend: { ...base("spr1"), kind: "approve_spend", amountUsd: 5, scopeLabel: "this task" },
  approve_test_env: { ...base("env1"), kind: "approve_test_env", risk: "medium", riskReasons: [], tier: "sandbox", expectedRevision: 1 },
  confirm_env_change: { ...base("chg1"), kind: "confirm_env_change", what: "accounts" },
  spec_choice: { ...base("spc1"), kind: "spec_choice", message: "The spec changed. Re-plan or keep?" },
  fix_setup: { ...base("fix1"), kind: "fix_setup", cause: "setup-failed-in-task", step: "Setup", taskCount: 2, knownFailingTests: 0, unconfirmedFailing: 0, eligibleTests: [] },
  setup_host: { ...base("hst1"), kind: "setup_host", host: "artifactory.corp.example", from: { path: "pip.conf", line: 2 }, journalN: 3, staffStep: true },
  second_review_notice: { ...base("srn1"), kind: "second_review_notice", message: "The second-opinion model your company chose no longer qualifies." },
  approve_fixture_set: { ...base("fxs1"), kind: "approve_fixture_set", dependency: "payments-api", origin: "recorded", entries: 4, faults: 1, scanClean: true, schemaSynth: false, firstFromTestAccount: false },
  approve_request: { ...base("spr_aaaaaaaaaaaaaaaaaaaa", { openPath: "/app/decisions/approve_request/spr_aaaaaaaaaaaaaaaaaaaa" }), kind: "approve_request", prefix: "spr" },
};
const DEFAULT_RISK: Record<DecisionKind, DecisionRisk> = {
  approve_plan: "low", approve_requirements: "low", approve_design: "low", merge: "low", answer_question: "low", choose_checks: "low", approve_dependency: "medium", approve_e2e_plan: "medium",
  review_feedback: "low", autofix_ask: "medium", approve_setting: "high", approve_spend: "low", approve_test_env: "medium", confirm_env_change: "medium", spec_choice: "low", fix_setup: "medium", setup_host: "medium", second_review_notice: "low", approve_fixture_set: "medium", approve_request: "high",
};
const cardOf = (item: DecisionItem, locks = {}) => {
  const result = cardOfItem(item, locks);
  if (result === undefined) throw new Error("no card");
  return result.card;
};

describe("every touchpoint becomes a card", () => {
  for (const kind of DECISION_KINDS) {
    it(`${kind}: valid card, default tier ${DEFAULT_RISK[kind]}, id and friction as the tier says`, () => {
      const card = cardOf(ITEMS[kind]);
      expect(DecisionCardSchema.safeParse(card).success).toBe(true);
      expect(card.kind).toBe(kind);
      expect(card.id).toBe(`${kind}:${ITEMS[kind].subjectId}`);
      expect(card.risk).toBe(DEFAULT_RISK[kind]);
      expect(card.status).toBe("pending");
      expect(card.friction.expandEvidenceFirst).toBe(card.risk !== "low");
      expect(card.friction.freshSignIn).toBe(card.risk === "high");
    });
  }
  it("projects them all in one pass without dropping any", () => {
    const projection = projectDecisionCards(Object.values(ITEMS));
    expect(projection.dropped).toBe(0);
    expect(projection.cards).toHaveLength(DECISION_KINDS.length - 1); // requirements + design of one task are one card
  });
});

describe("risk tiers are deterministic and only go up", () => {
  it("raises a plan that touches infrastructure to high and a sensitive path or an unproven claim to medium", () => {
    const plan = ITEMS.approve_plan as Extract<DecisionItem, { kind: "approve_plan" }>;
    expect(cardOf({ ...plan, files: ["infra/stack.ts"] }).risk).toBe("high");
    expect(cardOf({ ...plan, files: ["db/migrations/001.sql"] }).risk).toBe("high");
    expect(cardOf({ ...plan, files: ["src/auth/login.ts"] }).risk).toBe("medium");
    expect(cardOf({ ...plan, untestedClaims: 1 }).risk).toBe("medium");
    expect(cardOf({ ...plan, cost: { highUsd: 30 } }).risk).toBe("medium");
    expect(cardOf({ ...plan, cost: { highUsd: 150 } }).risk).toBe("high");
    expect(cardOf({ ...plan, files: Array.from({ length: 26 }, (_, i) => `src/f${String(i)}.ts`) }).risk).toBe("medium");
  });
  it("takes a merge's tier from the pull request, then raises it for failures, untested requirements, high findings and a pending full suite", () => {
    const merge = ITEMS.merge as Extract<DecisionItem, { kind: "merge" }>;
    expect(cardOf({ ...merge, prRisk: "medium" }).risk).toBe("medium");
    expect(cardOf({ ...merge, prRisk: "high" }).risk).toBe("high");
    expect(cardOf({ ...merge, proof: { ...proof, notTested: 1 } }).risk).toBe("medium");
    expect(cardOf({ ...merge, ci: "failing" }).risk).toBe("medium");
    expect(cardOf({ ...merge, securityFindingsHigh: 1 }).risk).toBe("high");
    expect(cardOf({ ...merge, fullSuitePending: true }).risk).toBe("medium");
  });
  it("tiers a spend by amount and a dependency by install scripts", () => {
    const spend = ITEMS.approve_spend as Extract<DecisionItem, { kind: "approve_spend" }>;
    expect([5, 10.01, 100, 100.01].map((amountUsd) => cardOf({ ...spend, amountUsd }).risk)).toEqual(["low", "medium", "medium", "high"]);
    expect(cardOf({ ...(ITEMS.approve_dependency), newInstallScripts: true } as DecisionItem).risk).toBe("high");
  });
  it("uses the test environment's own tier and a company lock can raise a tier but never lower it", () => {
    expect(cardOf({ ...(ITEMS.approve_test_env), risk: "high" } as DecisionItem).risk).toBe("high");
    expect(cardOf(ITEMS.approve_plan, { approve_plan: "high" }).risk).toBe("high");
    expect(cardOf(ITEMS.approve_plan, { approve_plan: "medium" }).risk).toBe("medium");
    expect(cardOf(ITEMS.approve_setting, { approve_setting: "low" }).risk).toBe("high");
    expect(cardOf({ ...(ITEMS.merge), prRisk: "high" } as DecisionItem, { merge: "low" }).risk).toBe("high");
    expect(cardOf(ITEMS.approve_dependency, { approve_dependency: "low" }).risk).toBe("medium");
  });
  it("fails closed when an input a kind needs is missing: no tier is guessed", () => {
    expect(() => riskTierOf("merge", {})).toThrow();
    expect(() => riskTierOf("approve_plan", {})).toThrow();
    expect(() => riskTierOf("approve_spend", { spend: { amountUsd: Number.NaN } })).toThrow();
  });
  it("recognises infrastructure paths on the whole segment", () => {
    expect(["infra/a.ts", "x/terraform/main.tf", "db/schema.sql", "Dockerfile", "cdk.json", "src/iam/roles.ts"].every(isInfraPath)).toBe(true);
    expect(["src/miami.ts", "src/author.ts", "src/cdkish.ts"].some(isInfraPath)).toBe(false);
  });
});

describe("friction on the card", () => {
  it("recommends looking first when the merge's evidence is bad", () => {
    const card = cardOf({ ...(ITEMS.merge), proof: { ...proof, failed: 1 } } as DecisionItem);
    expect(card.recommended.action).toBe("open");
    expect(card.actions[0]?.kind).toBe("open");
  });
});

describe("links are same-origin relative paths only", () => {
  it("drops a card whose open path is unsafe, counted and never shown", () => {
    const unsafe = ["//evil.example/x", "/\\evil.example", "https://evil.example/x", "/app/a/../b", "/s/ses_x"];
    const projection = projectDecisionCards([...unsafe.map((openPath, index) => ({ ...ITEMS.approve_plan, subjectId: `p${String(index)}`, openPath })), ITEMS.merge]);
    expect(projection.cards.map((card) => card.kind)).toEqual(["merge"]);
    expect(projection.dropped).toBe(unsafe.length);
  });
});

describe("standing rules", () => {
  const rule = { ruleId: "docs-only", at: "2026-10-30T11:00:00.000Z" };
  it("record a rule's answer on a low or medium card: answered_by_rule, no actions", () => {
    const card = cardOf({ ...(ITEMS.approve_plan), answeredByRule: rule });
    expect(card.status).toBe("answered_by_rule");
    expect(card.answeredByRule).toEqual(rule);
    expect(card.actions).toEqual([]);
  });
});

describe("Full path: requirements and design are one card with two tabs", () => {
  it("a high pair has no approve on the card", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, ITEMS.approve_design], { locks: { approve_design: "high" } });
    expect(projection.cards[0]?.risk).toBe("high");
    // Request changes stays (it never approves); Approve does not.
    expect(projection.cards[0]?.actions.map((action) => action.kind)).toEqual(["open", "request_changes"]);
  });
  it("every card about a task links to that card on its task page (?decision=<card id>), whatever the kind or tier (decision journey S1a)", () => {
    const page = `/app/sessions/ses_${"a".repeat(20)}`;
    const high = projectDecisionCards([ITEMS.approve_design], { locks: { approve_design: "high" } }).cards[0]!;
    expect(high.risk).toBe("high");
    expect(high.actions.find((action) => action.kind === "open")).toEqual({ kind: "open", label: "Open", href: `${page}?decision=approve_design%3Ades1`, method: "GET" });
    expect(DecisionCardSchema.safeParse(high).success).toBe(true);
    for (const kind of ["approve_design", "merge", "answer_question", "spec_choice", "approve_dependency"] as const) {
      const card = projectDecisionCards([ITEMS[kind]], { pairFullCards: false }).cards[0]!;
      expect(card.actions.find((action) => action.kind === "open")?.href).toBe(`${page}?decision=${encodeURIComponent(card.id)}`);
      expect(DecisionCardSchema.safeParse(card).success).toBe(true);
    }
    // A card about no task, or whose page is not a session page, keeps its page as it is.
    const company = projectDecisionCards([{ ...ITEMS.second_review_notice, taskId: undefined, openPath: "/app/admin/second-review" }]).cards[0]!;
    expect(company.actions.find((action) => action.kind === "open")?.href).toBe("/app/admin/second-review");
    const project = projectDecisionCards([{ ...ITEMS.confirm_env_change, openPath: "/app/projects/payments" }]).cards[0]!;
    expect(project.actions.find((action) => action.kind === "open")?.href).toBe("/app/projects/payments");
    const noTask = projectDecisionCards([{ ...ITEMS.approve_dependency, taskId: undefined }]).cards[0]!;
    expect(noTask.actions.find((action) => action.kind === "open")?.href).toBe(page);
    // A confirmation page of its own (a setting's) is still what a high card with one opens.
    const confirm = projectDecisionCards([{ ...ITEMS.approve_setting, confirmPath: "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }]).cards[0]!;
    expect(confirm.actions.find((action) => action.kind === "open")?.href).toBe("/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa");
  });
  it("does not merge different tasks, or when pairing is off (two separate cards)", () => {
    const other = { ...(ITEMS.approve_design), taskId: "22222222-2222-4222-8222-222222222222" } as DecisionItem;
    expect(projectDecisionCards([ITEMS.approve_requirements, other]).cards).toHaveLength(2);
    expect(projectDecisionCards([ITEMS.approve_requirements, ITEMS.approve_design], { pairFullCards: false }).cards).toHaveLength(2);
  });
});

describe("text and order", () => {
  it("cuts long text to the card's limits", () => {
    const card = cardOf({ ...(ITEMS.answer_question), question: "word ".repeat(200), title: "t".repeat(500) } as DecisionItem);
    expect([...card.question].length).toBeLessThanOrEqual(160);
    expect([...card.title].length).toBeLessThanOrEqual(80);
  });
});

describe("the digest of what is shown (I1, I2)", () => {
  const digestOf = (item: DecisionItem) => projectDecisionCards([item]).digests[`${item.kind}:${item.subjectId}`];
  it("changes when the evidence detail changes, and drops an item with no usable content version", () => {
    expect(digestOf({ ...ITEMS.approve_dependency, details: [{ title: "Packages", lines: ["left-pad"] }] })).not.toBe(digestOf({ ...ITEMS.approve_dependency, details: [{ title: "Packages", lines: ["right-pad"] }] }));
    expect(cardOfItem({ ...ITEMS.approve_dependency, contentVersion: "" })).toBeUndefined();
    expect(cardOfItem({ ...ITEMS.approve_dependency, contentVersion: "v‮1" })).toBeUndefined();
  });
});

describe("the evidence detail a medium card shows (I4)", () => {
  it("carries names the front does not: a plan's files, a merge's risk reasons, the item's own groups, and always why it needs a look", () => {
    const plan = projectDecisionCards([{ ...(ITEMS.approve_plan), files: ["src/auth/login.ts", "src/retry.ts"], details: [{ title: "Not tested", lines: ["R3 timeout falls back"] }] } as DecisionItem]);
    const groups = plan.details["approve_plan:plan1"]!;
    expect(groups.map((group) => group.title)).toEqual(["Files that change", "Not tested", "Why this needs a look"]);
    expect(groups[0]!.lines).toEqual(["src/auth/login.ts", "src/retry.ts"]);
    const merge = projectDecisionCards([{ ...(ITEMS.merge), prRisk: "medium", prReasons: ["Changes dependencies or build files: package.json."] } as DecisionItem]);
    expect(merge.details["merge:pr1"]![0]).toMatchObject({ title: "Why the pull request has this risk", lines: ["Changes dependencies or build files: package.json."] });
  });
});

describe("a high card opens the confirmation page (I5)", () => {
  it("refuses a confirmation path that is not a confirmation page", () => {
    expect(cardOfItem({ ...(ITEMS.approve_setting), confirmPath: "/app/sessions/ses_x" })).toBeUndefined();
  });
});

describe("fix_setup (setup and test health SH17)", () => {
  const fix = (extra: Partial<Extract<DecisionItem, { kind: "fix_setup" }>> = {}): DecisionItem => ({ ...(ITEMS.fix_setup as Extract<DecisionItem, { kind: "fix_setup" }>), ...extra });

  it("says apart, and never as older, the failing tests of those checks that the nightly run does not confirm", () => {
    const card = cardOf(fix({ knownFailingTests: 1, unconfirmedFailing: 2 }));
    expect(card.evidence.map((chip) => `${chip.label}: ${chip.value}`)).toContain("Failing in checks that failed before: 2 more tests, not confirmed older");
    expect(cardOf(fix({ knownFailingTests: 0, unconfirmedFailing: 2 })).actions.map((action) => action.kind)).toEqual(["open", "reject"]);
    expect(cardOf(fix()).evidence.some((chip) => chip.label === "Failing in checks that failed before")).toBe(false);
  });
});

it("decision cards for other people's tasks carry no money in plan, design, spend text or choices", () => {
 const items: DecisionItem[] = [
  { ...ITEMS.approve_plan, runLimit: { currentUsd: 9.73, proposedUsd: 18.61 } } as DecisionItem,
  { ...ITEMS.approve_spend, subjectId: "design-spend", amountUsd: 3.91, design: { why: "over_cap", capUsd: 2.83, estimateUsd: 3.91, choices: [{ label: "Raise the limit to $18.61", href: "/v1/app/tasks/raise" }, { label: "Run Light (about $1.81)", href: "/v1/app/tasks/light" }] } } as DecisionItem,
  { ...ITEMS.approve_spend, subjectId: "plain-spend", amountUsd: 17.43 } as DecisionItem,
 ];
 for (const role of ["reader", "co-owner"]) {
  const view = projectDecisionCards(items.map(item => ({ ...item, revealMoney: false })));
  expect(view.cards, role).toHaveLength(3);
  const shown = JSON.stringify({ cards: view.cards, tabs: view.tabs, details: view.details });
  expect(shown).not.toContain("$");
  for (const figure of [1.2, 3.1, 9.73, 18.61, 2.83, 3.91, 1.81, 17.43]) expect(shown).not.toContain(String(figure));
  expect(view.cards.map(card => card.risk)).toEqual(projectDecisionCards(items).cards.map(card => card.risk));
 }
 expect(JSON.stringify(projectDecisionCards(items).cards)).toContain("$17.43");
});
