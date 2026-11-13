// TE-F1b (M2, release 0.5.19; te-f1 design 3.1 and 3.2): the BY-NAME BLOCK of model hosts, as pure data. Customer code (the agent's commands, checks, evals, readiness runs) must never reach a model host directly. Every model host
// is pointed, in the sandbox's own hosts file (`docker run --add-host <host>:<address>`; the sandbox user is not root and cannot change Docker's bind-mounted /etc/hosts), at the model helper (.9 of the task's helper network), where
// a client that ignored its base-URL variable is recorded by name and closed (model-helper-recorder.ts); or, for a project with no model row and behind the company gate, at the dropped address 10.255.255.1.
//
// The list is GENERATED from the catalog (F0a's `modelHostBlockList`: every row's hosts and auth hosts, every company gateway host), plus Google's three token hosts. No host list is written by hand anywhere else, so a catalog row
// cannot exist without a block entry, and the sealed DNS table (`sealedModelHostPairs`) is made from the same list. A host that is not one exact lower-case public DNS name (a wildcard such as `*.googleapis.com`, which
// would take in Cloud Storage; an address; a scheme; a path) is refused wherever it comes from.
//
// RESIDUAL, said plainly (and carried by the evidence input below): a hosts file is a name block, not a wall. Code that dials an IP address, or uses DNS over HTTPS, still gets out of an UNSEALED round, because `agentx-task` has
// NAT. The evidence says "not sealed; model hosts blocked by name only". A host SUFFIX row (Azure OpenAI: every `<resource>.openai.azure.com`) cannot be held by a hosts file at all; it is listed in `suffixesNotBlockedByName`
// and the finder reports a call to any subdomain. Only the sealed round, which has no route out, closes both.
//
// This module changes no wall, no boot script and no DNS firewall rule. Pure: no I/O.
import { agentXError, builtinModelCatalog, checkModelHost, modelHostBlockList, modelHostSuffixBlockList, type CompanyGatewayRow, type ModelCatalogRow } from "@agentx/contracts";
import { MODEL_HELPER_ALIAS, RUN_NETWORK_MODEL_HELPER_OCTET, RUN_NETWORK_SLOTS } from "./run-network.js";

/** Google's token hosts: a Vertex client's auth library calls them (JS ignores `token_uri` and calls oauth2). They are a model host's own, so they are blocked even when a catalog has no Google row. */
export const GOOGLE_TOKEN_HOSTS: readonly string[] = ["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"];
/** The address a non-AI project's model names point at: inside `10.0.0.0/8`, which the `rvb` wall drops, so a call to it fails fast and reaches nothing. No helper is started for such a project. */
export const MODEL_BLACKHOLE_ADDRESS = "10.255.255.1";
/**
 * The company gate (TE-A1) that turns the block on for a project with NO model row (O21: a change for everyone, so behind a gate). PROPOSED NAME: TE-A1's `feature-rollout.ts` is not in the code this lane stacks on, so the gate's field
 * name must be agreed with the A1 owner (DEFERRED-CHECKS). This module only takes the gate as a boolean; it never reads a store.
 */
export const MODEL_HOST_BLOCK_GATE_NAME = "modelHostBlockNonAi";

// Built when it is used, not when the module loads: task-sandbox.ts imports this file and run-network.ts reaches task-sandbox.ts through setup-network.ts, so at load time the run-network constants may not exist yet.
const helperAddressPattern = (): RegExp => new RegExp(`^172\\.30\\.([1-9][0-9]{0,2})\\.${String(RUN_NETWORK_MODEL_HELPER_OCTET)}$`, "u");
const refuse = (what: string): never => {
  throw agentXError("CONFIG_INVALID", `not ${what} for the model host block`);
};

/** True when `address` is the model helper's address (.9) of a run network slot. */
export function isModelHelperAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const matched = helperAddressPattern().exec(address);
  return matched !== null && Number(matched[1]) <= RUN_NETWORK_SLOTS;
}

/** The names of a project's model-host block: the catalog's rows (all of them, not only the project's) and the project's company gateway rows, plus Google's token hosts. Sorted, no duplicates. Every name is checked. */
export function modelBlockHosts(rows: readonly Pick<ModelCatalogRow, "hosts" | "authHosts">[], gatewayRows: readonly Pick<CompanyGatewayRow, "host">[]): string[] {
  const hosts = [...new Set([...modelHostBlockList(rows, gatewayRows), ...GOOGLE_TOKEN_HOSTS])].sort();
  for (const host of hosts) if (!checkModelHost(host).ok) refuse("a model host name");
  return hosts;
}

export interface ModelHostBlock {
  /** `by_name`: the names are blocked in the sandbox's hosts file. `none`: no block (a project with no model row and the gate off). */
  readonly mode: "by_name" | "none";
  readonly target: "helper" | "blackhole" | "none";
  /** The address every name points at; undefined for `none`. */
  readonly address: string | undefined;
  /** The names, sorted. */
  readonly hosts: readonly string[];
  /** The host suffixes (Azure OpenAI) a hosts file cannot hold: not blocked by name; the finder reports a call to any subdomain. */
  readonly suffixesNotBlockedByName: readonly string[];
  /** Whether the helper's own name (`rovara-models`) is added: only when a helper is started. */
  readonly helperAlias: boolean;
}

