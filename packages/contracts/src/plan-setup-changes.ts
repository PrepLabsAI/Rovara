// L4-SC (DEC 254z c, DEC 254zw): the plan's "Setup change" section. When a task changes the setup itself (adds an outside service, a dependency, a variable or a command), the PLANNER proposes the
// change in the plan; a maintainer approves it there, bound to the plan's digest (the stored plan holds these items, so the approval of the plan is the approval of exactly them); it raises the plan's
// risk by one level; and after the pull request merges Rovara offers "Update setup" through the setup candidate -> check -> approve flow (core/setup-agent/plan-update.ts). The coding agent never writes
// a mock: it is told this list and may not add to it (core/setup-agent/plan-mock-guard.ts flags a mock or fixture file the plan did not name).
//
// An item is data only and all of it is fixed-shape text: no secret value ever travels in a plan (a `variable` is a NAME), and a `mock` names the OpenAPI description a Rovara-made fake is built from
// (general-fakes.ts), never an answer the agent made up.
//   mock        a Rovara-made fake for an outside service: the base-URL variable the code reads, and the spec file it is made from. Carried into the setup update (the project's `generalFakes`).
//   command     a setup or test command to add. Carried into the setup update (the project's commands).
//   variable    a variable NAME the code now reads; a person sets its value in the project's secrets. Listed, never carried.
//   dependency  a service the tests now talk to (a database, a queue); the test environment is approved on its own page. Listed, never carried.
import { z } from "zod";
import { sha256Hex } from "./web-hash.js";
import { canonicalJson } from "./canonical-json.js";
import { GeneralFakeServiceSchema } from "./general-fakes.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { redactText } from "./redaction.js";

export const PLAN_SETUP_CHANGES_MAX = 8;
export const PLAN_SETUP_MOCKS_MAX = 4;
export const SETUP_CHANGE_KINDS = ["mock", "command", "variable", "dependency"] as const;
export type SetupChangeKind = (typeof SETUP_CHANGE_KINDS)[number];
/** The kinds a setup update carries into the project's setup; the others are shown to the admin and left to a person. */
export const SETUP_CHANGE_CARRIED_KINDS = ["mock", "command"] as const;

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), { error: "may not contain line breaks or control characters" });
const IdSchema = z.string().regex(/^s[1-9][0-9]?$/u, "should be s1, s2 and so on");
/** The file and line that made the planner propose the change (shown one click away). */
const CiteSchema = z.object({ path: RelativeWorkspacePathSchema, line: z.number().int().min(1).max(10_000_000).optional() }).strict();
const ReasonSchema = text(200);
const VariableNameSchema = GeneralFakeServiceSchema.shape.variable;
const SpecSchema = GeneralFakeServiceSchema.shape.spec.unwrap();

const MockItemSchema = z.object({ id: IdSchema, kind: z.literal("mock"), service: text(60), variable: VariableNameSchema, spec: SpecSchema, reason: ReasonSchema, cite: CiteSchema.optional() }).strict();
const CommandItemSchema = z.object({
  id: IdSchema, kind: z.literal("command"), area: z.enum(["setup", "test"]), repo: text(100), line: text(300), reason: ReasonSchema, cite: CiteSchema.optional(),
}).strict();
const VariableItemSchema = z.object({ id: IdSchema, kind: z.literal("variable"), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "a variable name in capitals, such as STRIPE_WEBHOOK_SECRET"), reason: ReasonSchema, cite: CiteSchema.optional() }).strict();
const DependencyItemSchema = z.object({ id: IdSchema, kind: z.literal("dependency"), service: text(60), reason: ReasonSchema, cite: CiteSchema.optional() }).strict();

export const PlanSetupChangeItemSchema = z.discriminatedUnion("kind", [MockItemSchema, CommandItemSchema, VariableItemSchema, DependencyItemSchema]);
export type PlanSetupChangeItem = z.infer<typeof PlanSetupChangeItemSchema>;
export type PlanMockItem = Extract<PlanSetupChangeItem, { kind: "mock" }>;
export type PlanCommandItem = Extract<PlanSetupChangeItem, { kind: "command" }>;

