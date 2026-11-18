// Web task channel C8 (D7), rebuilt as option b (DEC 254zm(3)): the hosted core's attention email. A person with no chat who is waiting on a task is told by email, in the words of
// `core/notify/email-text.ts` (the task's title, its status sentence and links on the web app; nothing else). The broker decides who is told and what the email says; a SMALL separate function sends it
// (`attention-email-sender.ts`), as its own SES identity, with its own narrow role. The broker's own role and environment do not grow: it invokes that function by the function's own policy, and the
// function's name is derived from the environment's name.
//
// OFF BY DEFAULT. The switch `ROVARA_ATTENTION_EMAIL` (stack parameter `CoreAttentionEmail`, packed) is read once, when the core root is built. Anything but `on` builds nothing here: no Lambda client,
// no `email` adapter (Code's default, which sends nothing, stays), no address read, no index write, no unsubscribe route. With it on, an install that cannot send safely (no sign-in table, no sender
// function name, no signing key) stays off too, and says so in one fixed log line. It never sends without the unsubscribe link (the sender function refuses one).
//
// What the switch turns on, and nothing more:
//   - an `email` adapter (`lambdaAttentionEmailSender`) that hands one message to the sender function: `refused` for what the port (or the function) refuses, `unavailable` (fixed words) otherwise;
//   - the reverse index (`core/notify/person-index.ts`): when attention rows are written for a task, which person the task's (hashed) owner id stands for, from the task's own record;
//   - the person's own address (`hostedAttentionAddress`): the index's person, only while a live member of THIS company, and only an address a sign-in source that verifies addresses gave
//     (the install's own Slack workspace, GitHub's verified primary email, the install's own OIDC issuer). A company's own sign-in provider can assert any address, so its emails are never used;
//   - per-person links (`attentionEmailLinks`): settings, the inbox, and a SIGNED link that stops these emails. Acting on it still takes the person's own sign-in (`inbox-routes.ts`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { ATTENTION_EMAIL_FUNCTION_VARIABLE, EmailError, emailRefusal, isPlainEmailAddress, type DocumentStore, type EmailSender, type OrgId } from "@agentx/contracts";
import { isOwnSlackWorkspaceSignIn } from "./slack-own-workspace.js";
import { plainHttpsLink, type AttentionEmailLinks } from "../core/notify/email-text.js";
import { attentionPersonOf, rememberAttentionOwner } from "../core/notify/person-index.js";
import { mintUnsubscribeToken, unsubscribeKeyOf } from "../core/notify/unsubscribe-token.js";
import type { SessionChange } from "../core/sessions/summary.js";
import { coreAdapter, type CoreAdapterModule } from "../core-host/registry.js";
import { HOSTED_IDENTITY_PROVIDER } from "../core-host/hosted-modules.js";
import { GITHUB_ISSUER } from "../developer/providers.js";
import { ATTENTION_EMAIL_LINK_PLACEHOLDER } from "./attention-email-sender.js";

export const ATTENTION_EMAIL_VARIABLE = "ROVARA_ATTENTION_EMAIL";
/** The install's own OIDC issuer (the broker already has it): emails from it are verified by the install's own provider. */
const OWN_OIDC_ISSUER_VARIABLE = "DEVELOPER_OIDC_ISSUER";
export const ATTENTION_EMAIL_UNAVAILABLE = "the attention email could not be sent now";
export const ATTENTION_EMAIL_REFUSED = "the attention email was refused";
/** The invoke went out but its outcome is not known: the email may have gone, so it is never sent again (at most once). Not retryable. */
export const ATTENTION_EMAIL_UNKNOWN = "the attention email may have been sent and is not sent again";
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** `on` turns it on; unset, empty or `off` is off; anything else is off and reported (the caller logs a fixed line). */
export function attentionEmailSwitch(env: NodeJS.ProcessEnv): "on" | "off" | "invalid" {
  const value = env[ATTENTION_EMAIL_VARIABLE];
  if (value === undefined || value === "" || value === "off") return "off";
  return value === "on" ? "on" : "invalid";
}

type Dynamo = { send(command: unknown): Promise<unknown> };

// ---- the sender: one invoke of the sender function

