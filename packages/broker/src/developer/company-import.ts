// DEC 254b (b): the sign-in Lambda's side of an operator's company import (and its undo). Its writes run only in the sign-in Lambda's server; the broker
// imports only the event and reply schemas, to check what it forwards (aws/company-import-forwarding.ts).
// The broker reads the install's old company layout and Code's records, and plans exactly which rows to write or delete (aws/install-company-import.ts);
// this store only writes them, every row conditional, in bounded transactions, each with its company-log row. It never reads the State table, and it
// accepts the import event with Code's company layer on or off: the import must run BEFORE that layer is switched on, and every row it writes stays
// unread until then.
//
// Import: the company record (createdBy "import", importedAt) and, per person, the membership COMPANY_MEMBER#<person>/COMPANY and its member mirror,
// marked joinedVia "import", importedAt and importedRole. Every Put is attribute_not_exists, so it never overwrites anything.
// Undo: deletes exactly the rows an import wrote, each conditional on being unchanged since the import (the same values, and none of the fields a
// product write adds). A product write through the member helper rewrites the row without importedAt, so an undo never matches it.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { COMPANY_IMPORT_MEMBERS_MAX, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../aws/company-check.js";
import { CompanyPersonId, CompanyRecord, companyKey, companyMemberKey } from "./company-membership.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
/** People per transaction: two rows each, plus the company record and the log row, well inside DynamoDB's 100 actions. */
export const COMPANY_IMPORT_BATCH = 40;

const Company = OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID);
const uniquePeople = (members: Array<{ personId: string }>) => new Set(members.map((member) => member.personId)).size === members.length;
const ImportMember = z.object({ personId: CompanyPersonId, role: OrgRoleSchema, joinedAt: z.iso.datetime().optional() }).strict();
const UndoMember = z.object({ personId: CompanyPersonId, role: OrgRoleSchema, joinedAt: z.iso.datetime(), importedAt: z.iso.datetime() }).strict();
export const CompanyImportEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-import"), companyId: Company, name: z.string().trim().min(1).max(80), writeCompany: z.boolean(),
    members: z.array(ImportMember).max(COMPANY_IMPORT_MEMBERS_MAX).refine(uniquePeople), createdBy: CompanyPersonId }).strict(),
  z.object({ kind: z.literal("company-import-undo"), companyId: Company, members: z.array(UndoMember).max(COMPANY_IMPORT_MEMBERS_MAX).refine(uniquePeople),
    company: z.object({ name: z.string().min(1).max(80), createdAt: z.iso.datetime(), importedAt: z.iso.datetime() }).strict().optional(), createdBy: CompanyPersonId }).strict(),
]);
export type CompanyImportEventInput = z.infer<typeof CompanyImportEvent>;
export const CompanyImportReply = z.union([
  z.object({ ok: z.literal(true), rows: z.number().int().min(0), company: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["invalid_request", "unavailable"]) }).strict(),
  // A row changed under the run: the transactions before it stand (`rows` people), the rest were not written. Preview again; undo removes what an import wrote.
  z.object({ ok: z.literal(false), error: z.literal("conflict"), rows: z.number().int().min(0) }).strict(),
]);
export type CompanyImportReplyValue = z.infer<typeof CompanyImportReply>;

const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += COMPANY_IMPORT_BATCH) out.push(items.slice(at, at + COMPANY_IMPORT_BATCH));
  return out;
};

/** The fields an import's membership and mirror rows carry, besides their keys and entity type. */
function importedFields(companyId: string, member: { personId: string; role: z.infer<typeof OrgRoleSchema>; joinedAt: string }, importedAt: string) {
  return { personId: member.personId, companyId, role: member.role, joinedAt: member.joinedAt, joinedVia: "import" as const, importedAt, importedRole: member.role };
}

/** Undo's condition: the row holds exactly what the import wrote, and none of the fields a removal or role change adds. */
function unchangedSinceImport(entityType: string, fields: ReturnType<typeof importedFields>) {
  const names: Record<string, string> = { "#e": "entityType", "#role": "role" };
  const values: Record<string, unknown> = { ":e": entityType, ":p": fields.personId, ":c": fields.companyId, ":role": fields.role, ":j": fields.joinedAt, ":via": "import", ":at": fields.importedAt };
  return {
    ConditionExpression: "#e = :e AND personId = :p AND companyId = :c AND #role = :role AND importedRole = :role AND joinedAt = :j AND joinedVia = :via AND importedAt = :at"
      + " AND attribute_not_exists(revokedAt) AND attribute_not_exists(revokedBy) AND attribute_not_exists(updatedAt) AND attribute_not_exists(updatedBy)",
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  };
}

