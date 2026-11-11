// Parity lane: the `monitoring` port, as small as it can be. A monitoring adapter is one read-only source of operational facts (an error tracker, a metrics
// service, an on-call tool, a cloud's alarms) that a company connects to Rovara and a stage may read while it understands, plans, checks a plan or reviews.
// The core knows nothing about any vendor: it asks the adapter for the connection type it serves, the read-only tools it offers and whether a saved connection works.
//
// What stays out of the adapter, on purpose:
//   - Adding a connection and approving a tool are the owner's acts on a page (decision 66); an adapter never saves, approves or widens anything.
//   - The secret is read by the core through the `secrets` point and handed to `check` for the one call. An adapter never stores it and its answers never quote it.
//   - Whatever an adapter's tools return is data: the core frames it as untrusted text before a model sees it.
import type { JsonObject } from "./json.js";
import type { SecretValue } from "./model-keys.js";

/** One read-only tool an adapter offers. `inputSchema` is a JSON Schema describing the arguments a model sets, and no others. */
export interface MonitoringToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface MonitoringCheckInput {
  readonly companyId: string;
  /** The connection's settings as saved (its region, site, address, role): never its secret. */
  readonly settings: JsonObject;
  /** The saved secret, when the kind takes one; `undefined` for a kind that assumes a role instead. */
  readonly secret?: SecretValue | undefined;
  /**
   * The only fetch a check may use to reach the vendor: the core holds it to the vendor's origin (or, for an address a person typed, pins it to the addresses it checked) and
   * follows no redirect. An adapter must not build its own.
   */
  readonly fetch: typeof fetch;
}

export interface MonitoringCheckResult {
  readonly ok: boolean;
  /** A message safe to show: fixed words, never a part of the secret. */
  readonly message?: string;
  /** The vendor account the secret belongs to, when the vendor says (kept by the core, never shown). */
  readonly accountId?: string;
}

export interface MonitoringAdapter {
  /** The connection type this adapter serves (`sentry`, `datadog`, ...). */
  readonly kind: string;
  /** The vendor's name in words shown to the owner. */
  readonly vendor: string;
  /** Every monitoring tool is read-only: nothing creates, changes or deletes at the vendor. */
  readonly readOnly: true;
  /** Whether the connection holds a saved secret. False for a kind that assumes a role. */
  readonly takesSecret: boolean;
  tools(): readonly MonitoringToolInfo[];
  /** Asks the vendor whether the saved connection works. Throws only for a fault (the vendor could not be reached); a refusal is `{ ok: false }`. */
  check(input: MonitoringCheckInput): Promise<MonitoringCheckResult>;
}