/** The list as a plan holds it: 1 to 8 items, each id once, at most 4 mocks and no variable mocked twice. */
export const PlanSetupChangesSchema = z.array(PlanSetupChangeItemSchema).min(1).max(PLAN_SETUP_CHANGES_MAX).superRefine((items, context) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) context.addIssue({ code: "custom", message: "an id is used more than once" });
  const mocks = items.filter((item): item is PlanMockItem => item.kind === "mock");
  if (mocks.length > PLAN_SETUP_MOCKS_MAX) context.addIssue({ code: "custom", message: `a plan proposes at most ${String(PLAN_SETUP_MOCKS_MAX)} mocks` });
  if (new Set(mocks.map((item) => item.variable)).size !== mocks.length) context.addIssue({ code: "custom", message: "a variable is mocked once" });
});
export type PlanSetupChanges = z.infer<typeof PlanSetupChangesSchema>;

/** Whether the plan proposes any setup change (an absent or malformed list is none). */
export const planHasSetupChanges = (plan: { setupChanges?: readonly unknown[] | undefined }): boolean => Array.isArray(plan.setupChanges) && plan.setupChanges.length > 0;

/** The digest of the proposed items: what an offer and a setup candidate are bound to. Key order and spacing never change it. */
export const setupChangesDigest = (items: readonly PlanSetupChangeItem[]): string => sha256Hex(canonicalJson([...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))));

const oneLine = (value: string): string => redactText(value).replace(/\s+/gu, " ").trim();

/**
 * One line per item, in fixed words around the planner's own short text (redacted, one line). The same lines are the plan card's section and the Markdown copy the agent, the reviewers and the pull request read.
 * No digest, no spec contents: the file name only.
 */
export function setupChangeLines(items: readonly PlanSetupChangeItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "mock": return `Adds a mock for ${oneLine(item.service)} (\`${item.variable}\`), made by Rovara from \`${item.spec}\`. ${oneLine(item.reason)}`;
      case "command": return `Adds the ${item.area === "setup" ? "setup" : "test"} command \`${oneLine(item.line)}\` (in ${oneLine(item.repo)}). ${oneLine(item.reason)}`;
      case "variable": return `Adds the variable \`${item.name}\` (name only; you set the value). ${oneLine(item.reason)}`;
      case "dependency": return `Adds ${oneLine(item.service)} as a service the tests talk to. ${oneLine(item.reason)}`;
    }
  });
}

/** The words under the section on the plan card (DEC 254z c): what approving the plan does and does not do. */
export const SETUP_CHANGE_CARD_WORDS = "Approving this plan lets this task test against these mocks. It does not change the project's setup. After the pull request merges, a maintainer is asked to update the setup.";
/** What the coding agent reads under the section in the plan's Markdown copy: it never writes a mock. */
export const SETUP_CHANGE_AGENT_WORDS = "Do not write, edit or add a mock or an OpenAPI description yourself: only the mocks listed here are used, and one the plan did not name makes the pull request high risk.";
/** The one sentence Slack and Linear carry for a plan with a setup change (no Approve in chat: it is decided on the card). */
export const SETUP_CHANGE_CHAT_SENTENCE = "This plan changes the test setup, so it is approved on Rovara.";
/** The chip on the plan card. */
export const SETUP_CHANGE_CHIP = "Changes the test setup";
/** The one line the pull request carries for a mock approved with the plan. */
export const setupMockPrLine = (service: string, approvedBy: string | undefined): string =>
  `${oneLine(service)}: fake made by Rovara for this task${approvedBy === undefined ? "" : `, approved with the plan by ${oneLine(approvedBy)}`}. Not yet part of the project's setup.`;
