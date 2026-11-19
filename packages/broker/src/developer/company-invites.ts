// DEC 254a: operator invite codes, the self-serve switch, and DEC 253z's self-serve company create. Sign-in table only;
// the sign-in Lambda makes every write here. A code is stored only as its SHA-256 (the CLI makes the code and sends the
// hash); no row, answer or log line ever holds the code. Every write commits with its audit row in one transaction.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { CompanySelfServeNameSchema, CompanyInviteCodeHashSchema, CompanyInviteCodeIdSchema, CompanyInviteExpiryHoursSchema, OrgIdSchema, companyInviteCodeId, companyScoped, type CompanyInviteList, type CompanyInviteView } from "@agentx/contracts";
import { membershipKey } from "../aws/company-check.js";
import { CompanyPersonId, CompanyRecord, companyKey, generateCompanyId, type CompanySignInStore } from "./company-membership.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
/** One partition for every code, so the operator's list is one bounded query. */
export const INVITE_CODES_PK = "COMPANY_INVITE_CODES";
export const companyInviteKey = (codeHash: string) => ({ pk: INVITE_CODES_PK, sk: `CODE#${CompanyInviteCodeHashSchema.parse(codeHash)}` });
/** The install-level audit partition: one row per create, revoke, use and switch change. */
export const INVITE_LOG_PK = "COMPANY_INVITE_LOG";
/** The operator's self-serve switch. Absent: open (DEC 253z, self-serve now). */
export const SELF_SERVE_KEY = { pk: "COMPANY_SELF_SERVE", sk: "SETTING" } as const;
/** Per-person tries at self-serve create, per clock hour. `expiresAt` is the sign-in table's TTL attribute. */
export const selfCreateRateKey = (personId: string, hour: number) => ({ pk: `COMPANY_SELF_CREATE_RATE#${CompanyPersonId.parse(personId)}`, sk: `HOUR#${z.number().int().nonnegative().parse(hour)}` });
/** Tries per person per hour, counted before any code is read. The broker's request adapter exposes no source IP, so there is no per-IP counter. */
export const SELF_CREATE_TRIES_PER_HOUR = 5;

const Actor = z.union([z.literal("operator"), CompanyPersonId]);
export const CompanyInviteRecord = z.object({
  entityType: z.literal("COMPANY_INVITE_CODE"), status: z.enum(["live", "used", "revoked"]),
  expiresAt: z.number().int().positive(), createdAt: z.iso.datetime(), createdBy: Actor,
  usedBy: CompanyPersonId.optional(), usedAt: z.iso.datetime().optional(), companyId: OrgIdSchema.optional(),
  revokedAt: z.iso.datetime().optional(), revokedBy: Actor.optional(),
}).strict();
type InviteRecord = z.infer<typeof CompanyInviteRecord>;
const SelfServeRecord = z.object({ entityType: z.literal("COMPANY_SELF_SERVE_SETTING"), open: z.boolean(), updatedAt: z.iso.datetime(), updatedBy: Actor }).strict();

export type SelfCreateResult = { ok: true; companyId: string; companyName: string } | { ok: false; error: "refused" | "already_member" | "rate_limited" | "unavailable" };
const unavailable = () => new Error("company invites unavailable");
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const strip = (item: unknown, key: { pk: string; sk: string }): unknown => {
  if (item === null || typeof item !== "object") return item;
  const { pk, sk, ...rest } = item as Record<string, unknown>;
  return pk === key.pk && sk === key.sk ? rest : undefined;
};

