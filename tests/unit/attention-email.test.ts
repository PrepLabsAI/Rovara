// Web task channel C8, option b (DEC 254zm(3)): the hosted core's attention email. OFF by default (no client, no adapter, no read, no index, no route). With the switch on, the broker finds the person
// through the reverse index (company-scoped, self-verifying), reads only an address a verifying sign-in source gave, and hands the core's own words to the small sender function, which checks them
// again and sends as its own identity. No real send and no AWS call: every client here is a fake.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { AgentXError, ATTENTION_EMAIL_FUNCTION_VARIABLE, EmailError, IMPLICIT_COMPANY_ID, SLACK_OIDC_ISSUER, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import { attentionEmail, readNotifyPrefs, writeNotifyPrefs, mintUnsubscribeToken, unsubscribeKeyOf, verifyUnsubscribeToken, UNSUBSCRIBE_LINK_DAYS } from "../../packages/broker/src/core/notify/index.js";
import { attentionPersonKey, attentionPersonOf, rememberAttentionOwner } from "../../packages/broker/src/core/notify/person-index.js";
import { createNoticeService } from "../../packages/broker/src/services/notices.js";
import { createInboxRoutes, UNSUBSCRIBE_BAD_LINK } from "../../packages/broker/src/core-host/inbox-routes.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { GITHUB_ISSUER } from "../../packages/broker/src/developer/providers.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import {
  ATTENTION_EMAIL_REFUSED, ATTENTION_EMAIL_UNAVAILABLE, ATTENTION_EMAIL_UNKNOWN, ATTENTION_EMAIL_VARIABLE, attentionEmailFromEnvironment, attentionEmailLinks, attentionEmailSwitch,
  hostedAttentionAddress, lambdaAttentionEmailSender, verifiedSignInAddress,
} from "../../packages/broker/src/aws/attention-email.js";
import { ATTENTION_EMAIL_LINK_PLACEHOLDER as PLACEHOLDER, attentionEmailSenderHandler, checkedAttentionEmailRequest } from "../../packages/broker/src/aws/attention-email-sender.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_attnemailother000001" as OrgId;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const DANA_ID = "d".repeat(64);
const KEY = unsubscribeKeyOf("callback-signing-key-for-tests");
const ORIGIN = "https://app.example.test";
const FUNCTION = "agentx-staging-attention-email";
const ENV_ON = { [ATTENTION_EMAIL_VARIABLE]: "on", [ATTENTION_EMAIL_FUNCTION_VARIABLE]: FUNCTION, DEVELOPER_OIDC_ISSUER: "https://idp.install.test/" };
// A hosted person: the session names them by the hash of the hosted provider and their sign-in id (H1).
const PERSON = "signin-person-1";
const PERSON_HASH = developerIdOf({ provider: HOSTED_IDENTITY_PROVIDER, personId: PERSON });

const message = (extra: Record<string, unknown> = {}) => ({ companyId: ORG, purpose: "attention", to: "dana@example.test", subject: "Rovara: 1 task needs your attention", text: "A task needs your attention in Rovara:\n\n- Add retry: Needs your review", ...extra });
/** A real email of the core's own words, with the person's links on the placeholder origin (as the broker writes them). */
const coreMail = (links = attentionEmailLinks({ origin: PLACEHOLDER, key: KEY, now: () => NOW })(ORG, DANA_ID), title = "Add retry") => attentionEmail([{ title, status: "Needs your review", kind: "needs_you" }], 0, "attention", links);
const request = (extra: Record<string, unknown> = {}) => { const mail = coreMail(); return { v: 1, to: "dana@example.test", subject: mail.subject, text: mail.text, ...extra }; };

function fakeLambda(answer: unknown = { ok: true }, options: { functionError?: string; fail?: Error } = {}) {
  const calls: Array<{ input: Record<string, unknown>; payload: unknown; options: unknown }> = [];
  return {
    calls, lambda: {
      async send(command: unknown, opts?: unknown) {
        if (options.fail !== undefined) throw options.fail;
        if (!(command instanceof InvokeCommand)) throw new Error("only invokes");
        const input = command.input as unknown as Record<string, unknown>;
        calls.push({ input, payload: JSON.parse(new TextDecoder().decode(input["Payload"] as Uint8Array)) as unknown, options: opts });
        return { StatusCode: 200, ...(options.functionError === undefined ? {} : { FunctionError: options.functionError }), Payload: new TextEncoder().encode(JSON.stringify(answer)) };
      },
    },
  };
}

