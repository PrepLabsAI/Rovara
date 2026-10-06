// Spec 025 FR-034, E13: the Slack Web API calls the notifier makes. The token goes only in the
// Authorization header; an error carries Slack's error code (lowercase letters and _) or the HTTP
// status, never the token or the request body.
export class SlackPostError extends Error {
  constructor(readonly slackError: string, method = "chat.postMessage") {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = "SlackPostError";
  }
}

/** Errors from a request that may have reached Slack: it failed before or while Slack answered. */
const unanswered = new WeakSet<object>();

/**
 * 25c note 3: whether a failed post may still have landed. Yes for a request that failed before
 * Slack's answer was read (an abort, a timeout, a lost connection), and for a 2xx or 5xx answer
 * with no readable result. No for Slack's own error code, a 4xx, or anything thrown before the
 * request (such as loading the bot token).
 */
export function postMayHaveLanded(error: unknown): boolean {
  if (error instanceof SlackPostError) return /^http_[25]\d\d$/.test(error.slackError);
  return typeof error === "object" && error !== null && unanswered.has(error);
}

/** One Web API call; `complete` says whether a successful answer has what the caller needs. */
async function callSlack(method: string, botToken: string, body: Record<string, unknown>, fetchImplementation: typeof fetch, complete: (result: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null) unanswered.add(error);
    throw error;
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    // An unreadable answer is reported by its HTTP status below.
  }
  if (!response.ok || result.ok !== true || !complete(result)) {
    const code = typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`;
    throw new SlackPostError(code, method);
  }
  return result;
}

async function callSlackGet(method: string, botToken: string, query: Record<string, string>, fetchImplementation: typeof fetch): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImplementation(url, {
    method: "GET",
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null) unanswered.add(error);
    throw error;
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    // An unreadable answer is reported by its HTTP status below.
  }
  if (!response.ok || result.ok !== true) {
    const code = typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`;
    throw new SlackPostError(code, method);
  }
  return result;
}

/** Creates an immutable task/version Canvas, grants channel read access and returns Slack's own permalink. */
export async function createTaskPlanCanvas(
  botToken: string,
  input: { channel: string; taskId: string; title: string; version: number; markdown: string },
  fetchImplementation: typeof fetch = fetch,
  onCreated?: (canvasId: string) => Promise<void>,
): Promise<{ canvasId: string; permalink: string }> {
  if (!/^[CG][A-Z0-9]{8,}$/.test(input.channel) || !/^[A-Za-z0-9_-]{1,100}$/.test(input.taskId)
    || input.title.trim() === "" || !Number.isSafeInteger(input.version) || input.version < 1 || input.markdown.trim() === ""
    || Buffer.byteLength(input.markdown, "utf8") > 32_768) {
    throw new Error("task plan Canvas input is invalid");
  }
  const created = await callSlack("canvases.create", botToken, {
    title: `Plan: ${input.title.slice(0, 120)} (v${input.version})`,
    document_content: { type: "markdown", markdown: input.markdown },
  }, fetchImplementation);
  const canvasId = created.canvas_id;
  if (typeof canvasId !== "string" || !/^F[A-Z0-9]{8,}$/.test(canvasId)) throw new SlackPostError("invalid_canvas_id", "canvases.create");
  await onCreated?.(canvasId);
  await callSlack("canvases.access.set", botToken, { canvas_id: canvasId, access_level: "read", channel_ids: [input.channel] }, fetchImplementation);
  const info = await callSlackGet("files.info", botToken, { file: canvasId }, fetchImplementation);
  const file = info.file && typeof info.file === "object" ? info.file as Record<string, unknown> : {};
  const permalink = file.permalink;
  let parsed: URL | undefined;
  try {
    if (typeof permalink === "string") parsed = new URL(permalink);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || !(parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com") || parsed.hostname === "slack-gov.com" || parsed.hostname.endsWith(".slack-gov.com"))) {
    throw new Error("Slack files.info returned an invalid Canvas link");
  }
  return { canvasId, permalink: parsed.toString() };
}

/** Deletes only a Canvas ID already durably recorded for the task; Slack's not-found is ambiguous. */
export async function deleteTaskPlanCanvas(
  botToken: string,
  canvasId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<"deleted" | "unknown"> {
  if (!/^F[A-Z0-9]{8,}$/.test(canvasId)) throw new Error("task Canvas ID is invalid");
  try {
    await callSlack("canvases.delete", botToken, { canvas_id: canvasId }, fetchImplementation);
    return "deleted";
  } catch (error) {
    if (error instanceof SlackPostError && error.slackError === "canvas_not_found") return "unknown";
    throw error;
  }
}

export async function chatPostMessage(
  botToken: string,
  input: { channel: string; threadTs?: string | undefined; text: string; blocks?: unknown[] | undefined },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ ts: string; channel?: string }> {
  const result = await callSlack("chat.postMessage", botToken, {
    channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false,
    ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
  }, fetchImplementation, (answer) => typeof answer.ts === "string");
  // A post to a user ID lands in the bot's direct message with them, whose ID Slack answers (E13).
  return { ts: result.ts as string, ...(typeof result.channel === "string" ? { channel: result.channel } : {}) };
}

/** Spec 025 E13: edits a message the bot posted. Errors carry Slack's code only, as chatPostMessage's do. */
export async function chatUpdate(
  botToken: string,
  input: { channel: string; ts: string; text: string; blocks: unknown[] },
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  await callSlack("chat.update", botToken, { channel: input.channel, ts: input.ts, text: input.text, blocks: input.blocks }, fetchImplementation);
}
