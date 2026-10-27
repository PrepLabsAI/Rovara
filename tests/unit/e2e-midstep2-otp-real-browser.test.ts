import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBrowserState } from "../../packages/verifier/src/executor/browser-state-reader.js";
import { createHostModelStack } from "../../packages/verifier/src/executor/host-model-stack.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { RUN_ID, TOOLS, tapAnswer } from "../support/e2e-model-fixtures.js";
import { MIDSTEP2_POSITION as POSITION, createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 MASKMAYBE, the one-time-code case, in a real Chromium: a page SHOWS a code that the AI must type into a field, and also (in some variants) keeps it somewhere the executor reads.
// The model double reads the code off what it is shown and types it; the page says "verified" only if the typed text is the code. This records, case by case, whether the code was masked
// (the model saw `<session>`), refused (a credential in the prompt) or neither, and whether the step could still succeed. Skipped where no Chromium is installed.

const haveChromium = existsSync(chromium.executablePath());
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomCode(length: number): string {
  for (;;) {
    const code = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]!).join("");
    if (/[0-9]/.test(code) && /[A-Za-z]/.test(code)) return code;
  }
}
const OTP6 = String(randomInt(100_000, 1_000_000));
const RANDOM10 = randomCode(10);
const RANDOM12 = randomCode(12);
const RANDOM20 = randomCode(20);

type Where = "display only" | "local storage, neutral key" | "session storage, neutral key" | "local JSON leaf, neutral key" | "plain cookie" | "URL ?code=" | "HttpOnly cookie" | "local storage key passcode";

function page(code: string, where: Where): string {
  const keep = {
    "display only": "",
    "local storage, neutral key": `localStorage.setItem("pendingCode", ${JSON.stringify(code)});`,
    "session storage, neutral key": `sessionStorage.setItem("verifyStep", ${JSON.stringify(code)});`,
    "local JSON leaf, neutral key": `localStorage.setItem("verification", JSON.stringify({ attempt: 1, expected: ${JSON.stringify(code)} }));`,
    "plain cookie": `document.cookie = "otp=" + ${JSON.stringify(code)} + "; path=/";`,
    "URL ?code=": "",
    "HttpOnly cookie": "",
    "local storage key passcode": `localStorage.setItem("passcode", ${JSON.stringify(code)});`,
  }[where];
  return `<!doctype html><html><body><h1>Verify your sign-in</h1><p id="code">Your code: ${code}</p><label>Enter it here <input id="answer"></label><button id="go">Verify</button><p id="result"></p>
    <script>${keep} document.getElementById("go").onclick = () => { const typed = document.getElementById("answer").value; document.getElementById("result").textContent = typed === ${JSON.stringify(code)} ? "verified" : "wrong"; };</script></body></html>`;
}

let dir: string;
let browser: Browser;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "otp-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

const TOOLS_V4 = TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

