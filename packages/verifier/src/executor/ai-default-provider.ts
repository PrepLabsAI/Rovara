/**
 * The Vercel AI SDK resolves a model given as a string through `globalThis.AI_SDK_DEFAULT_PROVIDER`, and falls back to its gateway when there is none (M1.4 Task 4.3a).
 * The executor has no network but the app's, and no key, but it must not even try: this installs a property whose every read throws, before any module that could resolve a
 * string model id loads, so an agent given a string model id fails at once, with this sentence, instead of reaching for a gateway. The model of an agent step is the object the
 * executor builds over the worker's channel and nothing else.
 */

export const REFUSING_DEFAULT_PROVIDER_MESSAGE = "the AI SDK default provider is not available in the executor: a model must be the object over the model channel, never a model id";

const refuse = (): never => { throw new Error(REFUSING_DEFAULT_PROVIDER_MESSAGE); };

/** Idempotent. Not configurable, so nothing later in the process can put a provider back. */
export function installRefusingE2EDefaultProvider(target: typeof globalThis = globalThis): void {
  const existing = Object.getOwnPropertyDescriptor(target, "AI_SDK_DEFAULT_PROVIDER");
  if (existing?.get === refuse) return;
  Object.defineProperty(target, "AI_SDK_DEFAULT_PROVIDER", { configurable: false, enumerable: false, get: refuse, set: refuse });
}
