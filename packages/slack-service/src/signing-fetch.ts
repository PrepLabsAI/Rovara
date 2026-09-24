import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { slackThreadSubject, type SlackThread } from "@agentx/contracts";

type Credentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

// Sends the control-plane API client's /v1 requests to the IAM-authorized /v1/service routes as the orchestrator role.
export function createSignedServiceFetch(options: {
  region: string;
  credentials: Credentials;
  thread: SlackThread;
  userId: string;
  userName?: string;
  baseFetch?: typeof fetch;
}): typeof fetch {
  const signer = new SignatureV4({ service: "execute-api", region: options.region, credentials: options.credentials, sha256: Sha256 });
  const baseFetch = options.baseFetch ?? fetch;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!url.pathname.startsWith("/v1/")) throw new Error("control-plane service requests must target /v1 routes");
    url.pathname = `/v1/service${url.pathname.slice("/v1".length)}`;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      if (key !== "authorization") headers[key] = value;
    });
    headers["x-agentx-slack-thread"] = slackThreadSubject(options.thread);
    headers["x-agentx-slack-user"] = options.userId;
    if (options.userName) headers["x-agentx-slack-user-name"] = encodeURIComponent(options.userName.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80));
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (init?.body !== undefined && init.body !== null && body === undefined) {
      throw new Error("control-plane service requests must use string bodies");
    }
    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...headers, host: url.host },
      ...(body === undefined ? {} : { body }),
    });
    // Host is signed but set by fetch itself from the URL.
    const sendHeaders = { ...signed.headers };
    delete sendHeaders.host;
    return baseFetch(url.toString(), {
      ...init,
      headers: sendHeaders,
      ...(body === undefined ? {} : { body }),
    });
  };
}
