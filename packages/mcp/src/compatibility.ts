// Spec 025 FR-048 and R23: the control plane's API version decides whether the tools work.
import { DEVELOPER_API_VERSION, apiVersionCompatible } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";
import { NEXT_STEPS, ToolError, UPGRADE_AGENTX_STEP, plainText } from "./errors.js";

/**
 * Developer tasks arrived in API 1.1 (a 1.0 control plane has only GET /v1/dev/projects).
 * Spec 025 C20: the share route arrived in API 1.2.
 */
export const REQUIRED_SERVER_MINOR = 2;

export interface Compatibility {
  env: string;
  apiVersion: string;
  notice?: string;
  /** Spec 025 A1: the control plane's admin API version; absent before 25d. */
  adminApiVersion?: string;
}

/** Spec 025 A1: the admin read tools arrived in admin API 1.0. */
export const REQUIRED_ADMIN_MINOR = 0;

export function adminApiFits(version: string | undefined): "fits" | "missing" | "too_old" | "incompatible" {
  if (version === undefined) return "missing";
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match === null || match[1] !== "1") return "incompatible";
  return Number(match[2]) >= REQUIRED_ADMIN_MINOR ? "fits" : "too_old";
}

const version = (value: string): [number, number] | undefined => {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
};

/**
 * Reads the control plane's API version, at most once every 10 minutes while it is compatible. A
 * refusal is never kept, so an admin's upgrade is seen on the next call.
 */
export function compatibilityChecker(client: ControlPlaneClient, options: { now?(): number; cacheMs?: number } = {}): () => Promise<Compatibility> {
  const now = (): number => (options.now ? options.now() : Date.now());
  const cacheMs = options.cacheMs ?? 600_000;
  let cached: { at: number; value: Compatibility } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < cacheMs) return cached.value;
    const configuration = await client.configuration();
    const where = `AgentX at ${plainText(configuration.baseUrl, "its URL")}`;
    const served = plainText(configuration.apiVersion, "an unknown version").slice(0, 20);
    const { compatible, upgradeNotice } = apiVersionCompatible(configuration.apiVersion, DEVELOPER_API_VERSION);
    const server = version(configuration.apiVersion);
    const mine = version(DEVELOPER_API_VERSION)!;
    // Ruling S1: when AgentX, not this CLI, is the older side, only an admin can fix it.
    const agentxOlder = server !== undefined && (server[0] < mine[0] || (server[0] === mine[0] && server[1] < REQUIRED_SERVER_MINOR));
    if (agentxOlder) {
      throw new ToolError("UPGRADE_REQUIRED", `${where} answers API ${served}, which is older than this CLI's ${DEVELOPER_API_VERSION} and lacks the task routes it needs`, UPGRADE_AGENTX_STEP);
    }
    if (!compatible) {
      throw new ToolError("UPGRADE_REQUIRED", `this CLI speaks AgentX API ${DEVELOPER_API_VERSION}, but ${where} answers ${served}`, NEXT_STEPS.UPGRADE_REQUIRED);
    }
    const value: Compatibility = {
      env: configuration.env,
      apiVersion: configuration.apiVersion,
      ...(configuration.adminApiVersion === undefined ? {} : { adminApiVersion: configuration.adminApiVersion }),
      ...(upgradeNotice ? { notice: `a newer AgentX CLI is available for API ${configuration.apiVersion}; ${NEXT_STEPS.UPGRADE_REQUIRED}` } : {}),
    };
    cached = { at: now(), value };
    return value;
  };
}
