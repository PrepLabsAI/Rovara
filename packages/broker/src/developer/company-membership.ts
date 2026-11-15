// Sign-in-table membership, preapprovals and operator writes. No token claim is authority.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, companyScoped } from "@agentx/contracts";
import { Membership, membershipKey } from "../aws/company-check.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { emailIndexKey } from "./store.js";
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
type Member = z.infer<typeof Membership>;
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
    const found = Membership.safeParse(row);
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
      const writes: Write[] = [{ Put: { TableName: this.input.tableName, Item: { ...membershipKey(input.personId), ...member }, ConditionExpression: "attribute_not_exists(pk)" } }];
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
  async operatorWrite(companyId: string, event: string, writes: Write[], personId?: string): Promise<void> {
    if (!OrgIdSchema.safeParse(companyId).success || !/^company-[a-z-]+$/.test(event) || writes.length > 3) throw unavailable();
    await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: [...writes, { Put: {
      TableName: this.input.tableName, Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${this.iso()}#${randomUUID()}`, entityType: "COMPANY_LOG", event, companyId, ...(personId === undefined ? {} : { personId }) }, ConditionExpression: "attribute_not_exists(pk)",
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
  async setRevoked(companyId: string, personId: string, revoked: boolean): Promise<boolean> {
    const member = await this.membership(personId);
    if (member === undefined || member.companyId !== companyId) return false;
    await this.operatorWrite(companyId, revoked ? "company-member-revoke" : "company-member-restore", [{ Update: {
      TableName: this.input.tableName, Key: membershipKey(personId),
      UpdateExpression: revoked ? "SET revokedAt = :at, revokedBy = :operator" : "REMOVE revokedAt, revokedBy",
      ConditionExpression: "companyId = :company AND personId = :person",
      ExpressionAttributeValues: { ":company": companyId, ":person": personId, ...(revoked ? { ":at": this.iso(), ":operator": "operator" } : {}) },
    } }], personId);
    return true;
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
