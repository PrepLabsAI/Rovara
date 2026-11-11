// A model call the broker itself makes through the local model proxy (a diagnosis), on the proxy's own rules.
//
// A worker reaches the proxy with a token its callback capability bought. A call the broker makes for itself has no worker, workspace or operation record, so it is given a one-shot operation of its own: the broker mints the
// token in this process (`ModelTokenBook.mint`, never through the capability route, so no worker can ask for one), the operation is live only while the call runs, and the token dies with it. The call then goes over loopback
// to the callback listener, where the proxy does what it does for every call: the request guard, the route's spending cap, the key (read from the `model-keys` port and never given to the caller), the provider, the metering and
// the scrubbing of the answer. Nothing here sees a key.
import { request as httpRequest } from "node:http";
import type { Cost } from "@agentx/contracts";
import { MODEL_PROXY_PREFIX, WORKSPACE_HEADER } from "./proxy.js";
import { PROXY_PATH_API } from "./providers.js";
import type { ModelTokenBook } from "./tokens.js";
import type { ModelGrantSource, ProxyApi, ProxyRoute } from "./types.js";

/** The operations a broker-made call is running now: the proxy asks `active` before every call, so a token dies with its operation. */
export class OneShotOperations {
  readonly #live = new Map<string, string>();

  begin(operationId: string, workspaceId: string): void { this.#live.set(operationId, workspaceId); }
  end(operationId: string): void { this.#live.delete(operationId); }
  has(operation: { workspaceId: string; operationId: string }): boolean { return this.#live.get(operation.operationId) === operation.workspaceId; }
}

/** A grant source that also knows the broker's own one-shot operations. Every other operation is the source's answer; a capability can never name a one-shot operation (its `grant` is the source's). */
export function withOneShotOperations(source: ModelGrantSource, operations: OneShotOperations): ModelGrantSource {
  return {
    grant: (capability, slot) => source.grant(capability, slot),
    ...(source.slotMinted === undefined ? {} : { slotMinted: (grant, minted) => source.slotMinted!(grant, minted) }),
    async active(operation) { return operations.has(operation) || source.active(operation); },
  };
}

/** Where the proxy is, for a call from inside this process. Read late: the proxy is made after the app. */
export interface LoopbackProxy {
  tokens: Pick<ModelTokenBook, "mint" | "forgetOperation">;
  /** The loopback port of the listener the proxy is served on. */
  port: number;
}

const ANSWER_MAX_BYTES = 8 * 1_048_576;
const TOKEN_SECONDS = 5 * 60;

export interface OneShotCall {
  operationId: string;
  workspaceId: string;
  taskId?: string | undefined;
  projectName?: string | undefined;
  /** The one route the call may use, with its own spending cap. */
  route: ProxyRoute;
  api: ProxyApi;
  /** The request body; its `model` is the route's alias. */
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** An operation-wide budget in the Metering port's currency, when the install holds one. The route's own cap is what bounds the call otherwise. */
  budget?: Cost | undefined;
}

export interface OneShotAnswer { status: number; text: string }

/** The path of each request format on the proxy. */
const PATH_OF: Readonly<Record<ProxyApi, string>> = Object.fromEntries(Object.entries(PROXY_PATH_API).map(([path, api]) => [api, `${MODEL_PROXY_PREFIX}${path}`])) as Record<ProxyApi, string>;

/**
 * Makes one non-streamed call through the proxy and answers its status and body. The token is minted for this call alone and forgotten when it ends, whatever the outcome. The answer is read to a bound; a call that is
 * aborted ends with `aborted`.
 */
export async function callThroughProxy(proxy: LoopbackProxy, operations: OneShotOperations, call: OneShotCall): Promise<OneShotAnswer> {
  const minted = proxy.tokens.mint({
    workspaceId: call.workspaceId, operationId: call.operationId, taskId: call.taskId, projectName: call.projectName, routes: [call.route],
    ...(call.budget === undefined ? {} : { budget: call.budget }),
  }, { ttlSeconds: TOKEN_SECONDS });
  operations.begin(call.operationId, call.workspaceId);
  try {
    const payload = Buffer.from(JSON.stringify(call.body), "utf8");
    return await new Promise<OneShotAnswer>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: proxy.port, method: "POST", path: PATH_OF[call.api], signal: call.signal,
        // The listener answers only the name a worker's own gateway gives it, so this call says that name; the stamp is the one-shot operation's own workspace.
        headers: {
          host: `host.docker.internal:${String(proxy.port)}`, "content-type": "application/json", "content-length": String(payload.byteLength), authorization: `Bearer ${minted.token}`, [WORKSPACE_HEADER]: call.workspaceId,
          accept: "application/json",
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > ANSWER_MAX_BYTES) { request.destroy(new Error("answer_too_large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 502, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(payload);
    });
  } finally {
    operations.end(call.operationId);
    proxy.tokens.forgetOperation(call.operationId);
  }
}
