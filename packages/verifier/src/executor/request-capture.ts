import type { BrowserContext, Page } from "playwright-core";
import type { ClassifiedValue } from "./credential-classifier.js";
import { headerSecrets, urlSecrets } from "./request-secrets.js";

/**
 * Registers the login secrets the browser sends and visits (MIDSTEP-2). For one browser context:
 * - every request: its URL's query parameters, and its credential headers (`Authorization`, `Cookie`, `X-API-Key`, ...). The headers the page set are read at once (`request.headers()`); the
 *   full set, the browser's own added ones included, is read when the driver has it, for at most `HEADER_WAIT_MS`, and the session sync waits for that read (`track`) before it reads the browser.
 * - every frame navigation of every page, so the fragment of a URL (`#access_token=...`, which no request carries) and a redirect the page left at once are seen.
 * The sync also reads the frames' current URLs when it syncs (`browser-state-reader.ts`).
 */
export const REQUEST_HEADER_WAIT_MS = 1_500;

export interface RequestCaptureSink {
  learn(items: readonly ClassifiedValue[]): void;
  /** A read in progress; the session sync waits for it. */
  track(pending: Promise<unknown>): void;
}

function bounded(read: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, REQUEST_HEADER_WAIT_MS); });
  return Promise.race([read, wait]).finally(() => clearTimeout(timer));
}

export function watchBrowserRequests(context: BrowserContext, sink: RequestCaptureSink): void {
  const watchedPages = new WeakSet<Page>();
  const watchPage = (page: Page): void => {
    if (watchedPages.has(page)) return;
    watchedPages.add(page);
    page.on("framenavigated", (frame) => { sink.learn(urlSecrets(frame.url())); });
  };
  context.on("request", (request) => {
    sink.learn(urlSecrets(request.url()));
    sink.learn(headerSecrets(Object.entries(request.headers()).map(([name, value]) => ({ name, value }))));
    sink.track(bounded(request.headersArray().then((headers) => { sink.learn(headerSecrets(headers)); }, () => undefined)));
  });
  context.on("page", watchPage);
  for (const page of context.pages()) watchPage(page);
}
