import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
// Split from session-views.ts: the web app's first JavaScript reads this answer, but not the session view (and the task view it holds), which only the session screens read.
export const NEEDS_CONFIRMATION_CHANGES_MAX = 10;
export const CHANGE_TEXT_MAX = 300;
const URL_MAX = 2048;

/**
 * What a take-over or a company-wide share answers (HTTP 202) when the caller isn't signed in freshly enough to decide it: a link to open
 * in a browser. It is the shape of Plan 3's own pending-change routes, so CLI and MCP clients print the link and never say the sign-in ended.
 */
/** Shared confirmation metadata; absent on ordinary two-person confirmations. */
export const SoleOwnerConfirmationSchema = z.object({
  available:z.boolean(),availableAt:z.string().datetime().nullable(),
  reasonCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional(),
}).strict();

export const NeedsConfirmationSchema = z
  .object({
    status: z.literal("NEEDS_CONFIRMATION"),
    soleOwner: SoleOwnerConfirmationSchema.optional(),
    code: z.literal("REAUTH_REQUIRED"),
    confirmUrl: z.string().url().max(URL_MAX).refine((value) => value.startsWith("https://"), "must be an https link"),
    changes: z.array(z.string().min(1).max(CHANGE_TEXT_MAX)).max(NEEDS_CONFIRMATION_CHANGES_MAX),
  })
  .strict();

export type NeedsConfirmation = z.infer<typeof NeedsConfirmationSchema>;

/** How a client reads a `202 NEEDS_CONFIRMATION`: the broker adds the gateway's `requestId` to it, which the strict schema above refuses (bug E). */
export const NeedsConfirmationReaderSchema = forwardReader(NeedsConfirmationSchema);