/** The model double: reads "Your code: X" off what it was shown and types X. If it was shown a placeholder, it types that. */
function readingModel(call: unknown): ReturnType<typeof tapAnswer> {
  const shown = JSON.stringify(call);
  const code = /Your code: ([^\s"\\]+)/.exec(shown)?.[1] ?? "nothing";
  return tapAnswer({ content: [{ type: "tool-call" as const, toolCallId: "call_type_1", toolName: "type", input: JSON.stringify({ target: "n1", value: code }) }] });
}

interface Outcome { shownToModel: string | null; masked: boolean; refused: boolean; succeeded: boolean }

async function attempt(code: string, where: Where): Promise<Outcome> {
  const server: Server = createServer((request, response) => {
    const headers: Record<string, string | string[]> = { "content-type": "text/html" };
    if (where === "HttpOnly cookie") headers["set-cookie"] = `otp=${code}; HttpOnly; Path=/`;
    response.writeHead(200, headers);
    response.end(page(code, where));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const context = await browser.newContext();
  const shown = await context.newPage();
  await shown.goto(where === "URL ?code=" ? `${origin}/verify?code=${code}` : `${origin}/verify`);
  const e = await harness.executor(readingModel);
  e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
  const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "rovara-e2e-default", registry: e.registry, sessionSync: e.source, position: () => POSITION });
  const snapshot = `URL: ${shown.url()}\n${await shown.innerText("body")}`;
  try {
    const answer = await stack.adapter.doGenerate({ prompt: [{ role: "system", content: "You drive a web application one tool call at a time." }, { role: "user", content: [{ type: "text", text: `Goal: type the code on the page into the field\n${snapshot}` }] }],
      tools: TOOLS_V4, toolChoice: { type: "required" } }) as { content: Array<{ input: string }> };
    const typed = (JSON.parse(answer.content[0]!.input) as { value: string }).value;
    await shown.fill("#answer", typed);
    await shown.click("#go");
    const result = await shown.innerText("#result");
    return { shownToModel: JSON.stringify(e.run.seen[0]), masked: JSON.stringify(e.run.seen[0]).includes("<session>"), refused: false, succeeded: result === "verified" };
  } catch (error) {
    if ((error as { code?: string }).code !== "credential-in-prompt") throw error;
    return { shownToModel: null, masked: false, refused: true, succeeded: false };
  } finally {
    await context.close();
  }
}

describe.skipIf(!haveChromium)("a one-time code the AI must type (real Chromium)", () => {
  beforeEach(async () => { browser = await chromium.launch(); closers.push(() => browser.close()); });

  it("a 6-digit numeric OTP is never masked or refused, wherever the page keeps it (it is under 8 characters, so it is never registered): the step succeeds", async () => {
    for (const where of ["display only", "local storage, neutral key", "session storage, neutral key", "local JSON leaf, neutral key", "plain cookie", "URL ?code=", "HttpOnly cookie", "local storage key passcode"] as const) {
      const outcome = await attempt(OTP6, where);
      expect(outcome, where).toMatchObject({ masked: false, refused: false, succeeded: true });
      expect(outcome.shownToModel, where).toContain(OTP6);
    }
  }, 120_000);

  it.each([["10", () => RANDOM10], ["12", () => RANDOM12]])("a random-looking %s-character code is shown to the model and the step succeeds when the page only shows it or keeps it in storage or a cookie of a neutral name", async (_length, code) => {
    for (const where of ["display only", "local storage, neutral key", "session storage, neutral key", "local JSON leaf, neutral key", "plain cookie"] as const) {
      const outcome = await attempt(code(), where);
      expect(outcome, where).toMatchObject({ masked: false, refused: false, succeeded: true });
    }
  }, 120_000);

  it("RECORDED LIMITS (not fixed, no opt-out): a random-looking 8-12 character code IS masked when it is also in the URL as ?code= (the model types the placeholder, the step fails), is refused when an HttpOnly cookie or a credential-named key (passcode) holds it, and a 16+ character code kept in storage under a neutral key is masked too", async () => {
    // In the URL: weak (an OAuth `code` parameter is scrubbed), so now masked for the model: the call goes ahead, the model reads `<session>` and types it, the page says "wrong".
    const inUrl = await attempt(RANDOM10, "URL ?code=");
    expect(inUrl).toMatchObject({ masked: true, refused: false, succeeded: false });
    expect(inUrl.shownToModel).not.toContain(RANDOM10);
    // HttpOnly cookie with letters and digits: a session value (strong). A prompt that shows it is refused, as before this change.
    expect(await attempt(RANDOM12, "HttpOnly cookie")).toMatchObject({ masked: false, refused: true, succeeded: false });
    // A key named like a credential (passcode, pin, token...): strong, refused.
    expect(await attempt(RANDOM10, "local storage key passcode")).toMatchObject({ masked: false, refused: true, succeeded: false });
    // 16+ characters under a neutral key: weak (opaque token), masked.
    expect(await attempt(RANDOM20, "local storage, neutral key")).toMatchObject({ masked: true, refused: false, succeeded: false });
  }, 120_000);
});
