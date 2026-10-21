import { E2E_FORM_LOGIN_SUCCESS_TIMEOUT_MS, type E2EFormLogin } from "@agentx/contracts";
import { chromium, request as playwrightRequest, type BrowserContext } from "playwright-core";

/** One cookie of a browser context's storage state, in the shape Playwright reads and writes. */
export type StorageCookie = Readonly<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }>;
/** What a context kept after the form login: its cookies and the localStorage of the origins it visited. Secret: it is held in the executor's memory and nowhere else. */
export type FormLoginStorageState = Readonly<{ cookies: readonly StorageCookie[]; origins: readonly Readonly<{ origin: string; localStorage: readonly Readonly<{ name: string; value: string }>[] }>[] }>;

/** `setCookies` are the raw Set-Cookie lines of the answer, for the caller to tell the executor which values the application issued since the sign-in. */
export type FormRequestResult = Readonly<{ status: number; body: Uint8Array; contentType: string; setCookies: readonly string[] }>;

/** A cookie shorter than this is never a secret, whatever it is: `1`, `true`, `accepted` and `dark` are settings. */
const MIN_COOKIE_SECRET_LENGTH = 16;
/** An HttpOnly cookie is the application's own (the page cannot read it, so it is a session or a token); it counts from this length, the floor the redactor itself keeps. */
const MIN_HTTP_ONLY_COOKIE_SECRET_LENGTH = 8;
/**
 * Whether a cookie the application issued is a session secret the executor must keep out of everything it writes: 16 characters or more, or HttpOnly and 8 or more. Real session ids
 * and tokens are longer than that; a consent flag, a count, a language or a theme is not, and redacting it would rewrite the same word or number wherever it appears in a report.
 */
export function isSessionCookieSecret(cookie: { value: string; httpOnly: boolean }): boolean {
  return cookie.value.length >= MIN_COOKIE_SECRET_LENGTH || (cookie.httpOnly && cookie.value.length >= MIN_HTTP_ONLY_COOKIE_SECRET_LENGTH);
}
/** The name, value and HttpOnly flag of a Set-Cookie line; null for a line that is not `name=value; ...`. */
export function parseSetCookie(line: string): { name: string; value: string; httpOnly: boolean } | null {
  const [head, ...attributes] = line.split(";").map((part) => part.trim());
  const separator = head?.indexOf("=") ?? -1;
  if (head === undefined || separator < 1) return null;
  return { name: head.slice(0, separator), value: head.slice(separator + 1), httpOnly: attributes.some((attribute) => attribute.toLowerCase() === "httponly") };
}
/** A Playwright request context that carries the storage state's cookies (and takes whatever the application rotates). */
export type FormRequestContext = Readonly<{
  request(input: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; signal: AbortSignal }): Promise<FormRequestResult>;
  dispose(): Promise<void>;
}>;

/** How the executor signs an account in through the application's own form (`rovara-form-login/v1`). A test supplies another one; the executor's own is `createPlaywrightFormLoginDriver`. */
export type FormLoginDriver = Readonly<{
  /**
   * Opens `login.path` of `origin` in a fresh browser context, fills the username and password fields, submits, waits up to 10 s for the signed-in marker to be visible, keeps the
   * context's storage state and closes the context. `status` is the first POST the form made, or 200 when the page signed in without one. Any failure is a thrown error; none
   * of them may carry the page's text or what was typed.
   */
  signIn(input: { origin: string; login: E2EFormLogin; email: string; password: string; signal: AbortSignal }): Promise<{ state: FormLoginStorageState; status: number }>;
  requestContext(input: { origin: string; state: FormLoginStorageState }): Promise<FormRequestContext>;
}>;

/** A form login that did not complete. It names the account profile and nothing else: no page text, no selector, no credential. */
export class FormLoginError extends Error {
  readonly profileId: string;
  constructor(profileId: string) {
    super(`the form login of account profile ${profileId} did not complete`);
    this.name = "FormLoginError";
    this.profileId = profileId;
  }
}

const MAX_BODY_BYTES = 1_048_576;
const LOGIN_NAVIGATION_TIMEOUT_MS = 10_000;

/**
 * The executor's form login: the Chromium the parent launched, reached over its DevTools endpoint, gives a fresh context (an incognito one, nothing shared with the case's own
 * context). Tracing is never started in it, so the keystrokes are in no trace; no screenshot is taken of it; its requests go through the same guard as every case context.
 * The context is closed before the case begins, and the case gets the cookies of what it kept.
 */
export function createPlaywrightFormLoginDriver(input: { cdpEndpoint: string; guard(context: BrowserContext): Promise<void> }): FormLoginDriver {
  return Object.freeze({
    async signIn({ origin, login, email, password, signal }) {
      signal.throwIfAborted();
      const browser = await chromium.connectOverCDP(input.cdpEndpoint, { timeout: LOGIN_NAVIGATION_TIMEOUT_MS });
      try {
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
        try {
          await input.guard(context);
          const page = await context.newPage();
          page.setDefaultTimeout(E2E_FORM_LOGIN_SUCCESS_TIMEOUT_MS);
          page.setDefaultNavigationTimeout(LOGIN_NAVIGATION_TIMEOUT_MS);
          let status: number | null = null;
          page.on("response", (response) => {
            if (status === null && response.request().method() === "POST" && new URL(response.url()).origin === origin) status = response.status();
          });
          const abort = () => { void context.close().catch(() => undefined); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            await page.goto(new URL(login.path, origin).href, { waitUntil: "load" });
            await page.getByTestId(login.usernameTestId).fill(email);
            await page.getByTestId(login.passwordTestId).fill(password);
            await page.getByTestId(login.submitTestId).click();
            await page.getByTestId(login.successTestId).waitFor({ state: "visible", timeout: E2E_FORM_LOGIN_SUCCESS_TIMEOUT_MS });
            return { state: await context.storageState(), status: status ?? 200 };
          } finally { signal.removeEventListener("abort", abort); }
        } finally { await context.close().catch(() => undefined); }
      } finally { await browser.close().catch(() => undefined); }
    },
    async requestContext({ origin, state }) {
      const context = await playwrightRequest.newContext({ baseURL: origin, storageState: { cookies: state.cookies.map((cookie) => ({ ...cookie })),
        origins: state.origins.map((item) => ({ origin: item.origin, localStorage: item.localStorage.map((entry) => ({ ...entry })) })) } });
      return Object.freeze({
        async request({ method, path, body, signal }) {
          const response = await context.fetch(new URL(path, origin).href, { method, maxRedirects: 0, failOnStatusCode: false, timeout: 30_000,
            ...(body === undefined || method === "GET" ? {} : { data: body as never }) });
          signal.throwIfAborted();
          const bytes = await response.body();
          if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("application response exceeds the fixed bound");
          return { status: response.status(), body: new Uint8Array(bytes), contentType: response.headers()["content-type"] ?? "application/octet-stream",
            setCookies: response.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => header.value) };
        },
        dispose: () => context.dispose(),
      });
    },
  });
}
