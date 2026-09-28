// Spec 025 FR-048 and R23: the control plane's API version decides whether the tools work.
import { DEVELOPER_API_VERSION, apiVersionCompatible } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";
import { NEXT_STEPS, ToolError, UPGRADE_AGENTX_STEP, plainText } from "./errors.js";

/** Developer tasks arrived in API 1.1; a 1.0 control plane has only GET /v1/dev/projects. */
export const REQUIRED_SERVER_MINOR = 1;

export interface Compatibility { env: string; apiVersion: string; notice?: string }

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
      throw new ToolError("UPGRADE_REQUIRED", `${where} answers API ${served}, which is older than this CLI's ${DEVELOPER_API_VERSION} and has no developer tasks`, UPGRADE_AGENTX_STEP);
    }
    if (!compatible) {
      throw new ToolError("UPGRADE_REQUIRED", `this CLI speaks AgentX API ${DEVELOPER_API_VERSION}, but ${where} answers ${served}`, NEXT_STEPS.UPGRADE_REQUIRED);
    }
    const value: Compatibility = {
      env: configuration.env,
      apiVersion: configuration.apiVersion,
      ...(upgradeNotice ? { notice: `a newer AgentX CLI is available for API ${configuration.apiVersion}; ${NEXT_STEPS.UPGRADE_REQUIRED}` } : {}),
    };
    cached = { at: now(), value };
    return value;
  };
}