export interface PlanModelHostBlockInput {
  /** The catalog's rows; default: the built-in catalog. */
  rows?: readonly ModelCatalogRow[];
  /** The project's company gateway rows. */
  gatewayRows?: readonly CompanyGatewayRow[];
  /** Whether the project has a model row (a connected product source, or a detected model client): it then gets the helper. */
  hasModelRow: boolean;
  /** The helper's address (.9 of the helper network): required when `hasModelRow`. */
  helperIp?: string;
  /** The company gate for a project with no model row (`MODEL_HOST_BLOCK_GATE_NAME`); absent is off. */
  nonAiGate?: boolean;
}

/** Plans the block. Throws CONFIG_INVALID for a name that is not a plain model host, a helper address that is not .9 of a run network, or a model-row project with no helper address. */
export function planModelHostBlock(input: PlanModelHostBlockInput): ModelHostBlock {
  const rows = input.rows ?? builtinModelCatalog().rows;
  const gatewayRows = input.gatewayRows ?? [];
  const hosts = modelBlockHosts(rows, gatewayRows);
  const suffixes = modelHostSuffixBlockList(rows);
  if (input.hasModelRow) {
    if (!isModelHelperAddress(input.helperIp)) return refuse("the model helper's address");
    return { mode: "by_name", target: "helper", address: input.helperIp, hosts, suffixesNotBlockedByName: suffixes, helperAlias: true };
  }
  if (input.nonAiGate === true) return { mode: "by_name", target: "blackhole", address: MODEL_BLACKHOLE_ADDRESS, hosts, suffixesNotBlockedByName: suffixes, helperAlias: false };
  return { mode: "none", target: "none", address: undefined, hosts: [], suffixesNotBlockedByName: [], helperAlias: false };
}

/** Checks a block that may have been built by hand: the one place the address and every name are judged before they become a docker argument or a DNS table line. Returns the pairs (name, address). */
function checkedPairs(block: ModelHostBlock): Array<readonly [string, string]> {
  if (block.mode === "none") return [];
  const { address } = block;
  if (block.target === "helper" ? !isModelHelperAddress(address) : block.target === "blackhole" ? address !== MODEL_BLACKHOLE_ADDRESS : true) return refuse("an address");
  if ((block.target === "helper") !== block.helperAlias || block.mode !== "by_name") return refuse("a block");
  const pairs: Array<readonly [string, string]> = [];
  for (const host of block.hosts) {
    if (!checkModelHost(host).ok) return refuse("a model host name");
    pairs.push([host, address!]);
  }
  if (block.helperAlias) pairs.push([MODEL_HELPER_ALIAS, address!]);
  return pairs;
}

/** The `docker run` arguments of the block: `--add-host <name>:<address>` for every name, and for the helper's own name when a helper is started. Nothing for mode `none`. Throws CONFIG_INVALID for a block that is not sound. */
export function modelHostAddHostArgs(block: ModelHostBlock): string[] {
  return checkedPairs(block).flatMap(([host, address]) => ["--add-host", `${host}:${address}`]);
}

/** The same names for the sealed round's DNS table (`sealed-dns-helper.ts --host name=address`) and the run's own hosts file: generated from the same list, so the two cannot differ. Only a block that has a helper has a sealed table (the sealed round serves a model row through its helper); nothing for the dropped address or mode `none`. */
export function sealedModelHostPairs(block: ModelHostBlock): string[] {
  return checkedPairs(block).filter(() => block.target === "helper").map(([host, address]) => `${host}=${address}`);
}

/** What the sandbox's hosts file answers for `host`: the block's address for a blocked name (any case, one trailing dot) or the helper's own name, else undefined (the name resolves the usual way). */
export function resolveWithBlock(block: ModelHostBlock, host: string): string | undefined {
  const name = host.toLowerCase().replace(/\.$/u, "");
  return checkedPairs(block).find(([candidate]) => candidate === name)?.[1];
}

// ---- the round's block mode, for the evidence

export const MODEL_BLOCK_MODES = ["by_name", "sealed", "none"] as const;
export type ModelBlockMode = (typeof MODEL_BLOCK_MODES)[number];

/**
 * The block mode of a round. Only the sealed check round is `sealed` (no route out exists); the working round, the unsealed check round and anything this function does not know are `by_name`. There is no other way to
 * "sealed": F1-c's evidence says "not sealed; model hosts blocked by name only" for every round that is not exactly `check_sealed`, and never implies sealed.
 */
export function blockModeForRound(roundKind: unknown): ModelBlockMode {
  return roundKind === "check_sealed" ? "sealed" : "by_name";
}

export interface ModelBlockEvidenceInput {
  readonly blockMode: ModelBlockMode;
  /** F0a's finder input: the names that must not be reached directly. */
  readonly blockList: readonly string[];
  /** F0a's finder input: the suffixes whose every subdomain is blocked at DNS only. */
  readonly hostSuffixes: readonly string[];
}

/** The round's block facts for F1-c's evidence: the mode, the block list and the suffix list (the ledger inputs F1-a's evidence lines read, and F0a's redirect-escape finder). A project with no block reports `none`, never `by_name`. */
export function modelBlockEvidenceInput(roundKind: unknown, block: ModelHostBlock): ModelBlockEvidenceInput {
  const blockMode = blockModeForRound(roundKind) === "sealed" ? "sealed" : block.mode === "none" ? "none" : "by_name";
  return { blockMode, blockList: [...block.hosts], hostSuffixes: [...block.suffixesNotBlockedByName] };
}
