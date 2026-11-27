// Code's model gateway last-good record and live-gateway handover helpers (#1578).
// Stored in the release account at /agentx/release/model-gateway-last-good/<env>.
import { MODEL_GATEWAY_LAST_GOOD_PARAMETER, legacyLastGoodParameter, modelGatewayStackName } from "./context.js";
import { IMAGE_DIGEST } from "./ecr.js";
import { StageError } from "./types.js";
import type { GatewayLastGoodRecord, GatewayManifest, PipelineEnv, Ports } from "./types.js";

const SHA40 = /^[0-9a-f]{40}$/u;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const isSha = (value: string | null): value is string => value !== null && SHA40.test(value);

function parsePrevious(raw: unknown): GatewayLastGoodRecord["previous"] {
  if (!isObject(raw)) return null;
  const digest = text(raw.digest) ?? text(raw.gatewayDigest);
  if (digest === null || !IMAGE_DIGEST.test(digest)) return null;
  return { digest, codeSha: text(raw.codeSha) ?? text(raw.gatewayCodeSha) };
}

export function parseLastGood(raw: string): GatewayLastGoodRecord {
  let file: unknown;
  try { file = JSON.parse(raw); } catch { throw new StageError("REFUSED", "the model gateway last-good record is not JSON"); }
  if (!isObject(file) || file.schema !== 1) throw new StageError("REFUSED", "the model gateway last-good record has no schema 1");
  const env = file.env === "beta" || file.env === "production" ? file.env : null;
  const mode = file.mode === "release" || file.mode === "rollback" || file.mode === "adopt" ? file.mode : file.mode === "adoption" ? "adopt" : null;
  const gateway = isObject(file.gateway) ? file.gateway : {};
  const digest = text(gateway.digest);
  const executionId = text(file.executionId);
  const recordedAt = text(file.recordedAt);
  if (env === null || mode === null || digest === null || !IMAGE_DIGEST.test(digest) || executionId === null || recordedAt === null) {
    throw new StageError("REFUSED", "the model gateway last-good record is missing required values");
  }
  const checks = Array.isArray(file.checks) ? file.checks.filter((name): name is string => typeof name === "string") : [];
  return {
    schema: 1,
    env,
    recordedAt,
    executionId,
    mode,
    gateway: {
      digest,
      codeSha: text(gateway.codeSha),
      imageTag: text(gateway.imageTag),
      repository: text(gateway.repository),
    },
    checks,
    previous: parsePrevious(file.previous),
  };
}

export async function readLastGood(ports: Ports, env: PipelineEnv): Promise<GatewayLastGoodRecord | null> {
  const raw = await ports.releaseSsm.get(MODEL_GATEWAY_LAST_GOOD_PARAMETER[env]);
  return raw === null ? null : parseLastGood(raw);
}

/** Best-effort read of Cloud's legacy last-good record during one-time adopt handover (never fails if absent or inaccessible). */
export async function readLegacyLastGood(ports: Ports, env: PipelineEnv): Promise<GatewayLastGoodRecord | null> {
  try {
    const raw = await ports.ssm.get(legacyLastGoodParameter(env));
    return raw === null ? null : parseLastGood(raw);
  } catch {
    return null;
  }
}

export function buildLastGood(
  manifest: GatewayManifest,
  env: PipelineEnv,
  checks: string[],
  previous: GatewayLastGoodRecord | null,
  now: Date,
): GatewayLastGoodRecord {
  if (manifest.gateway.digest === null || !IMAGE_DIGEST.test(manifest.gateway.digest)) {
    throw new StageError("REFUSED", "no model gateway digest in the manifest: nothing to record as last-good");
  }
  const prev = previous === null
    ? null
    : { digest: previous.gateway.digest, codeSha: previous.gateway.codeSha };
  return {
    schema: 1,
    env,
    recordedAt: now.toISOString(),
    executionId: manifest.executionId,
    mode: manifest.mode,
    gateway: {
      digest: manifest.gateway.digest,
      codeSha: manifest.gateway.codeSha,
      imageTag: manifest.gateway.imageTag,
      repository: manifest.gateway.repository,
    },
    checks,
    previous: prev,
  };
}

export async function writeLastGood(ports: Ports, record: GatewayLastGoodRecord): Promise<void> {
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > 4000) throw new StageError("FAILED", "the model gateway last-good record is too large for an SSM standard parameter");
  await ports.releaseSsm.put(MODEL_GATEWAY_LAST_GOOD_PARAMETER[record.env], body);
}

export interface RecordedGateway {
  digest: string;
  codeSha: string | null;
  which: "last-good" | "previous";
}

export function recordedGateways(record: GatewayLastGoodRecord | null): RecordedGateway[] {
  if (record === null) return [];
  const found: RecordedGateway[] = [{ digest: record.gateway.digest, codeSha: record.gateway.codeSha, which: "last-good" }];
  if (record.previous !== null) found.push({ digest: record.previous.digest, codeSha: record.previous.codeSha, which: "previous" });
  return found;
}

export function recordedGatewayDigests(record: GatewayLastGoodRecord | null): string[] {
  return [...new Set(recordedGateways(record).map((entry) => entry.digest))];
}

export type LiveGatewayVerdict = { kind: "cloud" } | { kind: "code"; codeSha: string } | { kind: "no"; why: string };

export async function liveGatewayFor(ports: Ports, env: PipelineEnv, digest: string): Promise<LiveGatewayVerdict> {
  const name = modelGatewayStackName(env);
  const live = await ports.cfn.describeStack(name);
  if (live === null) return { kind: "no", why: `the gateway stack ${name} does not exist` };
  const running = live.parameters.ImageDigest;
  if (running !== digest) return { kind: "no", why: `the ${env} gateway stack runs ${running === undefined ? "no image digest" : `${running.slice(0, 19)}...`}, not that image` };
  const stamped = live.outputs.DeployedCodeSha;
  if (stamped === undefined) return { kind: "cloud" };
  if (!SHA40.test(stamped)) return { kind: "no", why: `the ${env} gateway stack DeployedCodeSha output is not a 40-hex commit` };
  return { kind: "code", codeSha: stamped };
}

export async function keepsLiveGateway(ports: Ports, env: PipelineEnv, digest: string): Promise<{ keep: true } | { keep: false; why: string }> {
  const verdict = await liveGatewayFor(ports, env, digest);
  if (verdict.kind === "cloud") return { keep: true };
  if (verdict.kind === "code") return { keep: false, why: `the ${env} gateway stack was already deployed from Code (${verdict.codeSha.slice(0, 12)})` };
  return { keep: false, why: verdict.why };
}

export async function gatewayCodeForRecordedDigest(
  ports: Ports,
  record: GatewayLastGoodRecord | null,
  digest: string,
  env: PipelineEnv,
): Promise<string | null> {
  const hits = recordedGateways(record).filter((entry) => entry.digest === digest);
  const hit = hits.find((entry) => isSha(entry.codeSha)) ?? hits[0];
  if (hit === undefined) {
    throw new StageError("ROLLBACK_REFUSED", `the digest ${digest.slice(0, 19)}... is not one the ${env} model gateway last-good record names`);
  }
  if (isSha(hit.codeSha)) return hit.codeSha;
  const verdict = await liveGatewayFor(ports, env, digest);
  if (verdict.kind === "cloud") return null;
  if (verdict.kind === "code") return verdict.codeSha;
  throw new StageError("ROLLBACK_REFUSED", `the ${env} ${hit.which} record has no Code commit for ${digest.slice(0, 19)}... (${verdict.why})`);
}
