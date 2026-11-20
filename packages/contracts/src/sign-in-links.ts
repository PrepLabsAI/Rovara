// DEC 254w: account linking between sign-in methods. A signed-in person connects a second sign-in method to their OWN person record, inside their
// live session; the second method then signs in as the same person (one person, one member record, one role). The broker may not write the
// sign-in table, so every request below goes to DeveloperIdentity, which owns it. Each names the CALLER by the developer id and session id of
// their verified access token (never body values of a public route); DeveloperIdentity reads that session from its own table.
import { z } from "zod";
import { DeveloperSignInMethodSchema } from "./developer-web.js";

/**
 * The methods a person may connect as a second sign-in. Today Slack and GitHub; a later method (Google) is added here and given a provider, and
 * nothing else in the link flow names a method.
 */
export const LINKABLE_SIGN_IN_METHODS = ["slack", "github"] as const;
export const LinkableSignInMethodSchema = z.enum(LINKABLE_SIGN_IN_METHODS);
export type LinkableSignInMethod = z.infer<typeof LinkableSignInMethodSchema>;

/** How long a started link may take, start to finish (seconds): short, and single use. */
export const SIGN_IN_LINK_SECONDS = 300;

const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/);
const SessionId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** A PKCE S256 challenge or verifier (RFC 7636 4.1, 4.2). */
const Pkce = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
/** The id of a started link (`lnk_` and 43 base64url characters) and the one-time code its callback hands the browser. */
export const SignInLinkIdSchema = z.string().regex(/^lnk_[A-Za-z0-9_-]{43}$/);
export const SignInLinkCodeSchema = z.string().regex(/^lnc_[A-Za-z0-9_-]{43}$/);
/** The web app's own state for the round trip (opaque to Code, handed back unchanged). */
const ClientState = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

// ---- The public routes' bodies (the broker validates them strictly before anything else) ----
export const SignInLinkStartBodySchema = z.object({ method: LinkableSignInMethodSchema, challenge: Pkce, returnTo: z.string().url().max(2_048), state: ClientState }).strict();
export type SignInLinkStartBody = z.infer<typeof SignInLinkStartBodySchema>;
export const SignInLinkFinishBodySchema = z.object({ linkId: SignInLinkIdSchema, linkCode: SignInLinkCodeSchema, verifier: Pkce }).strict();
export type SignInLinkFinishBody = z.infer<typeof SignInLinkFinishBodySchema>;

// ---- The broker's requests to DeveloperIdentity ----
/** Start: the caller's live web-app session asks to connect `method`; the answer is where to send the browser. */
export const SignInLinkStartRequestSchema = z.object({
  kind: z.literal("sign-in-link-start"), developerId: DeveloperId, sessionId: SessionId,
  method: LinkableSignInMethodSchema, challenge: Pkce, returnTo: z.string().url().max(2_048), state: ClientState,
}).strict();
export type SignInLinkStartRequest = z.infer<typeof SignInLinkStartRequestSchema>;
/** Finish: the SAME session, with the browser's one-time code and the web app's verifier, attaches the proved identity to the caller's person. */
export const SignInLinkFinishRequestSchema = z.object({
  kind: z.literal("sign-in-link-finish"), developerId: DeveloperId, sessionId: SessionId, linkId: SignInLinkIdSchema, linkCode: SignInLinkCodeSchema, verifier: Pkce,
}).strict();
export type SignInLinkFinishRequest = z.infer<typeof SignInLinkFinishRequestSchema>;
/** The connected sign-ins of `personDeveloperId` (the caller's own, or, for a company owner or admin, a person of their company). A live session is enough. */
export const SignInLinksListRequestSchema = z.object({ kind: z.literal("sign-in-links-list"), developerId: DeveloperId, sessionId: SessionId, personDeveloperId: DeveloperId }).strict();
export type SignInLinksListRequest = z.infer<typeof SignInLinksListRequestSchema>;
/** Unlink one connected method of `personDeveloperId`: the person themselves or a company owner or admin. The first method can never be removed. */
export const SignInUnlinkRequestSchema = z.object({ kind: z.literal("sign-in-unlink"), developerId: DeveloperId, sessionId: SessionId, personDeveloperId: DeveloperId, method: LinkableSignInMethodSchema }).strict();
export type SignInUnlinkRequest = z.infer<typeof SignInUnlinkRequestSchema>;

/** One sign-in method of a person: `primary` is the method the person first signed in with (never removable). */
export const ConnectedSignInSchema = z.object({ method: DeveloperSignInMethodSchema, primary: z.boolean(), linkedAt: z.iso.datetime().optional() }).strict();
export type ConnectedSignIn = z.infer<typeof ConnectedSignInSchema>;

/**
 * The refusals. `refused` is the ONE answer for every reason a link cannot be made (already linked to someone, a workspace that proves nothing,
 * the company's own sign-in, a revoked person, a used, expired or foreign link): the words never say which.
 * `signed_out`: the caller's session is not live. `forbidden`: not the person and not their company's owner or admin. `last_method`: the method
 * is the person's first (or only) one. `not_found`: no such connected method. `not_set_up`: linking is off on this install.
 */
export type SignInLinkRefusal = { ok: false; error: "refused" | "signed_out" | "forbidden" | "last_method" | "not_found" | "not_set_up" | "invalid_request" | "unavailable"; message: string };
export type SignInLinkStartResponse = { ok: true; authorizeUrl: string; linkId: string } | SignInLinkRefusal;
export type SignInLinkFinishResponse = { ok: true; method: LinkableSignInMethod } | SignInLinkRefusal;
export type SignInLinksListResponse = { ok: true; signIns: ConnectedSignIn[] } | SignInLinkRefusal;
export type SignInUnlinkResponse = { ok: true } | SignInLinkRefusal;

/** Fixed words, never echoing anything a request or a provider sent. */
export const SIGN_IN_LINK_TEXT = {
  refused: "That sign-in can't be connected to your account.",
  signedOut: "Your Rovara sign-in has ended. Sign in again.",
  forbidden: "Only the person or a company owner or admin can change this person's sign-ins.",
  lastMethod: "This is the first way this person signs in, so it can't be removed.",
  notFound: "That sign-in is not connected.",
  notSetUp: "Connecting sign-ins is not set up on this install.",
  invalid: "That request is not one Rovara understands.",
  unavailable: "Rovara could not finish this just now. Try again in a moment.",
} as const;
