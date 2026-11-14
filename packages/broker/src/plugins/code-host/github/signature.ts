// P6: GitHub's webhook signature check, in one place. The old webhook route (`aws/github-webhooks.ts`) and the neutral normaliser both call this one function, so the
// check cannot drift between them. It runs before anything of the body is read.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Validates GitHub's X-Hub-Signature-256 over the unchanged UTF-8 request body. */
export function verifyGithubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;
  const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