/** The adapter that hands one message to the sender function. Every failure is a fixed `EmailError`; nothing of the message is ever quoted or logged. */
export function lambdaAttentionEmailSender(options: { lambda: Pick<LambdaClient, "send">; functionName: string; now?: () => number }): EmailSender {
  if (!FUNCTION_NAME.test(options.functionName)) throw new Error("the attention email sender function is not named");
  const now = options.now ?? Date.now;
  return {
    capabilities: { available: true, html: false, unsubscribeHeader: false },
    async send(message) {
      if (emailRefusal(message) !== undefined) throw new EmailError("refused", ATTENTION_EMAIL_REFUSED);
      const wait = message.deadline === undefined ? 10_000 : message.deadline - now();
      if (wait <= 0) throw new EmailError("unavailable", ATTENTION_EMAIL_UNAVAILABLE);
      // At most once: once the invoke may have reached the function, an outcome that is not a definite "not sent" is never retried (the queue then keeps its claim).
      const unknown = () => new EmailError("refused", ATTENTION_EMAIL_UNKNOWN);
      let answer: unknown;
      try {
        const response = await options.lambda.send(new InvokeCommand({
          FunctionName: options.functionName, InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify({ v: 1, to: message.to, subject: message.subject, text: message.text })),
        }), { abortSignal: AbortSignal.timeout(Math.min(wait, 10_000)) });
        if (response.FunctionError !== undefined || response.Payload === undefined) throw unknown();
        answer = JSON.parse(new TextDecoder().decode(response.Payload)) as unknown;
      } catch (error) {
        if (error instanceof EmailError) throw error;
        // The SDK's error can quote the request: only its status is kept. Lambda refused the invoke itself (throttled, no such function): the function never ran, so it is tried again later.
        // Anything else (an abort at the deadline, a lost connection, an unreadable answer) may have sent it.
        const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
        if (status === 429 || status === 404) throw new EmailError("unavailable", ATTENTION_EMAIL_UNAVAILABLE);
        throw unknown();
      }
      // The function's answer (attention-email-sender.ts): `{ ok: true }` is a send, `{ refused: true }` a refusal, `{ unavailable: true }` a definite "SES did not take it" (tried again);
      // anything else may have gone, and is not sent again.
      const fields = typeof answer === "object" && answer !== null ? answer as Record<string, unknown> : {};
      if (fields["ok"] === true) return;
      if (fields["refused"] === true) throw new EmailError("refused", ATTENTION_EMAIL_REFUSED);
      if (fields["unavailable"] === true) throw new EmailError("unavailable", ATTENTION_EMAIL_UNAVAILABLE);
      throw unknown();
    },
  };
}

// ---- the person's address

/** A sign-in record's address, only when the source that gave it verifies addresses for this install; anything else is none. */
export function verifiedSignInAddress(record: Record<string, unknown> | undefined, ownOidcIssuer: string | undefined): string | undefined {
  if (record === undefined || record["revoked"] === true) return undefined;
  const email = record["email"], provider = record["provider"], issuer = record["issuer"], subject = record["subject"];
  if (typeof email !== "string" || !isPlainEmailAddress(email) || typeof issuer !== "string") return undefined;
  const trim = (value: string) => value.replace(/\/+$/u, "");
  // GitHub: the account's one verified primary email (developer/providers.ts).
  if (provider === "github" && issuer === GITHUB_ISSUER) return email;
  // Slack: the install's own workspace only (another workspace's sign-in stores no email, and names its subject `<team>:<user>`).
  if (provider === "slack" && isOwnSlackWorkspaceSignIn(issuer, subject)) return email;
  // OIDC: the install's own issuer only. A company's own issuer (company-issuer.ts) can assert any address for its members.
  if (provider === "oidc" && ownOidcIssuer !== undefined && trim(ownOidcIssuer) !== "" && trim(issuer) === trim(ownOidcIssuer)) return email;
  return undefined;
}

/**
 * The person's own address for a hashed id in one company: the reverse index's person (`attentionPersonOf`), only while their live membership is in THIS company, then their sign-in record
 * (`DEVELOPER#<person>` / META, strongly consistent), only for an address a verifying source gave (`verifiedSignInAddress`). Anything missing or failing is none.
 */
export function hostedAttentionAddress(inputs: {
  store: Pick<DocumentStore, "get">; documentClient: Dynamo; signInTableName: string; ownOidcIssuer: string | undefined;
  membershipOf: (personId: string) => Promise<{ companyId: OrgId } | undefined>;
}): (orgId: OrgId, developerId: string) => Promise<string | undefined> {
  return async (orgId, developerId) => {
    const personId = await attentionPersonOf(inputs.store, HOSTED_IDENTITY_PROVIDER, orgId, developerId);
    if (personId === undefined) return undefined;
    const membership = await inputs.membershipOf(personId);
    if (membership === undefined || membership.companyId !== orgId) return undefined;
    const response = await inputs.documentClient.send(new GetCommand({
      TableName: inputs.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true,
      ProjectionExpression: "#e, #r, #p, #i, #s", ExpressionAttributeNames: { "#e": "email", "#r": "revoked", "#p": "provider", "#i": "issuer", "#s": "subject" },
    })) as { Item?: Record<string, unknown> };
    return verifiedSignInAddress(response?.Item, inputs.ownOidcIssuer);
  };
}

