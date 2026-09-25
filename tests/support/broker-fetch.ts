// A fetch that hands a Slack service request to the broker handler as API Gateway would after IAM
// authorization: the signed Authorization header is replaced by the authorizer's principal.
import { randomUUID } from "node:crypto";
import { orchestratorPrincipal, type Handler } from "./slack-broker.js";

export function brokerFetch(handler: Handler, principal = orchestratorPrincipal): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const forwarded: Record<string, string> = {};
    for (const name of ["x-agentx-slack-thread", "x-agentx-slack-user", "x-agentx-slack-user-name"]) {
      const value = headers.get(name);
      if (value !== null) forwarded[name] = value;
    }
    const response = await handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: forwarded,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" }, authorizer: { iam: { userArn: principal } } },
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}
