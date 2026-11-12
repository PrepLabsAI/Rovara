// Decision 134: a clear small change starts Quick on its own. The classifier (in the Slack service) only says "small
// change"; this is the broker's own, deterministic second look at the request's text before anything starts, so text
// that steers the classifier still cannot start a task here. Anything that might be high risk by the existing path
// rules, anything that reads like instructions to the assistant, and anything long gets the card with Start instead.
// Every later gate is unchanged: the plan and its approval per risk level, high-risk paths, spend limits and admission.
import type { QuickAutoStartSkip } from "@agentx/contracts";
import { isSensitivePath } from "../decisions/sensitive-paths.js";

/** A clear small change is short. */
export const QUICK_AUTO_START_MAX_CHARS = 280;

/** Text that talks to the assistant, or carries markup or code (Slack's escaped `&lt;` `&gt;` `&amp;` too), is never "clear" enough to start on its own. */
const UNUSUAL = [
  /[<>{}`]/u,
  /&(?:lt|gt|amp);/iu,
  /\b(?:ignore|disregard|forget|override|bypass|jailbreak|pretend)\b/iu,
  /\b(?:instructions?|system\s+prompt|prompt|rules?|policy|policies)\b/iu,
  /\b(?:you\s+are|act\s+as|respond\s+with|reply\s+with)\b/iu,
];

/**
 * Words that name what the path rules call high risk (auth, payments, migrations, infrastructure, CI, secrets, ...), a
 * change that destroys, removes or reaches production, or one that touches the environment, dependencies or install
 * scripts, in any form ("migrate", "payment", "deploy", "delete", "removing").
 */
const HIGH_RISK_WORDS = /\b(?:auth\w*|login|logins|log\s+in|sign[\s-]?in|sso|saml|oauth|jwt|password\w*|secret\w*|credential\w*|tokens?|api\s+keys?|crypto\w*|encrypt\w*|security|permission\w*|roles?|iam|access\s+control|migrat\w*|schema|database|sql|payment\w*|billing|invoice\w*|checkout|infra\w*|terraform|cdk|cloudformation|dockerfile|docker|kubernetes|k8s|deploy\w*|release\w*|production|prod|pipeline\w*|ci|workflows?|github\s+actions|codeowners|branch\s+protection|delet\w*|remov\w*|drop|truncat\w*|wipe|purge|force[\s-]push|rewrite|revert|env|environment\w*|postinstall|preinstall|install\w*|dependenc(?:y|ies)|curl|wget|rate[\s-]?limit\w*)\b/iu;

/** The scripts a word may be written in; one word in two of them ("dеlete" with a Cyrillic е) hides what it says. */
const SCRIPTS: readonly RegExp[] = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u, /\p{Script=Han}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u];

/** The text as it is read: compatibility forms folded (full-width letters become plain ones), invisible format characters (zero-width, soft hyphen) removed. */
export function quickAutoStartText(instructions: string): string {
  return instructions.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
}

/**
 * Why `instructions` must not start Quick on its own, or undefined when it may. Every check reads the normalised text. A
 * path or file named in the text (`src/auth/session.ts`, `migrations/`, `Dockerfile`) is checked with the same rules
 * that make a change high risk.
 */
export function quickAutoStartRefusal(instructions: string): Exclude<QuickAutoStartSkip, "thread_busy" | "start_refused" | "not_recorded"> | undefined {
  const text = quickAutoStartText(instructions);
  if (text.length === 0 || text.length > QUICK_AUTO_START_MAX_CHARS || text.split(/\r\n|\r|\n|\u2028|\u2029/u).length > 3) return "too_long";
  if (UNUSUAL.some((pattern) => pattern.test(text))) return "unusual_text";
  const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];
  if (words.some((word) => SCRIPTS.filter((script) => script.test(word)).length > 1)) return "unusual_text";
  if (HIGH_RISK_WORDS.test(text)) return "high_risk";
  const tokens = text.split(/[\s,;:()"'!?]+/u).map((token) => token.replace(/^[.]+|[.]+$/gu, "")).filter((token) => token.length > 0);
  if (tokens.some((token) => isSensitivePath(token))) return "high_risk";
  return undefined;
}
