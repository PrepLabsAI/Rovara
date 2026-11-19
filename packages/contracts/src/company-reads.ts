// Lanes AU and EV: what a company administrator may read out of Code about their own company, over two routes under /v1/dev/client/company:
//   GET .../audit/records   the engine audit records ("person via caller" on each engine action)
//   GET .../events          the work events, and the usage they carry (`cost_settled`), polled with a cursor
// The audit record has the shape of the Cloud-to-Code contract v0's `company.audit.records` (when, who, what, on what, outcome) and adds the record's id, the actor's kind and the caller it came
// through (`via`). Both routes are bounded: a page is at most `*_PAGE_MAX` items, and one call reads at most `*_SCAN_MAX` rows, whatever the filters. A page may be short; `next` says where to go on.
import { z } from "zod";
import { AgentXNameSchema } from "./names.js";
import { WorkEventKindSchema, WorkEventPersonIdSchema, WorkEventSchema } from "./work-event.js";

export const COMPANY_AUDIT_RECORDS_PATH = "/v1/dev/client/company/audit/records";
export const COMPANY_EVENTS_PATH = "/v1/dev/client/company/events";

export const COMPANY_AUDIT_PAGE_DEFAULT = 50;
export const COMPANY_AUDIT_PAGE_MAX = 200;
/** The most audit rows one call reads. The rows of a company are in the store's key order (not time order), so a filter can only drop rows after they are read. */
export const COMPANY_AUDIT_SCAN_MAX = 2_000;
export const COMPANY_EVENTS_PAGE_DEFAULT = 100;
export const COMPANY_EVENTS_PAGE_MAX = 500;
/** The most event rows one call looks at (rows past this wait for the next call). */
export const COMPANY_EVENTS_SCAN_MAX = 2_000;
/** The most months one call's range may touch: events are kept 13 whole months after their own, so 15 covers everything that can still be there. */
export const COMPANY_EVENTS_MONTHS_MAX = 15;

/** The word naming the caller an action came through: `web`, `slack`, `cli`, `client:<sign-in client id>`. A short lower-case word, never text. */
export const AUDIT_VIA_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;
export const AuditViaSchema = z.string().regex(AUDIT_VIA_PATTERN);

/** An instant as UTC text, with or without milliseconds. */
const AuditInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u).refine((value) => !Number.isNaN(Date.parse(value)), "an instant");
/** An instant as UTC text with milliseconds, as `Date.prototype.toISOString` writes it (the form the events are keyed by). */
const EventInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u).refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "an instant with milliseconds");
/** An action name, as the audit records have it (`task.approved`), or a family of them (`task.*`). */
export const AuditActionFilterSchema = z.string().max(130).regex(/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*(?:\.\*)?$/u);
const CursorTextSchema = z.string().min(1).max(1_024);

export const CompanyAuditQuerySchema = z.object({
  from: AuditInstantSchema.optional(),
  to: AuditInstantSchema.optional(),
  project: AgentXNameSchema.optional(),
  person: WorkEventPersonIdSchema.optional(),
  action: AuditActionFilterSchema.optional(),
  limit: z.number().int().min(1).max(COMPANY_AUDIT_PAGE_MAX).optional(),
  cursor: CursorTextSchema.optional(),
}).strict();
export type CompanyAuditQuery = z.infer<typeof CompanyAuditQuerySchema>;

export const CompanyEventsQuerySchema = z.object({
  from: EventInstantSchema.optional(),
  to: EventInstantSchema.optional(),
  kinds: z.array(WorkEventKindSchema).min(1).max(15).optional(),
  project: AgentXNameSchema.optional(),
  taskId: z.string().uuid().optional(),
  person: WorkEventPersonIdSchema.optional(),
  limit: z.number().int().min(1).max(COMPANY_EVENTS_PAGE_MAX).optional(),
  cursor: CursorTextSchema.optional(),
}).strict();
export type CompanyEventsQuery = z.infer<typeof CompanyEventsQuerySchema>;

export const EngineAuditRecordSchema = z.object({
  eventId: z.string().min(1).max(256),
  at: z.string(),
  actor: z.object({ developerId: z.string().min(1).max(256), name: z.string().min(1).max(200), type: z.enum(["person", "agent", "system"]) }).strict(),
  action: z.string(),
  /** `<type>:<id>` of what the action was about, or empty when it was about nothing in particular. */
  subject: z.string(),
  /** `ok`, or `refused` for an action the engine turned down. */
  outcome: z.enum(["ok", "refused"]),
  via: AuditViaSchema.optional(),
}).strict();
export type EngineAuditRecord = z.infer<typeof EngineAuditRecordSchema>;

export const CompanyAuditResponseSchema = z.object({
  records: z.array(EngineAuditRecordSchema),
  /** Present when there may be more: pass it back as `cursor` with the same filters. A page may be short while it is present. */
  next: z.string().optional(),
  /** Rows of the company's partition that were not shown: not this company's, or not readable. Never their content. */
  skipped: z.number().int().min(0),
}).strict();
export type CompanyAuditResponse = z.infer<typeof CompanyAuditResponseSchema>;

export const CompanyEventsResponseSchema = z.object({
  events: z.array(WorkEventSchema),
  /** Where to poll from next: always present. Pass it back as `cursor` (with the same filters) to get what came after the last event seen. */
  next: z.string(),
  /** True when this call stopped before the end of the range: ask again with `next` straight away. */
  hasMore: z.boolean(),
  /** Rows of a version this code does not know. */
  unreadable: z.number().int().min(0),
  /** Rows of the company's partitions that are not this company's. Never their content. */
  skipped: z.number().int().min(0),
}).strict();
export type CompanyEventsResponse = z.infer<typeof CompanyEventsResponseSchema>;
