// Decisions D1: the pure card projector and the deterministic risk tiers. Every touchpoint row of the design becomes a card; tiers only go up; friction follows the tier; links are same-origin.
import { describe, expect, it } from "vitest";
import { DecisionCardSchema, DecisionTabsSchema, DECISION_KIND_FLOOR_RISK, DECISION_KINDS, type DecisionKind, type DecisionRisk } from "@rovara-code/contracts";
import { projectDecisionCards, cardOfItem, decisionCardPath, type DecisionItem, type ItemBase } from "../../packages/core/src/core/decisions/project.js";
import { isInfraPath, riskTierOf } from "../../packages/core/src/core/decisions/risk-tier.js";
import { isSafeRelativePath } from "../../packages/core/src/core/decisions/text.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
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
  fix_setup: { ...base("fix1"), kind: "fix_setup", cause: "setup-failed-in-task", step: "Setup", taskCount: 2, knownFailingTests: 0, unconfirmedFailing: 0 },
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
  it("never starts a kind below its floor, even for the smallest input", () => {
    const rank = { low: 0, medium: 1, high: 2 };
    for (const kind of DECISION_KINDS) expect(rank[cardOf(ITEMS[kind]).risk]).toBeGreaterThanOrEqual(rank[DECISION_KIND_FLOOR_RISK[kind]]);
    expect(cardOf(ITEMS.approve_setting).risk).toBe("high");
    expect(cardOf({ ...ITEMS.approve_setting, secondPerson: false } as DecisionItem).risk).toBe("high");
    expect(riskTierOf("approve_setting", {}).risk).toBe("high");
  });
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
  it("low is one tap: approve is a POST to this server's card route, first", () => {
    const card = cardOf(ITEMS.approve_plan);
    expect(card.actions[0]).toEqual({ kind: "approve", label: "Approve", href: `${decisionCardPath("approve_plan:plan1")}/approve`, method: "POST" });
    expect(card.recommended.action).toBe("approve");
    // A document is sent back with Request changes (slice 2), so its card has no reject and no reject reasons; a kind that can be put off keeps them.
    expect(card.rejectReasons).toEqual([]);
    expect(cardOf(ITEMS.approve_dependency).rejectReasons.length).toBeGreaterThan(0);
  });
  it("medium keeps the evidence-first flag and still offers approve (the server enforces the open)", () => {
    const card = cardOf(ITEMS.approve_dependency);
    expect(card.friction).toEqual({ expandEvidenceFirst: true, freshSignIn: false, secondPerson: false });
    expect(card.actions.some((action) => action.kind === "approve")).toBe(true);
  });
  it("high has NO approve action: only 'Open', and a fresh sign-in is flagged (second person where asked)", () => {
    const card = cardOf(ITEMS.approve_setting);
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
    expect(card.actions[0]?.label).toBe("Open");
    expect(card.recommended.action).toBe("open");
    expect(card.friction).toEqual({ expandEvidenceFirst: true, freshSignIn: true, secondPerson: true });
    expect(cardOf({ ...(ITEMS.approve_plan), files: ["infra/x.ts"] } as DecisionItem).friction.secondPerson).toBe(false);
  });
  it("recommends looking first when the merge's evidence is bad", () => {
    const card = cardOf({ ...(ITEMS.merge), proof: { ...proof, failed: 1 } } as DecisionItem);
    expect(card.recommended.action).toBe("open");
    expect(card.actions[0]?.kind).toBe("open");
  });
  it("a question or a checks choice is answered on its own page: the card only opens it", () => {
    for (const kind of ["answer_question", "choose_checks"] as const) {
      const card = cardOf(ITEMS[kind]);
      expect(card.actions.map((action) => [action.kind, action.method])).toEqual([["open", "GET"]]);
    }
  });
  it("no card has more than one approve and no action is bulk", () => {
    for (const card of projectDecisionCards(Object.values(ITEMS)).cards) {
      expect(card.actions.filter((action) => action.kind === "approve").length).toBeLessThanOrEqual(1);
      expect(card.actions.filter((action) => action.kind === "approve").every((action) => action.method === "POST")).toBe(true);
      expect(JSON.stringify(card)).not.toMatch(/bulk|approve-all|approveAll/iu);
    }
  });
});

