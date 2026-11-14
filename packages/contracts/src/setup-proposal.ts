// Meta repo lane B (K1, task B1): what the AI setup agent may propose. Browser-safe on purpose (the proposal page in the app reads it), so nothing here imports a Node module.
//
// The agent reads a project's meta repo and code repositories and PROPOSES: repositories, setup and test commands, checks, test-environment hints, a dev container,
// knowledge (rules, skills, specs, runbooks, key docs), a spec target, context sources, intake channels, allowed domains and the NAMES of secrets. Every proposed value is a
// `Proposed<T>` (provenance.ts): it carries at least one place it came from, which the broker re-reads. A model cannot propose a value from nowhere.
//
// Three rules are enforced by the readers of this contract (setup-proposal-read.ts, the broker's verification and apply), not by trust in the model:
//   - the risk of an item is decided by `setupItemHandling` below, never read from the model's answer;
//   - a command that fetches code and runs it is never an item: it is listed in `flaggedCommands` and nothing applies it;
//   - an item whose citation does not re-read is shown as "unverified" and is never pre-ticked.
import { z } from "zod";
import { AppProjectDetailSchema, isAllowedDomain } from "./app-projects.js";
import { GitBranchNameSchema } from "./git-branch.js";
import { AgentXNameSchema } from "./names.js";
import { IntakeSystemSchema } from "./intake.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { ProvenanceSchema, proposedSchema, type Proposed, type ProposalRisk } from "./provenance.js";

export const SETUP_PROPOSAL_VERSION = 2;

/** Every kind of thing a proposal item can be. The id of an item starts with its kind (`setup-api`, `repository-web`), assigned by the reader, never by the model. */
export const SETUP_ITEM_KINDS = ["repository", "setup", "tests", "check", "test_environment", "devcontainer", "knowledge", "spec_target", "source", "intake", "allowed_domain", "secret"] as const;
export type SetupItemKind = (typeof SETUP_ITEM_KINDS)[number];

export const SETUP_COMMANDS_MAX = 16;
export const SETUP_COMMAND_MAX_CHARS = 500;
/** A proposed devcontainer file is sent to a pull request intent (8 KiB with its instructions), so it is cut well below that. */
export const SETUP_DEVCONTAINER_MAX_BYTES = 6_000;
export const SETUP_SECRETS_MAX = 20;
export const SETUP_ITEM_LIMITS = {
  repositories: 31, setup: 32, tests: 32, checks: 20, testEnvironment: 10, knowledge: 40, sources: 16, intake: 8, allowedDomains: 50, secrets: SETUP_SECRETS_MAX, flagged: 40, found: 20,
} as const;

/** The only places a dev container's configuration lives. */
export const DEVCONTAINER_PATH_PATTERN = /^(?:\.devcontainer\/(?:(?![.]+\/)[A-Za-z0-9_.-]{1,64}\/)?devcontainer\.json|\.devcontainer\.json)$/u;
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

const commandLine = z.string().min(1).max(SETUP_COMMAND_MAX_CHARS);
const commandList = z.array(commandLine).min(1).max(SETUP_COMMANDS_MAX);

const HttpsRepositoryUrl = z.string().max(2_048).superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value); } catch { context.addIssue({ code: "custom", message: "url must be an https URL" }); return; }
  if (url.protocol !== "https:") context.addIssue({ code: "custom", message: "url must use https" });
  if (url.username !== "" || url.password !== "") context.addIssue({ code: "custom", message: "url must not carry a user or password" });
  // A query or a fragment is where a token goes ("?access_token="): a repository address has neither, and it is stored and shown.
  if (url.search !== "" || url.hash !== "") context.addIssue({ code: "custom", message: "url must not carry a query or a fragment" });
});

export const SetupRepositoryValueSchema = z.object({ name: AgentXNameSchema, url: HttpsRepositoryUrl, defaultBranch: GitBranchNameSchema.optional() }).strict();
export const SetupCommandsValueSchema = z.object({ repo: AgentXNameSchema, commands: commandList }).strict();
export const SetupCheckValueSchema = z.object({ name: z.string().trim().min(1).max(80), repo: AgentXNameSchema, command: commandLine }).strict();
export const SetupTestEnvironmentValueSchema = z.object({ hint: z.string().trim().min(1).max(500) }).strict();
export const SetupDevcontainerValueSchema = z.object({
  repository: AgentXNameSchema,
  configPath: z.string().regex(DEVCONTAINER_PATH_PATTERN),
  exists: z.boolean(),
  proposedContent: z.string().max(32_768).optional(),
}).strict();

