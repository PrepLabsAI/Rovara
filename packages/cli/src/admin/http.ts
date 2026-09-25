import { AgentXErrorCodeSchema, agentXError } from "@agentx/contracts";

/** A response body parsed defensively: `body` is `undefined` when the text is empty or is not valid JSON. */
export interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Reads a fetch `Response` as text and parses it as JSON, without throwing when the body is not
 * JSON (for example an HTML error page from a proxy in front of the control plane). Callers decide
 * what a missing `body` means for their status code.
 */
export async function readJsonResponse(response: Response): Promise<JsonResponse> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

/** The `{ code, message }` pair from a parsed error body shaped like `{ error: { code, message } }`. */
export interface ServerError {
  code: unknown;
  message: string | undefined;
}

const NO_SERVER_ERROR: ServerError = { code: undefined, message: undefined };

export function serverError(body: unknown): ServerError {
  if (!body || typeof body !== "object" || !("error" in body)) return NO_SERVER_ERROR;
  const error = body.error;
  if (!error || typeof error !== "object") return NO_SERVER_ERROR;
  const record = error as Record<string, unknown>;
  return {
    code: "code" in record ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

/**
 * An administration route's JSON body, or the AgentX error it carries. An unlabeled body is
 * classified by status: 5xx is the control plane's fault, anything else is what the caller sent.
 */
export async function adminResponseBody(response: Response): Promise<unknown> {
  const { ok, status, body } = await readJsonResponse(response);
  if (!ok) {
    if (body === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `HTTP ${status}`);
    const { code, message } = serverError(body);
    const parsedCode = AgentXErrorCodeSchema.safeParse(code);
    const fallback = status >= 500 ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID";
    throw agentXError(parsedCode.success ? parsedCode.data : fallback, message ?? `HTTP ${status}`);
  }
  if (body === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return body;
}