describe("the switch", () => {
  it("reads on, off and everything else as off, and reports a value it cannot read", () => {
    expect(attentionEmailSwitch({})).toBe("off");
    expect(attentionEmailSwitch({ [ATTENTION_EMAIL_VARIABLE]: "" })).toBe("off");
    expect(attentionEmailSwitch({ [ATTENTION_EMAIL_VARIABLE]: "off" })).toBe("off");
    expect(attentionEmailSwitch({ [ATTENTION_EMAIL_VARIABLE]: "on" })).toBe("on");
    for (const value of ["ON", "true", "1", "on ", "yes", "enabled"]) expect(attentionEmailSwitch({ [ATTENTION_EMAIL_VARIABLE]: value }), value).toBe("invalid");
  });

  it("builds nothing when off or unusable: no client, no read, and a fixed reason when it was asked for", () => {
    const logs: Array<Record<string, unknown>> = [];
    const lambda = vi.fn(() => fakeLambda().lambda);
    const reads: unknown[] = [];
    const documentClient = { async send(command: unknown) { reads.push(command); return {}; } };
    const membershipOf = vi.fn(async () => ({ companyId: ORG }));
    const build = (env: NodeJS.ProcessEnv, key: string = "k") => attentionEmailFromEnvironment({ env, lambda, documentClient, signInTableName: "signin", callbackSigningKey: key, now: () => NOW, membershipOf, log: (entry) => logs.push(entry) });
    for (const env of [{}, { [ATTENTION_EMAIL_VARIABLE]: "off" }, { ...ENV_ON, [ATTENTION_EMAIL_VARIABLE]: "" }]) expect(build(env)).toBeUndefined();
    expect(logs).toEqual([]);
    const reasons: Array<[NodeJS.ProcessEnv, string]> = [
      [{ ...ENV_ON, [ATTENTION_EMAIL_VARIABLE]: "maybe" }, "switch_unreadable"],
      [{ ...ENV_ON, [ATTENTION_EMAIL_FUNCTION_VARIABLE]: undefined }, "no_sender_function"], [{ ...ENV_ON, [ATTENTION_EMAIL_FUNCTION_VARIABLE]: "arn:aws:lambda:x" }, "no_sender_function"],
    ];
    for (const [env, reason] of reasons) {
      logs.length = 0;
      expect(build(env), reason).toBeUndefined();
      expect(logs).toEqual([{ event: "core_engine.attention_email_off", reason }]);
    }
    logs.length = 0;
    expect(build(ENV_ON, "")).toBeUndefined();
    expect(logs).toEqual([{ event: "core_engine.attention_email_off", reason: "no_signing_key" }]);
    logs.length = 0;
    expect(attentionEmailFromEnvironment({ env: ENV_ON, lambda, documentClient, signInTableName: undefined, callbackSigningKey: "k", now: () => NOW, membershipOf, log: (entry) => logs.push(entry) })).toBeUndefined();
    expect(logs).toEqual([{ event: "core_engine.attention_email_off", reason: "no_sign_in_table" }]);
    expect(lambda).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(membershipOf).not.toHaveBeenCalled();
    const parts = build(ENV_ON);
    expect(parts?.sender.capabilities).toEqual({ available: true, html: false, unsubscribeHeader: false });
    expect(lambda).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([]);
  });

  it("is wired into the core root only behind the switch, with one attempt per invoke, and Code's own default stays when it is off", () => {
    const root = readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    expect(root).toContain("const attention = coreActive ? attentionEmailFromEnvironment({ env, lambda: () => new LambdaClient({ maxAttempts: 1 }),");
    expect(root).toContain("...(attention === undefined ? [] : [attentionEmailModule(attention.sender)])");
    // Batch 14: the same seams, now spread next to the upkeep and human-edit ones.
    expect(root).toContain("...(attention === undefined ? {} : { notification: { address: attention.addressFor(flow.deps.store), emailLinks: attention.links, remember: attention.rememberFor(flow.deps.store) } })");
    expect(root).toContain("...(attention === undefined ? {} : { unsubscribeKey: attention.unsubscribeKey })");
    expect(root).not.toContain("client-sesv2");
    const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
    // Batch 14: the email seams travel together with the upkeep notice's (#959) in one notification object.
    // L4-AK1H: the admin notice's delivery re-check (`adminNotice`) rides in the same object, always present (it fails closed to no one until the core root answers).
    expect(broker).toContain("notification: { ...(wiring.notification ?? {}), ...(wiring.upkeep === undefined ? {} : { upkeep: wiring.upkeep }), adminNotice: async (orgId, developerId) => (await builtCoreRoot?.adminNotice?.(orgId, developerId)) === true }");
    expect(broker).not.toContain("attention-email-sender");
    const sender = readFileSync("packages/broker/src/aws/attention-email-sender.ts", "utf8");
    expect(sender).toContain("new SESv2Client({ maxAttempts: 1 })");
  });
});

describe("the broker's adapter: one invoke of the sender function", () => {
  it("hands one message to the named function, synchronously, and treats only { ok: true } as sent", async () => {
    const f = fakeLambda();
    const sender = lambdaAttentionEmailSender({ lambda: f.lambda, functionName: FUNCTION, now: () => NOW });
    expect(sender.capabilities).toEqual({ available: true, html: false, unsubscribeHeader: false });
    await sender.send(message({ deadline: NOW + 2_500, unsubscribeUrl: `${ORIGIN}/app/notifications/unsubscribe?t=x` }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.input).toMatchObject({ FunctionName: FUNCTION, InvocationType: "RequestResponse" });
    expect(f.calls[0]!.payload).toEqual({ v: 1, to: "dana@example.test", subject: "Rovara: 1 task needs your attention", text: message().text });
    expect((f.calls[0]!.options as { abortSignal?: unknown }).abortSignal).toBeDefined();
  });

  it("refuses what the port refuses before any call, and passes the function's refusal on, in fixed words", async () => {
    const f = fakeLambda();
    const sender = lambdaAttentionEmailSender({ lambda: f.lambda, functionName: FUNCTION, now: () => NOW });
    for (const bad of [{ to: "Dana <dana@example.test>" }, { to: "a@b.c, e@f.g" }, { subject: "one\nBcc: x@y.z" }, { text: "" }, { purpose: "Not One Word" }]) {
      const failure = await sender.send(message(bad)).catch((error: unknown) => error) as EmailError;
      expect(failure, JSON.stringify(bad)).toBeInstanceOf(EmailError);
      expect([failure.code, failure.message]).toEqual(["refused", ATTENTION_EMAIL_REFUSED]);
    }
    expect(f.calls).toEqual([]);
    const refusing = await lambdaAttentionEmailSender({ lambda: fakeLambda({ refused: true }).lambda, functionName: FUNCTION, now: () => NOW }).send(message()).catch((error: unknown) => error) as EmailError;
    expect([refusing.code, refusing.message]).toEqual(["refused", ATTENTION_EMAIL_REFUSED]);
  });

  it("is 'unavailable' (tried again) only when the email surely did not go: Lambda refused the invoke, or SES answered no", async () => {
    const throttled = Object.assign(new Error("dana@example.test throttled"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } });
    for (const f of [fakeLambda(undefined, { fail: throttled }), fakeLambda({ unavailable: true })]) {
      const failure = await lambdaAttentionEmailSender({ lambda: f.lambda, functionName: FUNCTION, now: () => NOW }).send(message()).catch((error: unknown) => error) as EmailError;
      expect([failure.code, failure.message, failure.retryable]).toEqual(["unavailable", ATTENTION_EMAIL_UNAVAILABLE, true]);
      expect(JSON.stringify([failure.message, failure.stack ?? ""])).not.toContain("dana@example.test");
    }
    const late = fakeLambda();
    const failure = await lambdaAttentionEmailSender({ lambda: late.lambda, functionName: FUNCTION, now: () => NOW }).send(message({ deadline: NOW - 1 })).catch((error: unknown) => error) as EmailError;
    expect(failure.code).toBe("unavailable");
    expect(late.calls).toEqual([]);
  });

  it("never retries an email that may have gone (at most once): an aborted or lost invoke, a function error, or an answer that is not a definite one", async () => {
    const aborted = Object.assign(new Error("dana@example.test"), { name: "AbortError" });
    const cases = [fakeLambda(undefined, { fail: aborted }), fakeLambda(undefined, { fail: new Error("socket hang up") }), fakeLambda({ ok: true }, { functionError: "Unhandled" }), fakeLambda({ unknown: true }), fakeLambda({ ok: "yes" }), fakeLambda(null), fakeLambda("ok")];
    for (const f of cases) {
      const failure = await lambdaAttentionEmailSender({ lambda: f.lambda, functionName: FUNCTION, now: () => NOW }).send(message()).catch((error: unknown) => error) as EmailError;
      expect(failure).toBeInstanceOf(EmailError);
      expect([failure.code, failure.message, failure.retryable]).toEqual(["refused", ATTENTION_EMAIL_UNKNOWN, false]);
      expect(JSON.stringify([failure.message, failure.stack ?? ""])).not.toContain("dana@example.test");
    }
  });

  it("will not be built without a plain function name", () => {
    for (const bad of ["", "arn:aws:lambda:us-west-2:1:function:x", "a b", "x".repeat(65)]) expect(() => lambdaAttentionEmailSender({ lambda: fakeLambda().lambda, functionName: bad }), bad).toThrow("not named");
  });
});

