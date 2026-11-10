// Approve by exception. A low-risk lesson drafted from a project member's own correction goes LIVE ON TRIAL with no approval; a thumbs-down by a
// project member, or a later contradicting correction, retires it; after 14 days and at least 3 loads with no thumbs-down it becomes STABLE (what repository publishing may publish).
//
// What this REPLACES for the trial path only: the pilot rule "a person approves every tier-0 lesson" (`TIER0_APPROVAL_DEFAULT` "one"), the cold-start guard (9 person-approved lessons),
// the corroboration rule (Lesson limits #4) and as a switch-on gate. What stays: spike detection (a held source never trials), the project brake, outsider filtering, citation checks,
// second-person rules for tier 2, and every escalation (checks, security, authority, spend) going to a person.
//
// The lesson's WORDS must come from the member's correction and the cited code (`lessonClaimsSupported`), every cited span must be a member correction (`memberCorrectionOf`),
// risky wording families and non-fact/convention/pitfall types never trial (`hasRiskyTrialWording`, `TRIAL_TYPES`), and a trial lesson is live only while every setting in force allows it
// (`ResolvedLearning.trialAllowed`: Standard, mode On, no company approval floor, no required group, no two-person requirement).
import { foldForMatching, isMeaningfulAnchor } from "@agentx/contracts";
import { emitAudit, modeAllows, requireAudit, type LearningPreset, type LearningMode } from "./policy.js";
import type { LessonDeps } from "./ports.js";
import { mayNameInRepository, viewedForLessons } from "./project-repo-audience.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { peopleOf, type Lesson } from "./types.js";

export const TRIAL_STABLE_AFTER_DAYS = 14;
export const TRIAL_STABLE_MIN_LOADS = 3;
const DAY = 86_400_000;
/** The approval a trial lesson carries: nobody, by design. The loader reads it (with the preset) as the only approval a trial lesson needs. */
export const TRIAL_APPROVER = "system:trial";

/**
 * Words that put a lesson with a person even though the tier rules would let it through: what it says touches money or the authority to decide (spend, budgets, billing, roles, owners,
 * approvals, policy, guardrails). The checks and security words are already tier 2 (`hasEscalationWords`); this adds spend and authority, which the owner named.
 */
const AUTHORITY_OR_SPEND: readonly RegExp[] = [
  /\b(budgets?|spend(ing)?|billing|invoices?|quotas?|payments?|pricing|prices?|costs?|credits?)\b/iu,
  /\b(authority|authori[sz]ation|entitle\w*|owners?|maintainers?|guardrails?|polic(y|ies)|governance|compliance|rbac|sudo|privileged?|escalat\w*)\b/iu,
];
export const touchesAuthorityOrSpend = (...texts: readonly string[]): boolean => texts.map(foldForMatching).flatMap(wordingVariants).some((text) => AUTHORITY_OR_SPEND.some((pattern) => pattern.test(text)));

/** The lesson types that may go on trial: statements of fact, convention and pitfall. A procedure, a preference or a review check is advice about HOW to work, and a person reads that first. */
export const TRIAL_TYPES: ReadonlySet<Lesson["type"]> = new Set(["fact", "convention", "pitfall"]);

/**
 * Wording that never goes live on trial, in families (+ controller: a trial lesson has no person, so the wording itself must be harmless). The families: merging, pushing, branches
 * and history; skipping hooks, verification or CI; disabling tests, linters and type checks; production, credentials and the environment; logging or sending bodies, secrets and personal data; deleting
 * migrations, data or history; widening permissions. Matching is broad on purpose: a lesson this catches only costs a person one tap. It runs on top of the tier-2 word lists (`guards.ts`).
 */
