// Rovara-cloud#308: the OpenAI key test, run before a company's OpenAI key is sealed (ProductKeyStore connect and rotate), so a wrong
// key is refused on the settings page instead of at its company's first agent or learning call.
//
// One free, read-only call: `GET https://api.openai.com/v1/models` with the key as a bearer token. It costs nothing, sends no prompt and
// reads nothing about the company. The host and path are fixed; no redirect is followed; the call has a deadline.
//   200            ok: the key is OpenAI's and active.
//   403            ok: the key is OpenAI's, but restricted from listing models (a restricted key may still call Chat Completions; its
//                  permissions are OpenAI's to check on each call, and a refused call there is recorded on the source as before).
//   401            refused: OpenAI does not know the key, or it was revoked.
//   anything else  unavailable: nothing is saved and the admin is asked to try again (fail closed, as the Vertex and Bedrock tests).
// The key is never logged, returned or put in an error: the result is one of three words.
export type OpenAiKeyCheck = (key: string) => Promise<"ok" | "refused" | "unavailable">;

export const OPENAI_KEY_CHECK_URL = "https://api.openai.com/v1/models";
/** How long the test may take before it answers unavailable. */
export const OPENAI_KEY_CHECK_TIMEOUT_MS = 10_000;

export function openAiKeyCheck(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): OpenAiKeyCheck {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_KEY_CHECK_TIMEOUT_MS;
  return async (key) => {
    let status: number;
    try {
      const response = await send(OPENAI_KEY_CHECK_URL, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      status = response.status;
      // The body is not read for its content (a model list); it is drained so the connection is released.
      await response.body?.cancel().catch(() => undefined);
    } catch {
      return "unavailable";
    }
    if (status === 200 || status === 403) return "ok";
    return status === 401 ? "refused" : "unavailable";
  };
}
