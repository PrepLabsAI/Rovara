// FIX-0518 (security, 7a 2026-11-13): a test account is never for an AI model service. A sealed check round's test-account proxy resolves names itself, outside the sandbox's hosts file, so a test account registered for a
// model host would carry REAL model calls past Rovara's model helper: no caps, no recording, no key separation (DECISIONS 157). This module is the one place that decides "is this host a model host", from F0a's model
// catalog (`builtinModelCatalog()`), and the test-account schema, the production check, the backing choice and the proxy all ask it.
//
// What counts: a catalog row's exact hosts (not its auth hosts: Google's token hosts oauth2/sts/iamcredentials are a pending owner decision and are not model hosts here), any subdomain of a catalog host suffix
// (Azure OpenAI's `<resource>.openai.azure.com`) and the suffix itself, and the company's own gateway hosts when the caller has them. Compared case-insensitively after trimming whitespace and trailing dots.
import { builtinModelCatalog } from "./model-catalog-rows.js";

/** The fixed sentence a refusal shows. Never the host asked for. */
export const TEST_ACCOUNT_MODEL_HOST_SENTENCE = "This address is an AI model service. AI calls go through Rovara's model helper, not a test account.";

export interface TestAccountModelHostOptions {
  /** A company's own gateway hosts (the model catalog's company rows): each is a model host too. Plain lower-case names; anything else is ignored here (the gateway contract has already checked it). */
  readonly gatewayHosts?: readonly string[];
}

interface ModelHostSets {
  readonly hosts: ReadonlySet<string>;
  readonly suffixes: readonly string[];
}

let builtin: ModelHostSets | undefined;
function builtinSets(): ModelHostSets {
  if (builtin === undefined) {
    const rows = builtinModelCatalog().rows;
    builtin = { hosts: new Set(rows.flatMap((row) => row.hosts)), suffixes: [...new Set(rows.flatMap((row) => row.hostSuffixes))] };
  }
  return builtin;
}

/** A host as it is compared: trimmed, lower case, without trailing dots. */
export function normalizeModelHostCandidate(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/u, "");
}

/** Whether the text names an AI model service: a catalog host, a host under a catalog suffix (or the suffix itself), or one of the given gateway hosts. Anything that is not a string is not a host (and so not refused here). */
export function isTestAccountModelHost(raw: unknown, options: TestAccountModelHostOptions = {}): boolean {
  if (typeof raw !== "string") return false;
  const host = normalizeModelHostCandidate(raw);
  if (host === "") return false;
  const sets = builtinSets();
  if (sets.hosts.has(host)) return true;
  if (sets.suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  return (options.gatewayHosts ?? []).some((gateway) => normalizeModelHostCandidate(gateway) === host);
}

/** The positions of the hosts that name an AI model service. Positions only, never the text. */
export function testAccountModelHostProblems(hosts: readonly unknown[], options: TestAccountModelHostOptions = {}): number[] {
  const found: number[] = [];
  hosts.forEach((host, index) => {
    if (isTestAccountModelHost(host, options)) found.push(index);
  });
  return found;
}