describe("the sender function", () => {
  const ses = (failWith?: Error) => {
    const sent: Array<{ input: Record<string, unknown>; options: unknown }> = [];
    return { sent, ses: { async send(command: unknown, options?: unknown) { if (failWith !== undefined) throw failWith; if (!(command instanceof SendEmailCommand)) throw new Error("only sends"); sent.push({ input: command.input as unknown as Record<string, unknown>, options }); return {}; } } };
  };
  const ENV = { ATTENTION_EMAIL_FROM: "notices@example.test", ATTENTION_EMAIL_LINK_ORIGIN: ORIGIN };

  it("sends the core's own words, as its own identity, to one address, plain text only", async () => {
    const f = ses();
    const logs: Array<Record<string, unknown>> = [];
    const answer = await attentionEmailSenderHandler({ ses: f.ses, env: ENV, log: (entry) => logs.push(entry) })(request());
    expect(answer).toEqual({ ok: true });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.input).toEqual({
      FromEmailAddress: "notices@example.test", Destination: { ToAddresses: ["dana@example.test"] },
      Content: { Simple: { Subject: { Data: request().subject, Charset: "UTF-8" }, Body: { Text: { Data: request().text.split(`${PLACEHOLDER}/`).join(`${ORIGIN}/`), Charset: "UTF-8" } } } },
    });
    // The links the broker wrote on the placeholder are on the web app's own origin now, and the placeholder is gone.
    const sentText = (f.sent[0]!.input["Content"] as { Simple: { Body: { Text: { Data: string } } } }).Simple.Body.Text.Data;
    expect(sentText).toContain(`Stop these emails: ${ORIGIN}/app/notifications/unsubscribe?t=`);
    expect(sentText).not.toContain(".invalid");
    expect(logs).toEqual([{ event: "attention_email.sent" }]);
    // Every one of the core's subjects and first lines is accepted.
    for (const kind of ["attention", "done", "digest"] as const) for (const count of [1, 3]) {
      const lines = Array.from({ length: count }, (_, index) => ({ title: `Task ${String(index)}`, status: "Done", kind: "done" }));
      const mail = attentionEmail(lines, 0, kind, attentionEmailLinks({ origin: PLACEHOLDER, key: KEY, now: () => NOW })(ORG, DANA_ID));
      expect(checkedAttentionEmailRequest({ v: 1, to: "dana@example.test", subject: mail.subject, text: mail.text }, ORIGIN), `${kind} ${String(count)}`).toBeDefined();
    }
  });

  it("refuses, before any SES call and in fixed words, anything that is not exactly the core's email to one plain address with the way out on the web app's own origin", async () => {
    const f = ses();
    const logs: Array<Record<string, unknown>> = [];
    const handler = attentionEmailSenderHandler({ ses: f.ses, env: ENV, log: (entry) => logs.push(entry) });
    const noStop = coreMail({ settings: `${PLACEHOLDER}/app/settings/notifications` });
    const onRealOrigin = coreMail(attentionEmailLinks({ origin: ORIGIN, key: KEY, now: () => NOW })(ORG, DANA_ID));
    const otherOrigin = coreMail(attentionEmailLinks({ origin: "https://evil.example.test", key: KEY, now: () => NOW })(ORG, DANA_ID));
    const bad: unknown[] = [
      undefined, null, "x", [], {}, request({ v: 2 }), request({ extra: 1 }), { ...request(), v: undefined },
      request({ to: "Dana <dana@example.test>" }), request({ to: "a@b.c, e@f.g" }), request({ to: "dana@example.test\r\nBcc: x@y.z" }), request({ to: 5 }),
      request({ subject: "Your account is locked" }), request({ subject: "Rovara: 1 task needs your attention\r\nBcc: x@y.z" }), request({ subject: "Rovara: 0 tasks finished" }),
      request({ text: "" }), request({ text: `Click here\n${request().text}` }), request({ text: `${request().text}\u0007` }), request({ text: `${request().text}\n${"x".repeat(70_000)}` }),
      request({ text: noStop.text }), request({ text: otherOrigin.text }),
      // A link of anywhere else, even in the owner's own title, is not sent.
      request({ text: coreMail(undefined, "see https://phish.example.test/login").text }), request({ text: coreMail(undefined, "see http://app.example.test.evil.test/x").text }),
      request({ text: coreMail(undefined, `see ${PLACEHOLDER}.evil.test/x`).text }), request({ text: coreMail(undefined, "see _https://evil.example.test/x").text }),
      request({ text: coreMail(undefined, "see xhttps://evil.example.test/x").text }), request({ text: coreMail(undefined, "see www.evil.example.test").text }),
      // Links the broker did not write on the placeholder (even on the web app's own origin) are not ones it sends.
      request({ text: onRealOrigin.text }), request({ text: coreMail(undefined, `see ${ORIGIN}/app/inbox`).text }),
    ];
    for (const value of bad) expect(await handler(value), JSON.stringify(value)?.slice(0, 60)).toEqual({ refused: true });
    expect(f.sent).toEqual([]);
    expect(new Set(logs.map((entry) => JSON.stringify(entry)))).toEqual(new Set([JSON.stringify({ event: "attention_email.refused" })]));
    // A placeholder link in a title is fine: it becomes the web app's own.
    expect(await handler(request({ text: coreMail(undefined, `see ${PLACEHOLDER}/app/inbox`).text }))).toEqual({ ok: true });
  });

  it("sends nothing without its own sender and origin, and is 'unavailable' in fixed words when SES fails, never quoting the request", async () => {
    expect(await attentionEmailSenderHandler({ ses: ses().ses, env: { ...ENV, ATTENTION_EMAIL_LINK_ORIGIN: "https://APP.example.test:443" }, log: () => undefined })(request())).toEqual({ ok: true });
    for (const env of [{}, { ...ENV, ATTENTION_EMAIL_FROM: "" }, { ...ENV, ATTENTION_EMAIL_FROM: "Rovara <a@b.test>" }, { ...ENV, ATTENTION_EMAIL_LINK_ORIGIN: "http://app.example.test" }, { ...ENV, ATTENTION_EMAIL_LINK_ORIGIN: "https://" }, { ...ENV, ATTENTION_EMAIL_LINK_ORIGIN: `${ORIGIN}/path` }]) {
      const f = ses();
      expect(await attentionEmailSenderHandler({ ses: f.ses, env, log: () => undefined })(request()), JSON.stringify(env)).toEqual({ refused: true });
      expect(f.sent).toEqual([]);
    }
    const logs: Array<Record<string, unknown>> = [];
    // SES answered no: not sent, tried again. No answer (timeout, lost connection): it may have gone, never again.
    const rejected = Object.assign(new Error("dana@example.test rejected"), { $metadata: { httpStatusCode: 400 } });
    expect(await attentionEmailSenderHandler({ ses: ses(rejected).ses, env: ENV, log: (entry) => logs.push(entry) })(request())).toEqual({ unavailable: true });
    expect(await attentionEmailSenderHandler({ ses: ses(Object.assign(new Error("dana@example.test"), { name: "TimeoutError" })).ses, env: ENV, log: (entry) => logs.push(entry) })(request())).toEqual({ unknown: true });
    expect(logs).toEqual([{ event: "attention_email.unavailable" }, { event: "attention_email.unknown" }]);
    expect(JSON.stringify(logs)).not.toContain("dana@example.test");
  });
});

