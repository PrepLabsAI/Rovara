// a Sentry or Datadog connection check goes out over the same lookup-checked fetch as the tools (`safeVendorFetch`), not the global
// one, so a vendor name that ever resolved to a private address is refused when the check connects, token and all. The fetch is replaced here by a recording
// one, so no network is reached; the global fetch throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "../../packages/contracts/src/index.js";
import { datadogConnectionCheck } from "../../packages/core/src/connectors/native/datadog-connector-type.js";
import { sentryConnectionCheck } from "../../packages/core/src/connectors/native/sentry-connector-type.js";
import { OrgConnectionStore } from "../../packages/core/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";

const seen = vi.hoisted(() => ({ urls: [] as string[], made: 0 }));

vi.mock("../../packages/core/src/connectors/native/vendor-fetch.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    safeVendorFetch: () => {
      seen.made += 1;
      return (async (input: string | URL | Request) => { seen.urls.push(String(input instanceof Request ? input.url : input)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    },
  };
});

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);

beforeEach(() => { seen.urls.length = 0; seen.made = 0; vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used by a connection check"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function store(checks: NonNullable<ConstructorParameters<typeof OrgConnectionStore>[0]["checks"]>) {
  const secrets = new InMemoryConnectionSecrets("staging");
  // No `fetch` is given: the vendor types' checks use the connectors' own safe fetch.
  return new OrgConnectionStore({ store: memoryStore(), env: "staging", secrets, now: () => Date.now(), checkEndpoint: async () => undefined, checks });
}

describe("a connection check's fetch when none is injected (review M-4)", () => {
  it("is the lookup-checked vendor fetch for Sentry, held to the region's host", async () => {
    const s = store({ sentry: sentryConnectionCheck });
    await s.put({ orgId: ORG_A, connection: { connectionId: CON, type: "sentry", label: "Sentry", access: "read", region: "de", orgSlug: "acme" }, secret: { authToken: "sntrys_SENTRYTESTTOKEN0123456789" }, by: ALICE });
    expect(await s.check(ORG_A, CON)).toEqual({ ok: true });
    expect(seen.made).toBe(1);
    expect(seen.urls).toEqual(["https://de.sentry.io/api/0/organizations/acme/"]);
  });

  it("is the same for Datadog, at the site's host", async () => {
    const s = store({ datadog: datadogConnectionCheck });
    await s.put({ orgId: ORG_A, connection: { connectionId: CON, type: "datadog", label: "Datadog", access: "read", site: "datadoghq.eu" }, secret: { apiKey: ["dd", "api", "key", "x".repeat(16)].join("-"), appKey: ["dd", "app", "key", "x".repeat(16)].join("-") }, by: ALICE });
    expect(await s.check(ORG_A, CON)).toEqual({ ok: true });
    expect(seen.urls.map((url) => new URL(url).hostname)).toEqual(["api.datadoghq.eu", "api.datadoghq.eu"]);
  });
});
