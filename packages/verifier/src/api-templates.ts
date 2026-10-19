export type E2EApiTemplateAction = Readonly<{ actionId: string; kind: "request" | "state-read" | "assert-status" | "assert-json" | "assert-denial" | "network-observation"; path: string | null; method: "GET" | "POST" | null; expectedStatus?: number; relativeOnly: true }>;
const apiTemplates = {
  "api-state-positive/v1": [
    { actionId: "read-orders-state", kind: "state-read", path: "/api/orders/state", method: "GET", expectedStatus: 200, relativeOnly: true },
    { actionId: "assert-orders-state", kind: "assert-json", path: "/api/orders/state", method: "GET", expectedStatus: 200, relativeOnly: true },
  ],
  "api-auth-viewer-refusal/v1": [
    { actionId: "read-viewer-orders", kind: "request", path: "/api/orders", method: "GET", expectedStatus: 403, relativeOnly: true },
    { actionId: "assert-viewer-refusal", kind: "assert-status", path: "/api/orders", method: "GET", expectedStatus: 403, relativeOnly: true },
  ],
  "api-tenant-negative/v1": [
    { actionId: "read-foreign-tenant", kind: "request", path: "/api/tenants/foreign/orders", method: "GET", expectedStatus: 403, relativeOnly: true },
    { actionId: "assert-tenant-refusal", kind: "assert-denial", path: "/api/tenants/foreign/orders", method: "GET", expectedStatus: 403, relativeOnly: true },
  ],
  "api-egress-denial/v1": [
    { actionId: "assert-egress-denial", kind: "network-observation", path: null, method: null, relativeOnly: true },
  ],
} as const satisfies Record<string, readonly E2EApiTemplateAction[]>;
for (const actions of Object.values(apiTemplates)) { for (const action of actions) Object.freeze(action); Object.freeze(actions); }
export const E2E_API_ACTION_TEMPLATES: Readonly<typeof apiTemplates> = Object.freeze(apiTemplates);
export type E2EApiTemplateId = keyof typeof apiTemplates;
export function resolveE2EApiTemplateAction(input: { templateId: E2EApiTemplateId; actionId: string }): E2EApiTemplateAction;
export function resolveE2EApiTemplateAction(input: unknown): E2EApiTemplateAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("API template action binding must be an ordinary record");
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "templateId" && key !== "actionId") || typeof row.templateId !== "string" || typeof row.actionId !== "string") throw new Error("API template action cannot carry caller-selected URLs, headers, body, or expectations");
  const actions = apiTemplates[row.templateId as E2EApiTemplateId];
  const action = actions?.find((item) => item.actionId === row.actionId);
  if (!action) throw new Error("API template action is not installed for the exact probe");
  return action;
}
