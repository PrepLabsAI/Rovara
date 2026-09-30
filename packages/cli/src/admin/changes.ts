// packages/cli/src/admin/changes.ts
// Spec 025 FR-052, E17 (Q6): the CLI's side of the admin change path. A person typing an agentx
// command is the confirmation (D12), recorded as the cli method; nothing applies before they say
// yes. Answers are read with the loose wire schemas (R1): a newer control plane's status, kind or
// method is a plain string here, and a status this CLI does not know is never taken as applied.
// The admin token goes only in the authorization header: never in a line written or an error.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  AdminChangeResponseWireSchema, AdminChangesResponseWireSchema, AgentXErrorCodeSchema, agentXError,
  type AdminChangeInput, type AdminChangeViewWire,
} from "@agentx/contracts";
import { adminResponseBody, readJsonResponse, serverError } from "./http.js";

/** Matches ADMIN_LIST_MAX, the most a change page holds. */
const PAGE_LIMIT = "100";
/** Guards against an endless export if the control plane ever hands back a growing cursor chain. */
const MAX_PAGES = 10_000;
const CHECK_STEP = "run agentx admin changes --since 1h to see how it ended";

/** Text from the control plane, without terminal control characters (a newline and a tab stay). */
function plain(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || !(code < 0x20 || (code >= 0x7f && code <= 0x9f))) out += character;
  }
  return out;
}

type Step = "plan" | "apply" | "decline" | "list";
const UNREACHABLE: Record<Step, (changeId?: string) => string> = {
  plan: () => "could not reach AgentX to plan the change; nothing was applied, try again",
  apply: (changeId) => `could not reach AgentX to apply change ${changeId}, so it may or may not have applied; ${CHECK_STEP}`,
  decline: (changeId) => `could not reach AgentX to decline change ${changeId}; nothing was applied, and it expires on its own`,
  list: () => "could not reach AgentX to read change records; try again",
};

interface Session { controlPlaneUrl: string; accessToken: string }

async function send(session: Session, traceId: string, method: "GET" | "POST", path: string, body: unknown, fetchImplementation: typeof fetch, step: Step, changeId?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${session.accessToken}`, "x-agentx-trace-id": traceId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // The fetch error's own words are never shown: they can quote the request.
    throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE[step](changeId));
  }
  // An apply refused without AgentX's own error (a gateway timeout, say) may still have applied.
  if (step === "apply" && !response.ok && serverError((await readJsonResponse(response.clone())).body).code === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status} while applying change ${changeId}, so it may or may not have applied; ${CHECK_STEP}`);
  }
  return adminResponseBody(response);
}

function viewOf(value: unknown, unreadable: string): AdminChangeViewWire {
  const parsed = AdminChangeResponseWireSchema.safeParse(value);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", unreadable);
  return parsed.data.change;
}

export interface CliChangeInput {
  controlPlaneUrl: string;
  accessToken: string;
  change: AdminChangeInput;
  cliVersion: string;
  /** Asked with the change's effect; true applies it, false declines it, and a rejection declines it as cancelled. */
  confirm(effect: string): Promise<boolean>;
  write(line: string): void;
  newId?(): string;
}

/**
 * Plans a change offering only the cli method, shows its effect, asks, and applies it with the cli
 * method on a yes or declines it on a no. An interrupted or failed prompt declines it as cancelled
 * and rethrows. Shared by every CLI change command (grant and revoke here, config set limits.*).
 */
