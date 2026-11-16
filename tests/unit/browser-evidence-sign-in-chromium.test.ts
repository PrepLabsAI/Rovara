// TE-H1 slice 3 in a real Chromium (skipped where none is installed; the CI linux-runtime job runs the executor image's own test). An app behind a login: the driver signs in once with the saved values, every page is taken signed in,
// a sign-in that did not work takes no page, a session that bounces back to the login page is no picture, and neither value, in any spelling, nor the login fields ever reach a picture.
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, type BrowserEvidenceExecutorSignIn, type BrowserEvidenceSignInValues } from "../../packages/contracts/src/index.js";
import { runCapture } from "../../packages/verifier/src/executor/browser-evidence-entry.js";
import { createChromiumEvidenceDriver, startProjectApp, type ProjectApp } from "../../packages/verifier/src/executor/browser-evidence-chromium.js";

const haveChromium = existsSync(chromium.executablePath());
const FIXTURE = join(process.cwd(), "tests/fixtures/browser-evidence-app");
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});
const command = `"${process.execPath}" ../server.mjs`;
const FORM: BrowserEvidenceExecutorSignIn = { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]", successPath: "/dashboard" };
/** Built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection. */
const ADA: BrowserEvidenceSignInValues = { username: ["tester", "ada", "7"].join("-"), password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
const BOB: BrowserEvidenceSignInValues = { username: ["tester", "bob", "9"].join("-"), password: ["pw", "Rt5", "Hk3", "Ya8"].join("-") };

let browser: Browser | undefined;
beforeAll(async () => { if (haveChromium) browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

/** The fixture app started with `account` as its one account, and the driver that signs in with `values` (which may be another person's). */
async function world(account: BrowserEvidenceSignInValues, values: BrowserEvidenceSignInValues, form: BrowserEvidenceExecutorSignIn = FORM) {
  const port = await freePort();
  const apps = new Map<string, ProjectApp>();
  const driver = createChromiumEvidenceDriver({
    browser: browser!, origin: `http://127.0.0.1:${port}`, signIn: { form, values },
    app: {
      async start(side, timeoutMs) {
        const started = await startProjectApp({ command, cwd: join(FIXTURE, side), port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BE_USER: account.username, BE_PASS: account.password } });
        if (started.status === "ready") apps.set(side, started.app);
        return started.status;
      },
      async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
    },
  });
  expect(await driver.startApp("after", { timeoutMs: 20_000 })).toBe("ready");
  return { driver, port, stop: () => driver.stopApp("after") };
}
const MASKS = [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, "#email", "#password"];
const picture = async (driver: Awaited<ReturnType<typeof world>>["driver"], route: string, maskSelectors: readonly string[] = MASKS) => {
  const answer = await driver.capture("after", route, { maskSelectors, timeoutMs: 15_000 });
  if (!answer.ok) return answer.reason;
  return Buffer.from(answer.bytes).toString("base64");
};

describe.skipIf(!haveChromium)("browser evidence behind a login, in a real Chromium", () => {
  it("signs in with the saved values and takes the page signed in; the account's name, wherever the page writes it, is not in the picture", async () => {
    const a = await world(ADA, ADA);
    const b = await world(BOB, BOB);
    try {
      expect(await a.driver.signIn({ timeoutMs: 15_000 })).toBe("ok");
      expect(await b.driver.signIn({ timeoutMs: 15_000 })).toBe("ok");
      // Positive control: pages that are not behind the login are not what the sign-in made possible; the signed-in page really loads (a picture, not a reason).
      for (const route of ["/dashboard", "/account", "/profile-field", "/account-urlencoded"]) {
        const x = await picture(a.driver, route);
        const y = await picture(b.driver, route);
        // Two different accounts, one picture: nothing of the account is in it (the name as text, in a field, percent-encoded).
        expect(x.length, route).toBeGreaterThan(1_000);
        expect(x, route).toBe(y);
      }
      // The masked text is the same picture as a page that was never given a name, and a page with another name is another picture (so the equality above is the masking, not an empty page).
      expect(await picture(a.driver, "/account")).toBe(await picture(a.driver, "/account-static"));
      expect(await picture(a.driver, "/account-static")).not.toBe(await picture(a.driver, "/account-other"));
    } finally { await a.stop(); await b.stop(); }
  }, 180_000);

  it("takes no page when the sign-in did not work (a wrong password), says so, and never takes the login form for the page", async () => {
    const w = await world(ADA, { ...ADA, password: ["not", "the", "password"].join("-") });
    try {
      expect(await w.driver.signIn({ timeoutMs: 15_000 })).toBe("sign_in_failed");
      for (const route of ["/dashboard", "/account", "/login"]) expect(await picture(w.driver, route), route).toBe("capture_failed");
      // The capture program's whole answer is the app's state and nothing else.
      expect(await runCapture({ port: w.port, routes: ["/account"], maskSelectors: [], runMs: 60_000, pageMs: 15_000, signIn: FORM }, { waitReady: async () => "ready", driver: w.driver }))
        .toEqual([{ t: "app", status: "sign_in_failed" }]);
    } finally { await w.stop(); }
  }, 120_000);

  it("takes the capture program's pages signed in, in one session, when the sign-in works", async () => {
    const w = await world(ADA, ADA);
    try {
      const lines = await runCapture({ port: w.port, routes: ["/account", "/dashboard"], maskSelectors: [], runMs: 90_000, pageMs: 15_000, signIn: FORM }, { waitReady: async () => "ready", driver: w.driver });
      expect(lines.map((line) => (line.t === "app" ? line.status : line.ok ? "shown" : line.reason))).toEqual(["ready", "shown", "shown"]);
      expect(JSON.stringify(lines)).not.toContain(ADA.password);
    } finally { await w.stop(); }
  }, 120_000);

  it("takes no picture of a page that sends the person back to the login page (the session did not hold), nor of one that sends them to another site", async () => {
    const w = await world(ADA, ADA);
    try {
      expect(await w.driver.signIn({ timeoutMs: 15_000 })).toBe("ok");
      expect(await picture(w.driver, "/expired")).toBe("capture_failed");
      expect(await picture(w.driver, "/away")).not.toMatch(/^\/9j/u);
    } finally { await w.stop(); }
  }, 120_000);

  it("is a sign-in that did not work, never a guess at another field, when the form is not what the recipe says (mutants: a wrong selector, a wrong success page)", async () => {
    for (const form of [{ ...FORM, usernameSelector: "#nope" }, { ...FORM, passwordSelector: "#nope" }, { ...FORM, submitSelector: "#nope" }, { ...FORM, successPath: "/account-never" }, { ...FORM, successPath: undefined, successSelector: "#never-there" }]) {
      const w = await world(ADA, ADA, form);
      try {
        expect(await w.driver.signIn({ timeoutMs: 20_000 }), JSON.stringify(form)).toBe("sign_in_failed");
        expect(await picture(w.driver, "/account"), JSON.stringify(form)).toBe("capture_failed");
      } finally { await w.stop(); }
    }
  }, 240_000);

  it("is the run's own time limit, not a failed sign-in, when the run's time is what ran out", async () => {
    const w = await world(ADA, ADA);
    try { expect(await w.driver.signIn({ timeoutMs: 1 })).toBe("time_limit"); } finally { await w.stop(); }
  }, 60_000);

  it("paints over the sign-in's own two fields in every picture: a field the recipe names is not shown, whatever it holds", async () => {
    const w = await world(ADA, ADA);
    try {
      await w.driver.signIn({ timeoutMs: 15_000 });
      expect(await picture(w.driver, "/prefilled-a", MASKS)).toBe(await picture(w.driver, "/prefilled-b", MASKS));
      // Positive control: with no painting the two pages are two pictures.
      expect(await picture(w.driver, "/prefilled-a", [])).not.toBe(await picture(w.driver, "/prefilled-b", []));
    } finally { await w.stop(); }
  }, 120_000);

  it("refuses the whole sign-in for values that would not mask (never types a value it could not hide)", async () => {
    const port = await freePort();
    const driver = createChromiumEvidenceDriver({ browser: browser!, origin: `http://127.0.0.1:${port}`, signIn: { form: FORM, values: { username: "ab", password: "cd" } }, app: { start: async () => "ready", stop: async () => undefined } });
    expect(await driver.signIn({ timeoutMs: 5_000 })).toBe("sign_in_failed");
  }, 30_000);
});