export const SETUP_KNOWLEDGE_KINDS = ["rule", "skill", "spec", "runbook", "keyDoc"] as const;
export const SETUP_KNOWLEDGE_ACTIVATIONS = ["always", "file_match", "manual", "auto"] as const;
export const SetupKnowledgeValueSchema = z.object({
  path: RelativeWorkspacePathSchema,
  kind: z.enum(SETUP_KNOWLEDGE_KINDS),
  activation: z.enum(SETUP_KNOWLEDGE_ACTIVATIONS).optional(),
}).strict();

export const SETUP_SPEC_FORMATS = ["kiro", "spec_kit", "other"] as const;
export const SetupSpecTargetValueSchema = z.object({ format: z.enum(SETUP_SPEC_FORMATS), path: RelativeWorkspacePathSchema }).strict();

export const SETUP_SOURCE_FOUND_IN = ["mcp_config", "readme", "connection"] as const;
/** A source is a NAME. Never an address, a command or a secret: a repository's MCP config is reported as found, not connected. */
export const SetupSourceValueSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, "a source is a name, never an address"),
  foundIn: z.enum(SETUP_SOURCE_FOUND_IN),
  matchesConnection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/).optional(),
}).strict();

export const SETUP_INTAKE_CHANNELS = ["slack", "linear", "jira", "github_issue", "tracker", "other"] as const;
/**
 * One place work is asked for, as the setup agent proposes it. `system` names a team's own tracker (a `tracker` channel); `connection` names an org connection (a name, never an address or a secret);
 * `label` is the label that asks for work (a routing hint only: whether work starts depends on who put it on, never on the label). The approval card is what turns this into an intake source.
 */
export const SetupIntakeValueSchema = z.object({
  channel: z.enum(SETUP_INTAKE_CHANNELS), hint: z.string().trim().min(1).max(200),
  system: IntakeSystemSchema.optional(),
  connection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/, "a connection is a name, never an address or a host name").optional(),
  label: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u, "one plain line").optional(),
}).strict();

export const SetupAllowedDomainValueSchema = z.string().max(253).refine((value) => value === value.toLowerCase() && isAllowedDomain(value), "not a domain the project settings accept");
export const SetupSecretValueSchema = z.object({ name: z.string().regex(SECRET_NAME_PATTERN), why: z.string().max(300) }).strict();

export type SetupIntakeValue = z.infer<typeof SetupIntakeValueSchema>;
export type SetupRepositoryValue = z.infer<typeof SetupRepositoryValueSchema>;
export type SetupCommandsValue = z.infer<typeof SetupCommandsValueSchema>;
export type SetupDevcontainerValue = z.infer<typeof SetupDevcontainerValueSchema>;

export const SetupFlaggedCommandSchema = z.object({
  command: z.string().min(1).max(1024),
  reason: z.string().min(1).max(300),
  from: z.array(ProvenanceSchema).min(1).max(8),
}).strict();

/** Things the agent found and will not use: a repository's MCP config (reported "found, not connected") and its hooks ("found, not run"). */
export const SetupFoundNotUsedSchema = z.object({ kind: z.enum(["hook", "mcp_config"]), repo: AgentXNameSchema, path: RelativeWorkspacePathSchema }).strict();

const Commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const SetupProposalSchema = z.object({
  version: z.literal(SETUP_PROPOSAL_VERSION),
  basedOnRevision: z.number().int().min(0),
  metaRepo: z.object({ name: AgentXNameSchema, commit: Commit }).strict().optional(),
  repositories: z.array(proposedSchema(SetupRepositoryValueSchema)).max(SETUP_ITEM_LIMITS.repositories),
  setup: z.array(proposedSchema(SetupCommandsValueSchema)).max(SETUP_ITEM_LIMITS.setup),
  tests: z.array(proposedSchema(SetupCommandsValueSchema)).max(SETUP_ITEM_LIMITS.tests),
  checks: z.array(proposedSchema(SetupCheckValueSchema)).max(SETUP_ITEM_LIMITS.checks),
  /** Input to the test-environment design; never applied here. */
  testEnvironment: z.array(proposedSchema(SetupTestEnvironmentValueSchema)).max(SETUP_ITEM_LIMITS.testEnvironment),
  devcontainer: proposedSchema(SetupDevcontainerValueSchema).optional(),
  knowledge: z.array(proposedSchema(SetupKnowledgeValueSchema)).max(SETUP_ITEM_LIMITS.knowledge),
  specTarget: proposedSchema(SetupSpecTargetValueSchema).optional(),
  sources: z.array(proposedSchema(SetupSourceValueSchema)).max(SETUP_ITEM_LIMITS.sources),
  intake: z.array(proposedSchema(SetupIntakeValueSchema)).max(SETUP_ITEM_LIMITS.intake),
  allowedDomains: z.array(proposedSchema(SetupAllowedDomainValueSchema)).max(SETUP_ITEM_LIMITS.allowedDomains),
  secretsNeeded: z.array(proposedSchema(SetupSecretValueSchema)).max(SETUP_ITEM_LIMITS.secrets),
  flaggedCommands: z.array(SetupFlaggedCommandSchema).max(SETUP_ITEM_LIMITS.flagged),
  foundNotUsed: z.array(SetupFoundNotUsedSchema).max(SETUP_ITEM_LIMITS.found),
  notes: z.string().max(2000),
}).strict().superRefine((proposal, context) => {
  const seen = new Set<string>();
  for (const item of setupItemsOf(proposal)) {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: [item.id], message: "item ids are unique within a proposal" });
    seen.add(item.id);
  }
});
export type SetupProposal = z.infer<typeof SetupProposalSchema>;

