// A fake Linear for the ticket write-back (R1 + L1 6.2): what Rovara WRITES into a customer's workspace and reads to do it. Each company's token reads and writes only its own workspace. It keeps
//   - comments by the id the caller chose (Linear accepts the client's id: a second create with the same id is refused, and the lookup by id finds the first), edits and replies;
//   - issues with a current workflow status, and each team's statuses with Linear's own `type` and `position`, so the forward-only rule is judged on the real fields;
//   - every write as it happened (`writes`), in order, with the company of the token that made it, and an `onWrite` hook that runs BEFORE the write is applied (a test reads the store there: "the note was written before the write");
//   - faults to inject: the next N calls to a named write answer a server error, a permission refusal (HTTP 403, which Linear sends for a token without write access), or a GraphQL permission error.
// No real Linear address is ever called: everything goes through the `fetch` seam, and no token is key-shaped (`tok-<company>` is built here, never a literal secret).

export interface FakeState { id: string; name: string; type: string; position: number }
export const DEFAULT_STATES: readonly FakeState[] = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 }, { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-progress", name: "In Progress", type: "started", position: 2 }, { id: "st-review", name: "In Review", type: "started", position: 3 },
  { id: "st-done", name: "Done", type: "completed", position: 4 }, { id: "st-canceled", name: "Canceled", type: "canceled", position: 5 },
];

export interface FakeWrite { company: string; kind: "create" | "edit" | "move"; id: string; parent?: string | undefined; body?: string | undefined; state?: string | undefined }
export type Fault = "server_error" | "http_403" | "graphql_forbidden";
type Target = "commentCreate" | "commentUpdate" | "issueUpdate" | "issue";

/** The workspace url key of a company in these tests (the issue links are `https://linear.app/<key>/issue/...`). */
export const urlKeyOf = (company: string): string => (company === "org_bbbbbbbbbbbbbbbbbbbb" ? "beta" : "acme");

export function fakeLinearWrites(options: { states?: readonly FakeState[] } = {}) {
  const states = options.states ?? DEFAULT_STATES;
  const comments = new Map<string, { id: string; issue: string; parent?: string | undefined; body: string; company: string }>();
  const issues = new Map<string, { state: string }>();
  const writes: FakeWrite[] = [];
  const reads: string[] = [];
  const faults: Array<{ target: Target; fault: Fault; times: number }> = [];
  let onWrite: ((write: FakeWrite) => Promise<void> | void) | undefined;
  const workspaces = new Map<string, string>();
  const workspaceOf = (company: string): string => workspaces.get(company) ?? urlKeyOf(company);
  const issueKey = (company: string, key: string): string => `${company}:${key}`;
  const stateOf = (company: string, key: string): string => issues.get(issueKey(company, key))?.state ?? "Todo";
  const take = (target: Target): Fault | undefined => {
    const found = faults.find((entry) => entry.target === target && entry.times > 0);
    if (found === undefined) return undefined;
    found.times -= 1;
    return found.fault;
  };
  const failure = (fault: Fault): Response => fault === "server_error" ? new Response("boom", { status: 500 })
    : fault === "http_403" ? new Response("no", { status: 403 })
      : new Response(JSON.stringify({ errors: [{ message: "forbidden", extensions: { code: "FORBIDDEN" } }] }), { status: 200 });
  const impl: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    const company = String(headers["authorization"] ?? headers["Authorization"] ?? "").replace("Bearer tok-", "");
    const body = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const q = body.query;
    if (q.includes("issue(id:") && q.includes("team { states")) {
      reads.push("issue");
      const fault = take("issue");
      if (fault !== undefined) return failure(fault);
      const key = body.variables["id"] as string;
      const current = states.find((state) => state.name === stateOf(company, key));
      return reply({ issue: {
        id: `iss:${company}:${key}`, identifier: key, url: `https://linear.app/${workspaceOf(company)}/issue/${key}/x`,
        state: current === undefined ? { name: stateOf(company, key) } : { name: current.name, type: current.type, position: current.position },
        team: { states: { nodes: states } },
      } });
    }
    if (q.includes("comment(id:")) {
      const found = comments.get(body.variables["id"] as string);
      return reply({ comment: found === undefined || found.company !== company ? null : { id: found.id, issue: { identifier: found.issue }, ...(found.parent === undefined ? {} : { parent: { id: found.parent } }) } });
    }
    if (q.includes("commentCreate")) {
      const input = body.variables["input"] as { id: string; issueId: string; body: string; parentId?: string };
      const write: FakeWrite = { company, kind: "create", id: input.id, parent: input.parentId, body: input.body };
      await onWrite?.(write);
      const fault = take("commentCreate");
      if (fault !== undefined) return failure(fault);
      // Linear refuses an id it already has: the caller then finds the comment by that id.
      if (comments.has(input.id)) return reply({ commentCreate: { success: false } });
      comments.set(input.id, { id: input.id, issue: input.issueId.split(":")[2]!, parent: input.parentId, body: input.body, company });
      writes.push(write);
      return reply({ commentCreate: { success: true } });
    }
    if (q.includes("commentUpdate")) {
      const id = body.variables["id"] as string;
      const found = comments.get(id)!;
      const write: FakeWrite = { company, kind: "edit", id, body: (body.variables["input"] as { body: string }).body };
      await onWrite?.(write);
      const fault = take("commentUpdate");
      if (fault !== undefined) return failure(fault);
      found.body = write.body!;
      writes.push(write);
      return reply({ commentUpdate: { success: true } });
    }
    if (q.includes("issueUpdate")) {
      const id = String(body.variables["id"]);
      const target = states.find((state) => state.id === body.variables["state"]);
      const key = id.split(":")[2]!;
      const write: FakeWrite = { company, kind: "move", id: key, state: target?.name };
      await onWrite?.(write);
      const fault = take("issueUpdate");
      if (fault !== undefined) return failure(fault);
      if (target === undefined) return reply({ issueUpdate: { success: false } });
      issues.set(issueKey(company, key), { state: target.name });
      writes.push(write);
      return reply({ issueUpdate: { success: true } });
    }
    return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 200 });
  };
  return {
    fetch: impl, comments, writes, reads,
    /** The ticket's status as Linear has it now. */
    stateOf,
    /** Puts a ticket in a status (a person moved it). */
    setState(company: string, key: string, name: string) { issues.set(issueKey(company, key), { state: name }); },
    /** The company reconnected to another Linear workspace: its token now reads and writes there, and the same issue keys are other issues. */
    reconnectTo(company: string, urlKey: string) { workspaces.set(company, urlKey); },
    /** The next `times` calls to this write answer `fault`. */
    fail(target: Target, fault: Fault, times = 1) { faults.push({ target, fault, times }); },
    /** Runs before every write is applied. */
    beforeWrite(hook: ((write: FakeWrite) => Promise<void> | void) | undefined) { onWrite = hook; },
    /** The comments one company's token wrote, oldest first. */
    commentsOf: (company: string) => [...comments.values()].filter((entry) => entry.company === company),
    moves: (company: string) => writes.filter((write) => write.kind === "move" && write.company === company).map((write) => write.state),
  };
}
