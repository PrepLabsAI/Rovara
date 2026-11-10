// Text guards. Pure code: what a lesson may never ask for, and what always sends a lesson to two people.
import { cleanLessonText, foldForMatching, redactText } from "@agentx/contracts";

/** Free text from a person or a system, made safe for a model and for storage: secrets redacted, hidden characters and markup removed, bounded. */
export function cleanForLearning(text: string, maxChars: number): string {
  return cleanLessonText(redactText(text), maxChars);
}

/**
 * Text that asks for a change to tools, permissions, domains, budgets, models, approvals or checks' authority. A lesson is advice: it has no field for
 * these and its text may not request them either (P8). Matching is broad on purpose; a refused lesson only costs a person a re-word.
 */
const CAPABILITY_REQUESTS: readonly RegExp[] = [
  /\b(grant|give|enable|allow|add|unlock|permit)\b[^.\n]{0,40}\b(tools?|permissions?|access|domains?|hosts?|websites?|network|egress|commands?|shell|credentials?|secrets?)\b/iu,
  /\b(allowed?\s*domains?|allowedDomains|allow-?list|egress)\b/iu,
  /\b(increase|raise|lift|remove|bump|change|set)\b[^.\n]{0,30}\b(budget|spend(ing)?\s*(limit|cap)|limit|cap|quota)\b/iu,
  /\b(change|switch|use|swap|pick)\b[^.\n]{0,20}\b(the\s+)?(model|models)\b/iu,
  /\b(auto-?approve|approve\s+automatically|without\s+(an?\s+)?approval|skip\s+(the\s+)?approvals?|bypass\s+(the\s+)?approvals?|no\s+approval\s+needed)\b/iu,
  /\b(run|execute)\b[^.\n]{0,20}\b(any|arbitrary|unrestricted)\b[^.\n]{0,20}\bcommands?\b/iu,
  /^\s*(tools|grants|commands|allowedDomains|permissions|allowed-tools)\s*:/imu,
];
export function requestsCapabilityChange(...texts: readonly string[]): boolean {
  return texts.map(foldForMatching).some((text) => CAPABILITY_REQUESTS.some((pattern) => pattern.test(text)));
}

/**
 * Words that put a lesson in front of two people (tier 2): tests, checks, CI, coverage, security, auth, secrets, permissions, dependencies, network or
 * domains, skipping or disabling anything, and approvals. Over-escalation is accepted in the pilot; the word list is reviewed weekly.
 */
const ESCALATION: readonly RegExp[] = [
  /\b(tests?|testing|test\s+suites?|unit\s+tests?|integration\s+tests?|e2e|flaky|coverage|assert(ion)?s?|mock(s|ing)?)\b/iu,
  /\b(checks?|checking|ci|pipelines?|lint(er|ing)?|typecheck(ing)?|build\s+gates?|gates?)\b/iu,
  /\b(security|secure|auth|authn|authz|authentication|authorization|authori[sz]e[sd]?|secrets?|credentials?|tokens?|passwords?|api[-\s]?keys?|encrypt\w*|crypto\w*|tls|ssl|certificates?|verify\s*=\s*false|sandbox(es|ed)?|vulnerab\w*|cve)\b/iu,
  /\b(permissions?|privileges?|roles?|iam|acl|access\s+control|admin)\b/iu,
  /\b(dependenc(y|ies)|packages?\s+versions?|lockfiles?|upgrade|downgrade|npm|pip|supply\s+chain)\b/iu,
  /\b(network|domains?|hosts?|egress|firewall|proxy|proxies|urls?|endpoints?\s+allow)\b/iu,
  /\b(skip(s|ped|ping)?|disabl(e|es|ed|ing)|bypass(es|ed|ing)?|ignor(e|es|ed|ing)|turn(s|ed|ing)?\s+off|suppress(es|ed|ing)?|no\s+need\s+to|needn'?t|don'?t\s+(need|have)\s+to|override|workaround)\b/iu,
  /\b(approv\w*|reviewers?|code\s+review|sign-?offs?|rubber-?stamp\w*)\b/iu,
];
export function hasEscalationWords(...texts: readonly string[]): boolean {
  return texts.map(foldForMatching).some((text) => ESCALATION.some((pattern) => pattern.test(text)));
}