// ---- the signed unsubscribe link (core/notify/unsubscribe-token.ts)

/**
 * The links one person's email carries. `origin` must be a plain https origin or there are no links (the broker passes the placeholder origin, which the sender function replaces). The pages are the web app's:
 * settings, the inbox, and the page that takes the signed link to the person's own sign-in and stops these emails (`POST /v1/app/notify/unsubscribe`).
 */
export function attentionEmailLinks(options: { origin: string; key: Buffer; now: () => number }): (orgId: OrgId, developerId: string) => AttentionEmailLinks {
  const base = plainHttpsLink(options.origin);
  const root = base === undefined ? undefined : new URL(base).origin;
  return (orgId, developerId) => root === undefined ? {} : {
    settings: `${root}/app/settings/notifications`,
    home: `${root}/app/inbox`,
    unsubscribe: `${root}/app/notifications/unsubscribe?t=${encodeURIComponent(mintUnsubscribeToken(options.key, { orgId, developerId, nowMs: options.now() }))}`,
  };
}

// ---- composing it for the core root

export interface AttentionEmailParts {
  /** The `email` adapter to register (replaces Code's `none`). */
  sender: EmailSender;
  /** The person's own address (a notice's `address` seam), over one company's store. */
  addressFor: (store: Pick<DocumentStore, "get">) => (orgId: OrgId, developerId: string) => Promise<string | undefined>;
  /** The reverse index's write (a notice service's `remember`), over one company's store. */
  rememberFor: (store: Pick<DocumentStore, "get" | "put">) => (change: SessionChange) => Promise<void>;
  /** Per-person links (a notice's `emailLinks`). */
  links: (orgId: OrgId, developerId: string) => AttentionEmailLinks;
  /** The key that verifies a signed link (`POST /v1/app/notify/unsubscribe`). */
  unsubscribeKey: Buffer;
}

/**
 * Everything the switch turns on, or undefined (off). Off for: the switch not `on`, no sign-in table, no sender function name, or no signing key.
 * Reads nothing and builds no client when off.
 */
export function attentionEmailFromEnvironment(inputs: {
  env: NodeJS.ProcessEnv; lambda: () => Pick<LambdaClient, "send">; documentClient: Dynamo; signInTableName: string | undefined; callbackSigningKey: string | Buffer; now: () => number;
  membershipOf: (personId: string) => Promise<{ companyId: OrgId } | undefined>; log: (entry: Record<string, unknown>) => void;
}): AttentionEmailParts | undefined {
  const mode = attentionEmailSwitch(inputs.env);
  if (mode === "off") return undefined;
  const refuse = (reason: string): undefined => { inputs.log({ event: "core_engine.attention_email_off", reason }); return undefined; };
  if (mode === "invalid") return refuse("switch_unreadable");
  const signInTableName = inputs.signInTableName;
  if (signInTableName === undefined || signInTableName === "") return refuse("no_sign_in_table");
  const functionName = inputs.env[ATTENTION_EMAIL_FUNCTION_VARIABLE];
  if (functionName === undefined || !FUNCTION_NAME.test(functionName)) return refuse("no_sender_function");
  // An empty key would sign links anyone can forge (they still act only for the signed-in person they name, but there is no reason to allow it).
  if (inputs.callbackSigningKey.length === 0) return refuse("no_signing_key");
  const key = unsubscribeKeyOf(inputs.callbackSigningKey);
  const ownOidcIssuer = inputs.env[OWN_OIDC_ISSUER_VARIABLE];
  return {
    sender: lambdaAttentionEmailSender({ lambda: inputs.lambda(), functionName }),
    addressFor: (store) => hostedAttentionAddress({ store, documentClient: inputs.documentClient, signInTableName, ownOidcIssuer, membershipOf: inputs.membershipOf }),
    rememberFor: (store) => async (change) => { await rememberAttentionOwner({ store, provider: HOSTED_IDENTITY_PROVIDER, now: () => new Date(inputs.now()), log: inputs.log }, change); },
    // The links go on the placeholder origin; the sender function, which alone knows the web app's host, moves them there (attention-email-sender.ts).
    links: attentionEmailLinks({ origin: ATTENTION_EMAIL_LINK_PLACEHOLDER, key, now: inputs.now }), unsubscribeKey: key,
  };
}

/** The `email` module to register when the switch is on: it replaces Code's default (which sends nothing). Off builds no module, so the default stays. */
export const attentionEmailModule = (sender: EmailSender): CoreAdapterModule<"email"> => coreAdapter({ point: "email", name: "hosted-attention-email", owner: "web task channel C8", create: () => sender });
