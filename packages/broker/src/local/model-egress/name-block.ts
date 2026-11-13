// TE-F1c (te-f1 design 3.2 item 4): the laptop's name block for model hosts.
//
// FINDING (the design is wrong about the code): the egress gateway reads ONE list, `localAllowedDomains()` (isolation/allow-list.ts, through `docker-worker-machines.ts`), for the worker's network AND the sandboxes' network, and
// that list is the cloud's default list, which holds api.anthropic.com, api.openai.com, chatgpt.com, auth.openai.com and openrouter.ai. So a sandbox on a laptop reaches the real model hosts today. Taking them off the shared list
// is not this lane's call: on a laptop the worker's own model calls go through the broker's relay (local/model-proxy), not through the gateway, but ChatGPT-plan sign-in (chatgpt.com, auth.openai.com) may still use it, and nothing here
// has proved the worker never needs these names. So the block is SANDBOX-ONLY: the gateway gets a deny list (`sandboxDenied`) that its sandbox-side name server and forwarders apply and its worker side does not.
//
// Nothing in this lane turns the block on for a running machine: `DockerWorkerMachines` takes it as an option (`modelHostsDeniedInSandbox`) and no caller passes it yet (it waits on 7a's answer that no Rovara component inside a
// sandbox calls a model host). Until then the evidence says "model hosts not blocked on this machine".
import { builtinModelCatalog, modelHostBlockList, modelHostSuffixBlockList, type CompanyGatewayRow, type ModelCatalogRow } from "@agentx/contracts";

type DenyRow = Pick<ModelCatalogRow, "hosts" | "hostSuffixes"> & { readonly authHosts?: readonly string[] | undefined };

/**
 * The names a sandbox must not reach on a laptop: every host of the built-in catalog (ALWAYS the full catalog; `rows` are ADDED, a partial list never shrinks the block), the company's gateway hosts, and every
 * host suffix as a wildcard (`*.openai.azure.com`: a gateway can hold a wildcard, a hosts file cannot). Sorted, no duplicates. Google's token hosts (oauth2, sts, iamcredentials) are NEVER in it (DECISIONS 174): they are not model hosts, and
 * a Google service that runs a model inside it is part of the stated residual. F0a's catalog no longer lists them (a30f3c492), so nothing here has to filter them out.
 */
export function laptopSandboxDenyList(rows: readonly DenyRow[] = [], gatewayRows: readonly Pick<CompanyGatewayRow, "host">[] = []): string[] {
  const all = [...builtinModelCatalog().rows, ...rows].map((row) => ({ hosts: row.hosts, authHosts: row.authHosts ?? [], hostSuffixes: row.hostSuffixes }));
  const hosts = modelHostBlockList(all as never, gatewayRows);
  const suffixes = modelHostSuffixBlockList(all as never).map((suffix) => `*.${suffix}`);
  return [...new Set([...hosts, ...suffixes])].sort();
}

export interface LaptopBlockEvidenceInput {
  readonly blockMode: "by_name" | "none";
  readonly blockList: readonly string[];
  readonly hostSuffixes: readonly string[];
  /** The gateway blocks the Azure suffix itself (a wildcard), so nothing is "not blocked" when the block is on. */
  readonly azureOpenAiNotBlocked: false;
  /** `not_blocked`: the bridge's evidence says "model hosts not blocked on this machine" and never "blocked by name". */
  readonly machineBlock?: "not_blocked";
  readonly observedHosts: readonly unknown[];
}

/** The evidence facts of a laptop round: `denyActive` is whether the gateway that serves the sandbox really has the deny list. */
export function laptopBlockEvidenceInput(denyActive: boolean, denyList: readonly string[] = laptopSandboxDenyList()): LaptopBlockEvidenceInput {
  return denyActive
    ? { blockMode: "by_name", blockList: denyList.filter((entry) => !entry.startsWith("*.")), hostSuffixes: [], azureOpenAiNotBlocked: false, observedHosts: [] }
    : { blockMode: "none", blockList: [], hostSuffixes: [], azureOpenAiNotBlocked: false, machineBlock: "not_blocked", observedHosts: [] };
}
