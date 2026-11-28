// #1612: the install's own company. Every install has exactly one, named by one setting row in the sign-in table, so a fresh install is not left in the built-in company (which the
// core refuses). `ensure` is idempotent: the first call makes the company (or adopts one an operator already moved the install into, #1300), every later call answers the same one.
// The first owner is named only by the hash of their email, which the install's own sign-in reads when that person first signs in. Only fixed outcomes and opaque ids are logged.
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
import { CompanyEmail, CompanyRecord, companyKey, generateCompanyId, type CompanySignInStore } from "./company-membership.js";
import { emailIndexKey } from "./store.js";

export const INSTALL_COMPANY_KEY = { pk: "INSTALL_COMPANY", sk: "SETTING" } as const;

const NamedCompanyId = OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID, "the install's company is a named company");
const EmailHash = z.string().regex(/^[a-f0-9]{64}$/);

export const InstallCompanyRecord = z.object({
  entityType: z.literal("INSTALL_COMPANY"),
  companyId: NamedCompanyId,
  /** "created": this install made it; "adopted": an operator had already moved the install into it. */
  via: z.enum(["created", "adopted"]),
  setAt: z.iso.datetime(),
  /** The SHA-256 of the first owner's email, as the email index keys it. Absent: no owner was named (an adopted company already has one). */
  ownerEmailHash: EmailHash.optional(),
}).strict();
export type InstallCompanyRecord = z.infer<typeof InstallCompanyRecord>;

export const InstallCompanyName = z.string().trim().min(1).max(80);

export interface EnsureInstallCompanyInput {
  /** The new company's name; unused when the install already has one or adopts one. */
  name: string;
  /** The first owner's email; stored only as its hash. */
  ownerEmail?: string;
  /** A named company the install was already moved into (its Slack workspace is bound to it): adopted instead of making a new one. */
  adoptCompanyId?: string;
}

export type EnsureInstallCompanyResult = { companyId: string; outcome: "existing" | "adopted" | "created" };

const failed = () => new Error("install company unavailable");
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const ownerHash = (email: string | undefined) => email === undefined ? undefined : emailIndexKey(CompanyEmail.parse(email)).pk.slice(6);

export class InstallCompanyStore {
  constructor(private readonly input: { company: CompanySignInStore; tableName: string; now: () => number; newCompanyId?: () => string }) {}

  /** The install's company setting, or undefined before one is made. A row that does not read is a failure (fail closed), never "none". */
  async read(): Promise<InstallCompanyRecord | undefined> {
    const row = await this.input.company.read(INSTALL_COMPANY_KEY) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const { pk, sk, ...fields } = row;
    const parsed = InstallCompanyRecord.safeParse(fields);
    if (pk !== INSTALL_COMPANY_KEY.pk || sk !== INSTALL_COMPANY_KEY.sk || !parsed.success) throw failed();
    return parsed.data;
  }

  /** The install's company id, or undefined before one is made. */
  async companyId(): Promise<string | undefined> {
    return (await this.read())?.companyId;
  }

  async ensure(input: EnsureInstallCompanyInput): Promise<EnsureInstallCompanyResult> {
    const name = InstallCompanyName.parse(input.name);
    const emailHash = ownerHash(input.ownerEmail);
    const adopt = input.adoptCompanyId === undefined ? undefined : NamedCompanyId.parse(input.adoptCompanyId);
    const existing = await this.read();
    if (existing !== undefined) return await this.existing(existing, emailHash);
    try {
      return adopt === undefined ? await this.create(name, emailHash) : await this.adopt(adopt);
    } catch (error) {
      // Another ensure won the race: answer the company it set.
      if (!conditional(error)) throw error;
      const won = await this.read();
      if (won === undefined) throw failed();
      return { companyId: won.companyId, outcome: "existing" };
    }
  }

  /** An install that already has its company: names the first owner if none was named yet (an install made before the owner was known), else changes nothing. */
  private async existing(record: InstallCompanyRecord, emailHash: string | undefined): Promise<EnsureInstallCompanyResult> {
    if (emailHash !== undefined && record.ownerEmailHash === undefined && record.via === "created") {
      try {
        await this.input.company.operatorWrite(record.companyId, "company-install-owner", [{ Update: {
          TableName: this.input.tableName, Key: INSTALL_COMPANY_KEY, UpdateExpression: "SET ownerEmailHash = :hash",
          ConditionExpression: "attribute_exists(pk) AND companyId = :company AND attribute_not_exists(ownerEmailHash)",
          ExpressionAttributeValues: { ":hash": emailHash, ":company": record.companyId },
        } }]);
      } catch (error) { if (!conditional(error)) throw error; }
    }
    return { companyId: record.companyId, outcome: "existing" };
  }

  private async adopt(companyId: string): Promise<EnsureInstallCompanyResult> {
    if (!await this.input.company.companyExists(companyId)) throw failed();
    const record = InstallCompanyRecord.parse({ entityType: "INSTALL_COMPANY", companyId, via: "adopted", setAt: this.iso() });
    await this.input.company.operatorWrite(companyId, "company-install-adopt", [
      { ConditionCheck: { TableName: this.input.tableName, Key: companyKey(companyId), ConditionExpression: "attribute_exists(pk) AND companyId = :company", ExpressionAttributeValues: { ":company": companyId } } },
      { Put: { TableName: this.input.tableName, Item: { ...INSTALL_COMPANY_KEY, ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
    return { companyId, outcome: "adopted" };
  }

  private async create(name: string, emailHash: string | undefined): Promise<EnsureInstallCompanyResult> {
    const companyId = this.input.newCompanyId?.() ?? generateCompanyId();
    const at = this.iso();
    const company = CompanyRecord.parse({ entityType: "COMPANY", companyId, name, status: "active", createdAt: at, createdBy: "operator" });
    const record = InstallCompanyRecord.parse({ entityType: "INSTALL_COMPANY", companyId, via: "created", setAt: at, ...(emailHash === undefined ? {} : { ownerEmailHash: emailHash }) });
    // One transaction: the company, the setting that names it and the log. A second ensure racing this one fails on the setting and answers the winner's company, leaving no stray company.
    await this.input.company.operatorWrite(companyId, "company-install-create", [
      { Put: { TableName: this.input.tableName, Item: { ...companyKey(companyId), ...company }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: this.input.tableName, Item: { ...INSTALL_COMPANY_KEY, ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
    return { companyId, outcome: "created" };
  }

  private iso() { return new Date(this.input.now()).toISOString(); }
}
