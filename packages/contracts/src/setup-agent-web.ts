// The setup run, as the app's Setup screen reads and writes it: the run's state, its journal and host asks, a person's command, the stop, and "Use this setup" (confirm). Browser-safe: it
// imports only other browser-safe contracts. The server (`core/setup-agent/agent.ts`, `apply.ts`) is the authority; these are the shapes the page reads and sends, so a newer server's unknown words are refused.
import { z } from "zod";
import { SESSION_ID_PATTERN } from "./browser-ids.js";
import { SETUP_VERIFICATION_STATES, SetupProposalSchema } from "./setup-proposal.js";
import { SetupAgentLimitsSchema, SetupHostSchema, SetupJournalEntrySchema, SetupRunEndWordSchema, SetupRunSummarySchema } from "./setup-run.js";

export const SETUP_AGENT_VIEW_STATUSES = ["none", "running", "ready", "failed"] as const;

export const SetupAgentViewSchema = z.object({
  status: z.enum(SETUP_AGENT_VIEW_STATUSES),
  basedOnRevision: z.number().int().min(0),
  limits: SetupAgentLimitsSchema,
  taskId: z.string().uuid().optional(),
  startedAt: z.string().datetime().optional(),
  /** The run's session: the Live wall's steer messages go to it. */
  sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
  stop: SetupRunEndWordSchema.optional(),
  summary: SetupRunSummarySchema.optional(),
  proposal: SetupProposalSchema.optional(),
  failure: z.string().max(1_000).optional(),
  verification: z.record(z.string().min(1).max(100), z.enum(SETUP_VERIFICATION_STATES)).optional(),
  verified: z.boolean().optional(),
  /** A company admin has turned setup runs off: nothing can be started. */
  companySetupOff: z.literal(true).optional(),
  /** The company's locks row does not read: runs are held until an admin repairs it. */
  companyLocksUnreadable: z.literal(true).optional(),
  /** A run a person stopped: who (a name, one plain line) and when. Its proposal, if it has one, is what the run had so far: unproven and never applied. */
  stoppedBy: z.object({ name: z.string().min(1).max(100), at: z.string().datetime() }).strict().optional(),
}).passthrough();
export type SetupAgentView = z.infer<typeof SetupAgentViewSchema>;

export const SetupAgentRequestBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const SetupAgentCommandRequestSchema = z.object({ requestId: z.string().uuid(), command: z.string().min(1).max(2_000) }).strict();
export const SetupAgentCommandReplySchema = z.object({ seq: z.number().int().min(1), state: z.enum(["queued", "taken", "done"]) }).passthrough();

export const SetupHostAskViewSchema = z.object({
  host: SetupHostSchema,
  status: z.enum(["open", "approved", "refused"]),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
}).passthrough();
export type SetupHostAskView = z.infer<typeof SetupHostAskViewSchema>;

export const SetupJournalReplySchema = z.object({
  status: z.enum(SETUP_AGENT_VIEW_STATUSES),
  entries: z.array(SetupJournalEntrySchema).max(400),
  hostAsks: z.array(SetupHostAskViewSchema).max(50),
}).passthrough();
export type SetupJournalReply = z.infer<typeof SetupJournalReplySchema>;

export const SetupConfirmRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  itemIds: z.array(z.string().min(1).max(100)).max(64).optional(),
}).strict();
export const SETUP_CONFIRM_LEFT_OUT = ["unverified", "refused_command", "not_a_command_item", "too_many", "invalid_command"] as const;
export const SetupConfirmReplySchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  used: z.array(z.string().min(1).max(100)).max(64),
  unchecked: z.array(z.string().min(1).max(100)).max(64),
  left: z.array(z.object({ id: z.string().min(1).max(100), reason: z.enum(SETUP_CONFIRM_LEFT_OUT) }).strict()).max(200),
  /** Always false here: the Prove is the wizard's, on the project's setup check. */
  proved: z.boolean(),
  next: z.literal("check"),
}).passthrough();
export type SetupConfirmReply = z.infer<typeof SetupConfirmReplySchema>;
