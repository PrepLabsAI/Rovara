// ONE rule for "could this inbound header carry a credential?", shared by the gateway side (inject.ts: every inbound credential is dropped before the one real credential is added) and the model helper inside the sandbox
// (`@agentx/contracts/model-helper`: credential headers are dropped before a backend sees a call). It lives in a module of its own with no imports so the helper's narrow entry can reach it without the egress code
// (BEDROCK-HELPER-CREDENTIAL-RULE-ONE-SOURCE: two copies had drifted, one missing x-authorization and x-amzn-bedrock-authorization, the other amz-sdk-*).

/** Header names that carry a credential, exactly. */
const CREDENTIAL_NAMES = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key", "x-goog-user-project", "cookie", "cookie2"]);

/** A header name as a lenient reader would compare it: whitespace, control characters and colons gone, lower case. A name with a fold (`authorization\r\n x`) reads as `authorization`. */
export function normalizeHeaderName(name: string): string {
  let kept = "";
  for (const character of name.replace(/[\s:]/gu, "")) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) kept += character;
  }
  return kept.toLowerCase();
}

/**
 * Whether an inbound header could carry a credential: a known credential header, `proxy-*`, any `x-amz-*` or `amz-sdk-*` (AWS signing and SDK headers), or any name that mentions authorization, an api key or a cookie (which covers
 * `x-authorization` and `x-amzn-bedrock-authorization`). Over-broad on purpose: a false positive drops a header nobody needs.
 */
export function isInboundCredentialHeader(name: string): boolean {
  const normal = normalizeHeaderName(name);
  return CREDENTIAL_NAMES.has(normal) || normal.startsWith("proxy-") || normal.startsWith("x-amz-") || normal.startsWith("amz-sdk-") || normal.includes("authorization") || normal.includes("api-key") || normal.includes("apikey") || normal.includes("cookie");
}