describe("only an address a verifying sign-in source gave (M2)", () => {
  const OWN = "https://idp.install.test";
  it("takes GitHub's verified primary, the install's own Slack workspace and the install's own OIDC issuer", () => {
    expect(verifiedSignInAddress({ email: "a@b.test", provider: "github", issuer: GITHUB_ISSUER, subject: "12" }, OWN)).toBe("a@b.test");
    expect(verifiedSignInAddress({ email: "a@b.test", provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: "U0123ABCD" }, OWN)).toBe("a@b.test");
    expect(verifiedSignInAddress({ email: "a@b.test", provider: "oidc", issuer: `${OWN}/`, subject: "s" }, OWN)).toBe("a@b.test");
    expect(verifiedSignInAddress({ email: "a@b.test", provider: "oidc", issuer: OWN, subject: "s" }, `${OWN}/`)).toBe("a@b.test");
  });
  it("refuses a company's own issuer, another Slack workspace, other methods, a revoked record and anything not one plain address", () => {
    const refused: Array<[Record<string, unknown> | undefined, string | undefined]> = [
      [{ email: "a@b.test", provider: "oidc", issuer: "https://idp.company.test", subject: "s" }, OWN],
      [{ email: "a@b.test", provider: "oidc", issuer: OWN, subject: "s" }, undefined], [{ email: "a@b.test", provider: "oidc", issuer: OWN, subject: "s" }, ""],
      [{ email: "a@b.test", provider: "oidc", issuer: "", subject: "s" }, ""],
      [{ email: "a@b.test", provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: "T0123:U0123ABCD" }, OWN],
      [{ email: "a@b.test", provider: "github", issuer: "https://github.evil.test", subject: "12" }, OWN],
      [{ email: "a@b.test", provider: "saml", issuer: OWN, subject: "s" }, OWN], [{ email: "a@b.test", provider: "cloud", issuer: OWN, subject: "s" }, OWN],
      [{ email: "a@b.test", provider: "github", issuer: GITHUB_ISSUER, subject: "12", revoked: true }, OWN],
      [{ email: "Dana <a@b.test>", provider: "github", issuer: GITHUB_ISSUER }, OWN], [{ provider: "github", issuer: GITHUB_ISSUER }, OWN], [undefined, OWN],
    ];
    for (const [record, own] of refused) expect(verifiedSignInAddress(record, own), JSON.stringify([record, own])).toBeUndefined();
  });
});