/**
 * Tier 0 is a positive shape: a plain statement of where something is or what it is called. Anything that tells the agent to run, install, fetch,
 * download, execute, pipe, source or change something goes to people. A list of known commands is always one spelling behind, so this is a list of the
 * KINDS of instruction: verbs, script-shaped tokens, make targets, hosts with or without a scheme, shell syntax, environment assignments.
 */
const COMMANDS: readonly RegExp[] = [
  // Verbs that make a sentence an instruction to act on the machine.
  /\b(run|runs|running|execute|executes|executing|invoke|invokes|invoking|install|installs|installing|reinstall|download|downloads|downloading|fetch|fetches|fetching|bootstrap|bootstraps|provision|deploy|launch|spawn|restart|kill|pipe|piped|pipes|sourcing|curl|wget|scp|rsync|ncat|telnet|sudo|chmod|chown|eval|exec|iwr|iex|invoke-expression|invoke-webrequest)\b/iu,
  /\b(put|add|append|prepend)\b[^.\n]{0,30}\b(on|to|in)\s+(the\s+)?(path|ld_library_path|pythonpath)\b/iu,
  // Package managers and runners, any verb after them.
  /\b(pip3?|pipx|uvx|poetry|conda|npm|npx|pnpm|yarn|deno|brew|apt(-get)?|yum|dnf|apk|gem|cargo|dotnet|nuget|choco|winget|scoop|helm|kubectl|terraform|docker|podman|cmake|gradle|mvn|rake|bazel|git)\s+[a-z-]+/iu,
  /\b(go\s+(run|install|get|build|test|generate)|uv\s+(tool|pip|run|sync|add|venv)|bun\s+(run|install|add|x)|make\s+(?!sure\b|it\b|the\b|a\b|an\b|this\b|that\b|them\b|your\b|our\b|no\b|any\b)[a-z][\w-]*)\b/iu,
  /\b(python3?|node|ruby|perl|php|bash|sh|zsh|pwsh|powershell|java)\s+(-[a-zA-Z-]+\b|[\w-]*[./][\w./-]*)/iu,
  /\|\s*(sh|bash|zsh|python3?|node|perl|ruby|iex)\b/iu,
  // Script-shaped tokens and paths.
  /(^|[\s`'"(])\.{1,2}\/[\w.-]+/u, /\b[\w.-]+\.(sh|ps1|bat|cmd|zsh|bash|run|bin|exe|msi|pkg|deb|rpm)\b/iu, /(^|\/)scripts?\//iu,
  // URLs with or without a scheme, and IP addresses.
  /\bhttps?:\/\//iu, /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|xyz|sh|app|cloud|info|biz|ru|cn|tk|ml|ga|cf|gq|top|site|online|link|zip|mov|ai|ly|gl|gd)(?:\/\S*)?\b/iu, /\b\d{1,3}(?:\.\d{1,3}){3}\b/u,
  // Shell syntax and environment.
  /\brm\s+-/iu, /\b(export\s+)?[A-Z][A-Z0-9_]{2,}=\S+/u, /&&|\|\||;\s*\w+\s+-|\$\(|\$\{|`[^`\n]*\s[^`\n]*`|>\s*\/|\/dev\//u,
];
/** Folds look-alikes and undoes defanged dots and schemes (`acme[.]com`, `hxxp`), so a host written to dodge a filter reads as the host it is. */
export function normaliseForScan(text: string): string {
  return foldForMatching(text).replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\s+dot\s+/giu, ".").replace(/\bhxxps?/giu, "http").replace(/\[:\]|\[:\/\/\]/gu, "://");
}
const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|swift|php|json|yaml|yml|toml|md|txt|sql|css|html|xml|lock|cfg|ini|conf|env|proto|graphql|vue|svelte";
const EXTRA_COMMANDS: readonly RegExp[] = [
  /\bsource\s+(?:\S*\.(?:local|env|sh|rc|profile|zsh|bash)\b|[.~/]\S*)/iu, /\b(irm|scriptblock|start-process|invoke-command|kick\s*off|paste|rerun|re-run)\b/iu,
  new RegExp(`\\b[a-z0-9-]+\\.(?!(?:${CODE_EXT})\\b)[a-z]{2,24}\\/`, "iu"), /(^|[\s`'"(])(bin|tools)\/\S+/iu, /\.(ps1|exe|pl)\b/iu,
  /\b(base64|decoded|decode|decrypt|deobfuscate|untar)\b/iu, /^```/mu,
];
export function hasCommandOrUrl(...texts: readonly string[]): boolean {
  return texts.map(normaliseForScan).some((text) => COMMANDS.some((pattern) => pattern.test(text)) || EXTRA_COMMANDS.some((pattern) => pattern.test(text)));
}

/** Encoded content: long unbroken tokens (base64, hex), percent or unicode escapes, character entities. Never part of a plain fact. */
export function hasEncodedBlob(...texts: readonly string[]): boolean {
  return texts.map(normaliseForScan).some((text) => /(^|[\s`'"(])[A-Za-z0-9+=_-]{24,}($|[\s`'".,;)])/u.test(text) || /%[0-9a-f]{2}/iu.test(text) || /\\(x[0-9a-f]{2}|u[0-9a-f]{4})/iu.test(text) || /&#x?[0-9a-f]+;/iu.test(text));
}

/**
 * The only shapes tier 0 accepts (an ALLOW-LIST): short declarative sentences that say where something is, what it is called, or what it uses.
 *   <thing> is/are at|in|under <path>      <thing> is/are called|named <name>      <thing> use(s) <library> [version] [from <path>]
 * Anything else, including every sentence that starts with a verb, is not tier 0. Checked after folding look-alikes and combining marks. Names and paths
 * may not look like hosts: a dotted token must end in a known code extension, and no directory in a path may contain a dot.
 */
const THING = "(?<thing>[A-Za-z0-9][A-Za-z0-9 _/'-]{0,80}?)";
/** Words that make a "thing" an instruction or an ordering rather than a name: modals, sequence words, imperatives. */
const THING_FORBIDDEN = /\b(must|should|shall|need|needs|before|after|first|then|always|never|every|each|call|calls|run|runs|use|uses|using|ensure|make|do|dont|avoid|check|install|remember|please|only|once)\b/iu;
const IMPERATIVE_START = /^(?:use|run|call|add|set|make|keep|avoid|never|always|do|don'?t|ensure|check|install|fix|update|remove|delete|create|write|read|open|start|stop|enable|disable|import|export|before|after|first|when|if|please)\b/iu;
/**
 * The closed vocabulary of the free-text slots (a title, a description, the "thing" of a template). A word is accepted only if it is a function word, a fixed
 * noun below, a number, or a word of the lesson's OWN cited material (its code paths and anchors, its scope), passed in as `vocab`. Everything else, including
 * every verb, is not accepted, so a sentence an attacker writes cannot go through a slot just because it contains no word on a deny-list.
 */
const FIXED_WORDS: ReadonlySet<string> = new Set((
  "the a an of for in on at under and or to by with from api http json yaml sql html css url id ids pr " +
  "service helper module package library client server config configuration setting option flag timeout limit retry handler function class method endpoint route model schema table queue " +
  "worker job parser validator formatter logger utility wrapper adapter interface type constant default value field file directory folder repo repository code data response " +
  "database db billing matching money amount cent date time name template test fixture script version workflow pipeline component screen page state event " +
  "error exception result input output param parameter argument key token session user account customer payment invoice item array string number boolean object " +
  "layer shared common base core internal public private middleware plugin feature metric app web mobile backend frontend project team policy rule"
).split(/\s+/u));

/** Words of a lesson's own cited material, lower-cased and split on punctuation and camelCase: what a title or a slot may repeat from the code. */
export function vocabularyOf(...pieces: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const piece of pieces) for (const token of piece.split(/[^A-Za-z0-9]+/u)) {
    if (token === "" || token.length > 40) continue;
    out.add(token.toLowerCase());
    for (const part of token.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u)) if (part !== "") out.add(part.toLowerCase());
  }
  return out;
}
const knownWord = (word: string, vocab: ReadonlySet<string>): boolean => {
  const w = word.toLowerCase();
  if (/^v?\d+(\.\d+)*$/u.test(w)) return true;
  for (const form of [w, w.replace(/ies$/u, "y"), w.replace(/es$/u, ""), w.replace(/s$/u, "")]) if (FIXED_WORDS.has(form) || vocab.has(form)) return true;
  return false;
};
const SLOT_CHARS = /^[A-Za-z0-9 _'-]{1,80}$/u;
/** A slot (the thing of a template) holds at most nine words, from the closed character set, every one of them accepted by `knownWord`. */
export function isPlainSlot(slot: string, vocab: ReadonlySet<string>): boolean {
  const words = slot.trim().split(/\s+/u).filter((w) => w !== "").map((w) => w.replace(/^'+|'+$/gu, ""));
  // At most two words may come from the lesson's code; every other word is on the fixed list.
  const fromCode = words.filter((w) => !knownWord(w, new Set()));
  return words.length >= 1 && words.length <= 9 && SLOT_CHARS.test(slot.trim()) && fromCode.length <= 2 && words.every((w) => knownWord(w, vocab));
}

const NAME = "[A-Za-z_@][\\w@-]*(?:\\.[\\w-]+)*";
const PATH = "[\\w@.~-]+(?:/[\\w@.~*-]+)*/?";
const TEMPLATES: readonly RegExp[] = [
  new RegExp(`^(?:the |a |an )?${THING} (?:is|are|lives|live|is located|are located|is defined|are defined|is configured|are configured|is implemented|is stored|are stored|is declared) (?:at|in|under|inside) (?:the )?(${PATH})(?: (?:directory|folder|file|module|package|service))?$`, "iu"),
  new RegExp(`^(?:the |a |an )?${THING} (?:is|are) (?:called|named|known as) (${NAME})$`, "iu"),
  new RegExp(`^(?:the |a |an )?${THING} (?:uses|use|depends on|is built on) (${NAME})(?: (?:v|version )?\\d+(?:\\.\\d+){0,2})?(?: (?:library|package|module|framework|helper))?(?: (?:from|in) (${PATH}))?$`, "iu"),
];
const CODE_EXT_RE = new RegExp(`\\.(?:${CODE_EXT})$`, "iu");
function plainToken(token: string, kind: "name" | "path"): boolean {
  if (token.length > (kind === "name" ? 60 : 100)) return false;
  const segments = token.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === ".." || s === ".")) return false;
  for (const [i, seg] of segments.entries()) {
    const last = i === segments.length - 1;
    const dots = seg.replace(/^\./u, "");
    if (!dots.includes(".")) continue;
    // A dot is fine only in the last segment, and only as a known code extension (index.ts), never as a host (acme.co/setup, get.acme.me).
    if (!last || !CODE_EXT_RE.test(seg)) return false;
  }
  return kind === "name" || segments.length > 0;
}
export interface ParsedFact { kind: "location" | "name" | "uses"; thing: string; name?: string; version?: string; path?: string }
/** One declarative sentence in one of the three templates, split into its slots (no vocabulary or code checks here). Undefined for anything else. */
export function parseDeclarative(text: string): ParsedFact | undefined {
  const folded = normaliseForScan(text).replace(/[`"\u201C\u201D]/gu, "").trim();
  if (folded === "" || folded.length > 200 || /[\n\r]/u.test(folded) || hasEncodedBlob(folded)) return undefined;
  const sentences = folded.split(/[.!?](?:\s+|$)/u).map((s) => s.trim()).filter((s) => s !== "");
  if (sentences.length !== 1) return undefined;
  const sentence = sentences[0]!;
  for (const [index, template] of TEMPLATES.entries()) {
    const m = template.exec(sentence);
    if (m === null) continue;
    const thing = (m.groups?.thing ?? "").trim();
    if (THING_FORBIDDEN.test(thing.replace(/\b(?:retries|uses?)\b/giu, "")) || IMPERATIVE_START.test(thing)) continue;
    const tokens = m.slice(1).filter((t): t is string => t !== undefined && t !== m.groups?.thing);
    if (index === 0) return { kind: "location", thing, path: tokens[0]! };
    if (index === 1) return { kind: "name", thing, name: tokens[0]! };
    const version = /\s(?:v|version )?(\d+(?:\.\d+){0,2})(?:\s|$)/iu.exec(sentence.slice(sentence.indexOf(tokens[0]!) + tokens[0]!.length))?.[1];
    const path = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
    return { kind: "uses", thing, name: tokens[0]!, ...(version === undefined ? {} : { version }), ...(path === undefined ? {} : { path }) };
  }
  return undefined;
}
/** plainToken for callers outside this file. */
export const isPlainToken = (token: string, kind: "name" | "path"): boolean => plainToken(token, kind);

/**
 * Paths where a wrong lesson weakens what protects the project: tests, CI, test-runner and lint configs, git hooks, code owners, scripts, auth and security
 * code, lockfiles and manifests, container and infra files. A lesson scoped to, or citing, any of them needs two people whatever its text says.
 * Globs are matched as plain strings, so `tests/**` matches. Paths are folded for look-alike letters first.
 */
const RISKY_PATHS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?|e2e|fixtures|cypress|playwright|mocks?|__mocks__|testing|qa)(\/|$)/iu, /\.(test|spec)\.[A-Za-z0-9]+/iu, /(^|\/)\*?[A-Za-z0-9_-]*(test|spec)[A-Za-z0-9_-]*\*?(\.|\/|$)/iu,
  /(^|\/)\.github(\/|$)/iu, /(^|\/)\.gitlab-ci/iu, /(^|\/)(Jenkinsfile|\.circleci|\.buildkite|azure-pipelines|buildspec|\.travis)/iu, /(^|\/)ci(\/|$)/iu,
  /(^|\/)(jest|vitest|karma|mocha|cypress|playwright|pytest|tox|nox|coverage|nyc|codecov|sonar|eslint|prettier|stylelint|tslint|babel|webpack|rollup|vite|tsconfig|pyproject|setup|noxfile|conftest|lefthook|commitlint|renovate|dependabot)[\w.-]*(\.(js|cjs|mjs|ts|json|ya?ml|toml|cfg|ini|rc))?$/iu,
  /(^|\/)(\.husky|\.pre-commit-config|\.eslintrc|\.prettierrc|\.babelrc|\.editorconfig|CODEOWNERS|\.git[a-z]*|hooks|githooks)(\/|\.|$)/iu, /(^|\/)scripts?(\/|$)/iu, /(^|\/)(bin|tools|tooling|build)(\/|$)/iu,
  /(^|\/)\*?[\w-]*(auth|authn|authz|oauth|oidc|saml|sso|login|logout|signin|signup|session|jwt|token|password|passwd|credential|cred|secret|security|sanitiz|csrf|cors|rbac|policy|policies|permission|privilege|crypto|cipher|keys?|cert|tls|ssl|iam|acl|admin|guard|middleware)[\w-]*\*?(\/|\.|$)/iu,
  /(^|\/)(package-lock\.json|package\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile(\.lock)?|Cargo\.(lock|toml)|go\.(sum|mod)|requirements[A-Za-z0-9_.-]*\.txt|Gemfile(\.lock)?)$/iu,
  /(^|\/)(Dockerfile[A-Za-z0-9_.-]*|docker-compose[A-Za-z0-9_.-]*|Makefile|\.env[A-Za-z0-9_.-]*|\.npmrc|\.pypirc|\.netrc|terraform|infra|deploy|helm|k8s|kubernetes|ansible|cdk|\.devcontainer|Containerfile[A-Za-z0-9_.-]*|Procfile|GNUmakefile|justfile|flake\.nix|\.envrc|\.tool-versions|\.nvmrc|\.yarnrc(\.yml)?|pnpm-workspace\.yaml|vercel\.json|netlify\.toml|serverless\.ya?ml|\.dockerignore)(\/|$|\.)/iu,
];
/** The loader's glob rule (`*` within a segment, `**` across segments, `?` one character), shared so the risk check and the loader mean the same thing. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") { if (glob[i + 1] === "*") { out += ".*"; i += 1; if (glob[i + 1] === "/") i += 1; } else out += "[^/]*"; }
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${out}$`, "u");
}

/** Paths that are risky by themselves; every one must be seen as risky by RISKY_PATHS (a test holds the two together). */
export const RISKY_SAMPLES: readonly string[] = [
  "tests/x.ts", "test/x.ts", "__tests__/x.ts", "spec/x.rb", "e2e/x.ts", "src/x.test.ts", ".github/workflows/x.yml", ".github/CODEOWNERS", ".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile",
  "ci/x.sh", "jest.config.js", "vitest.config.ts", ".eslintrc.json", ".husky/pre-commit", "CODEOWNERS", "scripts/x.sh", "bin/x", "tools/x", "src/auth/x.ts", "src/oauth/x.ts", "src/login/x.ts",
  "src/session/x.ts", "src/jwt.ts", "src/security/x.ts", "src/rbac/x.ts", "src/policy/x.ts", "src/middleware/x.ts", "src/password/x.ts", "src/token/x.ts", "package.json", "yarn.lock", "Dockerfile",
  "docker-compose.yml", ".npmrc", ".envrc", "tsconfig.json", ".prettierrc", "Makefile", "GNUmakefile", "justfile", ".env", "infra/x.ts", "deploy/x", "terraform/x.tf", "k8s/x.yaml", "helm/x", ".devcontainer/x.json", "pyproject.toml", "Procfile",
];

/**
 * Whether a scope or citation path touches what protects the project. Two checks: the spelling (RISKY_PATHS), and, for a glob with a wildcard INSIDE a segment
 * (for example t?sts, te* or .g* as a directory name), what the glob can reach: it is compiled with the loader's own rule and tried against RISKY_SAMPLES. A plain
 * directory followed by a double star, or a whole-segment star, is ordinary breadth and is not treated as reach.
 */
export function touchesRiskyPath(paths: readonly string[]): boolean {
  return paths.map(foldForMatching).some((path) => {
    if (RISKY_PATHS.some((pattern) => pattern.test(path))) return true;
    const segments = path.split("/");
    // Reach is tried when a wildcard sits INSIDE a segment (t?sts, te*), and when the glob has no literal leading directory at all (**, */workflows/**,
    // **/*.yml, *.yml): such a glob can reach anything. `src/**` and `src/**/*.ts` keep their literal prefix and stay ordinary breadth.
    const partial = segments.some((seg) => /[*?]/u.test(seg) && !/^\*{1,2}$/u.test(seg) && !/^\*+\.[A-Za-z0-9]+$/u.test(seg));
    const noLiteralPrefix = /[*?]/u.test(segments[0] ?? "");
    if (!partial && !noLiteralPrefix) return false;
    let expression: RegExp;
    try { expression = globToRegExp(path); } catch { return true; }
    return RISKY_SAMPLES.some((sample) => expression.test(sample));
  });
}

/** Words that flip a rule's direction, for the curator's "opposite polarity" check. */
const POSITIVE = /\b(always|must|use|prefer|do|enable|require|add|keep)\b/iu;
const NEGATIVE = /\b(never|avoid|don'?t|do\s+not|must\s+not|disable|remove|stop|without|instead\s+of)\b/iu;
export function polarity(text: string): "positive" | "negative" | "none" {
  // A negation anywhere flips the direction of the advice ("never use X" contains "use"), so it wins.
  return NEGATIVE.test(text) ? "negative" : POSITIVE.test(text) ? "positive" : "none";
}
/** True when exactly one of two texts carries a negation, so that a high embedding similarity cannot be trusted to mean "the same advice". */
export function oppositePolarity(a: string, b: string): boolean {
  return (polarity(a) === "negative") !== (polarity(b) === "negative");
}

/** A quoted, forwarded or pasted block inside a person's text carries the trust of its author, which is unknown here: treat it as an outsider's (C3). */
const QUOTED: readonly RegExp[] = [
  /^\s*>/mu, /(^|\n)\s*-{2,}\s*(original|forwarded)\s+message/iu, /\bforwarded\s+message\b/iu, /(^|\n)\s*(from|sent|to|subject)\s*:.*\n\s*(from|sent|to|subject|date)\s*:/iu,
  /\b(they|he|she|someone|\w+)\s+(said|wrote|asked)\s*:\s*["“]/iu, /\bfwd?:\s/iu,
];
export function looksQuoted(text: string): boolean {
  return QUOTED.some((pattern) => pattern.test(text));
}
