import { createHash } from "node:crypto";
import { tool, type ModelMessage } from "ai";
import { AgentError, createToolLoopExecutor, isAgentError } from "e2e/agent";
import type { StepExecutor } from "e2e";
import { z } from "zod";
import { E2E_AGENT_EXECUTOR_NAME, E2E_AGENT_EXECUTOR_VERSION } from "../application-templates.js";
import type { E2EAgentLedgerWriter, LedgerNode } from "./agent-ledger.js";

/**
 * The executor of an agent step (Task 4.3b): e2e's tool loop with Rovara's own prompt and a closed toolset (Ruling M1.4-AGENT-SEAM, (b)).
 *
 * The model sees the goal and a text description of the screen, one node per line (`#id role "name" ... testid="..."`), and answers with tool calls: `tap`, `type`, `press`,
 * `select`, `scroll` and `navigate`, plus the loop's own `complete_step`. There is no tool that attaches pixels, uploads a file, fills a secret or runs project code, and the prompt
 * is built from the tree-only observation: `observe({ pixels: true })` is never called, so no screenshot exists to be sent. The channel's request schema refuses a file part anyway.
 *
 * Every action goes through `ctx.actions`, which authorizes, counts and records it, and is written to the action ledger right after it ran. The ledger's node (role, name, test id)
 * is read from the line of the observation the model chose from, so it describes what the model saw, not what the page is now.
 *
 * The prompt keeps the shape the scripted model double reads (carried item k): the goal as a `Goal: ...` line of the user message, and the screen as node lines, in the user message
 * and in each tool result.
 */

export { E2E_AGENT_EXECUTOR_NAME, E2E_AGENT_EXECUTOR_VERSION };

/** Header of the screen text in the first user message and in a tool result; the elision of old screens looks for it. */
const SCREEN_HEADER = "Screen:";
const AFTER_HEADER = "Screen after the action:";
const OMITTED_SCREEN = "[an earlier screen is left out]";
/** The newest screen is cut here, so the whole request stays inside the channel's input bound (about 31 KB with the tool list). */
export const E2E_AGENT_SCREEN_MAX_BYTES = 12_288;
/** When the messages of a request pass this many bytes, superseded screens are replaced by a marker, oldest first. */
export const E2E_AGENT_MESSAGES_SOFT_BUDGET_BYTES = 20_480;

const SYSTEM = [
  "You operate a web application in a browser by calling tools. You are given a goal and the current screen as text, one node per line: #id role \"name\" ...",
  "A tool's target is a node id from the latest screen, without the #. A screen is only valid until the next action; after each action you get the new screen.",
  "You have no password, token or personal data: never type one. If the goal needs you to sign in, call complete_step with status failed.",
  "Do only what the goal asks. When the goal is done, call complete_step with status passed; if it cannot be done on this application, call it with status failed.",
].join("\n");

export type ScreenLine = { id: string; role: string; name: string; testId: string | null };

const LINE_HEAD = /^\s*#(\S+?)(?: ([a-z][a-z0-9]*))?(?: ("(?:[^"\\]|\\.)*"))?(?=\s|$)/;
const ATTRIBUTE = /^\s+([a-z]+)=("(?:[^"\\]|\\.)*"|\S+)/;
const unquote = (token: string): string => { try { return JSON.parse(token) as string; } catch { return token.slice(1, -1); } };

/** The node described by one observation line, or null when the line is not a node. Attributes are read in order, so a quoted name that contains `testid=` is never taken for one. */
export function parseScreenLine(line: string): ScreenLine | null {
  const head = LINE_HEAD.exec(line);
  if (head === null) return null;
  let rest = line.slice(head[0].length);
  let testId: string | null = null;
  for (;;) {
    const attribute = ATTRIBUTE.exec(rest);
    if (attribute === null) break;
    if (attribute[1] === "testid" && attribute[2]!.startsWith("\"")) testId = unquote(attribute[2]!);
    rest = rest.slice(attribute[0].length);
  }
  return { id: head[1]!, role: head[2] ?? "generic", name: head[3] === undefined ? "" : unquote(head[3]), testId };
}

