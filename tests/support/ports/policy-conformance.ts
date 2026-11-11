// Port lane W0: conformance suites for the policy seams and the model key store. Each states what every adapter of the seam must
// do, in Code (allow, do nothing) and in Cloud (budgets, ledger, members). The harness supplies the cases that belong to the adapter.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertValidTransaction,
  SecretValue,
  type Admission,
  type AdmissionRequest,
  type ApprovalProof,
  type ApprovalRequest,
  type Approvers,
  type AuditEvent,
  type AuditSink,
  type Cost,
  type IdentityProvider,
  type MeterEntry,
  type Metering,
  type ModelKeyStore,
  type ModelUsage,
  type PresentedCredential,
  type Principal,
} from "@agentx/contracts";

// ---- Admission ----

export interface AdmissionHarness {
  create(): Promise<Admission>;
  /** A request this adapter admits (in Code, any). Its `idempotencyKey` is replaced by the suite. */
  admissible: AdmissionRequest;
  /** A request this adapter refuses, or undefined when it refuses nothing (Code's default). */
  refused?: AdmissionRequest;
  /** What the adapter must declare as `enforcesCost`. Required: an adapter states it, the suite never infers it. `true` only for an adapter that refuses a request whose `estimate.cost` is over its allowance (so `refused` must be set, and carry such an estimate). */
  enforcesCost: boolean;
}

export function runAdmissionConformance(name: string, harness: AdmissionHarness): void {
  describe(`admission conformance: ${name}`, () => {
    it("admits an admissible request", async () => {
      const decision = await (await harness.create()).admit(harness.admissible);
      expect(decision.allowed).toBe(true);
    });

    it("declares whether it enforces a cost limit, and an adapter that says it does refuses a request over its allowance", async () => {
      const admission = await harness.create();
      expect(typeof admission.enforcesCost).toBe("boolean");
      expect(admission.enforcesCost).toBe(harness.enforcesCost);
      if (harness.enforcesCost) {
        expect(harness.refused?.estimate?.cost).toBeDefined();
        expect((await admission.admit(harness.refused!)).allowed).toBe(false);
      }
    });

    it("refuses with a code a caller can branch on and a sentence a person can read", async () => {
      if (harness.refused === undefined) return;
      const decision = await (await harness.create()).admit(harness.refused);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.code).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(decision.message.length).toBeGreaterThan(0);
        if (decision.retryAfterSeconds !== undefined) expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(0);
      }
    });

    it("answers a repeated request key with the same decision and takes the allowance once", async () => {
      const admission = await harness.create();
      const request = { ...harness.admissible, idempotencyKey: "same-key" };
      const first = await admission.admit(request);
      const second = await admission.admit(request);
      expect(second.allowed).toBe(first.allowed);
      if (first.allowed && second.allowed) expect(second.reservationId).toBe(first.reservationId);
    });

    it("stages the allowance for the caller's transaction, valid steps or none, and a refusal stages nothing", async () => {
      const admission = await harness.create();
      const staged = await admission.stage({ ...harness.admissible, idempotencyKey: "staged-key" });
      expect(staged.decision.allowed).toBe(true);
      if (staged.items.length > 0) assertValidTransaction(staged.items);
      if (harness.refused !== undefined) {
        const refused = await admission.stage({ ...harness.refused, idempotencyKey: "refused-key" });
        expect(refused.decision.allowed).toBe(false);
        expect(refused.items).toEqual([]);
      }
    });

    it("settles and releases a reservation once, and treats a repeat or an unknown id as a no-op", async () => {
      const admission = await harness.create();
      const decision = await admission.admit(harness.admissible);
      const reservationId = decision.allowed ? decision.reservationId : undefined;
      const cost: Cost = { micros: 1_000, currency: "USD" };
      if (reservationId !== undefined) {
        await admission.settle(reservationId, { tokens: 10, cost });
        await admission.settle(reservationId, { tokens: 10, cost });
        await admission.release(reservationId);
      }
      await admission.settle("no-such-reservation", { tokens: 1 });
      await admission.release("no-such-reservation");
    });
  });
}

// ---- Audit sink ----

export interface AuditSinkHarness {
  create(): Promise<AuditSink>;
}
export const SAMPLE_AUDIT_EVENT: AuditEvent = {
  eventId: "evt-1",
  companyId: "org_00000000000000000000",
  at: "2026-11-09T10:00:00.000Z",
  actor: { type: "person", id: "person-1" },
  action: "task.approved",
  subject: { type: "task", id: "task-1" },
  details: { revision: 3 },
};

