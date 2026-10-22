import { describe, expect, it } from "vitest";
import { E2EDisplayBaselineSchema, E2EDisplayScenarioSchema, E2EDisplayScenarioV2Schema, E2EDisplayBaselineV2Schema, E2EScenarioResultsSchema } from "@agentx/contracts";
import { row } from "../support/e2e-scenario-results.js";
import { agentNavigation, agentRow } from "../support/e2e-agent-display.js";

// M1.4 Tasks 4.4b and 4.4c: display schema v3. A row may say how the AI navigated (from the verified ledger only), and a baseline may say why it did not run or which AI-navigated
// scenarios it left out. Version 2 keeps its strict shape: a v2 reader refuses these fields, which is why they are a version.

describe("display schema v3 rows", () => {
  it("accepts a row with an agentNavigation block and refuses one that grows past its bounds, carries a value, or has an unknown field", () => {
    expect(E2EDisplayScenarioSchema.safeParse(agentRow()).success).toBe(true);
    const bad = [
      agentRow({ agentNavigation: agentNavigation({ steps: Array.from({ length: 4 }, () => agentNavigation().steps[0]) }) }),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "x".repeat(121), actedOn: [], stop: "concluded" }] }) }),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: Array.from({ length: 9 }, () => ({ role: "button", name: "a" })), stop: "concluded" }] }) }),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [{ role: "button", name: "x".repeat(61) }], stop: "concluded" }] }) }),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [{ role: "textbox", name: "Email", value: "hunter2" }], stop: "concluded" }] }) }),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [], stop: "gave-up" }] }) }),
      agentRow({ agentNavigation: agentNavigation({ modelCalls: -1 }) }),
      agentRow({ agentNavigation: agentNavigation({ transcript: "the model said" }) }),
    ];
    for (const value of bad) expect(E2EDisplayScenarioSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("is not a v2 row: the v2 schema refuses agentNavigation, and still accepts a row without it", () => {
    expect(E2EDisplayScenarioV2Schema.safeParse(agentRow()).success).toBe(false);
    expect(E2EDisplayScenarioV2Schema.safeParse(row()).success).toBe(true);
    expect(E2EDisplayScenarioSchema.safeParse(row()).success).toBe(true);
  });
});

