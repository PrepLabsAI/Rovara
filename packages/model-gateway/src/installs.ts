import { record } from "./model-gateway-token.js";
export interface Install { readonly issuer: string; readonly jwksUrl: string; readonly taskKids: readonly string[] }
/** Trusted configuration, never filled from a token's URLs. Task key IDs are distinct from developer key IDs. */
export interface InstallRegistry { find(issuer: string): Install | undefined }
export class StaticInstallRegistry implements InstallRegistry {
  readonly #entries: Map<string, Install>;
  constructor(entries: readonly Install[]) { this.#entries = new Map(entries.map((entry) => [entry.issuer, Object.freeze({ ...entry, taskKids: Object.freeze([...entry.taskKids]) })])); }
  find(issuer: string): Install | undefined { return this.#entries.get(issuer); }
}
export type JwksReader = (pinnedAddress: string) => Promise<unknown[]>;
/** One bounded read including the body; no redirects, retries or token-controlled addresses. */
export function createJwksReader(fetcher: typeof fetch): JwksReader {
  return async (address) => {
    const controller = new AbortController();
    let rejectTimeout!: (reason: Error) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("keys unavailable")); }, 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([fetcher(address, { redirect: "error", signal: controller.signal }), timeout]);
      if (!response.ok || response.redirected || response.body === null) throw new Error();
      reader = response.body.getReader();
      let total = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await Promise.race([reader.read(), timeout]); if (next.done) break;
        total += next.value.byteLength; if (total > 65536) throw new Error(); chunks.push(next.value);
      }
      const value = record(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
      if (!Array.isArray(value?.keys) || value.keys.length > 32) throw new Error();
      return value.keys as unknown[];
    } catch { throw new Error("keys unavailable"); }
    finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => undefined); }
  };
}
