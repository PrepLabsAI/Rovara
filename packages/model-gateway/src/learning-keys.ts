// The LearningKeySource adapter (DEC 226, learning-route.ts): the company's OWN connected learning accounts (Anthropic, OpenAI,
// Gemini on AI Studio), held in the product key store's learning document (LEARNING_OWNER; sealed like the product keys: KMS
// envelope bound to install, company, owner, source and version; read only at the AWSCURRENT stage). A company admin connects,
// rotates and removes them through Cloud's "Learning AI key" settings (cloud-server learning-ai-routes.ts); a project never holds
// one and can never link to one (product-keys.ts). Each provider is answered only by ITS account: a company with only Anthropic
// connected is not connected for OpenAI or Gemini, and Vertex learning is not connectable here (never connected).
import { parseEndpointConnect } from "./endpoint-source.js";
import type { CompanyKeyProvider, LearningKeySource } from "./learning-route.js";
import { LEARNING_KEY_PROVIDERS, type LearningKeyProvider, type ProductKeyStore } from "./product-keys.js";

const connectable = (provider: CompanyKeyProvider): provider is LearningKeyProvider => LEARNING_KEY_PROVIDERS.some((p) => p === provider);

export function storedLearningKeys(store: Pick<ProductKeyStore, "learningSource" | "companyBedrock" | "useKey" | "recordWarning">): LearningKeySource {
  return {
    async bedrockConnected(iss, cid) { return (await store.companyBedrock(iss, cid)) !== undefined; },
    async resolveForCharge(iss, cid, provider) {
      if (!connectable(provider)) return undefined;
      const saved = await store.learningSource(iss, cid, provider);
      if (saved === undefined) return undefined;
      return {
        source: { kind: "company_key", id: saved.sourceId, name: `Company ${provider}`, provider, connectionRevision: saved.versionId },
        key: () => store.useKey(iss, cid, saved),
      };
    },
    async endpointMetadata(iss, cid) {
      const saved = await store.learningSource(iss, cid, "endpoint");
      if (saved === undefined) return undefined;
      const text = await store.useKey(iss, cid, saved);
      if (text === undefined) return undefined;
      const connection = parseEndpointConnect(text);
      if (connection === undefined) throw new Error("endpoint connection unreadable");
      return { sourceId: saved.sourceId, versionId: saved.versionId, models: connection.models };
    },
    async identityFor(iss, cid, provider) {
      const source = await store.learningSource(iss, cid, provider);
      return source === undefined ? undefined : { sourceId: source.sourceId, versionId: source.versionId };
    },
    async connected(iss, cid, provider) { return connectable(provider) && (await store.learningSource(iss, cid, provider)) !== undefined; },
    async keyFor(iss, cid, provider) {
      if (!connectable(provider)) return undefined;
      const source = await store.learningSource(iss, cid, provider);
      return source === undefined ? undefined : store.useKey(iss, cid, source);
    },
    // The provider refused the account: shown on the settings page ("Learning AI key"). Never changes the call; never throws.
    async refused(iss, cid, provider) {
      if (!connectable(provider)) return;
      try {
        const source = await store.learningSource(iss, cid, provider);
        if (source !== undefined) await store.recordWarning(iss, cid, source, 401);
      } catch { /* A warning never changes a call. */ }
    },
  };
}
