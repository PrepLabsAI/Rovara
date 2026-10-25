import { canonicalJson, e2eApiSchemaComponentId, type E2EApiMockFixture, type E2EApplicationServiceContract, type E2EMockSpec } from "@agentx/contracts";

/** The port every mock and the sinkhole listen on, inside the run's `--internal` network. */
export const MOCK_ORIGIN_PORT = 8080;
/** The logical name of the sinkhole (`mock-unbound`): the one origin that has no fixture. */
export const SINKHOLE_ORIGIN_REF = "unbound";
/** The logical names a mock container can carry in its name, its network alias and its ledger file. */
const SAFE_ORIGIN_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
/** Each mock is a container of its own, so a run serves at most this many; a plan with more cannot run. */
export const MAX_MOCKED_ORIGINS = 8;

export type MockedApplicationOrigin = Readonly<{ originRef: string; envName: string; componentId: string; fixture: E2EApiMockFixture }>;
export type UnboundApplicationOrigin = Readonly<{ originRef: string; envName: string }>;
export type ApplicationOriginPlan = Readonly<{
  /** Declared origins that an approved mock serves in this run, one per mock component. */
  mocked: readonly MockedApplicationOrigin[];
  /** Declared origins with no approved mock: the sinkhole answers for them. */
  unbound: readonly UnboundApplicationOrigin[];
  /** Approved mocks that no declared origin claims through its `contractPath`. The Docker host refuses a run with any; an executor-request mock (no origin) is judged by its request steps instead. */
  unplaced: readonly E2EMockSpec[];
}>;

/** The hostname the app is given for an origin: always one of this run's own containers, never a real host. */
export const mockOriginHost = (originRef: string): string => `mock-${originRef}`;
export const mockOriginUrl = (originRef: string): string => `http://${mockOriginHost(originRef)}:${MOCK_ORIGIN_PORT}`;

/**
 * Which declared origins an approved mock serves and which have none. An approved API fixture is linked to its origin by the origin's `contractPath`: the discovery component
 * of that document is the mock's component. One origin served by two different fixtures, an origin name that cannot be a container name, and a mock of a kind a run cannot
 * serve are refused, so a run never starts with a mock it cannot place. Every declared origin that no mock serves is unbound and belongs to the sinkhole.
 */
export function planApplicationOrigins(input: Readonly<{ originBindings: E2EApplicationServiceContract["originBindings"]; mocks: readonly E2EMockSpec[] }>): ApplicationOriginPlan {
  const byComponent = new Map<string, MockedApplicationOrigin>();
  const unplaced: E2EMockSpec[] = [];
  for (const spec of input.mocks) {
    const binding = input.originBindings.find((candidate) => candidate.contractPath !== undefined && e2eApiSchemaComponentId(candidate.contractPath) === spec.componentId);
    if (!binding) { unplaced.push(spec); continue; }
    if (spec.kind !== "api" || spec.apiFixture === undefined) throw new Error(`approved mock ${spec.componentId} is not a source-backed API fixture, which is the only kind a run can serve`);
    if (!SAFE_ORIGIN_REF.test(binding.originRef) || binding.originRef === SINKHOLE_ORIGIN_REF) throw new Error(`origin ${binding.originRef} cannot be served by a mock container`);
    const previous = byComponent.get(spec.componentId);
    if (previous !== undefined && canonicalJson(previous.fixture) !== canonicalJson(spec.apiFixture)) throw new Error(`origin ${binding.originRef} has two different approved fixtures in one run`);
    byComponent.set(spec.componentId, { originRef: binding.originRef, envName: binding.envName, componentId: spec.componentId, fixture: spec.apiFixture });
  }
  if (byComponent.size > MAX_MOCKED_ORIGINS) throw new Error(`a run serves at most ${MAX_MOCKED_ORIGINS} mocked origins`);
  const mocked = [...byComponent.values()].sort((a, b) => a.originRef.localeCompare(b.originRef));
  const mockedRefs = new Set(mocked.map((item) => item.originRef));
  const unbound = input.originBindings.filter((binding) => !mockedRefs.has(binding.originRef)).map((binding) => ({ originRef: binding.originRef, envName: binding.envName }))
    .sort((a, b) => a.originRef.localeCompare(b.originRef));
  return Object.freeze({ mocked: Object.freeze(mocked), unbound: Object.freeze(unbound), unplaced: Object.freeze(unplaced) });
}