export function runAuditSinkConformance(name: string, harness: AuditSinkHarness): void {
  describe(`audit sink conformance: ${name}`, () => {
    it("stages steps that are valid in a document-store transaction (none is fine)", async () => {
      const steps = (await harness.create()).stage(SAMPLE_AUDIT_EVENT);
      if (steps.length > 0) assertValidTransaction(steps);
    });

    it("stages the same steps for the same event, and does not change the event", async () => {
      const sink = await harness.create();
      const before = structuredClone(SAMPLE_AUDIT_EVENT);
      expect(sink.stage(SAMPLE_AUDIT_EVENT)).toEqual(sink.stage(SAMPLE_AUDIT_EVENT));
      expect(SAMPLE_AUDIT_EVENT).toEqual(before);
    });

    it("records an event on its own, and a repeat of the same event id does not fail", async () => {
      const sink = await harness.create();
      await sink.record(SAMPLE_AUDIT_EVENT);
      await sink.record(SAMPLE_AUDIT_EVENT);
    });
  });
}

// ---- Approvers ----

export interface ApproversHarness {
  create(): Promise<Approvers>;
  request: ApprovalRequest;
  /** A proof this adapter accepts for `request`. The suite gives each use a new `proofId`. */
  acceptable: ApprovalProof;
  /** The same proof with a token the issuer does not know. */
  forgedToken: string;
}

export function runApproversConformance(name: string, harness: ApproversHarness): void {
  let counter = 0;
  const fresh = (overrides: Partial<ApprovalProof> = {}): ApprovalProof => ({ ...harness.acceptable, proofId: `proof-${++counter}`, ...overrides });
  describe(`approvers conformance: ${name}`, () => {
    it("says how a person may approve and how many must", async () => {
      const requirement = await (await harness.create()).requirement(harness.request);
      expect(requirement.methods.length).toBeGreaterThan(0);
      expect(requirement.minApprovers).toBeGreaterThanOrEqual(1);
      expect(typeof requirement.selfApprovalAllowed).toBe("boolean");
      expect(requirement.methods).toContain(harness.acceptable.method);
    });

    it("names its strong, reject and changes methods only among the methods it offers, and never a comment as strong (lane P3, item A3)", async () => {
      const requirement = await (await harness.create()).requirement(harness.request);
      for (const named of [requirement.strongMethods, requirement.rejectMethods, requirement.changesMethods]) {
        if (named !== undefined) for (const method of named) expect(requirement.methods).toContain(method);
      }
      for (const named of [requirement.strongMethods, requirement.rejectMethods]) {
        if (named !== undefined) expect(named).not.toContain("code-host-comment");
      }
      if (requirement.signIn !== undefined) expect(["window", "any-active"]).toContain(requirement.signIn.mode);
    });

    it("gives an approver an authTime that is a time, when it gives one (lane P3, item A1)", async () => {
      const verdict = await (await harness.create()).verify(harness.request, fresh());
      if (verdict.approved && verdict.approver.authTime !== undefined) expect(Number.isFinite(Date.parse(verdict.approver.authTime))).toBe(true);
    });

    it("accepts an acceptable proof and names the approver and the proof", async () => {
      const proof = fresh();
      const verdict = await (await harness.create()).verify(harness.request, proof);
      expect(verdict.approved).toBe(true);
      if (verdict.approved) {
        expect(verdict.method).toBe(proof.method);
        expect(verdict.proofId).toBe(proof.proofId);
        expect(verdict.approver.personId.length).toBeGreaterThan(0);
        expect(verdict.approver.companyId).toBe(harness.request.companyId);
      }
    });

    it("refuses a method it does not know, with a reason", async () => {
      const verdict = await (await harness.create()).verify(harness.request, fresh({ method: "no-such-method" }));
      expect(verdict.approved).toBe(false);
      if (!verdict.approved) expect(verdict.reason.length).toBeGreaterThan(0);
    });

    it("refuses a proof for another company's request", async () => {
      const verdict = await (await harness.create()).verify({ ...harness.request, companyId: "org_zzzzzzzzzzzzzzzzzzzz" }, fresh());
      expect(verdict.approved).toBe(false);
    });

    it("refuses a forged token, and a person that is only claimed", async () => {
      const approvers = await harness.create();
      expect((await approvers.verify(harness.request, fresh({ token: harness.forgedToken }))).approved).toBe(false);
      expect((await approvers.verify(harness.request, fresh({ token: "" }))).approved).toBe(false);
    });

    it("refuses a proof made for another request, another revision or other content", async () => {
      const approvers = await harness.create();
      expect((await approvers.verify(harness.request, fresh({ requestId: `${harness.request.requestId}-other` }))).approved).toBe(false);
      expect((await approvers.verify(harness.request, fresh({ revision: harness.request.revision + 1 }))).approved).toBe(false);
      expect((await approvers.verify(harness.request, fresh({ artifactDigest: "f".repeat(64) }))).approved).toBe(false);
      // The same proof, later, for a newer revision of the same subject.
      expect((await approvers.verify({ ...harness.request, revision: harness.request.revision + 1 }, fresh())).approved).toBe(false);
    });

    it("refuses a proof after the request has expired", async () => {
      const verdict = await (await harness.create()).verify({ ...harness.request, expiresAt: "2000-01-01T00:00:00.000Z" }, fresh());
      expect(verdict.approved).toBe(false);
    });

    it("accepts a proof once and refuses its replay", async () => {
      const approvers = await harness.create();
      const proof = fresh();
      expect((await approvers.verify(harness.request, proof)).approved).toBe(true);
      expect((await approvers.verify(harness.request, proof)).approved).toBe(false);
    });
  });
}

