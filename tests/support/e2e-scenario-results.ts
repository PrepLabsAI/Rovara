import { createHash } from "node:crypto";
import type { E2EDisplayScenario, E2EScenarioResults } from "@agentx/contracts";

/** Rows as the broker derives them, for the tests of what the page, Slack and the artifact route do with them. */
export const SHOT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x42)]);
export const SHOT_SHA = createHash("sha256").update(SHOT).digest("hex");
export const OTHER_SHOT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(256, 0x43)]);
export const OTHER_SHOT_SHA = createHash("sha256").update(OTHER_SHOT).digest("hex");

export const row = (overrides: Partial<E2EDisplayScenario> = {}): E2EDisplayScenario => ({
  scenarioId: "owner-export", title: "Owner export", kind: "web", accountLabel: "orders-owner", status: "PASSED", mockedOrigins: [], ...overrides,
});

export const failedViewerRow = (): E2EDisplayScenario => row({
  scenarioId: "viewer-cant-export", title: "Viewer can't export", accountLabel: "orders-viewer", status: "FAILED", reason: "expected hidden, was visible",
  failedAssertion: { kind: "visible", expected: "hidden", actual: "visible" }, screenshotRef: { sha256: SHOT_SHA, bytes: SHOT.byteLength, contentType: "image/jpeg" },
});

/** Five scenarios: four passed, one failed (the viewer can export), the inventory origin mocked where the owner export reads it. */
export const fiveScenarios = (): E2EDisplayScenario[] => [
  row({ mockedOrigins: ["inventory-v1"] }),
  failedViewerRow(),
  row({ scenarioId: "tenant-isolation", title: "Tenant isolation", kind: "api" }),
  row({ scenarioId: "owner-sees-orders", title: "Owner sees orders" }),
  row({ scenarioId: "signed-out-visitor", title: "Signed out visitor", accountLabel: "anonymous" }),
];

export const results = (overrides: Partial<E2EScenarioResults> = {}): E2EScenarioResults => ({ scenarios: fiveScenarios(), ...overrides });

/** The baseline of the example in the plan: two of five failed on the unchanged code. */
export const failedBaseline = (): NonNullable<E2EScenarioResults["baseline"]> => ({
  status: "FAILED",
  scenarios: [
    row({ status: "FAILED", reason: "expected 2 rows, received 3", failedAssertion: { kind: "csv", expected: "2 rows", actual: "3 rows" },
      screenshotRef: { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT.byteLength, contentType: "image/jpeg" } }),
    failedViewerRow(),
    row({ scenarioId: "tenant-isolation", title: "Tenant isolation", kind: "api" }),
    row({ scenarioId: "owner-sees-orders", title: "Owner sees orders" }),
    row({ scenarioId: "signed-out-visitor", title: "Signed out visitor", accountLabel: "anonymous" }),
  ],
});