describe("the reverse index (H1), scoped to one company", () => {
  const taskId = "00000000-0000-4000-8000-0000000000e2";
  const sessionId = taskSessionId(taskId);
  const session = (orgId: OrgId = ORG, owner = PERSON_HASH) => ({ orgId, sessionId, subject: { kind: "task", taskId }, owner: { developerId: owner, name: "P" } }) as never;
  const taskRecord = (fields: Record<string, unknown> = {}) => ({ pk: `DEVTASK#${taskId}`, sk: "META", developerId: PERSON, provider: HOSTED_IDENTITY_PROVIDER, companyId: ORG, sessionId, ...fields });
  const remember = (store: MemoryDocumentStore, orgId: OrgId = ORG, owner = PERSON_HASH) => rememberAttentionOwner({ store, provider: HOSTED_IDENTITY_PROVIDER, now: () => new Date(NOW) }, { orgId, sessionId, session: session(orgId, owner) });

  it("remembers the task's owner from the task's own record, in the company's partition, and finds them again", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: taskRecord() });
    expect(await remember(store)).toBe(true);
    expect(await store.get(attentionPersonKey(ORG, PERSON_HASH))).toMatchObject({ orgId: ORG, developerId: PERSON_HASH, personId: PERSON });
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, ORG, PERSON_HASH)).toBe(PERSON);
    // Another company asks for the same hash: its partition is empty.
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, OTHER_ORG, PERSON_HASH)).toBeUndefined();
  });

  it("keeps one row per company: another company's row for the same id never replaces or answers for this one", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: taskRecord() });
    await remember(store);
    await store.put({ item: { ...attentionPersonKey(OTHER_ORG, PERSON_HASH), entityType: "ATTENTION_PERSON", orgId: OTHER_ORG, developerId: PERSON_HASH, personId: PERSON } });
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, ORG, PERSON_HASH)).toBe(PERSON);
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, OTHER_ORG, PERSON_HASH)).toBe(PERSON);
    expect(attentionPersonKey(ORG, PERSON_HASH).pk).not.toBe(attentionPersonKey(OTHER_ORG, PERSON_HASH).pk);
  });

  it("writes nothing for a task record of another company, another provider, a person who is not the owner, another session, or a session that is not a task's", async () => {
    for (const fields of [{ companyId: OTHER_ORG }, { provider: "github" }, { developerId: "someone-else" }, { sessionId: "ses_other" }, { developerId: "has space" }]) {
      const store = new MemoryDocumentStore();
      await store.put({ item: taskRecord(fields) });
      expect(await remember(store), JSON.stringify(fields)).toBe(false);
      expect((await store.query({ pk: `ATTENTION_PERSON#${ORG}` })).items, JSON.stringify(fields)).toEqual([]);
    }
    const store = new MemoryDocumentStore();
    await store.put({ item: taskRecord() });
    // The session says another company than the change: nothing.
    expect(await rememberAttentionOwner({ store, provider: HOSTED_IDENTITY_PROVIDER }, { orgId: OTHER_ORG, sessionId, session: session(ORG) })).toBe(false);
    expect(await remember(store, ORG, DANA_ID)).toBe(false);
    expect(await rememberAttentionOwner({ store, provider: HOSTED_IDENTITY_PROVIDER }, { orgId: ORG, sessionId, session: { ...(session() as object), subject: { kind: "project", project: "web" } } as never })).toBe(false);
    expect(await remember(new MemoryDocumentStore())).toBe(false);
    expect((await store.query({ pk: `ATTENTION_PERSON#${ORG}` })).items).toEqual([]);
    // A store that fails never throws out of it.
    expect(await rememberAttentionOwner({ store: { async get() { throw new Error("down"); }, async put() { throw new Error("down"); } }, provider: HOSTED_IDENTITY_PROVIDER }, { orgId: ORG, sessionId, session: session() })).toBe(false);
  });

  it("never answers a row that is another company's, names another id, or names a person who does not hash to the id asked about", async () => {
    const store = new MemoryDocumentStore();
    const put = (fields: Record<string, unknown>) => store.put({ item: { ...attentionPersonKey(ORG, PERSON_HASH), entityType: "ATTENTION_PERSON", orgId: ORG, developerId: PERSON_HASH, personId: PERSON, ...fields } });
    for (const fields of [{ orgId: OTHER_ORG }, { developerId: DANA_ID }, { personId: "someone-else" }, { personId: 5 }, { personId: "a#b" }]) {
      await put(fields);
      expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, ORG, PERSON_HASH), JSON.stringify(fields)).toBeUndefined();
    }
    await put({});
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, ORG, PERSON_HASH)).toBe(PERSON);
    expect(await attentionPersonOf(store, "github", ORG, PERSON_HASH)).toBeUndefined();
    expect(await attentionPersonOf(store, HOSTED_IDENTITY_PROVIDER, ORG, "not-a-hash")).toBeUndefined();
  });

  it("finds the address only for a live member of THIS company, from a verifying source, reading only the fields it needs", async () => {
    const signIn = (record: Record<string, unknown> | undefined) => {
      const seen: Array<Record<string, unknown>> = [];
      return { seen, client: { async send(command: unknown) { if (!(command instanceof GetCommand)) throw new Error("only gets"); seen.push({ ...command.input }); return { Item: record }; } } };
    };
    const store = new MemoryDocumentStore();
    await store.put({ item: taskRecord() });
    await remember(store);
    const record = { email: "person@example.test", provider: "github", issuer: GITHUB_ISSUER, subject: "12" };
    const member = (companyId: OrgId | undefined) => async (personId: string) => (personId === PERSON && companyId !== undefined ? { companyId } : undefined);
    const live = signIn(record);
    const address = hostedAttentionAddress({ store, documentClient: live.client, signInTableName: "signin", ownOidcIssuer: undefined, membershipOf: member(ORG) });
    expect(await address(ORG, PERSON_HASH)).toBe("person@example.test");
    expect(live.seen).toEqual([{ TableName: "signin", Key: { pk: `DEVELOPER#${PERSON}`, sk: "META" }, ConsistentRead: true, ProjectionExpression: "#e, #r, #p, #i, #s", ExpressionAttributeNames: { "#e": "email", "#r": "revoked", "#p": "provider", "#i": "issuer", "#s": "subject" } }]);
    // A member of another company now, or of none: no address, no sign-in read.
    for (const companyId of [OTHER_ORG, undefined]) {
      const r = signIn(record);
      expect(await hostedAttentionAddress({ store, documentClient: r.client, signInTableName: "signin", ownOidcIssuer: undefined, membershipOf: member(companyId) })(ORG, PERSON_HASH)).toBeUndefined();
      expect(r.seen).toEqual([]);
    }
    // A row forged into another company's partition naming this person still sends nothing: the person is not a member there.
    await store.put({ item: { ...attentionPersonKey(OTHER_ORG, PERSON_HASH), entityType: "ATTENTION_PERSON", orgId: OTHER_ORG, developerId: PERSON_HASH, personId: PERSON } });
    const forged = signIn(record);
    expect(await hostedAttentionAddress({ store, documentClient: forged.client, signInTableName: "signin", ownOidcIssuer: undefined, membershipOf: member(ORG) })(OTHER_ORG, PERSON_HASH)).toBeUndefined();
    expect(forged.seen).toEqual([]);
    // A company issuer's email: none.
    expect(await hostedAttentionAddress({ store, documentClient: signIn({ ...record, provider: "oidc", issuer: "https://idp.company.test" }).client, signInTableName: "signin", ownOidcIssuer: "https://idp.install.test", membershipOf: member(ORG) })(ORG, PERSON_HASH)).toBeUndefined();
    // Nobody in the index: nothing is read.
    const nobody = signIn(record);
    expect(await hostedAttentionAddress({ store, documentClient: nobody.client, signInTableName: "signin", ownOidcIssuer: undefined, membershipOf: member(ORG) })(ORG, DANA_ID)).toBeUndefined();
    expect(nobody.seen).toEqual([]);
  });
});