describe("links are same-origin relative paths only", () => {
  it("accepts the contract's paths and refuses absolute, protocol-relative, backslash, dot-dot, spaced, encoded, colon and control forms", () => {
    expect(isSafeRelativePath("/app/sessions/ses_abc")).toBe(true);
    expect(isSafeRelativePath("/v1/app/approve/apr_abc?x=1")).toBe(true);
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/app/a\\b", "/app/a/../b", "/app/a b", "/app/a\nb", "/app/\u202Eevil", "javascript:alert(1)", "evil", "", "/s/ses_abc", "/other/x", "/app//x", "/app/a:b", "/app/a%2Fb", "/app/x@y"]) expect(isSafeRelativePath(bad), bad).toBe(false);
  });
  it("drops a card whose open path is unsafe, counted and never shown", () => {
    const unsafe = ["//evil.example/x", "/\\evil.example", "https://evil.example/x", "/app/a/../b", "/s/ses_x"];
    const projection = projectDecisionCards([...unsafe.map((openPath, index) => ({ ...ITEMS.approve_plan, subjectId: `p${String(index)}`, openPath })), ITEMS.merge]);
    expect(projection.cards.map((card) => card.kind)).toEqual(["merge"]);
    expect(projection.dropped).toBe(unsafe.length);
  });
  it("every link on every card is a safe relative path", () => {
    for (const card of projectDecisionCards(Object.values(ITEMS)).cards) for (const action of card.actions) expect(isSafeRelativePath(action.href), action.href).toBe(true);
  });
  it("drops an item with a bad id and a duplicate card", () => {
    const projection = projectDecisionCards([{ ...ITEMS.merge, subjectId: "has space" }, ITEMS.approve_plan, ITEMS.approve_plan]);
    expect(projection.cards).toHaveLength(1);
    expect(projection.dropped).toBe(2);
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
  it("never answer a high card: the rule is ignored and the card stays pending with 'open to decide'", () => {
    const card = cardOf({ ...(ITEMS.approve_setting), answeredByRule: rule });
    expect(card.status).toBe("pending");
    expect(card.answeredByRule).toBeUndefined();
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
  });
  it("a lock that raises a card to high also stops a rule from answering it", () => {
    const card = cardOf({ ...(ITEMS.approve_plan), answeredByRule: rule }, { approve_plan: "high" });
    expect(card.status).toBe("pending");
  });
  it("a finished item is history: its outcome, no actions", () => {
    const card = cardOf({ ...(ITEMS.merge), outcome: "approved" });
    expect(card.status).toBe("approved");
    expect(card.actions).toEqual([]);
  });
});

describe("Full path: requirements and design are one card with two tabs", () => {
  it("merges the pair for one task into one card at the higher tier, with two tabs that each stay an approval", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), files: ["infra/stack.ts", "src/auth/login.ts"] } as DecisionItem]);
    expect(projection.cards).toHaveLength(1);
    const [card] = projection.cards;
    expect(card?.kind).toBe("approve_requirements");
    const tabs = projection.tabs[card?.id ?? ""];
    expect(DecisionTabsSchema.safeParse(tabs).success).toBe(true);
    expect(tabs?.map((tab) => tab.id)).toEqual(["requirements", "design"]);
    expect(tabs?.every((tab) => !tab.approved)).toBe(true);
  });
  it("keeps the pair at the higher tier: a medium design makes the card medium", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), files: ["src/auth/login.ts"] } as DecisionItem]);
    expect(projection.cards[0]?.risk).toBe("medium");
    expect(projection.cards[0]?.friction.expandEvidenceFirst).toBe(true);
  });
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
  it("uses the one vocabulary on every action: Approve, Request changes, Merge, Answer, Open, Not now", () => {
    const labels = (kind: DecisionKind) => projectDecisionCards([ITEMS[kind]], { pairFullCards: false }).cards[0]!.actions.map((action) => action.label);
    expect(labels("approve_plan")).toEqual(["Approve", "Request changes", "Open"]);
    expect(labels("approve_dependency")).toEqual(["Approve", "Not now", "Open"]);
    expect(labels("merge")).toEqual(["Merge", "Not now", "Open"]);
    expect(labels("answer_question")).toEqual(["Answer"]);
    expect(labels("approve_setting")).toEqual(["Open"]);
  });
  it("does not merge different tasks, or when pairing is off (two separate cards)", () => {
    const other = { ...(ITEMS.approve_design), taskId: "22222222-2222-4222-8222-222222222222" } as DecisionItem;
    expect(projectDecisionCards([ITEMS.approve_requirements, other]).cards).toHaveLength(2);
    expect(projectDecisionCards([ITEMS.approve_requirements, ITEMS.approve_design], { pairFullCards: false }).cards).toHaveLength(2);
  });
});