// ---- Identity ----

export interface IdentityHarness {
  create(): Promise<IdentityProvider>;
  /** A credential this adapter accepts, and the principal it must give. */
  valid: { credential: PresentedCredential; principal: Pick<Principal, "companyId" | "personId"> };
  /** An outside account the adapter has linked to `valid.principal`, when it links any. */
  linkedAccount?: Parameters<IdentityProvider["resolveExternalAccount"]>[1];
}

export function runIdentityConformance(name: string, harness: IdentityHarness): void {
  describe(`identity conformance: ${name}`, () => {
    it("signs in a valid credential and gives a principal with a company and a person", async () => {
      const result = await (await harness.create()).authenticate(harness.valid.credential);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principal).toMatchObject(harness.valid.principal);
        expect(result.principal.provider.length).toBeGreaterThan(0);
        expect(Array.isArray(result.principal.roles)).toBe(true);
      }
    });

    it("refuses a credential it does not know and one of a scheme it does not use, without throwing", async () => {
      const identity = await harness.create();
      const unknown = await identity.authenticate({ scheme: harness.valid.credential.scheme, value: "not-a-credential" });
      expect(unknown.ok).toBe(false);
      const other = await identity.authenticate({ scheme: "no-such-scheme", value: harness.valid.credential.value });
      expect(other.ok).toBe(false);
      if (!other.ok) expect(["unknown", "expired", "refused"]).toContain(other.reason);
    });

    it("finds a person by id in their company, and nobody for an unknown id or another company", async () => {
      const identity = await harness.create();
      const { companyId, personId } = harness.valid.principal;
      expect((await identity.getPrincipal(companyId, personId))?.personId).toBe(personId);
      expect(await identity.getPrincipal(companyId, "no-such-person")).toBeUndefined();
      expect(await identity.getPrincipal("org_zzzzzzzzzzzzzzzzzzzz", personId)).toBeUndefined();
    });

    it("resolves a linked outside account to its person, and an unlinked one to nobody", async () => {
      const identity = await harness.create();
      const { companyId, personId } = harness.valid.principal;
      expect(await identity.resolveExternalAccount(companyId, { provider: "no-such-provider", tenant: "t", accountId: "nobody" })).toBeUndefined();
      if (harness.linkedAccount !== undefined) {
        expect((await identity.resolveExternalAccount(companyId, harness.linkedAccount))?.personId).toBe(personId);
        expect(await identity.resolveExternalAccount("org_zzzzzzzzzzzzzzzzzzzz", harness.linkedAccount)).toBeUndefined();
      }
    });

    // Lane P3, item I1: the optional abilities. An adapter offers what its capability flags say, and answers the way the port says.
    it("offers the abilities its capability flags name", async () => {
      const identity = await harness.create();
      if (identity.capabilities.interactiveSignIn) {
        expect(typeof identity.beginSignIn).toBe("function");
        expect(typeof identity.completeSignIn).toBe("function");
        expect(typeof identity.signOut).toBe("function");
      }
      if (identity.capabilities.externalAccounts) expect(typeof identity.accountsOf).toBe("function");
      if (identity.capabilities.members === true) expect(typeof identity.listMembers).toBe("function");
    });

    it("lists the company's members in its own company only, with a sign-in time that is a time when it has one", async () => {
      const identity = await harness.create();
      if (identity.listMembers === undefined) return;
      const { companyId, personId } = harness.valid.principal;
      const page = await identity.listMembers(companyId);
      expect(page.members.map((member) => member.personId)).toContain(personId);
      for (const member of page.members) {
        expect(member.companyId).toBe(companyId);
        if (member.authTime !== undefined) expect(Number.isFinite(Date.parse(member.authTime))).toBe(true);
      }
      expect((await identity.listMembers("org_zzzzzzzzzzzzzzzzzzzz")).members).toEqual([]);
    });

    it("lists a person's outside accounts, the other way round from resolving one, and none for a stranger", async () => {
      const identity = await harness.create();
      if (identity.accountsOf === undefined) return;
      const { companyId, personId } = harness.valid.principal;
      if (harness.linkedAccount !== undefined) expect(await identity.accountsOf(companyId, personId)).toContainEqual(harness.linkedAccount);
      expect(await identity.accountsOf(companyId, "no-such-person")).toEqual([]);
      expect(await identity.accountsOf("org_zzzzzzzzzzzzzzzzzzzz", personId)).toEqual([]);
    });

    it("ends a sign-in that is over without failing, and refuses nobody a second time", async () => {
      const identity = await harness.create();
      if (identity.signOut === undefined) return;
      await identity.signOut(harness.valid.credential);
      await identity.signOut(harness.valid.credential);
    });
  });
}

