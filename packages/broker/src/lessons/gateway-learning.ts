// Lessons on a deployed install (LESSONS-LEARNING-CODE-SIDE): the `learning` port of the core's lessons, answered by the model gateway's learning route (Cloud #57).
//
//   PipelineModel.complete  POST <gateway>/v1/learning/messages, an Anthropic Messages request, `x-api-key` the call's learning token. The token names the step
//                           `rovara-lessons-learning-call` and the models it may use (its `mdl`); it is minted by the deployment for one call (`token`), never taken from a request.
//   LearningSpend           the gateway holds the company's learning limit and refuses past it, so `admit` and `look` answer ok here: one place decides the money.
//
// Answers: 200 with text is the result. A refusal whose `error.type` is `lessons_paused` is a LearningRefusal with the code the gateway names in `x-rovara-lessons-pause` (one of
// LESSONS_PAUSE_CODES; any other value reads as `model_failed`). 429 (`budget_held`, `busy`), 502, 503 and anything else are ordinary failures, in fixed words. Nothing the gateway or the
// model sent is echoed into an error, and no token is ever logged.
import { LessonsPauseCodeSchema } from "@agentx/contracts";
import { LearningRefusal } from "./pause.js";
import type { LearningSpend, PipelineModel } from "./ports.js";

/** The step a learning token names (the gateway's describer reads it). */
export const LEARNING_CALL_STEP = "rovara-lessons-learning-call";
export const LEARNING_MESSAGES_PATH = "/v1/learning/messages";
export const LEARNING_PAUSE_HEADER = "x-rovara-lessons-pause";
/** The gateway's own figure for what the call cost, in US dollars, when it gives one. */
export const LEARNING_COST_HEADER = "x-rovara-cost-usd";
export const LEARNING_CALL_FAILED = "The learning call did not complete.";
export const LEARNING_NOT_AVAILABLE = "Learning is not available on this install yet.";
const PAUSED_WORDS = "The model gateway paused lessons.";
/** The most of an answer read (bytes): a learning answer is a short document. */
const ANSWER_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;

type LearningCall = Parameters<PipelineModel["complete"]>[0];

export interface GatewayLearningOptions {
  /** The gateway's address (https, or http on a loopback address in tests). */
  gatewayUrl: string;
  /** The learning token for one call, and the model alias it names (one of the token's `mdl`). Undefined: no token can be made for this call (learning refuses as `no_provider`). */
  token(call: LearningCall): Promise<{ token: string; model: string } | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function addressOf(gatewayUrl: string): URL {
  let url: URL;
  try { url = new URL(LEARNING_MESSAGES_PATH, gatewayUrl); } catch { throw new Error("the learning gateway address is not a URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("the learning gateway address must be https");
  return url;
}

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > ANSWER_MAX_BYTES) throw new Error(LEARNING_CALL_FAILED);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parse = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };

/** The learning model over the gateway's learning route. */
export function createGatewayLearningModel(options: GatewayLearningOptions): PipelineModel {
  const url = addressOf(options.gatewayUrl);
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async complete(call) {
      const issued = await options.token(call).catch(() => undefined);
      if (issued === undefined) throw new LearningRefusal("no_provider", LEARNING_NOT_AVAILABLE);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": issued.token, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: issued.model, max_tokens: call.maxOutputTokens, system: call.system, messages: [{ role: "user", content: call.user }] }),
          signal: controller.signal,
          // The token goes to the gateway only: a redirect is never followed (it would resend the key elsewhere), and is a failed call.
          redirect: "manual",
        });
        text = await boundedText(response);
      } catch {
        throw new Error(LEARNING_CALL_FAILED);
      } finally {
        clearTimeout(timer);
      }
      const body = parse(text) as { error?: { type?: unknown }; content?: unknown; model?: unknown } | undefined;
      if (response.status >= 300 && response.status < 400) throw new Error(LEARNING_CALL_FAILED);
      if (!response.ok) {
        if (body?.error?.type === "lessons_paused") {
          const code = LessonsPauseCodeSchema.safeParse(response.headers.get(LEARNING_PAUSE_HEADER));
          throw new LearningRefusal(code.success ? code.data : "model_failed", PAUSED_WORDS);
        }
        throw new Error(LEARNING_CALL_FAILED);
      }
      const blocks = Array.isArray(body?.content) ? body.content as Array<{ type?: unknown; text?: unknown }> : undefined;
      if (blocks === undefined || blocks.some((block) => block === null || typeof block !== "object")) throw new Error(LEARNING_CALL_FAILED);
      const answer = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
      // The gateway's figure, when it gives a readable one, never above the call's own budget; without one, the budget the call was given (the most it could have cost), else 0
      // (the gateway holds and counts the money either way).
      const raw = response.headers.get(LEARNING_COST_HEADER);
      const reported = raw === null ? Number.NaN : Number(raw);
      const budget = typeof call.budgetUsd === "number" && Number.isFinite(call.budgetUsd) && call.budgetUsd >= 0 ? call.budgetUsd : undefined;
      const costUsd = Number.isFinite(reported) && reported >= 0 ? (budget === undefined ? reported : Math.min(reported, budget)) : (budget ?? 0);
      return { text: answer, costUsd, model: typeof body?.model === "string" && body.model.length <= 128 ? body.model : issued.model };
    },
  };
}

/** The gateway holds the company's learning limit and refuses past it: the core's own look always answers ok. */
export function gatewayLearningSpend(): LearningSpend {
  return {
    async admit() { return true; },
    async look() { return "ok"; },
  };
}