describe("display schema v3 baselines", () => {
  it("accepts the reason agent-steps-only on a baseline that did not run, and a list of skipped AI scenarios on one that did", () => {
    expect(E2EDisplayBaselineSchema.safeParse({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" }).success).toBe(true);
    expect(E2EDisplayBaselineSchema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "owner-export-ai", title: "Owner export ai" }] }).success).toBe(true);
    expect(E2EScenarioResultsSchema.safeParse({ scenarios: [agentRow()], baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } }).success).toBe(true);
  });

  it("refuses any other reason, a reason on a baseline that ran, a skipped list on one that did not run, rows beside a reason, and more than 64 skipped entries", () => {
    const skipped = (count: number) => Array.from({ length: count }, (_, index) => ({ scenarioId: `s-${index}`, title: `Scenario ${index}` }));
    const bad = [
      { status: "UNAVAILABLE", scenarios: [], reason: "timed-out" },
      { status: "PASSED", scenarios: [row()], reason: "agent-steps-only" },
      { status: "UNAVAILABLE", scenarios: [], skippedAiScenarios: skipped(1) },
      { status: "UNAVAILABLE", scenarios: [row()], reason: "agent-steps-only" },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: skipped(65) },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "a", title: "b", result: "PASSED" }] },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "a", title: "x".repeat(121) }] },
    ];
    for (const value of bad) expect(E2EDisplayBaselineSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(E2EDisplayBaselineSchema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: skipped(64) }).success).toBe(true);
  });

  it("is not a v2 baseline: the v2 schema refuses both fields, and still accepts an M1.3 baseline as it was", () => {
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" }).success).toBe(false);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: [] }).success).toBe(false);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "FAILED", scenarios: [row({ status: "FAILED" })] }).success).toBe(true);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "UNAVAILABLE", scenarios: [] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Test 24 and 27: the reason sentences
// ---------------------------------------------------------------------------------------------
import { afterEach, vi } from "vitest";
import { E2E_AGENT_UNKNOWN_CODES } from "@agentx/verifier";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { baselineOf, buildScenarioRows, scrubScenarioResults, type DisplayGroupInput } from "../../packages/broker/src/e2e/application-display.js";

const caseOf = { caseId: "owner-export-ai-case", scenarioId: "owner-export-ai", targetId: "web-1", accountProfileId: "orders-owner" };
const group = (overrides: Partial<DisplayGroupInput> = {}): DisplayGroupInput => ({ verdict: "UNKNOWN", reason: "", cases: [caseOf], scenarios: new Map(), result: undefined, observed: new Map(), screenshots: new Map(), ...overrides });
const rowsOf = (groups: DisplayGroupInput[], extra: { authoritative?: boolean } = {}) => buildScenarioRows({ authoritative: extra.authoritative ?? true, attach: "failed-or-incomplete", targetKinds: new Map([["web-1", "web"]]), groups }).scenarios;
const unavailableCase = (reason: string) => ({ cases: [{ caseId: caseOf.caseId, status: "unavailable", reason, assertionReceipts: [{ assertionIndex: 0, status: "unavailable" }] }] });

describe("test 24: a group that could not run says why for the closed set of route codes, and repeats nothing else", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("puts model-route-changed-reapprove and agent-route-not-approved into the owner's words, with or without the detail the broker or worker added", () => {
    for (const reason of ["model-route-changed-reapprove", "model-route-changed-reapprove: The AI navigation settings changed; approve the checks again"]) {
      expect(rowsOf([group({ reason })])[0]!.reason).toBe("The AI navigation settings changed after setup was approved. Approve setup again to run these checks.");
    }
    for (const reason of ["agent-route-not-approved", "agent-route-not-approved: the group has AI navigation steps and the admission pins no model route"]) {
      expect(rowsOf([group({ reason })])[0]!.reason).toBe("AI navigation isn't approved for this project yet. Approve setup to run the AI-navigated checks.");
    }
    expect(rowsOf([group({ reason: "model-route-budget-exhausted: 41 calls" })])[0]!.reason).toBe(E2E_OWNER_SENTENCES.agentCode["model-route-budget-exhausted"]);
  });

  it("does not repeat an unknown group code, or any text after a known one, or a code that only starts like a known one", () => {
    const hostile = ["some-new-code: password=hunter2-secret ops@tenant-a.example", "model-route-changed-reapprove-2: detail", "x model-route-changed-reapprove", "Model-Route-Changed-Reapprove", "",
      "the worker says it was fine"];
    for (const reason of hostile) {
      const [row] = rowsOf([group({ reason })]);
      expect(row!.reason, reason).toBe("this check could not be verified");
    }
    const withDetail = rowsOf([group({ reason: "agent-route-not-approved: password=hunter2-secret ops@tenant-a.example" })])[0]!;
    expect(JSON.stringify(withDetail)).not.toContain("hunter2-secret");
    expect(JSON.stringify(withDetail)).not.toContain("ops@tenant-a.example");
  });

  it("says model-environment-unsafe as 'could not be verified' and leaves one operator log line with the code only", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rows = rowsOf([group({ reason: "model-environment-unsafe: HTTPS_PROXY is set to http://10.0.0.5:3128 password=hunter2-secret" })]);
    expect(rows[0]!.reason).toBe("this check could not be verified");
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ component: "broker", event: "workflow.e2e_group_reason", code: "model-environment-unsafe" });
    expect(line).not.toContain("hunter2-secret");
    expect(line).not.toContain("10.0.0.5");
  });

  it("logs nothing for a group reason that is put into words, or for one nobody knows", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    rowsOf([group({ reason: "agent-route-not-approved" })]);
    rowsOf([group({ reason: "unknown-thing: detail" })]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("test 27: a sentence for every agent code, each a fixed string", () => {
  it("gives a case with each code its own sentence, and the sentences are all different", () => {
    const seen = new Set<string>();
    for (const code of E2E_AGENT_UNKNOWN_CODES) {
      const [row] = rowsOf([group({ verdict: "UNKNOWN", reason: "irrelevant", result: unavailableCase(code) })]);
      expect(row!.status).toBe("UNKNOWN");
      expect(row!.reason, code).toBe(E2E_OWNER_SENTENCES.agentCode[code]);
      expect(row!.reason).not.toBe("this check could not be verified");
      seen.add(row!.reason!);
    }
    expect(seen.size).toBe(E2E_AGENT_UNKNOWN_CODES.length);
  });

  it("uses the plan's exact words for agent-no-download", () => {
    const [row] = rowsOf([group({ result: unavailableCase("agent-no-download") })]);
    expect(row!.reason).toBe("The AI navigator didn't find a way to download the CSV; retry, or check the button exists");
  });

  it("puts a group's own agent code into words too (a refusal of the whole group)", () => {
    const [row] = rowsOf([group({ reason: "model-receipts-mismatch: no model receipts or action ledgers came with the group's AI navigation steps" })]);
    expect(row!.reason).toBe(E2E_OWNER_SENTENCES.agentCode["model-receipts-mismatch"]);
  });

  it("never turns a code into words for a round the broker did not accept whole", () => {
    expect(rowsOf([group({ result: unavailableCase("agent-no-download") })], { authoritative: false })[0]!.reason).toBe("the checks have not finished");
  });
});

describe("the navigation block rides on a row only from the broker's verified ledger", () => {
  const passedCase = { cases: [{ caseId: caseOf.caseId, status: "passed", reason: "ok", assertionReceipts: [{ assertionIndex: 0, status: "passed" }] }] };
  it("attaches the block the broker derived to the row of its case, once the round is whole", () => {
    const navigation = agentNavigation();
    const [row] = rowsOf([group({ verdict: "PASS", result: passedCase, agentNavigation: new Map([[caseOf.caseId, navigation]]) })]);
    expect(row).toMatchObject({ status: "PASSED", agentNavigation: navigation });
  });
  it("attaches nothing to a row the broker could not decide: its reason says why, and no 'the model clicked' stands beside it", () => {
    const [row] = rowsOf([group({ verdict: "UNKNOWN", result: unavailableCase("agent-no-download"), agentNavigation: new Map([[caseOf.caseId, agentNavigation()]]) })]);
    expect(row!.status).toBe("UNKNOWN");
    expect(row).not.toHaveProperty("agentNavigation");
  });
  it("attaches nothing for a case it has no block for, for another case's block, or for a round that is not whole", () => {
    expect(rowsOf([group({ verdict: "PASS", result: passedCase })])[0]).not.toHaveProperty("agentNavigation");
    expect(rowsOf([group({ verdict: "PASS", result: passedCase, agentNavigation: new Map([["another-case", agentNavigation()]]) })])[0]).not.toHaveProperty("agentNavigation");
    expect(rowsOf([group({ verdict: "PASS", result: passedCase, agentNavigation: new Map([[caseOf.caseId, agentNavigation()]]) })], { authoritative: false })[0]).not.toHaveProperty("agentNavigation");
  });
});

describe("scrubbing a stored result keeps the navigation block and the baseline's v3 fields, and scrubs them again", () => {
  it("keeps a clean block as it is", () => {
    const scrubbed = scrubScenarioResults({ scenarios: [agentRow()] });
    expect(scrubbed?.scenarios[0]?.agentNavigation).toEqual(agentNavigation());
  });
  it("redacts a credential pattern and an email in a goal, an element name and the route id, and keeps the block valid", () => {
    const dirty = agentRow({ agentNavigation: agentNavigation({ routeId: "route ops@tenant-a.example",
      steps: [{ goal: "Open the page with password=hunter2-secret", actedOn: [{ role: "button", name: "Mail ops@tenant-a.example" }], stop: "concluded" }] }) });
    const scrubbed = scrubScenarioResults({ scenarios: [dirty] });
    expect(scrubbed).toBeDefined();
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("ops@tenant-a.example");
    expect(scrubbed!.scenarios[0]!.agentNavigation!.steps[0]!.actedOn[0]!.role).toBe("button");
  });
  it("keeps a baseline's reason and scrubs the titles of its skipped list", () => {
    const scrubbed = scrubScenarioResults({ scenarios: [row()], baseline: { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "owner-export-ai", title: "Export for ops@tenant-a.example" }] } });
    expect(scrubbed?.baseline?.skippedAiScenarios).toEqual([{ scenarioId: "owner-export-ai", title: "Export for [email]" }]);
    expect(scrubScenarioResults({ scenarios: [row()], baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } })?.baseline).toEqual({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" });
  });
});

describe("baselineOf", () => {
  it("is exactly what it was for a plan with nothing skipped, and lists the skipped AI scenarios when there are some", () => {
    expect(baselineOf([row()])).toEqual({ status: "PASSED", scenarios: [row()] });
    expect(baselineOf([row()], [])).toEqual({ status: "PASSED", scenarios: [row()] });
    expect(baselineOf([row()], [{ scenarioId: "owner-export-ai", title: "Owner export ai" }]))
      .toEqual({ status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "owner-export-ai", title: "Owner export ai" }] });
  });
});