describe("text and order", () => {
  it("flattens a hostile title and question to plain text", () => {
    const card = cardOf({ ...(ITEMS.answer_question), question: "Pick one‮\nnow <script>alert(1)</script>", title: "a\u0000b\n\nc" } as DecisionItem);
    expect(card.question).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(card.title).toBe("a b c");
  });
  it("cuts long text to the card's limits", () => {
    const card = cardOf({ ...(ITEMS.answer_question), question: "word ".repeat(200), title: "t".repeat(500) } as DecisionItem);
    expect([...card.question].length).toBeLessThanOrEqual(160);
    expect([...card.title].length).toBeLessThanOrEqual(80);
  });
  it("orders high first, then newer first, and gives the same answer every time", () => {
    const items = [ITEMS.approve_plan, { ...ITEMS.merge, createdAt: "2026-10-30T12:00:00.000Z" }, ITEMS.approve_setting, ITEMS.approve_dependency];
    const first = projectDecisionCards(items).cards.map((card) => card.id);
    expect(first).toEqual(["approve_setting:set1", "approve_dependency:dep1", "merge:pr1", "approve_plan:plan1"]);
    expect(projectDecisionCards([...items].reverse()).cards.map((card) => card.id)).toEqual(first);
  });
});

describe("the digest of what is shown (I1, I2)", () => {
  const digestOf = (item: DecisionItem) => projectDecisionCards([item]).digests[`${item.kind}:${item.subjectId}`];
  it("is a sha-256 for every card and the same for the same items", () => {
    expect(digestOf(ITEMS.approve_dependency)).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestOf(ITEMS.approve_dependency)).toBe(digestOf({ ...ITEMS.approve_dependency }));
  });
  it("changes when the content version changes though the title, counts and evidence chips do not", () => {
    const a = digestOf({ ...ITEMS.approve_dependency, contentVersion: "v1" });
    const b = digestOf({ ...ITEMS.approve_dependency, contentVersion: "v2" });
    expect(a).not.toBe(b);
    expect(cardOf({ ...ITEMS.approve_dependency, contentVersion: "v1" })).toEqual(cardOf({ ...ITEMS.approve_dependency, contentVersion: "v2" }));
  });
  it("changes when the evidence detail changes, and drops an item with no usable content version", () => {
    expect(digestOf({ ...ITEMS.approve_dependency, details: [{ title: "Packages", lines: ["left-pad"] }] })).not.toBe(digestOf({ ...ITEMS.approve_dependency, details: [{ title: "Packages", lines: ["right-pad"] }] }));
    expect(cardOfItem({ ...ITEMS.approve_dependency, contentVersion: "" })).toBeUndefined();
    expect(cardOfItem({ ...ITEMS.approve_dependency, contentVersion: "v‮1" })).toBeUndefined();
  });
  it("covers both documents of a Full pair", () => {
    const pair = (design: string) => projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), contentVersion: design }]);
    const first = pair("d1"), second = pair("d2");
    const id = first.cards[0]!.id;
    expect(first.digests[id]).not.toBe(second.digests[id]);
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
  it("keeps each tab's detail on its tab", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), files: ["src/a.ts"] } as DecisionItem]);
    const groups = projection.details[projection.cards[0]!.id]!;
    expect(new Set(groups.map((group) => group.tab))).toEqual(new Set(["requirements", "design"]));
  });
});

