import type { BrowserContext } from "playwright-core";
import { readBrowserState } from "./browser-state-reader.js";
import { tellBrowserState } from "./browser-state-secrets.js";
import { parseSetCookie } from "./cookie-secret.js";
import { watchBrowserRequests } from "./request-capture.js";
import type { E2ESessionSyncSource } from "./session-sync.js";
import { cookieTier } from "./visitor-cookie.js";

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
        if (issued === null) continue;
        const tier = cookieTier(issued, anonymous);
        if (tier === "strong") input.registerSecret(issued.value);
        else if (tier !== null) sessionSync.learn([{ value: issued.value, tier }]);
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

/**
 * The host's two calls, with the choice of bar held here so that it can be tested without the host: whether a case's session is a signed-out visitor's (`isAnonymous`) decides the bar, never whether
 * the context is wired. Every case context is wired and read at close.
 */
export function wireCaseContext(input: { browserContext: BrowserContext; sessionRef: string; isAnonymous: (sessionRef: string) => boolean; sessionSync: E2ESessionSyncSource; registerSecret: (value: string) => void }): void {
  wireSessionContext({ browserContext: input.browserContext, sessionRef: input.sessionRef, anonymous: input.isAnonymous(input.sessionRef), sessionSync: input.sessionSync, registerSecret: input.registerSecret });
}
export async function readCaseContextAtClose(input: { browserContext: BrowserContext | undefined; sessionRef: string; isAnonymous: (sessionRef: string) => boolean; sessionSync: E2ESessionSyncSource }): Promise<void> {
  if (input.browserContext === undefined) return;
  await readSessionContextAtClose({ browserContext: input.browserContext, anonymous: input.isAnonymous(input.sessionRef), sessionSync: input.sessionSync });
}
