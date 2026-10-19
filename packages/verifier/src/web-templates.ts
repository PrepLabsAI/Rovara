export type E2EWebTemplateAction = Readonly<{ actionId: string; kind: "open" | "fill" | "click" | "reload" | "download" | "assert-refusal" | "assert-visible" | "assert-text" | "choose-file" | "network-observation"; testId: string | null; sameOwnedPage: true }>;
const webTemplates = {
  "web-csv-positive/v1": [
    { actionId: "open-orders", kind: "open", testId: null, sameOwnedPage: true },
    { actionId: "download-orders", kind: "download", testId: "download-orders", sameOwnedPage: true },
    { actionId: "assert-orders-csv", kind: "assert-text", testId: "orders-export-status", sameOwnedPage: true },
  ],
  "web-auth-viewer-refusal/v1": [
    { actionId: "open-orders", kind: "open", testId: null, sameOwnedPage: true },
    { actionId: "assert-viewer-refusal", kind: "assert-refusal", testId: "orders-access-error", sameOwnedPage: true },
  ],
  "web-csv-negative/v1": [
    { actionId: "open-orders", kind: "open", testId: null, sameOwnedPage: true },
    { actionId: "download-orders", kind: "download", testId: "download-orders", sameOwnedPage: true },
    { actionId: "assert-extra-row", kind: "assert-text", testId: "orders-export-status", sameOwnedPage: true },
  ],
  "web-egress-denial/v1": [
    { actionId: "assert-network-denial", kind: "network-observation", testId: null, sameOwnedPage: true },
  ],
} as const satisfies Record<string, readonly E2EWebTemplateAction[]>;
for (const actions of Object.values(webTemplates)) { for (const action of actions) Object.freeze(action); Object.freeze(actions); }
export const E2E_WEB_ACTION_TEMPLATES: Readonly<typeof webTemplates> = Object.freeze(webTemplates);
export type E2EWebTemplateId = keyof typeof webTemplates;
export function resolveE2EWebTemplateAction(input: { templateId: E2EWebTemplateId; actionId: string }): E2EWebTemplateAction;
export function resolveE2EWebTemplateAction(input: unknown): E2EWebTemplateAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("web template action binding must be an ordinary record");
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "templateId" && key !== "actionId") || typeof row.templateId !== "string" || typeof row.actionId !== "string") throw new Error("web template action cannot carry caller-selected selectors, scripts, or endpoints");
  const actions = webTemplates[row.templateId as E2EWebTemplateId];
  const action = actions?.find((item) => item.actionId === row.actionId);
  if (!action) throw new Error("web template action is not installed for the exact probe");
  return action;
}
