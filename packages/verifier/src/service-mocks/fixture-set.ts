// Service mocks (E8): how a request is keyed and found in a recorded fixture set. Shared by the server and the recorder so both address a request the same way.
import {
  SERVICE_MOCK_BODY_MAX_BYTES,
  ServiceMockFixtureSetSchema,
  serviceMockFixtureSetDigest,
  serviceMockRequestHash,
  type ServiceMockEntry,
  type ServiceMockFixtureSet,
} from "@agentx/contracts";

type Kind = ServiceMockFixtureSet["service"]["kind"];

/**
 * What a request is addressed to inside its service: the endpoint name for a SageMaker Runtime service (`/endpoints/{name}/invocations`), and the host plus path and query for every other kind. The host
 * is the service's own (from the approved environment), not the `Host` header the app happened to send to the mock.
 */
export function mockRequestTarget(kind: Kind, service: { target: string }, pathAndQuery: string): string {
  return kind === "sagemaker_runtime" ? service.target : `${service.target}${pathAndQuery}`;
}

/** `/endpoints/{name}/invocations`: the SageMaker Runtime InvokeEndpoint path. Undefined for any other path. */
export function sagemakerEndpointOfPath(path: string): string | undefined {
  const match = /^\/endpoints\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))\/invocations$/u.exec(path);
  return match?.[1];
}

export class FixtureSetRefused extends Error {
  constructor(readonly reason: "unreadable" | "digest_mismatch" | "additions_unpinned" | "additions_forged" | "additions_unsafe" | "request_lines_unknown") {
    super(`fixture set refused: ${reason}`);
    this.name = "FixtureSetRefused";
  }
}

/** A fixture set read for serving: it must parse, and hash to the digest the approved environment pinned (`mock.fixtureSetRef`). Anything else is refused. */
export function loadFixtureSet(raw: unknown, expectedDigest: string): ServiceMockFixtureSet {
  const parsed = ServiceMockFixtureSetSchema.safeParse(raw);
  if (!parsed.success) throw new FixtureSetRefused("unreadable");
  if (serviceMockFixtureSetDigest(parsed.data) !== expectedDigest) throw new FixtureSetRefused("digest_mismatch");
  return parsed.data;
}

export interface MockRequestParts { method: string; pathAndQuery: string; contentType: string; body: string }

export function hashOfRequest(set: ServiceMockFixtureSet, request: MockRequestParts): string {
  return serviceMockRequestHash({ service: set.service.kind, target: mockRequestTarget(set.service.kind, set.service, request.pathAndQuery), method: request.method, contentType: request.contentType, body: request.body });
}

export function indexEntries(set: ServiceMockFixtureSet): Map<string, ServiceMockEntry> {
  return new Map(set.entries.map((entry) => [entry.requestHash, entry]));
}

export const MOCK_BODY_MAX_BYTES = SERVICE_MOCK_BODY_MAX_BYTES;
