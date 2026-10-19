import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";
import { E2EApplicationExternalConnectionRefSchema, E2EApplicationHostPreparationBindingSchema,
  E2EApplicationServiceContractSchema, type E2EApplicationExternalConnectionRef } from "@agentx/contracts";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type AppRouteInput = { applicationId: string; serviceContract: unknown };
type LogicalRoute = { originRef: string; origin: string | null; mockComponentId?: string; externalConnectionRef?: E2EApplicationExternalConnectionRef };
export type E2EApplicationNormalizedRoute = Readonly<{ applicationId: string; originRef: string; origin: string | null; kind: "owned-service" | "mock" | "external";
  componentId: string | null; externalConnectionRef: E2EApplicationExternalConnectionRef | null; fixtureDigest: string | null; mockManifestDigest: string | null; routeDigest: string }>;

export function normalizeE2EApplicationOrigin(value: string): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("application origin is outside its bounds");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("application origin is not a URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hostname.includes("*")
    || parsed.hostname.includes("%") || parsed.hostname.endsWith(".")
    || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port === "0" || parsed.origin !== value) {
    throw new Error("application route must be a concrete canonical HTTP(S) origin");
  }
  return parsed.origin;
}

export function validateE2EApplicationNetworkRoutes(input: {
  binding: unknown; applications: readonly AppRouteInput[];
  originByApplicationId: readonly { applicationId: string; origins: readonly LogicalRoute[] }[];
  mockManifest: readonly { componentId: string; applicationId: string; originRef: string; fixtureDigest: string; mockManifestDigest: string }[];
  approvedExternalConnectionRefs: readonly E2EApplicationExternalConnectionRef[];
}): E2EApplicationNormalizedRoute[] {
  E2EApplicationHostPreparationBindingSchema.parse(input.binding);
  if (input.applications.length < 1 || input.applications.length > 12 || input.originByApplicationId.length !== input.applications.length) throw new Error("network route inventory differs from the exact application group");
  const apps = new Map(input.applications.map((item) => [item.applicationId, { ...item, serviceContract: E2EApplicationServiceContractSchema.parse(item.serviceContract) }]));
  if (apps.size !== input.applications.length) throw new Error("application network inventory contains duplicate application identities");
  const applicationOwnersByOriginRef = new Map<string, Set<string>>();
  for (const [applicationId, app] of apps) for (const route of app.serviceContract.originBindings) {
    const owners = applicationOwnersByOriginRef.get(route.originRef) ?? new Set<string>();
    owners.add(applicationId);
    applicationOwnersByOriginRef.set(route.originRef, owners);
  }
  const routesByApp = new Map(input.originByApplicationId.map((row) => [row.applicationId, row.origins]));
  if (routesByApp.size !== input.originByApplicationId.length || [...routesByApp.keys()].some((key) => !apps.has(key))) throw new Error("network origins contain a duplicate or foreign application");
  const mocks = new Map(input.mockManifest.map((item) => [`${item.applicationId}\0${item.originRef}\0${item.componentId}`, item]));
  if (mocks.size !== input.mockManifest.length) throw new Error("mock manifest contains duplicate route identities");
  const connections = input.approvedExternalConnectionRefs.map((item) => E2EApplicationExternalConnectionRefSchema.parse(item));
  const connectionKeys = new Set(connections.map((item) => `${item.connectionId}\0${item.revision}\0${item.originRef}\0${item.grantDigest}`));
  if (connectionKeys.size !== connections.length) throw new Error("approved external connection inventory contains duplicates");
  for (const connection of connections) if ((applicationOwnersByOriginRef.get(connection.originRef)?.size ?? 0) > 1) {
    throw new Error("external origin reference has multiple source application owners in this group");
  }
  const normalized: E2EApplicationNormalizedRoute[] = [];
  for (const [applicationId, app] of apps) {
    const declared = app.serviceContract.originBindings;
    const routes = routesByApp.get(applicationId) ?? [];
    if (routes.length !== declared.length) throw new Error("network route inventory omits or adds a source-declared logical origin");
    const routeMap = new Map(routes.map((route) => [route.originRef, route]));
    if (routeMap.size !== routes.length || declared.some((item) => !routeMap.has(item.originRef))) throw new Error("network routes do not match the exact source-declared origin references");
    for (const source of declared) {
      const route = routeMap.get(source.originRef)!;
      let kind: E2EApplicationNormalizedRoute["kind"] = "owned-service";
      let componentId: string | null = null;
      let fixtureDigest: string | null = null;
      let mockManifestDigest: string | null = null;
      let externalConnectionRef: E2EApplicationExternalConnectionRef | null = null;
      if (route.mockComponentId !== undefined) {
        const mock = mocks.get(`${applicationId}\0${source.originRef}\0${route.mockComponentId}`);
        if (!mock || !/^[a-f0-9]{64}$/.test(mock.fixtureDigest) || !/^[a-f0-9]{64}$/.test(mock.mockManifestDigest)) throw new Error("network mock route is not an exact source-approved installed fixture");
        kind = "mock"; componentId = mock.componentId; fixtureDigest = mock.fixtureDigest; mockManifestDigest = mock.mockManifestDigest;
      }
      if (route.externalConnectionRef !== undefined) {
        const connection = E2EApplicationExternalConnectionRefSchema.parse(route.externalConnectionRef);
        const key = `${connection.connectionId}\0${connection.revision}\0${connection.originRef}\0${connection.grantDigest}`;
        if (route.mockComponentId !== undefined || connection.originRef !== source.originRef || !connectionKeys.has(key)) throw new Error("external network route lacks its exact approved named connection grant");
        kind = "external"; componentId = connection.connectionId; externalConnectionRef = connection;
      }
      let origin: string | null;
      if (kind === "owned-service") {
        if (route.origin === null) throw new Error("owned source service route must bind its prepared concrete origin");
        origin = normalizeE2EApplicationOrigin(route.origin);
      } else {
        if (route.origin !== null) throw new Error("mock and external endpoint URLs are owned by the protected network allocator, not supplied by source or caller");
        origin = null;
      }
      const routeIdentity = { applicationId, originRef: source.originRef, origin, kind, componentId, externalConnectionRef, fixtureDigest, mockManifestDigest };
      normalized.push({ ...routeIdentity, routeDigest: sha(routeIdentity) });
    }
  }
  if (input.mockManifest.some((mock) => !normalized.some((route) => route.kind === "mock" && route.applicationId === mock.applicationId
    && route.originRef === mock.originRef && route.componentId === mock.componentId
    && route.fixtureDigest === mock.fixtureDigest && route.mockManifestDigest === mock.mockManifestDigest))) throw new Error("network mock manifest contains an unused or foreign route");
  return normalized.sort((a, b) => `${a.applicationId}\0${a.originRef}`.localeCompare(`${b.applicationId}\0${b.originRef}`));
}

