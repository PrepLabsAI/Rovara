import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { launchLocalChromium } from "./local-browser.js";

// Proves the image's Chromium starts as the unprivileged user without any network: load a data URL, read it back, exit.
const downloads = await mkdtemp(join(tmpdir(), "rovara-smoke-"));
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("chromium smoke check timed out")), 60_000);
let browser: Awaited<ReturnType<typeof launchLocalChromium>> | null = null;
try {
  browser = await launchLocalChromium({ downloadDir: downloads, signal: controller.signal });
  const connected = await chromium.connectOverCDP(browser.cdpEndpoint);
  const context = await connected.newContext();
  const page = await context.newPage();
  await page.goto("data:text/html,<p data-testid=ok>ok</p>");
  const text = await page.getByTestId("ok").textContent();
  await connected.close();
  if (text !== "ok") throw new Error(`unexpected page text: ${String(text)}`);
  process.stdout.write("chromium ok\n");
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`chromium smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await browser?.close().catch(() => undefined);
  await rm(downloads, { recursive: true, force: true });
}
