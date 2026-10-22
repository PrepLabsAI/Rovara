import { createHash } from "node:crypto";
import { createInMemoryE2EDayBudget } from "@agentx/model-runtime";
import type { DockerApplicationModelChannel, WebApiProbeModelChannelRequest } from "@agentx/verifier";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "./e2e-model-channel-session.js";
import { createScriptedE2EInvoke, type ScriptedTurn } from "./e2e-model-scripted.js";

/**
 * The model channel of an agent qualification probe (M1.4 Task 4.5): the same per-run proxy, route checks, budgets, credential scan and receipts as a real group's channel, answering
 * from the scripted double under the route `rovara-scripted/v1` and a qualification policy. It reaches no provider, reads no secret and spends nothing: the day budget is in memory.
 *
 * The qualification CLI (in the verifier package, which cannot import the worker) loads this module from the installed worker and hands the probe runner this function.
 */
export type ScriptedQualificationModelChannelOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  /** Test seam: runs once the socket is listening, for a runner whose user is not the executor's. */
  afterOpen?(socketPath: string): void | Promise<void>;
}>;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** A turn of the probe asset's script as the scripted double takes it: the name is a regular expression source. */
function turnOf(turn: WebApiProbeModelChannelRequest["script"][number]): ScriptedTurn {
  return turn.kind === "tap" ? { kind: "tap", name: new RegExp(turn.name) } : { kind: "done" };
}

export function createScriptedQualificationModelChannel(request: WebApiProbeModelChannelRequest, options: ScriptedQualificationModelChannelOptions = {}): DockerApplicationModelChannel {
  return { async open(open) {
    const evidence = createE2EModelEvidenceCollector();
    const invoke = createScriptedE2EInvoke({ scripts: { [sha256(request.goal)]: request.script.map(turnOf) } });
    const session = await openE2EModelChannelSession({ runId: request.runId, modelRoute: request.modelRoute, policyScope: "qualification", socketPath: open.socketPath,
      allowedSteps: request.allowedSteps, credentialSet: { ...open.credentialSet, cookieValues: [] }, deadlineAt: open.deadlineAt, dayBudget: createInMemoryE2EDayBudget(), evidence,
      signal: open.signal, invoke, ...(options.environment === undefined ? {} : { environment: options.environment }) });
    try { await options.afterOpen?.(session.socketPath); } catch (error) { await session.close().catch(() => undefined); throw error; }
    return { async close() {
      const summary = await session.close();
      return { ...summary, transcripts: evidence.transcripts(), valueKey: open.valueKey, definition: session.definition };
    } };
  } };
}