export type E2EApplicationMockConsumptionExpectation = Readonly<{ caseId: string; targetId: string; componentId: string; mockManifestDigest: string; fixtureDigest: string }>;
export type E2EApplicationMockConsumptionReceipt = Readonly<{ runId: string; caseId: string; targetId: string; mockManifestDigest: string; componentId: string; fixtureDigest: string; requestId: string; responseStatus: number }>;
export function validateE2EApplicationNetworkObservation(input: {
  expectedRunId: string;
  expected: readonly E2EApplicationMockConsumptionExpectation[]; observedReceipts: readonly E2EApplicationMockConsumptionReceipt[];
  observedMockComponentIds: readonly string[]; requiredRealComponentIds: readonly string[]; observedRealComponentIds?: readonly string[];
}): { consumedMockComponentIds: string[]; unavailableComponentIds: string[] } {
  const expectedKeys = input.expected.map((item) => `${item.caseId}\0${item.targetId}\0${item.componentId}\0${item.mockManifestDigest}`);
  if (new Set(expectedKeys).size !== expectedKeys.length) throw new Error("mock consumption expectations contain duplicate case route bindings");
  if (!input.expectedRunId || input.expectedRunId.length > 120) throw new Error("mock consumption observations require the exact current run identity");
  if (input.expected.some((item) => !/^[a-f0-9]{64}$/.test(item.mockManifestDigest) || !/^[a-f0-9]{64}$/.test(item.fixtureDigest))) throw new Error("mock expectations lack exact manifest and fixture digests");
  const receiptKeys = input.observedReceipts.map((item) => `${item.runId}\0${item.caseId}\0${item.targetId}\0${item.componentId}\0${item.requestId}`);
  if (new Set(receiptKeys).size !== receiptKeys.length || input.observedReceipts.some((item) => !item.requestId || item.responseStatus < 100 || item.responseStatus > 599 || !/^[a-f0-9]{64}$/.test(item.fixtureDigest))) throw new Error("mock consumption receipt is malformed or reused");
  const consumed = new Set<string>();
  for (const receipt of input.observedReceipts) {
    if (receipt.runId !== input.expectedRunId || !input.expected.some((item) => item.caseId === receipt.caseId && item.targetId === receipt.targetId
      && item.componentId === receipt.componentId && item.mockManifestDigest === receipt.mockManifestDigest && item.fixtureDigest === receipt.fixtureDigest)) {
      throw new Error("mock consumption receipt is foreign to the exact run, case, target, manifest, or fixture");
    }
    consumed.add(receipt.componentId);
  }
  if (input.expected.some((item) => !input.observedReceipts.some((receipt) => receipt.runId === input.expectedRunId && receipt.caseId === item.caseId && receipt.targetId === item.targetId
    && receipt.componentId === item.componentId && receipt.mockManifestDigest === item.mockManifestDigest && receipt.fixtureDigest === item.fixtureDigest))) throw new Error("declared mock behavior has no independently observed consumption receipt");
  const reported = new Set(input.observedMockComponentIds);
  if (reported.size !== consumed.size || [...reported].some((component) => !consumed.has(component))) throw new Error("observed mock IDs must exactly match protected request/response consumption receipts");
  const real = new Set(input.observedRealComponentIds ?? []);
  const unavailableComponentIds = [...new Set(input.requiredRealComponentIds.filter((component) => !real.has(component)))].sort();
  return { consumedMockComponentIds: [...consumed].sort(), unavailableComponentIds };
}
