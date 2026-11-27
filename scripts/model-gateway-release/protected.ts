// Protected-resource change-set check for Code's model gateway deploy step (#1578).
import { fileURLToPath } from "node:url";
import type { ChangeRow, ChangeSetRecord } from "./types.js";

export const PROTECTED_PATH = fileURLToPath(new URL("./protected.json", import.meta.url));
const METADATA_TYPE = "AWS::CDK::Metadata";

export interface ImageRowRule {
  resourceType: string;
  logicalIdPattern: string;
}

export interface ProtectedList {
  schema: 1;
  parts: Record<string, Record<string, string>>;
  statefulTypes: string[];
  dataRewrites: Record<string, string[]>;
  imageRows: ImageRowRule[];
  imageOnlyCodePaths: string[];
}

export interface ProtectedResult {
  failures: string[];
  notes: string[];
  checkedRows: number;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");

function validateParts(parts: unknown): Record<string, Record<string, string>> {
  if (typeof parts !== "object" || parts === null || Array.isArray(parts)) throw new Error("protected.json: parts must be an object");
  const record = parts as Record<string, unknown>;
  const gateway = record.gateway;
  if (typeof gateway !== "object" || gateway === null || Object.keys(gateway).length === 0) {
    throw new Error("protected.json: parts.gateway must list its protected resources");
  }
  for (const [part, ids] of Object.entries(record)) {
    for (const [id, type] of Object.entries(ids as Record<string, unknown>)) {
      if (typeof type !== "string" || !/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/u.test(type)) {
        throw new Error(`protected.json: parts.${part}.${id} must name a resource type`);
      }
    }
  }
  return record as Record<string, Record<string, string>>;
}

function validateDataRewrites(rewrites: unknown): Record<string, string[]> {
  if (typeof rewrites !== "object" || rewrites === null || Array.isArray(rewrites)) {
    throw new Error("protected.json: dataRewrites must be an object of resource type -> property names");
  }
  for (const [type, names] of Object.entries(rewrites as Record<string, unknown>)) {
    if (!isStringList(names)) throw new Error(`protected.json: dataRewrites.${type} must be a non-empty list of property names`);
  }
  return rewrites as Record<string, string[]>;
}

function validateImageRows(rows: unknown): ImageRowRule[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("protected.json: imageRows must be a non-empty list");
  for (const rule of rows as Array<{ resourceType?: unknown; logicalIdPattern?: unknown }>) {
    if (typeof rule.resourceType !== "string" || typeof rule.logicalIdPattern !== "string") {
      throw new Error("protected.json: each image row needs resourceType and logicalIdPattern");
    }
    new RegExp(rule.logicalIdPattern, "u");
  }
  return rows as ImageRowRule[];
}

export function parseProtected(raw: string): ProtectedList {
  let file: Partial<ProtectedList>;
  try { file = JSON.parse(raw) as Partial<ProtectedList>; } catch (error) {
    throw new Error(`protected.json is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (file.schema !== 1) throw new Error("protected.json: schema must be 1");
  const parts = validateParts(file.parts);
  if (!isStringList(file.statefulTypes)) throw new Error("protected.json: statefulTypes must be a non-empty list");
  if (!isStringList(file.imageOnlyCodePaths)) throw new Error("protected.json: imageOnlyCodePaths must be a non-empty list");
  const dataRewrites = validateDataRewrites(file.dataRewrites);
  const imageRows = validateImageRows(file.imageRows);
  return { schema: 1, parts, statefulTypes: file.statefulTypes, dataRewrites, imageRows, imageOnlyCodePaths: file.imageOnlyCodePaths };
}

export function isReplacement(row: ChangeRow): boolean {
  return row.replacement === "True" || row.replacement === "Conditional";
}

function isImageRow(list: ProtectedList, row: ChangeRow): boolean {
  return row.action === "Modify"
    && list.imageRows.some((rule) => rule.resourceType === row.resourceType && new RegExp(rule.logicalIdPattern, "u").test(row.logicalId));
}

function checkProtectedRow(
  list: ProtectedList,
  listed: Record<string, string>,
  stateful: ReadonlySet<string>,
  row: ChangeRow,
  where: string,
): string[] {
  const failures: string[] = [];
  const isListed = Object.hasOwn(listed, row.logicalId);
  const isStateful = stateful.has(row.resourceType);
  if (!isListed && !isStateful) return failures;
  const why = isListed ? "on the protected list" : `a ${row.resourceType} (stateful type)`;
  if (row.action === "Remove") failures.push(`${where} would be removed; it is ${why}`);
  else if (row.action === "Dynamic") failures.push(`${where} has a Dynamic change; it is ${why}`);
  else if (isReplacement(row)) failures.push(`${where} would be replaced (Replacement=${row.replacement}); it is ${why}`);
  const rewrites = list.dataRewrites[row.resourceType];
  if (rewrites !== undefined && row.action === "Modify" && !isReplacement(row)) {
    failures.push(...checkDataRewrites(row, rewrites, where, why));
  }
  if (isListed && listed[row.logicalId] !== row.resourceType) {
    failures.push(`${where} is listed with the type ${listed[row.logicalId]}: the list and the template disagree`);
  }
  return failures;
}

function checkDataRewrites(row: ChangeRow, rewrites: readonly string[], where: string, why: string): string[] {
  if (row.changedProperties === undefined) {
    return [`${where}: the change set gave no property details, so an in-place data rewrite cannot be ruled out (failing closed); it is ${why}`];
  }
  const failures: string[] = [];
  for (const name of row.changedProperties) {
    if (name.startsWith("Properties:") && rewrites.includes(name.slice("Properties:".length))) {
      failures.push(`${where} changes ${name.slice("Properties:".length)} in place, which rewrites or drops its data; it is ${why}`);
    }
  }
  return failures;
}

export function checkProtected(list: ProtectedList, record: ChangeSetRecord, options: { imageOnly: boolean }): ProtectedResult {
  const failures: string[] = [];
  const notes: string[] = [];
  let checkedRows = 0;
  const stateful = new Set(list.statefulTypes);
  const listed = list.parts[record.part] ?? {};
  for (const row of record.rows) {
    checkedRows += 1;
    if (row.resourceType === METADATA_TYPE) continue;
    const where = `${record.part}/${row.logicalId} (${row.resourceType})`;
    failures.push(...checkProtectedRow(list, listed, stateful, row, where));
    if (options.imageOnly && !isImageRow(list, row)) {
      failures.push(`${where}: ${row.action} is not one of the image rows, but the gateway infra is unchanged (image-only change)`);
    }
  }
  if (options.imageOnly) notes.push("gateway: image-only change, rows limited to the known image rows");
  return { failures, notes, checkedRows };
}
