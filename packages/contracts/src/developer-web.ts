// The sign-in side of the signed-in person's own answers (`GET /v1/app/me`, `PUT /v1/app/me/name`). Trimmed from Cloud's developer-web.ts for Code (port lane L1):
// the company directory, member lookup and role change, invite list and status, and the trial state belong to Cloud (decision 41) and stay in Cloud's file, which
// keeps this part unchanged. Decision 51 gap: the sign-in method list below names its providers in the core.
import { z } from "zod";
import { OrgRoleNameSchema } from "./company-scope.js";
import { DISPLAY_NAME_MAX_CODE_POINTS, containsEmailAddress, isReservedDisplayName } from "./display-name.js";
import { forwardReader } from "./forward-reader.js";
import { BUILT_IN_SIGN_IN_METHODS, SignInMethodIdSchema } from "./outside-account.js";
/** The built-in sign-in methods the hosted sign-in server knows (a closed list for that server). Shapes that only carry a method use the open `SignInMethodIdSchema` (outside-account.ts; lane P3, item I2). */
export const DeveloperSignInMethodSchema = z.enum(BUILT_IN_SIGN_IN_METHODS);
export type DeveloperSignInMethod = z.infer<typeof DeveloperSignInMethodSchema>;
/**
 * One sign-in method linked to a developer (`GET /v1/app/me`). It names the method and what the person recognises it by, never the
 * provider's issuer or subject.
 */
export const LinkedIdentitySchema = z.object({
  provider: SignInMethodIdSchema,
  email: z.string().optional(),
  login: z.string().optional(),
  linkedAt: z.string(),
  lastSignInAt: z.string(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentitySchema>;

/** `GET /v1/app/me`: who the signed-in developer is, their org, and every sign-in method linked to them. */
export const AppMeResponseSchema = z.object({
  csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  developer: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    /** Never an email address (release 0.4.16): the name the person chose, else the sign-in provider's real name, else a placeholder such as "Member 3fa9". */
    name: z.string().min(1).max(200),
    /** The person's own email: theirs to see, never shown to others. */
    email: z.string().optional(),
    orgRole: OrgRoleNameSchema,
    /** True once the person chose their name; false while it is the provider's or a placeholder (the web app then asks once). Absent from a control plane that predates it. */
    nameChosen: z.boolean().optional(),
  }),
  org: z.object({ orgId: z.string(), name: z.string(), plan: z.string(), nameIsDefault: z.boolean().optional() }),
  identities: z.array(LinkedIdentitySchema),
  /** UX1: the sign-in methods this person may link from the web app (the method is on here). Absent from an older control plane. */
  linkable: z.object({ slack: z.boolean(), github: z.boolean() }).optional(),
});
export type AppMeResponse = z.infer<typeof AppMeResponseSchema>;


export const AppMeResponseReaderSchema = forwardReader(AppMeResponseSchema);

/** Control characters and format characters (bidi controls, zero-width spaces, tag characters) other than ZWNJ and ZWJ, which scripts and emoji sequences need. */
const NAME_UNSAFE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

/**
 * `PUT /v1/app/me/name` (release 0.4.16): the name the signed-in person chooses for themselves. 1 to 80 characters after trimming, no control characters, no email
 * address, at least one letter or number. The person is the session's, never anything the body carries, so the body holds the name and nothing else.
 */
export const SetMyNameBodySchema = z.object({
  name: z.string()
    .refine((value) => !NAME_UNSAFE.test(value), "must not contain control characters")
    .transform((value) => value.replace(/\s+/gu, " ").trim())
    .refine((value) => value.length > 0 && Array.from(value).length <= DISPLAY_NAME_MAX_CODE_POINTS, `must have 1 to ${String(DISPLAY_NAME_MAX_CODE_POINTS)} characters`)
    .refine((value) => !containsEmailAddress(value), "must not be an email address")
    .refine((value) => /[\p{L}\p{N}]/u.test(value), "must have a letter or a number")
    .refine((value) => !isReservedDisplayName(value), "can't look like a placeholder name such as Member 3fa9c1d2"),
}).strict();
export type SetMyNameBody = z.output<typeof SetMyNameBodySchema>;

/** `PUT /v1/app/me/name`: the name now stored, always chosen. */
export const SetMyNameResponseSchema = z.object({ name: z.string().min(1).max(200), nameChosen: z.literal(true) }).strict();
export type SetMyNameResponse = z.infer<typeof SetMyNameResponseSchema>;
export const SetMyNameResponseReaderSchema = forwardReader(SetMyNameResponseSchema);
