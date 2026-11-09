// The control plane's words for a refusal (Plan 3 Task 26), made safe to show a member or print in a task's error. One definition, shared by the worker, the
// model runtime and the Slack service: control and format characters are dropped, the text is cut to 300 characters, and the angle-bracket forms Slack acts on
// (`<@U123>` a user, `<#C123>` a channel, `<!here>` a broadcast, `<url|label>` a link) lose their brackets, so they read as plain text.

/** The most characters of a refusal that are kept. */
export const REFUSAL_WORDS_MAX = 300;

/** The refusal's words as safe text, or undefined when it has none. */
export function safeRefusalWords(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[<>]/gu, "").trim().slice(0, REFUSAL_WORDS_MAX).trim();
  return cleaned === "" ? undefined : cleaned;
}
