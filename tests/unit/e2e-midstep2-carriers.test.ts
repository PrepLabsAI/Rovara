import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBrowserState } from "../../packages/verifier/src/executor/browser-state-reader.js";
import type { BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { watchBrowserRequests } from "../../packages/verifier/src/executor/request-capture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CARRIER_NAMES, STRONG_CARRIERS, plantCarrierSets, startCarriersApp, spellings, type CarrierName, type CarriersAppProcess, type PlantedSet } from "../support/e2e-midstep-carriers.js";
import { call } from "../support/e2e-model-fixtures.js";
import { MIDSTEP2_POSITION, createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// The carrier fixture (tests/fixtures/e2e-midstep-carriers) in a real Chromium, against the real MIDSTEP-2 model-side stack of the harness (the worker's proxy, the executor's redactor, registry,
// session source, channel client with its scan and mask), without Docker and without the executor: the same flow as tests/linux/e2e-midstep-carriers.test.ts, one carrier per test. The page
// signs in through the app's own form; the test takes the first "model call" (nothing secret on screen), clicks the carrier's sync button (the app acquires a session cookie, a local storage
// token, a session storage token, a JSON leaf token, a `?token=` URL, an Authorization-header call, an IndexedDB token and an opaque id), and takes the second call with what the page then shows.
// The values are random for each run and exist only in the temp directory of the app. Skipped where no Chromium is installed.
const haveChromium = existsSync(chromium.executablePath());
const PASSWORD = randomBytes(12).toString("base64url");
const ACCOUNTS = JSON.stringify({ schemaVersion: "rovara-accounts/v1", accounts: [{ profileId: "orders-owner", email: "maya@example.com", password: PASSWORD, tenantRef: "tenant-a", roleRef: "owner" }] });

let dir: string;
let app: CarriersAppProcess;
let sets: Record<string, PlantedSet>;
const closers: Array<() => Promise<unknown>> = [];
beforeAll(async () => { if (!haveChromium) return; sets = plantCarrierSets(CARRIER_NAMES); app = await startCarriersApp(ACCOUNTS, sets); });
afterAll(async () => { await app?.stop(); });
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "m2cr-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

const panelText = (page: Page) => page.locator('[data-testid="panel"]').innerText();

async function signIn(page: Page): Promise<void> {
  await page.goto(`${app.upstream}/`);
  await page.locator('[data-testid="email"]').fill("maya@example.com");
  await page.locator('[data-testid="password"]').fill(PASSWORD);
  await page.locator('[data-testid="login-submit"]').click();
  await page.locator('[data-testid="identity"]').waitFor();
}

/** One carrier's flow. `stale` makes the session sync read the browser as it was just before the click and never again (what a broken mid-step sync would do). */
async function flow(name: CarrierName, options: { stale?: boolean } = {}) {
  const browser: Browser = await chromium.launch();
  closers.push(() => browser.close());
  const context = await browser.newContext();
  const e = await harness.executor();
  watchBrowserRequests(context, { learn: (items) => e.source.learn(items), track: (pending) => e.source.track(pending) });
  const page = await context.newPage();
  await signIn(page);
  let frozen: BrowserSecretState | null = null;
  e.source.attach("s2", { storageState: async () => frozen ?? readBrowserState(context) }, { anonymous: false });
  // The step's first model call: the page shows nothing that was synced, and the call goes through.
  const first = await e.executorSays(`${await panelText(page)} at ${page.url()}`);
  if (options.stale) frozen = await readBrowserState(context);
  await page.locator(`[data-testid="sync-${name}"]`).click();
  await page.waitForFunction(`/^Synced/.test(document.querySelector('[data-testid="panel"]')?.textContent ?? "")`);
  const shown = `${await panelText(page)} at ${page.url()}`;
  const second = await e.executorSays(shown);
  return { e, first, second, shown, set: sets[name]!, seen: () => JSON.stringify(e.run.seen) };
}
const has = (text: string, value: string) => spellings(value).some((form) => text.includes(form));

describe.skipIf(!haveChromium)("the carrier fixture in a real browser, against the MIDSTEP-2 model-side stack", () => {
  it("control: the app acquires every carrier mid-step but shows none, and the second call goes through", async () => {
    const { e, first, second, set, seen } = await flow("control");
    expect(first).toBe("ok");
    expect(second).toBe("ok");
    expect(e.run.seen).toHaveLength(2);
    expect(seen()).toContain("Synced quietly");
    // Every value the app issued is in the browser by now, and none is on screen: nothing was refused, nothing was masked.
    for (const value of Object.values(set)) expect(has(seen(), value)).toBe(false);
  });

  for (const carrier of STRONG_CARRIERS) {
    it(`${carrier}: the call that would show the value is refused by the executor (credential-in-prompt) and by the worker (refused-credential-match); no spelling reaches the provider`, async () => {
      const { e, first, second, shown, set, seen } = await flow(carrier);
      expect(first).toBe("ok");
      // The page does show it (the test is not passing because nothing was shown).
      expect(has(shown, set[carrier])).toBe(true);
      expect(second).toBe("credential-in-prompt");
      expect(e.run.seen).toHaveLength(1);
      // The worker's own scan agrees: the sync told it the value, so the same prompt sent without the executor's scan (as the call the executor refused, index 1) is refused there with a receipt.
      const atWorker = await e.workerOnly.generate({ ...MIDSTEP2_POSITION, callIndex: 1, call: call(`#n1 text "${shown}"`) });
      expect(atWorker.result).toMatchObject({ status: "error", code: "refused-credential-match" });
      expect(e.run.seen).toHaveLength(1);
      for (const value of Object.values(set)) expect(has(seen(), value), "a planted value reached the provider").toBe(false);
    });
  }

  it("weak: an opaque id under a neutral key is shown to the model as <session>, never as the value, and the call goes through", async () => {
    const { e, first, second, shown, set, seen } = await flow("weak");
    expect(first).toBe("ok");
    expect(has(shown, set.weak)).toBe(true);
    expect(second).toBe("ok");
    expect(e.run.seen).toHaveLength(2);
    expect(seen()).toContain("Synced weak: <session>");
    for (const value of Object.values(set)) expect(has(seen(), value), "a planted value reached the provider").toBe(false);
  });

  // The positive control: the same flow with a mid-step sync that is stale. The values the app keeps in the browser then reach the provider, so the tests above cannot pass for the wrong reason.
  for (const carrier of ["local", "session", "json", "idb"] as const) {
    it(`control for ${carrier}: with a stale session read the value reaches the provider (the refusal above is the sync's doing)`, async () => {
      const { e, second, set, seen } = await flow(carrier, { stale: true });
      expect(second).toBe("ok");
      expect(e.run.seen).toHaveLength(2);
      expect(has(seen(), set[carrier])).toBe(true);
    });
  }
});