// ---- Metering ----

export interface MeteringHarness {
  create(): Promise<Metering>;
  known: ModelUsage;
  /** Usage of a model the adapter cannot price. */
  unknown: ModelUsage;
  entry(usage: ModelUsage): MeterEntry;
}

export function runMeteringConformance(name: string, harness: MeteringHarness): void {
  describe(`metering conformance: ${name}`, () => {
    it("prices known usage as a whole, non-negative number of millionths with a currency", async () => {
      const cost = await (await harness.create()).price(harness.known);
      expect(cost).not.toBeNull();
      expect(Number.isInteger(cost!.micros)).toBe(true);
      expect(cost!.micros).toBeGreaterThanOrEqual(0);
      expect(cost!.currency).toMatch(/^[A-Z]{3}$/);
    });

    it("prices no tokens at nothing, and more tokens at no less", async () => {
      const metering = await harness.create();
      const none = await metering.price({ ...harness.known, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      expect(none?.micros).toBe(0);
      const small = await metering.price(harness.known);
      const big = await metering.price({ ...harness.known, tokens: { input: harness.known.tokens.input * 10, output: harness.known.tokens.output * 10, cacheRead: harness.known.tokens.cacheRead * 10, cacheWrite: harness.known.tokens.cacheWrite * 10 } });
      expect(big!.micros).toBeGreaterThanOrEqual(small!.micros);
    });

    it("records usage and answers the cost it priced", async () => {
      const metering = await harness.create();
      const result = await metering.record(harness.entry(harness.known));
      expect(result.cost).toEqual(await metering.price(harness.known));
      expect(["price-table", "provider-reported"]).toContain(result.source);
    });

    it("counts an entry once however often it is recorded", async () => {
      const metering = await harness.create();
      const entry = harness.entry(harness.known);
      const first = await metering.record(entry);
      const again = await metering.record(entry);
      expect(again).toEqual(first);
    });

    it("answers a model it cannot price with no cost and the source unknown, and does not throw", async () => {
      const metering = await harness.create();
      expect(await metering.price(harness.unknown)).toBeNull();
      expect(await metering.record(harness.entry(harness.unknown))).toEqual({ cost: null, source: "unknown" });
    });
  });
}

// ---- Model key store ----

export interface ModelKeyStoreHarness {
  /** A store holding exactly `keys` (provider to key). */
  create(keys: Record<string, string>): Promise<ModelKeyStore>;
}

export function runModelKeyStoreConformance(name: string, harness: ModelKeyStoreHarness): void {
  const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
  const keys = { anthropic: ["test", "key", "one"].join("-"), openai: ["test", "key", "two"].join("-") };
  describe(`model key store conformance: ${name}`, () => {
    it("gives the key for a provider that has one, and nothing for one that has none", async () => {
      const store = await harness.create(keys);
      const key = await store.get(COMPANY, "anthropic");
      expect(key).toBeInstanceOf(SecretValue);
      expect(key!.reveal()).toBe(keys.anthropic);
      expect(await store.get(COMPANY, "no-such-provider")).toBeUndefined();
      expect(await store.get(COMPANY, "../etc/passwd")).toBeUndefined();
    });

    it("lists the providers that have a key, and never the keys", async () => {
      const store = await harness.create(keys);
      const providers = await store.providers(COMPANY);
      expect(providers).toEqual(expect.arrayContaining(["anthropic", "openai"]));
      expect(JSON.stringify(providers)).not.toContain(keys.anthropic);
    });

    it("keeps a key out of text, JSON and console output", async () => {
      const key = (await (await harness.create(keys)).get(COMPANY, "anthropic"))!;
      for (const shown of [String(key), `${key.toString()}`, JSON.stringify({ key }), inspect(key), inspect({ nested: { key } })]) {
        expect(shown).not.toContain(keys.anthropic);
      }
    });
  });
}