/** One proposed item, whatever its kind: what the proposal page and the apply route walk. */
export interface SetupItem {
  id: string;
  kind: SetupItemKind;
  proposed: Proposed<unknown>;
}

/** Every item of a proposal, in the order the page shows them. */
export function setupItemsOf(proposal: Pick<SetupProposal, "repositories" | "setup" | "tests" | "checks" | "testEnvironment" | "devcontainer" | "knowledge" | "specTarget" | "sources" | "intake" | "allowedDomains" | "secretsNeeded">): SetupItem[] {
  const items: SetupItem[] = [];
  const add = (kind: SetupItemKind, proposed: ReadonlyArray<Proposed<unknown>> | Proposed<unknown> | undefined) => {
    if (proposed === undefined) return;
    for (const entry of Array.isArray(proposed) ? proposed : [proposed]) items.push({ id: (entry as Proposed<unknown>).id, kind, proposed: entry as Proposed<unknown> });
  };
  add("repository", proposal.repositories);
  add("setup", proposal.setup);
  add("tests", proposal.tests);
  add("check", proposal.checks);
  add("test_environment", proposal.testEnvironment);
  add("devcontainer", proposal.devcontainer);
  add("knowledge", proposal.knowledge);
  add("spec_target", proposal.specTarget);
  add("source", proposal.sources);
  add("intake", proposal.intake);
  add("allowed_domain", proposal.allowedDomains);
  add("secret", proposal.secretsNeeded);
  return items;
}

/**
 * What applying an item does:
 *   - `settings`: the broker saves it through the project settings (a maintainer's save, with the same checks), unless a person's own value is there;
 *   - `approval`: it gets its OWN approval card (a person decides it on the confirmation page after signing in again); nothing changes until then;
 *   - `website_proposal`: allowed websites are widened only through the browser proposal flow, so the item hands off to it;
 *   - `info`: shown with where it came from; nothing in the project settings holds it yet.
 */
export const SETUP_ITEM_HANDLINGS = ["settings", "approval", "website_proposal", "info"] as const;
export type SetupItemHandling = (typeof SETUP_ITEM_HANDLINGS)[number];

/** How an item is handled. Decided here, from the kind and the value: the model's own opinion of an item's risk is never read. */
export function setupItemHandling(kind: SetupItemKind, value: unknown): SetupItemHandling {
  switch (kind) {
    case "setup":
    case "tests":
      return "settings";
    case "devcontainer": {
      const container = value as { exists?: unknown; proposedContent?: unknown } | undefined;
      if (container?.exists === true) return "settings";
      return typeof container?.proposedContent === "string" ? "approval" : "info";
    }
    case "repository":
    case "source":
    case "intake":
    case "secret":
      return "approval";
    case "allowed_domain":
      return "website_proposal";
    default:
      return "info";
  }
}

/** The risk class an item carries on the proposal page (provenance.ts `ProposalRisk`): safe for what a maintainer's save applies and what is only shown, needs_admin for the rest. */
export function setupItemRisk(kind: SetupItemKind, value: unknown): ProposalRisk {
  return setupItemHandling(kind, value) === "settings" || setupItemHandling(kind, value) === "info" ? "safe" : "needs_admin";
}

// ---- the page and the apply route

/** Whether an item's citations were re-read by the broker. `unchecked`: nothing to re-read (an inferred item) or GitHub could not be asked; `unverified`: it was read and does not match. */
export const SETUP_VERIFICATION_STATES = ["verified", "unverified", "unchecked"] as const;
export type SetupVerification = (typeof SETUP_VERIFICATION_STATES)[number];

