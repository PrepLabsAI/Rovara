// the model call an Ask makes on this computer (`AskAnswerer`, core/sessions/ask.ts). One request with no tools to the provider the install chose for its steps, made by the broker itself
// with the same pieces the model proxy forwards a worker's call with (the provider plug-in's address and sign-in, the key store, the request guard), and nothing of the proxy's worker side: no token, no operation, no
// budget (an Ask is bounded by its rates, a 60 KB context and 1,200 output tokens). The key never leaves this module: it signs the call, and an answer that contains it is thrown away. A failure is a name, never the
// provider's words (they can quote the key or the request).
import { providerFormat, type ModelKeyStore, type ModelProviderAdapter } from "@agentx/contracts";
import type { AskAnswerer } from "../core/sessions/ask.js";
import { credentialOf } from "./model-proxy/credentials.js";
import { RequestNotAllowed, checkRequestBody, upstreamTarget, type ProviderEndpoints } from "./model-proxy/providers.js";
import { SignInProblem, needsCredential, signCall } from "./model-proxy/sign-in.js";
import type { ModelProviderBook, ProxyApi } from "./model-proxy/types.js";
import { usageOf } from "./model-proxy/usage.js";
import type { LocalModelChoice } from "./model-choice.js";

const ANTHROPIC_VERSION = "2023-06-01";
const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
/** The most of an answer that is read: an Ask's answer is a few thousand characters. */
const ANSWER_MAX_BYTES = 1_048_576;

export interface LocalAskModelOptions {
  /** The model the install's steps use (the owner's `model` setting, else the first provider with a key); undefined: none is set up. */
  choice: () => Promise<LocalModelChoice | undefined>;
  keys: ModelKeyStore;
  companyId: string;
  providers: ModelProviderBook;
  endpoints?: Partial<ProviderEndpoints> | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

/** The body of an answer, at most `limit` bytes: read as it arrives, so a provider that sends more is stopped and not buffered whole. */
async function readBounded(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array | undefined };
    if (done) break;
    size += value?.byteLength ?? 0;
    if (size > limit) { await reader.cancel().catch(() => undefined); throw new AskModelProblem("answer_too_large"); }
    if (value !== undefined) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class AskModelProblem extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AskModelProblem";
  }
}

/** The request of each format, with no tools and nothing kept at the provider. */
export function requestBody(api: ProxyApi, model: string, context: string, question: string, maxOutputTokens: number): Record<string, unknown> {
  switch (api) {
    case "anthropic-messages": return { model, max_tokens: maxOutputTokens, system: context, messages: [{ role: "user", content: question }], stream: false };
    case "openai-completions": return { model, max_tokens: maxOutputTokens, messages: [{ role: "system", content: context }, { role: "user", content: question }], stream: false, store: false };
    // The guard has no `instructions` field for this format (and stays field for field the hosted product's), so the rules go in as the first message of `input`.
    case "openai-responses": return { model, input: [{ role: "developer", content: context }, { role: "user", content: question }], max_output_tokens: maxOutputTokens, stream: false, store: false };
  }
}

/** The answer's text, wherever the format puts it. */
export function textOf(api: ProxyApi, body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (api === "anthropic-messages") {
    for (const block of Array.isArray(body["content"]) ? body["content"] as unknown[] : []) if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") parts.push((block as { text: string }).text);
  } else if (api === "openai-completions") {
    const message = (Array.isArray(body["choices"]) ? body["choices"][0] as { message?: { content?: unknown } } | undefined : undefined)?.message?.content;
    if (typeof message === "string") parts.push(message);
  } else {
    for (const item of Array.isArray(body["output"]) ? body["output"] as unknown[] : []) {
      for (const content of Array.isArray((item as { content?: unknown })?.content) ? (item as { content: unknown[] }).content : []) {
        if (typeof content === "object" && content !== null && (content as { type?: unknown }).type === "output_text" && typeof (content as { text?: unknown }).text === "string") parts.push((content as { text: string }).text);
      }
    }
  }
  return parts.join("").trim();
}

export function createLocalAskModel(options: LocalAskModelOptions): AskAnswerer {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async available() { return (await options.choice()) !== undefined; },
    async answer({ context, question, maxOutputTokens, signal }) {
      const choice = await options.choice();
      if (choice === undefined) throw new AskModelProblem("no_model");
      const row: ModelProviderAdapter | undefined = options.providers.get(choice.provider);
      const format = row === undefined ? undefined : providerFormat(row, choice.api);
      if (row === undefined || format === undefined) throw new AskModelProblem("provider_not_set_up");
      const api: ProxyApi = format.format;
      const target = upstreamTarget(row, format, choice.model, false, options.endpoints?.[choice.provider]);
      const body = requestBody(api, choice.model, context, question, maxOutputTokens);
      // The same guard a worker's request passes: only the fields a format allows, no tools, no provider-side features.
      try { checkRequestBody(api, body); } catch (error) { throw error instanceof RequestNotAllowed ? new AskModelProblem("request_not_allowed") : error; }
      if (target.variant === "vertex") { delete body["model"]; body["anthropic_version"] = VERTEX_ANTHROPIC_VERSION; }
      const text = JSON.stringify(body);
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "user-agent": "rovara-local-ask" };
      if (api === "anthropic-messages" && target.variant === undefined) headers["anthropic-version"] = ANTHROPIC_VERSION;
      let sensitive: string[];
      try {
        const secret = needsCredential(row) ? await credentialOf(row, options.keys, options.companyId) : undefined;
        if (needsCredential(row) && secret === undefined) throw new AskModelProblem("no_credential");
        const signed = signCall({ provider: row, url: new URL(target.url), headers: { "content-type": "application/json" }, body: text, secret, now: new Date(now()) });
        Object.assign(headers, signed.headers);
        sensitive = signed.sensitive;
      } catch (error) {
        throw error instanceof SignInProblem ? new AskModelProblem("sign_in_failed") : error;
      }
      let upstream: Response;
      try {
        // A redirect is never followed (the next address would get the key).
        upstream = await transport(target.url, { method: "POST", headers, body: text, redirect: "manual", signal });
      } catch {
        throw new AskModelProblem(signal.aborted ? "timed_out" : "provider_unreachable");
      }
      if (upstream.status < 200 || upstream.status >= 300) throw new AskModelProblem(`provider_status_${String(upstream.status)}`);
      const whole = await readBounded(upstream, ANSWER_MAX_BYTES);
      // An answer that holds the key is thrown away whole.
      if (sensitive.some((value) => value.length >= 8 && whole.includes(value))) throw new AskModelProblem("key_in_answer");
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(whole) as Record<string, unknown>; } catch { throw new AskModelProblem("unreadable_answer"); }
      const answer = textOf(api, parsed);
      if (answer === "") throw new AskModelProblem("empty_answer");
      // The parsed text too: a key echoed with JSON escapes passes the raw check and reads as plain text here.
      if (sensitive.some((value) => value.length >= 8 && answer.includes(value))) throw new AskModelProblem("key_in_answer");
      const used = usageOf(api, parsed["usage"]);
      return {
        text: answer, model: `${choice.provider}/${choice.model}`,
        ...(used === undefined ? {} : { usage: { input: used.input ?? 0, output: used.output ?? 0, cacheRead: used.cacheRead ?? 0, cacheWrite: used.cacheWrite ?? 0, provider: choice.provider, modelId: choice.model } }),
      };
    },
  };
}
