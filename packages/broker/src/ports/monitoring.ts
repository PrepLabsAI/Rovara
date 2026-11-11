// The `monitoring` point: a fake adapter for tests (the conformance suite, and tests of the connection checks that need an adapter that answers on cue). Code's own
// adapters (Sentry, Datadog, Grafana, PagerDuty, Vercel) are `monitoring/native-adapters.ts`, registered by `rovara up`.
import type { MonitoringAdapter, MonitoringCheckResult, MonitoringToolInfo } from "@agentx/contracts";

export interface FakeMonitoringOptions {
  kind?: string;
  vendor?: string;
  takesSecret?: boolean;
  /** The vendor's address the check asks (through the fetch it is given). */
  origin?: string;
  tools?: readonly MonitoringToolInfo[];
}

/**
 * A fake vendor: its check asks `<origin>/whoami` through the fetch it is given and answers ok on a 2xx (with the account id the body names), `{ ok: false }` on a 4xx, and
 * throws on anything else (a fault). It never quotes the secret.
 */
export function createFakeMonitoringAdapter(options: FakeMonitoringOptions = {}): MonitoringAdapter {
  const origin = options.origin ?? "https://monitoring.example.test";
  const takesSecret = options.takesSecret ?? true;
  const tools = options.tools ?? [{ name: "list_alerts", description: "Lists open alerts.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } }];
  return {
    kind: options.kind ?? "fakewatch",
    vendor: options.vendor ?? "Fake Watch",
    readOnly: true,
    takesSecret,
    tools: () => tools.map((tool) => structuredClone(tool)),
    async check(input): Promise<MonitoringCheckResult> {
      if (takesSecret && input.secret === undefined) return { ok: false, message: "no secret is saved for this connection" };
      const headers: Record<string, string> = input.secret === undefined ? {} : { authorization: `Bearer ${input.secret.reveal()}` };
      const response = await input.fetch(`${origin}/whoami`, { method: "GET", headers, redirect: "manual" });
      if (response.status >= 200 && response.status < 300) {
        const body = await response.json().catch(() => ({})) as { account?: unknown };
        return { ok: true, ...(typeof body.account === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(body.account) ? { accountId: body.account } : {}) };
      }
      if (response.status >= 400 && response.status < 500) return { ok: false, message: "the vendor refused the saved secret" };
      throw new Error("the vendor could not be reached");
    },
  };
}
