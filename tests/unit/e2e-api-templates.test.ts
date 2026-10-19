import { describe, expect, it } from "vitest";
import { E2E_API_ACTION_TEMPLATES, resolveE2EApiTemplateAction } from "../../packages/verifier/src/api-templates.js";

describe("fixed API action templates", () => {
  it("binds state and auth probes to fixed relative-path operations", () => {
    expect(resolveE2EApiTemplateAction({ templateId: "api-state-positive/v1", actionId: "read-orders-state" })).toMatchObject({
      kind: "state-read", path: "/api/orders/state", method: "GET", relativeOnly: true,
    });
    expect(E2E_API_ACTION_TEMPLATES["api-auth-viewer-refusal/v1"]?.some((item) => item.kind === "assert-status" && item.expectedStatus === 403)).toBe(true);
  });

  it("rejects arbitrary paths, methods, headers, scripts, and caller expectations", () => {
    expect(() => resolveE2EApiTemplateAction({ templateId: "api-state-positive/v1", actionId: "read-orders-state", url: "https://outside.test", headers: { Authorization: "x" } } as never)).toThrow();
    expect(() => resolveE2EApiTemplateAction({ templateId: "api-state-positive/v1", actionId: "caller-picked" })).toThrow();
    expect(() => resolveE2EApiTemplateAction({ templateId: "unreviewed/v1", actionId: "read-orders-state" } as never)).toThrow();
  });

  it("does not use a candidate-controlled endpoint as egress proof", () => {
    expect(resolveE2EApiTemplateAction({ templateId: "api-egress-denial/v1", actionId: "assert-egress-denial" }))
      .toMatchObject({ kind: "network-observation", path: null, method: null });
  });
});
