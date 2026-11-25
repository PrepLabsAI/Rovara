// IAM rules the gateway's infrastructure lane must apply to product keys (F1-d L2, F1e L9). No infra lives in this package;
// these are the statements and names the CDK stack imports, plus the wildcard evaluator its tests (and ours) use. The live
// IAM simulation against the deployed boundaries is a staging row (DEFERRED PRODUCT-KEYS-IAM-SIM).
import { PRODUCT_KEY_PURPOSE } from "./product-seal.js";

/**
 * The name the infra lane gives the gateway's serving role (today CDK generates one, infra/lib/model-gateway.ts ServeTaskRole).
 * Chosen to match no wildcard in any boundary or STS statement (F1e L9 lesson).
 */
export const PRODUCT_RUNTIME_ROLE_NAME = "rovara-gw-serve";
/**
 * F1-d L2: no operator or install role may decrypt product keys. Attached to every non-gateway role (and as an explicit Deny
 * in the boundary): KMS Decrypt with the product-key purpose in the encryption context is denied unless the caller is the
 * gateway's runtime role.
 */
export function productKeyDenyStatement(runtimeRoleArn: string): Record<string, unknown> {
  if (!/^arn:aws(?:-[a-z]+)*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/u.test(runtimeRoleArn) || /[*?]/u.test(runtimeRoleArn)) throw new Error("a runtime role ARN without wildcards is required");
  return {
    Sid: "DenyProductKeyDecryptOutsideGateway", Effect: "Deny", Action: ["kms:Decrypt", "kms:ReEncryptFrom", "kms:GenerateDataKey*"], Resource: "*",
    Condition: {
      StringEquals: { "kms:EncryptionContext:purpose": PRODUCT_KEY_PURPOSE },
      ArnNotEquals: { "aws:PrincipalArn": runtimeRoleArn },
    },
  };
}
/** IAM ARN wildcard match (`*` any run, `?` one character), case-sensitive, whole string. */
export function iamWildcardMatches(pattern: string, value: string): boolean {
  let p = 0; let v = 0; let star = -1; let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) { p++; v++; }
    else if (p < pattern.length && pattern[p] === "*") { star = p++; mark = v; }
    else if (star >= 0) { p = star + 1; v = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
/** True when any statement allowing sts:AssumeRole / sts:TagSession has a resource pattern that covers the role ARN. */
export function roleCoveredByStsPatterns(roleArn: string, statements: ReadonlyArray<{ actions: readonly string[]; resources: readonly string[] }>): boolean {
  // The statement's action is itself a pattern ("sts:*", "*", "sts:Assume*").
  const sts = (action: string) => ["sts:AssumeRole", "sts:TagSession"].some((target) => iamWildcardMatches(action, target));
  return statements.some((s) => s.actions.some(sts) && s.resources.some((r) => iamWildcardMatches(r, roleArn)));
}