export class CompanyInviteStore {
  /**
   * `selfServeAllowed`: the CompanySelfServe stack switch (COMPANY_SELF_SERVE, DEC 254zg (a)), always given. False: every create is the uniform refusal, whatever the stored
   * setting says, so self-serve stays closed while company sign-in is on until the operator enables it too.
   */
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number; company: CompanySignInStore; selfServeAllowed: boolean; newCompanyId?: () => string }) {}
  private iso() { return new Date(this.input.now()).toISOString(); }
  private seconds() { return Math.floor(this.input.now() / 1000); }
  private async get(key: { pk: string; sk: string }): Promise<unknown> {
    const answer = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    if (answer.Item !== undefined && Buffer.byteLength(JSON.stringify(answer.Item)) > 409_600) throw unavailable();
    return answer.Item;
  }
  private audit(event: "company-invite-create" | "company-invite-revoke" | "company-invite-use" | "company-self-serve-set", fields: { codeId?: string; createdBy: string; companyId?: string; personId?: string; open?: boolean }): Write {
    return { Put: { TableName: this.input.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: INVITE_LOG_PK, sk: `${this.iso()}#${randomUUID()}`, entityType: "COMPANY_INVITE_LOG", event, at: this.iso(), ...fields } } };
  }
  private async commit(writes: Write[]): Promise<void> {
    await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
  }

  /** A new live code, stored by hash. A hash already stored (a repeat or a clash) is refused, never overwritten. */
  async create(codeHash: string, hours: number, createdBy: string = "operator"): Promise<string> {
    const hash = CompanyInviteCodeHashSchema.parse(codeHash);
    const record: InviteRecord = CompanyInviteRecord.parse({ entityType: "COMPANY_INVITE_CODE", status: "live", expiresAt: this.seconds() + CompanyInviteExpiryHoursSchema.parse(hours) * 3600, createdAt: this.iso(), createdBy: Actor.parse(createdBy) });
    const codeId = companyInviteCodeId(hash);
    await this.commit([
      { Put: { TableName: this.input.tableName, Item: { ...companyInviteKey(hash), ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
      this.audit("company-invite-create", { codeId, createdBy: record.createdBy }),
    ]);
    return codeId;
  }

  /** At most 100 codes, in hash order; each shows only its id, status and times. Any unreadable row refuses the whole list. */
  async list(): Promise<CompanyInviteList> {
    const started = this.input.now();
    const answer = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": INVITE_CODES_PK }, ConsistentRead: true, Limit: 100 })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
    if (!Array.isArray(answer.Items) || answer.Items.length > 100 || Buffer.byteLength(JSON.stringify(answer)) > 1_100_000 || this.input.now() - started > 10_000) throw unavailable();
    const now = this.seconds();
    const invites = answer.Items.map((item): CompanyInviteView => {
      const sk = (item as { sk?: unknown } | null)?.sk;
      const hash = typeof sk === "string" ? /^CODE#([a-f0-9]{64})$/.exec(sk)?.[1] : undefined;
      if (hash === undefined) throw unavailable();
      const row = CompanyInviteRecord.safeParse(strip(item, companyInviteKey(hash)));
      if (!row.success) throw unavailable();
      const status = row.data.status === "live" && row.data.expiresAt <= now ? "expired" : row.data.status;
      return { codeId: companyInviteCodeId(hash), status, expiresAt: new Date(row.data.expiresAt * 1000).toISOString(), createdAt: row.data.createdAt,
        ...(row.data.usedAt === undefined ? {} : { usedAt: row.data.usedAt }), ...(row.data.revokedAt === undefined ? {} : { revokedAt: row.data.revokedAt }) };
    });
    return { invites, more: answer.LastEvaluatedKey !== undefined, selfServe: await this.selfServeOpen() ? "open" : "closed" };
  }

  /** Revokes one live code by its id. Not found: no code has that id, or it is no longer live (used or revoked). */
  async revoke(codeId: string, createdBy: string = "operator"): Promise<boolean> {
    const id = CompanyInviteCodeIdSchema.parse(codeId);
    const answer = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :id)",
      ExpressionAttributeValues: { ":pk": INVITE_CODES_PK, ":id": `CODE#${id}` }, ConsistentRead: true, Limit: 2 })) as { Items?: unknown[] };
    if (!Array.isArray(answer.Items) || answer.Items.length !== 1) return false;
    const hash = /^CODE#([a-f0-9]{64})$/.exec(String((answer.Items[0] as { sk?: unknown }).sk))?.[1];
    if (hash === undefined) return false;
    const row = CompanyInviteRecord.safeParse(strip(answer.Items[0], companyInviteKey(hash)));
    if (!row.success || row.data.status !== "live") return false;
    try {
      await this.commit([
        { Update: { TableName: this.input.tableName, Key: companyInviteKey(hash), UpdateExpression: "SET #status = :revoked, revokedAt = :at, revokedBy = :by",
          ConditionExpression: "#status = :live AND createdAt = :created", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "revoked", ":at": this.iso(), ":by": Actor.parse(createdBy), ":live": "live", ":created": row.data.createdAt } } },
        this.audit("company-invite-revoke", { codeId: id, createdBy }),
      ]);
    } catch (error) { if (conditional(error)) return false; throw error; }
    return true;
  }

  /** The operator's switch. Closed: every create is the uniform refusal. */
  async setSelfServe(open: boolean, createdBy: string = "operator"): Promise<void> {
    const record = SelfServeRecord.parse({ entityType: "COMPANY_SELF_SERVE_SETTING", open, updatedAt: this.iso(), updatedBy: createdBy });
    await this.commit([{ Put: { TableName: this.input.tableName, Item: { ...SELF_SERVE_KEY, ...record } } }, this.audit("company-self-serve-set", { createdBy, open })]);
  }
  /** The stack switch off: closed, with nothing read. Absent: open. Unreadable: closed (fail closed). */
  async selfServeOpen(): Promise<boolean> {
    if (this.input.selfServeAllowed !== true) return false;
    const item = await this.get(SELF_SERVE_KEY);
    if (item === undefined) return true;
    const parsed = SelfServeRecord.safeParse(strip(item, SELF_SERVE_KEY));
    return parsed.success && parsed.data.open;
  }

  /**
   * DEC 253z: may this person hold a session with no company? Only with no membership row at all (a removed member keeps theirs), and
   * no sign-in record from before (a legacy person joins the built-in company) unless it is one this path wrote, and never one that now points at a person
   * (DEC 254zzz39: a kept unlinked sign-in linked again). Any doubt: no.
   */
  async companylessEligible(personId: string): Promise<boolean> {
    try {
      if (!CompanyPersonId.safeParse(personId).success) return false;
      if (await this.get(membershipKey(personId)) !== undefined) return false;
      const developer = await this.get({ pk: `DEVELOPER#${personId}`, sk: "META" }) as Record<string, unknown> | undefined;
      return developer === undefined || (developer.entityType === "DEVELOPER" && developer.revoked === false && developer.companyless === true && developer.mergedInto === undefined);
    } catch { return false; }
  }

  /** Counted before any code is read, so guessing is throttled. A conditional increment: the sixth try in an hour fails. */
  private async countTry(personId: string): Promise<boolean> {
    const hour = Math.floor(this.seconds() / 3600);
    try {
      await this.input.documentClient.send(new UpdateCommand({ TableName: this.input.tableName, Key: selfCreateRateKey(personId, hour),
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity, expiresAt = :ttl",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit", ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":entity": "COMPANY_SELF_CREATE_RATE", ":ttl": (hour + 2) * 3600, ":limit": SELF_CREATE_TRIES_PER_HOUR } }));
      return true;
    } catch (error) { if (conditional(error)) return false; throw error; }
  }

  /**
   * One person makes their own company with one live code (DEC 253z, 254a). The same reads happen for every code problem, and every code
   * problem (and a closed switch) gets one answer. One transaction spends the code, writes the company, the owner membership and its
   * mirror, the company log and the invite audit row, so a code makes exactly one company and a person gets exactly one.
   */
  async selfCreate(input: { personId: string; name: string; codeHash: string }): Promise<SelfCreateResult> {
    const parsed = z.object({ personId: CompanyPersonId, name: CompanySelfServeNameSchema, codeHash: CompanyInviteCodeHashSchema }).strict().safeParse(input);
    if (!parsed.success) return { ok: false, error: "unavailable" };
    const { personId, name, codeHash } = parsed.data;
    try {
      if (!await this.countTry(personId)) return { ok: false, error: "rate_limited" };
      const [member, open, raw] = await Promise.all([this.get(membershipKey(personId)), this.selfServeOpen(), this.get(companyInviteKey(codeHash))]);
      if (member !== undefined) return { ok: false, error: "already_member" };
      const code = CompanyInviteRecord.safeParse(strip(raw, companyInviteKey(codeHash)));
      if (!open || !code.success || code.data.status !== "live" || code.data.expiresAt <= this.seconds()) return { ok: false, error: "refused" };
      const companyId = OrgIdSchema.parse(this.input.newCompanyId?.() ?? generateCompanyId());
      const at = this.iso();
      const company = CompanyRecord.parse({ entityType: "COMPANY", companyId, name, status: "active", createdAt: at, createdBy: "self-serve", selfServedBy: personId });
      const membership = { entityType: "COMPANY_MEMBERSHIP" as const, personId, companyId, role: "owner" as const, joinedAt: at, joinedVia: "self-serve" as const };
      const codeId = companyInviteCodeId(codeHash);
      const writes: Write[] = [
        { Update: { TableName: this.input.tableName, Key: companyInviteKey(codeHash), UpdateExpression: "SET #status = :used, usedBy = :person, usedAt = :at, companyId = :company",
          ConditionExpression: "#status = :live AND expiresAt > :now AND expiresAt = :expires AND createdAt = :created", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":used": "used", ":person": personId, ":at": at, ":company": companyId, ":live": "live", ":now": this.seconds(), ":expires": code.data.expiresAt, ":created": code.data.createdAt } } },
        { Put: { TableName: this.input.tableName, Item: { ...companyKey(companyId), ...company }, ConditionExpression: "attribute_not_exists(pk)" } },
        // One company per person (DEC 253z): the membership row is the person's, whatever company.
        { Put: { TableName: this.input.tableName, Item: { ...membershipKey(personId), ...membership }, ConditionExpression: "attribute_not_exists(pk)" } },
        this.input.company.memberMirror(membership),
        { Put: { TableName: this.input.tableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${at}#${randomUUID()}`, entityType: "COMPANY_LOG", event: "company-self-create", companyId, personId } } },
        this.audit("company-invite-use", { codeId, createdBy: personId, companyId, personId }),
        // The switch is checked again inside the transaction: closing it races no create.
        { ConditionCheck: { TableName: this.input.tableName, Key: SELF_SERVE_KEY, ConditionExpression: "attribute_not_exists(pk) OR #open = :true", ExpressionAttributeNames: { "#open": "open" }, ExpressionAttributeValues: { ":true": true } } },
      ];
      try { await this.commit(writes); }
      catch (error) {
        // Only a failed condition is an answer about the code or the person; a conflict or anything else is "try again" (503), never the code refusal.
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | null)?.CancellationReasons;
        if (!conditional(error) || (Array.isArray(reasons) && reasons.some((reason) => reason?.Code !== undefined && reason.Code !== "None" && reason.Code !== "ConditionalCheckFailed"))) throw error;
        // A lost race: whoever won, this person either has a company now or the code is spent.
        return await this.get(membershipKey(personId)) !== undefined ? { ok: false, error: "already_member" } : { ok: false, error: "refused" };
      }
      return { ok: true, companyId, companyName: company.name };
    } catch { return { ok: false, error: "unavailable" }; }
  }
}
