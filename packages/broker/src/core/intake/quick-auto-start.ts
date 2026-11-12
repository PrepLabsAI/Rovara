// Decision 134: a clear small change starts Quick on its own. The classifier (in the Slack service) only says "small
// change"; this is the broker's own, deterministic second look at the request's text before anything starts, so text
// that steers the classifier still cannot start a task here. Anything that might be high risk by the existing path
// rules, anything that reads like instructions to the assistant, and anything long gets the card with Start instead.
// Every later gate is unchanged: the plan and its approval per risk level, high-risk paths, spend limits and admission.
import type { QuickAutoStartSkip } from "@agentx/contracts";
import { isSensitivePath } from "../decisions/sensitive-paths.js";

/** A clear small change is short. */
export const QUICK_AUTO_START_MAX_CHARS = 280;

/** Text that talks to the assistant, or carries markup or code, is never "clear" enough to start on its own. */
const UNUSUAL = [
  /[<>{}`]/u,
  /\b(?:ignore|disregard|forget|override|bypass|jailbreak|pretend)\b/iu,
  /\b(?:instructions?|system\s+prompt|prompt|rules?|policy|policies)\b/iu,
  /\b(?:you\s+are|act\s+as|respond\s+with|reply\s+with)\b/iu,
];

/**
 * Words that name what the path rules call high risk (auth, payments, migrations, infrastructure, CI, secrets, ...), or
 * a change that destroys or reaches production, in any form ("migrate", "payment", "deploy", "delete").
 */
const HIGH_RISK_WORDS = /\b(?:auth\w*|login|logins|log\s+in|sign[\s-]?in|sso|saml|oauth|jwt|password\w*|secret\w*|credential\w*|tokens?|api\s+keys?|crypto\w*|encrypt\w*|security|permission\w*|roles?|iam|access\s+control|migrat\w*|schema|database|sql|payment\w*|billing|invoice\w*|checkout|infra\w*|terraform|cdk|cloudformation|dockerfile|docker|kubernetes|k8s|deploy\w*|release\w*|production|prod|pipeline\w*|ci|workflows?|github\s+actions|codeowners|branch\s+protection|delet\w*|drop|truncat\w*|wipe|purge|force[\s-]push|rewrite|revert)\b/iu;

/**
 * Why `instructions` must not start Quick on its own, or undefined when it may. A path or file named in the text
 * (`src/auth/session.ts`, `migrations/`, `Dockerfile`) is checked with the same rules that make a change high risk.
 */
export function quickAutoStartRefusal(instructions: string): Exclude<QuickAutoStartSkip, "thread_busy" | "start_refused"> | undefined {
  const text = instructions.trim();
  if (text.length === 0 || text.length > QUICK_AUTO_START_MAX_CHARS || text.split("\n").length > 3) return "too_long";
  if (UNUSUAL.some((pattern) => pattern.test(text))) return "unusual_text";
  if (HIGH_RISK_WORDS.test(text)) return "high_risk";
  const tokens = text.split(/[\s,;:()"'!?]+/u).map((token) => token.replace(/^[.]+|[.]+$/gu, "")).filter((token) => token.length > 0);
  if (tokens.some((token) => isSensitivePath(token))) return "high_risk";
  return undefined;
}
