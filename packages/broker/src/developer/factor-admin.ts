// ID-STEPUP-FOLLOWUPS (a) and (b): the factor email and passkeys, managed through DeveloperIdentity (the broker may not write the sign-in table).
//
//   - list-passkeys: the caller's own passkeys. A live session is enough.
//   - list-sign-in-factors: the caller's own passkeys AND their confirmation email, masked here (the broker never holds the full address). A live session is enough. Nothing names a second person.
//   - remove-passkey: removes one of the caller's own passkeys. Needs a FRESH STEP-UP.
//   - remove-person-passkeys: a company admin removes all of another person's passkeys. Needs the admin's own fresh step-up; the person is told at their factor email. A notice that cannot
//     be sent does not stop the removal (removing only takes access away), and the answer says it was not sent.
//   - set-factor-email: a company admin sets where a person's step-up codes go. Needs the admin's own fresh step-up. The old address, when there is one, is told BEFORE the change, and the
//     change is refused when it cannot be told (a change of factor email can hand someone's step-up to another inbox, so the person must hear of it first).
//
// Rules:
//   - The caller is named by the developer id and session id of their verified access token. Their session is read HERE, from this table: it must exist, be theirs, not be revoked, ended
//     (by its end time or an admin's end of their sign-ins), and their record must not be turned off. The step-up time and method are the SESSION's own (`stepUpAt`, `stepUpMethod`, set
//     only by a completed step-up and never renewed by a refresh), never anything a request carries. Fresh means: one of Code's factors, no older than the window, and not in the future
//     beyond a small clock-skew allowance that is never longer than the window.
//   - Who is a company admin over a person is the install's rule (`companyAdmin`), asked only after the step-up was found fresh. Absent: these admin requests are refused (`not_set_up`),
//     never let through on a guess. Its answer counts only when it is exactly `true`; a throw is `unavailable`.
//   - Ending a person's sessions does not remove their passkeys (they are the person's own factor); an admin's removal does.
//   - Answers and logs carry fixed words, ids and counts only: never an email address in full, a credential's key, or a caught error's message.
import {
  DEVELOPER_STEP_UP_METHODS, DEVELOPER_STEP_UP_WINDOW_SECONDS, ListPasskeysRequestSchema, ListSignInFactorsRequestSchema, MaskedFactorEmailSchema, RemovePasskeyRequestSchema, RemovePersonPasskeysRequestSchema, SetFactorEmailRequestSchema,
  type DeveloperFactorRefusal, type ListPasskeysResponse, type ListSignInFactorsResponse, type RemovePasskeyResponse, type RemovePersonPasskeysResponse, type SetFactorEmailResponse,
} from "@agentx/contracts";
import { maskedEmail, type StepUpEmailSender } from "./step-up.js";
import { endedByAdmin, type DeveloperRecord, type DeveloperSignInStore, type SessionRecord } from "./store.js";

/** The install's rule for who administers whom: true only when `adminDeveloperId` is a company admin over `personDeveloperId` now. */
export type CompanyAdminRule = (adminDeveloperId: string, personDeveloperId: string) => Promise<boolean>;

export interface FactorAdminOptions {
  env: string;
  store: DeveloperSignInStore;
  email: StepUpEmailSender | undefined;
  companyAdmin: CompanyAdminRule | undefined;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Whether the session's sign-in method is still on (and was on when it started), as a refresh checks. Absent: not checked. */
  methodLive?: (session: SessionRecord) => boolean;
}

/** A step-up time this far ahead of the clock is still believed (never more than the window). */
const STEP_UP_SKEW_SECONDS = 60;
const SEND_DEADLINE_MS = 10_000;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const FACTOR_ADMIN_TEXT = {
  invalid: "That request is not one AgentX understands.",
  signedOut: "Your AgentX sign-in has ended. Sign in again.",
  reauth: "Confirm it's you first: this needs a confirmation from the last few minutes. Confirm it's you, then try again.",
  forbidden: "Only a company admin can do that for this person.",
  notSetUp: "This is not set up on this install yet. Ask whoever runs AgentX.",
  noSender: "AgentX cannot send email on this install, so the person's current confirmation email cannot be told about the change. Nothing was changed.",
  noticeFailed: "AgentX could not tell the person's current confirmation email about the change, so nothing was changed. Try again in a moment.",
  conflict: "The person's confirmation email changed while you were changing it. Check it and try again.",
  notFound: "Not found.",
  personNotFound: "That person has never signed in to AgentX.",
  unavailable: "AgentX could not finish this just now. Try again in a moment.",
  changedSubject: "The email for your AgentX confirmation codes was changed",
  removedSubject: "Your AgentX passkeys were removed",
} as const;

const refusal = (error: DeveloperFactorRefusal["error"], message: string): DeveloperFactorRefusal => ({ ok: false, error, message });

