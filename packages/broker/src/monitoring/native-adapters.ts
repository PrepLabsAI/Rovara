// The monitoring adapters Code ships: Sentry, Datadog, Grafana, PagerDuty and Vercel, each over its own vendor's read-only API (the connector specs in `connectors/native`). Each is a
// `MonitoringAdapter` on the `monitoring` point, so the core knows no vendor: `connectionChecksFromRegistry` answers the connection store's checks from whatever adapters the registry holds
// (an adapter a plug-in registers is checked the same way). CloudWatch is not here: it is an AWS service, and Code's public AWS adapters are the storage, queue, object and secret ones only.
import {
  ConnectionSecretSchemas, OrgConnectionSchema, SecretValue, connectionTakesSecret,
  type AdapterRegistry, type ConnectionType, type JsonObject, type MonitoringAdapter, type MonitoringCheckInput, type MonitoringCheckResult, type ObservabilityConnectionType, type OrgConnection,
} from "@agentx/contracts";
import { DATADOG_SPEC, DATADOG_TOOLS } from "../connectors/native/datadog.js";
import { GRAFANA_SPEC, GRAFANA_TOOLS } from "../connectors/native/grafana.js";
import { PAGERDUTY_SPEC, PAGERDUTY_TOOLS } from "../connectors/native/pagerduty.js";
import { SENTRY_SPEC, SENTRY_TOOLS } from "../connectors/native/sentry.js";
import { VERCEL_SPEC, VERCEL_TOOLS } from "../connectors/native/vercel.js";
import { datadogConnectionCheck } from "../connectors/native/datadog-connector-type.js";
import { grafanaConnectionCheck } from "../connectors/native/grafana-connector-type.js";
import { pagerdutyConnectionCheck } from "../connectors/native/pagerduty-connector-type.js";
import { sentryConnectionCheck } from "../connectors/native/sentry-connector-type.js";
import { vercelConnectionCheck } from "../connectors/native/vercel-connector-type.js";
import type { CheckResult, ConnectionCheckInput, ConnectionChecks } from "../connections/store.js";
import type { NativeTool } from "../connectors/native/runtime.js";

type Check = (input: never) => Promise<CheckResult & { actorId?: string }>;

/** The saved secret of a kind, in the shape its type takes; undefined for a kind that has none or a value that is not that shape. */
function secretOf(kind: ConnectionType, value: SecretValue | undefined): ReturnType<(typeof ConnectionSecretSchemas)[keyof typeof ConnectionSecretSchemas]["parse"]> | undefined {
  if (value === undefined || !connectionTakesSecret(kind)) return undefined;
  let json: unknown;
  try { json = JSON.parse(value.reveal()); } catch { return undefined; }
  const parsed = ConnectionSecretSchemas[kind].safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function adapterOf(input: { kind: ObservabilityConnectionType; vendor: string; takesSecret: boolean; tools: readonly NativeTool<never>[]; check: Check }): MonitoringAdapter {
  return {
    kind: input.kind, vendor: input.vendor, readOnly: true, takesSecret: input.takesSecret,
    tools: () => input.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as JsonObject })),
    async check(request: MonitoringCheckInput): Promise<MonitoringCheckResult> {
      const parsed = OrgConnectionSchema.safeParse(request.settings);
      if (!parsed.success || parsed.data.type !== input.kind) return { ok: false, message: `these are not the settings of a ${input.vendor} connection` };
      const secret = secretOf(input.kind, request.secret);
      if (input.takesSecret && secret === undefined) return { ok: false, message: "the saved secret could not be read; save it again" };
      const answer = await input.check({ orgId: request.companyId, connection: parsed.data, secret, fetch: request.fetch } as never);
      return { ok: answer.ok, ...(answer.message === undefined ? {} : { message: answer.message }), ...(answer.actorId === undefined ? {} : { accountId: answer.actorId }) };
    },
  };
}

/** The adapters that need no access beyond the vendor's own API. */
export function nativeMonitoringAdapters(): MonitoringAdapter[] {
  return [
    adapterOf({ kind: "sentry", vendor: SENTRY_SPEC.vendor, takesSecret: true, tools: SENTRY_TOOLS, check: sentryConnectionCheck }),
    adapterOf({ kind: "datadog", vendor: DATADOG_SPEC.vendor, takesSecret: true, tools: DATADOG_TOOLS, check: datadogConnectionCheck }),
    adapterOf({ kind: "grafana", vendor: GRAFANA_SPEC.vendor, takesSecret: true, tools: GRAFANA_TOOLS, check: grafanaConnectionCheck }),
    adapterOf({ kind: "pagerduty", vendor: PAGERDUTY_SPEC.vendor, takesSecret: true, tools: PAGERDUTY_TOOLS, check: pagerdutyConnectionCheck }),
    adapterOf({ kind: "vercel", vendor: VERCEL_SPEC.vendor, takesSecret: true, tools: VERCEL_TOOLS, check: vercelConnectionCheck }),
  ];
}

/** Registers the adapters on the `monitoring` point, each under its kind. A kind that is already registered (a plug-in's own) is left alone. */
export function registerNativeMonitoring(registry: AdapterRegistry, adapters: readonly MonitoringAdapter[] = nativeMonitoringAdapters()): void {
  for (const adapter of adapters) if (registry.get("monitoring", adapter.kind) === undefined) registry.register("monitoring", adapter.kind, adapter);
}

/** The connection store's checks, answered by the adapters the registry holds: a kind with no adapter is "not available". */
export function connectionChecksFromRegistry(registry: Pick<AdapterRegistry, "get">): ConnectionChecks {
  const checks: Record<string, (input: ConnectionCheckInput) => Promise<CheckResult & { actorId?: string }>> = {};
  for (const kind of ["sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"] as const) {
    checks[kind] = async (input) => {
      const adapter = registry.get("monitoring", kind);
      if (adapter === undefined) return { ok: false, message: `checking a ${kind} connection is not available on this install` };
      const answer = await adapter.check({
        companyId: input.orgId, settings: input.connection as unknown as JsonObject,
        secret: input.secret === undefined ? undefined : new SecretValue(JSON.stringify(input.secret)), fetch: input.fetch,
      });
      return { ok: answer.ok, ...(answer.message === undefined ? {} : { message: answer.message }), ...(answer.accountId === undefined ? {} : { actorId: answer.accountId }) };
    };
  }
  return checks;
}

export type { OrgConnection };
