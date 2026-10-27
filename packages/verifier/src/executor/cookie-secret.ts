// Which cookies and storage values are session secrets by length (moved out of form-login.ts so the browser-state readers can use it without importing the Playwright driver).

/** A cookie shorter than this is never a secret, whatever it is: `1`, `true`, `accepted` and `dark` are settings. */
const MIN_COOKIE_SECRET_LENGTH = 16;
/** An HttpOnly cookie is the application's own (the page cannot read it, so it is a session or a token); it counts from this length, the floor the redactor itself keeps. */
const MIN_HTTP_ONLY_COOKIE_SECRET_LENGTH = 8;
/** A local storage value is a setting, not a token, below this length: it is not registered as a session secret. */
const MIN_STORAGE_SECRET_LENGTH = 16;
/**
 * Whether a cookie the application issued is a session secret the executor must keep out of everything it writes: 16 characters or more, or HttpOnly and 8 to 15 that mix letters
 * and digits. Real session ids and tokens are longer than that, or random; a consent flag, a count, a language or a theme is not, and neither is a plain word or number that a
 * framework made HttpOnly with the rest of its cookies (`accepted`), and redacting one would rewrite the same word wherever it appears in a report.
 */
export function isSessionCookieSecret(cookie: { value: string; httpOnly: boolean }): boolean {
  if (cookie.value.length >= MIN_COOKIE_SECRET_LENGTH) return true;
  return cookie.httpOnly && cookie.value.length >= MIN_HTTP_ONLY_COOKIE_SECRET_LENGTH && /[A-Za-z]/.test(cookie.value) && /[0-9]/.test(cookie.value);
}
/** Whether a local storage value the application keeps is a session secret: the same length floor as a cookie without the HttpOnly band (storage has no such flag). */
export function isSessionStorageSecret(value: string): boolean {
  return value.length >= MIN_STORAGE_SECRET_LENGTH;
}
/** The name, value and HttpOnly flag of a Set-Cookie line; null for a line that is not `name=value; ...`. */
export function parseSetCookie(line: string): { name: string; value: string; httpOnly: boolean } | null {
  const [head, ...attributes] = line.split(";").map((part) => part.trim());
  const separator = head?.indexOf("=") ?? -1;
  if (head === undefined || separator < 1) return null;
  return { name: head.slice(0, separator), value: head.slice(separator + 1), httpOnly: attributes.some((attribute) => attribute.toLowerCase() === "httponly") };
}
