// The conformance suite every `monitoring` adapter must pass: the fake, each adapter Code ships, and a hosted install's own adapters later. The harness says how the
// vendor answers (a fetch for "works", one for "refused") and which origin the check may reach.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginNameSchema, SecretValue, type JsonObject, type MonitoringAdapter } from "@agentx/contracts";

export interface MonitoringUnderTest {
  adapter: MonitoringAdapter;
  companyId?: string;
  /** The connection's settings, as saved (never its secret). */
  settings: JsonObject;
  /** The secret as the connection keeps it (the adapter reads it as a `SecretValue`), for a kind that takes one. */
  secret?: string;
  /** The vendor's origin(s) the check may ask. */
  origins: readonly string[];
  /** A vendor that says the connection works. */
  works: typeof fetch;
  /** A vendor that refuses the secret. */
  refuses: typeof fetch;
}

export interface MonitoringHarness {
  create(): Promise<MonitoringUnderTest>;
}

export function runMonitoringConformance(name: string, harness: MonitoringHarness): void {
  describe(`monitoring conformance: ${name}`, () => {
    const outside = vi.fn(async () => { throw new Error("an adapter used a fetch it was not given"); });
    beforeEach(() => { vi.stubGlobal("fetch", outside); });
    afterEach(() => { vi.unstubAllGlobals(); outside.mockClear(); });

    const inputOf = (under: MonitoringUnderTest, fetchImplementation: typeof fetch) => ({
      companyId: under.companyId ?? "org_00000000000000000000",
      settings: under.settings,
      secret: under.secret === undefined ? undefined : new SecretValue(under.secret),
      fetch: fetchImplementation,
    });

    it("is read-only, names its kind as a plug-in name, and offers tools with unique names and closed arguments", async () => {
      const { adapter } = await harness.create();
      expect(adapter.readOnly).toBe(true);
      expect(PluginNameSchema.safeParse(adapter.kind).success).toBe(true);
      expect(adapter.vendor.length).toBeGreaterThan(0);
      const tools = adapter.tools();
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      }
    });

    it("answers ok when the vendor says the connection works, asking only the vendor's origin through the fetch it is given", async () => {
      const under = await harness.create();
      const asked: string[] = [];
      const answer = await under.adapter.check(inputOf(under, async (input, init) => {
        asked.push(String(input instanceof Request ? input.url : input));
        return under.works(input, init);
      }));
      expect(answer.ok).toBe(true);
      expect(asked.length).toBeGreaterThan(0);
      for (const url of asked) expect(under.origins).toContain(new URL(url).origin);
      expect(outside).not.toHaveBeenCalled();
    });

    it("answers a refusal as { ok: false } in words that never quote the secret", async () => {
      const under = await harness.create();
      const answer = await under.adapter.check(inputOf(under, under.refuses));
      expect(answer.ok).toBe(false);
      if (under.secret !== undefined) expect(JSON.stringify(answer)).not.toContain(under.secret);
      expect(outside).not.toHaveBeenCalled();
    });

    it("never answers ok when the vendor cannot be reached, and never quotes the secret in a fault", async () => {
      const under = await harness.create();
      const failure = await under.adapter.check(inputOf(under, async () => { throw new TypeError("fetch failed"); })).catch((error: unknown) => error);
      if (failure instanceof Error) {
        if (under.secret !== undefined) expect(failure.message).not.toContain(under.secret);
      } else {
        expect((failure as { ok: boolean }).ok).toBe(false);
      }
    });

    it("refuses without asking the vendor when a kind that takes a secret has none", async () => {
      const under = await harness.create();
      if (!under.adapter.takesSecret) return;
      const asked = vi.fn(under.works);
      const answer = await under.adapter.check({ ...inputOf(under, asked), secret: undefined });
      expect(answer.ok).toBe(false);
      expect(asked).not.toHaveBeenCalled();
    });
  });
}
