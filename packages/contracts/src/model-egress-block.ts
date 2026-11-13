// TE-F0a: this lane's share of the egress-block requirement (7a, 2026-11-13; full text in TE-F2's block): while tests run against the helper, every model host is blocked at the network, not only redirected by an
// environment variable, so a client that ignores its redirect fails visibly ("not run: client ignored the redirect (called <host>)") and never silently calls the real model. Two probes of the Gemini redirect check (the AI SDK
// and LangChain JS variables) sent a fake key to the real Google endpoint: that is the failure this prevents.
//
// Pure: the list of hosts to block, the finder that reads a list of observed hosts against it, and the fixed sentences. Building the network block itself is TE-F1/TE-F2 and the infra queue.
import type { CompanyGatewayRow, ModelCatalogRow } from "./model-catalog.js";

/** Evidence sentences, fixed in code. */
export const MODEL_HOSTS_NOT_BLOCKED_SENTENCE = "model hosts not blocked on this machine";
export const NOT_SEALED_SENTENCE = "not sealed";
export const NOT_SEALED_BLOCKED_BY_NAME_SENTENCE = "not sealed; model hosts blocked by name only";
export const redirectEscapeSentence = (host: string): string => `not run: client ignored the redirect (called ${host})`;

/**
 * Every host a customer's code must not reach directly: each catalog row's hosts and auth hosts (Google's token hosts), and each company gateway's host. Sorted, no duplicates, no wildcard. The F1 contract test builds the
 * `--add-host` list and the sealed DNS table from this, so a row cannot exist without a block entry.
 */
export function modelHostBlockList(rows: readonly Pick<ModelCatalogRow, "hosts" | "authHosts">[], gatewayRows: readonly Pick<CompanyGatewayRow, "host">[]): string[] {
  const hosts = new Set<string>();
  for (const row of rows) for (const host of [...row.hosts, ...row.authHosts]) hosts.add(host);
  for (const row of gatewayRows) hosts.add(row.host);
  return [...hosts].sort();
}

export interface RedirectEscape {
  /** A host taken from the block list, never from the observation. */
  readonly host: string;
  readonly sentence: string;
}

/** A host as the evidence may carry it: lowercase, no port, no trailing dot, trimmed. */
function normalizeObserved(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 300) return undefined;
  const host = raw.trim().toLowerCase().replace(/:[0-9]{1,5}$/u, "").replace(/\.$/u, "");
  return host.length > 0 ? host : undefined;
}

/**
 * The hosts a client called although it should have been redirected: every observed host that is on the block list, once, sorted, each with the fixed sentence. The host in a finding is the BLOCK LIST's own text, so an
 * observed name (which came from a Host header or a TLS hello that customer code controls) is never repeated in the evidence; an observed name not on the list is not a finding here.
 */
export function findRedirectEscapes(blockList: readonly string[], observedHosts: readonly unknown[]): RedirectEscape[] {
  const blocked = new Set(blockList);
  const hit = new Set<string>();
  for (const observed of observedHosts) {
    const host = normalizeObserved(observed);
    if (host !== undefined && blocked.has(host)) hit.add(host);
  }
  return [...hit].sort().map((host) => ({ host, sentence: redirectEscapeSentence(host) }));
}