export class CompanyImportStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  private log(companyId: string, event: "company-import" | "company-import-undo", at: string, createdBy: string, people: string[], company: boolean): Write {
    // Ids only: the company, the operator and the people in this batch.
    return { Put: { TableName: this.input.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
      pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${at}#${randomUUID()}`, entityType: "COMPANY_LOG", event, companyId, createdBy, people, ...(company ? { companyRecord: true } : {}),
    } } };
  }

  /** Runs the batches in order; the first conditional failure stops the run and says how many people's rows stand. */
  private async run(batches: Array<{ writes: Write[]; people: number; company: boolean }>): Promise<CompanyImportReplyValue> {
    let rows = 0, company = false;
    for (const batch of batches) {
      try { await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: batch.writes })); }
      catch (error) {
        if (conditional(error)) return { ok: false, error: "conflict", rows };
        throw error;
      }
      rows += batch.people;
      company ||= batch.company;
    }
    return { ok: true, rows, company };
  }

  async importCompany(input: Extract<CompanyImportEventInput, { kind: "company-import" }>): Promise<CompanyImportReplyValue> {
    // Re-running after a success: nothing to write, and no log row.
    if (!input.writeCompany && input.members.length === 0) return { ok: true, rows: 0, company: false };
    const importedAt = new Date(this.input.now()).toISOString();
    const { tableName } = this.input;
    const companyWrite: Write | undefined = input.writeCompany ? { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
      ...companyKey(input.companyId),
      ...CompanyRecord.parse({ entityType: "COMPANY", companyId: input.companyId, name: input.name, status: "active", createdAt: importedAt, createdBy: "import", importedAt }),
    } } } : undefined;
    const groups = input.members.length === 0 ? [[]] : chunks(input.members);
    return this.run(groups.map((group, index) => {
      const withCompany = index === 0 && companyWrite !== undefined;
      const writes: Write[] = withCompany ? [companyWrite] : [];
      for (const member of group) {
        const fields = importedFields(input.companyId, { ...member, joinedAt: member.joinedAt ?? importedAt }, importedAt);
        writes.push(
          { Put: { TableName: tableName, Item: { ...membershipKey(member.personId), entityType: "COMPANY_MEMBERSHIP", ...fields }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: tableName, Item: { ...companyMemberKey(input.companyId, member.personId), entityType: "COMPANY_MEMBER_VIEW", ...fields }, ConditionExpression: "attribute_not_exists(pk)" } },
        );
      }
      writes.push(this.log(input.companyId, "company-import", importedAt, input.createdBy, group.map((member) => member.personId), withCompany));
      return { writes, people: group.length, company: withCompany };
    }));
  }

  async undoImport(input: Extract<CompanyImportEventInput, { kind: "company-import-undo" }>): Promise<CompanyImportReplyValue> {
    if (input.company === undefined && input.members.length === 0) return { ok: true, rows: 0, company: false };
    const at = new Date(this.input.now()).toISOString();
    const { tableName } = this.input;
    // The company record goes last, in the final batch, only if every member batch before it held.
    const companyDelete: Write | undefined = input.company === undefined ? undefined : { Delete: { TableName: tableName, Key: companyKey(input.companyId),
      ConditionExpression: "#e = :e AND companyId = :c AND #name = :name AND #status = :active AND createdAt = :created AND createdBy = :import AND importedAt = :at"
        + " AND attribute_not_exists(selfServedBy)",
      ExpressionAttributeNames: { "#e": "entityType", "#name": "name", "#status": "status" },
      ExpressionAttributeValues: { ":e": "COMPANY", ":c": input.companyId, ":name": input.company.name, ":active": "active", ":created": input.company.createdAt, ":import": "import", ":at": input.company.importedAt },
    } };
    const groups = input.members.length === 0 ? [[]] : chunks(input.members);
    return this.run(groups.map((group, index) => {
      const writes: Write[] = [];
      for (const member of group) {
        const fields = importedFields(input.companyId, member, member.importedAt);
        writes.push(
          { Delete: { TableName: tableName, Key: membershipKey(member.personId), ...unchangedSinceImport("COMPANY_MEMBERSHIP", fields) } },
          { Delete: { TableName: tableName, Key: companyMemberKey(input.companyId, member.personId), ...unchangedSinceImport("COMPANY_MEMBER_VIEW", fields) } },
        );
      }
      const withCompany = index === groups.length - 1 && companyDelete !== undefined;
      if (withCompany) writes.push(companyDelete);
      writes.push(this.log(input.companyId, "company-import-undo", at, input.createdBy, group.map((member) => member.personId), withCompany));
      return { writes, people: group.length, company: withCompany };
    }));
  }
}

/** The sign-in Lambda's dispatch for the two import events. Fixed outcomes and opaque ids in its log, never a name. */
export async function companyImportOperator(deps: { store: CompanyImportStore; log: (entry: Record<string, unknown>) => void }, event: unknown): Promise<CompanyImportReplyValue> {
  const parsed = CompanyImportEvent.safeParse(event);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const input = parsed.data;
  try {
    const reply = input.kind === "company-import" ? await deps.store.importCompany(input) : await deps.store.undoImport(input);
    deps.log({ event: input.kind, companyId: input.companyId, ...(reply.ok ? { rows: reply.rows, companyRecord: reply.company } : { refused: reply.error }) });
    return reply;
  } catch {
    deps.log({ event: input.kind, companyId: input.companyId, refused: "unavailable" });
    return { ok: false, error: "unavailable" };
  }
}