// ---------------------------------------------------------------------------------------------
// Tests 25, 26 and 30: the badge, the Slack line, the baseline sentences
// ---------------------------------------------------------------------------------------------
import { renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks } from "../../packages/broker/src/e2e-presentation.js";
import { results } from "../support/e2e-scenario-results.js";

const artifactPath = (sha256: string) => `/review/11111111-1111-4111-8111-111111111111/task/api/e2e/artifacts/${sha256}`;
const unescapeHtml = (value: string) => value.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const pageOf = (value: ReturnType<typeof results>) => unescapeHtml(renderE2EScenarioRowsHtml(value, { artifactPath }));
const slackOf = (value: ReturnType<typeof results>) => renderE2EScenarioSlackBlocks(value, { taskPageUrl: "https://agentx.test/review/1/task" }).map((block) => block.text.text).join("\n");

describe("test 25: the badge on an AI-navigated row", () => {
  it("says what the model clicked and which check decided, in the plan's words", () => {
    const page = pageOf(results({ scenarios: [agentRow()] }));
    expect(page).toContain("AI-navigated: the model clicked 'Download orders'; the CSV check decided");
    expect(page).toContain('<span class="tag">AI-navigated: ');
  });

  it("names at most two elements and counts the rest, says 'the model navigated' when it clicked nothing, and says 'the checks decided' when no single kind of check did", () => {
    const names = (list: string[], decidedBy?: unknown) => pageOf(results({ scenarios: [agentRow({ agentNavigation: agentNavigation({ decidedBy,
      steps: [{ goal: "g", actedOn: list.map((name) => ({ role: "button", name })), stop: "concluded" }] }) })] }));
    expect(names(["A", "B", "C", "D"], ["csv"])).toContain("AI-navigated: the model clicked 'A' and 'B' and 2 more; the CSV check decided");
    expect(names([], ["text"])).toContain("AI-navigated: the model navigated; the text check decided");
    expect(names(["A"], ["csv", "visible"])).toContain("AI-navigated: the model clicked 'A'; the checks decided");
    expect(names(["A"], undefined)).toContain("AI-navigated: the model clicked 'A'; the checks decided");
  });

  it("puts no badge on a row without a navigation block, and leaves such a page exactly as it was", () => {
    const page = pageOf(results());
    expect(page).not.toContain("AI-navigated");
    expect(renderE2EScenarioRowsHtml(results(), { artifactPath })).toBe(renderE2EScenarioRowsHtml(results({ scenarios: results().scenarios.map((item) => ({ ...item })) }), { artifactPath }));
  });

  it("scrubs the element name again and escapes it, so a stored name can't carry markup or an email", () => {
    const hostile = agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [{ role: "button", name: "<img src=x onerror=alert(1)> ops@tenant-a.example" }], stop: "concluded" }] }) });
    const raw = renderE2EScenarioRowsHtml(results({ scenarios: [hostile] }), { artifactPath });
    expect(raw).not.toContain("<img");
    expect(raw).not.toContain("ops@tenant-a.example");
  });
});

