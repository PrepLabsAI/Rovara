// Sign-in-table membership, preapprovals and operator writes. No token claim is authority.
import { randomBytes, randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../aws/company-check.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { emailIndexKey } from "./store.js";
import { CompanyMember, CompanyMemberRefusal, MemberListInput, MEMBER_CHANGED, MEMBER_LAST_OWNER, MEMBER_REVOKED, MEMBER_ONLY_OWNER, MEMBER_SUCCESSOR_INVALID, memberCursor, memberCursorPerson } from "./company-member-contract.js";
import { CompanyIssuerRecord, CompanyIssuerSettings, companyIssuerKey } from "./company-issuer.js";

export const CompanyPersonId = z.string().regex(/^[a-f0-9]{64}$/);
export const CompanyEmail = z.string().trim().min(3).max(320).email();
export const CompanyExpiryHours = z.number().int().min(1).max(720);
// DEC 253z: a company is made by an operator, or by its first owner with an operator's invite code ("self-serve", naming that person). Old rows ("operator") still read.
// DEC 254b (b): "import" was copied by an operator from the install's old company layout, at `importedAt` (its undo deletes only that record).
export const CompanyRecord = z.object({ entityType: z.literal("COMPANY"), companyId: OrgIdSchema, name: z.string().min(1).max(80), status: z.literal("active"), createdAt: z.iso.datetime(),
  createdBy: z.enum(["operator", "self-serve", "import"]), selfServedBy: z.string().regex(/^[a-f0-9]{64}$/).optional(), importedAt: z.iso.datetime().optional() })
  .refine((record) => (record.createdBy === "self-serve") === (record.selfServedBy !== undefined), "a self-serve company names its first owner")
  .refine((record) => (record.createdBy === "import") === (record.importedAt !== undefined), "an imported company names its import time");
/** A new company id: 128 random bits in base 36, as the operator's create has always made them. */
export const generateCompanyId = () => `org_${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(36).padStart(20, "0").slice(-20)}`;
export const CompanyPreapproval = z.object({
  entityType: z.literal("COMPANY_PREAPPROVAL"), role: z.enum(["admin", "member"]), status: z.enum(["live", "used", "withdrawn"]),
  expiresAt: z.number().int().positive(), createdAt: z.iso.datetime(), createdBy: z.union([z.literal("operator"), CompanyPersonId]),
  usedBy: CompanyPersonId.optional(), usedAt: z.iso.datetime().optional(),
  /** DEC 254h: the SHA-256 of the one invite link secret made with this pre-approval. Replacing the pre-approval replaces it, ending the old secret. */
  inviteHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const companyKey = (companyId: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "COMPANY"), sk: "META" });
export const preapprovalKey = (companyId: string, email: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "PREAPPROVAL"), sk: emailIndexKey(CompanyEmail.parse(email)).pk });
export const preapprovalHashKey = (companyId: string, hash: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "PREAPPROVAL"), sk: `EMAIL#${z.string().regex(/^[a-f0-9]{64}$/).parse(hash)}` });
/**
 * DEC 254h: an invite link's single-use secret, kept only as its SHA-256 in the company's own partition (a secret for A is never even looked up
 * under B), bound to one pre-approval (by its email hash, and the pre-approval naming this secret's hash): withdrawing, spending or replacing
 * that pre-approval ends the secret too.
 */
export const inviteLinkKey = (companyId: string, hash: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "INVITE_LINK"), sk: `SECRET#${z.string().regex(/^[a-f0-9]{64}$/).parse(hash)}` });
export const CompanyInviteLink = z.object({
  entityType: z.literal("COMPANY_INVITE_LINK"), companyId: OrgIdSchema, status: z.enum(["live", "used", "withdrawn"]),
  expiresAt: z.number().int().positive(), createdAt: z.iso.datetime(), createdBy: z.union([z.literal("operator"), CompanyPersonId]),
  emailHash: z.string().regex(/^[a-f0-9]{64}$/),
  usedBy: CompanyPersonId.optional(), usedAt: z.iso.datetime().optional(),
}).strict();
type Member = z.infer<typeof CompanyMember>;
export const companyMemberKey = (companyId: string, personId: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "MEMBERS"), sk: `MEMBER#${CompanyPersonId.parse(personId)}` });
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
/** `viaPreapproval`: DEC 254b (f), this very call wrote the membership by consuming a live pre-approval (never an existing member, a legacy join or a lost race). */
/**
 * DEC 254zzz84 (5): what a removal with a hand-over fences inside the removal's own transaction: the role the remover saw (the target's snapshot CAS
 * then holds it), and the successor, who must be a live member of the same company (any role) at the moment the removal commits.
 */
