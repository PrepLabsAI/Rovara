import type { BrowserContext } from "playwright-core";
import { readBrowserState } from "./browser-state-reader.js";
import { tellBrowserState } from "./browser-state-secrets.js";
import { isSessionCookieSecret, parseSetCookie } from "./cookie-secret.js";
import { watchBrowserRequests } from "./request-capture.js";
import type { E2ESessionSyncSource } from "./session-sync.js";
import { visitorCookieSecret } from "./visitor-cookie.js";

/**
 * What the executor does with one case's browser context to learn its login secrets (MIDSTEP-2, MASKMAYBE round 2 R-6). One place for the host and the tests: the context is attached to the session
 * sync (read before every model call), its requests and URLs are watched, and a `Set-Cookie` of an answer is registered as it arrives. A signed-out visitor's context (`anonymous`) gets the same three,
 * judged with the visitor bar (an id or a cart is not a secret; a session, a token, a JWT is).
 */
export function wireSessionContext(input: {
  browserContext: BrowserContext;
  sessionRef: string;
  anonymous: boolean;
  sessionSync: E2ESessionSyncSource;
  /** Told a cookie value that is a session secret (a credential: the worker is told too). */
  registerSecret: (value: string) => void;
}): void {
  const { browserContext, sessionRef, anonymous, sessionSync } = input;
  sessionSync.attach(sessionRef, { storageState: () => readBrowserState(browserContext) }, { anonymous });
  watchBrowserRequests(browserContext, { learn: (items) => sessionSync.learn(items), track: (pending) => sessionSync.track(pending) }, { visitor: anonymous });
  // A session cookie the application swaps in or issues while the case runs is registered when its answer arrives.
  browserContext.on("response", (response) => {
    sessionSync.track(response.headersArray().then((headers) => {
      for (const header of headers) {
        if (header.name.toLowerCase() !== "set-cookie") continue;
        const issued = parseSetCookie(header.value);
        if (issued !== null && (anonymous ? visitorCookieSecret(issued) : isSessionCookieSecret(issued))) input.registerSecret(issued.value);
      }
    }, () => undefined));
  });
}

/**
 * What the case's browser holds when the case closes, whoever put it there: read with the same reader and classifier as the sync, with the visitor bar for a signed-out visitor. Best effort: a closed
 * page has nothing to ask.
 */
export async function readSessionContextAtClose(input: { browserContext: BrowserContext; anonymous: boolean; sessionSync: E2ESessionSyncSource }): Promise<void> {
  try {
    tellBrowserState(await readBrowserState(input.browserContext), (item) => input.sessionSync.learn([item]), undefined, { visitor: input.anonymous });
  } catch { /* the context is gone */ }
}