describe("test 26: one Slack line for the round", () => {
  it("adds `AI navigation: 1 step, 3 model calls (checks decide)` for a round with one AI-navigated row, directly after the counts", () => {
    const lines = slackOf(results({ scenarios: [agentRow(), ...results().scenarios] })).split("\n");
    expect(lines[0]).toMatch(/^Browser and API checks: /);
    expect(lines[1]).toBe("AI navigation: 1 step, 3 model calls (checks decide)");
    expect(lines.filter((line) => line.startsWith("AI navigation:"))).toHaveLength(1);
  });

  it("adds the steps and calls of every AI-navigated row into the one line", () => {
    const second = agentRow({ scenarioId: "owner-export-ai-2", agentNavigation: agentNavigation({ modelCalls: 2, steps: [agentNavigation().steps[0], agentNavigation().steps[0]] }) });
    expect(slackOf(results({ scenarios: [agentRow(), second] }))).toContain("AI navigation: 3 steps, 5 model calls (checks decide)");
  });

  it("says nothing about AI navigation when no row has a navigation block, and counts no baseline row", () => {
    expect(slackOf(results())).not.toContain("AI navigation");
    expect(slackOf(results({ baseline: { status: "PASSED", scenarios: [agentRow()] } }))).not.toContain("AI navigation:");
  });
});

