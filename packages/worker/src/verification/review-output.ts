import { Buffer } from "node:buffer";
import { redactText } from "@agentx/contracts";

const REVIEW_RESPONSE_MAX_BYTES = 20_000;

export function parseWorkflowReviewerResponse(value: string): { status: "PASS" | "FINDINGS" | "UNKNOWN"; findings: string[]; failureReason?: "RESPONSE_TOO_LARGE" | "INVALID_JSON" | "INVALID_SHAPE" } {
  if (Buffer.byteLength(value, "utf8") > REVIEW_RESPONSE_MAX_BYTES) return { status: "UNKNOWN", findings: [], failureReason: "RESPONSE_TOO_LARGE" };
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return { status: "UNKNOWN", findings: [], failureReason: "INVALID_JSON" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" };
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.findings) || record.findings.length > 50
    || record.findings.some((finding) => typeof finding !== "string" || finding.trim().length === 0 || finding.trim().length > 1000)) {
    return { status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" };
  }
  const findings = record.findings.map((finding) => redactText((finding as string).trim()));
  return { status: findings.length === 0 ? "PASS" : "FINDINGS", findings };
}
