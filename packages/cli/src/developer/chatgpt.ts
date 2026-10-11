// Sign in with ChatGPT from the CLI (#339): `rovara chatgpt connect | status | disconnect`. The
// control plane starts the sign-in and does the code exchange (#338); this computer only catches
// OpenAI's callback on 127.0.0.1:1455 (the only callback OpenAI allows) and passes the code, the
// state and the client ID on. Nothing token-bearing is written on this computer.
import { createServer, type Server } from "node:http";
import {
  CHATGPT_CALLBACK_URL, CLI_PACKAGE_NAME, ChatGptConnectStartSchema, ChatGptConnectionViewSchema, agentXError,
  type ChatGptConnectFinishRequest, type ChatGptConnectionView,
} from "@agentx/contracts";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const CONNECTION_PATH = "/v1/dev/chatgpt/connection";

export interface ChatGptCallbackValues { code: string; state: string; clientId: string }

/** The page the browser shows once the callback has reached this computer. */
const CAUGHT_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Rovara</title><p>Rovara has your ChatGPT sign-in. Return to your terminal to see it finish; you can close this tab.</p>";

/**
 * Listens for OpenAI's callback on 127.0.0.1 at the callback's port and path. A callback carrying
 * another state is refused and ignored, so no other page can cancel or hijack the sign-in; one with
 * this state and an `error` (such as a declined consent) ends it with OpenAI's error word. Resolves
 * to undefined when the port is taken, so the caller can fall back to pasting.
 */
export async function listenForChatGptCallback(expectedState: string, port: number): Promise<{ values: Promise<ChatGptCallbackValues>; close: () => void } | undefined> {
  const path = new URL(CHATGPT_CALLBACK_URL).pathname;
  let resolveValues!: (values: ChatGptCallbackValues) => void;
  let rejectValues!: (error: Error) => void;
  const values = new Promise<ChatGptCallbackValues>((resolve, reject) => { resolveValues = resolve; rejectValues = reject; });
  // Awaited later; this only stops Node reporting an early refusal as unhandled.
  values.catch(() => undefined);
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) { response.writeHead(404).end(); return; }
    if (url.searchParams.get("state") !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain" }).end("This is not the ChatGPT sign-in Rovara started.");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id");
    if (error !== null || !code || !clientId) {
      response.writeHead(400, { "content-type": "text/plain" }).end("ChatGPT did not connect. Return to your terminal.");
      const word = error !== null && /^[a-z_]{1,40}$/.test(error) ? error : undefined;
      rejectValues(agentXError("CONFIG_INVALID", word === "access_denied"
        ? "ChatGPT was not connected: the sign-in was declined on OpenAI's page"
        : `ChatGPT did not connect${word === undefined ? "" : ` (${word})`}; run npx ${CLI_PACKAGE_NAME} chatgpt connect again`));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CAUGHT_PAGE);
    resolveValues({ code, state: expectedState, clientId });
  });
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => { resolve(true); });
  });
  if (!listening) return undefined;
  return { values, close: () => { server.close(); server.closeAllConnections(); } };
}

export interface ChatGptConnectOptions {
  browser: boolean;
  openBrowser: (url: string) => Promise<void>;
  write: (line: string) => void;
  /** One line typed by the person: the address the browser ended on. Undefined when there is no more input. */
  readLine: () => Promise<string | undefined>;
  /** Whether a person is there to paste; without one only the local callback can finish. */
  interactive: boolean;
  /** The callback's port; tests pick another. */
  port?: number;
  now?: () => number;
}

/**
 * Connects the developer's ChatGPT plan: starts at the control plane, opens OpenAI's page, and
 * finishes with whichever comes first, the local callback or a pasted address (for a browser on
 * another computer, or a port already taken, such as by the Codex CLI).
 */