const RISKY_WORDING: readonly RegExp[] = [
  // merging, pushing, branches and history
  /\b(merg\w*|rebas\w*|squash\w*|cherry-?pick\w*|force\w*|amend\w*|revert\w*|push\w*|deploy\w*|releas\w*|publish\w*|rollout|roll\s*back|ship(s|ped|ping)?)\b/iu,
  /(?<![\w./-])(main|master|trunk|develop)\b(?![\w/-]|\.\w)/iu,
  /\b(default|protected|release|production|upstream|shared)\s+branch(es)?\b/iu,
  /\bcommit\w*\b[^.\n]{0,40}\b(straight|direct\w*|main|master|trunk|branch|without|skip\w*)\b/iu,
  /\b(straight|directly)\s+(to|into|on)\b/iu,
  /\b(anyway|regardless|despite|even\s+if|even\s+when|no\s+matter|at\s+any\s+cost)\b/iu,
  // hooks, verification, CI
  /(^|\s)--?no-?[a-z]+|\bno[- ]verify\b|\b(hooks?|pre[-\s]?commit|pre[-\s]?push|husky|lefthook|verif\w*)\b/iu,
  /\bci(\/cd)?\b|\bcontinuous\s+integration\b|\bpipelines?\b/iu,
  // disabling a safeguard (either order)
  /\b(disabl\w*|skip\w*|bypass\w*|turn(?:ing|s|ed)?\s+off|switch\w*\s+off|silenc\w*|suppress\w*|comment(?:ing|ed)?\s+out|ignor\w*|mut(?:e|ed|ing)|loosen\w*|relax\w*|weaken\w*|remov\w*|delet\w*|drop\w*|circumvent\w*|work(?:ing|s|ed)?[-\s]?arounds?|evad\w*|overrid\w*|waiv\w*|dismiss\w*)\b[^.\n]{0,50}\b(hooks?|pre[-\s]?commit|pre[-\s]?push|ci|pipelines?|gates?|reviews?|approvals?|sign-?offs?|tls|ssl|certs?|tests?|specs?|lint\w*|eslint|prettier|type[- ]?check\w*|typecheck\w*|tsc|strict\w*|checks?|assert\w*|coverage|guards?|validation|warnings?|safeguards?|protection|signing|verif\w*)\b/iu,
  /\b(tests?|specs?|lint\w*|eslint|prettier|type[- ]?check\w*|typecheck\w*|tsc|strict\w*|checks?|assert\w*|coverage|guards?|validation|warnings?|safeguards?|protection|signing|verif\w*)\b[^.\n]{0,50}\b(disabl\w*|skip\w*|bypass\w*|off|silenc\w*|suppress\w*|ignor\w*|optional|unnecessary|not\s+needed)\b/iu,
  /\bts[-\s]?(ignore|expect[-\s]?error|nocheck)\b|@ts-|eslint[-\s]disable|\bnoqa\b|\bnolint\b/iu,
  // production, accounts, credentials, the environment
  /\b(prod|production|staging|pre[-\s]?prod|live\s+(data|database|db|environment|env|system|server|traffic|account|cluster|bucket|table|customers?))\b/iu,
  /\b(accounts?\s*ids?|aws\s+accounts?|tenants?\s*ids?)\b|\b\d{9,}\b/iu,
  /\b(environment|envs?)\b|\.env\b|dotenv/iu,
  /\b(secrets?|credentials?|tokens?|passwords?|passwd|api[-\s]?keys?|private\s+keys?|certificates?|cookies?|bearer)\b/iu,
  // logging or sending data out
  /\b(?:log(?:s|ged|ging)?|logger|print(?:s|ed|ing)?|echo(?:es|ed|ing)?|console)\b[^.\n]{0,60}\b(request|response|body|bodies|payload|headers?|cookies?|users?|customers?|pii|personal|emails?|data|env\w*|stack\s?traces?|secrets?|tokens?|full|entire|whole|all)\b/iu,
  /\b(requests?|responses?|body|bodies|payloads?|headers?|pii|personal|customers?|stack\s?traces?)\b[^.\n]{0,40}\b(?:log(?:s|ged|ging)?|logger|print(?:s|ed|ing)?|echo(?:es|ed|ing)?|console)\b/iu,
  /\b(webhooks?|telemetry|analytics|exfil\w*|third[- ]part(y|ies)|external\s+(service|endpoint|api|server)|upload\w*|export\w*|dump\w*|stack\s?traces?|backtraces?|core\s?dump|heap\s?dump|screenshots?|send\w*\s+(it|them|the|all)\b[^.\n]{0,40}\bto)\b/iu,
  /\b(customers?|pii|personal(ly)?|gdpr|hipaa|ssn|medical|financial|credit\s+card|real\s+data|sensitive|confidential)\b/iu,
  // deleting migrations, data, history
  /\b(delet\w*|drop\w*|truncat\w*|wip(?:e|es|ed|ing)|purg\w*|destroy\w*|eras(?:e|es|ed|ing)|obliterat\w*|nuk(?:e|es|ed|ing)|clobber\w*|overwrit\w*|prun(?:e|es|ed|ing)|rm)\b/iu,
  /\b(remov\w*|clear\w*|clean\w*)\b[^.\n]{0,40}\b(migrations?|tables?|databases?|data|history|branch\w*|backups?|snapshots?|logs?|records?|rows?|volumes?|buckets?)\b/iu,
  // widening permissions
  /\b(permissions?|privileg\w*|iam|roles?|admins?|sudo|root\s+(user|access|account)|chmod|chown|grants?|allow-?lists?|acl|wildcards?|cors|firewall|ingress|egress|security\s+groups?|0\.0\.0\.0|everyone|anonymous|unauthenticated|widen\w*|broaden\w*|escalat\w*)\b/iu,
  /\bpublic(ly)?\s+(access\w*|read\w*|writ\w*|bucket|url|endpoint|internet)\b|\bopen\s+(up\s+)?to\s+(the\s+)?(world|internet|public|everyone)\b/iu,
  // landing or merging without review, mainline and trunk, self-approval
  /\bland(s|ed|ing)?\b(?!\s+pages?\b)|\bmain[-\s]?line\b|\bfast[-\s]?forward\w*|\bintegrat\w*\b[^\n]{0,30}\binto\b/iu,
  /\bwithout\s+(\w+\s+){0,3}(review\w*|approv\w*|waiting|sign-?offs?|permission|asking)\b|\bno\s+(review|approval|sign-?off)s?\b|\bunreviewed\b/iu,
  /\b(self[-\s]?approv\w*|rubber[-\s]?stamp\w*|lgtm|approv\w*|auto[-\s]?approv\w*|auto[-\s]?merg\w*)\b/iu,
  // CORS allow-all, any origin, the origin header, TLS
  /\b(all|any|every|each|wildcard|\*)\s+(origins?|hosts?|domains?|referers?|referrers?)\b|\borigins?\s+(headers?|checks?|validation|allow\w*)\b|\bcross[-\s]?origin\b|\baccess[-\s]?control[-\s]?allow\b|\b(validat\w*|check\w*|trust\w*|verif\w*)\b[^\n]{0,30}\b(origins?|hosts?\s+headers?)\b|\bhost\s+headers?\b/iu,
  /\b(tls|ssl|https?\s+only|reject[-\s]?unauthori[sz]ed|insecure|strict[-\s]?ssl|self[-\s]?signed|certificate\w*|certs?|mtls)\b/iu,
  // unsafe sinks and unescaped output
  /\b(inner[-\s]?html|outer[-\s]?html|dangerously\w*|eval|new\s+function|document\.write|insert[-\s]?adjacent[-\s]?html|v-html|unsafe[-\s]?(inline|eval)|child[-\s]?process|sanitiz\w*|xss|csrf|sql\s?injection|injection|shell\s?out)\b/iu,
  // casting around the type system
  /\bas\s+any\b|:\s*any\b|<any>|\bany[`'"]*\s+(casts?|casting|typed|assertions?)\b|\b(cast\w*|assert\w*)\b[^\n]{0,20}\bany\b|\bunknown\s+as\b|\bnon[-\s]?null\s+assertions?\b|(quiet|silenc\w*|suppress\w*|shut\s+up|hush)\w*\b[^\n]{0,30}\b(compiler|linter|type\s?checker|warnings?|errors?)\b/iu,
  // marking a build or check green or passing, especially on a timeout
  /\b(green|greenlight\w*)\b/iu,
  /\b(mark\w*|report\w*|treat\w*|count\w*|record\w*|set\w*|force\w*|flip\w*|make\w*)\b[^\n]{0,30}\b(builds?|checks?|ci|tests?|jobs?|status(es)?|runs?|pipelines?|gates?)\b[^\n]{0,30}\b(pass\w*|success\w*|succeed\w*|ok|okay|healthy)\b/iu,
  /\b(time[sd]?[-\s]?out|timeouts?|flak\w*)\b[^\n]{0,60}\b(pass\w*|success\w*|ok|okay|fine|ignor\w*|rerun|re-?try)\b|\b(pass\w*|success\w*|ok|okay)\b[^\n]{0,60}\b(time[sd]?[-\s]?out|timeouts?|flak\w*)\b/iu,
  // who must approve, and the rules around the branch
  /\bcode[-\s]?owners?\b|\bbranch[-\s]?protection\b|\brequired\s+(reviews?|checks?|reviewers?|status\w*)\b|\brulesets?\b|\bprotected\s+(branch\w*|tags?)\b|\bstatus\s+checks?\b/iu,
  // real people's data
  /\b(real|actual|genuine|live|prod\w*)\s+(customers?|users?|data|records?|accounts?|emails?|names?|people|clients?|traffic)\b|\b(customers?|users?|clients?)[-\s]?(data|records?|emails?|info\w*|details)\b|\breal[-\s]?world\s+data\b/iu,
  // (lessons leftovers sweep): the fresh phrasings the earlier re-check found passing. Each pattern is as NARROW as its phrasing allows (review: the first version sent 20 of 38 ordinary lines to a
  // person, the base 7; approve by exception exists to cut human work, so a pattern that needs a bare common word is not added). `trial-eval-set.test.ts` pins the false-positive rate. (narrowing the older words) waits for .
  // CORS: an allow-origin header, and reflecting, mirroring or echoing the caller's origin or referer
  /\ballow[-\s]?origin\b|\b(reflect\w*|mirror\w*|echo\w*)\b[^\n]{0,40}\b(origin|referer|referrer|host\s+header)\b/iu,
  // turning strictness or an implicit/unused check off in a compiler config
  /\b(strict|implicit|unused|skip\s+lib\s+check|isolated\s+modules)(?:\s+(?:null|any|this|property|initiali[sz]ation|function|bind|call|apply|checks?|locals?|parameters?|index|access|override|modules?))*(?:\s+(?:to|is)\s+|\s*[=:]\s*|\s+)(?:false|off|0)\b/iu,
  // writing a whole request, event or user object to standard output, and leaking raw errors, call stacks or whole profiles
  /\b(full|whole|entire|raw|complete)\s+(req|request|res|response|ctx|context|event|payload|body|headers?|user|profile|session|env)\b[^\n]{0,40}\b(stdout|stderr|process\.std\w*)\b|\b(pass|write|send|pipe|dump|print)\w*\s+(req|request|res|response|ctx|payload|body|headers?)\s+to\s+(stdout|stderr|process\.std\w*)/iu,
  /\b(raw|unfiltered|unredacted|unsanitized)\s+(errors?|exceptions?)\b|\b(errors?|exceptions?)\b[^\n]{0,30}\bcall\s*stacks?\b|\b(respon\w*|return\w*|send\w*|expos\w*|show\w*|render\w*|leak\w*)\b[^\n]{0,30}\bcall\s*stacks?\b/iu,
  /\b(users?|customers?|members?)'?s\s+(full|entire|whole|complete)\s+(profiles?|records?|details|data|info\w*|objects?|accounts?)\b|\b(full|entire|whole|complete)\s+(user|customer)\s+(profiles?|objects?|records?)\b/iu,
  // marking a suite or workflow as succeeded; treating a red build as fine
  /\b(mark\w*|report\w*|treat\w*|count\w*|record\w*|set\w*|force\w*|flip\w*|make\w*)\b[^\n]{0,30}\b(suites?|workflows?)\b[^\n]{0,30}\b(pass\w*|success\w*|succe\w*|ok|okay|healthy|fine|green)\b/iu,
  /\bred\s+(builds?|ci|runs?|checks?|pipelines?|tests?|status|suites?|jobs?)\b[^\n]{0,40}\b(fine|ok|okay|acceptable|passing|passed|safe|ignor\w*|harmless|green|success\w*)\b|\b(treat\w*|consider\w*|accept\w*|ignor\w*|count\w*|call\w*)\b[^\n]{0,20}\bred\s+(builds?|ci|runs?|checks?|pipelines?|tests?|status|suites?|jobs?)\b/iu,
  // the primary database, and building SQL from strings
  /\bprimary\s+(db|database|datastore|replicas?)\b/iu,
  /\bconcat\w*\b[^\n]{0,40}\bsql\b|\bsql\b[^\n]{0,40}\bconcat\w*|\b(user|client|form|request)\s+input\b[^\n]{0,30}\bsql\b/iu,
  // building code from a string
  /\bfunction\s*\([^)\n]{0,60}\)\s*\(|\bset\s*(?:timeout|interval)\b[^\n]{0,30}\bstring\b/iu,
  // plain http, a self-issued certificate chain, secrets in browser storage, hard-coded logins, objects readable by everyone, a wildcard action on a cloud service
  /\bplain[-\s]?(?:text\s+)?http\b|\bhttp\s+(?:instead\s+of|rather\s+than|over)\s+https\b|\bun-?encrypted\b|\bcleartext\b|\bself[-\s]?issued\b|\b(?:accept\w*|trust\w*)\b[^\n]{0,30}\b(?:root\s+cas?|unknown\s+(?:ca|issuer))\b/iu,
  /\b(?:sessions?|auth\w*|access|api|login|csrf|jwt|secrets?|keys?|tokens?|passwords?|credentials?|cookies?)\b[^\n]{0,40}\b(?:local|session)[-\s]?storage\b|\b(?:local|session)[-\s]?storage\b[^\n]{0,40}\b(?:sessions?|auth\w*|jwt|secrets?|keys?|tokens?|passwords?|credentials?|cookies?)\b/iu,
  /\bhard[-\s]?cod\w*\b[^\n]{0,60}\b(?:logins?|passwords?|secrets?|keys?|tokens?|credentials?|creds?|usernames?|dsn|connection\s+strings?)\b|\b(?:logins?|passwords?|secrets?|keys?|tokens?|credentials?|creds?)\b[^\n]{0,60}\bhard[-\s]?cod\w*\b/iu,
  /\b(?:readable|writable|writeable|accessible)\s+(?:by|to|for)\s+(?:all|anyone|everyone|any|the\s+world|the\s+public|every\w*)\b(?!\s+(?:screen|assistive))|\bworld[-\s]?(?:readable|writable)\b/iu,
  /\b(?:s3|iam|ec2|lambda|dynamodb|sqs|sns|kms|sts|ssm|rds|logs|events|states|ecr|ecs|eks|route53|cloudfront|secretsmanager|cloudformation|apigateway|elasticloadbalancing|\*):\*|\b(?:action|resource)s?\s*[:=]\s*["']?\*/iu,
  // landing on the primary line, editing generated files without regenerating them, leaving a failing step out
  /\bprimary\s+(?:line|trunk|stream)\b/iu,
  /\bwithout\s+(?:re-?)?generat\w*/iu,
  /\b(?:leav\w*|omit\w*|exclud\w*|tak\w*)\b[^\n]{0,30}\b(?:steps?|stages?|jobs?|checks?|tests?|migrations?|gates?|phases?)\b[^\n]{0,20}\bout\b[^\n]{0,50}\b(?:when|if|on)\b[^\n]{0,15}\b(?:fails?|failed|failing|errors?)\b/iu,
];
/** Dots inside a gap no longer end it (`req.body`, `user.email`): only a sentence end does (a dot followed by a space or the end). */
const GAP_FROM = "[^.\\n]";
const GAP_TO = "(?:(?!\\.(?:\\s|$))[^\\n])";
const PATTERNS: readonly RegExp[] = RISKY_WORDING.map((pattern) => new RegExp(pattern.source.split(GAP_FROM).join(GAP_TO), pattern.flags));
/** The text with its identifiers cut into words: `useProdDatabase`, `PROD_DB_URL`, `use-prod-db` and `skipPreCommit` read as `use Prod Database`, `PROD DB URL`, `use prod db` and `skip Pre Commit`. */
export const splitIdentifiers = (text: string): string => text
  .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").replace(/[_]+/gu, " ").replace(/(?<=[\p{L}\p{N}])-+(?=[\p{L}\p{N}])/gu, " ");
/**
 * The copies of one (already folded) text the wording screens read: as written, with identifiers split into words, and each of those again with quotes, backticks, `*`, `~` and `_` taken out (review,:
 * `"strict": false`, `**Allow**-**Origin**` and `_strict_` read as the words they hold). A function declaration, so the authority and spend screen above can use it too.
 */
function wordingVariants(text: string): string[] {
  const plain = text.replace(/[*`"'~_]/gu, "");
  return [text, splitIdentifiers(text), plain, splitIdentifiers(plain)];
}
/** Whether any of the lesson's words is in a family no trial lesson may use. Each text is matched as written AND with its identifiers split into words, after look-alikes and hidden characters are folded. */
export const hasRiskyTrialWording = (...texts: readonly string[]): boolean =>
  texts.map(foldForMatching).flatMap(wordingVariants).some((text) => PATTERNS.some((pattern) => pattern.test(text)));

/**
 * Key identifiers of a lesson's text: the tokens a reader could check against the correction or the code. A path (has a slash), a file name, a snake_case or camelCase or PascalCase name, an
 * UPPER_SNAKE constant, a command-line flag. Plain words are not key identifiers.
 */
export function keyIdentifiers(...texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const raw of foldForMatching(text).split(/[\s,;:()[\]{}<>"'`]+/u)) {
      const token = raw.replace(/^[^\w@/.-]+|[.,;:!?)-]+$/gu, "");
      if (token.length < 3 || token.length > 120 || NOT_IDENTIFIERS.has(token.toLowerCase()) || /^v?\d+(\.\d+)*$/u.test(token)) continue;
      const identifier = token.includes("/") || /^--?[a-z][\w-]*$/iu.test(token) || /^[\w-]{2,}(\.[\w-]+)+$/u.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/u.test(token) || /[a-z][A-Z]/u.test(token) || /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/u.test(token);
      if (identifier) found.add(token.toLowerCase());
    }
  }
  return [...found];
}
const NOT_IDENTIFIERS: ReadonlySet<string> = new Set(["and/or", "either/or", "w/o", "n/a", "i/o", "etc.", "e.g", "i.e"]);
/**
 * The literal front part of a path glob (`src/retry/**` gives `src/retry/`), or undefined for a glob with no literal part. `partial` is true when the glob's wildcard cuts a path segment short
 * (`src/ret*` gives `src/ret`), which is the only case where more characters may follow the prefix in the cited path.
 */