async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("send deadline passed"), { name: "SendDeadline" })), ms); });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createFactorAdmin(options: FactorAdminOptions) {
  const seconds = () => Math.floor(options.now() / 1000);

  /** The caller's live session, read from this table; a refusal when it is not live or not theirs. */
  async function liveSession(developerId: string, sessionId: string): Promise<{ session: SessionRecord; developer: DeveloperRecord } | DeveloperFactorRefusal> {
    const session = await options.store.getSession(sessionId);
    if (session === undefined || session.developerId !== developerId || session.revokedAt !== undefined || !(session.endsAt > seconds())) return refusal("signed_out", FACTOR_ADMIN_TEXT.signedOut);
    const developer = await options.store.getDeveloper(developerId);
    if (developer === undefined || developer.revoked || endedByAdmin(session.startedAt, developer.sessionsEndedAt)) return refusal("signed_out", FACTOR_ADMIN_TEXT.signedOut);
    if (options.methodLive !== undefined && !options.methodLive(session)) return refusal("signed_out", FACTOR_ADMIN_TEXT.signedOut);
    return { session, developer };
  }

  /** Whether the session's own step-up is fresh now: one of Code's factors, no older than the window, and not in the future beyond the skew. */
  function fresh(session: SessionRecord): boolean {
    const at = session.stepUpAt;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return false;
    if (!(DEVELOPER_STEP_UP_METHODS as readonly unknown[]).includes(session.stepUpMethod)) return false;
    const age = seconds() - at;
    return age <= DEVELOPER_STEP_UP_WINDOW_SECONDS && -age <= Math.min(STEP_UP_SKEW_SECONDS, DEVELOPER_STEP_UP_WINDOW_SECONDS);
  }

  /** A live session with a fresh step-up, or the refusal. */
  async function freshCaller(developerId: string, sessionId: string): Promise<{ session: SessionRecord; developer: DeveloperRecord } | DeveloperFactorRefusal> {
    const live = await liveSession(developerId, sessionId);
    if ("ok" in live) return live;
    if (!fresh(live.session)) {
      options.log({ event: "signin.factor_change_refused", developerId, reason: "stale_step_up" });
      return refusal("reauth", FACTOR_ADMIN_TEXT.reauth);
    }
    return live;
  }

  /** The install's admin rule over this person: undefined when it says yes; otherwise the refusal. Asked only once the step-up was found fresh. */
  async function adminOver(adminDeveloperId: string, personDeveloperId: string): Promise<DeveloperFactorRefusal | undefined> {
    if (options.companyAdmin === undefined) return refusal("not_set_up", FACTOR_ADMIN_TEXT.notSetUp);
    let answer: unknown;
    try {
      answer = await options.companyAdmin(adminDeveloperId, personDeveloperId);
    } catch (error) {
      options.log({ event: "signin.company_admin_rule_failed", developerId: adminDeveloperId, error: errorName(error) });
      return refusal("unavailable", FACTOR_ADMIN_TEXT.unavailable);
    }
    if (answer !== true) {
      options.log({ event: "signin.factor_change_refused", developerId: adminDeveloperId, personDeveloperId, reason: "not_admin" });
      return refusal("forbidden", FACTOR_ADMIN_TEXT.forbidden);
    }
    return undefined;
  }

  /** A store or sender failure answers `unavailable` with fixed words; only the error's name is logged. */
  async function guarded<T>(operation: string, work: () => Promise<T>): Promise<T | DeveloperFactorRefusal> {
    try {
      return await work();
    } catch (error) {
      options.log({ event: "signin.factor_operation_failed", operation, error: errorName(error) });
      return refusal("unavailable", FACTOR_ADMIN_TEXT.unavailable);
    }
  }

  const operations = {
    async listPasskeys(event: unknown): Promise<ListPasskeysResponse> {
      const parsed = ListPasskeysRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", FACTOR_ADMIN_TEXT.invalid);
      const live = await liveSession(parsed.data.developerId, parsed.data.sessionId);
      if ("ok" in live) return live;
      const keys = await options.store.listPasskeys(parsed.data.developerId);
      return { ok: true, passkeys: keys.map((key) => ({ credentialId: key.credentialId, createdAt: key.createdAt, ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }) })) };
    },

    async listSignInFactors(event: unknown): Promise<ListSignInFactorsResponse> {
      const parsed = ListSignInFactorsRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", FACTOR_ADMIN_TEXT.invalid);
      const live = await liveSession(parsed.data.developerId, parsed.data.sessionId);
      if ("ok" in live) return live;
      const keys = await options.store.listPasskeys(parsed.data.developerId);
      // The caller's OWN record (read for their live session), masked here; an address that cannot be masked into the fixed shape is left out, never sent as it is.
      const stored = live.developer.factorEmail;
      const masked = stored === undefined ? undefined : MaskedFactorEmailSchema.safeParse(maskedEmail(stored));
      if (stored !== undefined && masked?.success !== true) options.log({ event: "signin.factor_email_unmaskable", developerId: parsed.data.developerId });
      return {
        ok: true, ...(masked?.success === true ? { factorEmail: masked.data } : {}),
        passkeys: keys.map((key) => ({ credentialId: key.credentialId, createdAt: key.createdAt, ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }) })),
      };
    },

    async removePasskey(event: unknown): Promise<RemovePasskeyResponse> {
      const parsed = RemovePasskeyRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", FACTOR_ADMIN_TEXT.invalid);
      const caller = await freshCaller(parsed.data.developerId, parsed.data.sessionId);
      if ("ok" in caller) return caller;
      if (!await options.store.removePasskey(parsed.data.developerId, parsed.data.credentialId)) return refusal("not_found", FACTOR_ADMIN_TEXT.notFound);
      options.log({ event: "signin.passkey_removed", developerId: parsed.data.developerId, by: "self" });
      return { ok: true };
    },

    async removePersonPasskeys(event: unknown): Promise<RemovePersonPasskeysResponse> {
      const parsed = RemovePersonPasskeysRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", FACTOR_ADMIN_TEXT.invalid);
      const { developerId, sessionId, personDeveloperId } = parsed.data;
      const caller = await freshCaller(developerId, sessionId);
      if ("ok" in caller) return caller;
      const denied = await adminOver(developerId, personDeveloperId);
      if (denied !== undefined) return denied;
      const person = await options.store.getDeveloper(personDeveloperId);
      if (person === undefined) return refusal("not_found", FACTOR_ADMIN_TEXT.personNotFound);
      let removed: number;
      try {
        removed = await options.store.removeAllPasskeys(personDeveloperId);
      } catch (error) {
        options.log({ event: "signin.passkeys_remove_failed", developerId, personDeveloperId, error: errorName(error) });
        return refusal("unavailable", FACTOR_ADMIN_TEXT.unavailable);
      }
      options.log({ event: "signin.passkeys_removed_by_admin", developerId, personDeveloperId, removed });
      let notified = false;
      if (removed > 0 && options.email !== undefined && person.factorEmail !== undefined) {
        try {
          await withDeadline(options.email.send({
            to: person.factorEmail, subject: FACTOR_ADMIN_TEXT.removedSubject,
            text: `A company admin removed your AgentX passkeys (${String(removed)}) at ${new Date(options.now()).toISOString()} (environment ${options.env}). You can add a new one the next time you confirm it's you.\n\n`
              + "If you did not expect this, tell an AgentX admin.",
          }), SEND_DEADLINE_MS);
          notified = true;
        } catch (error) {
          options.log({ event: "signin.passkeys_removed_notice_failed", personDeveloperId, error: errorName(error) });
        }
      }
      return { ok: true, removed, notified };
    },

    async setFactorEmail(event: unknown): Promise<SetFactorEmailResponse> {
      const parsed = SetFactorEmailRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", FACTOR_ADMIN_TEXT.invalid);
      const { developerId, sessionId, personDeveloperId } = parsed.data;
      const email = parsed.data.email.trim();
      const caller = await freshCaller(developerId, sessionId);
      if ("ok" in caller) return caller;
      const denied = await adminOver(developerId, personDeveloperId);
      if (denied !== undefined) return denied;
      const person = await options.store.getDeveloper(personDeveloperId);
      if (person === undefined) return refusal("not_found", FACTOR_ADMIN_TEXT.personNotFound);
      const old = person.factorEmail;
      if (old !== undefined && sameEmail(old, email)) return { ok: true, changed: false };
      if (old !== undefined) {
        // Told first: a change the person never hears of is the attack this guards against.
        if (options.email === undefined) return refusal("not_set_up", FACTOR_ADMIN_TEXT.noSender);
        try {
          await withDeadline(options.email.send({
            to: old, subject: FACTOR_ADMIN_TEXT.changedSubject,
            text: `A company admin is changing the email your AgentX confirmation codes go to, from this address to ${maskedEmail(email)}, at ${new Date(options.now()).toISOString()} (environment ${options.env}).\n\n`
              + "If you did not expect this, tell an AgentX admin now: whoever reads that inbox can confirm it's you.",
          }), SEND_DEADLINE_MS);
        } catch (error) {
          options.log({ event: "signin.factor_email_notice_failed", developerId, personDeveloperId, error: errorName(error) });
          return refusal("notice_failed", FACTOR_ADMIN_TEXT.noticeFailed);
        }
      }
      if (!await options.store.setFactorEmail(personDeveloperId, email, old, developerId)) return refusal("conflict", FACTOR_ADMIN_TEXT.conflict);
      options.log({ event: "signin.factor_email_set_by_admin", developerId, personDeveloperId, replaced: old !== undefined });
      return { ok: true, changed: true };
    },
  };
  return {
    listPasskeys: (event: unknown): Promise<ListPasskeysResponse> => guarded("list-passkeys", () => operations.listPasskeys(event)),
    listSignInFactors: (event: unknown): Promise<ListSignInFactorsResponse> => guarded("list-sign-in-factors", () => operations.listSignInFactors(event)),
    removePasskey: (event: unknown): Promise<RemovePasskeyResponse> => guarded("remove-passkey", () => operations.removePasskey(event)),
    removePersonPasskeys: (event: unknown): Promise<RemovePersonPasskeysResponse> => guarded("remove-person-passkeys", () => operations.removePersonPasskeys(event)),
    setFactorEmail: (event: unknown): Promise<SetFactorEmailResponse> => guarded("set-factor-email", () => operations.setFactorEmail(event)),
  };
}
