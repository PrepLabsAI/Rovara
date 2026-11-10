// Lane P3, item I2 (owner decision 62): ONE neutral shape for an account at an outside system, used by every new shape: `{ provider, tenant, accountId }` (the adapter's id for the system, the workspace or
// organisation it lives in, and the system's own id for the account). `ActorRef` (a chat user: channel, tenant, userId) and `HostAccount` (a code host login) stay for the wire shapes that already carry them; the
// functions below convert, so new code never grows a per-provider field. The old per-provider id fields (`slackUserId`) are read as a legacy alias and are not written by new code.
//
// Also here: the sign-in method id is open (an adapter registers its own), where `DeveloperSignInMethodSchema` is the closed list of the built-in methods the hosted sign-in server knows.
import { z } from "zod";
import { ChannelIdSchema, ChannelOpaqueIdSchema, type ActorRef } from "./conversation.js";
import type { HostAccount } from "./plugins/common.js";
import type { ExternalAccountRef } from "./ports/policy.js";

/** An adapter's id for an outside system, such as a chat tool, a code host or a sign-in provider: lower case, digits and hyphens. */
export const OutsideProviderIdSchema = ChannelIdSchema;

/** `tenant` is empty text when the system has no workspace or organisation. */
export const ExternalAccountRefSchema = z.object({
  provider: OutsideProviderIdSchema,
  tenant: z.union([z.literal(""), ChannelOpaqueIdSchema]),
  accountId: ChannelOpaqueIdSchema,
}).strict();

// The schema and the port's interface are one shape: this fails to compile when they differ.
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const EXTERNAL_ACCOUNT_SHAPES_MATCH: SameShape<z.infer<typeof ExternalAccountRefSchema>, ExternalAccountRef> = true;

/** A sign-in method's id. Open: an identity adapter names its own. The built-in list is `BUILT_IN_SIGN_IN_METHODS`. */
export const SignInMethodIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export type SignInMethodId = z.infer<typeof SignInMethodIdSchema>;

/** The methods the hosted sign-in server has built in (`DeveloperSignInMethodSchema`). Not a limit: any id that passes `SignInMethodIdSchema` is a method. */
export const BUILT_IN_SIGN_IN_METHODS = ["slack", "oidc", "cloud", "github", "saml"] as const;

export function externalAccountOfActor(actor: ActorRef): ExternalAccountRef {
  return { provider: actor.channel, tenant: actor.tenant, accountId: actor.userId };
}

export function actorOfExternalAccount(account: ExternalAccountRef): ActorRef {
  return { channel: account.provider, tenant: account.tenant, userId: account.accountId };
}

/** A code host login as an outside account, or undefined when the host gave no stable id (a login can be renamed, so it is not an account id). */
export function externalAccountOfHostAccount(provider: string, tenant: string, account: HostAccount): ExternalAccountRef | undefined {
  return account.hostUserId === undefined ? undefined : { provider, tenant, accountId: account.hostUserId };
}

export function sameExternalAccount(a: ExternalAccountRef, b: ExternalAccountRef): boolean {
  return a.provider === b.provider && a.tenant === b.tenant && a.accountId === b.accountId;
}

/** One text for an account, for a key or a map. The parts cannot contain a NUL, so two different accounts never share one. */
export function externalAccountKey(account: ExternalAccountRef): string {
  return [account.provider, account.tenant, account.accountId].join("\u0000");
}

/** The provider the old `slackUserId` fields meant. */
export const LEGACY_USER_ID_PROVIDER = "slack";

/**
 * The account a shape names. The neutral `account` field wins; a shape that has only the legacy `slackUserId` is read as an account of the `slack` provider (in the workspace `legacyTenant` names, else none).
 * When both are present they must agree, else the answer is undefined: a caller never has to guess which of two different accounts was meant.
 */
export function readExternalAccount(fields: { account?: ExternalAccountRef | undefined; slackUserId?: string | undefined }, legacyTenant = ""): ExternalAccountRef | undefined {
  const legacy: ExternalAccountRef | undefined = fields.slackUserId === undefined ? undefined : { provider: LEGACY_USER_ID_PROVIDER, tenant: legacyTenant, accountId: fields.slackUserId };
  if (fields.account === undefined) return legacy;
  if (legacy === undefined) return fields.account;
  return fields.account.provider === legacy.provider && fields.account.accountId === legacy.accountId && (legacyTenant === "" || fields.account.tenant === legacyTenant) ? fields.account : undefined;
}
