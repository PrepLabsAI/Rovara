// FIX-0518 (security, 7a 2026-11-13): the laptop's task sandboxes must not reach a model host.
//
// FINDING: the egress gateway reads ONE allow list (`localAllowedDomains()`, the cloud's default list, which holds api.openai.com, api.anthropic.com, auth.openai.com, openrouter.ai and chatgpt.com) for the worker's network AND the
// sandboxes' network. So customer test code and the agent's shell commands in a sandbox could send workspace data to a model host with an attacker's key (exfiltration), or spend without a cap on a key committed to a repository. The agent's
// own model loop runs in the WORKER through the broker's key proxy, so the worker's network keeps the model hosts and the sandbox network loses them: the gateway gets a SANDBOX-ONLY deny list (`sandboxDenied`).
//
// ON by default. The owner's own config can switch it off for one project (`projectSettings.<project>.sandboxModelHosts: "allow"`), for a customer whose tests really call a model with the repository's own key; the evidence then says so.
//
// Not here, on purpose: Google's token hosts (oauth2, sts, iamcredentials.googleapis.com). Whether they stay on any list is a separate owner decision.
import { builtinModelCatalog, type CompanyGatewayRow, type ModelCatalogRow, type PluginConfig } from "@agentx/contracts";

/** The five hosts the default allow list gives the sandboxes today. Pinned here, so the deny never shrinks if the catalog changes. */
export const SANDBOX_PINNED_MODEL_HOSTS: readonly string[] = ["api.anthropic.com", "api.openai.com", "auth.openai.com", "chatgpt.com", "openrouter.ai"];

/**
 * The pinned hosts' families as wildcards. A project's own list may allow a whole family (`*.openai.com`), which would pass `eu.api.openai.com` or `ab.chatgpt.com` although the exact names are denied; a wildcard here covers every depth below the name.
 * Each pinned host also gets its own `*.<host>` (below), and the registrable parents of the five are named here.
 */
export const SANDBOX_PINNED_MODEL_PARENTS: readonly string[] = ["*.openai.com", "*.anthropic.com", "*.openrouter.ai", "*.chatgpt.com"];

/** Google's token hosts: left out of this deny list (a pending owner decision removes them everywhere). */
export const SANDBOX_DENY_LEAVES_OUT: readonly string[] = ["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"];

type DenyRow = Pick<ModelCatalogRow, "hosts" | "hostSuffixes"> & { readonly authHosts?: readonly string[] | undefined };

/**
 * The names a sandbox must not reach on a laptop: the five pinned hosts, every host of the built-in catalog (ALWAYS the full catalog; `rows` are ADDED, a partial list never shrinks the deny), the company's gateway hosts, every host
 * suffix as a wildcard (`*.openai.azure.com`), a `*.<host>` wildcard under every one of those hosts, and the pinned families (`*.openai.com`, `*.anthropic.com`, `*.openrouter.ai`, `*.chatgpt.com`). Sorted, no duplicates, never Google's token hosts.
 */
export function laptopSandboxDenyList(rows: readonly DenyRow[] = [], gatewayRows: readonly Pick<CompanyGatewayRow, "host">[] = []): string[] {
  const all: DenyRow[] = [...builtinModelCatalog().rows, ...rows];
  const names = new Set<string>(SANDBOX_PINNED_MODEL_HOSTS);
  for (const row of all) for (const host of [...row.hosts, ...(row.authHosts ?? [])]) names.add(host.toLowerCase());
  for (const row of gatewayRows) names.add(row.host.toLowerCase());
  for (const row of all) for (const suffix of row.hostSuffixes) names.add(`*.${suffix.toLowerCase()}`);
  // Every subdomain of a denied host, and the pinned families: `*.api.openai.com`, `*.openai.com`, `*.chatgpt.com` ... (a wildcard never matches the bare name, so the exact names stay).
  for (const name of [...names]) if (!name.startsWith("*.")) names.add(`*.${name}`);
  for (const parent of SANDBOX_PINNED_MODEL_PARENTS) names.add(parent);
  for (const left of SANDBOX_DENY_LEAVES_OUT) { names.delete(left); names.delete(`*.${left}`); }
  return [...names].sort();
}

/**
 * Whether the owner let this project's sandboxes reach the model hosts. Only an own `"allow"` counts: a project with no entry, an entry without the setting, `"deny"`, a missing project name or a name that is not an own key all mean deny.
 * The config is the owner's file; nothing a repository or an agent writes reaches it.
 */
export function sandboxModelHostsAllowed(config: Pick<PluginConfig, "projectSettings"> | undefined, project: string | undefined): boolean {
  const settings = config?.projectSettings;
  if (settings === undefined || project === undefined || !Object.hasOwn(settings, project)) return false;
  return settings[project]?.sandboxModelHosts === "allow";
}