describe("a high card opens the confirmation page (I5)", () => {
  const confirm = "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
  it("uses the item's confirmation page for 'Open' and lists a high card without one as unconfirmed", () => {
    const withPage = projectDecisionCards([{ ...(ITEMS.approve_setting), confirmPath: confirm }]);
    expect(withPage.cards[0]!.actions).toEqual([{ kind: "open", label: "Open", href: confirm, method: "GET" }]);
    expect(withPage.unconfirmed).toEqual([]);
    const without = projectDecisionCards([ITEMS.approve_setting]);
    expect(without.unconfirmed).toEqual(["approve_setting:set1"]);
  });
  it("refuses a confirmation path that is not a confirmation page", () => {
    expect(cardOfItem({ ...(ITEMS.approve_setting), confirmPath: "/app/sessions/ses_x" })).toBeUndefined();
  });
  it("a spend above the admin amount needs a second person", () => {
    expect(cardOf({ ...(ITEMS.approve_spend), amountUsd: 250 } as DecisionItem).friction.secondPerson).toBe(true);
    expect(cardOf({ ...(ITEMS.approve_spend), amountUsd: 50 } as DecisionItem).friction.secondPerson).toBe(false);
  });
});

describe("a spec on hold (wire lane D, MD-1)", () => {
  it("is a card that only opens the task page: no approve, no reject, and the broker's fixed sentence", async () => {
    const card = cardOf(ITEMS["spec_choice"]);
    expect(card).toMatchObject({ kind: "spec_choice", status: "pending", risk: "low", question: "The spec changed. Re-plan or keep?", recommended: { action: "open" } });
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
    expect(card.rejectReasons).toEqual([]);
  });
});

describe("fix_setup (setup and test health SH17)", () => {
  const fix = (extra: Partial<Extract<DecisionItem, { kind: "fix_setup" }>> = {}): DecisionItem => ({ ...(ITEMS.fix_setup as Extract<DecisionItem, { kind: "fix_setup" }>), ...extra });

  it("is a medium card that opens the setup page and can be put away, with no approve when there is nothing to mark", () => {
    const card = cardOf(fix());
    expect(card.risk).toBe("medium");
    expect(card.actions.map((action) => action.kind)).toEqual(["open", "reject"]);
    expect(card.recommended.action).toBe("open");
    expect(card.question).toBe("Fix the test setup?");
    expect(card.evidence.map((chip) => `${chip.label}: ${chip.value}`)).toEqual(["Result: Blocked by environment", "Failing step: Setup", "Tasks affected: 2"]);
  });

  it("offers Mark as known failing as the one approve only when the record has tests to mark, and says how many", () => {
    const card = cardOf(fix({ knownFailingTests: 3 }));
    expect(card.actions.map((action) => [action.kind, action.label])).toEqual([["open", "Open the setup"], ["reject", "Not now"], ["approve", "Mark as known failing"]]);
    expect(card.actions.find((action) => action.kind === "approve")!.href).toBe("/v1/app/decisions/fix_setup/fix1/approve");
    expect(card.evidence.some((chip) => chip.label === "Failing before this change" && chip.value === "3 tests, confirmed by the nightly run")).toBe(true);
    expect(card.friction.expandEvidenceFirst).toBe(true);
    expect(card.riskReasons).toContain("Marking tests as already failing changes how later results are judged.");
  });

  it("says apart, and never as older, the failing tests of those checks that the nightly run does not confirm", () => {
    const card = cardOf(fix({ knownFailingTests: 1, unconfirmedFailing: 2 }));
    expect(card.evidence.map((chip) => `${chip.label}: ${chip.value}`)).toContain("Failing in checks that failed before: 2 more tests, not confirmed older");
    expect(cardOf(fix({ knownFailingTests: 0, unconfirmedFailing: 2 })).actions.map((action) => action.kind)).toEqual(["open", "reject"]);
    expect(cardOf(fix()).evidence.some((chip) => chip.label === "Failing in checks that failed before")).toBe(false);
  });

  it("a company lock that raises it to high leaves only Open, never an approve", () => {
    const card = cardOf(fix({ knownFailingTests: 3 }), { fix_setup: "high" });
    expect(card.risk).toBe("high");
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
  });

  it("the digest changes when the record's version does, so an earlier 'evidence opened' does not carry over", () => {
    const one = projectDecisionCards([fix({ contentVersion: "v1" })]);
    const two = projectDecisionCards([fix({ contentVersion: "v2" })]);
    expect(Object.values(one.digests)[0]).not.toBe(Object.values(two.digests)[0]);
  });

  it("words nothing a worker, model or repository wrote: the question, next and why are fixed", () => {
    const card = cardOf(fix({ step: "Setup" }));
    expect(card.next.text).toContain("2 tasks wait on this");
    expect(card.recommended.why).toBe("The code did not fail: the test setup could not give a verdict.");
  });
});
