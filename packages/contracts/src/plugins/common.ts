// Plug-in foundations, task P1: the words every plug-in port shares. This folder holds types and Zod schemas only: no adapter, no I/O.
//
// Ports live in `contracts`; adapters live in `broker/src/plugins/<kind>/<name>/` and ship in the release (no code is loaded at run time).
// The vocabulary is neutral: change request (a pull request or a CR), revision (a commit or a CR revision), check (a CI job or a build),
// review and comment, item (a ticket or a task). A caller never branches on an adapter's name; it reads the adapter's capabilities.
import { z } from "zod";
import { OrgIdSchema } from "../browser-ids.js";

/** What a plug-in is called: lower-case words and digits with hyphens. A built-in kind, or one the install's owner names in the plug-in config (the install loads the adapters its config names, decision 40); a kind is registered by its adapter, never by a caller's request. */
export const PluginKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type PluginKind = z.infer<typeof PluginKindSchema>;

/**
 * Whose authority a plug-in call runs under, for the install's own credential rules: one company's own work (`orgId` is the company id), or a system
 * caller that names no company: `webhook` (a signed delivery a host sent) or `install` (the install's own work, for an install that runs as one company).
 * `private-install` is the older spelling of `install` and is still read (it parses as `install`); it goes away after one release, so write `install`.
 */
export const HostScopeSchema = z.union([
  z.object({ orgId: OrgIdSchema }).strict(),
  z.object({ system: z.enum(["webhook", "install", "private-install"]).transform((system) => (system === "private-install" ? "install" as const : system)) }).strict(),
]);
export type HostScope = z.infer<typeof HostScopeSchema>;

/** A repository as the install registered it (the address the plug-in resolves). The plug-in decides what the address means; the broker never parses it. */
export const RepositoryRefSchema = z.object({ url: z.string().min(1).max(2_048) }).strict();
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

/** A revision: a commit id or a CR revision id, opaque to everything but the plug-in. */
export const RevisionSchema = z.string().min(1).max(200);
export type Revision = z.infer<typeof RevisionSchema>;

/**
 * A commit id of the hash length the host uses, as lower-case hex: 40 digits for SHA-1 and 64 for SHA-256, and anything between up to 128 so a host's longer id is not refused by the core. The core never decides the length (item C4);
 * an adapter that knows its host's exact length holds it itself.
 */
export const COMMIT_ID_SOURCE = "[a-f0-9]{40,128}";
export const COMMIT_ID_PATTERN = new RegExp(`^${COMMIT_ID_SOURCE}$`, "u");
export const CommitIdSchema = z.string().regex(COMMIT_ID_PATTERN, "a commit id");
export const isCommitId = (value: unknown): value is string => typeof value === "string" && COMMIT_ID_PATTERN.test(value);

/** A branch name as one short line. */
export const BranchNameSchema = z.string().min(1).max(250).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "a branch name has no control characters");

/** Ids and numbers an outside system hands out, kept as short strings so a host that uses numbers and one that uses uuids look the same. */
export const ExternalIdSchema = z.string().min(1).max(200);

/** A link an outside system gave: https only, no credentials in it. Empty when it gave none. */
export const HttpsUrlOrEmptySchema = z.string().max(2_048).refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "an https link without credentials, or empty");

/** A person's account at an outside system. `login` is how the host names it; `hostUserId` is its stable id when it has one. */
export const HostAccountSchema = z.object({ login: z.string().min(1).max(200), hostUserId: ExternalIdSchema.optional() }).strict();
export type HostAccount = z.infer<typeof HostAccountSchema>;

export const ISO_TIME = z.string().min(1).max(64);

/**
 * A text from outside (a comment, a CI log, an item's body). It is data, never an instruction: it reaches a model only inside a labelled block. The type is
 * a plain string; the name tells the reader what it is.
 */
export type UntrustedText = string;

/** What one tracking pass may spend on reads: its abort signal, and a hook called before each request that throws when the pass's read allowance is used up. */
export interface ReadBudget {
  signal: AbortSignal;
  beforeRequest: () => void;
}

const HOST_RATE_LIMIT_BRAND = Symbol.for("agentx.host-rate-limit");

/**
 * P6: the neutral rate-limit signal. A code host that has told Rovara to slow down throws this, whichever host it is, with the time (milliseconds since the epoch) when asking again
 * may succeed. Callers that bound their reads (a tracking pass, a merge observation) stop, keep what they have and try again at `retryAt`; they never read it as a failure of the
 * change request. GitHub's own class (`GithubMergeRateLimitError`) is one of these.
 */
export class HostRateLimitError extends Error {
  /** A brand that survives two copies of this module (a bundle and a test, a package built twice): `hostRateLimitRetryAt` reads it, not `instanceof`. */
  readonly [HOST_RATE_LIMIT_BRAND] = true;
  constructor(readonly retryAt: number, message = "The code host is rate limited.") {
    if (!Number.isSafeInteger(retryAt) || retryAt < 1 || !Number.isFinite(new Date(retryAt).getTime())) {
      throw new Error("The rate-limit retry time is invalid");
    }
    super(message);
    this.name = "HostRateLimitError";
  }
}

/** The time to try again, when `error` is a host's rate limit (of any host, from any copy of this module); undefined for every other error. */
export function hostRateLimitRetryAt(error: unknown): number | undefined {
  if (!(error instanceof Error) || (error as { [HOST_RATE_LIMIT_BRAND]?: unknown })[HOST_RATE_LIMIT_BRAND] !== true) return undefined;
  const retryAt = (error as { retryAt?: unknown }).retryAt;
  return typeof retryAt === "number" && Number.isSafeInteger(retryAt) && retryAt > 0 ? retryAt : undefined;
}