const globPrefix = (glob: string): { prefix: string; partial: boolean } | undefined => {
  const cut = glob.search(/[*?[{]/u);
  const literal = (cut === -1 ? glob : glob.slice(0, cut)).replace(/^\.\//u, "");
  if (literal.length < 2) return undefined;
  return { prefix: literal.toLowerCase(), partial: cut !== -1 && !literal.endsWith("/") && !literal.endsWith(".") };
};

/**
 * Whether a scope glob starts with whole, literal path segments that lead to a verified cited code path (a segment with a wildcard ends the literal front, so `sr*` and `src/re*` have none). `src/retry/**` and
 * `src/retry/index.ts` pass for the cited `src/retry/index.ts`; `**`/x, `sr*`/`**`, `src/re*`/`**` and a front no valid citation lies under do not .
 */
function scopeFrontIsCited(glob: string, verifiedPaths: readonly string[]): boolean {
  const segments = glob.replace(/^\.\//u, "").toLowerCase().split("/");
  const lead: string[] = [];
  for (const segment of segments) { if (/[*?[\]{}]/u.test(segment)) break; lead.push(segment); }
  const front = lead.join("/");
  if (front === "" || lead.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return verifiedPaths.some((path) => path === front || path.startsWith(front + "/"));
}

/** A character that continues an identifier or a path segment (so a match that touches one is part of a longer name). */
const TOKEN_CHAR = /[\p{L}\p{N}_-]/u;
/**
 * Whether `needle` is in `haystack` as a whole token: the character before it is not part of a name and the character after it is not either (a member access `withRetry.call` is the same identifier; a path
 * is not extended by `.ts`: `src/a` is not in `src/a.ts` or `src/abc/deep.ts`, but is in `src/a/deep.ts`). With `openEnd` only the front is checked (a glob's literal front: `src/retry/` of `src/retry/**`).
 */
export function hasWholeToken(haystack: string, needle: string, openEnd = false): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (before !== undefined && TOKEN_CHAR.test(before) && TOKEN_CHAR.test(needle[0]!)) continue;
    if (openEnd) return true;
    if (after !== undefined && TOKEN_CHAR.test(after) && TOKEN_CHAR.test(needle[needle.length - 1]!)) continue;
    if (after === "." && needle.includes("/") && /\w/u.test(haystack[at + needle.length + 1] ?? "")) continue;
    return true;
  }
  return false;
}

/**
 * Whether the lesson's claims rest on what the member said and the code the lesson cites, and on nothing else (the second half of the trial rule; accepts planted text that arrives
 * through a member's correction, not text that arrives from elsewhere). Deterministic: the lesson names at least one key identifier, and EVERY identifier it names (and the literal front of every path
 * in its scope) appears in the member's correction text or in a cited code path or anchor, as a whole token or path segment (: `src/a` is not supported by `src/abc`, `withRetry` not by
 * `withRetryPolicy`). A lesson whose key words appear nowhere in those is the model's own, or came from text it read and did not cite.
 *
 * Accepted residual risk: plain words are never checked, only identifiers, and the model picks the cited anchors, so an identifier that exists in the repository can be cited to support a claim.
 */
export function lessonClaimsSupported(lesson: { title: string; description: string; body: string; scopePaths?: readonly string[] }, support: { correctionTexts: readonly string[]; code: ReadonlyArray<{ path: string; anchor: string }> }): boolean {
  const haystack = foldForMatching([...support.correctionTexts, ...support.code.flatMap((c) => [c.path, c.anchor])].join("\n")).toLowerCase();
  const identifiers = keyIdentifiers(lesson.title, lesson.description, lesson.body);
  if (identifiers.length === 0 || !identifiers.every((id) => hasWholeToken(haystack, id))) return false;
  return (lesson.scopePaths ?? []).every((glob) => { const front = globPrefix(glob); return front === undefined || hasWholeToken(haystack, front.prefix, front.partial || front.prefix.endsWith("/") || front.prefix.endsWith(".")); });
}

export interface TrialContext {
  /** The preset in force (the stricter of company and project). */
  preset: LearningPreset;
  mode: LearningMode;
  /** `ResolvedLearning.trialAllowed`: false when a stricter setting (a company approval floor, a required group, a two-person requirement) asks for a person. */
  trialAllowed: boolean;
  /** The lesson contradicts another, is a refinement, was sent back to a person, is held by a paused source, or the project brake is on: a person decides. */
  contradiction: boolean; refinement: boolean; reviewRequired: boolean; held: boolean; braked: boolean;
  /** The places of the repositories the project has NOW (read live by the caller). A lesson restricted only to readers of these counts as project-wide. Absent or unreadable: it stays restricted (fail closed). */
  projectRepos?: ReadonlySet<string> | undefined;
}

/**
 * Why a lesson may not go live on trial, as fixed codes; empty means it may. `tier` is the tier decision already made for the lesson (tier 2 and "never" are people's, whatever else is true).
 * Every code is checked by code, from fields code set: the verified citations, the tier, the cited member sources (`provenance.memberCorrection`), the lesson's claims against them
 * (`provenance.claimsSupported`), and the lesson's scope, type and text. It is asked twice: when the lesson is settled, and again on the stored lesson just before it goes live.
 */
export function trialBlockers(lesson: Lesson, tier: Lesson["tier"], context: TrialContext): string[] {
  const why: string[] = [];
  if (context.preset !== "standard") why.push("preset_regulated");
  if (!modeAllows(context.mode, "auto_apply")) why.push("mode_not_on");
  if (context.preset === "standard" && modeAllows(context.mode, "auto_apply") && !context.trialAllowed) why.push("stricter_setting");
  if (tier === 2) why.push("needs_two_people");
  if (!TRIAL_TYPES.has(lesson.type)) why.push("type_not_allowed");
  if (lesson.provenance.minTrust === "outsider") why.push("outsider_source");
  if (lesson.provenance.memberCorrection !== true) why.push("not_member_correction");
  if (lesson.provenance.claimsSupported !== true) why.push("claims_not_supported");
  if (viewedForLessons(lesson, context.projectRepos).provenance.audience.kind !== "project") why.push("restricted_source");
  if (lesson.type === "review_check") why.push("review_check");
  const checks = lesson.citationChecks ?? [];
  const code = lesson.citations.flatMap((c, index) => (c.kind === "code" ? [{ c, index }] : []));
  if (code.length === 0) why.push("no_code_citation");
  if (code.some(({ c, index }) => !isMeaningfulAnchor(c.anchor) || !checks.some((check) => check.index === index && check.result === "valid"))) why.push("citations_not_verified");
  // One repository, and every code citation in it: a check in repository A is no evidence for repository B.
  const repos = lesson.scope.repos ?? [];
  if (repos.length !== 1 || code.some(({ c }) => c.repo !== repos[0])) why.push("scope_not_repo");
  if (touchesAuthorityOrSpend(lesson.title, lesson.description, lesson.body, ...(lesson.scope.paths ?? []))) why.push("touches_authority_or_spend");
  // The scope label is shown to the agent, so it is wording-screened like the text .
  if (hasRiskyTrialWording(lesson.title, lesson.description, lesson.body, ...(lesson.scope.paths ?? []))) why.push("risky_wording");
  // Every scope glob has a literal front, and that front is a prefix of a code path the broker verified (a front found only in the correction text, or a glob that starts with a wildcard, goes to a person).
  const verified = code.filter(({ index }) => checks.some((check) => check.index === index && check.result === "valid")).map(({ c }) => (c.kind === "code" ? c.path.replace(/^\.\//u, "").toLowerCase() : ""));
  if ((lesson.scope.paths ?? []).some((glob) => !scopeFrontIsCited(glob, verified))) why.push("scope_not_literal");
  if (context.contradiction) why.push("contradiction");
  if (context.refinement) why.push("refinement");
  // A lesson linked as a possible duplicate of another is never started on trial while the link stands; a person decides (merge, keep both, reject). Read from the lesson itself, so the second check sees it too.
  if (lesson.possibleDuplicateOf !== undefined) why.push("possible_duplicate");
  if (context.reviewRequired) why.push("review_required");
  if (context.held) why.push("source_held");
  if (context.braked) why.push("project_brake");
  return why;
}

/** Whether a lesson is live on trial or stable (it carries a trial record and the trial approval). The loader asks it together with the preset. */
export const isTrialLesson = (lesson: Pick<Lesson, "trial" | "approvals">): boolean => lesson.trial !== undefined && lesson.approvals.some((a) => a.mode === "trial" && a.by === TRIAL_APPROVER);

export interface StableDeps extends LessonDeps { store: LessonStore }

/** A code citation the broker's own check found stale: the loader withholds the lesson, so it also neither becomes stable nor is published (`load.ts` re-exports this). */
export const hasStaleCitation = (lesson: Pick<Lesson, "citationChecks">): boolean => (lesson.citationChecks ?? []).some((check) => check.result === "stale");

/** Whether a trial lesson has earned stable: 14 days live, at least 3 loads, no thumbs-down (a thumbs-down retires it), no "wrong here" mark or retire proposal waiting, and no stale citation. */
export function trialIsStable(lesson: Lesson, now: number): boolean {
  const t = lesson.trial;
  return t !== undefined && t.state === "trial" && lesson.status === "active" && now - t.startedAt >= TRIAL_STABLE_AFTER_DAYS * DAY
    && lesson.counters.loaded >= TRIAL_STABLE_MIN_LOADS && lesson.counters.harmful === 0 && lesson.retireProposedAt === undefined && !hasStaleCitation(lesson);
}

/** The pending cards that came from a member's correction and name a lesson, by card id. */
export async function memberCardsOf(store: StableDeps["store"], key: ScopeKey): Promise<Lesson[]> {
  return (await store.list(key, { statuses: ["pending"] })).filter((card) => card.contradictsWith !== undefined && card.provenance.memberCorrection === true).sort((a, b) => a.id.localeCompare(b.id));
}
/** The ids of the lessons such cards name: a lesson in this set is contradicted by a member's correction that a person has not decided yet. One read of the project's pending lessons. */
export async function contradictedByMemberCard(store: StableDeps["store"], key: ScopeKey): Promise<ReadonlySet<string>> {
  return new Set((await memberCardsOf(store, key)).map((card) => card.contradictsWith!));
}

/**
 * Moves one trial lesson to stable if it has earned it. Idempotent; true when this call moved it.
 * Stable is what makes a lesson publishable to a repository, so it is a grant: the ledger entry is written first (ONCE per call, not once per try), and a promotion that cannot be recorded does not happen (it is tried
 * again later). A lesson a pending member-correction card contradicts is not promoted (`contradictedByMemberCard`). A lesson that names an erased person is not tried at all (the store's erasure fence would refuse the commit, and the ledger would hold a grant that never happened), and a commit the fence refuses
 * ("erased", "fenced") is final: only a lost race ("conflict") is tried again. A commit that fails after the entry was written is followed by a `lesson.promote_failed` bookkeeping line.
 */
export async function promoteIfStable(deps: StableDeps, key: ScopeKey, lessonId: string, contradicted?: ReadonlySet<string>): Promise<boolean> {
  const now = deps.now();
  let audited = false;
  const failed = async (): Promise<false> => {
    if (audited) await emitAudit(deps.audit, { action: "lesson.promote_failed", workspaceId: key.workspaceId, project: key.project, lessonId, facts: {} });
    return false;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lessonId);
    if (fresh === undefined || !trialIsStable(fresh, now)) return failed();
    // The one eligibility check beyond the lesson's own (the load-time and the nightly path both come through here): a lesson a pending member-correction card contradicts is not made stable (the nightly repair retires it,
    // or a person decides the card). `contradicted` is the nightly pass's list, read once for the project; asked alone, this reads the project's pending cards once, and only for a lesson that has otherwise earned stable.
    // A read that fails holds back this promotion only (fail closed): the lesson stays on trial and is looked at again at its next load or in the nightly pass; the caller's other work goes on.
    let held: boolean;
    try { held = (contradicted ?? await contradictedByMemberCard(deps.store, key)).has(fresh.id); } catch { return failed(); }
    if (held) return failed();
    for (const person of peopleOf(fresh)) if (await deps.store.isErased(key, person)) return failed();
    if (!audited) {
      if (!(await requireAudit(deps.audit, { action: "lesson.trial_stable", workspaceId: key.workspaceId, project: key.project, lessonId: fresh.id, facts: { tier: fresh.tier } }))) return false;
      audited = true;
    }
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, trial: { ...fresh.trial!, state: "stable", stableAt: now }, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), updatedAt: now }], now);
    if (result.ok) return true;
    if (result.reason !== "conflict") break;
  }
  return failed();
}

/**
 * Moves every trial lesson that earned it to stable. Idempotent and bounded; returns the ids moved. For the nightly pass (a lesson that is not loaded again would otherwise wait for a load). `stop` is asked before
 * each lesson (the caller's time budget); `skip` is the lessons a pending member card contradicts, when the caller has read them once for the project (absent: read when a lesson has earned stable). The lessons are read a page at a time (`PROMOTE_PAGE`), so a large project is never read whole.
 */
export const PROMOTE_PAGE = 100;
export async function promoteStableTrials(deps: StableDeps, key: ScopeKey, limit = 200, stop?: () => boolean, skip?: ReadonlySet<string>): Promise<string[]> {
  const moved: string[] = [];
  const now = deps.now();
  let after: string | undefined;
  do {
    const page = await deps.store.listPage(key, { statuses: ["active"], limit: PROMOTE_PAGE, ...(after === undefined ? {} : { after }) });
    for (const lesson of page.lessons) {
      if (moved.length >= limit || stop?.() === true) return moved;
      if (trialIsStable(lesson, now) && (await promoteIfStable(deps, key, lesson.id, skip))) moved.push(lesson.id);
    }
    after = page.next;
  } while (after !== undefined);
  return moved;
}

/**
 * What repository publishing may publish (into the repository whose place is `targetPlace`: a lesson restricted only to one project repository is publishable only into that very repository): a lesson that is stable, live, from a task shared with the project and a project-wide source, still sound (not tier 2, no send-back to a person, no
 * retire proposal, no thumbs-down or wrong-here mark), and whose text names no person. Names are matched against `names` (REQUIRED: the display names of the people the lesson could name, which the
 * caller reads; an empty list is a statement that the caller found none), and an @handle or an e-mail address always counts as a name. Anything unknown is false. The caller still checks the preset in
 * force (`ResolvedLearning.trialAllowed`: under Regulated nothing is published) and that the people who will read the repository may read the lesson NOW (`readVisible` with a viewer of `undefined`, which also checks the live visibility of every task the lesson was learned from; `fromSharedTask` is only what was true when it was learned).
 */
export function isPublishable(lesson: Lesson, names: readonly string[], projectRepos?: ReadonlySet<string>, targetPlace?: string): boolean {
  // A lesson restricted only to one project repository is published only into that repository (`targetPlace`, its `github:repo/<id>`); with no target it is not publishable.
  if (!mayNameInRepository(lesson, targetPlace)) return false;
  if (lesson.trial?.state !== "stable" || lesson.status !== "active" || lesson.provenance.fromSharedTask !== true || viewedForLessons(lesson, projectRepos).provenance.audience.kind !== "project") return false;
  if (lesson.tier >= 2 || lesson.reviewRequired === true || lesson.retireProposedAt !== undefined || lesson.counters.harmful > 0 || hasStaleCitation(lesson)) return false;
  return !namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), names);
}
/** Whether a text names a person: an @handle, an e-mail address, or any of the given display names as a whole word (case and look-alikes folded). */
export function namesAPerson(text: string, names: readonly string[]): boolean {
  const folded = foldForMatching(text);
  if (/(^|[^\w])@[a-z0-9][\w-]{0,38}/iu.test(folded) || /[\w.+-]+@[\w-]+\.[\w.-]+/u.test(folded)) return true;
  return names.map((n) => foldForMatching(n).trim()).filter((n) => n.length >= 2).some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(folded));
}