export async function runCliChange(input: CliChangeInput, fetchImplementation: typeof fetch = fetch): Promise<{ outcome: "applied" | "declined"; change: AdminChangeViewWire }> {
  // FR-052: one trace ID for the change's steps.
  const traceId = randomUUID();
  const planned = viewOf(
    await send(input, traceId, "POST", "/v1/admin/changes", { requestId: (input.newId ?? randomUUID)(), change: input.change, client: { cliVersion: input.cliVersion }, methods: ["cli"] }, fetchImplementation, "plan"),
    "AgentX answered with a change this version of the CLI cannot read; nothing was applied. Upgrade the CLI, then ask again",
  );
  const changeId = planned.changeId;
  const path = `/v1/admin/changes/${encodeURIComponent(changeId)}`;
  if (planned.status !== "pending") {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX planned change ${changeId} as ${plain(planned.status)}, not waiting for a yes, so nothing was asked and nothing was applied; ask for the change again`);
  }
  if (!planned.methodsOffered.includes("cli")) {
    throw agentXError("CONFIRMATION_UNAVAILABLE", `AgentX did not offer the CLI prompt for change ${changeId}, so it cannot be confirmed here; nothing was applied, and it expires on its own`);
  }
  const effect = plain(planned.effect);
  input.write(effect);

  const decline = async (reason: "declined" | "cancelled"): Promise<AdminChangeViewWire> => {
    try {
      const declined = viewOf(await send(input, traceId, "POST", `${path}/decline`, { method: "cli", reason, answeredAt: new Date().toISOString() }, fetchImplementation, "decline", changeId), `AgentX's answer to declining change ${changeId} could not be read`);
      input.write(declined.status === "declined" ? "Nothing changed." : `Nothing was applied by this command; ${CHECK_STEP}.`);
      return declined;
    } catch {
      // Nothing applies without a yes: the change was offered only to this CLI, and it expires.
      input.write(`Nothing was applied; AgentX did not record the decline, so change ${changeId} expires on its own.`);
      return planned;
    }
  };

  const requestedAt = new Date().toISOString();
  let yes: boolean;
  try {
    yes = await input.confirm(effect);
  } catch (error) {
    await decline("cancelled");
    throw error;
  }
  const answeredAt = new Date().toISOString();
  if (yes !== true) return { outcome: "declined", change: await decline("declined") };

  const applied = viewOf(
    await send(input, traceId, "POST", `${path}/apply`, { method: "cli", requestedAt, answeredAt }, fetchImplementation, "apply", changeId),
    `AgentX's answer to applying change ${changeId} could not be read, so it may or may not have applied; ${CHECK_STEP}`,
  );
  if (applied.status === "applied") {
    input.write("Applied.");
    return { outcome: "applied", change: applied };
  }
  if (applied.status === "failed") {
    const code = AgentXErrorCodeSchema.safeParse(applied.error?.code);
    throw agentXError(code.success ? code.data : "RUNTIME_UNAVAILABLE", `change ${changeId} failed: ${plain(applied.error?.message ?? "it was not applied")}`);
  }
  // R1: a status this CLI does not know is never taken as applied.
  throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered change ${changeId} as ${plain(applied.status)}, which this CLI does not read as applied; ${CHECK_STEP}`);
}

/** Where the terminal prompt reads and writes; `signals` is the process, for Ctrl-C outside the prompt's own line. */
export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  signals?: { once(event: "SIGINT", listener: () => void): unknown; off(event: "SIGINT", listener: () => void): unknown };
}

/**
 * Asks "<question> [y/N]" until y, yes, n, no or an empty line (no). Ctrl-C or the end of input is
 * never a yes: it rejects, and the caller declines the change.
 */
export function askToApply(question: string, streams: PromptStreams): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: streams.input, output: streams.output, terminal: (streams.input as { isTTY?: boolean }).isTTY === true });
    let settled = false;
    const finish = (answer: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      streams.signals?.off("SIGINT", interrupt);
      rl.close();
      if (answer === undefined) reject(agentXError("CONFIRMATION_DECLINED", "the prompt ended without a yes, so nothing was applied; run the command again to make the change"));
      else resolve(answer);
    };
    function interrupt(): void { finish(undefined); }
    rl.on("SIGINT", interrupt);
    rl.on("close", interrupt);
    streams.signals?.once("SIGINT", interrupt);
    const ask = (): void => {
      rl.question(`${question} [y/N] `, (line) => {
        const answer = line.trim().toLowerCase();
        if (answer === "y" || answer === "yes") finish(true);
        else if (answer === "" || answer === "n" || answer === "no") finish(false);
        else {
          streams.output.write("  answer y or n\n");
          ask();
        }
      });
    };
    ask();
  });
}

/** FR-052: every change record since `since`, newest first, as text lines or as JSON Lines of the records as stored. */
export async function exportChanges(input: { controlPlaneUrl: string; accessToken: string; since: string; write(line: string): void | Promise<void>; json: boolean }, fetchImplementation: typeof fetch = fetch): Promise<{ exported: number; since: string }> {
  const traceId = randomUUID();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let exported = 0;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_PAGES) throw agentXError("RUNTIME_UNAVAILABLE", "change record export did not finish after 10000 pages; try a narrower --since");
    const query = new URLSearchParams({ since: input.since, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
    const body = await send(input, traceId, "GET", `/v1/admin/changes?${query.toString()}`, undefined, fetchImplementation, "list");
    const page = AdminChangesResponseWireSchema.safeParse(body);
    if (!page.success) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid change page; upgrade the CLI, then try again");
    const raw = (body as { changes: unknown[] }).changes;
    for (const [index, record] of page.data.changes.entries()) {
      // JSON Lines carry the record exactly as AgentX sent it (redacted as the broker stores it).
      await input.write(input.json
        ? `${JSON.stringify(raw[index])}\n`
        : `${[record.proposedAt, record.outcome ?? record.status, record.kind, record.admin.displayName ?? record.admin.subject, record.changeId].map(plain).join("  ")}\n`);
      exported += 1;
    }
    cursor = page.data.cursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw agentXError("RUNTIME_UNAVAILABLE", "control plane repeated a change page cursor; export stopped");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return { exported, since: input.since };
}
