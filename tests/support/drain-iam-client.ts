import { REQUALIFY_DRAIN_READ_ATTRIBUTES } from "../../packages/contracts/src/index.js";
import { requalifySetupWorkRow } from "../../packages/broker/src/e2e/requalify-hold.js";

export const DRAIN_FIXTURE_NOW = Date.parse("2026-10-27T03:00:00.000Z");
const NOW = DRAIN_FIXTURE_NOW;
const iso = (ms: number) => new Date(ms).toISOString();

type Item = Record<string, unknown>;
type Input = {
  Key?: { pk: string; sk: string }; IndexName?: string; Select?: string; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string>; ExclusiveStartKey?: unknown;
};

export interface DrainRequest { command: "GetCommand" | "QueryCommand"; select: string | undefined; attributes: string[] | undefined; indexName: string | undefined }

/**
 * A DynamoDB document client that behaves like the renewal role under its narrowed `DrainRead` statement and like DynamoDB for a projection:
 *  - it refuses (AccessDeniedException) a Query without Select=SPECIFIC_ATTRIBUTES, any read without a ProjectionExpression, and a read of an attribute outside `allowed`;
 *  - it returns only the projected attributes, so code that reads another attribute sees `undefined`;
 *  - `deny` makes the n-th matching read fail as a refused read would.
 * Every request is recorded with the attribute names its ProjectionExpression resolves to.
 */
export function drainIamClient(items: readonly Item[], options: { allowed?: readonly string[]; deny?: (request: DrainRequest) => boolean } = {}) {
  const allowed = options.allowed ?? REQUALIFY_DRAIN_READ_ATTRIBUTES;
  const requests: DrainRequest[] = [];
  const denied = (message: string) => Object.assign(new Error(message), { name: "AccessDeniedException" });
  const send = async (command: { constructor: { name: string }; input: Input }) => {
    const { input } = command;
    const name = command.constructor.name;
    if (name !== "GetCommand" && name !== "QueryCommand") throw new Error(`unexpected ${name}`);
    const resolve = (expression: string | undefined): string[] | undefined =>
      expression === undefined ? undefined : expression.split(",").map((part) => part.trim()).map((part) => (part.startsWith("#") ? input.ExpressionAttributeNames?.[part] ?? `<unresolved ${part}>` : part));
    const attributes = resolve(input.ProjectionExpression);
    const request: DrainRequest = { command: name, select: input.Select, attributes, indexName: input.IndexName };
    requests.push(request);
    if (name === "QueryCommand" && input.Select !== "SPECIFIC_ATTRIBUTES") throw denied("Select must be SPECIFIC_ATTRIBUTES");
    if (attributes === undefined) throw denied("a read must name its attributes");
    for (const attribute of attributes) if (!allowed.includes(attribute)) throw denied(`attribute ${attribute} is not allowed`);
    if (options.deny?.(request) === true) throw denied("refused");
    const project = (item: Item): Item => Object.fromEntries(attributes.map((attribute) => [attribute, item[attribute]]).filter(([, value]) => value !== undefined));
    if (name === "GetCommand") {
      const found = items.find((item) => item.pk === input.Key?.pk && item.sk === input.Key?.sk);
      return { Item: found === undefined ? undefined : project(found) };
    }
    const values = input.ExpressionAttributeValues ?? {};
    const rows = input.IndexName === undefined
      ? items.filter((item) => item.pk === values[":pk"] && String(item.sk).startsWith(values[":operation"] ?? values[":setup"] ?? ""))
      : items.filter((item) => item.sessionState === values[":state"]);
    return { Items: rows.map(project) };
  };
  return { documentClient: { send } as never, requests };
}

/** One READY workspace with a running round and a finished one, one with a running round that is not browser and API, a stopped workspace's running round, and two setup runs. */
export function drainFixtureRows() {
  const operation = (workspaceId: string, id: string, extra: Record<string, unknown>) => ({
    pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${id}`, entityType: "OPERATION", id, kind: "task", workflowMode: "CHECKS", status: "RUNNING",
    createdAt: iso(NOW - 60_000), updatedAt: iso(NOW - 30_000), workflowE2EAdmission: { kind: "application" }, secretLookingField: "must-not-be-read", ...extra,
  });
  const marker = (id: string) => requalifySetupWorkRow(id, iso(NOW + 600_000));
  return [
    { pk: "WORKSPACE#ws-1", sk: "SESSION", workspaceId: "ws-1", sessionState: "READY" },
    { pk: "WORKSPACE#ws-2", sk: "SESSION", workspaceId: "ws-2", sessionState: "READY" },
    { pk: "WORKSPACE#ws-3", sk: "SESSION", workspaceId: "ws-3", sessionState: "STOPPING" },
    operation("ws-1", "a", { status: "ACCEPTED" }),
    operation("ws-1", "b", { status: "SUCCEEDED" }),
    operation("ws-2", "c", { workflowMode: "IMPLEMENT" }),
    operation("ws-3", "d", {}),
    marker("11111111-1111-4111-8111-111111111111"),
    marker("22222222-2222-4222-8222-222222222222"),
    marker("33333333-3333-4333-8333-333333333333"),
    { pk: "PROJECT_SETUP#11111111-1111-4111-8111-111111111111", sk: "EXECUTION", state: "ACCEPTED", extra: "must-not-be-read" },
    { pk: "PROJECT_SETUP#22222222-2222-4222-8222-222222222222", sk: "EXECUTION", state: "DISPATCHING" },
    { pk: "PROJECT_SETUP#33333333-3333-4333-8333-333333333333", sk: "EXECUTION", state: "SUCCEEDED" },
  ];
}

