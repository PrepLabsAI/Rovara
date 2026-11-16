// Hosted keys are fetched on first send. The existing client signs and verifies every question and answer.
import {
  PolicyHookPinnedKeySchema, PolicyHookSettingsSchema, policyHookKeyThumbprint,
  type AdapterRegistry, type HostedPolicyHookSettings, type PolicyHookSettings,
} from "@agentx/contracts";
import { createPolicyHookClient, type PolicyHookClient, type PolicyHookInstall } from "./client.js";
import { applyPolicyHookClient, PolicyHookSetupError, type ApplyPolicyHookOptions } from "./index.js";

const JWKS_TIMEOUT_MS = 2_000;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_TTL_MS = 5 * 60 * 1000;

/** Internal hosted composition. Every failure becomes the existing client's no-answer outcome. */
export function createHostedPolicyHookClient(settings: HostedPolicyHookSettings, install: PolicyHookInstall, options: ApplyPolicyHookOptions = {}): PolicyHookClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  // Preparation and audit need no answering keys. Sending always resolves the current pinned keys first.
  const base = createPolicyHookClient({ ...options, install, settings: { address: settings.address, keys: [] } });
  let cached: { settings: PolicyHookSettings; expiresAt: number } | undefined;
  let pending: Promise<PolicyHookSettings | undefined> | undefined;

  async function fetchKeys(): Promise<PolicyHookSettings | undefined> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("policy hook keys unavailable"));
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }, JWKS_TIMEOUT_MS);
    });
    const read = async (): Promise<PolicyHookSettings> => {
      const response = await fetcher(settings.jwks, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
      if (response.status !== 200 || response.redirected || response.body === null) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("policy hook keys unavailable");
      }
      reader = response.body.getReader();
      controller.signal.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > JWKS_MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new Error("policy hook keys unavailable");
        }
        chunks.push(value);
      }
      const document: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (document === null || typeof document !== "object" || !("keys" in document) || !Array.isArray(document.keys)) throw new Error("policy hook keys unavailable");
      const keys = document.keys.flatMap((candidate: unknown) => {
        const parsed = PolicyHookPinnedKeySchema.safeParse(candidate);
        return parsed.success && settings.thumbprints.includes(policyHookKeyThumbprint(parsed.data)) ? [parsed.data] : [];
      });
      // Duplicate material in a JWKS is harmless. Ambiguous kids or too many matches refuse through the existing settings schema.
      const unique = [...new Map(keys.map((key) => [JSON.stringify(key), key])).values()];
      return PolicyHookSettingsSchema.parse({ address: settings.address, keys: unique });
    };
    try {
      return await Promise.race([read(), deadline]);
    } catch {
      log({ component: "policy-hook", event: "jwks.unavailable" });
      return undefined;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }

  async function resolve(): Promise<PolicyHookSettings | undefined> {
    if (cached !== undefined && now() < cached.expiresAt) return cached.settings;
    cached = undefined;
    pending ??= fetchKeys().then((resolved) => {
      if (resolved !== undefined) cached = { settings: resolved, expiresAt: now() + JWKS_TTL_MS };
      return resolved;
    }).finally(() => { pending = undefined; });
    return await pending;
  }

  return {
    prepare: base.prepare,
    audit: base.audit,
    async send(prepared) {
      const resolved = await resolve();
      if (resolved === undefined) return { answered: false };
      return await createPolicyHookClient({ ...options, install, settings: resolved }).send(prepared);
    },
  };
}

export function applyHostedPolicyHook(registry: AdapterRegistry, settings: HostedPolicyHookSettings, install: PolicyHookInstall | undefined, options: ApplyPolicyHookOptions = {}): PolicyHookClient {
  if (install === undefined) throw new PolicyHookSetupError();
  return applyPolicyHookClient(registry, createHostedPolicyHookClient(settings, install, options), options);
}
