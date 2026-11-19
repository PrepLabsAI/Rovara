// L9: share the notifier's State reader; the broker still owns the company-scoped relay.
import { companyOfKey } from "@agentx/contracts";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { CompanyRunReport } from "../core-host/jobs.js";

export interface StreamBatchResponse { batchItemFailures: Array<{ itemIdentifier: string }> }
type RecordShape = { eventSource?: unknown; eventName?: unknown; dynamodb?: { SequenceNumber?: unknown; NewImage?: Record<string, { S?: unknown }> } };

export function outboxCompanyOf(record: unknown): string | undefined {
  const entry = record as RecordShape | null;
  if (entry?.eventSource !== "aws:dynamodb" || entry.eventName !== "INSERT") return undefined;
  const image = entry.dynamodb?.NewImage;
  return image?.outboxState !== undefined && typeof image.pk?.S === "string" ? companyOfKey(image.pk.S) : undefined;
}

/** Only State INSERTs with an outbox marker and a valid company-scoped key. */
export function outboxCompaniesOf(event: unknown): string[] | undefined {
  const records = (event as { Records?: unknown } | null)?.Records;
  if (!Array.isArray(records) || records.length === 0 || !records.every((record: RecordShape | null) => record?.eventSource === "aws:dynamodb")) return undefined;
  return [...new Set(records.map(outboxCompanyOf).filter((company): company is string => company !== undefined))];
}

/** Lambda's stream retry identifiers are sequence numbers, never event IDs. */
export function streamFailures(records: readonly unknown[]): StreamBatchResponse["batchItemFailures"] {
  return records.map((record) => {
    const sequence = (record as RecordShape | null)?.dynamodb?.SequenceNumber;
    if (typeof sequence !== "string" || !/^\d{1,128}$/u.test(sequence)) throw new Error("invalid stream sequence");
    return { itemIdentifier: sequence };
  });
}

export async function relayCoreOutboxStream(event: unknown, relay: (companies: readonly string[]) => Promise<CompanyRunReport[]>): Promise<StreamBatchResponse | undefined> {
  const companies = outboxCompaniesOf(event);
  if (companies === undefined) return undefined;
  const records = (event as { Records: unknown[] }).Records;
  let failed: Set<string>;
  try {
    const reports = await relay(companies);
    failed = new Set(reports.filter((report) => report.outcome !== "ran" || (typeof report.report?.failed === "number" && report.report.failed > 0)).map((report) => report.companyId));
  } catch {
    failed = new Set(companies);
  }
  return { batchItemFailures: streamFailures(records.filter((record) => {
    const company = outboxCompanyOf(record);
    return company !== undefined && failed.has(company);
  })) };
}

const batchResponse = z.object({ batchItemFailures: z.array(z.object({ itemIdentifier: z.string().regex(/^\d{1,128}$/u) }).strict()).max(100) }).strict();

/** One synchronous call, one payload bound and one abort budget for the complete batch. */
export async function invokeCoreOutbox(client: Pick<LambdaClient, "send">, functionName: string, records: unknown[], remainingMs = 30_000): Promise<StreamBatchResponse> {
  try {
    if (records.length > 100 || records.some((record) => outboxCompanyOf(record) === undefined)) throw new Error();
    const sequences = new Set(streamFailures(records).map(({ itemIdentifier }) => itemIdentifier));
    const payload = Buffer.from(JSON.stringify({ Records: records }));
    if (payload.byteLength > 6 * 1024 * 1024) throw new Error();
    const response = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: payload }), {
      abortSignal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remainingMs - 2_000))),
    });
    if (response.StatusCode !== 200 || response.FunctionError !== undefined || response.Payload === undefined || response.Payload.byteLength > 64_000) throw new Error();
    // The broker's internal invocation answers through its existing HTTP-shaped envelope.
    const envelope = z.object({ statusCode: z.literal(200), body: z.string() }).passthrough().parse(JSON.parse(Buffer.from(response.Payload).toString("utf8")));
    const result = batchResponse.extend({ requestId: z.literal("core-engine").optional() }).parse(JSON.parse(envelope.body));
    if (result.batchItemFailures.some(({ itemIdentifier }) => !sequences.has(itemIdentifier))) throw new Error();
    return { batchItemFailures: result.batchItemFailures };
  } catch {
    throw new Error("core outbox relay unavailable");
  }
}