describe("the signed link", () => {
  it("names one company and one person, for 90 days, and nothing else", () => {
    const token = mintUnsubscribeToken(KEY, { orgId: ORG, developerId: DANA_ID, nowMs: NOW });
    expect(verifyUnsubscribeToken(KEY, token, NOW + 1)).toEqual({ orgId: ORG, developerId: DANA_ID });
    expect(verifyUnsubscribeToken(KEY, token, NOW + (UNSUBSCRIBE_LINK_DAYS * 86_400_000) - 1)).toEqual({ orgId: ORG, developerId: DANA_ID });
    expect(verifyUnsubscribeToken(KEY, token, NOW + UNSUBSCRIBE_LINK_DAYS * 86_400_000)).toBeUndefined();
    expect(token).not.toContain(DANA_ID);
  });
  it("is refused when changed in any way, signed by another key, or not shaped like one", () => {
    const token = mintUnsubscribeToken(KEY, { orgId: ORG, developerId: DANA_ID, nowMs: NOW });
    const [v, body, sig] = token.split(".") as [string, string, string];
    const other = mintUnsubscribeToken(KEY, { orgId: ORG, developerId: OWNER_ID, nowMs: NOW }).split(".")[1]!;
    const bad = [
      "", "x", `${v}.${body}`, `${v}.${body}.${sig}.x`, `v2.${body}.${sig}`, `${v}.${other}.${sig}`, `${v}.${body}.${sig.slice(0, -2)}AA`, `${v}.${body}.`, `${v}..${sig}`, token.toUpperCase(), `${token} `,
      mintUnsubscribeToken(unsubscribeKeyOf("another-key"), { orgId: ORG, developerId: DANA_ID, nowMs: NOW }), "a".repeat(700), 5, undefined, null, {},
    ];
    for (const value of bad) expect(verifyUnsubscribeToken(KEY, value, NOW), JSON.stringify(value)?.slice(0, 30)).toBeUndefined();
    // A correctly signed token with a body of the wrong shape is refused too.
    const signed = (value: unknown) => { const b = Buffer.from(JSON.stringify(value)).toString("base64url"); return `v1.${b}.${createHmac("sha256", KEY).update(`v1.${b}`).digest("base64url")}`; };
    for (const value of [[ORG, DANA_ID], [ORG, DANA_ID, "x"], [ORG, DANA_ID, NOW + 1000, "extra"], ["org_x", DANA_ID, NOW + 1000], [ORG, "short", NOW + 1000], { a: 1 }, "x", null, [5, DANA_ID, NOW + 1000]]) expect(verifyUnsubscribeToken(KEY, signed(value), NOW), JSON.stringify(value)).toBeUndefined();
    expect(verifyUnsubscribeToken(KEY, signed([ORG, DANA_ID, NOW + 1000]), NOW)).toEqual({ orgId: ORG, developerId: DANA_ID });
  });
  it("builds per-person links on the web app's own origin only, and none when that is not a plain https origin", () => {
    const links = attentionEmailLinks({ origin: "https://app.example.test/some/path?x=1", key: KEY, now: () => NOW });
    const dana = links(ORG, DANA_ID);
    expect(dana.settings).toBe("https://app.example.test/app/settings/notifications");
    expect(dana.home).toBe("https://app.example.test/app/inbox");
    expect(dana.unsubscribe!.startsWith("https://app.example.test/app/notifications/unsubscribe?t=")).toBe(true);
    const token = decodeURIComponent(dana.unsubscribe!.split("?t=")[1]!);
    expect(verifyUnsubscribeToken(KEY, token, NOW)).toEqual({ orgId: ORG, developerId: DANA_ID });
    expect(links(ORG, OWNER_ID).unsubscribe).not.toBe(dana.unsubscribe);
    for (const origin of ["http://app.example.test", "ftp://x.test", "https://user:pw@app.example.test", "not a url", ""]) expect(attentionEmailLinks({ origin, key: KEY, now: () => NOW })(ORG, DANA_ID), origin).toEqual({});
  });
});