export async function chatGptConnect(deps: DeveloperSessionDeps, env: string | undefined, options: ChatGptConnectOptions): Promise<{ env: string; url: string; connection: ChatGptConnectionView }> {
  const started = await developerRequest(deps, env, CONNECTION_PATH, ChatGptConnectStartSchema, { method: "POST", explain: true });
  const { authorizeUrl } = started.body;
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (state === null || !authorizeUrl.startsWith("https://auth.openai.com/")) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest chatgpt connect`);
  }
  const listener = await listenForChatGptCallback(state, options.port ?? Number(new URL(CHATGPT_CALLBACK_URL).port));
  if (listener === undefined && !options.interactive) {
    throw agentXError("RUNTIME_UNAVAILABLE", `port ${new URL(CHATGPT_CALLBACK_URL).port} on this computer is in use (the Codex CLI may be signing in); close it and run npx ${CLI_PACKAGE_NAME} chatgpt connect again`);
  }
  try {
    if (options.browser) {
      options.write(`Opening your browser to connect ChatGPT. If it does not open, open this link: ${authorizeUrl}`);
      await options.openBrowser(authorizeUrl).catch(() => undefined);
    } else {
      options.write(`Open this link in a browser to connect ChatGPT: ${authorizeUrl}`);
    }
    if (listener === undefined) {
      options.write(`Port ${new URL(CHATGPT_CALLBACK_URL).port} on this computer is in use, so after you press Allow the browser will show an error page. That is expected: copy the whole address it ended on (it starts with ${CHATGPT_CALLBACK_URL}) and paste it here.`);
    } else if (options.interactive) {
      options.write(`If the browser is on another computer, it will end on an error page after you press Allow: copy the whole address (it starts with ${CHATGPT_CALLBACK_URL}) and paste it here.`);
    }
    const finish = await firstAnswer(listener?.values, options.interactive ? pasted(options.readLine) : undefined, started.body.expiresAt, options.now ?? Date.now);
    options.write("Finishing the connection...");
    const finished = await developerRequest(deps, env, `${CONNECTION_PATH}/finish`, ChatGptConnectionViewSchema, { method: "POST", body: finish, explain: true });
    return { env: finished.env, url: finished.url, connection: finished.body };
  } finally {
    listener?.close();
  }
}

/** The first non-empty pasted line, as the address to finish with. Never resolves when input ends. */
async function pasted(readLine: () => Promise<string | undefined>): Promise<ChatGptConnectFinishRequest> {
  for (;;) {
    const line = await readLine();
    if (line === undefined) return new Promise<never>(() => undefined);
    if (line.trim() !== "") return { callbackUrl: line.trim() };
  }
}

/** Whichever of the callback and the paste comes first, until the started sign-in expires. */
async function firstAnswer(
  callback: Promise<ChatGptCallbackValues> | undefined,
  paste: Promise<ChatGptConnectFinishRequest> | undefined,
  expiresAt: string,
  now: () => number,
): Promise<ChatGptConnectFinishRequest> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    const wait = Math.max(0, Date.parse(expiresAt) - now());
    timer = setTimeout(() => { reject(agentXError("CONFIG_INVALID", `connecting ChatGPT timed out; run npx ${CLI_PACKAGE_NAME} chatgpt connect again`)); }, Number.isFinite(wait) ? wait : 600_000);
    timer.unref();
  });
  try {
    return await Promise.race([expired, ...(callback === undefined ? [] : [callback]), ...(paste === undefined ? [] : [paste])]);
  } finally {
    clearTimeout(timer);
  }
}

export async function chatGptStatus(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; connection: ChatGptConnectionView }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, CONNECTION_PATH, ChatGptConnectionViewSchema, { explain: true });
  return { env: resolved, url, connection: body };
}

export async function chatGptDisconnect(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; connection: ChatGptConnectionView }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, CONNECTION_PATH, ChatGptConnectionViewSchema, { method: "DELETE", explain: true });
  return { env: resolved, url, connection: body };
}

/** What `chatgpt connect` and `chatgpt status` print. */
export function chatGptConnectionText(result: { env: string; connection: ChatGptConnectionView }, verb: "connected" | "status"): string {
  const { connection } = result;
  if (!connection.connected) {
    return `ChatGPT is not connected to AgentX environment ${result.env}. Connect it with npx ${CLI_PACKAGE_NAME} chatgpt connect.\n`;
  }
  const account = connection.email === undefined ? "" : ` (${sanitizeServerText(connection.email)})`;
  const lines = [verb === "connected"
    ? `Connected your ChatGPT plan${account} to AgentX environment ${result.env}.`
    : `Your ChatGPT plan${account} is connected to AgentX environment ${result.env}${connection.connectedAt === undefined ? "" : ` since ${sanitizeServerText(connection.connectedAt)}`}.`];
  if (connection.status === "revoked") {
    lines.push(`The connection no longer works (it was revoked at OpenAI, or expired); connect again with npx ${CLI_PACKAGE_NAME} chatgpt connect.`);
  } else if (connection.status === "limit-reached") {
    lines.push("Your plan reached its usage limit; tasks use this environment's default model until it resets.");
  }
  if (connection.models !== undefined && connection.models.length > 0) {
    lines.push(`Models your plan offers: ${connection.models.map(sanitizeServerText).join(", ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

export function chatGptDisconnectText(result: { env: string }): string {
  return `Disconnected ChatGPT from AgentX environment ${result.env}. You can also remove Rovara from your ChatGPT account's connected apps.\n`;
}
