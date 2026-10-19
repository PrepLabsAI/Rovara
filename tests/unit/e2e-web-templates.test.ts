import { describe, expect, it } from "vitest";
import { E2E_WEB_ACTION_TEMPLATES, resolveE2EWebTemplateAction } from "../../packages/verifier/src/web-templates.js";

describe("fixed web action templates", () => {
  it("binds approved probes to fixed same-page test IDs and operation kinds", () => {
    const download = resolveE2EWebTemplateAction({ templateId: "web-csv-positive/v1", actionId: "download-orders" });
    expect(download).toMatchObject({ kind: "download", testId: "download-orders", sameOwnedPage: true });
    expect(E2E_WEB_ACTION_TEMPLATES["web-auth-viewer-refusal/v1"]?.some((item) => item.kind === "assert-refusal")).toBe(true);
  });

  it("does not accept caller supplied selectors, scripts, URLs, or unknown actions", () => {
    expect(() => resolveE2EWebTemplateAction({ templateId: "web-csv-positive/v1", actionId: "download-orders", selector: "body", evaluate: "fetch('/')" } as never)).toThrow();
    expect(() => resolveE2EWebTemplateAction({ templateId: "web-csv-positive/v1", actionId: "arbitrary" })).toThrow();
    expect(() => resolveE2EWebTemplateAction({ templateId: "unreviewed/v1", actionId: "download-orders" } as never)).toThrow();
  });

  it("binds egress probes to protected network observations rather than app UI text", () => {
    expect(resolveE2EWebTemplateAction({ templateId: "web-egress-denial/v1", actionId: "assert-network-denial" }))
      .toMatchObject({ kind: "network-observation", testId: null });
  });
});