// ---- the unsubscribe route

describe("POST /v1/app/notify/unsubscribe", () => {
  const members: SessionMembers = { companyRole: () => "member", projectGrant: () => undefined };
  const dana = { companyId: ORG, personId: "dana", displayName: "Dana", roles: ["member"], provider: "test" } as const;
  const danaId = developerIdOf(dana);
  const REQUEST = "6f1c1c1e-5b0e-4c1f-9a53-0f4f2b7d9a10";
  async function route(options: { key?: Buffer | undefined; companyId?: OrgId } = {}) {
    const store = new MemoryDocumentStore();
    const routes = createInboxRoutes({ store, companyId: options.companyId ?? ORG, origin: () => "https://api.example.test", members, ...(options.key === undefined && "key" in options ? {} : { unsubscribeKey: options.key ?? KEY }), now: () => NOW });
    const call = async (principal: typeof dana, body: unknown, method = "POST") => {
      try {
        const answer = await routes({ method, path: "/v1/app/notify/unsubscribe", headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }, { principal: principal });
        return answer === undefined ? { status: 0, body: undefined } : { status: answer.statusCode, body: JSON.parse(answer.body) as unknown };
      } catch (error) {
        if (error instanceof AgentXError) return { status: error.statusCode, body: { code: error.code, message: error.message.slice(error.code.length + 2) } };
        throw error;
      }
    };
    return { store, call, prefs: (id: string, org: string = ORG) => readNotifyPrefs(store, org, id) };
  }
  const tokenFor = (developerId: string, orgId: string = ORG, nowMs = NOW) => mintUnsubscribeToken(KEY, { orgId, developerId, nowMs });

  it("stops the emails of the signed-in person the link names, and only theirs", async () => {
    const r = await route();
    await writeNotifyPrefs({ store: r.store, now: () => new Date(NOW) }, ORG, danaId, { channel: "email" });
    expect(await r.call(dana, { requestId: REQUEST, token: tokenFor(danaId) })).toEqual({ status: 200, body: { emailUnsubscribed: true } });
    expect(await r.prefs(danaId)).toMatchObject({ emailUnsubscribed: true, channel: "email" });
    expect((await r.prefs(OWNER_ID)).emailUnsubscribed).toBe(false);
    // Repeating it changes nothing more.
    expect((await r.call(dana, { requestId: REQUEST, token: tokenFor(danaId) })).status).toBe(200);
  });

  it("answers one fixed refusal, and writes nothing, for a link that is someone else's, another company's, expired, changed or not a link", async () => {
    const r = await route();
    const good = tokenFor(danaId);
    const [v, body, sig] = good.split(".") as [string, string, string];
    const bad = [tokenFor(OWNER_ID), tokenFor(danaId, OTHER_ORG), tokenFor(danaId, ORG, NOW - UNSUBSCRIBE_LINK_DAYS * 86_400_000 - 1), `${v}.${body}.${sig.slice(0, -2)}AA`, "x", "", 5, null, undefined];
    for (const token of bad) {
      const refused = await r.call(dana, { requestId: REQUEST, token });
      expect(refused.status, String(token).slice(0, 20)).toBe(400);
      expect((refused.body as { message: string }).message).toBe(UNSUBSCRIBE_BAD_LINK);
    }
    expect((await r.prefs(danaId)).emailUnsubscribed).toBe(false);
    expect((await r.store.query({ pk: `NOTIFY_PREFS#${ORG}` })).items).toEqual([]);
    // The owner's link does not stop Dana's emails even when Dana sends it, and the answer does not say whose it was.
    expect(JSON.stringify((await r.call(dana, { requestId: REQUEST, token: tokenFor(OWNER_ID) })).body)).not.toContain(OWNER_ID);
  });

  it("refuses a body that is not exactly { requestId, token }, a principal of another company, and is not served without the key", async () => {
    const r = await route();
    for (const body of [{ token: tokenFor(danaId) }, { requestId: "nope", token: tokenFor(danaId) }, { requestId: REQUEST, token: tokenFor(danaId), companyId: ORG }, "{nope", [], null]) {
      const refused = await r.call(dana, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect((refused.body as { message: string }).message).toBe("That request is not valid.");
    }
    expect((await r.call({ ...dana, companyId: OTHER_ORG }, { requestId: REQUEST, token: tokenFor(danaId) })).status).toBe(401);
    expect(await r.call(dana, { requestId: REQUEST, token: tokenFor(danaId) }, "GET")).toEqual({ status: 0, body: undefined });
    const unwired = await route({ key: undefined });
    const answer = await unwired.call(dana, { requestId: REQUEST, token: tokenFor(danaId) });
    expect(answer.status).toBe(404);
    expect((answer.body as { message: string }).message).toBe("That is not on the core engine on this install yet.");
    expect((await unwired.prefs(danaId)).emailUnsubscribed).toBe(false);
  });
});

// ---- the whole path, over fakes: the notice service, the reverse index, the address, the broker's adapter and the sender function's own checks

describe("a hosted person with no chat is told by email, in the core's words", () => {
  const T0 = "2026-11-09T10:00:00.000Z";
  const AGENT = { agentId: "rovara-code", name: "Rovara Code", version: 1 };
  const HOSTED = { companyId: ORG, personId: PERSON, displayName: "Pat", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER } as const;
  async function world(options: { record?: Record<string, unknown> | undefined; companyId?: OrgId; sender?: boolean; abort?: boolean } = {}) {
    const invokes = { count: 0 };
    const store = new MemoryDocumentStore();
    const registry = createAdapterRegistry();
    const sent: Array<Record<string, unknown>> = [];
    const ses = { async send(command: unknown) { sent.push((command as SendEmailCommand).input as unknown as Record<string, unknown>); return {}; } };
    const handler = attentionEmailSenderHandler({ ses, env: { ATTENTION_EMAIL_FROM: "notices@example.test", ATTENTION_EMAIL_LINK_ORIGIN: ORIGIN }, log: () => undefined });
    const lambda = { async send(command: unknown) { invokes.count += 1; if (options.abort === true) throw Object.assign(new Error("aborted"), { name: "AbortError" }); const payload = JSON.parse(new TextDecoder().decode((command as InvokeCommand).input.Payload as Uint8Array)) as unknown; return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(await handler(payload))) }; } };
    const signInReads: unknown[] = [];
    const documentClient = { async send(command: unknown) { signInReads.push(command); return { Item: "record" in options ? options.record : { email: "pat@example.test", provider: "github", issuer: GITHUB_ISSUER, subject: "7" } }; } };
    const parts = attentionEmailFromEnvironment({ env: ENV_ON, lambda: () => lambda, documentClient, signInTableName: "signin", callbackSigningKey: "callback-signing-key-for-tests", now: () => NOW, membershipOf: async (personId) => (personId === PERSON ? { companyId: options.companyId ?? ORG } : undefined), log: () => undefined })!;
    if (options.sender !== false) registry.register("email", "hosted-attention-email", parts.sender);
    // As the core root wires it: with the switch off there are no attention parts at all.
    const notices = createNoticeService({ store, registry, now: () => new Date(NOW), log: () => undefined, inbox: true, ...(options.sender === false ? {} : { address: parts.addressFor(store), emailLinks: parts.links, remember: parts.rememberFor(store) }) });
    const taskId = "00000000-0000-4000-8000-0000000000e1";
    const sessionId = taskSessionId(taskId);
    await store.transact(createTaskSessionItems({ orgId: ORG, sessionId, taskId, project: "web", agent: AGENT, title: "Add retry", owner: HOSTED, origin: "app", payer: { kind: "member", developerId: PERSON_HASH } as never, now: T0 }));
    // The task's own record, as the hosted start writes it (the raw sign-in id, the provider, the company, the session).
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", developerId: PERSON, provider: HOSTED_IDENTITY_PROVIDER, companyId: ORG, sessionId } });
    const facts: { value: SessionTaskFacts } = { value: { companyId: ORG, taskId, project: "web", ownerDeveloperId: PERSON_HASH, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
    let ms = NOW - 3_600_000;
    const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined, onChange: [async (change) => { await notices.queue(change); }] };
    for (const [stage, state] of [["IMPLEMENT", "RUNNING"], ["PLAN_REVIEW", "WAITING"]] as const) { facts.value = { ...facts.value, workflow: { stage, state } }; ms += 1_000; await refreshSessionSummary(deps, ORG, sessionId); }
    return { store, notices, sent, signInReads, sessionId, invokes };
  }

  it("finds the person through the index written with the attention rows, and sends one email of the core's words from the attention identity, with the signed way out", async () => {
    const w = await world();
    expect(await w.store.get(attentionPersonKey(ORG, PERSON_HASH))).toMatchObject({ personId: PERSON, orgId: ORG });
    const report = await w.notices.deliver();
    expect(report).toMatchObject({ emails: 1 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ FromEmailAddress: "notices@example.test", Destination: { ToAddresses: ["pat@example.test"] } });
    const text = ((w.sent[0]!["Content"] as { Simple: { Body: { Text: { Data: string } } } }).Simple.Body.Text.Data);
    expect(text.split("\n")[0]).toBe("A task needs your attention in Rovara:");
    const unsubscribe = text.split("\n").find((line) => line.startsWith("Stop these emails: "))!;
    expect(verifyUnsubscribeToken(unsubscribeKeyOf("callback-signing-key-for-tests"), decodeURIComponent(unsubscribe.split("?t=")[1]!), NOW)).toEqual({ orgId: ORG, developerId: PERSON_HASH });
    expect(text).not.toContain(w.sessionId);
    expect(await w.notices.deliver()).toMatchObject({ emails: 0 });
  });

  it("sends nothing to a person who stopped these emails, is a member elsewhere now, has a company issuer's or no address; and does not fail", async () => {
    const stopped = await world();
    await writeNotifyPrefs({ store: stopped.store, now: () => new Date(NOW) }, ORG, PERSON_HASH, { emailUnsubscribed: true });
    await stopped.notices.deliver();
    expect(stopped.sent).toEqual([]);
    for (const options of [{ companyId: OTHER_ORG }, { record: { email: "pat@example.test", provider: "oidc", issuer: "https://idp.company.test", subject: "s" } }, { record: undefined }, { record: { email: "Pat <pat@example.test>", provider: "github", issuer: GITHUB_ISSUER } }]) {
      const w = await world(options);
      await expect(w.notices.deliver()).resolves.toBeDefined();
      expect(w.sent, JSON.stringify(options)).toEqual([]);
    }
  });

  it("does not send again an email whose invoke was cut off at the deadline (the claim is kept)", async () => {
    const w = await world({ abort: true });
    // Given up on at once, not counted as a failure to try again later.
    expect(await w.notices.deliver()).toMatchObject({ emails: 0, gaveUp: 1, failed: 0 });
    expect(w.invokes.count).toBe(1);
    await w.notices.deliver({});
    expect(w.invokes.count).toBe(1);
  });

  it("sends nothing at all and writes no index when the switch is off: Code's default sender is in place and nothing is read", async () => {
    const w = await world({ sender: false });
    expect(w.notices.canNotify()).toBe(false);
    expect(await w.notices.deliver()).toBeUndefined();
    expect(w.sent).toEqual([]);
    expect(w.signInReads).toEqual([]);
    expect(await w.store.get(attentionPersonKey(ORG, PERSON_HASH))).toBeUndefined();
  });
});
