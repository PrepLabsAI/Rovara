// The hosted install's task-end notice to the model gateway (Cloud's `POST /v1/service/task-ended`). The gateway refuses a call of a task that ended and cuts one still running, so a task's end has to reach it.
//
//   POST <gateway>/v1/service/task-ended
//     headers  accept: application/json, content-type: application/json, authorization: Bearer <service token>
//              the service token is the one the eval authority read uses (`signServiceToken`: the install's TASK key, typ rovara-service+jwt), with aud "rovara-model-gateway-task-ended" and cid = the company that owns the task
//     body     exactly {"company": <org id>, "task": <task id>}
//   200 body   exactly {"company", "task", "ended": true}
//
// DELIVERED means exactly that: a 200 whose body names the SAME company and task and says `ended: true`. Anything else is not delivered and never an error to the person: a 404 (a gateway that does not have the route
// yet), any other 4xx (the answer will not change, so it is not asked again at once), a redirect, an oversized or unparseable body, a 5xx, a busy answer, a fault or no answer in time. A 5xx, a 429, a fault and a timeout are
// tried again, at most `TASK_ENDED_TRIES` times in all with a short wait between; the seam then answers "pending" and the reconcile (`reconcileTaskEnds`, task-flow/task-end.ts) sends it again later. The sender never throws
// and never logs or echoes the gateway's answer, a token or an id.
import { OrgIdSchema } from "@agentx/contracts";
import { z } from "zod";
import type { TokenSigner } from "../developer/tokens.js";
import { boundedText, signServiceToken } from "./offered-models-http.js";

export const TASK_ENDED_PATH = "/v1/service/task-ended";
export const TASK_ENDED_AUDIENCE = "rovara-model-gateway-task-ended";
/** The answer is one short line; anything bigger is not the contract. */
export const TASK_ENDED_BODY_MAX_BYTES = 2_048;
/** One try (the signature, the request and the body) takes at most this long. */
export const TASK_ENDED_ATTEMPT_TIMEOUT_MS = 3_000;
/** Tries in all, with the waits below between them. */
export const TASK_ENDED_TRIES = 3;
export const TASK_ENDED_BACKOFF_MS: readonly number[] = [250, 1_000];
/** The gateway's own task id pattern. */
const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

const AnswerSchema = z.object({ company: OrgIdSchema, task: z.string().min(1).max(128), ended: z.literal(true) }).strict();

export interface TaskEndedHttpInputs {
  /** The gateway's https origin (ROVARA_CORE_MODEL_GATEWAY_URL, already checked). */
  gatewayUrl: string;
  /** The install's task-key signer and issuer, read when a notice is sent (none yet: not delivered, sent again later). */
  tokens: () => { signer: TokenSigner; issuer: string } | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

type Attempt = "delivered" | "retry" | "stop";

/** The seam's sender: `TaskFlowDeps.taskEnded` of a hosted install. Resolves undefined when the gateway took the notice, "pending" otherwise. */
export function taskEndedSender(input: TaskEndedHttpInputs): (event: { orgId: string; taskId: string }) => Promise<void | "pending"> {
  const origin = input.gatewayUrl.replace(/\/+$/u, "");
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const say = (outcome: string): void => { try { input.log?.({ event: "task_end_notice", outcome }); } catch { /* a log never fails the notice */ } };
  const attempt = async (asked: { company: string; task: string }): Promise<Attempt> => {
    let tokens: ReturnType<TaskEndedHttpInputs["tokens"]>;
    try { tokens = input.tokens(); } catch { return "stop"; }
    if (tokens === undefined) return "stop";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"retry">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("retry"); }, input.timeoutMs ?? TASK_ENDED_ATTEMPT_TIMEOUT_MS); });
    const send = async (): Promise<Attempt> => {
      const token = await signServiceToken({ issuer: tokens.issuer, signer: tokens.signer, ...(input.now === undefined ? {} : { now: input.now }) }, asked.company, TASK_ENDED_AUDIENCE);
      const response = await (input.fetch ?? fetch)(`${origin}${TASK_ENDED_PATH}`, {
        method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify(asked),
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        // A route the gateway does not have (404), or a refusal that will not change, is not asked again at once; a busy or failing gateway is.
        return response.status === 429 || response.status >= 500 ? "retry" : "stop";
      }
      // An oversized or unreadable answer is not the contract: not delivered, and not asked again at once.
      let answer: unknown;
      try { answer = JSON.parse(await boundedText(response, TASK_ENDED_BODY_MAX_BYTES)); } catch { return "stop"; }
      const parsed = AnswerSchema.safeParse(answer);
      return parsed.success && parsed.data.company === asked.company && parsed.data.task === asked.task ? "delivered" : "stop";
    };
    try { return await Promise.race([send(), deadline]); } catch { return "retry"; }
    finally { clearTimeout(timer); deadline.catch(() => undefined); }
  };
  return async (event) => {
    const company = OrgIdSchema.safeParse(event?.orgId);
    if (!company.success || typeof event.taskId !== "string" || !TASK_ID.test(event.taskId)) { say("invalid"); return "pending"; }
    const asked = { company: company.data, task: event.taskId };
    let last: Attempt = "retry";
    for (let tried = 0; tried < TASK_ENDED_TRIES; tried += 1) {
      if (tried > 0) await sleep(TASK_ENDED_BACKOFF_MS[Math.min(tried - 1, TASK_ENDED_BACKOFF_MS.length - 1)]!);
      last = await attempt(asked);
      if (last !== "retry") break;
    }
    if (last === "delivered") { say("delivered"); return undefined; }
    say(last === "stop" ? "not_delivered" : "unavailable");
    return "pending";
  };
}