export interface RemovalFence { expectedRole?: Member["role"]; successorId?: string }
export type CompanyJoin = { ok: true; membership: Member; viaPreapproval?: true } | { ok: false; reason: "not_invited" | "member_elsewhere" | "member_revoked" };
const refused = (): CompanyJoin => ({ ok: false, reason: "not_invited" });
const unavailable = () => new Error("company sign-in unavailable");
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** One bounded operation, using the host's existing request timeout. No detached I/O. */
export class CompanySignInStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}
  private iso() { return new Date(this.input.now()).toISOString(); }
  private seconds() { return Math.floor(this.input.now() / 1000); }
  async read(key: { pk: string; sk: string }): Promise<unknown> {
    const answer = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    if (answer.Item !== undefined && Buffer.byteLength(JSON.stringify(answer.Item)) > 409_600) throw unavailable();
    return answer.Item;
  }
  async companyExists(companyId: string): Promise<boolean> {
    if (!OrgIdSchema.safeParse(companyId).success) return false;
    if (companyId === IMPLICIT_COMPANY_ID) return true;
    const found = CompanyRecord.safeParse(await this.read(companyKey(companyId)));
    return found.success && found.data.companyId === companyId;
  }
  /**
   * DEC 254b (a): whether a company has a sign-in of its own. Any stored issuer row counts, even a disabled or unreadable one (fail closed: such a
   * company is never opened to the install's shared method). The built-in company never has one. A read error throws.
   */
  async hasOwnIssuer(companyId: string): Promise<boolean> {
    if (!OrgIdSchema.safeParse(companyId).success) throw unavailable();
    if (companyId === IMPLICIT_COMPANY_ID) return false;
    return await this.read(companyIssuerKey(companyId)) !== undefined;
  }
  async membership(personId: string): Promise<Member | undefined> {
    if (!CompanyPersonId.safeParse(personId).success) throw unavailable();
    const row = await this.read(membershipKey(personId));
    if (row === undefined) return undefined;
    const found = CompanyMember.safeParse(row);
    if (!found.success || found.data.personId !== personId) throw unavailable();
    return found.data;
  }
  private memberResult(member: Member, companyId: string): CompanyJoin {
    if (member.revokedAt !== undefined) return { ok: false, reason: "member_revoked" };
    if (member.companyId !== companyId) return { ok: false, reason: "member_elsewhere" };
    return { ok: true, membership: member };
  }
  /** A bounded retry only rereads the winning membership; it never consumes another invite. */
  async join(input: { personId: string; companyId: string; email?: string }): Promise<CompanyJoin> {
    if (!CompanyPersonId.safeParse(input.personId).success || !OrgIdSchema.safeParse(input.companyId).success) return refused();
    try {
      const existing = await this.membership(input.personId);
      if (existing !== undefined) return this.memberResult(existing, input.companyId);
      if (!await this.companyExists(input.companyId)) return refused();
      let legacy = false;
      if (input.companyId === IMPLICIT_COMPANY_ID) {
        const developer = z.object({ entityType: z.literal("DEVELOPER"), provider: z.enum(["slack", "oidc"]), issuer: z.string().min(1), subject: z.string().min(1), revoked: z.literal(false), firstSignInAt: z.iso.datetime(), companyless: z.unknown().optional() }).safeParse(await this.read({ pk: `DEVELOPER#${input.personId}`, sk: "META" }));
        // DEC 253z: a record first written by a sign-in with no company is never "legacy": that person joins only by invitation or their own company.
        legacy = developer.success && developer.data.companyless === undefined && ownerKeyForSubject(developer.data.issuer, developer.data.subject) === input.personId;
      }
      const key = input.email === undefined || !CompanyEmail.safeParse(input.email).success ? undefined : preapprovalKey(input.companyId, input.email);
      const approval = !legacy && key !== undefined ? CompanyPreapproval.safeParse(await this.read(key)) : undefined;
      if (!legacy && (!approval?.success || approval.data.status !== "live" || approval.data.expiresAt <= this.seconds())) return refused();
      const member: Member = { entityType: "COMPANY_MEMBERSHIP", personId: input.personId, companyId: input.companyId, role: legacy ? "member" : approval!.data!.role, joinedAt: this.iso(), joinedVia: legacy ? "legacy" : "preapproval" };
      const writes: Write[] = [{ Put: { TableName: this.input.tableName, Item: { ...membershipKey(input.personId), ...member }, ConditionExpression: "attribute_not_exists(pk)" } }, this.memberMirror(member)];
      if (!legacy) writes.push({ Update: { TableName: this.input.tableName, Key: key!,
        UpdateExpression: "SET #status = :used, usedBy = :person, usedAt = :at",
        ConditionExpression: "#status = :live AND expiresAt > :now AND expiresAt = :expires AND #role = :role AND createdAt = :created",
        ExpressionAttributeNames: { "#status": "status", "#role": "role" },
        ExpressionAttributeValues: { ":used": "used", ":person": input.personId, ":at": this.iso(), ":live": "live", ":now": this.seconds(), ":expires": approval!.data!.expiresAt, ":role": approval!.data!.role, ":created": approval!.data!.createdAt },
      } });
      try { await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
      catch (error) {
        if (!conditional(error)) return refused();
        const won = await this.membership(input.personId);
        return won === undefined ? refused() : this.memberResult(won, input.companyId);
      }
      return { ok: true, membership: member, ...(legacy ? {} : { viaPreapproval: true as const }) };
    } catch { return refused(); }
  }
  /**
   * DEC 254h: join by an invite link's secret, whatever the sign-in method and whether or not the identity has an email. The secret must be live,
   * unexpired and stored under exactly this company, and its pre-approval still live and the very one it was made with. One transaction writes
   * the membership and spends both, so exactly one person ever joins by one secret. Every failure is the one "not invited" answer; a person who
   * is already a member anywhere spends nothing. A live member of this very company is signed in as before whatever `invite=` says (the secret is
   * then neither checked nor spent, and the sign-in is not "joined by invite"): an admitted sign-in never means a secret was valid.
   */
  async joinByInvite(input: { personId: string; companyId: string; inviteHash: string }): Promise<CompanyJoin> {
    if (!CompanyPersonId.safeParse(input.personId).success || !OrgIdSchema.safeParse(input.companyId).success || !/^[a-f0-9]{64}$/.test(input.inviteHash)) return refused();
    try {
      const existing = await this.membership(input.personId);
      if (existing !== undefined) return this.memberResult(existing, input.companyId);
      if (!await this.companyExists(input.companyId)) return refused();
      const linkKey = inviteLinkKey(input.companyId, input.inviteHash);
      const stored = await this.read(linkKey) as Record<string, unknown> | undefined;
      const { pk: storedPk, sk: storedSk, ...fields } = stored ?? {};
      const link = storedPk === linkKey.pk && storedSk === linkKey.sk ? CompanyInviteLink.safeParse(fields) : undefined;
      if (link === undefined) return refused();
      if (!link.success || link.data.companyId !== input.companyId || link.data.status !== "live" || link.data.expiresAt <= this.seconds()) return refused();
      const approvalKey = preapprovalHashKey(input.companyId, link.data.emailHash);
      const approval = CompanyPreapproval.safeParse(await this.read(approvalKey));
      if (!approval.success || approval.data.status !== "live" || approval.data.expiresAt <= this.seconds() || approval.data.inviteHash !== input.inviteHash) return refused();
      const at = this.iso();
      const member: Member = { entityType: "COMPANY_MEMBERSHIP", personId: input.personId, companyId: input.companyId, role: approval.data.role, joinedAt: at, joinedVia: "preapproval" };
      const writes: Write[] = [
        { Put: { TableName: this.input.tableName, Item: { ...membershipKey(input.personId), ...member }, ConditionExpression: "attribute_not_exists(pk)" } },
        this.memberMirror(member),
        { Update: { TableName: this.input.tableName, Key: linkKey, UpdateExpression: "SET #status = :used, usedBy = :person, usedAt = :at",
          ConditionExpression: "#status = :live AND expiresAt > :now AND companyId = :company AND createdAt = :created",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":used": "used", ":person": input.personId, ":at": at, ":live": "live", ":now": this.seconds(), ":company": input.companyId, ":created": link.data.createdAt } } },
        { Update: { TableName: this.input.tableName, Key: approvalKey, UpdateExpression: "SET #status = :used, usedBy = :person, usedAt = :at",
          ConditionExpression: "#status = :live AND expiresAt > :now AND expiresAt = :expires AND #role = :role AND createdAt = :created AND inviteHash = :hash",
          ExpressionAttributeNames: { "#status": "status", "#role": "role" },
          ExpressionAttributeValues: { ":used": "used", ":person": input.personId, ":at": at, ":live": "live", ":now": this.seconds(), ":expires": approval.data.expiresAt, ":role": approval.data.role, ":created": approval.data.createdAt, ":hash": input.inviteHash } } },
      ];
      try { await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
      catch (error) {
        if (!conditional(error)) return refused();
        // A lost race spends nothing of this sign-in's: whoever won, only an existing membership can admit (and it never counts as this invite).
        const won = await this.membership(input.personId);
        return won === undefined ? refused() : this.memberResult(won, input.companyId);
      }
      return { ok: true, membership: member, viaPreapproval: true };
    } catch { return refused(); }
  }
  /** Every mutation and its durable log commit together. Logs contain only fixed events and opaque ids. */
  async operatorWrite(companyId: string, event: string, writes: Write[], personId?: string, memberAudit?: { createdBy: string; createdAt: string; fromRole: Member["role"]; toRole: Member["role"]; ownerOverride?: true; successorId?: string }): Promise<void> {
    // At most 5: a member write, its mirror, the actor's check, the last-owner witness and (DEC 254zzz84 (5)) a removal's successor.
    if (!OrgIdSchema.safeParse(companyId).success || !/^company-[a-z-]+$/.test(event) || writes.length > 5) throw unavailable();
    await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: [...writes, { Put: {
      TableName: this.input.tableName, Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${this.iso()}#${randomUUID()}`, entityType: "COMPANY_LOG", event, companyId, ...(personId === undefined ? {} : { personId }), ...memberAudit }, ConditionExpression: "attribute_not_exists(pk)",
    } }] }));
  }
  async create(companyId: string, name: string, email: string, hours: number): Promise<void> {
    const record = CompanyRecord.parse({ entityType: "COMPANY", companyId, name, status: "active", createdAt: this.iso(), createdBy: "operator" });
    const approval = this.approval("admin", hours, "operator");
    await this.operatorWrite(companyId, "company-create", [
      { Put: { TableName: this.input.tableName, Item: { ...companyKey(companyId), ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: this.input.tableName, Item: { ...preapprovalKey(companyId, email), ...approval }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
  }
  private approval(role: "admin" | "member", hours: number, createdBy: string) {
    return CompanyPreapproval.parse({ entityType: "COMPANY_PREAPPROVAL", role, status: "live", expiresAt: this.seconds() + CompanyExpiryHours.parse(hours) * 3600, createdAt: this.iso(), createdBy });
  }
  /**
   * A new pre-approval; its expiry (epoch seconds) is the answer. DEC 254h: with `inviteHash`, the SHA-256 of an invite link's secret is stored with
   * it in the same transaction, bound to this pre-approval (same expiry; ended with it). A hash already stored is refused, never overwritten.
   */
  async preapprove(companyId: string, email: string, role: "admin" | "member", hours: number, createdBy = "operator", inviteHash?: string): Promise<number> {
    if (!await this.companyExists(companyId)) throw unavailable();
    const key = preapprovalKey(companyId, email);
    const raw = await this.read(key);
    const previous = raw === undefined ? undefined : CompanyPreapproval.parse(raw);
    if (previous?.status === "live" && previous.expiresAt > this.seconds()) throw unavailable();
    const approval = CompanyPreapproval.parse({ ...this.approval(role, hours, createdBy), ...(inviteHash === undefined ? {} : { inviteHash }) });
    const link: Write[] = inviteHash === undefined ? [] : [{ Put: { TableName: this.input.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: { ...inviteLinkKey(companyId, inviteHash),
      ...CompanyInviteLink.parse({ entityType: "COMPANY_INVITE_LINK", companyId, status: "live", expiresAt: approval.expiresAt, createdAt: approval.createdAt, createdBy: approval.createdBy, emailHash: key.sk.slice(6) }) } } }];
    await this.operatorWrite(companyId, "company-preapprove", [...link, { Put: { TableName: this.input.tableName, Item: { ...key, ...approval },
      ...(previous === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : {
        ConditionExpression: "createdAt = :created AND expiresAt = :expires AND #status = :status AND #role = :role",
        ExpressionAttributeNames: { "#status": "status", "#role": "role" },
        ExpressionAttributeValues: { ":created": previous.createdAt, ":expires": previous.expiresAt, ":status": previous.status, ":role": previous.role },
      }),
    } }]);
    return approval.expiresAt;
  }
  async withdraw(companyId: string, hash: string, createdBy?: string): Promise<boolean> {
    const key = preapprovalHashKey(companyId, hash);
    const row = CompanyPreapproval.safeParse(await this.read(key));
    if (!row.success) return false;
    // DEC 254h: its invite link's row is marked too, in the same transaction (the join checks the pre-approval anyway; expired rows age out by TTL).
    const link: Write[] = row.data.inviteHash === undefined ? [] : [{ Update: { TableName: this.input.tableName, Key: inviteLinkKey(companyId, row.data.inviteHash),
      UpdateExpression: "SET #status = :withdrawn", ConditionExpression: "attribute_exists(pk) AND #status = :live", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":withdrawn": "withdrawn", ":live": "live" } } }];
    await this.operatorWrite(companyId, "company-preapproval-withdraw", [{ Update: {
      TableName: this.input.tableName, Key: key, UpdateExpression: "SET #status = :withdrawn", ConditionExpression: "attribute_exists(pk) AND createdAt = :at",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":withdrawn": "withdrawn", ":at": row.data.createdAt },
    } }, ...(row.data.status === "live" && row.data.expiresAt > this.seconds() ? link : [])], createdBy);
    return true;
  }
  async list(companyId: string): Promise<{ preapprovals: Array<z.infer<typeof CompanyPreapproval> & { emailHash: string }>; more: boolean }> {
    const started = this.input.now();
    const pk = companyScoped(OrgIdSchema.parse(companyId), "PREAPPROVAL");
    const answer = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: 100 })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
    if (!Array.isArray(answer.Items) || answer.Items.length > 100 || Buffer.byteLength(JSON.stringify(answer)) > 1_100_000 || this.input.now() - started > 10_000) throw unavailable();
    const preapprovals = answer.Items.map((item) => {
      const row = CompanyPreapproval.extend({ pk: z.literal(pk), sk: z.string().regex(/^EMAIL#[a-f0-9]{64}$/) }).safeParse(item);
      if (!row.success) throw unavailable();
      // The invite link's hash stays in the table: a list shows none of it.
      const shown: Partial<z.infer<typeof CompanyPreapproval>> & Omit<z.infer<typeof CompanyPreapproval>, "inviteHash"> = CompanyPreapproval.parse(row.data);
      delete shown.inviteHash;
      return { ...shown, emailHash: row.data.sk.slice(6) };
    });
    return { preapprovals, more: answer.LastEvaluatedKey !== undefined };
  }
  memberMirror(member: Member): Write {
    return { Put: { TableName: this.input.tableName, Item: { ...member, ...companyMemberKey(member.companyId, member.personId), entityType: "COMPANY_MEMBER_VIEW" } } };
  }
  /** Stable snapshot CAS protects role, revocation and mirror contents against concurrent writers. */
  private memberSnapshot(member: Member) {
    const names: Record<string, string> = {}, values: Record<string, unknown> = {};
    const fields = ["entityType", "personId", "companyId", "role", "joinedAt", "joinedVia", "revokedAt", "revokedBy", "updatedAt", "updatedBy"] as const;
    const conditions = fields.map((field, i) => {
      const name = `#m${i}`, value = `:m${i}`;
      names[name] = field;
      if (member[field] === undefined) return `attribute_not_exists(${name})`;
      values[value] = member[field]; return `${name} = ${value}`;
    });
    return { ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  }
  private liveMemberCheck(companyId: string, personId: string, owner: boolean | "any"): Write {
    const roles = owner === "any" ? "(#role = :owner OR #role = :admin OR #role = :member)" : owner ? "#role = :owner" : "(#role = :owner OR #role = :admin)";
    return { ConditionCheck: { TableName: this.input.tableName, Key: membershipKey(personId),
      ConditionExpression: "#entity = :entity AND companyId = :company AND personId = :person AND attribute_not_exists(revokedAt) AND " + roles,
      ExpressionAttributeNames: { "#entity": "entityType", "#role": "role" },
      ExpressionAttributeValues: { ":entity": "COMPANY_MEMBERSHIP", ":company": companyId, ":person": personId, ":owner": "owner", ...(owner === true ? {} : { ":admin": "admin" }), ...(owner === "any" ? { ":member": "member" } : {}) },
    } };
  }
  private async checkActor(companyId: string, createdBy: string | undefined, owner = false): Promise<void> {
    // Omission is reserved for direct operator invokes; the broker pins a live actor.
    if (createdBy === undefined) return;
    const actor = await this.membership(createdBy);
    if (owner && actor?.role !== "owner") throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_ONLY_OWNER });
    if (actor === undefined || actor.companyId !== companyId || actor.revokedAt !== undefined || (actor.role !== "admin" && actor.role !== "owner")) throw unavailable();
  }
  private async writeMember(previous: Member, next: Member, event: string, createdBy?: string, fence: RemovalFence = {}): Promise<void> {
    // A self-actor's target snapshot must itself still be authorized. The earlier
    // actor read alone can race with this read; the snapshot CAS then fences it.
    if (createdBy === previous.personId && (previous.revokedAt !== undefined || (previous.role !== "admin" && previous.role !== "owner"))) throw unavailable();
    const ownerChange = (previous.role === "owner" && (next.role !== "owner" || next.revokedAt !== undefined)) || (previous.role !== "owner" && next.role === "owner");
    if (ownerChange) await this.checkActor(previous.companyId, createdBy, true);
    // The target snapshot CAS includes its current role in this same transaction.
    // A concurrent promotion cannot turn a plain-member write into an elevated write.
    // DEC 254zzz84 (5): the role the remover saw; the target snapshot CAS below holds it to the commit.
    if (fence.expectedRole !== undefined && fence.expectedRole !== previous.role) throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_CHANGED });
    if (fence.successorId !== undefined) {
      const successor = fence.successorId === previous.personId ? undefined : await this.membership(fence.successorId).catch(() => undefined);
      if (successor === undefined || successor.companyId !== previous.companyId || successor.revokedAt !== undefined) throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_SUCCESSOR_INVALID });
    }
    let witness: string | undefined;
    if (previous.role === "owner" && previous.revokedAt === undefined && (next.role !== "owner" || next.revokedAt !== undefined)) {
      // The mirror only locates a candidate; the transaction checks the authoritative row.
      // Search the company mirror under one total read budget, including filter-short pages.
      const page = await this.memberPage(previous.companyId, undefined, 100, previous.personId);
      witness = page.members.find((member) => member.personId !== previous.personId && member.role === "owner" && member.revokedAt === undefined)?.personId;
      if (witness === undefined && page.more) throw unavailable();
      if (witness === undefined) throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_LAST_OWNER });
    }
    const writes: Write[] = [
      { Put: { TableName: this.input.tableName, Item: { ...membershipKey(next.personId), ...next }, ...this.memberSnapshot(previous) } },
      this.memberMirror(next),
    ];
    // DynamoDB forbids two actions on one item. A self-actor is checked by the target
    // snapshot CAS; an actor who is also the owner witness uses the stronger owner check.
    if (createdBy !== undefined && createdBy !== previous.personId && createdBy !== witness) writes.push(this.liveMemberCheck(previous.companyId, createdBy, ownerChange));
    const witnessIndex = writes.length;
    if (witness !== undefined) writes.push(this.liveMemberCheck(previous.companyId, witness, true));
    // The successor is live (any role) at the commit. The actor and an owner witness are already checked live with a stronger role, and DynamoDB forbids two steps on one item.
    const successorIndex = writes.length;
    const successorChecked = fence.successorId !== undefined && fence.successorId !== createdBy && fence.successorId !== witness;
    if (successorChecked) writes.push(this.liveMemberCheck(previous.companyId, fence.successorId!, "any"));
    try {
      await this.operatorWrite(previous.companyId, event, writes, previous.personId, { createdBy: createdBy ?? "operator", createdAt: this.iso(), fromRole: previous.role, toRole: next.role,
        ...(ownerChange && createdBy === undefined ? { ownerOverride: true } : {}), ...(fence.successorId === undefined ? {} : { successorId: fence.successorId }) });
    } catch (error) {
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | null)?.CancellationReasons;
      if (witness !== undefined && conditional(error) && reasons?.[witnessIndex]?.Code === "ConditionalCheckFailed") throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_LAST_OWNER });
      if (successorChecked && conditional(error) && reasons?.[successorIndex]?.Code === "ConditionalCheckFailed") throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_SUCCESSOR_INVALID });
      // The target's snapshot (index 0) moved: with an expected role, that is "the person changed", in fixed words.
      if (fence.expectedRole !== undefined && conditional(error) && reasons?.[0]?.Code === "ConditionalCheckFailed") throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_CHANGED });
      throw unavailable();
    }
  }
  async setRevoked(companyId: string, personId: string, revoked: boolean, createdBy?: string, fence: RemovalFence = {}): Promise<boolean> {
    if (!OrgIdSchema.safeParse(companyId).success || typeof revoked !== "boolean") throw unavailable();
    // A fence belongs to a removal only (a restore names no successor).
    if (!revoked && (fence.expectedRole !== undefined || fence.successorId !== undefined)) throw unavailable();
    await this.checkActor(companyId, createdBy);
    const member = await this.membership(personId);
    if (member === undefined || member.companyId !== companyId) return false;
    // DEC 254zzz84 (5): a fenced removal never ends a membership that has already ended (a second removal racing the first refuses, it does not re-stamp it).
    if (revoked && (fence.expectedRole !== undefined || fence.successorId !== undefined) && member.revokedAt !== undefined) throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_REVOKED });
    const next = { ...member };
    if (revoked) { next.revokedAt = this.iso(); next.revokedBy = createdBy ?? "operator"; }
    else { delete next.revokedAt; delete next.revokedBy; }
    await this.writeMember(member, next, revoked ? "company-member-revoke" : "company-member-restore", createdBy, fence);
    return true;
  }
  async setRole(companyId: string, personId: string, role: Member["role"], createdBy?: string): Promise<"changed" | "unchanged" | "not_found"> {
    if (!OrgIdSchema.safeParse(companyId).success || !OrgRoleSchema.safeParse(role).success) throw unavailable();
    await this.checkActor(companyId, createdBy);
    const member = await this.membership(personId);
    if (member === undefined || member.companyId !== companyId) return "not_found";
    if (member.revokedAt !== undefined) throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_REVOKED });
    if (member.role === role) return "unchanged";
    await this.writeMember(member, { ...member, role, updatedAt: this.iso(), updatedBy: createdBy ?? "operator" }, "company-member-role-set", createdBy);
    return "changed";
  }
  /** One total budget, strong reads, no filter assumptions. The host owns the SDK timeout. */
  async listMembers(companyId: string, cursor?: string, limit?: number): Promise<{ members: Member[]; more: boolean; cursor?: string }> {
    return this.memberPage(companyId, cursor, limit);
  }
  private async memberPage(companyId: string, cursor?: string, limit?: number, ownerExcept?: string): Promise<{ members: Member[]; more: boolean; cursor?: string }> {
    const parsed = MemberListInput.safeParse({ companyId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) });
    if (!parsed.success) throw new CompanyMemberRefusal({ ok: false, error: "invalid_request" });
    const size = parsed.data.limit ?? 100, started = this.input.now();
    let after = cursor === undefined ? undefined : memberCursorPerson(companyId, cursor);
    let bytes = 0, evaluated = 0;
    const members: Member[] = [];
    const pk = companyScoped(companyId, "MEMBERS");
    const Row = CompanyMember.extend({ entityType: z.literal("COMPANY_MEMBER_VIEW"), pk: z.literal(pk), sk: z.string().regex(/^MEMBER#[a-f0-9]{64}$/) });
    const Key = z.object({ pk: z.literal(pk), sk: z.string().regex(/^MEMBER#[a-f0-9]{64}$/) }).strict();
    for (let queries = 0; queries < 32; queries++) {
      if (this.input.now() - started > 10_000) throw unavailable();
      const remaining = Math.min(size - members.length, 1_000 - evaluated);
      const answer = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName,
        KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk, ...(ownerExcept === undefined ? {} : { ":owner": "owner", ":except": ownerExcept }) }, ConsistentRead: true, Limit: remaining,
        ...(ownerExcept === undefined ? {} : { FilterExpression: "#role = :owner AND attribute_not_exists(revokedAt) AND personId <> :except", ExpressionAttributeNames: { "#role": "role" } }),
        ...(after === undefined ? {} : { ExclusiveStartKey: companyMemberKey(companyId, after) }),
      })) as { Items?: unknown[]; LastEvaluatedKey?: unknown; ScannedCount?: number };
      bytes += Buffer.byteLength(JSON.stringify(answer));
      if (!Array.isArray(answer.Items) || answer.Items.length > remaining || bytes > 1_100_000 || this.input.now() - started > 10_000) throw unavailable();
      const scanned = answer.ScannedCount ?? remaining;
      if (!Number.isInteger(scanned) || scanned < answer.Items.length || scanned > remaining || scanned < 0) throw unavailable();
      evaluated += Math.max(1, scanned);
      let last = after;
      for (const item of answer.Items) {
        const row = Row.safeParse(item);
        if (!row.success || row.data.companyId !== companyId || row.data.sk !== `MEMBER#${row.data.personId}` || (last !== undefined && row.data.personId <= last)) throw unavailable();
        members.push(CompanyMember.parse({ ...row.data, entityType: "COMPANY_MEMBERSHIP" }));
        last = row.data.personId;
      }
      if (answer.LastEvaluatedKey === undefined) return { members, more: false };
      const key = Key.safeParse(answer.LastEvaluatedKey);
      if (!key.success) throw unavailable();
      const next = key.data.sk.slice(7);
      if ((after !== undefined && next <= after) || (last !== undefined && next < last)) throw unavailable();
      after = next;
      if (members.length === size || (ownerExcept !== undefined && members.length > 0) || evaluated >= 1_000 || queries === 31) return { members, more: true, cursor: memberCursor(companyId, after) };
    }
    throw unavailable();
  }
  async setIssuer(companyId: string, settings: unknown): Promise<void> {
    if (companyId === IMPLICIT_COMPANY_ID) throw unavailable();
    if (!await this.companyExists(companyId)) throw unavailable();
    const parsed = CompanyIssuerSettings.parse(settings);
    if (parsed.requiredValues.length > 0 && parsed.requiredClaim === undefined) throw unavailable();
    const record = CompanyIssuerRecord.parse({ ...parsed, entityType: "COMPANY_SIGNIN_ISSUER", enabledSince: this.input.now() / 1000 });
    await this.operatorWrite(companyId, "company-issuer-set", [{ Put: { TableName: this.input.tableName, Item: { ...companyIssuerKey(companyId), ...record } } }]);
  }
}
