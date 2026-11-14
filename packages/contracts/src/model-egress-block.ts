// TE-F0a: this lane's share of the egress-block requirement (7a, 2026-11-13; full text in TE-F2's block): while tests run against the helper, every model host is blocked at the network, not only redirected by an
// environment variable, so a client that ignores its redirect fails visibly ("not run: client ignored the redirect (called <host>)") and never silently calls the real model. Two probes of the Gemini redirect check (the AI SDK
// and LangChain JS variables) sent a fake key to the real Google endpoint: that is the failure this prevents.
//
// Pure: the list of hosts to block, the finder that reads a list of observed hosts against it, and the fixed sentences. Building the network block itself is TE-F1/TE-F2 and the infra queue.
import { checkModelHost, type CompanyGatewayRow, type ModelCatalogRow } from "./model-catalog.js";

/** Evidence sentences, fixed in code. */
export const MODEL_HOSTS_NOT_BLOCKED_SENTENCE = "model hosts not blocked on this machine";
/**
 * FIX-0518: a laptop's sandbox network denies the model hosts unless the owner set `projectSettings.<project>.sandboxModelHosts: "allow"` in the Rovara config. When that setting is used, the evidence says this (fixed words, no host list).
 */
export const MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE = "model hosts allowed in the test sandbox by project setting";
/** The id of the pack's "not tested" item that carries the sentence above. A verdict does not read it as "details unreadable". */
export const SANDBOX_MODEL_HOSTS_ITEM_ID = "sandbox_model_hosts";
export const NOT_SEALED_SENTENCE = "not sealed";
export const NOT_SEALED_BLOCKED_BY_NAME_SENTENCE = "not sealed; model hosts blocked by name only";
export const redirectEscapeSentence = (host: string): string => `not run: client ignored the redirect (called ${host})`;

/**
 * Every host a customer's code must not reach directly: each catalog row's model hosts (never authHosts, which serve other APIs too), and each company gateway's host. Sorted, no duplicates, no wildcard. The F1 contract test builds the
 * `--add-host` list and the sealed DNS table from this, so a row cannot exist without a block entry.
 */
export function modelHostBlockList(rows: readonly Pick<ModelCatalogRow, "hosts" | "authHosts">[], gatewayRows: readonly Pick<CompanyGatewayRow, "host">[]): string[] {
  const hosts = new Set<string>();
  for (const row of rows) for (const host of row.hosts) hosts.add(host);
  for (const row of gatewayRows) hosts.add(row.host);
  return [...hosts].sort();
}

/** The suffixes whose every subdomain is a model host (Azure OpenAI's `openai.azure.com`): a hosts file cannot hold them, so the DNS-level block and `findRedirectEscapes` take them from here. Sorted, no duplicates. */
export function modelHostSuffixBlockList(rows: readonly Pick<ModelCatalogRow, "hostSuffixes">[]): string[] {
  return [...new Set(rows.flatMap((row) => row.hostSuffixes))].sort();
}

export type RedirectEscapeKind = "ignored_redirect" | "unlisted_model_host";
export interface RedirectEscape {
  /** A host that passed the strict host checker and is on the block list, matches a listed suffix, or is a Google AI host name; never free text. */
  readonly host: string;
  readonly kind: RedirectEscapeKind;
  readonly sentence: string;
}
export const unlistedModelHostSentence = (host: string): string => `not run: unlisted model host (called ${host})`;

/**
 * A host as the evidence may carry it, or undefined when it is not a plain public DNS name. Reads a URL (`https://user@Host:443/path?q#f`), a bracketed host (`[host]:443`), a port with a trailing dot (`host:443.`) and
 * doubled trailing dots (`host..`), then holds the result to `checkModelHost`: an address, a path, a userinfo or anything else that is not exactly one lowercase public name is not a host.
 */
function normalizeObserved(raw: unknown, countWork?: () => void): string | undefined {
  countWork?.();
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  let text = raw.trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  const end = text.search(/[/?#\\]/u);
  if (end >= 0) text = text.slice(0, end);
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  const bracketed = /^\[([^\]]*)\](.*)$/u.exec(text);
  if (bracketed !== null) text = `${bracketed[1] ?? ""}${bracketed[2] ?? ""}`;
  text = text.replace(/\.+$/u, "").replace(/:[0-9]{1,5}$/u, "").replace(/\.+$/u, "");
  const checked = checkModelHost(text);
  return checked.ok ? checked.host : undefined;
}

/** Google's AI hosts by name shape: a regional or mtls aiplatform host, Firebase AI Logic, or anything generativelanguage-like. A name of this shape that no row lists is a model host the catalog has missed. */
const GOOGLE_AI_HOST = /^(?:[a-z0-9-]+-)?aiplatform(?:\.mtls)?\.googleapis\.com$|^aiplatform\.[a-z0-9-]+\.rep(?:\.mtls)?\.googleapis\.com$|^firebasevertexai\.googleapis\.com$|^[a-z0-9.-]*generativelanguage[a-z0-9.-]*\.googleapis\.com$/u;

/**
 * The hosts a client called although they are blocked: every observed host that is on the block list or under a listed suffix is an "ignored redirect"; a Google AI host name (`*-aiplatform.googleapis.com`,
 * generativelanguage-like) that no row lists is an "unlisted model host". Once each, sorted, with fixed sentences. A host in a finding has passed the strict host checker, so an observed name that customer code controls
 * (a Host header, a TLS hello) is never repeated unless it is a plain DNS name of one of those shapes; anything else is not a finding here.
 * `countWork` is an optional test counter called for each normalization attempt, including rejected observations.
 */
export function findRedirectEscapes(blockList: readonly string[], observedHosts: readonly unknown[], options: { readonly hostSuffixes?: readonly string[] } = {}, countWork?: () => void): RedirectEscape[] {
  const blocked = new Set(blockList);
  const suffixes = (options.hostSuffixes ?? []).map((suffix) => `.${suffix}`);
  const found = new Map<string, RedirectEscapeKind>();
  for (const observed of observedHosts) {
    const host = normalizeObserved(observed, countWork);
    if (host === undefined) continue;
    if (blocked.has(host) || suffixes.some((suffix) => host.endsWith(suffix))) found.set(host, "ignored_redirect");
    else if (GOOGLE_AI_HOST.test(host)) found.set(host, "unlisted_model_host");
  }
  return [...found.keys()].sort().map((host) => {
    const kind = found.get(host) ?? "ignored_redirect";
    return { host, kind, sentence: kind === "ignored_redirect" ? redirectEscapeSentence(host) : unlistedModelHostSentence(host) };
  });
}
