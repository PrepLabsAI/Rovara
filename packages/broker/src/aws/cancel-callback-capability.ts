import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { agentXError, deriveCancelCallbackKey } from "@agentx/contracts";

const CancelCallbackClaimsSchema = z.object({
  version: z.literal(1),
  purpose: z.literal("cancel-result"),
  workspaceId: z.uuid(),
  operationId: z.uuid(),
  targetOperationId: z.uuid(),
  fence: z.number().int().positive().safe(),
  actions: z.tuple([z.literal("result")]),
  expiresAt: z.number().int().safe(),
}).strict();

export const cancelCallbackForbidden = () => agentXError("CALLBACK_FORBIDDEN", "invalid cancel callback capability");

/** Buffer's base64url decoder is permissive; capability encodings must be canonical. */
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw cancelCallbackForbidden();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw cancelCallbackForbidden();
  return bytes;
}

/** Authenticates only cancel-result authority. The broker separately binds it to stored state. */
export function verifyCancelCallbackCapability(root: string, token: string, action: string) {
  if (token.length > 8192 || action !== "result") throw cancelCallbackForbidden();
  const [prefix, body, signature, extra] = token.split(".");
  if (prefix !== "cancel-v1" || !body || !signature || extra !== undefined) throw cancelCallbackForbidden();
  const actual = decode(signature);
  const expected = createHmac("sha256", deriveCancelCallbackKey(root)).update(`cancel-v1.${body}`).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw cancelCallbackForbidden();
  const bytes = decode(body);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw cancelCallbackForbidden();
  }
  const parsed = CancelCallbackClaimsSchema.safeParse(value);
  const now = Math.floor(Date.now() / 1000);
  if (!parsed.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + 32400) {
    throw cancelCallbackForbidden();
  }
  return parsed.data;
}
