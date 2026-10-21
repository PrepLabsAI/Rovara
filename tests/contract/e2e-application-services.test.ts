import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import {
  E2EApplicationExternalConnectionRefSchema,
  E2EApplicationHostPreparationBindingSchema,
  E2EApplicationPreparedEnvironmentSchema,
  E2EApplicationServiceContractSchema,
  e2eApiSchemaComponentId,
  e2eApplicationPreparedEnvironmentDigest,
} from "../../packages/contracts/src/e2e-application-services.js";

const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const id = () => "11111111-1111-4111-8111-111111111111";
const preparation = () => ({
  schemaVersion: "e2e-application-host-preparation/v1" as const, preparationId: id(), taskId: id(), workspaceId: id(), operationId: id(), operationFence: 2,
  workflowRevision: 3, candidateDigest: "a".repeat(64), planDigest: "b".repeat(64), intentDigest: "c".repeat(64), groupId: "group-orders",
  runtimeProfileId: "linux-web-api/v1", runtimeManifestDigest: "d".repeat(64), networkPolicyDigest: "e".repeat(64),
  admittedAt: "2026-10-17T12:00:00.000Z", preparationDeadlineAt: "2026-10-17T12:02:00.000Z", deadlineAt: "2026-10-17T12:05:00.000Z",
});
const processIdentity = { containerId: "container-1", pid: 42, startTime: "2026-10-17T12:00:30.000Z", namespaceId: "netns-1", incarnation: "launch-1" };

describe("application service and preparation contracts", () => {
  it("bounds service ports, origins, and protected environment bindings", () => {
    const valid = { listenPort: 4317, portEnv: "APP_PORT", originBindings: [{ originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }] };
    expect(E2EApplicationServiceContractSchema.parse(valid)).toEqual(valid);
    expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, listenPort: 80 })).toThrow();
    expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, originBindings: [{ originRef: "orders-api", envName: "AWS_SECRET_ACCESS_KEY" }] })).toThrow();
    expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, originBindings: [{ originRef: "orders-api", envName: "lowercase_url" }] })).toThrow();
    expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, executable: "node -e doBadThing" })).toThrow();
  });

  it("links an origin to its API contract by an optional repository-relative contractPath, and the link is the discovery component id", () => {
    const valid = { listenPort: 4317, portEnv: "APP_PORT", originBindings: [{ originRef: "inventory-v1", envName: "INVENTORY_ORIGIN", contractPath: "inventory/openapi.json" },
      { originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }] };
    expect(E2EApplicationServiceContractSchema.parse(valid)).toEqual(valid);
    expect(e2eApiSchemaComponentId("inventory/openapi.json")).toBe(`api-schema-${sha256Of("inventory/openapi.json").slice(0, 12)}`);
    for (const contractPath of ["/etc/passwd", "../openapi.json", "inventory/../openapi.json", "inventory//openapi.json", "", "a".repeat(513), "inventory/open api.json", "inventory\\openapi.json"]) {
      expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, originBindings: [{ originRef: "inventory-v1", envName: "INVENTORY_ORIGIN", contractPath }] }), contractPath).toThrow();
    }
    expect(() => E2EApplicationServiceContractSchema.parse({ ...valid, originBindings: [{ originRef: "a", envName: "A_ORIGIN", contractPath: "x/openapi.json" },
      { originRef: "b", envName: "B_ORIGIN", contractPath: "x/openapi.json" }] })).toThrow(/contract/);
  });

  it("requires strict named external connection references", () => {
    const value = { connectionId: "orders-test", revision: 2, originRef: "orders-api", grantDigest: "f".repeat(64) };
    expect(E2EApplicationExternalConnectionRefSchema.parse(value)).toEqual(value);
    expect(() => E2EApplicationExternalConnectionRefSchema.parse({ ...value, url: "https://example.test" })).toThrow();
    expect(() => E2EApplicationExternalConnectionRefSchema.parse({ ...value, revision: 0 })).toThrow();
  });

  it("keeps preparation inside its original admission and overall deadlines", () => {
    expect(E2EApplicationHostPreparationBindingSchema.parse(preparation())).toEqual(preparation());
    expect(() => E2EApplicationHostPreparationBindingSchema.parse({ ...preparation(), preparationDeadlineAt: "2026-10-17T12:06:00.000Z" })).toThrow();
    expect(() => E2EApplicationHostPreparationBindingSchema.parse({ ...preparation(), admittedAt: "2026-10-17T12:03:00.000Z" })).toThrow();
  });

  it("binds prepared origins, leases, process incarnation, and evidence references into one digest", () => {
    const base = {
      preparation: preparation(), authorityDigest: "1".repeat(64), networkLeaseId: "network-lease-1",
      services: [{ leaseId: "service-lease-1", applicationId: "apps/orders", origin: "http://127.0.0.1:4317", processIdentity,
        buildManifestDigest: "2".repeat(64), artifactSha256: "3".repeat(64), recipeDigest: "4".repeat(64) }],
      originByApplicationId: [{ applicationId: "apps/orders", origin: "http://127.0.0.1:4317" }],
      receiptRefs: [{ artifactId: "service-ready", sha256: "5".repeat(64), byteLength: 12, mediaType: "application/json" }],
    };
    const prepared = { ...base, preparedDigest: e2eApplicationPreparedEnvironmentDigest(base) };
    expect(E2EApplicationPreparedEnvironmentSchema.parse(prepared)).toEqual(prepared);
    expect(() => E2EApplicationPreparedEnvironmentSchema.parse({ ...prepared, originByApplicationId: [] })).toThrow();
    expect(() => E2EApplicationPreparedEnvironmentSchema.parse({ ...prepared,
      services: [{ ...prepared.services[0]!, origin: "http://*.example.test" }], originByApplicationId: [{ applicationId: "apps/orders", origin: "http://*.example.test" }],
      preparedDigest: e2eApplicationPreparedEnvironmentDigest({ ...base, services: [{ ...base.services[0]!, origin: "http://*.example.test" }], originByApplicationId: [{ applicationId: "apps/orders", origin: "http://*.example.test" }] }) })).toThrow();
    expect(() => E2EApplicationPreparedEnvironmentSchema.parse({ ...prepared, preparedDigest: sha({ ...base, originByApplicationId: [] }) })).toThrow();
    expect(e2eApplicationPreparedEnvironmentDigest({ ...base, originByApplicationId: [] })).not.toBe(prepared.preparedDigest);
  });
});