const ItemId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** What the page shows beside an item: how it is handled, whether its citations hold and, for a setting, what the project has now ("You typed X. Rovara suggests Y."). */
export const SetupReviewEntrySchema = z.object({
  id: ItemId,
  handling: z.enum(SETUP_ITEM_HANDLINGS),
  verification: z.enum(SETUP_VERIFICATION_STATES),
  /**
   * What the project has now. `managed_by_file`: the meta repo's config file manages this setting, so it is changed there. `setBy` (with `differs`): who set the value the project has,
   * a person or an earlier Rovara proposal; a person's value is replaced only on that item's own tick.
   */
  current: z.object({ state: z.enum(["empty", "same", "differs", "managed_by_file"]), yours: z.array(z.string().max(600)).max(64).optional(), setBy: z.enum(["person", "agent"]).optional() }).strict().optional(),
  /** Why the item cannot be applied from here (fixed words), when it cannot. */
  unavailable: z.string().max(200).optional(),
  /** The asker's own approval card for this item, when one was made: `approved` means a maintainer may now apply the item. */
  approval: z.object({ approvalId: z.string().min(1).max(200), state: z.enum(["pending", "approved", "declined", "expired"]) }).strict().optional(),
}).strict();
export type SetupReviewEntry = z.infer<typeof SetupReviewEntrySchema>;

export const SETUP_APPLY_ITEMS_MAX = 64;
/**
 * `POST …/setup-draft/apply`: the items the person ticked, each by id. Nothing is applied that is not named. `useSuggestion` is the per-item "Use Rovara's" tick: without it
 * an item never replaces a value the project already has.
 */
export const SetupApplyBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  items: z.array(z.object({ id: ItemId, useSuggestion: z.boolean().optional() }).strict()).min(1).max(SETUP_APPLY_ITEMS_MAX),
  /** True only when the person asks to run the check of these commands again after it failed (without it, a failed check for the same commands and settings is shown again, not re-run). */
  checkAgain: z.boolean().optional(),
}).strict().superRefine((body, context) => {
  const seen = new Set<string>();
  for (const [index, item] of body.items.entries()) {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: ["items", index, "id"], message: "an item is named once" });
    seen.add(item.id);
  }
});
export type SetupApplyBody = z.infer<typeof SetupApplyBodySchema>;

/** `checking`: the commands are being run on a fresh machine and nothing is saved yet; `check_failed`: they did not pass, so nothing was saved. */
/** `proposed` (owner decision 11, one apply path): setup and test commands went to the test environment as its proposal, to be checked, proved and approved there; nothing was saved. */
export const SETUP_APPLY_OUTCOMES = ["applied", "already_set", "kept_yours", "approval_needed", "website_proposal", "not_available", "managed_by_file", "unknown_item", "failed", "checking", "check_failed", "proposed"] as const;
export type SetupApplyOutcome = (typeof SETUP_APPLY_OUTCOMES)[number];

export const SetupApplyResultItemSchema = z.object({
  id: ItemId,
  kind: z.enum(SETUP_ITEM_KINDS),
  outcome: z.enum(SETUP_APPLY_OUTCOMES),
  /** Fixed words, never the model's or a repository's. */
  message: z.string().max(300).optional(),
  /** `check_failed`: why the check of the commands did not pass or did not start (a redacted one-liner from the check, never a model's text). */
  reason: z.string().max(400).optional(),
  /** `approval_needed`: the card for this one item. */
  approval: z.object({ approvalId: z.string().min(1).max(200), confirmUrl: z.string().max(2_048) }).strict().optional(),
  /** `proposed` (owner decision 11): the test environment proposal the commands went to, so the page can open it. */
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** `website_proposal`: the domains to carry to the website proposal flow. */
  domains: z.array(z.string().max(253)).max(50).optional(),
  /** `applied` for a dev container pull request: the task that opens it. */
  pullRequest: z.object({ taskId: z.string().max(100), sessionId: z.string().max(100).optional(), sessionUrl: z.string().max(2_048).optional() }).strict().optional(),
}).strict();
export type SetupApplyResultItem = z.infer<typeof SetupApplyResultItemSchema>;

/** What `POST …/setup-draft/apply` answers: the project as the app shows it, and what happened to each named item. */
export const SetupApplyResponseSchema = z.object({
  project: AppProjectDetailSchema,
  warnings: z.array(z.string().max(500)).max(100),
  setupCheck: z.enum(["started", "not_started", "not_needed"]),
  setupCheckMessage: z.string().max(500).optional(),
  results: z.array(SetupApplyResultItemSchema).max(SETUP_APPLY_ITEMS_MAX),
}).strict();
export type SetupApplyResponse = z.infer<typeof SetupApplyResponseSchema>;
