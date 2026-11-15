// Sign-in-table membership, preapprovals and operator writes. No token claim is authority.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../aws/company-check.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { emailIndexKey } from "./store.js";
import { CompanyMember, CompanyMemberRefusal, MemberListInput, MEMBER_LAST_OWNER, MEMBER_REVOKED, MEMBER_STEP_UP, memberCursor, memberCursorPerson } from "./company-member-contract.js";
import { CompanyIssuerRecord, CompanyIssuerSettings, companyIssuerKey } from "./company-issuer.js";

export const CompanyPersonId = z.string().regex(/^[a-f0-9]{64}$/);
export const CompanyEmail = z.string().trim().min(3).max(320).email();
export const CompanyExpiryHours = z.number().int().min(1).max(720);
export const CompanyRecord = z.object({ entityType: z.literal("COMPANY"), companyId: OrgIdSchema, name: z.string().min(1).max(80), status: z.literal("active"), createdAt: z.iso.datetime(), createdBy: z.literal("operator") });
export const CompanyPreapproval = z.object({
  entityType: z.literal("COMPANY_PREAPPROVAL"), role: z.enum(["admin", "member"]), status: z.enum(["live", "used", "withdrawn"]),
  expiresAt: z.number().int().positive(), createdAt: z.iso.datetime(), createdBy: z.union([z.literal("operator"), CompanyPersonId]),
  usedBy: CompanyPersonId.optional(), usedAt: z.iso.datetime().optional(),
});
export const companyKey = (companyId: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "COMPANY"), sk: "META" });
export const preapprovalKey = (companyId: string, email: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "PREAPPROVAL"), sk: emailIndexKey(CompanyEmail.parse(email)).pk });
export const preapprovalHashKey = (companyId: string, hash: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "PREAPPROVAL"), sk: `EMAIL#${z.string().regex(/^[a-f0-9]{64}$/).parse(hash)}` });
type Member = z.infer<typeof CompanyMember>;
export const companyMemberKey = (companyId: string, personId: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "MEMBERS"), sk: `MEMBER#${CompanyPersonId.parse(personId)}` });
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
export type CompanyJoin = { ok: true; membership: Member } | { ok: false; reason: "not_invited" | "member_elsewhere" | "member_revoked" };
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
        const developer = z.object({ entityType: z.literal("DEVELOPER"), provider: z.enum(["slack", "oidc"]), issuer: z.string().min(1), subject: z.string().min(1), revoked: z.literal(false), firstSignInAt: z.iso.datetime() }).safeParse(await this.read({ pk: `DEVELOPER#${input.personId}`, sk: "META" }));
        legacy = developer.success && ownerKeyForSubject(developer.data.issuer, developer.data.subject) === input.personId;
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
      return { ok: true, membership: member };
    } catch { return refused(); }
  }
  /** Every mutation and its durable log commit together. Logs contain only fixed events and opaque ids. */
  async operatorWrite(companyId: string, event: string, writes: Write[], personId?: string, memberAudit?: { createdBy: string; createdAt: string; fromRole: Member["role"]; toRole: Member["role"] }): Promise<void> {
    if (!OrgIdSchema.safeParse(companyId).success || !/^company-[a-z-]+$/.test(event) || writes.length > 4) throw unavailable();
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
  async preapprove(companyId: string, email: string, role: "admin" | "member", hours: number, createdBy = "operator"): Promise<void> {
    if (!await this.companyExists(companyId)) throw unavailable();
    const key = preapprovalKey(companyId, email);
    const raw = await this.read(key);
    const previous = raw === undefined ? undefined : CompanyPreapproval.parse(raw);
    if (previous?.status === "live" && previous.expiresAt > this.seconds()) throw unavailable();
    await this.operatorWrite(companyId, "company-preapprove", [{ Put: { TableName: this.input.tableName, Item: { ...key, ...this.approval(role, hours, createdBy) },
      ...(previous === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : {
        ConditionExpression: "createdAt = :created AND expiresAt = :expires AND #status = :status AND #role = :role",
        ExpressionAttributeNames: { "#status": "status", "#role": "role" },
        ExpressionAttributeValues: { ":created": previous.createdAt, ":expires": previous.expiresAt, ":status": previous.status, ":role": previous.role },
      }),
    } }]);
  }
  async withdraw(companyId: string, hash: string, createdBy?: string): Promise<boolean> {
    const key = preapprovalHashKey(companyId, hash);
    const row = CompanyPreapproval.safeParse(await this.read(key));
    if (!row.success) return false;
    await this.operatorWrite(companyId, "company-preapproval-withdraw", [{ Update: {
      TableName: this.input.tableName, Key: key, UpdateExpression: "SET #status = :withdrawn", ConditionExpression: "attribute_exists(pk) AND createdAt = :at",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":withdrawn": "withdrawn", ":at": row.data.createdAt },
    } }], createdBy);
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
      return { ...CompanyPreapproval.parse(row.data), emailHash: row.data.sk.slice(6) };
    });
    return { preapprovals, more: answer.LastEvaluatedKey !== undefined };
  }
  private memberMirror(member: Member): Write {
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
  private liveMemberCheck(companyId: string, personId: string, owner: boolean): Write {
    return { ConditionCheck: { TableName: this.input.tableName, Key: membershipKey(personId),
      ConditionExpression: "#entity = :entity AND companyId = :company AND personId = :person AND attribute_not_exists(revokedAt) AND " + (owner ? "#role = :owner" : "(#role = :owner OR #role = :admin)"),
      ExpressionAttributeNames: { "#entity": "entityType", "#role": "role" },
      ExpressionAttributeValues: { ":entity": "COMPANY_MEMBERSHIP", ":company": companyId, ":person": personId, ":owner": "owner", ...(owner ? {} : { ":admin": "admin" }) },
    } };
  }
  private async checkActor(companyId: string, createdBy: string | undefined): Promise<void> {
    if (createdBy === undefined) return;
    const actor = await this.membership(createdBy);
    if (actor === undefined || actor.companyId !== companyId || actor.revokedAt !== undefined || (actor.role !== "admin" && actor.role !== "owner")) throw unavailable();
  }
  /** #660 plugs its fresh auth_time verification into this single fail-closed seam. */
  private requireMemberStepUp(role: Member["role"]): void {
    if (role === "admin" || role === "owner") throw new CompanyMemberRefusal({ ok: false, error: "step_up_required", message: MEMBER_STEP_UP });
  }
  private async writeMember(previous: Member, next: Member, event: string, createdBy?: string): Promise<void> {
    // A self-actor's target snapshot must itself still be authorized. The earlier
    // actor read alone can race with this read; the snapshot CAS then fences it.
    if (createdBy === previous.personId && (previous.revokedAt !== undefined || (previous.role !== "admin" && previous.role !== "owner"))) throw unavailable();
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
    if (createdBy !== undefined && createdBy !== previous.personId && createdBy !== witness) writes.push(this.liveMemberCheck(previous.companyId, createdBy, false));
    const witnessIndex = writes.length;
    if (witness !== undefined) writes.push(this.liveMemberCheck(previous.companyId, witness, true));
    try {
      await this.operatorWrite(previous.companyId, event, writes, previous.personId, { createdBy: createdBy ?? "operator", createdAt: this.iso(), fromRole: previous.role, toRole: next.role });
    } catch (error) {
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | null)?.CancellationReasons;
      if (witness !== undefined && conditional(error) && reasons?.[witnessIndex]?.Code === "ConditionalCheckFailed") throw new CompanyMemberRefusal({ ok: false, error: "unavailable", message: MEMBER_LAST_OWNER });
      throw unavailable();
    }
  }
  async setRevoked(companyId: string, personId: string, revoked: boolean, createdBy?: string): Promise<boolean> {
    if (!OrgIdSchema.safeParse(companyId).success || typeof revoked !== "boolean") throw unavailable();
    await this.checkActor(companyId, createdBy);
    const member = await this.membership(personId);
    if (member === undefined || member.companyId !== companyId) return false;
    const next = { ...member };
    if (revoked) { next.revokedAt = this.iso(); next.revokedBy = createdBy ?? "operator"; }
    else { delete next.revokedAt; delete next.revokedBy; }
    await this.writeMember(member, next, revoked ? "company-member-revoke" : "company-member-restore", createdBy);
    return true;
  }
  async setRole(companyId: string, personId: string, role: Member["role"], createdBy?: string): Promise<"changed" | "unchanged" | "not_found"> {
    if (!OrgIdSchema.safeParse(companyId).success || !OrgRoleSchema.safeParse(role).success) throw unavailable();
    await this.checkActor(companyId, createdBy);
    this.requireMemberStepUp(role);
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
