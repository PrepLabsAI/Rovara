// Person erase (row 13.1): the Code API a company admin calls to erase one person in their company (`POST /v1/app/people/<personId>/erase`). The engine erase and its receipt are Code's
// (broker core/people/erase.ts); the caller's company comes from membership, never from this body, and the press needs a fresh step-up with a factor Code owns.
import { z } from "zod";

/** The body: only the request id that makes the call repeatable (the same id, or any repeat, records nothing new). Nothing else is accepted. */
export const PersonEraseRequestSchema = z.object({ requestId: z.string().uuid() }).strict();
export type PersonEraseRequest = z.infer<typeof PersonEraseRequestSchema>;

export const PersonEraseCountsSchema = z.object({
  links: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  erased: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  incomplete: z.number().int().nonnegative(),
}).strict();

/** The answer: when the person was erased (the first time, on a repeat), whether this call repeated it, and whether their stored evidence is gone in every version or still owed. Counts only. */
export const PersonEraseReceiptSchema = z.object({
  personId: z.string().min(1).max(100),
  erasedAt: z.string().datetime(),
  alreadyErased: z.boolean(),
  evidence: z.enum(["done", "owed"]),
  counts: PersonEraseCountsSchema,
}).strict();
export type PersonEraseReceipt = z.infer<typeof PersonEraseReceiptSchema>;

/** What the person is told when the evidence is still owed: the walk continues on its own, and the same request finishes it sooner. */
export const PERSON_ERASE_OWED_WORDS = "The person is erased. Some of their stored test evidence is still being removed; send the same request again to finish it sooner.";
