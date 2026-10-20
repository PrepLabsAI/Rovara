import { createHash } from "node:crypto";
import type { E2EWorkflowAdmissionRef } from "@agentx/contracts";
import { readObjectText } from "../developer/plan-artifacts.js";

/**
 * How the dispatcher learns what kind of admission a CHECKS reference names: it reads the stored object, holds it to the reference's size and sha256, and answers its
 * `schemaVersion`. Anything it cannot establish (missing, changed, not JSON, no string schemaVersion) answers undefined, which the dispatcher treats as a refusal to deliver.
 */
export function createWorkflowE2EAdmissionSchemaReader(input: { s3: { send(command: never): Promise<unknown> }; bucket: string }) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<string | undefined> => {
    const { key, sha256, byteLength } = reference.admissionRef;
    const text = await readObjectText(input.s3, input.bucket, key, byteLength);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    try {
      const schemaVersion = (JSON.parse(text) as { schemaVersion?: unknown } | null)?.schemaVersion;
      return typeof schemaVersion === "string" ? schemaVersion : undefined;
    } catch { return undefined; }
  };
}