describe("test 30 (BASEREASON): what the unchanged code did, when AI-navigated checks are not run on it", () => {
  const WORDS = /\b(pass(ed)?|fail(ed)?)\b/iu;
  const SKIPPED = [{ scenarioId: "owner-export-ai", title: "Owner export ai" }];

  it("reads 'not run' for a baseline of a plan that is all AI navigation, on the page and in Slack, without a pass or fail word and without the generic sentence", () => {
    const value = results({ baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } });
    const sentence = "Before the change: not run. Every check here uses AI navigation, which runs only on the change.";
    expect(sentence).toBe(E2E_OWNER_SENTENCES.baseline.agentStepsOnly);
    for (const text of [pageOf(value), slackOf(value)]) {
      expect(text).toContain(sentence);
      expect(text).not.toContain("Couldn't run the checks on the unchanged code");
    }
    expect(WORDS.test(sentence)).toBe(false);
  });

  it("still reads 'Couldn't run the checks' for a baseline that could not run for any other reason", () => {
    const value = results({ baseline: { status: "UNAVAILABLE", scenarios: [] } });
    expect(pageOf(value)).toContain("Couldn't run the checks on the unchanged code.");
    expect(slackOf(value)).toContain("Couldn't run the checks on the unchanged code.");
  });

  it("says how many AI-navigated checks a baseline that did run left out, and lists their titles apart from its rows", () => {
    const value = results({ baseline: { status: "PASSED", scenarios: [row(), row({ scenarioId: "tenant-isolation", title: "Tenant isolation", kind: "api" })], skippedAiScenarios: SKIPPED } });
    const page = pageOf(value);
    expect(page).toContain("1 AI-navigated check is not run on the unchanged code.");
    expect(page).toContain("<li>Owner export ai</li>");
    expect(page.match(/data-e2e-baseline-row=/gu)).toHaveLength(2);
    expect(page).not.toMatch(/data-e2e-baseline-row="owner-export-ai"/u);
    const slack = slackOf(value);
    expect(slack).toContain("1 AI-navigated check is not run on the unchanged code.");
    expect(slack).toContain("Not run before the change: Owner export ai");
    for (const added of ["1 AI-navigated check is not run on the unchanged code.", "Not run before the change: Owner export ai", "Owner export ai"]) expect(WORDS.test(added), added).toBe(false);
  });

  it("counts several skipped checks in the plural and bounds the list it prints", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ scenarioId: `ai-${index}`, title: `AI check ${index}` }));
    const value = results({ baseline: { status: "FAILED", scenarios: [row({ status: "FAILED" })], skippedAiScenarios: many } });
    expect(slackOf(value)).toContain("12 AI-navigated checks are not run on the unchanged code.");
    expect(pageOf(value)).toContain("12 AI-navigated checks are not run on the unchanged code.");
    expect(pageOf(value).match(/<li>AI check \d+<\/li>/gu)).toHaveLength(12);
  });

  it("leaves the baseline of an M1.3 plan (nothing skipped) with no mention of AI navigation", () => {
    const value = results({ baseline: { status: "PASSED", scenarios: [row()] } });
    expect(pageOf(value)).not.toContain("AI-navigated");
    expect(slackOf(value)).not.toContain("AI-navigated");
  });
});