/** The nodes of a screen, by id. A later line with the same id replaces an earlier one. */
export function parseScreen(text: string): Map<string, ScreenLine> {
  const nodes = new Map<string, ScreenLine>();
  for (const line of text.split("\n")) {
    const node = parseScreenLine(line);
    if (node !== null) nodes.set(node.id, node);
  }
  return nodes;
}

/** An absolute or relative target as an app path without a query or fragment, or null when it names another origin (or is not a URL at all). */
export function appRelativePath(target: string, origin: string): string | null {
  let parsed: URL;
  try { parsed = new URL(target, `${origin}/`); } catch { return null; }
  if (parsed.origin !== new URL(origin).origin) return null;
  return parsed.pathname.length > 512 ? null : parsed.pathname;
}

function boundScreen(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= E2E_AGENT_SCREEN_MAX_BYTES) return text;
  let end = E2E_AGENT_SCREEN_MAX_BYTES;
  const bytes = Buffer.from(text, "utf8");
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[the screen is cut here]`;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Replaces the screen of one message with the marker. A message with no screen is returned as it is. */
function elide(message: ModelMessage): ModelMessage {
  if (message.role === "user" && Array.isArray(message.content)) {
    return { ...message, content: message.content.map((part) => {
      if (part.type !== "text") return part;
      const at = part.text.indexOf(`\n\n${SCREEN_HEADER}\n`);
      return at < 0 ? part : { ...part, text: `${part.text.slice(0, at)}\n\n${SCREEN_HEADER}\n${OMITTED_SCREEN}` };
    }) } as ModelMessage;
  }
  if (message.role === "tool") {
    return { ...message, content: message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output as { type: string; value?: unknown };
      if (output.type !== "text" || !textOf(output.value).includes(AFTER_HEADER)) return part;
      return { ...part, output: { type: "text", value: `${textOf(output.value).slice(0, textOf(output.value).indexOf(AFTER_HEADER))}${AFTER_HEADER}\n${OMITTED_SCREEN}` } };
    }) } as ModelMessage;
  }
  return message;
}

/** Keeps the request inside the input bound: when the messages are large, every screen but the newest is left out, oldest first, until they fit. */
export function elideSupersededScreens(messages: ModelMessage[]): ModelMessage[] {
  const size = (list: ModelMessage[]) => Buffer.byteLength(JSON.stringify(list), "utf8");
  if (size(messages) <= E2E_AGENT_MESSAGES_SOFT_BUDGET_BYTES) return messages;
  const result = [...messages];
  // The newest message that holds a screen is the one the model is acting on: it stays.
  const holdsScreen = (message: ModelMessage) => { const json = JSON.stringify(message); return (json.includes(SCREEN_HEADER) || json.includes(AFTER_HEADER)) && !json.includes(OMITTED_SCREEN); };
  let newest = -1;
  for (let index = result.length - 1; index >= 0; index -= 1) { if (holdsScreen(result[index]!)) { newest = index; break; } }
  for (let index = 0; index < newest && size(result) > E2E_AGENT_MESSAGES_SOFT_BUDGET_BYTES; index += 1) result[index] = elide(result[index]!);
  return result;
}

export interface E2EAgentExecutorOptions {
  /** The agent step now running, or null when none is. A tool call outside a step is refused. */
  position: () => { caseId: string; stepIndex: number } | null;
  /** The ledger of the running step's case. */
  ledger: () => E2EAgentLedgerWriter | null;
  /** The application's origin (as the browser sees it): `navigate` goes to a path of this origin and nowhere else. */
  origin: () => string;
}

const direction = z.enum(["up", "down", "left", "right"]);

export function createRovaraE2EAgentExecutor(options: E2EAgentExecutorOptions): StepExecutor {
  return createToolLoopExecutor({
    name: E2E_AGENT_EXECUTOR_NAME,
    version: E2E_AGENT_EXECUTOR_VERSION,
    system: SYSTEM,
    prepareMessages: (messages) => elideSupersededScreens(messages),
    async buildPrompt(ctx) {
      const observation = await ctx.observe();
      return `Goal: ${ctx.step.instruction}\n\n${SCREEN_HEADER}\n${boundScreen(observation.text)}`;
    },
    tools(ctx, { guard }) {
      // The screen the model last saw: node ids are valid only for it. It is read once per action, after the action, and is what the ledger describes.
      let screen: { text: string; sha: string; nodes: Map<string, ScreenLine> } | null = null;
      const look = async () => {
        const observation = await ctx.observe();
        screen = { text: observation.text, sha: sha256(observation.text), nodes: parseScreen(observation.text) };
        return boundScreen(observation.text);
      };
      const current = async () => { if (screen === null) await look(); return screen!; };
      const nodeFor = (target: string): { id: string; node: LedgerNode } => {
        const id = target.replace(/^#/, "");
        const line = screen?.nodes.get(id);
        return { id, node: line === undefined ? { role: "generic", name: "", testId: null } : { role: line.role, name: line.name, testId: line.testId } };
      };

      type Spec = { tool: "tap" | "type" | "press" | "select" | "scroll" | "navigate"; target: string | null; value: string | null; url?: string | null; run(id: string | null): Promise<void> };
      const act = async (spec: Spec): Promise<string> => {
        const ledger = options.ledger();
        if (options.position() === null || ledger === null) throw new Error("an agent tool was called outside an agent step");
        const seen = await current();
        const resolved = spec.target === null ? null : nodeFor(spec.target);
        let outcome: "ok" | "action-failed" | "policy-denied" = "ok";
        let failure: unknown;
        try { await spec.run(resolved === null ? null : resolved.id); }
        catch (error) { failure = error; outcome = isAgentError(error) && error.code === "POLICY_DENIED" ? "policy-denied" : "action-failed"; }
        ledger.recordAction({ tool: spec.tool, node: resolved === null ? null : resolved.node, value: spec.value, url: spec.url ?? null, snapshotSha256: seen.sha, outcome });
        if (failure !== undefined) throw failure;
        return `Done.\n\n${AFTER_HEADER}\n${await look()}`;
      };

      return {
        tap: tool({ description: "Tap (click) one node.", inputSchema: z.object({ target: z.string().min(1).max(64) }),
          execute: ({ target }) => guard(() => act({ tool: "tap", target, value: null, run: (id) => ctx.actions.tap({ id: id! }) })) }),
        type: tool({ description: "Type text into one input node.", inputSchema: z.object({ target: z.string().min(1).max(64), value: z.string().max(1024) }),
          execute: ({ target, value }) => guard(() => act({ tool: "type", target, value, run: (id) => ctx.actions.type({ id: id! }, value) })) }),
        press: tool({ description: "Press one key (for example Enter) on a node.", inputSchema: z.object({ target: z.string().min(1).max(64), key: z.string().min(1).max(64) }),
          execute: ({ target, key }) => guard(() => act({ tool: "press", target, value: key, run: (id) => ctx.actions.press({ id: id! }, key) })) }),
        select: tool({ description: "Choose one option of a select node by its label.", inputSchema: z.object({ target: z.string().min(1).max(64), value: z.string().min(1).max(256) }),
          execute: ({ target, value }) => guard(() => act({ tool: "select", target, value, run: (id) => ctx.actions.select({ id: id! }, value) })) }),
        scroll: tool({ description: "Scroll the page, or one node, up, down, left or right.", inputSchema: z.object({ direction, target: z.string().min(1).max(64).optional() }),
          execute: ({ direction: way, target }) => guard(() => act({ tool: "scroll", target: target ?? null, value: way,
            run: (id) => (id === null ? ctx.actions.scroll(way) : ctx.actions.scroll(way, { id })) })) }),
        navigate: tool({ description: "Go to a page of this application by its path (for example /orders). Other sites are refused.", inputSchema: z.object({ url: z.string().min(1).max(512) }),
          execute: ({ url }) => guard(async () => {
            const origin = options.origin();
            const path = appRelativePath(url, origin);
            if (path === null) {
              // Another origin is never visited. The attempt is recorded, with no path, and the model is told why.
              const ledger = options.ledger();
              if (ledger === null) throw new Error("an agent tool was called outside an agent step");
              const seen = await current();
              ledger.recordAction({ tool: "navigate", node: null, value: null, url: "/", snapshotSha256: seen.sha, outcome: "policy-denied" });
              throw new AgentError("POLICY_DENIED", "navigate only goes to pages of this application");
            }
            return act({ tool: "navigate", target: null, value: null, url: path, run: () => ctx.actions.navigate(new URL(url, `${origin}/`).toString()) });
          }) }),
      };
    },
  });
}
