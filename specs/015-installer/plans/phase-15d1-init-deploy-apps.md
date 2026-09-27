# Phase 15d1: `agentx init` Through the Slack Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentx init` takes an engineer from AWS credentials to a deployed AgentX environment with
its own GitHub App and Slack app. It:
- checks prerequisites and stops before creating anything when the region or a model won't work;
- asks every question (each also a flag), shows what it will create and what it will cost, and asks
  for confirmation;
- runs its steps one by one, recording each in SSM, and resumes from the first incomplete step;
- creates the GitHub App with GitHub's manifest flow and the Slack app from a Slack manifest, with
  secrets going straight from the vendor or a hidden prompt into Secrets Manager.

It ends with all six stacks deployed, environment settings written and the local cache set up.
Phase 15d2 adds the admin user, the first project and channel, connectors, alerts, the budget and
the end-to-end Slack reply.

**Architecture:**
- **A generic step runner** (`init/steps.ts`) holds the environment lock for the whole run, reads
  progress from SSM, skips steps already done, and writes each step's outcome as soon as it has
  one. A step may finish (`done`) or stop to wait for a person (`waiting`, for Slack admin
  approval). A step that fails is not recorded, so the next run retries it.
- **Install state lives in two SSM parameters** beside the environment settings:
  `/agentx/<env>/install/answers` (the answers, with no secret) and `/agentx/<env>/install/progress`
  (step outcomes and the GitHub and Slack facts collected so far). Environment settings are still
  written only by `deployEnvironment`, once the Slack stack exists (the 15c2 ruling).
- **Deploy steps drive 15c2's `deployEnvironment` unchanged in behaviour**, one step per group of
  parts, with `parts` and a new `lockHeld` flag (the runner already holds the lock). A new
  `prepareDeployment` is factored out of `runDeploy`, so `agentx deploy` and `agentx init` build
  the engine, check the caller's account and hold the stores the same way.
- **The step order follows the deploy-order decision:** prerequisites; access; foundation and
  identity; the GitHub App; control plane and runtime; the Slack app; the Slack service. The GitHub
  App comes before the control plane because the control plane takes its details. The Slack app
  comes after the control plane because its manifest needs the control plane's URLs.
- **Every vendor and AWS call sits behind an injected interface:** prompts, Bedrock, AgentCore,
  GitHub, Slack, Secrets Manager, CloudFormation status, fetch, the browser, sleep and the clock.
  No test reaches AWS, GitHub or Slack. The GitHub manifest listener is a real HTTP server on
  `127.0.0.1`, which tests drive with `fetch`.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4
(`z.partialRecord`), Vitest, commander 15, AWS SDK v3 3.1134.0 (`@aws-sdk/client-ssm`,
`client-secrets-manager`, `client-cloudformation`, `client-sts`; new in the CLI:
`@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock-agentcore-control`), `node:crypto`
(RS256 JWT for the GitHub App), `node:http` (loopback listener), the system `tar`.

**Spec:** [../spec.md](../spec.md):
- FR-015 (prerequisites), FR-016 (questions), FR-017 (plan and cost), FR-018 steps 1 to 5 (in
  the deploy order below), FR-019 (resume; nothing changes on re-run), FR-020 (flags and secret
  inputs).
- FR-027 to FR-030 (GitHub App), FR-031 to FR-035 (Slack app and Slack service).
- The alert address question from FR-016. Subscribing it is FR-045, in 15d2.
- FR-021's discovery check for your own OIDC provider. The admin-claim check needs the admin
  user, so it is in 15d2.

Phase 15d2 ([phase-15d2-init-finish.md](phase-15d2-init-finish.md), an outline until this phase
merges) covers:
- FR-018 steps 6 to 10;
- FR-019's operator-role resume and the export path;
- FR-036 to FR-041, and FR-045 to FR-047.

The phase map is in [README.md](README.md).

**Branch:** `feat/015d-init` in `/Users/abhishekgarg/web/AgentX-p15d`, cut from mainline `06def19`
(phases 15a, 15b, 15c1 and 15c2 merged). One PR, against `mainline`. Do not stack a 15d2 branch
on it: 15d2 is cut from mainline after this merges.

## Decisions recorded by this plan

- **Why 15d is split.** The whole of 15d would be about 22 tasks across three vendors, four new
  commands and a policy change. 15d1 is the part every later step stands on: questions, the
  runner, the deploys and the two app flows. Its live check proves a real GitHub App and Slack app
  against a real environment. 15d2 is the part that talks to people and third parties (admin
  user, projects, channels, connectors, alerts, budget) and needs the operator-role policy
  additions.
- **Step order**, recorded in `INIT_STEP_IDS`:

  | Step id | What it does | FR-018 step |
  |---|---|---|
  | `prerequisites` | the FR-015 checks | 1 |
  | `access` | deploys the access stack with the caller's own rights | 3 |
  | `core` | deploys foundation, and identity unless you bring your own OIDC | 2 |
  | `github-app` | runs the manifest flow, stores the key, waits for the installation, checks repository access | 4 |
  | `control-plane` | deploys the control plane and runtime | 2 |
  | `slack-app` | creates the app from a manifest and stores the token and signing secret | 5 |
  | `slack-service` | deploys the Slack service, writes settings (by `deployEnvironment`), probes the Slack URLs, writes the local cache | 5 |

  This is FR-018's list, reordered to match the spec's own deploy-order decision. It is listed
  under Open questions for the owner to amend FR-018's text.
- **The GitHub App has no webhook and subscribes to no events.** AgentX handles no GitHub webhook:
  the control plane has no webhook route, and `grep -ri webhook infra/lib packages/broker/src`
  finds nothing. The control plane also doesn't exist yet when the app is created. The manifest
  asks for exactly the permissions the broker requests in `packages/broker/src/github-app.ts`:
  `contents: write`, `pull_requests: write`, `issues: write` and `metadata: read`. It's an Open
  question, because FR-027 mentions a webhook URL.
- **The manifest listener binds `127.0.0.1` on a free port (port 0)**, never 8765. Port 8765 stays
  free for `agentx login` and the Asana sign-in. The manifest's `redirect_url` names the chosen
  port, so any port works.
- **With `--no-browser`, the GitHub code is pasted back** (FR-030). The CLI still serves the form
  page on `127.0.0.1`: open it through an `ssh -L` tunnel or on the same machine. After GitHub
  creates the app, the engineer pastes the address GitHub redirected to (or just its `code`).
  The CLI checks the `state` when the address carries one.
- **Slack verification (FR-033)** works like this:
  - After the token and signing secret are stored, the CLI sends a request signed with the
    signing secret to the events URL (a `url_verification` challenge, which must be echoed back)
    and to the interactivity URL (which must answer with anything but 401).
  - The ingress caches the Slack secret for 5 minutes, so the probe retries for up to 7 minutes.
  - It then opens the app's Event Subscriptions page and asks the engineer to confirm that Slack
    shows the URL as Verified (clicking Retry if it doesn't).
  - Slack offers no API that reports verification without an app configuration token, and it
    never verifies interactivity URLs at all. This is recorded under Open questions.
- **Slack bot scopes** are `app_mentions:read`, `chat:write`, `users:read`, `channels:read`,
  `groups:read` and `channels:join`.
  - The first three are what the ingress and Slack service use today.
  - `users:read` also covers `bots.info`, which gives the app ID.
  - The other three are for 15d2's `channel add` (find a channel, join a public one), so the app
    never needs reinstalling.
  - No history scope is requested. 15d2 confirms the end-to-end reply through turn records, not by
    reading channel history.
- **Alert webhook addresses are secrets.** PagerDuty and Opsgenie integration addresses carry
  their integration key (Opsgenie's is `?apiKey=...`).
  - A webhook is read only from a hidden prompt, `--alert-webhook-file` or `--alert-webhook-env`,
    and stored in `agentx/<env>/alert-endpoint`.
  - The answers keep only `https://<host>/...` for display.
  - An email address is not secret and may be given as `--alert-email`.
- **`--yes` answers yes to every question**, including the plan confirmation, running
  `cdk bootstrap` when the cdk engine needs it, and "does Slack show Verified". Every other
  unanswered question takes its default or, when there is none, fails with the flag to pass.
- **Defaults** (spec Decisions, verbatim ids):
  - orchestrator `us.anthropic.claude-sonnet-4-6`, with `zai.glm-4.7` offered as the lower-cost
    choice;
  - classifier (the action-gate checker) `amazon.nova-lite-v1:0`, with
    `us.anthropic.claude-haiku-4-5-20251001-v1:0` offered;
  - worker `amazon.nova-pro-v1:0`, the existing `init --export` default.
- **Already decided, restated so nothing here contradicts it:**
  - a named environment's AgentCore runtime has DeletionPolicy Delete;
  - the capacity provider is retained, because deleting it deletes every workspace volume;
  - `agentx destroy` belongs to phase 15e.
- **A waiting step exits 0.** The printed message and the `--json` data (`"status": "waiting"`)
  say what to do. See Open questions.

## Open questions for the owner

Each question has the plan's recommended answer. The plan is written to the recommendation, and the
spec entries in Task 12 record it for confirmation in the PR.

1. **FR-018's step list vs the deploy-order decision.** FR-018 lists the operator and service roles
   (step 3) after the core stacks (step 2), and the GitHub App (step 4) after the control plane.
   The spec's own deploy-order decision needs access first, and the GitHub App before the control
   plane. *Recommended:* amend FR-018's list to the order in "Decisions recorded by this plan".
2. **FR-027's webhook URL.** AgentX handles no GitHub webhook, and the control plane doesn't exist
   yet when the app is created. *Recommended:* no webhook and no events; amend FR-027 to say so.
3. **FR-033's "confirm Slack has verified" both URLs.** No Slack API reports verification without
   an app configuration token, and Slack never verifies interactivity URLs. *Recommended:* a signed
   self-probe of both URLs, then the engineer confirms "Verified" on the page. 15d2's end-to-end
   reply is the real proof.
4. **Two hidden-prompt pastes for Slack**, against User Story 1's "nothing is copied between
   screens by hand". FR-032 itself requires hidden prompts. The alternative, Slack's App Manifest
   API, needs an app configuration token pasted instead, and still needs an OAuth install for the
   bot token. *Recommended:* keep FR-032's two pastes, count them in the live check (SC-002 allows
   15 actions), and revisit only if SC-001 shows people stumble here.
5. **Alert webhook addresses carry integration keys.** *Recommended:* treat them as secrets, as
   this plan does. FR-048's `alerts.address` then shows the host only for a webhook.
6. **`agentx init --export` refuses `--env production` outright.** That rule exists because of our
   own adopted deployment, but it blocks every other organization's natural default name.
   *Recommended:* refuse only when SSM already holds settings for that environment. That is a
   read-only check, which FR-026 allows. Change it in 15d2 with the export resume. The interactive
   `init` in this phase already follows the recommended rule.
7. **Exit code for a waiting step (Slack admin approval).** *Recommended:* 0, with
   `"status": "waiting"` in `--json`, because nothing failed. The alternative is a distinct
   non-zero code, so scripts notice.
8. **Where install progress lives.** FR-003 lists install progress among the settings, but
   settings are written only once the Slack stack exists (the 15c2 ruling), and an SSM parameter
   holds at most 4 KB. *Recommended:* the two parameters `/agentx/<env>/install/answers` and
   `/progress`; amend FR-003's wording.
9. **The cost estimate's basis.** List prices at a stated usage:
   - 1,000 turns;
   - 100 worker sessions;
   - 60 worker instance-hours;
   - 10 kept workspaces.

   It does not include any AgentCore charge beyond the EC2 instance and EBS volumes; the plan could
   not confirm whether AgentCore Runtime adds one for `instances-ebs`. *Recommended:* keep the
   stated-usage estimate, and have the owner confirm the AgentCore pricing line before the live
   check.
10. **`--yes` runs `cdk bootstrap` when the cdk engine needs it.** *Recommended:* yes, because
    `--yes` means yes to every question and the plan text says so. The alternative is a separate
    `--cdk-bootstrap` flag.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Never run vitest with `-u`. No test, and no step of
  the live check, touches production's stacks or its `/agentx/production/*` parameters.
- **No test reaches AWS, GitHub or Slack.** Every client is injected, as in
  `tests/contract/deploy-cli.test.ts`'s `safeDeployDeps`. The only real network use in tests is the
  loopback listener on `127.0.0.1`.
- **No secret value in output, logs, errors, local files or SSM:** the GitHub App private key, the
  Slack bot token, the Slack signing secret, the callback signing key and the alert webhook
  address. Every task that handles one asserts its value appears in none of those.
- **Secrets are never read from a flag's value.** They come only from a hidden prompt,
  `--<name>-file <path>` or `--<name>-env <NAME>` (FR-020). A pasted secret is read whole, never
  truncated at 128 characters.
- **Exact names:**
  - SSM `/agentx/<env>/install/answers` and `/agentx/<env>/install/progress`, each at most 4096
    bytes (the standard-tier limit);
  - secrets `agentx/<env>/github-app` (JSON `{"appId","slug","account","privateKey"}`, which
    `privateKeyFromSecret` accepts), `agentx/<env>/slack` (JSON `{"signingSecret","botToken"}`,
    created by the control plane, value put by init) and `agentx/<env>/alert-endpoint` (the
    webhook URL as a plain string);
  - lock command `init`.
- **Settings are written only by `deployEnvironment`.** `init` never writes
  `/agentx/<env>/settings` itself.
- **Pinned dependencies:** exact versions, matching the `3.1134.0` every other `@aws-sdk` client
  in `packages/cli/package.json` uses.
- **Copy:**
  - plain words;
  - every error says what to do next;
  - no em dashes in any AWS resource name or description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.

## Review Focus

1. **A killed or closed terminal leaves the SSM lock held by the same person.** `withEnvironmentLock`
   releases only on a thrown error, not when the process dies. Today the next `agentx init` would
   refuse with "locked by you" for two hours. Expected: the same caller running the same command
   is offered a takeover at once, after confirming no other run is still going. Someone else's
   fresh lock is still refused without asking. Pinned in Task 2 (lock) and Task 3 (runner).
2. **Resuming while a stack from the interrupted run is still `CREATE_IN_PROGRESS`,
   `UPDATE_IN_PROGRESS` or `ROLLBACK_IN_PROGRESS`.** CloudFormation keeps going after the terminal
   closes, and the templates engine answers "stack is busy". Expected: the deploy step waits for
   the stack to settle, saying so, then deploys. It fails with a clear message only after 60
   minutes. Pinned in Task 7.
3. **A pasted secret with a trailing CR or LF, surrounding spaces, bracketed-paste markers
   (`ESC[200~` and `ESC[201~`), or more than 128 characters.** Expected:
   - the value is stored trimmed and whole;
   - a value with spaces or line breaks inside is refused before anything is saved;
   - the value is never echoed.

   Pinned in Task 1.
4. **An alert webhook address that embeds an integration key**, typed as a flag value or shown in
   the plan. Expected:
   - `--alert-webhook https://...` does not exist, so a webhook can only come from a hidden
     prompt, a file or an environment variable;
   - the answers, the SSM parameter and the plan show only the host;
   - the full address goes only to `agentx/<env>/alert-endpoint`.

   Pinned in Task 4.
5. **A model the account cannot call yet**, which a new account hits first:
   - an Anthropic model whose one-time use-case form hasn't been submitted;
   - a base model id that must be called through an inference profile;
   - Bedrock throttling the one-token check.

   Expected: `init` stops before creating anything. For the first two, the message says exactly
   what to change (submit the form in the Bedrock console, or use the `us.` profile id). For
   throttling, it retries once, then says to try again. Pinned in Task 5.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/init/prompts.ts` | `Prompter`, hidden input, secret sources, secret shape checks | 1 |
| `packages/cli/src/init/install-state.ts` | `InitAnswers` and `InstallProgress` schemas, SSM read and write, the size limit | 2 |
| `packages/cli/src/environments/lock.ts` (modify) | `takeOverOwn` | 2 |
| `packages/cli/src/deploy/deploy-environment.ts` (modify) | `lockHeld` | 2 |
| `packages/cli/src/init/steps.ts` | the step runner | 3 |
| `packages/cli/src/init/answers.ts` | questions and flags to `InitAnswers`; model choices; alert address; resume flag check | 4 |
| `packages/cli/src/init/prerequisites.ts` | FR-015 checks and their real AWS implementations | 5 |
| `packages/cli/src/init/plan.ts` | what will be created, and the cost estimate | 6 |
| `packages/cli/src/init/context.ts` | `InitContext`, `InitSecrets`, `StackStatusReader` | 7 |
| `packages/cli/src/init/deploy-steps.ts` | deploy steps, answers mapping, waiting for idle stacks | 7 |
| `packages/cli/src/deploy/commands.ts` (modify) | `prepareDeployment`; exported answer schemas; `slackAppPostedMessages` | 7 |
| `packages/cli/src/deploy/parameters.ts` (modify) | `SlackAppPostedMessages` parameter | 7 |
| `packages/cli/src/init/github-app.ts` | manifest, listener, conversion, JWT, installation wait | 8 |
| `packages/cli/src/init/slack-app.ts` | manifest, token checks, secret, URL probe | 9 |
| `packages/cli/src/version.ts`, `packages/cli/src/init/release-fetch.ts` | the release matching the CLI's version | 10 |
| `packages/cli/src/init/commands.ts`, `packages/cli/src/main.ts` (modify) | `runInit` and the `init` command | 11 |
| `tests/support/init-fakes.ts` | shared fakes for every init test | 1, 2, 5, 7, 8, 9 |

---

### Task 1: Prompts, hidden input and secret sources

**Files:**
- Create: `packages/cli/src/init/prompts.ts`
- Create: `tests/support/init-fakes.ts`
- Test: `tests/contract/init-prompts.test.ts`

**Interfaces:**
- Consumes: `agentXError` from `@agentx/contracts`.
- Produces:

```ts
export interface TextWriter { write(text: string): unknown }
export interface PromptFlag { flag: string }
export interface Prompter {
  /** Visible answer. An empty line returns defaultValue when given. validate returns a problem, or undefined. */
  ask(question: string, options: PromptFlag & { defaultValue?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: PromptFlag & { defaultValue: T }): Promise<T>;
  confirm(question: string, options: { defaultValue: boolean }): Promise<boolean>;
  /** Hidden answer: nothing typed is echoed. */
  secret(question: string, options: PromptFlag): Promise<string>;
}
/** For --yes: defaults, yes to every confirm, and a clear error naming the flag when there is no default. */
export function unattendedPrompter(): Prompter;
export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export function readHidden(input: HiddenInput, output: TextWriter, question: string): Promise<string>;
/** The real terminal prompter: visible questions through readLine, secrets through readSecret. */
export function terminalPrompter(io: { readLine(question: string): Promise<string>; readSecret(question: string): Promise<string>; write(text: string): void }): Prompter;
/** terminalPrompter over process.stdin and process.stderr. */
export function processPrompter(stderr: TextWriter): Prompter;
export function stripPasteMarkers(text: string): string;
/** Trims, strips paste markers, refuses empty, and (unless multiline) refuses whitespace inside. Never includes the value in an error. */
export function cleanSecret(raw: string, what: string, options?: { multiline?: boolean }): string;
export interface SecretSource { file?: string; envName?: string }
export function secretFromSource(input: { what: string; flag: string; source: SecretSource; processEnv: NodeJS.ProcessEnv; prompter: Prompter; multiline?: boolean; readFile?: (path: string) => Promise<string> }): Promise<string>;
export function checkSlackBotToken(value: string): string;
export function checkSlackSigningSecret(value: string): string;
export function checkPrivateKeyPem(value: string): string;
```

- `tests/support/init-fakes.ts` starts with `scriptedPrompter` (below). Later tasks append to it:
  `sampleAnswers` (Task 2), `passingChecks` (Task 5), the deploy and secret fakes (Task 7), the
  GitHub fakes (Task 8) and the Slack fakes (Task 9).

- [ ] **Step 1: Write the shared scripted prompter**

```ts
// tests/support/init-fakes.ts
// Shared fakes for `agentx init` tests. Nothing here reaches AWS, GitHub or Slack.
import type { Prompter } from "../../packages/cli/src/init/prompts.js";

export type ScriptedAnswer = string | boolean;

/** Answers questions in order. "" takes the question's default. Records every question asked. */
export function scriptedPrompter(script: ScriptedAnswer[]): Prompter & { asked: string[]; remaining: () => number } {
  const queue = [...script];
  const asked: string[] = [];
  const next = (question: string): ScriptedAnswer => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`test setup: no scripted answer for "${question}"`);
    return answer;
  };
  return {
    asked,
    remaining: () => queue.length,
    async ask(question, options) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      const value = answer === "" && options.defaultValue !== undefined ? options.defaultValue : answer;
      const problem = options.validate?.(value);
      if (problem !== undefined) throw new Error(`test setup: "${question}" refused ${JSON.stringify(value)}: ${problem}`);
      return value;
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T }): Promise<T> {
      const answer = next(question);
      if (answer === "") return options.defaultValue;
      const match = choices.find((choice) => choice.value === answer);
      if (match === undefined) throw new Error(`test setup: "${question}" has no choice ${String(answer)}`);
      return match.value;
    },
    async confirm(question) {
      const answer = next(question);
      if (typeof answer !== "boolean") throw new Error(`test setup: "${question}" wants true or false`);
      return answer;
    },
    async secret(question) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      return answer;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/init-prompts.test.ts
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPrivateKeyPem, checkSlackBotToken, checkSlackSigningSecret, cleanSecret, readHidden, secretFromSource,
  terminalPrompter, unattendedPrompter,
} from "../../packages/cli/src/init/prompts.js";
import { scriptedPrompter } from "../support/init-fakes.js";

class FakeTty extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean) { this.rawModes.push(mode); return this; }
  resume() { return this; }
  pause() { return this; }
}

class FakePipe extends EventEmitter {
  isTTY = false;
  resume() { return this; }
  pause() { return this; }
}

function sink() {
  const written: string[] = [];
  return { written, write: (text: string) => { written.push(text); } };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("hidden input", () => {
  it("reads a long secret whole in raw mode, echoes nothing of it, and restores the terminal (Review Focus 3)", async () => {
    const input = new FakeTty();
    const output = sink();
    const secret = `xoxb-${"a1".repeat(150)}`; // 305 characters, past macOS security's 128-character cut
    const pending = readHidden(input, output, "Bot token: ");
    for (const character of secret) input.emit("data", character);
    input.emit("data", "\r");
    await expect(pending).resolves.toBe(secret);
    expect(output.written.join("")).toBe("Bot token: \n");
    expect(input.rawModes).toEqual([true, false]);
  });

  it("strips bracketed-paste markers and honours backspace (Review Focus 3)", async () => {
    const input = new FakeTty();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", "\u001b[200~abcX\u001b[201~");
    input.emit("data", "\u007f");
    input.emit("data", "d\r");
    await expect(pending).resolves.toBe("abcd");
  });

  it("cancels on Ctrl-C and still restores the terminal", async () => {
    const input = new FakeTty();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", "abc\u0003");
    await expect(pending).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("cancelled") as unknown });
    expect(input.rawModes).toEqual([true, false]);
  });

  it("reads one line from piped input, dropping a trailing CR", async () => {
    const input = new FakePipe();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", Buffer.from("piped-value\r\nnext line\n"));
    await expect(pending).resolves.toBe("piped-value");
  });
});

describe("cleaning secrets", () => {
  it("trims surrounding spaces and line breaks and paste markers (Review Focus 3)", () => {
    expect(cleanSecret("  \u001b[200~value-123\u001b[201~\r\n", "Slack bot token")).toBe("value-123");
  });

  it("refuses whitespace inside a single-line secret without echoing it", () => {
    let message = "";
    try { cleanSecret("abc def-secret", "Slack bot token"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("CONFIG_INVALID: the Slack bot token contains spaces or line breaks; copy it again and paste only the value");
    expect(message).not.toContain("def-secret");
  });

  it("allows line breaks inside a multiline secret such as a PEM key", () => {
    expect(cleanSecret("\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n\n", "GitHub App private key", { multiline: true }))
      .toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("refuses an empty secret", () => {
    expect(() => cleanSecret(" \r\n", "Slack signing secret")).toThrow("the Slack signing secret is empty");
  });
});

describe("secret sources", () => {
  it("prefers the file, then the environment variable, then the hidden prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-secret-"));
    dirs.push(dir);
    await writeFile(join(dir, "token"), "from-file\n");
    const base = { what: "Slack bot token", flag: "--slack-bot-token", processEnv: { TOKEN: "from-env" } };
    await expect(secretFromSource({ ...base, source: { file: join(dir, "token"), envName: "TOKEN" }, prompter: scriptedPrompter([]) })).resolves.toBe("from-file");
    await expect(secretFromSource({ ...base, source: { envName: "TOKEN" }, prompter: scriptedPrompter([]) })).resolves.toBe("from-env");
    await expect(secretFromSource({ ...base, source: {}, prompter: scriptedPrompter(["from-prompt "]) })).resolves.toBe("from-prompt");
  });

  it("names a missing environment variable without guessing", async () => {
    await expect(secretFromSource({ what: "Slack bot token", flag: "--slack-bot-token", source: { envName: "NOPE" }, processEnv: {}, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("environment variable NOPE (--slack-bot-token-env) is not set");
  });

  it("with --yes and no source, names both flags that could supply the secret", async () => {
    await expect(secretFromSource({ what: "Slack bot token", flag: "--slack-bot-token", source: {}, processEnv: {}, prompter: unattendedPrompter() }))
      .rejects.toThrow("Slack bot token needs an answer; with --yes, pass --slack-bot-token-file <path> or --slack-bot-token-env <NAME>");
  });
});

describe("secret shapes", () => {
  it("accepts a bot token and refuses a user or app token, never echoing it", () => {
    expect(checkSlackBotToken("xoxb-123-456-abcDEF")).toBe("xoxb-123-456-abcDEF");
    expect(() => checkSlackBotToken("xoxp-111-secretvalue")).toThrow("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(() => checkSlackBotToken("xapp-1-secretvalue")).toThrow("that is an app-level token (xapp-); paste the Bot User OAuth Token, which starts with xoxb-");
    let message = "";
    try { checkSlackBotToken("nonsense-secretvalue"); } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("secretvalue");
  });

  it("accepts a 32-character hexadecimal signing secret only", () => {
    expect(checkSlackSigningSecret("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(() => checkSlackSigningSecret("0123456789abcdef")).toThrow("a Slack signing secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Signing Secret)");
  });

  it("accepts a PEM private key only", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    expect(checkPrivateKeyPem(pem)).toBe(pem);
    expect(() => checkPrivateKeyPem("not a key")).toThrow("the GitHub App private key must be the .pem file GitHub gave you (it starts with -----BEGIN)");
  });
});

describe("terminal prompter", () => {
  function scriptedIo(lines: string[]) {
    const out: string[] = [];
    return { out, io: { readLine: async () => lines.shift() ?? "", readSecret: async () => lines.shift() ?? "", write: (text: string) => { out.push(text); } } };
  }

  it("returns the default on an empty line and asks again until the answer is valid", async () => {
    const { io, out } = scriptedIo(["", "BAD", "good"]);
    const prompter = terminalPrompter(io);
    await expect(prompter.ask("Region", { flag: "--region", defaultValue: "us-east-1" })).resolves.toBe("us-east-1");
    await expect(prompter.ask("Name", { flag: "--name", validate: (value) => (value === "good" ? undefined : "must be good") })).resolves.toBe("good");
    expect(out.join("")).toContain("must be good");
  });

  it("returns an empty answer only for an optional question (an empty default)", async () => {
    const { io, out } = scriptedIo(["", "", "x"]);
    const prompter = terminalPrompter(io);
    await expect(prompter.ask("Boundary (Enter for none)", { flag: "--permission-boundary", defaultValue: "" })).resolves.toBe("");
    await expect(prompter.ask("Required", { flag: "--required" })).resolves.toBe("x");
    expect(out.join("")).toContain("an answer is required");
  });

  it("chooses by number or value, and confirms with the default on an empty line", async () => {
    const { io } = scriptedIo(["2", "", "n"]);
    const prompter = terminalPrompter(io);
    const choices = [{ value: "templates", label: "templates" }, { value: "cdk", label: "cdk" }] as const;
    await expect(prompter.choose("Engine", choices, { flag: "--engine", defaultValue: "templates" })).resolves.toBe("cdk");
    await expect(prompter.confirm("Continue?", { defaultValue: true })).resolves.toBe(true);
    await expect(prompter.confirm("Continue?", { defaultValue: true })).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-prompts.test.ts`
Expected: FAIL, "Cannot find module .../init/prompts.js".

- [ ] **Step 4: Implement `prompts.ts`**

```ts
// packages/cli/src/init/prompts.ts
// Everything `agentx init` asks a person, and every way a secret reaches it: a hidden prompt, a
// file, or an environment variable, never a flag's value (FR-020). Secrets are read whole: no
// 128-character cut like macOS `security add-generic-password -w`.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { agentXError } from "@agentx/contracts";

export interface TextWriter { write(text: string): unknown }
export interface PromptFlag { flag: string }
export interface Prompter {
  ask(question: string, options: PromptFlag & { defaultValue?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: PromptFlag & { defaultValue: T }): Promise<T>;
  confirm(question: string, options: { defaultValue: boolean }): Promise<boolean>;
  secret(question: string, options: PromptFlag): Promise<string>;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export function stripPasteMarkers(text: string): string {
  return text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
}

export function unattendedPrompter(): Prompter {
  return {
    async ask(question, options) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw agentXError("CONFIG_INVALID", `${question} needs an answer; with --yes, pass ${options.flag}`);
    },
    async choose(_question, _choices, options) {
      return options.defaultValue;
    },
    async confirm() {
      return true;
    },
    async secret(question, options) {
      throw agentXError("CONFIG_INVALID", `${question} needs an answer; with --yes, pass ${options.flag}-file <path> or ${options.flag}-env <NAME>`);
    },
  };
}

export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export function readHidden(input: HiddenInput, output: TextWriter, question: string): Promise<string> {
  output.write(question);
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error === undefined) resolvePromise(buffer);
      else reject(error);
    };
    const onEnd = () => finish(buffer === "" ? agentXError("CONFIG_INVALID", "no input was given") : undefined);
    const onData = (chunk: Buffer | string) => {
      const text = stripPasteMarkers(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      for (const character of text) {
        if (character === "\r" || character === "\n") return finish();
        if (raw && character === "\u0003") return finish(agentXError("CONFIG_INVALID", "cancelled"));
        if (raw && (character === "\u007f" || character === "\b")) {
          buffer = [...buffer].slice(0, -1).join("");
          continue;
        }
        buffer += character;
      }
    };
    if (raw) input.setRawMode?.(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

export function terminalPrompter(io: { readLine(question: string): Promise<string>; readSecret(question: string): Promise<string>; write(text: string): void }): Prompter {
  return {
    async ask(question, options) {
      const suffix = options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`;
      for (;;) {
        const line = (await io.readLine(`${question}${suffix}: `)).trim();
        const value = line === "" && options.defaultValue !== undefined ? options.defaultValue : line;
        // An empty answer is allowed only when the question offers an empty default (an optional value).
        const problem = value === "" && options.defaultValue === undefined ? "an answer is required" : options.validate?.(value);
        if (problem === undefined) return value;
        io.write(`  ${problem}\n`);
      }
    },
    async choose(question, choices, options) {
      io.write(`${question}\n`);
      choices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}${choice.value === options.defaultValue ? " (default)" : ""}\n`));
      for (;;) {
        const line = (await io.readLine(`Choose 1-${choices.length}: `)).trim();
        if (line === "") return options.defaultValue;
        const byNumber = choices[Number.parseInt(line, 10) - 1];
        const match = /^\d+$/.test(line) ? byNumber : choices.find((choice) => choice.value === line);
        if (match !== undefined) return match.value;
        io.write(`  choose a number from 1 to ${choices.length}\n`);
      }
    },
    async confirm(question, options) {
      for (;;) {
        const line = (await io.readLine(`${question} ${options.defaultValue ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (line === "") return options.defaultValue;
        if (line === "y" || line === "yes") return true;
        if (line === "n" || line === "no") return false;
        io.write("  answer y or n\n");
      }
    },
    async secret(question) {
      return io.readSecret(`${question} (hidden): `);
    },
  };
}

export function processPrompter(stderr: TextWriter): Prompter {
  return terminalPrompter({
    async readLine(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    readSecret: (question) => readHidden(process.stdin, stderr, question),
    write: (text) => { stderr.write(text); },
  });
}

export function cleanSecret(raw: string, what: string, options: { multiline?: boolean } = {}): string {
  const value = stripPasteMarkers(raw).trim();
  if (value === "") throw agentXError("CONFIG_INVALID", `the ${what} is empty`);
  if (!options.multiline && /\s/.test(value)) {
    throw agentXError("CONFIG_INVALID", `the ${what} contains spaces or line breaks; copy it again and paste only the value`);
  }
  return value;
}

export interface SecretSource { file?: string; envName?: string }

export async function secretFromSource(input: {
  what: string; flag: string; source: SecretSource; processEnv: NodeJS.ProcessEnv; prompter: Prompter; multiline?: boolean;
  readFile?: (path: string) => Promise<string>;
}): Promise<string> {
  const read = input.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const clean = (raw: string) => cleanSecret(raw, input.what, input.multiline === true ? { multiline: true } : {});
  if (input.source.file !== undefined) {
    let raw: string;
    try {
      raw = await read(input.source.file);
    } catch (error) {
      throw agentXError("CONFIG_INVALID", `could not read ${input.flag}-file ${input.source.file}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
    return clean(raw);
  }
  if (input.source.envName !== undefined) {
    const raw = input.processEnv[input.source.envName];
    if (raw === undefined) throw agentXError("CONFIG_INVALID", `environment variable ${input.source.envName} (${input.flag}-env) is not set`);
    return clean(raw);
  }
  return clean(await input.prompter.secret(input.what, { flag: input.flag }));
}

export function checkSlackBotToken(value: string): string {
  if (value.startsWith("xoxp-")) throw agentXError("CONFIG_INVALID", "that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
  if (value.startsWith("xapp-")) throw agentXError("CONFIG_INVALID", "that is an app-level token (xapp-); paste the Bot User OAuth Token, which starts with xoxb-");
  if (!/^xoxb-[A-Za-z0-9-]+$/.test(value)) throw agentXError("CONFIG_INVALID", "a Slack bot token starts with xoxb- (OAuth & Permissions, Bot User OAuth Token)");
  return value;
}

export function checkSlackSigningSecret(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", "a Slack signing secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Signing Secret)");
  }
  return value;
}

export function checkPrivateKeyPem(value: string): string {
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(value)) {
    throw agentXError("CONFIG_INVALID", "the GitHub App private key must be the .pem file GitHub gave you (it starts with -----BEGIN)");
  }
  return value;
}
```

`AgentXError` prefixes its message with the code (`packages/contracts/src/errors.ts`:
`super(\`${code}: ${message}\`)`), which is why the test expects `"CONFIG_INVALID: the Slack bot token ..."`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/prompts.ts tests/support/init-fakes.ts tests/contract/init-prompts.test.ts
git commit -m "feat(cli): init prompts, hidden input read whole, and secret sources"
```

### Task 2: Install state in SSM, own-lock takeover, and `lockHeld`

**Files:**
- Create: `packages/cli/src/init/install-state.ts`
- Modify: `packages/cli/src/environments/lock.ts` (`takeOverOwn`)
- Modify: `packages/cli/src/deploy/deploy-environment.ts` (`lockHeld`)
- Modify: `packages/cli/src/deploy/commands.ts` (export `IdentityAnswersSchema`, `ModelsAnswersSchema`, `ImagesAnswersSchema`, `REGION_PATTERN`, `ACCOUNT_PATTERN`; no behaviour change)
- Test: `tests/contract/init-install-state.test.ts`; append to `tests/contract/environment-lock.test.ts` and `tests/contract/deploy-environment.test.ts`

**Interfaces:**
- Consumes: `ParameterStore` (15a); `EnvironmentNameSchema`, `environmentSettingsPrefix`, `agentXError`, `ImageDigest` from `@agentx/contracts`.
- Produces:

```ts
// install-state.ts
export const INIT_STEP_IDS = ["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service"] as const;
export type InitStepId = (typeof INIT_STEP_IDS)[number];
export const SSM_STANDARD_VALUE_LIMIT = 4096;
export const InitAnswersSchema: z.ZodType<InitAnswers>;   // strict
export interface InitAnswers {
  schemaVersion: 1;
  env: string; region: string; account: string;
  engine: "templates" | "cdk";
  releaseVersion: string;                       // x.y.z
  identity: DeployAnswers["identity"];
  models: { orchestrator: string; classifier: string; worker: string };
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
  images?: { worker?: string; slack?: string };
  alert: { kind: "email"; address: string } | { kind: "webhook"; display: string; secretName: string } | { kind: "none" };
  github: { account: string; accountType: "organization" | "user"; appName: string };
  slack: { appName: string; appPostedMessages: "accept" | "ignore" };
  createdAt: string;
}
export const InstallProgressSchema: z.ZodType<InstallProgress>;   // strict
export interface StepRecord { status: "done" | "waiting"; at: string; note?: string }
export interface InstallProgress {
  schemaVersion: 1;
  env: string;
  steps: Partial<Record<InitStepId, StepRecord>>;
  github?: { account: string; appId: string; slug: string; privateKeySecretArn: string; installationId?: string };
  slack?: { appId: string; teamId: string; botUserId: string };
  updatedAt: string;
}
export function installAnswersParameterName(env: string): string;    // /agentx/<env>/install/answers
export function installProgressParameterName(env: string): string;   // /agentx/<env>/install/progress
export function emptyProgress(env: string, now: number): InstallProgress;
export async function readInstallAnswers(store: ParameterStore, env: string): Promise<InitAnswers | undefined>;
export async function writeInstallAnswers(store: ParameterStore, answers: InitAnswers): Promise<void>;
export async function readInstallProgress(store: ParameterStore, env: string): Promise<InstallProgress | undefined>;
export async function writeInstallProgress(store: ParameterStore, progress: InstallProgress): Promise<void>;

// lock.ts: withEnvironmentLock input gains
takeOverOwn?: boolean;   // offer confirmTakeover for a fresh lock whose holder and command equal ours

// deploy-environment.ts: DeployEnvironmentInput gains
/** The caller already holds the environment lock (agentx init's step runner): do not take it again. */
lockHeld?: boolean;
```

- [ ] **Step 1: Append `sampleAnswers` to the shared fakes, then write the failing tests**

```ts
// tests/support/init-fakes.ts (append)
import type { InitAnswers } from "../../packages/cli/src/init/install-state.js";

export function sampleAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    schemaVersion: 1,
    env: "staging",
    region: "us-east-1",
    account: "123456789012",
    engine: "templates",
    releaseVersion: "1.2.3",
    identity: { mode: "cognito" },
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    alert: { kind: "email", address: "ops@example.com" },
    github: { account: "acme", accountType: "organization", appName: "AgentX acme staging" },
    slack: { appName: "AgentX", appPostedMessages: "accept" },
    createdAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}
```

```ts
// tests/contract/init-install-state.test.ts
import { describe, expect, it } from "vitest";
import {
  INIT_STEP_IDS, emptyProgress, installAnswersParameterName, installProgressParameterName, readInstallAnswers,
  readInstallProgress, writeInstallAnswers, writeInstallProgress, type InitAnswers,
} from "../../packages/cli/src/init/install-state.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

describe("install state", () => {
  it("names its parameters under the environment's settings prefix", () => {
    expect(installAnswersParameterName("staging")).toBe("/agentx/staging/install/answers");
    expect(installProgressParameterName("staging")).toBe("/agentx/staging/install/progress");
    expect(INIT_STEP_IDS).toEqual(["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service"]);
  });

  it("round-trips answers and progress", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers());
    expect(await readInstallAnswers(store, "staging")).toEqual(sampleAnswers());
    const progress = { ...emptyProgress("staging", T0), steps: { access: { status: "done" as const, at: "2026-09-27T00:00:00.000Z" } } };
    await writeInstallProgress(store, progress);
    expect(await readInstallProgress(store, "staging")).toEqual(progress);
    expect(await readInstallProgress(store, "other")).toBeUndefined();
  });

  it("refuses answers that carry an unknown field, such as a secret someone added", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallAnswers(store, { ...sampleAnswers(), botToken: "xoxb-1" } as InitAnswers)).rejects.toThrow("install answers are invalid");
    expect(store.values.size).toBe(0);
  });

  it("refuses a value larger than a standard SSM parameter, naming the size", async () => {
    const store = new MemoryParameterStore();
    const huge = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: Array.from({ length: 400 }, (_, i) => `group-${i}`) } });
    await expect(writeInstallAnswers(store, huge)).rejects.toThrow(/install answers for environment staging are \d+ bytes, more than SSM's 4096-byte limit/);
    expect(store.values.size).toBe(0);
  });

  it("the largest ordinary answers fit comfortably", async () => {
    const store = new MemoryParameterStore();
    const big = sampleAnswers({
      permissionsBoundaryArn: `arn:aws:iam::123456789012:policy/${"b".repeat(120)}`,
      operatorPrincipalArn: `arn:aws:iam::123456789012:role/${"o".repeat(64)}`,
      images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}`, slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/s@sha256:${"b".repeat(64)}` },
      alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" },
    });
    await writeInstallAnswers(store, big);
    expect(Buffer.byteLength(store.values.get("/agentx/staging/install/answers")!)).toBeLessThan(2048);
  });

  it("explains progress written by a newer agentx", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/install/progress", JSON.stringify({ ...emptyProgress("staging", T0), steps: { "admin-user": { status: "done", at: "2026-09-27T00:00:00.000Z" } } }));
    await expect(readInstallProgress(store, "staging")).rejects.toThrow("install progress for environment staging is invalid or was written by a newer agentx; upgrade agentx and run it again");
  });
});
```

Append to `tests/contract/environment-lock.test.ts`, inside the existing `describe`:

```ts
  it("offers a takeover of the caller's own fresh lock for the same command when takeOverOwn is set (Review Focus 1)", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    const result = await withEnvironmentLock({ ...base, command: "init", store, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 7);
    expect(result).toBe(7);
    expect(confirmTakeover).toHaveBeenCalledOnce();
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("refuses the caller's own fresh lock, saying how, when the takeover is declined", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store, now: () => t0, takeOverOwn: true, confirmTakeover: async () => false }, async () => 1))
      .rejects.toThrow("(your own earlier \"init\"; confirm the takeover only if that run is no longer going)");
  });

  it("never offers a takeover of someone else's fresh lock, or of the caller's own lock for another command", async () => {
    const confirmTakeover = vi.fn(async () => true);
    const other = new MemoryParameterStore();
    other.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "init", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store: other, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 1)).rejects.toThrow("locked by bob");
    const own = new MemoryParameterStore();
    own.values.set("/agentx/staging/lock", JSON.stringify({ holder: base.holder, command: "deploy install", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    await expect(withEnvironmentLock({ ...base, command: "init", store: own, now: () => t0, takeOverOwn: true, confirmTakeover }, async () => 1)).rejects.toThrow("running \"deploy install\"");
    expect(confirmTakeover).not.toHaveBeenCalled();
  });
```

Append to `tests/contract/deploy-environment.test.ts`:

```ts
describe("deployEnvironment with lockHeld", () => {
  it("never touches the lock parameter when the caller already holds the lock", async () => {
    const store = new MemoryParameterStore();
    const { deployer } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"], lockHeld: true });
    expect(store.calls.filter((call) => call.name === "/agentx/staging/lock")).toEqual([]);
  });

  it("still refuses a different engine with lockHeld", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["slack"], lockHeld: true }))
      .rejects.toThrow("was installed with the templates engine");
    expect(requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-install-state.test.ts tests/contract/environment-lock.test.ts tests/contract/deploy-environment.test.ts`
Expected: FAIL. The install-state module is missing; `takeOverOwn` and `lockHeld` have no effect.

- [ ] **Step 3: Implement**

`install-state.ts`:

```ts
// packages/cli/src/init/install-state.ts
// `agentx init`'s own state in SSM, beside the environment settings: the answers (never a secret)
// and the progress (step outcomes, and the GitHub and Slack facts collected so far). Settings are
// written only by deployEnvironment once the Slack stack exists; these two let a stopped init
// resume before that, from any machine with access to the account.
import { z } from "zod";
import { agentXError, EnvironmentNameSchema, environmentSettingsPrefix, ImageDigest } from "@agentx/contracts";
import { ACCOUNT_PATTERN, IdentityAnswersSchema, ModelsAnswersSchema, REGION_PATTERN } from "../deploy/commands.js";
import type { ParameterStore } from "../environments/parameter-store.js";

export const INIT_STEP_IDS = ["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service"] as const;
export type InitStepId = (typeof INIT_STEP_IDS)[number];
export const SSM_STANDARD_VALUE_LIMIT = 4096;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

export const InitAnswersSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  region: z.string().regex(REGION_PATTERN),
  account: z.string().regex(ACCOUNT_PATTERN),
  engine: z.enum(["templates", "cdk"]),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  identity: IdentityAnswersSchema,
  models: ModelsAnswersSchema,
  permissionsBoundaryArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/).optional(),
  operatorPrincipalArn: z.string().regex(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/).optional(),
  images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional() }).strict().optional(),
  alert: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("email"), address: z.email() }).strict(),
    z.object({ kind: z.literal("webhook"), display: z.string().regex(/^https:\/\/[^/\s]+\/\.\.\.$/), secretName: z.string().regex(/^agentx\/[a-z0-9-]+\/alert-endpoint$/) }).strict(),
    z.object({ kind: z.literal("none") }).strict(),
  ]),
  github: z.object({ account: z.string().regex(GITHUB_LOGIN), accountType: z.enum(["organization", "user"]), appName: z.string().min(1).max(34) }).strict(),
  slack: z.object({ appName: z.string().min(1).max(35), appPostedMessages: z.enum(["accept", "ignore"]) }).strict(),
  createdAt: z.iso.datetime(),
}).strict();

export type InitAnswers = z.infer<typeof InitAnswersSchema>;

const StepRecordSchema = z.object({ status: z.enum(["done", "waiting"]), at: z.iso.datetime(), note: z.string().max(300).optional() }).strict();
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const InstallProgressSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  steps: z.partialRecord(z.enum(INIT_STEP_IDS), StepRecordSchema),
  github: z.object({
    account: z.string().regex(GITHUB_LOGIN),
    appId: z.string().regex(/^\d+$/),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    privateKeySecretArn: z.string().regex(SECRET_ARN),
    installationId: z.string().regex(/^\d+$/).optional(),
  }).strict().optional(),
  slack: z.object({ appId: z.string().regex(/^A[A-Z0-9]+$/), teamId: z.string().regex(/^T[A-Z0-9]+$/), botUserId: z.string().regex(/^[UW][A-Z0-9]+$/) }).strict().optional(),
  updatedAt: z.iso.datetime(),
}).strict();

export type InstallProgress = z.infer<typeof InstallProgressSchema>;

export function installAnswersParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}install/answers`;
}

export function installProgressParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}install/progress`;
}

export function emptyProgress(env: string, now: number): InstallProgress {
  return { schemaVersion: 1, env, steps: {}, updatedAt: new Date(now).toISOString() };
}

async function writeJson(store: ParameterStore, name: string, what: string, env: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes > SSM_STANDARD_VALUE_LIMIT) {
    throw agentXError("CONFIG_INVALID", `${what} for environment ${env} are ${bytes} bytes, more than SSM's ${SSM_STANDARD_VALUE_LIMIT}-byte limit; shorten the longest answer (for example the admin values list)`);
  }
  await store.put(name, json);
}

async function readJson<T>(store: ParameterStore, name: string, schema: z.ZodType<T>, invalid: string): Promise<T | undefined> {
  const stored = await store.get(name);
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", invalid);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", invalid);
  return parsed.data;
}

export async function readInstallAnswers(store: ParameterStore, env: string): Promise<InitAnswers | undefined> {
  return readJson(store, installAnswersParameterName(env), InitAnswersSchema, `install answers for environment ${env} are invalid or were written by a newer agentx; upgrade agentx and run it again`);
}

export async function writeInstallAnswers(store: ParameterStore, answers: InitAnswers): Promise<void> {
  const parsed = InitAnswersSchema.safeParse(answers);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install answers are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installAnswersParameterName(answers.env), "install answers", answers.env, parsed.data);
}

export async function readInstallProgress(store: ParameterStore, env: string): Promise<InstallProgress | undefined> {
  return readJson(store, installProgressParameterName(env), InstallProgressSchema, `install progress for environment ${env} is invalid or was written by a newer agentx; upgrade agentx and run it again`);
}

export async function writeInstallProgress(store: ParameterStore, progress: InstallProgress): Promise<void> {
  const parsed = InstallProgressSchema.safeParse(progress);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `install progress is invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await writeJson(store, installProgressParameterName(progress.env), "install progress", progress.env, parsed.data);
}
```

`ImageDigest` is the Zod schema from `packages/contracts/src/release.ts`.

In `commands.ts`, add `export` to `IdentityAnswersSchema`, `ModelsAnswersSchema`, `ImagesAnswersSchema`, `REGION_PATTERN` and `ACCOUNT_PATTERN`. Change nothing else.

In `lock.ts`, inside the `ParameterExistsError` branch, replace the stale check and the `confirmTakeover` guard with:

```ts
    const stale = now() - Date.parse(held.acquiredAt) > STALE_LOCK_MS;
    const ownEarlierRun = input.takeOverOwn === true && held.holder === input.holder && held.command === input.command;
    if (!stale && !ownEarlierRun) throw agentXError("CONFIG_INVALID", heldMessage(input.env, held));
    const why = stale
      ? "older than 2 hours"
      : `your own earlier "${held.command}"; confirm the takeover only if that run is no longer going`;
    if (!input.confirmTakeover) {
      throw agentXError("CONFIG_INVALID", `${heldMessage(input.env, held)} (${why}; to clear it, delete ${name} once you are sure no AgentX command is running)`);
    }
    if (!(await input.confirmTakeover(held))) {
      throw agentXError("CONFIG_INVALID", `${heldMessage(input.env, held)} (${why})`);
    }
```

Keep the rest of the takeover path (recheck, delete, re-create) exactly as it is. Add
`takeOverOwn?: boolean` to the input type, with a comment that it exists for `agentx init`, which a
closed terminal can leave holding its own lock. The existing stale-lock tests must pass unchanged.

In `deploy-environment.ts`, move the body of the `withEnvironmentLock` callback into
`const work = async (): Promise<DeployEnvironmentResult> => { ... }`. Then:

```ts
  return input.lockHeld === true ? work() : withEnvironmentLock({ store, env, holder, command: `deploy ${mode}`, now }, work);
```

Add `lockHeld?: boolean` to `DeployEnvironmentInput`. `work` still re-reads settings and re-runs
`assertDeployAllowed` first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-install-state.test.ts tests/contract/environment-lock.test.ts tests/contract/deploy-environment.test.ts tests/contract/deploy-cli.test.ts`
Expected: PASS, including every earlier lock and orchestrator test.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/install-state.ts packages/cli/src/environments/lock.ts packages/cli/src/deploy/deploy-environment.ts packages/cli/src/deploy/commands.ts tests/support/init-fakes.ts tests/contract/init-install-state.test.ts tests/contract/environment-lock.test.ts tests/contract/deploy-environment.test.ts
git commit -m "feat(cli): init answers and progress in SSM; own-lock takeover; deploys under a held lock"
```

### Task 3: The step runner

**Files:**
- Create: `packages/cli/src/init/steps.ts`
- Test: `tests/contract/init-steps.test.ts`

**Interfaces:**
- Consumes: `withEnvironmentLock`, `LockRecord` (Task 2); `readInstallProgress`, `writeInstallProgress`, `emptyProgress`, `InitStepId`, `InstallProgress` (Task 2); `cliErrorFor` from `deploy/commands.ts`.
- Produces:

```ts
export type StepOutcome = { status: "done"; note?: string } | { status: "waiting"; message: string };
export interface ProgressHandle {
  current(): InstallProgress;
  /** Merges github or slack facts and writes progress at once, so a crash right after keeps them. */
  update(patch: Pick<Partial<InstallProgress>, "github" | "slack">): Promise<void>;
}
export interface InitStep<C> { id: InitStepId; title: string; run(context: C, progress: ProgressHandle): Promise<StepOutcome> }
export type InitEvent =
  | { kind: "step-skipped"; id: InitStepId; title: string }
  | { kind: "step-started"; id: InitStepId; title: string }
  | { kind: "step-done"; id: InitStepId; title: string }
  | { kind: "step-waiting"; id: InitStepId; title: string; message: string };
export type InitRunResult =
  | { status: "complete"; ran: InitStepId[]; skipped: InitStepId[] }
  | { status: "waiting"; step: InitStepId; message: string; ran: InitStepId[]; skipped: InitStepId[] };
export async function runInitSteps<C>(input: {
  env: string; store: ParameterStore; holder: string;
  steps: ReadonlyArray<InitStep<C>>; context: C;
  onEvent?: (event: InitEvent) => void;
  confirmTakeover?: (held: LockRecord) => Promise<boolean>;
  now?: () => number;
}): Promise<InitRunResult>;
export function initStepFailure(title: string, error: unknown): unknown;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-steps.test.ts
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { installProgressParameterName, readInstallProgress, type InitStepId } from "../../packages/cli/src/init/install-state.js";
import { runInitSteps, type InitEvent, type InitStep, type StepOutcome } from "../../packages/cli/src/init/steps.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "staging";
const HOLDER = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const LOCK = "/agentx/staging/lock";

function step(id: InitStepId, run: () => Promise<StepOutcome> = async () => ({ status: "done" })): InitStep<unknown> & { run: ReturnType<typeof vi.fn> } {
  return { id, title: `step ${id}`, run: vi.fn(run) } as unknown as InitStep<unknown> & { run: ReturnType<typeof vi.fn> };
}

const run = (store: MemoryParameterStore, steps: ReadonlyArray<InitStep<unknown>>, extra: Partial<Parameters<typeof runInitSteps>[0]> = {}) =>
  runInitSteps({ env: ENV, store, holder: HOLDER, steps, context: {}, now: () => T0, ...extra });

describe("init step runner", () => {
  it("runs steps in order and records each as done in SSM", async () => {
    const store = new MemoryParameterStore();
    const events: InitEvent[] = [];
    const steps = [step("prerequisites"), step("access"), step("core")];
    const result = await run(store, steps, { onEvent: (event) => events.push(event) });
    expect(result).toEqual({ status: "complete", ran: ["prerequisites", "access", "core"], skipped: [] });
    const progress = await readInstallProgress(store, ENV);
    expect(Object.keys(progress!.steps)).toEqual(["prerequisites", "access", "core"]);
    expect(progress!.steps.access).toEqual({ status: "done", at: "2026-09-27T00:00:00.000Z" });
    expect(events.map((event) => event.kind)).toEqual(["step-started", "step-done", "step-started", "step-done", "step-started", "step-done"]);
  });

  it("resumes at the first incomplete step and never re-runs a completed one", async () => {
    const store = new MemoryParameterStore();
    const first = [step("prerequisites"), step("access"), step("core", async () => { throw new Error("network lost"); })];
    await expect(run(store, first)).rejects.toThrow('init stopped at "step core": network lost. Run agentx init again to continue from this step.');
    const second = [step("prerequisites"), step("access"), step("core")];
    const result = await run(store, second);
    expect(result).toEqual({ status: "complete", ran: ["core"], skipped: ["prerequisites", "access"] });
    expect(second[0]!.run).not.toHaveBeenCalled();
    expect(second[1]!.run).not.toHaveBeenCalled();
  });

  it("changes nothing when every step is already done", async () => {
    const store = new MemoryParameterStore();
    await run(store, [step("prerequisites"), step("access")]);
    const before = store.values.get(installProgressParameterName(ENV));
    store.calls.length = 0;
    const again = [step("prerequisites"), step("access")];
    const result = await run(store, again);
    expect(result).toEqual({ status: "complete", ran: [], skipped: ["prerequisites", "access"] });
    expect(store.values.get(installProgressParameterName(ENV))).toBe(before);
    expect(store.calls.filter((call) => call.op === "put" && call.name !== LOCK)).toEqual([]);
    expect(again.every((s) => s.run.mock.calls.length === 0)).toBe(true);
  });

  it("does not record a failed step, runs nothing after it, and releases the lock", async () => {
    const store = new MemoryParameterStore();
    const later = step("core");
    await expect(run(store, [step("access", async () => { throw agentXError("CONFIG_INVALID", "bad input"); }), later])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await readInstallProgress(store, ENV))?.steps.access).toBeUndefined();
    expect(later.run).not.toHaveBeenCalled();
    expect(store.values.has(LOCK)).toBe(false);
  });

  it("records a waiting step, stops, and runs it again next time", async () => {
    const store = new MemoryParameterStore();
    const later = step("slack-service");
    const result = await run(store, [step("slack-app", async () => ({ status: "waiting", message: "waiting for a Slack admin" })), later]);
    expect(result).toEqual({ status: "waiting", step: "slack-app", message: "waiting for a Slack admin", ran: [], skipped: [] });
    expect((await readInstallProgress(store, ENV))?.steps["slack-app"]).toEqual({ status: "waiting", at: "2026-09-27T00:00:00.000Z", note: "waiting for a Slack admin" });
    expect(later.run).not.toHaveBeenCalled();
    const retried = step("slack-app");
    expect(await run(store, [retried, step("slack-service")])).toMatchObject({ status: "complete", ran: ["slack-app", "slack-service"] });
    expect(retried.run).toHaveBeenCalledOnce();
  });

  it("turns expired AWS credentials into AUTH_REQUIRED that says how to refresh and that init resumes", async () => {
    const store = new MemoryParameterStore();
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    await expect(run(store, [step("core", async () => { throw expired; })])).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining('init stopped at "step core": AWS credentials missing or expired') as unknown,
    });
  });

  it("writes github facts the moment a step records them, so a crash afterwards keeps them", async () => {
    const store = new MemoryParameterStore();
    const github = { account: "acme", appId: "42", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbC" };
    const crashing: InitStep<unknown> = {
      id: "github-app",
      title: "GitHub App",
      async run(_context, progress) {
        await progress.update({ github });
        throw new Error("terminal closed");
      },
    };
    await expect(run(store, [crashing])).rejects.toThrow("terminal closed");
    expect((await readInstallProgress(store, ENV))?.github).toEqual(github);
  });

  it("holds the lock as init while steps run", async () => {
    const store = new MemoryParameterStore();
    await run(store, [step("access", async () => {
      expect(JSON.parse(store.values.get(LOCK)!)).toMatchObject({ holder: HOLDER, command: "init" });
      return { status: "done" };
    })]);
  });

  it("offers to take over the caller's own lock left by a killed run, and refuses without asking for someone else's (Review Focus 1)", async () => {
    const own = new MemoryParameterStore();
    own.values.set(LOCK, JSON.stringify({ holder: HOLDER, command: "init", acquiredAt: new Date(T0 - 5 * 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    expect(await run(own, [step("access")], { confirmTakeover })).toMatchObject({ status: "complete" });
    expect(confirmTakeover).toHaveBeenCalledOnce();

    const other = new MemoryParameterStore();
    other.values.set(LOCK, JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/Admin/bob", command: "init", acquiredAt: new Date(T0 - 5 * 60_000).toISOString() }));
    const notAsked = vi.fn(async () => true);
    await expect(run(other, [step("access")], { confirmTakeover: notAsked })).rejects.toThrow("locked by arn:aws:sts::123456789012:assumed-role/Admin/bob");
    expect(notAsked).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-steps.test.ts`
Expected: FAIL, "Cannot find module .../init/steps.js".

- [ ] **Step 3: Implement `steps.ts`**

```ts
// packages/cli/src/init/steps.ts
// Runs `agentx init`'s steps in order under the environment lock, recording each outcome in SSM
// as soon as it is known. A done step is skipped on every later run (FR-019: re-running a
// completed step changes nothing); a failed step is not recorded, so the next run retries it; a
// waiting step (a person must act first, FR-035) is recorded and stops the run.
import { AgentXError, agentXError } from "@agentx/contracts";
import { cliErrorFor } from "../deploy/commands.js";
import { withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { emptyProgress, readInstallProgress, writeInstallProgress, type InitStepId, type InstallProgress } from "./install-state.js";

export type StepOutcome = { status: "done"; note?: string } | { status: "waiting"; message: string };

export interface ProgressHandle {
  current(): InstallProgress;
  update(patch: Pick<Partial<InstallProgress>, "github" | "slack">): Promise<void>;
}

export interface InitStep<C> {
  id: InitStepId;
  title: string;
  run(context: C, progress: ProgressHandle): Promise<StepOutcome>;
}

export type InitEvent =
  | { kind: "step-skipped"; id: InitStepId; title: string }
  | { kind: "step-started"; id: InitStepId; title: string }
  | { kind: "step-done"; id: InitStepId; title: string }
  | { kind: "step-waiting"; id: InitStepId; title: string; message: string };

export type InitRunResult =
  | { status: "complete"; ran: InitStepId[]; skipped: InitStepId[] }
  | { status: "waiting"; step: InitStepId; message: string; ran: InitStepId[]; skipped: InitStepId[] };

const RESUME = "Run agentx init again to continue from this step.";

export function initStepFailure(title: string, error: unknown): unknown {
  const mapped = cliErrorFor(error);
  const message = mapped instanceof Error ? mapped.message.replace(/^[A-Z_]+: /, "") : String(mapped);
  const text = `init stopped at "${title}": ${message}. ${RESUME}`;
  if (mapped instanceof AgentXError) {
    const refresh = mapped.code === "AUTH_REQUIRED" ? " Refresh your AWS session first (for example aws sso login or aws login)." : "";
    return Object.assign(agentXError(mapped.code, `${text}${refresh}`), { cause: error });
  }
  return new Error(text, { cause: error });
}

export async function runInitSteps<C>(input: {
  env: string; store: ParameterStore; holder: string;
  steps: ReadonlyArray<InitStep<C>>; context: C;
  onEvent?: (event: InitEvent) => void;
  confirmTakeover?: (held: LockRecord) => Promise<boolean>;
  now?: () => number;
}): Promise<InitRunResult> {
  const now = input.now ?? Date.now;
  return withEnvironmentLock(
    {
      store: input.store, env: input.env, holder: input.holder, command: "init", now, takeOverOwn: true,
      ...(input.confirmTakeover === undefined ? {} : { confirmTakeover: input.confirmTakeover }),
    },
    async () => {
      let progress = (await readInstallProgress(input.store, input.env)) ?? emptyProgress(input.env, now());
      const save = async (next: InstallProgress) => {
        progress = { ...next, updatedAt: new Date(now()).toISOString() };
        await writeInstallProgress(input.store, progress);
      };
      const handle: ProgressHandle = {
        current: () => progress,
        update: (patch) => save({ ...progress, ...patch }),
      };
      const ran: InitStepId[] = [];
      const skipped: InitStepId[] = [];
      for (const step of input.steps) {
        if (progress.steps[step.id]?.status === "done") {
          skipped.push(step.id);
          input.onEvent?.({ kind: "step-skipped", id: step.id, title: step.title });
          continue;
        }
        input.onEvent?.({ kind: "step-started", id: step.id, title: step.title });
        let outcome: StepOutcome;
        try {
          outcome = await step.run(input.context, handle);
        } catch (error) {
          throw initStepFailure(step.title, error);
        }
        const at = new Date(now()).toISOString();
        if (outcome.status === "waiting") {
          await save({ ...progress, steps: { ...progress.steps, [step.id]: { status: "waiting", at, note: outcome.message.slice(0, 300) } } });
          input.onEvent?.({ kind: "step-waiting", id: step.id, title: step.title, message: outcome.message });
          return { status: "waiting", step: step.id, message: outcome.message, ran, skipped };
        }
        await save({ ...progress, steps: { ...progress.steps, [step.id]: { status: "done", at, ...(outcome.note === undefined ? {} : { note: outcome.note.slice(0, 300) }) } } });
        ran.push(step.id);
        input.onEvent?.({ kind: "step-done", id: step.id, title: step.title });
      }
      return { status: "complete", ran, skipped };
    },
  );
}
```

`cliErrorFor` maps an expired token to `AUTH_REQUIRED: AWS credentials missing or expired: ...`.
`initStepFailure` strips that `CODE: ` prefix before rewording, because `agentXError` adds it
again.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/steps.ts tests/contract/init-steps.test.ts
git commit -m "feat(cli): init step runner with progress in SSM, resume and waiting steps"
```

### Task 4: The questions and flags

**Files:**
- Create: `packages/cli/src/init/answers.ts`
- Test: `tests/contract/init-answers.test.ts`

**Interfaces:**
- Consumes:
  - `Prompter`, `SecretSource`, `secretFromSource` (Task 1);
  - `InitAnswers`, `InitAnswersSchema`, `writeInstallAnswers` (Task 2);
  - `SecretAlreadyExistsError` from `deploy/signing-key.ts`;
  - `ImageDigest`, `agentXError` from `@agentx/contracts`.
- Produces:

```ts
export const ORCHESTRATOR_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }>;
export const CLASSIFIER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }>;
export const DEFAULT_ORCHESTRATOR_MODEL = "us.anthropic.claude-sonnet-4-6";
export const DEFAULT_CLASSIFIER_MODEL = "amazon.nova-lite-v1:0";
export const DEFAULT_WORKER_MODEL = "amazon.nova-pro-v1:0";
export const GLM_NOTE: string;
export const HAIKU_NOTE: string;
/** Only flags the engineer actually typed (main.ts drops commander defaults), so a default never skips a question. */
export interface InitFlags {
  engine?: "templates" | "cdk";
  identity?: "cognito" | "oidc";
  oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  orchestratorModel?: string; classifierModel?: string; workerModel?: string;
  permissionBoundary?: string; operatorPrincipal?: string;
  alertEmail?: string;
  /** --alert-webhook-file / --alert-webhook-env: there is deliberately no flag that takes the address itself. */
  alertWebhook?: SecretSource;
  /** false for --no-alerts */
  alerts?: boolean;
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore";
  workerImage?: string; slackImage?: string;
}
export interface CollectedAnswers { answers: InitAnswers; /** the secret webhook address, never stored in answers */ alertWebhook?: string; notes: string[] }
export async function collectInitAnswers(input: {
  env: string; region: string; account: string; releaseVersion: string;
  flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; now: () => number;
  readFile?: (path: string) => Promise<string>;
}): Promise<CollectedAnswers>;
export function alertWebhookSecretName(env: string): string;   // agentx/<env>/alert-endpoint
export function checkAlertWebhook(url: string): string;         // https only; never echoes the value
export function webhookDisplay(url: string): string;            // https://<host>/...
/** Refuses a typed flag that differs from what this install started with. */
export function assertResumeFlagsMatch(stored: InitAnswers, flags: InitFlags): void;
export interface AlertSecretWriter { create(name: string, value: string): Promise<void>; put(name: string, value: string): Promise<void> }
export async function persistInitAnswers(input: { store: ParameterStore; secrets: AlertSecretWriter; collected: CollectedAnswers }): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-answers.test.ts
import { describe, expect, it } from "vitest";
import {
  alertWebhookSecretName, assertResumeFlagsMatch, collectInitAnswers, GLM_NOTE, HAIKU_NOTE, persistInitAnswers, type InitFlags,
} from "../../packages/cli/src/init/answers.js";
import { readInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const WEBHOOK = "https://api.opsgenie.com/v1/json/amazonsns?apiKey=0f9e8d7c-SECRET-KEY-6b5a";
const base = { env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => T0 };

const everyFlag: InitFlags = {
  engine: "templates", identity: "cognito",
  orchestratorModel: "us.anthropic.claude-sonnet-4-6", classifierModel: "amazon.nova-lite-v1:0", workerModel: "amazon.nova-pro-v1:0",
  permissionBoundary: "", operatorPrincipal: "",
  alertEmail: "ops@example.com",
  githubAccount: "acme", githubAccountType: "organization", githubAppName: "AgentX acme staging",
  slackAppName: "AgentX", slackAppPostedMessages: "accept",
};

function memoryAlertSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    async create(name: string, value: string) { if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value); },
    async put(name: string, value: string) { values.set(name, value); },
  };
}

describe("init questions", () => {
  it("takes every default with Enter and asks for what has no default", async () => {
    const prompter = scriptedPrompter(["", "", "", "", "", "", "", "", "ops@example.com", "acme", "", "", "", ""]);
    const { answers, notes, alertWebhook } = await collectInitAnswers({ ...base, flags: {}, prompter });
    expect(prompter.remaining()).toBe(0);
    expect(alertWebhook).toBeUndefined();
    expect(notes).toEqual([]);
    expect(answers).toEqual({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
      identity: { mode: "cognito" },
      models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
      alert: { kind: "email", address: "ops@example.com" },
      github: { account: "acme", accountType: "organization", appName: "AgentX acme staging" },
      slack: { appName: "AgentX", appPostedMessages: "accept" },
      createdAt: "2026-09-27T00:00:00.000Z",
    });
  });

  it("asks nothing when every flag is given", async () => {
    const { answers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(answers.github.appName).toBe("AgentX acme staging");
  });

  it("states GLM 4.7's trade-off and Claude Haiku 4.5's model-access need when chosen", async () => {
    const { answers, notes } = await collectInitAnswers({ ...base, flags: { ...everyFlag, orchestratorModel: "zai.glm-4.7", classifierModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, prompter: scriptedPrompter([]) });
    expect(answers.models.orchestrator).toBe("zai.glm-4.7");
    expect(notes).toEqual([GLM_NOTE, HAIKU_NOTE]);
    expect(GLM_NOTE).toContain("6 of 7");
  });

  it("accepts another Bedrock model id for the orchestrator", async () => {
    const prompter = scriptedPrompter(["other", "us.amazon.nova-premier-v1:0"]);
    const { answers } = await collectInitAnswers({ ...base, flags: { ...everyFlag, orchestratorModel: undefined } as InitFlags, prompter });
    expect(answers.models.orchestrator).toBe("us.amazon.nova-premier-v1:0");
  });

  it("collects your own OIDC provider's issuer, audience, client and admin claim", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectInitAnswers({ ...base, flags, prompter: scriptedPrompter([]) });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://id.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins", "platform"] });
  });

  it("keeps a webhook address out of the answers and stores it only as a secret (Review Focus 4)", async () => {
    const flags: InitFlags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    const prompter = scriptedPrompter(["webhook", `  ${WEBHOOK}\r\n`]);
    const collected = await collectInitAnswers({ ...base, flags, prompter });
    expect(collected.answers.alert).toEqual({ kind: "webhook", display: "https://api.opsgenie.com/...", secretName: "agentx/staging/alert-endpoint" });
    expect(JSON.stringify(collected.answers)).not.toContain("SECRET-KEY");
    expect(collected.alertWebhook).toBe(WEBHOOK);

    const store = new MemoryParameterStore();
    const secrets = memoryAlertSecrets();
    await persistInitAnswers({ store, secrets, collected });
    expect(secrets.values.get(alertWebhookSecretName("staging"))).toBe(WEBHOOK);
    expect(store.values.get("/agentx/staging/install/answers")).not.toContain("SECRET-KEY");
    expect(await readInstallAnswers(store, "staging")).toEqual(collected.answers);
  });

  it("reads a webhook from --alert-webhook-env, refuses one that is not https, and replaces a secret left by an aborted run", async () => {
    const flags: InitFlags = { ...everyFlag, alertEmail: undefined, alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } } as InitFlags;
    const collected = await collectInitAnswers({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: WEBHOOK }, flags, prompter: scriptedPrompter([]) });
    const secrets = memoryAlertSecrets();
    secrets.values.set("agentx/staging/alert-endpoint", "https://stale.example.com/x");
    await persistInitAnswers({ store: new MemoryParameterStore(), secrets, collected });
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);

    let message = "";
    try {
      await collectInitAnswers({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: "http://hooks.example.com/k=SECRET-KEY" }, flags, prompter: scriptedPrompter([]) });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("an alert webhook must be an https:// address");
    expect(message).not.toContain("SECRET-KEY");
  });

  it("with --yes and no alert flag, names every way to answer", async () => {
    const flags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    await expect(collectInitAnswers({ ...base, flags, prompter: unattendedPrompter() }))
      .rejects.toThrow("Alert email address needs an answer; with --yes, pass --alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)");
  });

  it("records no alerts for --no-alerts, with a note saying nobody will hear about failures", async () => {
    const { answers, notes } = await collectInitAnswers({ ...base, flags: { ...everyFlag, alertEmail: undefined, alerts: false } as InitFlags, prompter: scriptedPrompter([]) });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.join("\n")).toContain("nobody is told when AgentX fails");
  });

  it("refuses an image override that is not a digest reference", async () => {
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, workerImage: "repo/worker:latest" }, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("--worker-image must be referenced by digest (repository@sha256:...)");
  });

  it("with --yes and no GitHub account, names the flag", async () => {
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, githubAccount: undefined } as InitFlags, prompter: unattendedPrompter() }))
      .rejects.toThrow("with --yes, pass --github-account");
  });
});

describe("resuming with flags", () => {
  it("refuses a flag that differs from what the install started with, and accepts matching ones", async () => {
    const { answers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "us.anthropic.claude-sonnet-4-6" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "zai.glm-4.7" })).toThrow(
      "--orchestrator-model zai.glm-4.7 differs from what this install started with (us.anthropic.claude-sonnet-4-6); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(answers, { engine: "cdk" })).toThrow("--engine cdk differs");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-answers.test.ts`
Expected: FAIL, "Cannot find module .../init/answers.js".

- [ ] **Step 3: Implement `answers.ts`**

```ts
// packages/cli/src/init/answers.ts
// FR-016's questions, each with a flag (FR-020). Only flags the engineer typed arrive here, so a
// commander default never silently skips a question. An alert webhook carries its integration
// key, so it is a secret: it is never a flag value and never stored in the answers.
import { agentXError, ImageDigest } from "@agentx/contracts";
import { SecretAlreadyExistsError } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { writeInstallAnswers, type InitAnswers } from "./install-state.js";
import { secretFromSource, type Prompter, type SecretSource } from "./prompts.js";

export const DEFAULT_ORCHESTRATOR_MODEL = "us.anthropic.claude-sonnet-4-6";
export const DEFAULT_CLASSIFIER_MODEL = "amazon.nova-lite-v1:0";
export const DEFAULT_WORKER_MODEL = "amazon.nova-pro-v1:0";
const GLM = "zai.glm-4.7";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export const ORCHESTRATOR_MODEL_CHOICES = [
  { value: DEFAULT_ORCHESTRATOR_MODEL, label: "Claude Sonnet 4.6 (recommended; about $0.025 a turn)" },
  { value: GLM, label: "GLM 4.7 (lower cost; about $0.007 a turn)" },
] as const;
export const CLASSIFIER_MODEL_CHOICES = [
  { value: DEFAULT_CLASSIFIER_MODEL, label: "Amazon Nova Lite (default)" },
  { value: HAIKU, label: "Claude Haiku 4.5 (needs Anthropic model access in Bedrock)" },
] as const;
export const GLM_NOTE =
  "GLM 4.7 costs about $0.007 a turn against Claude Sonnet 4.6's $0.025, and passed as many evaluation cases (58 of 65), but it refused correctly in only 6 of 7 cases that needed a refusal (Sonnet 4.6: 7 of 7).";
export const HAIKU_NOTE =
  "Claude Haiku 4.5 needs Anthropic model access in this account: a one-time use-case form in the Bedrock console. The prerequisite check below tests it.";
const NO_ALERTS_NOTE = "No alert address: nobody is told when AgentX fails until you add one (agentx config set alerts.address, phase 15e).";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface InitFlags {
  engine?: "templates" | "cdk";
  identity?: "cognito" | "oidc";
  oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  orchestratorModel?: string; classifierModel?: string; workerModel?: string;
  permissionBoundary?: string; operatorPrincipal?: string;
  alertEmail?: string;
  alertWebhook?: SecretSource;
  alerts?: boolean;
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore";
  workerImage?: string; slackImage?: string;
}

export interface CollectedAnswers { answers: InitAnswers; alertWebhook?: string; notes: string[] }

export function alertWebhookSecretName(env: string): string {
  return `agentx/${env}/alert-endpoint`;
}

export function checkAlertWebhook(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw agentXError("CONFIG_INVALID", "an alert webhook must be an https:// address (your PagerDuty or Opsgenie integration address)");
  }
  if (parsed.protocol !== "https:") throw agentXError("CONFIG_INVALID", "an alert webhook must be an https:// address (your PagerDuty or Opsgenie integration address)");
  return url;
}

export function webhookDisplay(url: string): string {
  return `https://${new URL(url).host}/...`;
}

const optionalArn = (pattern: RegExp, what: string) => (value: string): string | undefined =>
  value === "" || pattern.test(value) ? undefined : `must be ${what}`;

async function modelChoice(prompter: Prompter, flagValue: string | undefined, question: string, flag: string, choices: ReadonlyArray<{ value: string; label: string }>, defaultValue: string): Promise<string> {
  if (flagValue !== undefined) return flagValue;
  const picked = await prompter.choose(question, [...choices, { value: "other", label: "Another Bedrock model id" }], { flag, defaultValue });
  return picked === "other" ? prompter.ask(`${question} id`, { flag }) : picked;
}

function digestFlag(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ImageDigest.safeParse(value).success) throw agentXError("CONFIG_INVALID", `${flag} must be referenced by digest (repository@sha256:...)`);
  return value;
}

export async function collectInitAnswers(input: {
  env: string; region: string; account: string; releaseVersion: string;
  flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; now: () => number;
  readFile?: (path: string) => Promise<string>;
}): Promise<CollectedAnswers> {
  const { flags, prompter } = input;
  const notes: string[] = [];
  const workerImage = digestFlag(flags.workerImage, "--worker-image");
  const slackImage = digestFlag(flags.slackImage, "--slack-image");

  const engine = flags.engine ?? (await prompter.choose("Deploy engine", [
    { value: "templates", label: "templates: published CloudFormation templates, no CDK setup (recommended)" },
    { value: "cdk", label: "cdk: deploy from AgentX's CDK code at the release tag" },
  ] as const, { flag: "--engine", defaultValue: "templates" }));

  const identityMode = flags.identity ?? (await prompter.choose("Sign-in", [
    { value: "cognito", label: "Create a Cognito user pool for AgentX (recommended)" },
    { value: "oidc", label: "Use your own OIDC provider" },
  ] as const, { flag: "--identity", defaultValue: "cognito" }));
  let identity: InitAnswers["identity"] = { mode: "cognito" };
  if (identityMode === "oidc") {
    const https = (value: string) => (/^https:\/\/\S+$/.test(value) ? undefined : "must be an https:// URL");
    const issuer = flags.oidcIssuer ?? (await prompter.ask("OIDC issuer URL", { flag: "--oidc-issuer", validate: https }));
    const audience = flags.oidcAudience ?? (await prompter.ask("OIDC audience", { flag: "--oidc-audience" }));
    const clientId = flags.oidcClientId ?? (await prompter.ask("OIDC client id for agentx login", { flag: "--oidc-client-id" }));
    const adminClaim = flags.adminClaim ?? (await prompter.ask("Claim that marks AgentX administrators", { flag: "--admin-claim", defaultValue: "groups" }));
    const rawValues = flags.adminValues ?? (await prompter.ask("Values of that claim that mark an administrator, comma-separated", { flag: "--admin-values" }));
    const adminValues = rawValues.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (adminValues.length === 0) throw agentXError("CONFIG_INVALID", "--admin-values must name at least one value");
    identity = { mode: "oidc", issuer, audience, clientId, adminClaim, adminValues };
  }

  const orchestrator = await modelChoice(prompter, flags.orchestratorModel, "Orchestrator model", "--orchestrator-model", ORCHESTRATOR_MODEL_CHOICES, DEFAULT_ORCHESTRATOR_MODEL);
  const classifier = await modelChoice(prompter, flags.classifierModel, "Action-gate classifier model", "--classifier-model", CLASSIFIER_MODEL_CHOICES, DEFAULT_CLASSIFIER_MODEL);
  const worker = flags.workerModel ?? (await prompter.ask("Worker model id", { flag: "--worker-model", defaultValue: DEFAULT_WORKER_MODEL }));
  if (orchestrator === GLM) notes.push(GLM_NOTE);
  if (classifier === HAIKU) notes.push(HAIKU_NOTE);

  const boundary = flags.permissionBoundary ?? (await prompter.ask("Permission boundary policy ARN (Enter for AgentX's default boundary)", {
    flag: "--permission-boundary", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/, "an IAM policy ARN"),
  }));
  const operator = flags.operatorPrincipal ?? (await prompter.ask("IAM principal allowed to assume the AgentX operator role (Enter for this account)", {
    flag: "--operator-principal", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/, "an IAM principal ARN"),
  }));

  let alert: InitAnswers["alert"];
  let alertWebhook: string | undefined;
  const emailFlag = "--alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)";
  const readWebhook = async (source: SecretSource) => checkAlertWebhook(await secretFromSource({
    what: "alert webhook address", flag: "--alert-webhook", source, processEnv: input.processEnv, prompter,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  }));
  if (flags.alerts === false) {
    alert = { kind: "none" };
  } else if (flags.alertEmail !== undefined) {
    if (!EMAIL.test(flags.alertEmail)) throw agentXError("CONFIG_INVALID", `--alert-email ${flags.alertEmail} is not an email address`);
    alert = { kind: "email", address: flags.alertEmail };
  } else if (flags.alertWebhook !== undefined) {
    alertWebhook = await readWebhook(flags.alertWebhook);
  } else {
    const kind = await prompter.choose("Where should AgentX send alerts?", [
      { value: "email", label: "An email address" },
      { value: "webhook", label: "A PagerDuty or Opsgenie integration address (kept secret)" },
      { value: "none", label: "Nowhere for now" },
    ] as const, { flag: emailFlag, defaultValue: "email" });
    if (kind === "email") {
      alert = { kind: "email", address: await prompter.ask("Alert email address", { flag: emailFlag, validate: (value) => (EMAIL.test(value) ? undefined : "must be an email address") }) };
    } else if (kind === "webhook") {
      alertWebhook = await readWebhook({});
    } else {
      alert = { kind: "none" };
    }
  }
  if (alertWebhook !== undefined) alert = { kind: "webhook", display: webhookDisplay(alertWebhook), secretName: alertWebhookSecretName(input.env) };
  if (alert === undefined) throw new Error("unreachable: every alert branch sets alert");
  if (alert.kind === "none") notes.push(NO_ALERTS_NOTE);

  const githubAccount = flags.githubAccount ?? (await prompter.ask("GitHub organization or user that will own the AgentX GitHub App", {
    flag: "--github-account", validate: (value) => (GITHUB_LOGIN.test(value) ? undefined : "must be a GitHub organization or user name"),
  }));
  if (!GITHUB_LOGIN.test(githubAccount)) throw agentXError("CONFIG_INVALID", `--github-account ${githubAccount} is not a GitHub organization or user name`);
  const accountType = flags.githubAccountType ?? (await prompter.choose(`Is ${githubAccount} an organization or a personal account?`, [
    { value: "organization", label: "An organization" },
    { value: "user", label: "A personal account" },
  ] as const, { flag: "--github-account-type", defaultValue: "organization" }));
  const appName = flags.githubAppName ?? (await prompter.ask("GitHub App name (must be unique on GitHub)", {
    flag: "--github-app-name", defaultValue: `AgentX ${githubAccount} ${input.env}`.slice(0, 34),
    validate: (value) => (value.length <= 34 ? undefined : "must be at most 34 characters"),
  }));
  const slackAppName = flags.slackAppName ?? (await prompter.ask("Slack app name", {
    flag: "--slack-app-name", defaultValue: "AgentX", validate: (value) => (value.length <= 35 ? undefined : "must be at most 35 characters"),
  }));
  const appPostedMessages = flags.slackAppPostedMessages ?? (await prompter.choose("Answer mentions people post through other apps with their own Slack token?", [
    { value: "accept", label: "Yes (accept)" },
    { value: "ignore", label: "No, only mentions typed in Slack (ignore)" },
  ] as const, { flag: "--slack-app-posted-messages", defaultValue: "accept" }));

  const answers: InitAnswers = {
    schemaVersion: 1,
    env: input.env, region: input.region, account: input.account, engine, releaseVersion: input.releaseVersion,
    identity,
    models: { orchestrator, classifier, worker },
    ...(boundary === "" ? {} : { permissionsBoundaryArn: boundary }),
    ...(operator === "" ? {} : { operatorPrincipalArn: operator }),
    ...(workerImage === undefined && slackImage === undefined
      ? {}
      : { images: { ...(workerImage === undefined ? {} : { worker: workerImage }), ...(slackImage === undefined ? {} : { slack: slackImage }) } }),
    alert,
    github: { account: githubAccount, accountType, appName },
    slack: { appName: slackAppName, appPostedMessages },
    createdAt: new Date(input.now()).toISOString(),
  };
  return { answers, notes, ...(alertWebhook === undefined ? {} : { alertWebhook }) };
}

const RESUME_CHECKS: Array<{ flag: string; key: keyof InitFlags; stored: (answers: InitAnswers) => string | undefined }> = [
  { flag: "--engine", key: "engine", stored: (a) => a.engine },
  { flag: "--identity", key: "identity", stored: (a) => a.identity.mode },
  { flag: "--orchestrator-model", key: "orchestratorModel", stored: (a) => a.models.orchestrator },
  { flag: "--classifier-model", key: "classifierModel", stored: (a) => a.models.classifier },
  { flag: "--worker-model", key: "workerModel", stored: (a) => a.models.worker },
  { flag: "--permission-boundary", key: "permissionBoundary", stored: (a) => a.permissionsBoundaryArn ?? "" },
  { flag: "--operator-principal", key: "operatorPrincipal", stored: (a) => a.operatorPrincipalArn ?? "" },
  { flag: "--alert-email", key: "alertEmail", stored: (a) => (a.alert.kind === "email" ? a.alert.address : undefined) },
  { flag: "--github-account", key: "githubAccount", stored: (a) => a.github.account },
  { flag: "--github-account-type", key: "githubAccountType", stored: (a) => a.github.accountType },
  { flag: "--github-app-name", key: "githubAppName", stored: (a) => a.github.appName },
  { flag: "--slack-app-name", key: "slackAppName", stored: (a) => a.slack.appName },
  { flag: "--slack-app-posted-messages", key: "slackAppPostedMessages", stored: (a) => a.slack.appPostedMessages },
  { flag: "--worker-image", key: "workerImage", stored: (a) => a.images?.worker },
  { flag: "--slack-image", key: "slackImage", stored: (a) => a.images?.slack },
];

export function assertResumeFlagsMatch(stored: InitAnswers, flags: InitFlags): void {
  for (const check of RESUME_CHECKS) {
    const given = flags[check.key];
    if (given === undefined || typeof given !== "string") continue;
    const was = check.stored(stored);
    if (given !== was) {
      throw agentXError("CONFIG_INVALID", `${check.flag} ${given} differs from what this install started with (${was ?? "not set"}); an install's answers cannot change halfway. Run agentx init without that flag to continue`);
    }
  }
}

export interface AlertSecretWriter { create(name: string, value: string): Promise<void>; put(name: string, value: string): Promise<void> }

export async function persistInitAnswers(input: { store: ParameterStore; secrets: AlertSecretWriter; collected: CollectedAnswers }): Promise<void> {
  const { answers, alertWebhook } = input.collected;
  if (alertWebhook !== undefined && answers.alert.kind === "webhook") {
    try {
      await input.secrets.create(answers.alert.secretName, alertWebhook);
    } catch (error) {
      if (!(error instanceof SecretAlreadyExistsError)) throw error;
      await input.secrets.put(answers.alert.secretName, alertWebhook);
    }
  }
  await writeInstallAnswers(input.store, answers);
}
```

The secret is written before the answers. A crash between the two leaves a secret with no answers,
and the next first run replaces it. The reverse order would leave answers pointing at a secret that
doesn't exist.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-answers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/answers.ts tests/contract/init-answers.test.ts
git commit -m "feat(cli): init questions and flags; model choices; alert webhooks kept secret"
```

### Task 5: Prerequisites

**Files:**
- Create: `packages/cli/src/init/prerequisites.ts`
- Modify: `packages/cli/package.json` (add `"@aws-sdk/client-bedrock-runtime": "3.1134.0"` and `"@aws-sdk/client-bedrock-agentcore-control": "3.1134.0"`), then `npm install`
- Modify: `tests/support/init-fakes.ts` (append `passingChecks`)
- Test: `tests/contract/init-prerequisites.test.ts`

**Interfaces:**
- Consumes:
  - `InitAnswers` (Task 2);
  - `Prompter` (Task 1);
  - `assertCdkBootstrapped`, `CommandRunner` from `deploy/cdk-engine.ts`;
  - `ParameterStore`.
- Produces:

```ts
export interface PrerequisiteChecks {
  /** A one-token Bedrock Converse call. */
  converse(modelId: string): Promise<void>;
  /** A read-only AgentCore control-plane call in the region (ListAgentRuntimes, 1 result). */
  agentCore(): Promise<void>;
  /** The command's --version output, or undefined when it is not installed. */
  commandVersion(command: string): Promise<string | undefined>;
  cdkBootstrapped(): Promise<boolean>;
  runCdkBootstrap(): Promise<void>;
  oidcDiscovery(issuer: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}
export type ModelRole = "orchestrator" | "classifier" | "worker";
export function modelCheckProblem(input: { modelId: string; role: ModelRole; region: string; error: unknown }): string;
/** True when the error means the service has no endpoint in the region. */
export function endpointMissing(error: unknown): boolean;
export const DEDICATED_ACCOUNT_NOTE: string;
export async function checkPrerequisites(input: {
  answers: InitAnswers; releaseRegions: readonly string[]; caller: { account: string; arn: string };
  checks: PrerequisiteChecks; prompter: Prompter; write: (line: string) => void;
}): Promise<void>;
export function awsPrerequisiteChecks(input: { region: string; account: string; store: ParameterStore; runner: CommandRunner; fetch: typeof fetch }): PrerequisiteChecks;
```

- [ ] **Step 1: Append the passing checks fake**

```ts
// tests/support/init-fakes.ts (append)
import type { PrerequisiteChecks } from "../../packages/cli/src/init/prerequisites.js";

/** Every prerequisite passes; override one method to make it fail. Records every model checked. */
export function passingChecks(overrides: Partial<PrerequisiteChecks> = {}): PrerequisiteChecks & { models: string[]; bootstraps: number } {
  const state = { models: [] as string[], bootstraps: 0 };
  return {
    get models() { return state.models; },
    get bootstraps() { return state.bootstraps; },
    converse: async (modelId) => { state.models.push(modelId); },
    agentCore: async () => undefined,
    commandVersion: async (command) => (command === "node" ? "v22.20.0" : "10.9.0"),
    cdkBootstrapped: async () => true,
    runCdkBootstrap: async () => { state.bootstraps += 1; },
    oidcDiscovery: async (issuer) => ({ issuer }),
    sleep: async () => undefined,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/init-prerequisites.test.ts
import { describe, expect, it } from "vitest";
import { checkPrerequisites, DEDICATED_ACCOUNT_NOTE, endpointMissing, modelCheckProblem } from "../../packages/cli/src/init/prerequisites.js";
import type { InitAnswers } from "../../packages/cli/src/init/install-state.js";
import { passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";

const caller = { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" };
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

async function run(answers: InitAnswers, checks = passingChecks(), prompter = scriptedPrompter([])) {
  const lines: string[] = [];
  await checkPrerequisites({ answers, releaseRegions: ["us-east-1"], caller, checks, prompter, write: (line) => lines.push(line) });
  return lines;
}

describe("init prerequisites", () => {
  it("names the account, recommends a dedicated account, and checks each distinct model once", async () => {
    const checks = passingChecks();
    const lines = await run(sampleAnswers({ models: { orchestrator: "a", classifier: "b", worker: "a" } }), checks);
    expect(lines[0]).toBe("AWS account 123456789012 as arn:aws:sts::123456789012:assumed-role/Admin/alice");
    expect(lines).toContain(DEDICATED_ACCOUNT_NOTE);
    expect(checks.models).toEqual(["a", "b"]);
  });

  it("stops when the region has no AgentCore, saying nothing was created", async () => {
    const checks = passingChecks({ agentCore: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-agentcore-control.eu-north-1.amazonaws.com"), { code: "ENOTFOUND" }); } });
    await expect(run(sampleAnswers({ region: "eu-north-1" }), checks)).rejects.toThrow(
      /init cannot start; nothing was created:\n- this release does not cover region eu-north-1; it covers: us-east-1\n- Amazon Bedrock AgentCore Runtime is not available in eu-north-1/,
    );
  });

  it("counts an AgentCore access denial as the service being present", async () => {
    await expect(run(sampleAnswers(), passingChecks({ agentCore: async () => { throw awsError("AccessDeniedException", "not authorized"); } }))).resolves.toBeDefined();
  });

  it("explains the Anthropic use-case form, an id that needs an inference profile, and an unknown id (Review Focus 5)", () => {
    const form = modelCheckProblem({ modelId: "us.anthropic.claude-sonnet-4-6", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "Model use case details have not been submitted for this account.") });
    expect(form).toBe("us.anthropic.claude-sonnet-4-6: Anthropic models need a one-time use-case form in this account. Open the Bedrock console in us-east-1, Model catalog, choose the model and submit the form, then run agentx init again");
    const profile = modelCheckProblem({ modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "classifier", region: "us-east-1", error: awsError("ValidationException", "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported.") });
    expect(profile).toBe("anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in us-east-1; use us.anthropic.claude-haiku-4-5-20251001-v1:0 instead (--classifier-model)");
    const unknown = modelCheckProblem({ modelId: "made.up-v1", role: "worker", region: "us-east-1", error: awsError("ValidationException", "The provided model identifier is invalid.") });
    expect(unknown).toBe("made.up-v1 is not a Bedrock model id available in us-east-1; check the id, or choose another with --worker-model");
    const denied = modelCheckProblem({ modelId: "zai.glm-4.7", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "You don't have access to the model with the specified model ID.") });
    expect(denied).toContain("Enable access in the Bedrock console (Model access), or choose another model with --orchestrator-model");
  });

  it("retries a throttled model check once, then gives up with a try-again message (Review Focus 5)", async () => {
    let calls = 0;
    const flaky = passingChecks({ converse: async () => { calls += 1; if (calls === 1) throw awsError("ThrottlingException", "Too many requests"); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "a", classifier: "a", worker: "a" } }), flaky)).resolves.toBeDefined();
    expect(calls).toBe(2);
    const throttled = passingChecks({ converse: async () => { throw awsError("ThrottlingException", "Too many requests"); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "a", classifier: "a", worker: "a" } }), throttled)).rejects.toThrow("Bedrock throttled the check of a; wait a minute and run agentx init again");
  });

  it("reports every problem at once", async () => {
    const checks = passingChecks({ converse: async (id) => { throw awsError("ValidationException", `The provided model identifier is invalid. ${id}`); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "x", classifier: "y", worker: "z" } }), checks)).rejects.toThrow(/- x is not.*\n- y is not.*\n- z is not/s);
  });

  it("for the cdk engine, needs Node 22.19 or later and offers cdk bootstrap, running it only when every other check passed", async () => {
    await expect(run(sampleAnswers({ engine: "cdk" }), passingChecks({ commandVersion: async () => "v20.11.0" }))).rejects.toThrow("the cdk engine needs Node 22.19 or later (found v20.11.0)");

    const yes = passingChecks({ cdkBootstrapped: async () => false });
    await run(sampleAnswers({ engine: "cdk" }), yes, scriptedPrompter([true]));
    expect(yes.bootstraps).toBe(1);

    const no = passingChecks({ cdkBootstrapped: async () => false });
    await expect(run(sampleAnswers({ engine: "cdk" }), no, scriptedPrompter([false]))).rejects.toThrow("run npx cdk bootstrap aws://123456789012/us-east-1, or use --engine templates, which needs no bootstrap");
    expect(no.bootstraps).toBe(0);

    const blocked = passingChecks({ cdkBootstrapped: async () => false, converse: async () => { throw awsError("ValidationException", "The provided model identifier is invalid."); } });
    await expect(run(sampleAnswers({ engine: "cdk" }), blocked, scriptedPrompter([]))).rejects.toThrow("is not a Bedrock model id");
    expect(blocked.bootstraps).toBe(0);
  });

  it("checks your own OIDC provider's discovery document names the same issuer", async () => {
    const oidc = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] } });
    await expect(run(oidc, passingChecks({ oidcDiscovery: async () => ({ issuer: "https://other.example.com" }) }))).rejects.toThrow(
      "the OIDC discovery document at https://id.example.com/.well-known/openid-configuration names issuer https://other.example.com, not https://id.example.com",
    );
    await expect(run(oidc, passingChecks({ oidcDiscovery: async () => ({ issuer: "https://id.example.com/" }) }))).resolves.toBeDefined();
  });

  it("recognises a missing endpoint by name or DNS failure", () => {
    expect(endpointMissing(awsError("UnknownEndpoint", "x"))).toBe(true);
    expect(endpointMissing(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(endpointMissing(awsError("AccessDeniedException", "x"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts`
Expected: FAIL, "Cannot find module .../init/prerequisites.js".

- [ ] **Step 4: Implement `prerequisites.ts`**

```ts
// packages/cli/src/init/prerequisites.ts
// FR-015: everything init checks before it creates anything. Every problem is collected and
// reported together, with what to change; cdk bootstrap (which creates the CDKToolkit stack) is
// offered only when every other check has passed.
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { agentXError } from "@agentx/contracts";
import { assertCdkBootstrapped, type CommandRunner } from "../deploy/cdk-engine.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";

export interface PrerequisiteChecks {
  converse(modelId: string): Promise<void>;
  agentCore(): Promise<void>;
  commandVersion(command: string): Promise<string | undefined>;
  cdkBootstrapped(): Promise<boolean>;
  runCdkBootstrap(): Promise<void>;
  oidcDiscovery(issuer: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export type ModelRole = "orchestrator" | "classifier" | "worker";

export const DEDICATED_ACCOUNT_NOTE =
  "AgentX recommends a dedicated AWS account for each install: environments that share an account are not a security boundary against each other.";

const errorName = (error: unknown) => (error instanceof Error ? error.name : "");
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function endpointMissing(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "UnknownEndpoint" || record.name === "EndpointError" || record.code === "ENOTFOUND") return true;
    if (typeof record.message === "string" && /getaddrinfo ENOTFOUND/.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

function profilePrefix(region: string): string {
  if (region.startsWith("eu-")) return "eu.";
  if (region.startsWith("ap-")) return "apac.";
  return "us.";
}

export function modelCheckProblem(input: { modelId: string; role: ModelRole; region: string; error: unknown }): string {
  const { modelId, role, region, error } = input;
  const name = errorName(error);
  const message = errorMessage(error);
  if (endpointMissing(error)) return `Amazon Bedrock is not available in ${region}`;
  if (name === "AccessDeniedException" && /use case/i.test(message)) {
    return `${modelId}: Anthropic models need a one-time use-case form in this account. Open the Bedrock console in ${region}, Model catalog, choose the model and submit the form, then run agentx init again`;
  }
  if (name === "AccessDeniedException") {
    return `${modelId}: this account or your credentials cannot call it in ${region} (${message}). Enable access in the Bedrock console (Model access), or choose another model with --${role}-model`;
  }
  if (name === "ValidationException" && /on-demand throughput/i.test(message)) {
    return `${modelId} must be called through an inference profile in ${region}; use ${profilePrefix(region)}${modelId} instead (--${role}-model)`;
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model identifier is invalid/i.test(message))) {
    return `${modelId} is not a Bedrock model id available in ${region}; check the id, or choose another with --${role}-model`;
  }
  if (name === "ThrottlingException") return `Bedrock throttled the check of ${modelId}; wait a minute and run agentx init again`;
  return `${modelId} did not answer a one-token test call in ${region}: ${message}`;
}

function nodeVersionOk(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function checkPrerequisites(input: {
  answers: InitAnswers; releaseRegions: readonly string[]; caller: { account: string; arn: string };
  checks: PrerequisiteChecks; prompter: Prompter; write: (line: string) => void;
}): Promise<void> {
  const { answers, checks, write } = input;
  const { region } = answers;
  const problems: string[] = [];
  write(`AWS account ${input.caller.account} as ${input.caller.arn}`);
  write(DEDICATED_ACCOUNT_NOTE);

  if (!input.releaseRegions.includes(region)) {
    problems.push(`this release does not cover region ${region}; it covers: ${input.releaseRegions.join(", ") || "no region"}`);
  }
  try {
    await checks.agentCore();
    write(`ok AgentCore Runtime is available in ${region}`);
  } catch (error) {
    if (errorName(error).startsWith("AccessDenied")) write(`ok AgentCore Runtime answers in ${region}`);
    else if (endpointMissing(error)) problems.push(`Amazon Bedrock AgentCore Runtime is not available in ${region}`);
    else problems.push(`could not reach AgentCore Runtime in ${region}: ${errorMessage(error)}`);
  }

  const roles: Array<[ModelRole, string]> = [["orchestrator", answers.models.orchestrator], ["classifier", answers.models.classifier], ["worker", answers.models.worker]];
  const seen = new Set<string>();
  for (const [role, modelId] of roles) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    try {
      try {
        await checks.converse(modelId);
      } catch (error) {
        if (errorName(error) !== "ThrottlingException") throw error;
        await checks.sleep(2000);
        await checks.converse(modelId);
      }
      write(`ok ${modelId} answers`);
    } catch (error) {
      problems.push(modelCheckProblem({ modelId, role, region, error }));
    }
  }

  if (answers.identity.mode === "oidc") {
    const issuer = answers.identity.issuer.replace(/\/$/, "");
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const document = (await checks.oidcDiscovery(answers.identity.issuer)) as { issuer?: unknown };
      const named = typeof document.issuer === "string" ? document.issuer.replace(/\/$/, "") : undefined;
      if (named !== issuer) problems.push(`the OIDC discovery document at ${url} names issuer ${named ?? "nothing"}, not ${issuer}`);
      else write(`ok OIDC discovery at ${url}`);
    } catch (error) {
      problems.push(`could not read the OIDC discovery document at ${url}: ${errorMessage(error)}`);
    }
  }

  let needsBootstrap = false;
  if (answers.engine === "cdk") {
    const node = await checks.commandVersion("node");
    if (node === undefined || !nodeVersionOk(node)) problems.push(`the cdk engine needs Node 22.19 or later (found ${node?.trim() ?? "no node"})`);
    if ((await checks.commandVersion("npx")) === undefined) problems.push("the cdk engine needs npx (it comes with npm)");
    needsBootstrap = !(await checks.cdkBootstrapped());
  }

  if (needsBootstrap && problems.length === 0) {
    const target = `aws://${answers.account}/${region}`;
    write(`CDK is not bootstrapped in ${region}. cdk bootstrap creates the CDKToolkit stack (an S3 bucket, an ECR repository and deploy roles) that the cdk engine needs.`);
    if (await input.prompter.confirm(`Run cdk bootstrap ${target} now?`, { defaultValue: false })) {
      await checks.runCdkBootstrap();
      write(`ok CDK bootstrapped in ${region}`);
    } else {
      problems.push(`CDK is not bootstrapped in ${region}; run npx cdk bootstrap ${target}, or use --engine templates, which needs no bootstrap`);
    }
  }

  if (problems.length > 0) {
    throw agentXError("CONFIG_INVALID", `init cannot start; nothing was created:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export function awsPrerequisiteChecks(input: { region: string; account: string; store: ParameterStore; runner: CommandRunner; fetch: typeof fetch }): PrerequisiteChecks {
  const bedrock = new BedrockRuntimeClient({ region: input.region });
  const agentCore = new BedrockAgentCoreControlClient({ region: input.region });
  return {
    async converse(modelId) {
      await bedrock.send(new ConverseCommand({ modelId, messages: [{ role: "user", content: [{ text: "Reply with OK." }] }], inferenceConfig: { maxTokens: 1 } }));
    },
    async agentCore() {
      await agentCore.send(new ListAgentRuntimesCommand({ maxResults: 1 }));
    },
    async commandVersion(command) {
      try {
        return (await input.runner.run(command, ["--version"], { cwd: process.cwd(), display: `${command} --version` })).stdout;
      } catch {
        return undefined;
      }
    },
    async cdkBootstrapped() {
      try {
        await assertCdkBootstrapped({ store: input.store, region: input.region });
        return true;
      } catch {
        return false;
      }
    },
    async runCdkBootstrap() {
      const target = `aws://${input.account}/${input.region}`;
      await input.runner.run("npx", ["cdk", "bootstrap", target], { cwd: process.cwd(), display: `npx cdk bootstrap ${target}` });
    },
    async oidcDiscovery(issuer) {
      const response = await input.fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm install && npx vitest run tests/contract/init-prerequisites.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/init/prerequisites.ts tests/support/init-fakes.ts tests/contract/init-prerequisites.test.ts
git commit -m "feat(cli): init prerequisites stop before anything is created and say what to change"
```

### Task 6: What will be created, and what it will cost

**Files:**
- Create: `packages/cli/src/init/plan.ts`
- Test: `tests/contract/init-plan.test.ts`

**Interfaces:**
- Consumes:
  - `InitAnswers` (Task 2);
  - `Prompter` (Task 1);
  - `installOrder` from `deploy/parameters.ts`;
  - `environmentStackName`, `environmentCloudFormationRoleName`, `environmentOperatorRoleName`, `defaultBoundaryName`, `environmentRolePath` from `@agentx/contracts`.
- Produces:

```ts
export const STATED_USAGE: { turnsPerMonth: number; workerSessionsPerMonth: number; workerInstanceHoursPerMonth: number; keptWorkspaces: number };
export interface CostLine { item: string; usd: number | undefined; basis: string }
export interface CostEstimate { lines: CostLine[]; totalUsd: number; unpriced: string[] }
export function estimateMonthlyCost(models: InitAnswers["models"], usage?: typeof STATED_USAGE): CostEstimate;
export function installPlanText(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[]): string;
/** Prints the plan and asks; a no (the default) throws "install declined; nothing was created". */
export async function confirmInstallPlan(input: { answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void }): Promise<void>;
```

The prices are us-east-1 list prices. Before committing, check each constant in the
implementation against the AWS pricing pages (NAT Gateway, Fargate arm64, EC2 m6g.medium on
demand, EBS gp3, Bedrock for Nova Lite, Nova Pro and Claude Haiku 4.5). Update any that changed, and
update the test totals with them. The two orchestrator per-turn figures come from the spec's
2026-09-25 evaluation; do not change them.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-plan.test.ts
import { describe, expect, it } from "vitest";
import { confirmInstallPlan, estimateMonthlyCost, installPlanText } from "../../packages/cli/src/init/plan.js";
import { sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";

describe("cost estimate", () => {
  it("adds the fixed infrastructure and the default models at the stated usage", () => {
    const estimate = estimateMonthlyCost(sampleAnswers().models);
    expect(estimate.lines.map((line) => [line.item, line.usd])).toEqual([
      ["Two NAT gateways", 65.7],
      ["Slack service (Fargate, 0.5 vCPU, 1 GB, arm64)", 14.42],
      ["Worker instances (m6g.medium)", 2.31],
      ["Workspace volumes", 16],
      ["API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch", 10],
      ["Orchestrator model (us.anthropic.claude-sonnet-4-6)", 25],
      ["Classifier model (amazon.nova-lite-v1:0)", 0.15],
      ["Worker model (amazon.nova-pro-v1:0)", 19.2],
    ]);
    expect(estimate.totalUsd).toBe(152.78);
    expect(estimate.unpriced).toEqual([]);
  });

  it("prices GLM 4.7 lower, and names a model it has no price for instead of guessing", () => {
    expect(estimateMonthlyCost({ ...sampleAnswers().models, orchestrator: "zai.glm-4.7" }).totalUsd).toBe(134.78);
    const custom = estimateMonthlyCost({ ...sampleAnswers().models, worker: "us.amazon.nova-premier-v1:0" });
    expect(custom.unpriced).toEqual(["us.amazon.nova-premier-v1:0"]);
    expect(custom.lines.find((line) => line.item.startsWith("Worker model"))?.usd).toBeUndefined();
    expect(custom.totalUsd).toBe(133.58);
  });
});

describe("install plan", () => {
  it("lists every stack, role, secret, app and setting it will create, and the cost", () => {
    const answers = sampleAnswers();
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), []);
    for (const expected of [
      "AgentX will create environment staging in account 123456789012 (us-east-1) with the templates engine, release 1.2.3:",
      "agentx-staging-access, agentx-staging-foundation, agentx-staging-identity, agentx-staging-control-plane, agentx-staging-runtime, agentx-staging-slack",
      "IAM roles agentx-staging-cloudformation (CloudFormation deploys through it) and agentx-staging-operator (day-2 commands)",
      "the permission boundary agentx-staging-boundary, which every AgentX role carries; the stacks' own roles live under the IAM path /agentx/staging/",
      "Secrets agentx/staging/callback-signing-key, agentx/staging/github-app, agentx/staging/slack",
      "Settings under /agentx/staging/",
      "In GitHub: an app named \"AgentX acme staging\" owned by acme, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.",
      "In Slack: an app named \"AgentX\".",
      "Alerts: email to ops@example.com",
      "AgentX never answers itself or other bots. Mentions people post through other apps: accept (slack.appPostedMessages).",
      "Estimated monthly total: $152.78 at 1,000 turns, 100 worker sessions and 60 worker instance-hours a month",
      "Deleting the capacity provider deletes every workspace volume.",
    ]) expect(text).toContain(expected);
  });

  it("names a company boundary, a webhook's host only, no identity stack with your own OIDC, and the notes", () => {
    const answers = sampleAnswers({
      permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/CompanyBoundary",
      alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" },
      identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] },
    });
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), ["a note"]);
    expect(text).toContain("the permission boundary arn:aws:iam::123456789012:policy/CompanyBoundary");
    expect(text).toContain("Alerts: https://events.pagerduty.com/... (the full address is kept in agentx/staging/alert-endpoint)");
    expect(text).toContain("agentx/staging/alert-endpoint");
    expect(text).not.toContain("agentx-staging-identity");
    expect(text).toContain("a note");
  });

  it("creates nothing when the engineer says no", async () => {
    const written: string[] = [];
    await expect(confirmInstallPlan({ answers: sampleAnswers(), notes: [], prompter: scriptedPrompter([false]), write: (text) => written.push(text) }))
      .rejects.toThrow("install declined; nothing was created");
    expect(written.join("")).toContain("Estimated monthly total");
  });
});
```

The `133.58` total is 152.78 less the 19.20 unpriced worker line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-plan.test.ts`
Expected: FAIL, "Cannot find module .../init/plan.js".

- [ ] **Step 3: Implement `plan.ts`**

```ts
// packages/cli/src/init/plan.ts
// FR-017 and FR-022: before anything is created, show every stack, role, secret, app and setting
// init will create, and an estimated monthly cost at a stated usage, then ask. Prices are us-east-1
// list prices checked on the date in PRICES_CHECKED; the orchestrator per-turn figures come from the
// 2026-09-25 evaluation in the spec's Decisions.
import {
  agentXError, defaultBoundaryName, environmentCloudFormationRoleName, environmentOperatorRoleName, environmentRolePath, environmentStackName,
} from "@agentx/contracts";
import { installOrder } from "../deploy/parameters.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";

const PRICES_CHECKED = "September 2026";
const HOURS_PER_MONTH = 730;
const PRICES = {
  natGatewayHour: 0.045,
  fargateArmVcpuHour: 0.03238,
  fargateArmGbHour: 0.00356,
  m6gMediumHour: 0.0385,
  gp3GbMonth: 0.08,
  workspaceGiB: 20,
  smallServicesMonth: 10,
};
const ORCHESTRATOR_PER_TURN: Record<string, number> = { "us.anthropic.claude-sonnet-4-6": 0.025, "zai.glm-4.7": 0.007 };
/** About 2,000 input and 100 output tokens per check. */
const CLASSIFIER_PER_CHECK: Record<string, number> = { "amazon.nova-lite-v1:0": 0.00015, "us.anthropic.claude-haiku-4-5-20251001-v1:0": 0.0025 };
/** About 200,000 input and 10,000 output tokens per session. */
const WORKER_PER_SESSION: Record<string, number> = { "amazon.nova-pro-v1:0": 0.192 };

export const STATED_USAGE = { turnsPerMonth: 1000, workerSessionsPerMonth: 100, workerInstanceHoursPerMonth: 60, keptWorkspaces: 10 };

export interface CostLine { item: string; usd: number | undefined; basis: string }
export interface CostEstimate { lines: CostLine[]; totalUsd: number; unpriced: string[] }

const cents = (usd: number) => Math.round(usd * 100);
const money = (usd: number) => `$${usd.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-US");

export function estimateMonthlyCost(models: InitAnswers["models"], usage = STATED_USAGE): CostEstimate {
  const unpriced: string[] = [];
  const priced = (item: string, usd: number, basis: string): CostLine => ({ item, usd: cents(usd) / 100, basis });
  const perUse = (item: string, id: string, table: Record<string, number>, uses: number, what: string): CostLine => {
    const each = table[id];
    if (each === undefined) {
      unpriced.push(id);
      return { item, usd: undefined, basis: `not estimated: no price on file for ${id}` };
    }
    return priced(item, each * uses, `${count(uses)} ${what} at about $${each} each`);
  };
  const lines: CostLine[] = [
    priced("Two NAT gateways", 2 * PRICES.natGatewayHour * HOURS_PER_MONTH, `2 x $${PRICES.natGatewayHour}/hour, plus $0.045 per GB processed`),
    priced("Slack service (Fargate, 0.5 vCPU, 1 GB, arm64)", (0.5 * PRICES.fargateArmVcpuHour + 1 * PRICES.fargateArmGbHour) * HOURS_PER_MONTH, "one task, always on"),
    priced("Worker instances (m6g.medium)", PRICES.m6gMediumHour * usage.workerInstanceHoursPerMonth, `${usage.workerInstanceHoursPerMonth} instance-hours at $${PRICES.m6gMediumHour}/hour`),
    priced("Workspace volumes", usage.keptWorkspaces * PRICES.workspaceGiB * PRICES.gp3GbMonth, `${usage.keptWorkspaces} kept workspaces x ${PRICES.workspaceGiB} GiB gp3 at $${PRICES.gp3GbMonth}/GB-month`),
    priced("API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch", PRICES.smallServicesMonth, "about, at this usage"),
    perUse(`Orchestrator model (${models.orchestrator})`, models.orchestrator, ORCHESTRATOR_PER_TURN, usage.turnsPerMonth, "turns"),
    perUse(`Classifier model (${models.classifier})`, models.classifier, CLASSIFIER_PER_CHECK, usage.turnsPerMonth, "checks"),
    perUse(`Worker model (${models.worker})`, models.worker, WORKER_PER_SESSION, usage.workerSessionsPerMonth, "sessions"),
  ];
  const totalCents = lines.reduce((sum, line) => sum + (line.usd === undefined ? 0 : cents(line.usd)), 0);
  return { lines, totalUsd: totalCents / 100, unpriced };
}

export function installPlanText(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[]): string {
  const { env } = answers;
  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(env, part));
  const boundary = answers.permissionsBoundaryArn ?? defaultBoundaryName(env);
  const secrets = [`agentx/${env}/callback-signing-key`, `agentx/${env}/github-app`, `agentx/${env}/slack`, ...(answers.alert.kind === "webhook" ? [answers.alert.secretName] : [])];
  const alerts = answers.alert.kind === "email"
    ? `email to ${answers.alert.address}`
    : answers.alert.kind === "webhook"
      ? `${answers.alert.display} (the full address is kept in ${answers.alert.secretName})`
      : "none";
  const lines = [
    `AgentX will create environment ${env} in account ${answers.account} (${answers.region}) with the ${answers.engine} engine, release ${answers.releaseVersion}:`,
    `- Stacks, in this order: ${stacks.join(", ")}`,
    `- IAM roles ${environmentCloudFormationRoleName(env)} (CloudFormation deploys through it) and ${environmentOperatorRoleName(env)} (day-2 commands), and the permission boundary ${boundary}, which every AgentX role carries; the stacks' own roles live under the IAM path ${environmentRolePath(env)}`,
    `- Secrets ${secrets.join(", ")}`,
    `- Settings under /agentx/${env}/`,
    `- In GitHub: an app named "${answers.github.appName}" owned by ${answers.github.account}, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.`,
    `- In Slack: an app named "${answers.slack.appName}".`,
    `- Models: orchestrator ${answers.models.orchestrator}, classifier ${answers.models.classifier}, worker ${answers.models.worker}`,
    `- Alerts: ${alerts}`,
    `- AgentX never answers itself or other bots. Mentions people post through other apps: ${answers.slack.appPostedMessages} (slack.appPostedMessages).`,
    ...notes.map((note) => `Note: ${note}`),
    "",
    "Estimated monthly cost:",
    ...estimate.lines.map((line) => `  ${line.usd === undefined ? "    n/a" : money(line.usd).padStart(8)}  ${line.item} (${line.basis})`),
    `Estimated monthly total: ${money(estimate.totalUsd)} at ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} worker sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} worker instance-hours a month (us-east-1 list prices, ${PRICES_CHECKED}; your bill will differ)${estimate.unpriced.length > 0 ? `, not counting ${estimate.unpriced.join(", ")}` : ""}.`,
    "",
    "To remove it later, follow the teardown guide (agentx destroy arrives in phase 15e). Deleting the capacity provider deletes every workspace volume.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function confirmInstallPlan(input: { answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void }): Promise<void> {
  input.write(installPlanText(input.answers, estimateMonthlyCost(input.answers.models), input.notes));
  if (!(await input.prompter.confirm("Create all of this?", { defaultValue: false }))) {
    throw agentXError("CONFIG_INVALID", "install declined; nothing was created");
  }
}
```

`defaultBoundaryName` and `environmentRolePath` come from `packages/contracts/src/access-policies.ts`
(`agentx-<env>-boundary`, `/agentx/<env>/`). The role names come from `environments.ts`. Both are
re-exported by the contracts index.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/plan.ts tests/contract/init-plan.test.ts
git commit -m "feat(cli): init shows everything it will create and its monthly cost, then asks"
```

### Task 7: The init context and the deploy steps

**Files:**
- Create: `packages/cli/src/init/context.ts`
- Create: `packages/cli/src/init/deploy-steps.ts`
- Modify: `packages/cli/src/deploy/commands.ts`:
  - factor `prepareDeployment` out of `deployCommand`;
  - add `slackAppPostedMessages` to `DeployAnswersSchema` and `toDeployAnswers`.
- Modify: `packages/cli/src/deploy/parameters.ts` (`InstallAnswers.slackAppPostedMessages`, and the control plane's `SlackAppPostedMessages` parameter)
- Modify: `tests/support/init-fakes.ts` (append the deploy and secret fakes)
- Test: `tests/contract/init-deploy-steps.test.ts`; append to `tests/contract/deploy-parameters.test.ts` and `tests/contract/deploy-cli.test.ts`

**Interfaces:**
- Consumes:
  - `deployEnvironment` with `parts` and `lockHeld` (Task 2);
  - `InitStep`, `ProgressHandle` (Task 3);
  - `InitAnswers`, `InstallProgress` (Task 2);
  - `Prompter`, `SecretSource` (Task 1);
  - `installOrder`, `DeployPart` (15c1);
  - `progressLine`, `DeployCliDependencies`, `Writer` (15c2);
  - `readEnvironmentSettings` and `writeEnvironmentCache` (15a).
- Produces:

```ts
// commands.ts
export interface PreparedDeployment {
  deployer: StackDeployer; store: ParameterStore; secrets: SecretValueStore; holder: string; partition: string;
  /** Removes the cdk engine's outputs directory; a no-op for templates. */
  cleanup(): Promise<void>;
}
/** Everything runDeploy did between loading the answers and calling deployEnvironment: region coverage, the caller's account and partition, the stores, and the engine (cdk: source tag, bootstrap, build). */
export async function prepareDeployment(input: {
  engine: "templates" | "cdk"; env: string; region: string; account: string; partition?: string; identityMode: "cognito" | "oidc";
  release: LoadedRelease; source?: string; deps: DeployCliDependencies; stderr: Writer;
}): Promise<PreparedDeployment>;
// DeployAnswers (via InstallAnswers) gains: slackAppPostedMessages?: "accept" | "ignore"

// context.ts
export interface InitSecrets extends SecretValueStore {
  /** PutSecretValue on an existing secret. */
  put(name: string, value: string): Promise<void>;
  /** The secret's full ARN, or undefined when it does not exist. */
  arn(name: string): Promise<string | undefined>;
}
export function secretsManagerInitSecrets(client: SecretsManagerClient): InitSecrets;
export interface StackStatusReader { status(stackName: string): Promise<string | undefined> }
export function cloudFormationStatusReader(client: CloudFormationClient): StackStatusReader;
export interface SecretFlags { slackBotToken?: SecretSource; slackSigningSecret?: SecretSource; githubPrivateKey?: SecretSource }
export interface PreMadeGitHubApp { appId: string; installationId: string }
export interface InitContext {
  env: string;
  answers: InitAnswers;
  release: LoadedRelease;
  holder: string;
  store: ParameterStore;
  secrets: InitSecrets;
  prompter: Prompter;
  /** One progress line (to stderr). */
  write(line: string): void;
  /** Absent with --no-browser. */
  openBrowser?: (url: string) => Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
  processEnv: NodeJS.ProcessEnv;
  secretFlags: SecretFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  /** Built on first use and reused by every deploy step in this run. */
  deployment(): Promise<PreparedDeployment>;
  stackStatus: StackStatusReader;
  home: string;
  /** True when this run already ran checkPrerequisites before the plan. */
  prerequisitesPassed: boolean;
  runPrerequisites(): Promise<void>;
}

// deploy-steps.ts
export const DEPLOY_STEP_PARTS: { access: ["access"]; core: ["foundation", "identity"]; "control-plane": ["control-plane", "runtime"]; "slack-service": ["slack"] };
export type DeployStepId = keyof typeof DEPLOY_STEP_PARTS;
export function initDeployAnswers(answers: InitAnswers, progress: InstallProgress, parts: readonly DeployPart[]): DeployAnswers;
export const IDLE_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
export async function waitForIdleStacks(input: { reader: StackStatusReader; stackNames: readonly string[]; sleep(ms: number): Promise<void>; write(line: string): void; now(): number; pollMs?: number; timeoutMs?: number }): Promise<void>;
export function deployStep(input: { id: DeployStepId; title: string; after?: (context: InitContext, progress: ProgressHandle) => Promise<void> }): InitStep<InitContext>;
```

- [ ] **Step 1: Append the deploy and secret fakes**

```ts
// tests/support/init-fakes.ts (append)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import type { InitContext, InitSecrets } from "../../packages/cli/src/init/context.js";
import { emptyProgress, type InstallProgress } from "../../packages/cli/src/init/install-state.js";
import type { ProgressHandle } from "../../packages/cli/src/init/steps.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";

export const T0 = Date.parse("2026-09-27T00:00:00.000Z");
export const HOLDER = "arn:aws:sts::123456789012:assumed-role/Admin/alice";

export function memoryInitSecrets(initial: Record<string, string> = {}): InitSecrets & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(name) { return values.get(name); },
    async create(name, value) { if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value); },
    async put(name, value) { if (!values.has(name)) throw Object.assign(new Error(`Secrets Manager can't find ${name}`), { name: "ResourceNotFoundException" }); values.set(name, value); },
    async arn(name) { return values.has(name) ? `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}-AbCdEf` : undefined; },
  };
}

/** Every part's outputs, enough for stackParameters, settings and the Slack step. */
export function allStackOutputs(env = "staging"): Record<string, StackOutputs> {
  const name = (part: Parameters<typeof environmentStackName>[1]) => environmentStackName(env, part);
  return {
    [name("access")]: { ArtifactBucketName: `agentx-${env}-access-artifactbucket-abc`, CloudFormationRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-cloudformation`, OperatorRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-operator`, PullThroughPrefix: `agentx-${env}` },
    [name("foundation")]: { CapacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx_${env}_capacity-AbCdEfGhIj`, VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2" },
    [name("identity")]: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123", ClientId: "client123" },
    [name("control-plane")]: {
      ApiEndpoint: "https://abc123.execute-api.us-east-1.amazonaws.com",
      SlackEventsUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/events",
      SlackInteractivityUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/interactions",
      SlackSecretArn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/${env}/slack-AbCdEf`,
      SlackOrchestratorTaskRoleArn: `arn:aws:iam::123456789012:role/agentx/${env}/slack-task`,
      SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/requests",
      SlackThreadsTableName: "threads", TurnRecordsTableName: "turns", SlackThreadSessionBucketName: "sessions",
      OperatorAlertsTopicArn: `arn:aws:sns:us-east-1:123456789012:agentx-${env}-alerts`,
    },
    [name("runtime")]: {},
    [name("slack")]: {},
  };
}

/** Deploys by returning scripted outputs and emitting a deployed event; outputs() answers only for stacks deployed so far (or listed as existing). */
export function scriptedDeployer(outputsByStack: Record<string, StackOutputs>, existing: string[] = []): StackDeployer & { requests: DeployRequest[]; fail: Map<string, Error> } {
  const deployed = new Set(existing);
  const requests: DeployRequest[] = [];
  const fail = new Map<string, Error>();
  return {
    requests,
    fail,
    async deploy(request) {
      requests.push(request);
      const error = fail.get(request.stackName);
      if (error !== undefined) throw error;
      const outputs = outputsByStack[request.stackName];
      if (outputs === undefined) throw new Error(`test setup: no outputs for ${request.stackName}`);
      deployed.add(request.stackName);
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return outputs;
    },
    async outputs(stackName) { return deployed.has(stackName) ? outputsByStack[stackName] : undefined; },
  };
}

export function fakeRelease(version = "1.2.3"): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, version, gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` },
  };
  return { manifest, dir: "/nonexistent", regions: () => ["us-east-1"], template: () => { throw new Error("not used"); }, packagePath: () => { throw new Error("not used"); } };
}

export function progressHandle(initial: InstallProgress = emptyProgress("staging", T0)): ProgressHandle & { value(): InstallProgress } {
  let value = initial;
  return { value: () => value, current: () => value, update: async (patch) => { value = { ...value, ...patch }; } };
}

/** A context whose clock advances by every sleep, so timeouts can be reached without waiting. */
export type TestInitContext = InitContext & { lines: string[]; deployer: ReturnType<typeof scriptedDeployer>; opened: string[]; secrets: InitSecrets & { values: Map<string, string> } };

export function initContext(overrides: Partial<Omit<InitContext, "secrets">> & { secrets?: InitSecrets & { values: Map<string, string> } } = {}): TestInitContext {
  let clock = T0;
  const lines: string[] = [];
  const opened: string[] = [];
  const store = new MemoryParameterStore();
  const secrets = memoryInitSecrets();
  const deployer = scriptedDeployer(allStackOutputs());
  const context: InitContext = {
    env: "staging",
    answers: sampleAnswers(),
    release: fakeRelease(),
    holder: HOLDER,
    store,
    secrets,
    prompter: scriptedPrompter([]),
    write: (line) => { lines.push(line); },
    openBrowser: async (url) => { opened.push(url); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => { throw new Error("test setup: fetch not expected"); },
    processEnv: {},
    secretFlags: {},
    // Read at call time, so an overridden store or secrets is the one deploys use.
    deployment: async () => ({ deployer, store: context.store, secrets: context.secrets, holder: HOLDER, partition: "aws", cleanup: async () => undefined }),
    stackStatus: { status: async () => undefined },
    home: join(tmpdir(), `agentx-init-home-${randomBytes(6).toString("hex")}`),
    prerequisitesPassed: true,
    runPrerequisites: async () => undefined,
    ...overrides,
  };
  return Object.assign(context, { lines, deployer, opened }) as TestInitContext;
}
```

Tests that use `initContext` delete `context.home` in an `afterEach`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/init-deploy-steps.test.ts
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_STEP_PARTS, deployStep, initDeployAnswers, waitForIdleStacks } from "../../packages/cli/src/init/deploy-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { initContext, progressHandle, sampleAnswers, T0 } from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const GITHUB = { account: "acme", appId: "42", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" };

describe("init deploy answers", () => {
  it("maps the install answers, and fills GitHub only once the app is installed", () => {
    const answers = sampleAnswers({ images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}` }, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B" });
    const early = initDeployAnswers(answers, emptyProgress("staging", T0), ["access"]);
    expect(early).toEqual({
      env: "staging", region: "us-east-1", account: "123456789012",
      models: answers.models, identity: { mode: "cognito" },
      github: { account: "", appId: "", installationId: "", privateKeySecretArn: "" },
      permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B",
      images: answers.images,
      slackAppPostedMessages: "accept",
    });
    const later = initDeployAnswers(answers, { ...emptyProgress("staging", T0), github: GITHUB }, ["control-plane", "runtime"]);
    expect(later.github).toEqual({ account: "acme", appId: "42", installationId: "777", privateKeySecretArn: GITHUB.privateKeySecretArn });
  });

  it("refuses to deploy the control plane before the GitHub App is installed", () => {
    const { installationId: _omitted, ...notInstalled } = GITHUB;
    expect(() => initDeployAnswers(sampleAnswers(), { ...emptyProgress("staging", T0), github: notInstalled }, ["control-plane"]))
      .toThrow("the control plane needs the GitHub App's installation; the github-app step must finish first");
  });
});

describe("init deploy steps", () => {
  it("names each step's parts", () => {
    expect(DEPLOY_STEP_PARTS).toEqual({ access: ["access"], core: ["foundation", "identity"], "control-plane": ["control-plane", "runtime"], "slack-service": ["slack"] });
  });

  it("deploys its parts under the runner's lock, never taking the lock itself", async () => {
    const context = initContext();
    homes.push(context.home);
    await deployStep({ id: "access", title: "Deploy the access stack" }).run(context, progressHandle());
    await deployStep({ id: "core", title: "Deploy the foundation and identity stacks" }).run(context, progressHandle());
    expect(context.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity"]);
    expect(context.deployer.requests[1]?.roleArn).toBe("arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect((context.store as unknown as { calls: Array<{ name: string }> }).calls.some((call) => call.name.endsWith("/lock"))).toBe(false);
    expect(context.lines).toContain("deployed agentx-staging-access");
  });

  it("skips the identity stack when the environment brings its own OIDC provider", async () => {
    const context = initContext({ answers: sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] } }) });
    homes.push(context.home);
    await deployStep({ id: "access", title: "a" }).run(context, progressHandle());
    await deployStep({ id: "core", title: "c" }).run(context, progressHandle());
    expect(context.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation"]);
  });

  it("passes the Slack app-posted-messages choice to the control plane", async () => {
    const context = initContext({ answers: sampleAnswers({ slack: { appName: "AgentX", appPostedMessages: "ignore" } }) });
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: GITHUB });
    for (const id of ["access", "core", "control-plane"] as const) await deployStep({ id, title: id }).run(context, progress);
    expect(context.deployer.requests.find((request) => request.part === "control-plane")?.parameters.SlackAppPostedMessages).toBe("ignore");
  });

  it("after the Slack service, requires settings, writes the local cache and runs the after hook", async () => {
    const context = initContext();
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: GITHUB });
    for (const id of ["access", "core", "control-plane"] as const) await deployStep({ id, title: id }).run(context, progress);
    const after = vi.fn(async () => undefined);
    await deployStep({ id: "slack-service", title: "Deploy the Slack service", after }).run(context, progress);
    const settings = await readEnvironmentSettings(context.store, "staging");
    expect(settings?.controlPlaneUrl).toBe("https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(context.lines.join("\n")).toContain(environmentCachePath(context.home, "staging"));
    expect(after).toHaveBeenCalledOnce();
  });
});

describe("waiting for stacks left busy by an interrupted run (Review Focus 2)", () => {
  it("waits while a stack is in progress, saying so once, then returns", async () => {
    const statuses = ["UPDATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE"];
    let clock = T0;
    const lines: string[] = [];
    await waitForIdleStacks({ reader: { status: async () => statuses.shift() }, stackNames: ["agentx-staging-foundation"], sleep: async (ms) => { clock += ms; }, write: (line) => lines.push(line), now: () => clock });
    expect(lines).toEqual(["Waiting for agentx-staging-foundation: it is UPDATE_IN_PROGRESS from an earlier run"]);
    expect(clock - T0).toBe(30_000);
  });

  it("does not wait for a stack that does not exist or is under review", async () => {
    const sleep = vi.fn(async () => undefined);
    await waitForIdleStacks({ reader: { status: async (name) => (name.endsWith("a") ? undefined : "REVIEW_IN_PROGRESS") }, stackNames: ["x-a", "x-b"], sleep, write: () => undefined, now: () => T0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after 60 minutes with what to do", async () => {
    let clock = T0;
    await expect(waitForIdleStacks({ reader: { status: async () => "ROLLBACK_IN_PROGRESS" }, stackNames: ["agentx-staging-core"], sleep: async (ms) => { clock += ms; }, write: () => undefined, now: () => clock }))
      .rejects.toThrow("stack agentx-staging-core is still ROLLBACK_IN_PROGRESS after 60 minutes; check it in the CloudFormation console, then run agentx init again");
  });

  it("is what a deploy step does before deploying", async () => {
    const statuses = ["CREATE_IN_PROGRESS", "CREATE_COMPLETE"];
    const context = initContext({ stackStatus: { status: async () => statuses.shift() } });
    homes.push(context.home);
    await deployStep({ id: "access", title: "a" }).run(context, progressHandle());
    expect(context.lines[0]).toBe("Waiting for agentx-staging-access: it is CREATE_IN_PROGRESS from an earlier run");
    expect(context.deployer.requests).toHaveLength(1);
  });
});
```

Append to `tests/contract/deploy-parameters.test.ts`:

```ts
it("passes SlackAppPostedMessages to the control plane only when chosen", () => {
  expect(stackParameters("control-plane", { ...answers(), slackAppPostedMessages: "ignore" }, outputs).SlackAppPostedMessages).toBe("ignore");
  expect(stackParameters("control-plane", answers(), outputs)).not.toHaveProperty("SlackAppPostedMessages");
});
```

Append to `tests/contract/deploy-cli.test.ts`, in the `agentx deploy` describe:

```ts
  it("accepts slackAppPostedMessages in the answers file and refuses a value outside accept and ignore", async () => {
    const io = capture();
    const dir = await tmp("agentx-answers-");
    const answersPath = join(dir, "answers.json");
    await writeFile(answersPath, JSON.stringify(answersJson({ slackAppPostedMessages: "sometimes" })));
    const code = await executeCli(["deploy", "--mode", "install", "--release", "/nonexistent-release", "--answers", answersPath, "--yes"], { ...io, deploy: safeDeployDeps() });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("slackAppPostedMessages");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-cli.test.ts`
Expected: FAIL. The init modules are missing and `SlackAppPostedMessages` is not passed.

- [ ] **Step 4: Implement**

`parameters.ts`: add `slackAppPostedMessages?: "accept" | "ignore"` to `InstallAnswers`, with the comment
"the control plane's SlackAppPostedMessages (spec 014 FR-012); template default accept". In the
`control-plane` case, add
`...(answers.slackAppPostedMessages === undefined ? {} : { SlackAppPostedMessages: answers.slackAppPostedMessages })`.

`commands.ts`:
- `DeployAnswersSchema` gains `slackAppPostedMessages: z.enum(["accept", "ignore"]).optional()`, and
  `toDeployAnswers` copies it the same way it copies `operatorPrincipalArn`.
- Add `prepareDeployment`, moving these lines out of `deployCommand` unchanged, in their existing
  order:
  - the region coverage check (keep the copy in `deployCommand` too, before the confirmation
    setup, so `agentx deploy`'s refusal order does not change);
  - `identity.get()` and the account and partition checks;
  - the store and secrets;
  - building the deployer, including the cdk branch's `assertSourceAtRelease`,
    `assertCdkBootstrapped`, `buildSource` and outputs directory.
- `cleanup` removes that outputs directory.
- `deployCommand` then does
  `const prepared = await prepareDeployment({...}); try { ...deployEnvironment({ deployer: prepared.deployer, store: prepared.store, secrets: prepared.secrets, holder: prepared.holder, ... }) } finally { await prepared.cleanup(); }`.
- Every existing `deploy-cli.test.ts` test must pass unchanged. They are the proof the refactor
  kept behaviour.

`context.ts`:

```ts
// packages/cli/src/init/context.ts
// What every init step receives. Every AWS, vendor, browser, clock and prompt dependency is here,
// so tests replace all of them and nothing reaches AWS, GitHub or Slack.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeSecretCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { PreparedDeployment } from "../deploy/commands.js";
import type { LoadedRelease } from "../deploy/release.js";
import { secretsManagerValueStore, type SecretValueStore } from "../deploy/signing-key.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter, SecretSource } from "./prompts.js";

export interface InitSecrets extends SecretValueStore {
  put(name: string, value: string): Promise<void>;
  arn(name: string): Promise<string | undefined>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function secretsManagerInitSecrets(client: SecretsManagerClient): InitSecrets {
  const base = secretsManagerValueStore(client);
  return {
    get: (name) => base.get(name),
    create: (name, value) => base.create(name, value),
    async put(name, value) {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    },
    async arn(name) {
      try {
        return (await client.send(new DescribeSecretCommand({ SecretId: name }))).ARN;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        throw error;
      }
    },
  };
}

export interface StackStatusReader { status(stackName: string): Promise<string | undefined> }

export function cloudFormationStatusReader(client: CloudFormationClient): StackStatusReader {
  return {
    async status(stackName) {
      try {
        return (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
      } catch (error) {
        if (errorName(error) === "ValidationError" && /does not exist/.test((error as Error).message)) return undefined;
        throw error;
      }
    },
  };
}

export interface SecretFlags { slackBotToken?: SecretSource; slackSigningSecret?: SecretSource; githubPrivateKey?: SecretSource }
export interface PreMadeGitHubApp { appId: string; installationId: string }

export interface InitContext {
  env: string;
  answers: InitAnswers;
  release: LoadedRelease;
  holder: string;
  store: ParameterStore;
  secrets: InitSecrets;
  prompter: Prompter;
  write(line: string): void;
  openBrowser?: (url: string) => Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
  processEnv: NodeJS.ProcessEnv;
  secretFlags: SecretFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  deployment(): Promise<PreparedDeployment>;
  stackStatus: StackStatusReader;
  home: string;
  prerequisitesPassed: boolean;
  runPrerequisites(): Promise<void>;
}
```

`deploy-steps.ts`:

```ts
// packages/cli/src/init/deploy-steps.ts
// The init steps that deploy stacks: each drives 15c2's deployEnvironment for its parts, under the
// lock the step runner already holds. Before deploying, a step waits for any of its stacks still
// busy from an interrupted run (CloudFormation keeps going after a terminal closes).
import { agentXError, environmentStackName } from "@agentx/contracts";
import { progressLine } from "../deploy/commands.js";
import { deployEnvironment, type DeployAnswers } from "../deploy/deploy-environment.js";
import { installOrder, type DeployPart } from "../deploy/parameters.js";
import { writeEnvironmentCache } from "../environments/cache.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import type { InitContext, StackStatusReader } from "./context.js";
import type { InitAnswers, InstallProgress } from "./install-state.js";
import type { InitStep, ProgressHandle } from "./steps.js";

export const DEPLOY_STEP_PARTS = {
  access: ["access"],
  core: ["foundation", "identity"],
  "control-plane": ["control-plane", "runtime"],
  "slack-service": ["slack"],
} as const satisfies Record<string, readonly DeployPart[]>;
export type DeployStepId = keyof typeof DEPLOY_STEP_PARTS;

export const IDLE_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const IDLE_POLL_MS = 15_000;

export function initDeployAnswers(answers: InitAnswers, progress: InstallProgress, parts: readonly DeployPart[]): DeployAnswers {
  let github: DeployAnswers["github"] = { account: "", appId: "", installationId: "", privateKeySecretArn: "" };
  if (parts.includes("control-plane")) {
    const app = progress.github;
    if (app?.installationId === undefined) {
      throw agentXError("CONFIG_INVALID", "the control plane needs the GitHub App's installation; the github-app step must finish first");
    }
    github = { account: app.account, appId: app.appId, installationId: app.installationId, privateKeySecretArn: app.privateKeySecretArn };
  }
  // Rebuilt field by field: zod's inferred optionals are `T | undefined`, which exactOptionalPropertyTypes
  // treats as a different type from DeployAnswers' absent-or-T optionals (as toDeployAnswers does).
  const source = answers.identity;
  const identity: DeployAnswers["identity"] = source.mode === "cognito"
    ? { mode: "cognito" }
    : {
        mode: "oidc", issuer: source.issuer, audience: source.audience,
        ...(source.adminClaim === undefined ? {} : { adminClaim: source.adminClaim }),
        ...(source.adminValues === undefined ? {} : { adminValues: source.adminValues }),
        ...(source.clientId === undefined ? {} : { clientId: source.clientId }),
      };
  const images = answers.images === undefined
    ? undefined
    : { ...(answers.images.worker === undefined ? {} : { worker: answers.images.worker }), ...(answers.images.slack === undefined ? {} : { slack: answers.images.slack }) };
  return {
    env: answers.env,
    region: answers.region,
    account: answers.account,
    models: answers.models,
    identity,
    github,
    ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    ...(answers.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: answers.operatorPrincipalArn }),
    ...(images === undefined ? {} : { images }),
    slackAppPostedMessages: answers.slack.appPostedMessages,
  };
}

const busy = (status: string | undefined) => status !== undefined && status.endsWith("_IN_PROGRESS") && status !== "REVIEW_IN_PROGRESS";

export async function waitForIdleStacks(input: {
  reader: StackStatusReader; stackNames: readonly string[]; sleep(ms: number): Promise<void>; write(line: string): void; now(): number;
  pollMs?: number; timeoutMs?: number;
}): Promise<void> {
  const timeout = input.timeoutMs ?? IDLE_WAIT_TIMEOUT_MS;
  for (const stackName of input.stackNames) {
    const started = input.now();
    let status = await input.reader.status(stackName);
    if (busy(status)) input.write(`Waiting for ${stackName}: it is ${status} from an earlier run`);
    while (busy(status)) {
      if (input.now() - started >= timeout) {
        throw agentXError("CONFIG_INVALID", `stack ${stackName} is still ${status} after ${Math.round(timeout / 60_000)} minutes; check it in the CloudFormation console, then run agentx init again`);
      }
      await input.sleep(input.pollMs ?? IDLE_POLL_MS);
      status = await input.reader.status(stackName);
    }
  }
}

export function deployStep(input: { id: DeployStepId; title: string; after?: (context: InitContext, progress: ProgressHandle) => Promise<void> }): InitStep<InitContext> {
  return {
    id: input.id,
    title: input.title,
    async run(context, progress) {
      const { env, answers } = context;
      const order = installOrder(answers.identity.mode);
      const parts = DEPLOY_STEP_PARTS[input.id].filter((part) => order.includes(part));
      await waitForIdleStacks({ reader: context.stackStatus, stackNames: parts.map((part) => environmentStackName(env, part)), sleep: context.sleep, write: context.write, now: context.now });
      const deployment = await context.deployment();
      const result = await deployEnvironment({
        mode: "install",
        engine: answers.engine,
        answers: initDeployAnswers(answers, progress.current(), parts),
        release: context.release,
        deployer: deployment.deployer,
        store: deployment.store,
        secrets: deployment.secrets,
        holder: context.holder,
        parts: [...parts],
        lockHeld: true,
        onEvent: (event) => context.write(progressLine(event)),
        now: context.now,
      });
      if (input.id === "slack-service") {
        const settings = result.settingsWritten ? await readEnvironmentSettings(deployment.store, env) : undefined;
        if (settings === undefined) {
          throw agentXError("CONFIG_INVALID", `the Slack service deployed but environment ${env}'s settings were not written because not every stack reports its outputs; check the agentx-${env}-* stacks in CloudFormation, then run agentx init again`);
        }
        const path = await writeEnvironmentCache(context.home, settings);
        context.write(`Environment settings written to /agentx/${env}/settings; this machine's copy is ${path}`);
      }
      if (input.after !== undefined) await input.after(context, progress);
      return { status: "done" };
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-cli.test.ts tests/contract/deploy-environment.test.ts tests/contract/export-bundle.test.ts`
Expected: PASS. The export bundle tests pass unchanged, because an answer that doesn't set the
new field adds no parameter.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/context.ts packages/cli/src/init/deploy-steps.ts packages/cli/src/deploy/commands.ts packages/cli/src/deploy/parameters.ts tests/support/init-fakes.ts tests/contract/init-deploy-steps.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-cli.test.ts
git commit -m "feat(cli): init deploy steps drive deployEnvironment, waiting out stacks left busy"
```

### Task 8: The GitHub App manifest flow

**Files:**
- Create: `packages/cli/src/init/github-app.ts`
- Modify: `tests/support/init-fakes.ts` (append `fakeGitHubApi`, `browserThatCreatesGitHubApp`)
- Test: `tests/contract/init-github-app.test.ts`

**Interfaces:**
- Consumes:
  - `InitContext`, `InitSecrets` (Task 7);
  - `InitStep` (Task 3);
  - `secretFromSource`, `checkPrivateKeyPem` (Task 1);
  - `agentXError`.
- Produces:

```ts
export const AGENTX_HOMEPAGE = "https://github.com/PrepLabsAI/AgentX";
export const GITHUB_WAIT_MS = 15 * 60 * 1000;
export interface GitHubManifest {
  name: string; url: string; redirect_url: string; public: false;
  default_permissions: { contents: "write"; pull_requests: "write"; issues: "write"; metadata: "read" };
  default_events: string[];
}
export function githubAppManifest(input: { appName: string; redirectUrl: string }): GitHubManifest;
export function githubNewAppUrl(input: { account: string; accountType: "organization" | "user"; state: string }): string;
export function manifestFormPage(input: { actionUrl: string; manifest: GitHubManifest }): string;
export function parseManifestCallback(pasted: string, expectedState: string): string;
export interface ManifestListener { port: number; startUrl: string; redirectUrl: string; code: Promise<string>; close(): void }
export async function startManifestListener(input: { state: string; page: (redirectUrl: string) => string; timeoutMs: number }): Promise<ManifestListener>;
export function githubAppJwt(input: { appId: string; privateKey: string; nowSeconds: number }): string;
export interface GitHubApi {
  convertManifest(code: string): Promise<{ id: number; slug: string; pem: string; owner: { login: string; type: string } }>;
  getApp(jwt: string): Promise<{ slug: string; owner: { login: string; type: string } }>;
  listInstallations(jwt: string): Promise<Array<{ id: number; account: { login: string } }>>;
  installationToken(jwt: string, installationId: string): Promise<string>;
  repositoryCount(token: string): Promise<number>;
}
export function githubRestApi(fetchImplementation: typeof fetch): GitHubApi;
export function githubAppSecretName(env: string): string;   // agentx/<env>/github-app
export function githubAppStep(api: GitHubApi): InitStep<InitContext>;
```

- [ ] **Step 1: Append the GitHub fakes**

```ts
// tests/support/init-fakes.ts (append)
import { generateKeyPairSync } from "node:crypto";
import type { GitHubApi } from "../../packages/cli/src/init/github-app.js";

const TEST_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
// Trimmed, as the CLI stores it: GitHub's PEM ends with a newline, and the CLI trims before storing.
export const TEST_PRIVATE_KEY = TEST_KEYS.privateKey.trim();
export const TEST_PUBLIC_KEY = TEST_KEYS.publicKey;

/** A GitHub that converts any code into an app owned by `owner`, installs it after `installAfterPolls` polls, and reports repository counts in turn. */
export function fakeGitHubApi(input: { owner?: string; ownerType?: string; installAfterPolls?: number; repositoryCounts?: number[]; installationId?: number } = {}): GitHubApi & { conversions: string[]; polls: () => number } {
  const conversions: string[] = [];
  let polls = 0;
  const counts = [...(input.repositoryCounts ?? [1])];
  const owner = { login: input.owner ?? "acme", type: input.ownerType ?? "Organization" };
  return {
    conversions,
    polls: () => polls,
    async convertManifest(code) { conversions.push(code); return { id: 424242, slug: "agentx-acme-staging", pem: TEST_PRIVATE_KEY, owner }; },
    async getApp() { return { slug: "agentx-acme-staging", owner }; },
    async listInstallations() { polls += 1; return polls > (input.installAfterPolls ?? 0) ? [{ id: input.installationId ?? 777, account: { login: owner.login } }] : []; },
    async installationToken() { return "ghs_installation-token-value"; },
    async repositoryCount() { return counts.length > 1 ? (counts.shift() as number) : (counts[0] as number); },
  };
}

/** A browser that, given the local form page, plays GitHub: it redirects back with `code` and the page's state. */
export function browserThatCreatesGitHubApp(opened: string[], code = "0123456789abcdef0123"): (url: string) => Promise<void> {
  return async (url) => {
    opened.push(url);
    if (!url.startsWith("http://127.0.0.1:")) return;
    const page = await (await fetch(url)).text();
    const state = /[?&]state=([a-f0-9]+)/.exec(page)?.[1];
    await fetch(`${url.replace("/github/start", "/github/created")}?code=${code}&state=${state ?? "missing"}`);
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/init-github-app.test.ts
import { createVerify } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubAppJwt, githubAppManifest, githubAppSecretName, githubAppStep, githubNewAppUrl, manifestFormPage, parseManifestCallback, startManifestListener,
} from "../../packages/cli/src/init/github-app.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import {
  browserThatCreatesGitHubApp, fakeGitHubApi, initContext, memoryInitSecrets, progressHandle, sampleAnswers, scriptedPrompter, T0, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const SECRET = githubAppSecretName("staging");

describe("GitHub App manifest", () => {
  it("asks for exactly the permissions AgentX uses, no webhook and no events", () => {
    expect(githubAppManifest({ appName: "AgentX acme staging", redirectUrl: "http://127.0.0.1:50123/github/created" })).toEqual({
      name: "AgentX acme staging",
      url: "https://github.com/PrepLabsAI/AgentX",
      redirect_url: "http://127.0.0.1:50123/github/created",
      public: false,
      default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
      default_events: [],
    });
  });

  it("opens the new-app page for an organization or a personal account", () => {
    expect(githubNewAppUrl({ account: "acme", accountType: "organization", state: "s1" })).toBe("https://github.com/organizations/acme/settings/apps/new?state=s1");
    expect(githubNewAppUrl({ account: "alice", accountType: "user", state: "s1" })).toBe("https://github.com/settings/apps/new?state=s1");
  });

  it("posts the manifest from an auto-submitting form, escaping everything", () => {
    const page = manifestFormPage({ actionUrl: "https://github.com/settings/apps/new?state=s1", manifest: githubAppManifest({ appName: "A\"<b>'&", redirectUrl: "http://127.0.0.1:1/github/created" }) });
    expect(page).toContain('<form id="manifest-form" method="post" action="https://github.com/settings/apps/new?state=s1">');
    expect(page).toContain('name="manifest" value="{&quot;name&quot;:&quot;A\\&quot;&lt;b&gt;&#39;&amp;&quot;');
    expect(page).not.toContain("<b>");
    expect(page).toContain('document.getElementById("manifest-form").submit()');
  });

  it("takes a pasted redirect address or a bare code, and refuses another run's address", () => {
    expect(parseManifestCallback("http://127.0.0.1:50123/github/created?code=abc123def456&state=s1", "s1")).toBe("abc123def456");
    expect(parseManifestCallback("  abc123def456\n", "s1")).toBe("abc123def456");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?code=abc123def456&state=other", "s1")).toThrow("that address is from a different agentx init run");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?state=s1", "s1")).toThrow("that address has no code");
    expect(() => parseManifestCallback("no", "s1")).toThrow("that is not a GitHub manifest code");
  });

  it("signs an app JWT GitHub accepts: RS256, issued a minute early, nine minutes long", () => {
    const jwt = githubAppJwt({ appId: "424242", privateKey: TEST_PRIVATE_KEY, nowSeconds: 1_800_000_000 });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "424242" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(TEST_PUBLIC_KEY, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("manifest listener", () => {
  it("serves the form on a free loopback port and resolves the code only for the right state", async () => {
    const listener = await startManifestListener({ state: "s1", page: (redirect) => `<p>${redirect}</p>`, timeoutMs: 60_000 });
    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.port).not.toBe(8765);
      expect(await (await fetch(listener.startUrl)).text()).toBe(`<p>${listener.redirectUrl}</p>`);
      expect((await fetch(`${listener.redirectUrl}?code=abc&state=wrong`)).status).toBe(400);
      const done = await fetch(`${listener.redirectUrl}?code=abc123def456&state=s1`);
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("You can close this tab");
      await expect(listener.code).resolves.toBe("abc123def456");
    } finally {
      listener.close();
    }
  });
});

describe("GitHub App step", () => {
  it("creates the app, stores its key straight into Secrets Manager, and waits for an installation with repositories", async () => {
    const opened: string[] = [];
    const api = fakeGitHubApi({ installAfterPolls: 2 });
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp(opened) });
    homes.push(context.home);
    const progress = progressHandle();
    const outcome = await githubAppStep(api).run(context, progress);
    expect(outcome.status).toBe("done");
    expect(api.conversions).toEqual(["0123456789abcdef0123"]);
    expect(JSON.parse(context.secrets.values.get(SECRET)!)).toEqual({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY });
    expect(progress.value().github).toEqual({ account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" });
    expect(opened).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(context.lines.join("\n")).not.toContain("PRIVATE KEY");
  });

  it("refuses an app created under another account, saving nothing and saying how to delete it", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    let message = "";
    try { await githubAppStep(fakeGitHubApi({ owner: "someone-else", ownerType: "User" })).run(context, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("the GitHub App was created under someone-else, not acme; nothing was saved. Delete it at https://github.com/settings/apps/agentx-acme-staging/advanced and run agentx init again");
    expect(message).not.toContain("PRIVATE KEY");
    expect(context.secrets.values.size).toBe(0);
  });

  it("resumes after the app was created: never creates a second app, reads the key back from the secret", async () => {
    const api = fakeGitHubApi();
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets });
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: { account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" } });
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(progress.value().github?.installationId).toBe("777");
  });

  it("recovers an app whose secret was stored just before a crash, without creating another", async () => {
    const api = fakeGitHubApi();
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(context.lines).toContain("Found the GitHub App agentx-acme-staging an earlier run created.");
  });

  it("waits until the installation can see at least one repository", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    await githubAppStep(fakeGitHubApi({ repositoryCounts: [0, 0, 2] })).run(context, progressHandle());
    expect(context.lines.join("\n")).toContain("The app is installed but can see no repositories. Choose at least one at https://github.com/organizations/acme/settings/installations/777");
  });

  it("gives up waiting for an installation after 15 minutes, naming the install page", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi({ installAfterPolls: 1_000_000 })).run(context, progressHandle()))
      .rejects.toThrow("the GitHub App was not installed on acme within 15 minutes; install it at https://github.com/apps/agentx-acme-staging/installations/new, then run agentx init again");
  });

  it("with --no-browser, takes the pasted redirect address", async () => {
    const api = fakeGitHubApi();
    const context = initContext({ prompter: scriptedPrompter(["0123456789abcdef0123"]) });
    delete (context as { openBrowser?: unknown }).openBrowser;
    homes.push(context.home);
    await githubAppStep(api).run(context, progressHandle());
    expect(api.conversions).toEqual(["0123456789abcdef0123"]);
    expect(context.lines.join("\n")).toContain("ssh -L");
  });

  it("uses a GitHub App made beforehand, checking its owner and installation", async () => {
    const api = fakeGitHubApi({ installationId: 555 });
    const context = initContext({
      preMadeGitHubApp: { appId: "424242", installationId: "555" },
      secretFlags: { githubPrivateKey: { envName: "GH_KEY" } },
      processEnv: { GH_KEY: `${TEST_PRIVATE_KEY}\n` },
      answers: sampleAnswers(),
    });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(progress.value().github?.installationId).toBe("555");

    const wrong = initContext({ preMadeGitHubApp: { appId: "424242", installationId: "999" }, secretFlags: { githubPrivateKey: { envName: "GH_KEY" } }, processEnv: { GH_KEY: TEST_PRIVATE_KEY } });
    homes.push(wrong.home);
    await expect(githubAppStep(fakeGitHubApi({ installationId: 555 })).run(wrong, progressHandle())).rejects.toThrow("installation 999 of GitHub App 424242 is not on acme");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-github-app.test.ts`
Expected: FAIL, "Cannot find module .../init/github-app.js".

- [ ] **Step 4: Implement `github-app.ts`**

```ts
// packages/cli/src/init/github-app.ts
// FR-027 to FR-030: the GitHub App is created with GitHub's manifest flow. A one-time listener on
// 127.0.0.1 serves the pre-filled form and receives GitHub's redirect; the conversion's private key
// goes straight into Secrets Manager and is never printed or written to disk. The app has no
// webhook: AgentX handles no GitHub events.
import { createSign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { agentXError } from "@agentx/contracts";
import type { InitContext } from "./context.js";
import { checkPrivateKeyPem, secretFromSource } from "./prompts.js";
import type { InitStep } from "./steps.js";

export const AGENTX_HOMEPAGE = "https://github.com/PrepLabsAI/AgentX";
export const GITHUB_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 5_000;
const API = "https://api.github.com";

export interface GitHubManifest {
  name: string; url: string; redirect_url: string; public: false;
  default_permissions: { contents: "write"; pull_requests: "write"; issues: "write"; metadata: "read" };
  default_events: string[];
}

export function githubAppManifest(input: { appName: string; redirectUrl: string }): GitHubManifest {
  return {
    name: input.appName,
    url: AGENTX_HOMEPAGE,
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    default_events: [],
  };
}

export function githubNewAppUrl(input: { account: string; accountType: "organization" | "user"; state: string }): string {
  return input.accountType === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(input.account)}/settings/apps/new?state=${input.state}`
    : `https://github.com/settings/apps/new?state=${input.state}`;
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function manifestFormPage(input: { actionUrl: string; manifest: GitHubManifest }): string {
  return [
    "<!doctype html><meta charset=\"utf-8\"><title>Create the AgentX GitHub App</title>",
    `<form id="manifest-form" method="post" action="${escapeHtml(input.actionUrl)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(input.manifest))}">`,
    "<p>Opening GitHub with the AgentX GitHub App filled in.</p><button type=\"submit\">Continue to GitHub</button></form>",
    "<script>document.getElementById(\"manifest-form\").submit()</script>",
  ].join("\n");
}

export function parseManifestCallback(pasted: string, expectedState: string): string {
  const text = pasted.trim();
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    const state = url.searchParams.get("state");
    if (state !== null && state !== expectedState) throw agentXError("CONFIG_INVALID", "that address is from a different agentx init run (its state does not match); create the app from the page this run printed");
    const code = url.searchParams.get("code");
    if (code === null || code === "") throw agentXError("CONFIG_INVALID", "that address has no code; paste the address GitHub sent your browser to after creating the app");
    return code;
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(text)) throw agentXError("CONFIG_INVALID", "that is not a GitHub manifest code; paste the address GitHub sent your browser to after creating the app");
  return text;
}

export interface ManifestListener { port: number; startUrl: string; redirectUrl: string; code: Promise<string>; close(): void }

export async function startManifestListener(input: { state: string; page: (redirectUrl: string) => string; timeoutMs: number }): Promise<ManifestListener> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolvePromise, reject) => { resolveCode = resolvePromise; rejectCode = reject; });
  code.catch(() => undefined); // a timeout nobody awaits (the --no-browser path) must not crash the process
  let redirectUrl = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    if (request.method === "GET" && url.pathname === "/github/start") return send(200, input.page(redirectUrl));
    if (request.method === "GET" && url.pathname === "/github/created") {
      if (url.searchParams.get("state") !== input.state) return send(400, "<p>This page is from a different agentx init run.</p>");
      const received = url.searchParams.get("code");
      if (received === null || received === "") return send(400, "<p>GitHub sent no code.</p>");
      resolveCode(received);
      return send(200, "<p>AgentX has the new GitHub App. You can close this tab and return to the terminal.</p>");
    }
    return send(404, "<p>Not found.</p>");
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  redirectUrl = `http://127.0.0.1:${port}/github/created`;
  const timer = setTimeout(() => rejectCode(agentXError("CONFIG_INVALID", `no GitHub App was created within ${Math.round(input.timeoutMs / 60_000)} minutes; run agentx init again`)), input.timeoutMs);
  return {
    port,
    startUrl: `http://127.0.0.1:${port}/github/start`,
    redirectUrl,
    code,
    close: () => { clearTimeout(timer); server.close(); },
  };
}

export function githubAppJwt(input: { appId: string; privateKey: string; nowSeconds: number }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: input.nowSeconds - 60, exp: input.nowSeconds + 540, iss: input.appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(input.privateKey).toString("base64url")}`;
}

export interface GitHubApi {
  convertManifest(code: string): Promise<{ id: number; slug: string; pem: string; owner: { login: string; type: string } }>;
  getApp(jwt: string): Promise<{ slug: string; owner: { login: string; type: string } }>;
  listInstallations(jwt: string): Promise<Array<{ id: number; account: { login: string } }>>;
  installationToken(jwt: string, installationId: string): Promise<string>;
  repositoryCount(token: string): Promise<number>;
}

export function githubRestApi(fetchImplementation: typeof fetch): GitHubApi {
  const call = async (what: string, path: string, init: { method?: string; token?: string } = {}): Promise<unknown> => {
    const response = await fetchImplementation(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agentx-cli",
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
    });
    // Never include the body: a conversion response carries the private key.
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${response.status}`);
    return response.json();
  };
  return {
    async convertManifest(code) {
      return (await call("manifest conversion (the code is valid for one hour)", `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" })) as Awaited<ReturnType<GitHubApi["convertManifest"]>>;
    },
    async getApp(jwt) {
      return (await call("app lookup", "/app", { token: jwt })) as Awaited<ReturnType<GitHubApi["getApp"]>>;
    },
    async listInstallations(jwt) {
      return (await call("installation list", "/app/installations?per_page=100", { token: jwt })) as Awaited<ReturnType<GitHubApi["listInstallations"]>>;
    },
    async installationToken(jwt, installationId) {
      return ((await call("installation token", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: "POST", token: jwt })) as { token: string }).token;
    },
    async repositoryCount(token) {
      return ((await call("repository list", "/installation/repositories?per_page=1", { token })) as { total_count: number }).total_count;
    },
  };
}

export function githubAppSecretName(env: string): string {
  return `agentx/${env}/github-app`;
}

interface AppSecret { appId: string; slug: string; account: string; privateKey: string }

function parseAppSecret(raw: string, name: string): AppSecret {
  try {
    const value = JSON.parse(raw) as Partial<AppSecret>;
    if (typeof value.appId === "string" && typeof value.slug === "string" && typeof value.account === "string" && typeof value.privateKey === "string") {
      return { appId: value.appId, slug: value.slug, account: value.account, privateKey: checkPrivateKeyPem(value.privateKey) };
    }
  } catch { /* the one message below; never echo the value */ }
  throw agentXError("CONFIG_INVALID", `secret ${name} is not an AgentX GitHub App secret; delete it (aws secretsmanager delete-secret --secret-id ${name} --force-delete-without-recovery) and run agentx init again`);
}

const appSettingsUrl = (owner: { login: string; type: string }, slug: string) =>
  owner.type === "Organization" ? `https://github.com/organizations/${owner.login}/settings/apps/${slug}` : `https://github.com/settings/apps/${slug}`;
const installationSettingsUrl = (accountType: "organization" | "user", account: string, id: string) =>
  accountType === "organization" ? `https://github.com/organizations/${account}/settings/installations/${id}` : `https://github.com/settings/installations/${id}`;

async function createWithManifest(context: InitContext, api: GitHubApi): Promise<AppSecret & { owner: { login: string; type: string } }> {
  const { account, accountType, appName } = context.answers.github;
  const state = randomBytes(16).toString("hex");
  const actionUrl = githubNewAppUrl({ account, accountType, state });
  const listener = await startManifestListener({ state, page: (redirectUrl) => manifestFormPage({ actionUrl, manifest: githubAppManifest({ appName, redirectUrl }) }), timeoutMs: GITHUB_WAIT_MS });
  try {
    context.write(`Create the GitHub App "${appName}" for ${account}: GitHub opens with everything filled in; press Create GitHub App.`);
    let code: string;
    if (context.openBrowser !== undefined) {
      context.write(`If no browser opens, open ${listener.startUrl}`);
      await context.openBrowser(listener.startUrl);
      code = await listener.code;
    } else {
      context.write(`Open ${listener.startUrl} in a browser on this machine. From another machine, first run: ssh -L ${listener.port}:127.0.0.1:${listener.port} <this host>`);
      context.write("After GitHub creates the app it sends your browser to a 127.0.0.1 address. If that page does not load, copy the address from the address bar.");
      code = parseManifestCallback(await context.prompter.ask("Paste that address (or just its code)", { flag: "--github-app-id, --github-installation-id and --github-private-key-file (a GitHub App made beforehand)" }), state);
    }
    const conversion = await api.convertManifest(code);
    return { appId: String(conversion.id), slug: conversion.slug, account: conversion.owner.login, privateKey: checkPrivateKeyPem(conversion.pem.trim()), owner: conversion.owner };
  } finally {
    listener.close();
  }
}

async function usePreMadeApp(context: InitContext, api: GitHubApi, appId: string): Promise<AppSecret & { owner: { login: string; type: string } }> {
  const privateKey = checkPrivateKeyPem(await secretFromSource({
    what: "GitHub App private key", flag: "--github-private-key", source: context.secretFlags.githubPrivateKey ?? {}, processEnv: context.processEnv, prompter: context.prompter, multiline: true,
  }));
  const app = await api.getApp(githubAppJwt({ appId, privateKey, nowSeconds: Math.floor(context.now() / 1000) }));
  return { appId, slug: app.slug, account: app.owner.login, privateKey, owner: app.owner };
}

export function githubAppStep(api: GitHubApi): InitStep<InitContext> {
  return {
    id: "github-app",
    title: "Create and install the GitHub App",
    async run(context, progress) {
      const { account, accountType } = context.answers.github;
      const name = githubAppSecretName(context.env);
      const requireArn = async () => {
        const arn = await context.secrets.arn(name);
        if (arn === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `secret ${name} was just stored but cannot be described; run agentx init again`);
        return arn;
      };
      const jwtFor = (appId: string, privateKey: string) => githubAppJwt({ appId, privateKey, nowSeconds: Math.floor(context.now() / 1000) });

      let app = progress.current().github;
      let privateKey: string | undefined;
      if (app === undefined) {
        const leftover = await context.secrets.get(name);
        if (leftover !== undefined) {
          const recovered = parseAppSecret(leftover, name);
          privateKey = recovered.privateKey;
          app = { account: recovered.account, appId: recovered.appId, slug: recovered.slug, privateKeySecretArn: await requireArn() };
          await progress.update({ github: app });
          context.write(`Found the GitHub App ${recovered.slug} an earlier run created.`);
        }
      }
      if (app === undefined) {
        const created = context.preMadeGitHubApp !== undefined ? await usePreMadeApp(context, api, context.preMadeGitHubApp.appId) : await createWithManifest(context, api);
        if (created.owner.login.toLowerCase() !== account.toLowerCase()) {
          throw agentXError("CONFIG_INVALID", `the GitHub App was created under ${created.owner.login}, not ${account}; nothing was saved. Delete it at ${appSettingsUrl(created.owner, created.slug)}/advanced and run agentx init again`);
        }
        await context.secrets.create(name, JSON.stringify({ appId: created.appId, slug: created.slug, account, privateKey: created.privateKey }));
        privateKey = created.privateKey;
        app = { account, appId: created.appId, slug: created.slug, privateKeySecretArn: await requireArn() };
        await progress.update({ github: app });
      }
      if (privateKey === undefined) {
        const stored = await context.secrets.get(name);
        if (stored === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} is missing; delete the GitHub App ${app.slug} and run agentx init again`);
        privateKey = parseAppSecret(stored, name).privateKey;
      }

      const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
      const deadline = context.now() + GITHUB_WAIT_MS;
      let installationId = context.preMadeGitHubApp?.installationId;
      if (installationId !== undefined) {
        const listed = await api.listInstallations(jwtFor(app.appId, privateKey));
        if (!listed.some((entry) => String(entry.id) === installationId && entry.account.login.toLowerCase() === account.toLowerCase())) {
          throw agentXError("CONFIG_INVALID", `installation ${installationId} of GitHub App ${app.appId} is not on ${account}; check --github-installation-id`);
        }
      } else {
        context.write(`Install the app on ${account} and choose the repositories AgentX may use: ${installUrl}`);
        if (context.openBrowser !== undefined) await context.openBrowser(installUrl);
        for (;;) {
          const match = (await api.listInstallations(jwtFor(app.appId, privateKey))).find((entry) => entry.account.login.toLowerCase() === account.toLowerCase());
          if (match !== undefined) { installationId = String(match.id); break; }
          if (context.now() >= deadline) {
            throw agentXError("CONFIG_INVALID", `the GitHub App was not installed on ${account} within 15 minutes; install it at ${installUrl}, then run agentx init again`);
          }
          await context.sleep(POLL_MS);
        }
      }

      let told = false;
      for (;;) {
        const token = await api.installationToken(jwtFor(app.appId, privateKey), installationId);
        if ((await api.repositoryCount(token)) > 0) break;
        if (!told) {
          context.write(`The app is installed but can see no repositories. Choose at least one at ${installationSettingsUrl(accountType, account, installationId)}`);
          told = true;
        }
        if (context.now() >= deadline) throw agentXError("CONFIG_INVALID", `the GitHub App can see no repositories; choose at least one at ${installationSettingsUrl(accountType, account, installationId)}, then run agentx init again`);
        await context.sleep(POLL_MS);
      }
      await progress.update({ github: { ...app, installationId } });
      return { status: "done", note: `GitHub App ${app.slug} installed on ${account}` };
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-github-app.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/github-app.ts tests/support/init-fakes.ts tests/contract/init-github-app.test.ts
git commit -m "feat(cli): GitHub App from a manifest; key straight to Secrets Manager; installation checked"
```

### Task 9: The Slack app from a manifest, and verifying its URLs

**Files:**
- Create: `packages/cli/src/init/slack-app.ts`
- Modify: `tests/support/init-fakes.ts` (append `fakeSlackApi`, `slackIngressFetch`)
- Test: `tests/contract/init-slack-app.test.ts`

**Interfaces:**
- Consumes:
  - `InitContext` (Task 7);
  - `InitStep`, `ProgressHandle` (Task 3);
  - `secretFromSource`, `checkSlackBotToken`, `checkSlackSigningSecret` (Task 1);
  - `environmentStackName`, `agentXError`.
- Produces:

```ts
export const SLACK_BOT_SCOPES: readonly string[];   // app_mentions:read, channels:join, channels:read, chat:write, groups:read, users:read
export interface SlackManifest { /* the Slack app manifest shape below */ }
export function slackBotDisplayName(appName: string): string;
export function slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string }): SlackManifest;
export function slackCreateAppUrl(manifest: SlackManifest): string;
export function slackSecretName(env: string): string;   // agentx/<env>/slack
export function signSlackRequest(input: { signingSecret: string; body: string; timestampSeconds: number }): { "x-slack-request-timestamp": string; "x-slack-signature": string };
export const SLACK_PROBE_TIMEOUT_MS = 7 * 60 * 1000;
export async function probeSlackUrls(input: { eventsUrl: string; interactivityUrl: string; signingSecret: string; fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void>; write(line: string): void; timeoutMs?: number; pollMs?: number }): Promise<void>;
export interface SlackApi {
  authTest(token: string): Promise<{ ok: boolean; error?: string; user_id?: string; bot_id?: string; team_id?: string }>;
  botsInfo(token: string, botId: string): Promise<{ ok: boolean; error?: string; bot?: { app_id?: string } }>;
}
export function slackWebApi(fetchImplementation: typeof fetch): SlackApi;
export function slackAppStep(api: SlackApi): InitStep<InitContext>;
/** The slack-service step's after hook (Task 11 wires it): probe both URLs, then ask the engineer to confirm Slack shows Verified. */
export async function verifySlackUrls(context: InitContext, progress: ProgressHandle): Promise<void>;
```

- [ ] **Step 1: Append the Slack fakes**

```ts
// tests/support/init-fakes.ts (append)
import { createHmac } from "node:crypto";
import type { SlackApi } from "../../packages/cli/src/init/slack-app.js";

export const TEST_BOT_TOKEN = "xoxb-1111-2222-SECRETbotTOKENvalue";
export const TEST_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

export function fakeSlackApi(overrides: Partial<SlackApi> = {}): SlackApi {
  return {
    authTest: async () => ({ ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEAM" }),
    botsInfo: async () => ({ ok: true, bot: { app_id: "A0APP" } }),
    ...overrides,
  };
}

/** Plays the control plane's Slack ingress: verifies the signature like validSignature does, answers 401 for the first `staleFor` calls (the cached old secret), then echoes challenges. */
export function slackIngressFetch(input: { signingSecret: string; staleFor?: number }): typeof fetch & { calls: string[] } {
  let seen = 0;
  const calls: string[] = [];
  const handler = async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push(target);
    seen += 1;
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    const timestamp = headers.get("x-slack-request-timestamp") ?? "";
    const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    if (seen <= (input.staleFor ?? 0) || headers.get("x-slack-signature") !== expected) return new Response(JSON.stringify({ error: "invalid Slack signature" }), { status: 401 });
    if (target.endsWith("/events")) return new Response(JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return Object.assign(handler as typeof fetch, { calls });
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/init-slack-app.test.ts
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeSlackUrls, signSlackRequest, slackAppManifest, slackAppStep, slackBotDisplayName, slackCreateAppUrl, slackSecretName, verifySlackUrls,
} from "../../packages/cli/src/init/slack-app.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import {
  allStackOutputs, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedDeployer, scriptedPrompter, slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const EVENTS = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/events";
const INTERACTIONS = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/interactions";
const SLACK_SECRET = slackSecretName("staging");

/** A context whose control plane is deployed and whose Slack secret exists with the control plane's placeholder. */
function slackContext(prompts: Array<string | boolean>, extra: Parameters<typeof initContext>[0] = {}) {
  const outputs = allStackOutputs();
  const deployer = scriptedDeployer(outputs, Object.keys(outputs));
  const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ botToken: "unset", signingSecret: "generated-placeholder" }) });
  const context = initContext({ prompter: scriptedPrompter(prompts), secrets, ...extra });
  context.deployment = async () => ({ deployer, store: context.store, secrets, holder: context.holder, partition: "aws", cleanup: async () => undefined });
  homes.push(context.home);
  return context;
}

describe("Slack app manifest", () => {
  it("carries AgentX's bot scopes, the app_mention event and this environment's URLs", () => {
    expect(slackAppManifest({ appName: "AgentX", eventsUrl: EVENTS, interactivityUrl: INTERACTIONS })).toEqual({
      display_information: { name: "AgentX", description: "AgentX: ask in Slack, and AgentX works in your repositories and trackers." },
      features: { bot_user: { display_name: "agentx", always_online: true } },
      oauth_config: { scopes: { bot: ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "users:read"] } },
      settings: {
        event_subscriptions: { request_url: EVENTS, bot_events: ["app_mention"] },
        interactivity: { is_enabled: true, request_url: INTERACTIONS },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("derives a valid bot display name from any app name", () => {
    expect(slackBotDisplayName("AgentX Staging!")).toBe("agentx-staging");
    expect(slackBotDisplayName("***")).toBe("agentx");
  });

  it("opens Slack's create-from-manifest page with the manifest", () => {
    const manifest = slackAppManifest({ appName: "AgentX", eventsUrl: EVENTS, interactivityUrl: INTERACTIONS });
    const url = new URL(slackCreateAppUrl(manifest));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json")!)).toEqual(manifest);
  });

  it("signs a request exactly as the ingress verifies it", () => {
    const headers = signSlackRequest({ signingSecret: TEST_SIGNING_SECRET, body: "{}", timestampSeconds: 1_800_000_000 });
    expect(headers).toEqual({
      "x-slack-request-timestamp": "1800000000",
      "x-slack-signature": `v0=${createHmac("sha256", TEST_SIGNING_SECRET).update("v0:1800000000:{}").digest("hex")}`,
    });
  });
});

describe("probing the Slack URLs", () => {
  const probe = (fetch: typeof globalThis.fetch, clock = { t: T0 }, lines: string[] = []) => probeSlackUrls({
    eventsUrl: EVENTS, interactivityUrl: INTERACTIONS, signingSecret: TEST_SIGNING_SECRET, fetch, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, write: (line) => lines.push(line),
  });

  it("retries while the ingress still holds the old secret, then passes both URLs", async () => {
    const fetch = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET, staleFor: 3 });
    const lines: string[] = [];
    await probe(fetch, { t: T0 }, lines);
    expect(fetch.calls.filter((url) => url === EVENTS)).toHaveLength(4);
    expect(fetch.calls.at(-1)).toBe(INTERACTIONS);
    expect(lines).toEqual(["Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)"]);
  });

  it("gives up after 7 minutes, suggesting the likeliest mistake", async () => {
    await expect(probe(slackIngressFetch({ signingSecret: "ffffffffffffffffffffffffffffffff" })))
      .rejects.toThrow(`${EVENTS} still refuses requests signed with the new signing secret after 7 minutes; check that you pasted the Signing Secret, not the Client Secret, then run agentx init again`);
  });
});

describe("Slack app step", () => {
  it("stores the bot token and signing secret in the Slack secret and records the app, never printing either", async () => {
    const context = slackContext(["installed", TEST_BOT_TOKEN, `${TEST_SIGNING_SECRET}\n`]);
    const progress = progressHandle();
    expect(await slackAppStep(fakeSlackApi()).run(context, progress)).toMatchObject({ status: "done" });
    expect(JSON.parse(context.secrets.values.get(SLACK_SECRET)!)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(progress.value().slack).toEqual({ appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" });
    const printed = context.lines.join("\n");
    expect(printed).not.toContain(TEST_BOT_TOKEN);
    expect(printed).not.toContain(TEST_SIGNING_SECRET);
    expect(context.opened[0]).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  });

  it("waits when a workspace admin must approve the app, and continues on the next run", async () => {
    const waiting = slackContext(["approval"]);
    const outcome = await slackAppStep(fakeSlackApi()).run(waiting, progressHandle());
    expect(outcome).toEqual({ status: "waiting", message: 'Slack is waiting for a workspace admin to approve "AgentX". Once it is installed, run agentx init --env staging again; it continues here.' });
    expect(JSON.parse(waiting.secrets.values.get(SLACK_SECRET)!).botToken).toBe("unset");

    const resumed = slackContext(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]);
    const progress = progressHandle({ ...emptyProgress("staging", T0), steps: { "slack-app": { status: "waiting", at: "2026-09-27T00:00:00.000Z" } } });
    expect(await slackAppStep(fakeSlackApi()).run(resumed, progress)).toMatchObject({ status: "done" });
    expect(resumed.opened).toEqual([]);
  });

  it("refuses a user token before storing anything", async () => {
    const context = slackContext(["installed", "xoxp-1-2-3-user", TEST_SIGNING_SECRET]);
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle())).rejects.toThrow("that is a user token (xoxp-)");
    expect(JSON.parse(context.secrets.values.get(SLACK_SECRET)!).botToken).toBe("unset");
  });

  it("refuses a token Slack rejects, or one without a bot user, without echoing it", async () => {
    const rejected = slackContext(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]);
    let message = "";
    try { await slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) })).run(rejected, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
    expect(message).not.toContain(TEST_BOT_TOKEN);

    const noBot = slackContext(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]);
    await expect(slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: true, user_id: "U1", team_id: "T1" }) })).run(noBot, progressHandle()))
      .rejects.toThrow("that token does not belong to a bot user");
  });

  it("refuses a token from a different workspace than this install already uses", async () => {
    const context = slackContext(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]);
    const progress = progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0OLD", teamId: "T0OTHER", botUserId: "U0OLD" } });
    await expect(slackAppStep(fakeSlackApi()).run(context, progress)).rejects.toThrow("that token belongs to Slack workspace T0TEAM, but this install uses T0OTHER; nothing was saved");
  });

  it("reads the token and signing secret from files or environment variables under --yes", async () => {
    const context = slackContext([], {
      secretFlags: { slackBotToken: { envName: "BOT" }, slackSigningSecret: { envName: "SIGNING" } },
      processEnv: { BOT: TEST_BOT_TOKEN, SIGNING: TEST_SIGNING_SECRET },
    });
    context.prompter = { ...scriptedPrompter([]), choose: async (_q, _c, options) => options.defaultValue } as typeof context.prompter;
    expect(await slackAppStep(fakeSlackApi()).run(context, progressHandle())).toMatchObject({ status: "done" });
  });
});

describe("verifying the Slack URLs after the Slack service deploys", () => {
  it("probes both URLs, opens Event Subscriptions and accepts the engineer's confirmation", async () => {
    const context = slackContext([true], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }) });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(context, progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } }));
    expect(context.opened).toEqual(["https://api.slack.com/apps/A0APP/event-subscriptions"]);
  });

  it("stops with what to check when Slack does not show Verified", async () => {
    const context = slackContext([false], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }) });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await expect(verifySlackUrls(context, progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } })))
      .rejects.toThrow("Slack has not verified");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-slack-app.test.ts`
Expected: FAIL, "Cannot find module .../init/slack-app.js".

- [ ] **Step 4: Implement `slack-app.ts`**

```ts
// packages/cli/src/init/slack-app.ts
// FR-031 to FR-035. The Slack app is created from a manifest AgentX generates; the bot token and
// signing secret come from hidden prompts (or files or environment variables), are checked with
// auth.test, and go straight into the control plane's agentx/<env>/slack secret. The ingress
// still refuses its own and other bots' messages (FR-034): nothing here changes that.
import { createHmac, randomBytes } from "node:crypto";
import { agentXError, environmentStackName } from "@agentx/contracts";
import type { InitContext } from "./context.js";
import { checkSlackBotToken, checkSlackSigningSecret, secretFromSource } from "./prompts.js";
import type { InitStep, ProgressHandle } from "./steps.js";

export const SLACK_BOT_SCOPES = ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "users:read"] as const;
export const SLACK_PROBE_TIMEOUT_MS = 7 * 60 * 1000;
const PROBE_POLL_MS = 15_000;

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export function slackBotDisplayName(appName: string): string {
  const name = appName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return name === "" ? "agentx" : name;
}

export function slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string }): SlackManifest {
  return {
    display_information: { name: input.appName, description: "AgentX: ask in Slack, and AgentX works in your repositories and trackers." },
    features: { bot_user: { display_name: slackBotDisplayName(input.appName), always_online: true } },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: input.eventsUrl, bot_events: ["app_mention"] },
      interactivity: { is_enabled: true, request_url: input.interactivityUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackCreateAppUrl(manifest: SlackManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function slackSecretName(env: string): string {
  return `agentx/${env}/slack`;
}

export function signSlackRequest(input: { signingSecret: string; body: string; timestampSeconds: number }): { "x-slack-request-timestamp": string; "x-slack-signature": string } {
  const timestamp = String(input.timestampSeconds);
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${input.body}`).digest("hex")}`,
  };
}

export async function probeSlackUrls(input: {
  eventsUrl: string; interactivityUrl: string; signingSecret: string; fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void>; write(line: string): void;
  timeoutMs?: number; pollMs?: number;
}): Promise<void> {
  const deadline = input.now() + (input.timeoutMs ?? SLACK_PROBE_TIMEOUT_MS);
  let told = false;
  const send = (url: string, body: string, contentType: string) => input.fetch(url, {
    method: "POST",
    headers: { "content-type": contentType, ...signSlackRequest({ signingSecret: input.signingSecret, body, timestampSeconds: Math.floor(input.now() / 1000) }) },
    body,
  });
  const retry = async (url: string) => {
    if (input.now() >= deadline) {
      throw agentXError("CONFIG_INVALID", `${url} still refuses requests signed with the new signing secret after ${Math.round((input.timeoutMs ?? SLACK_PROBE_TIMEOUT_MS) / 60_000)} minutes; check that you pasted the Signing Secret, not the Client Secret, then run agentx init again`);
    }
    if (!told) {
      input.write("Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)");
      told = true;
    }
    await input.sleep(input.pollMs ?? PROBE_POLL_MS);
  };

  const challenge = randomBytes(12).toString("hex");
  const eventsBody = JSON.stringify({ type: "url_verification", token: "agentx-init-probe", challenge });
  for (;;) {
    const response = await send(input.eventsUrl, eventsBody, "application/json");
    if (response.status === 200) {
      const echoed = ((await response.json()) as { challenge?: unknown }).challenge;
      if (echoed !== challenge) throw agentXError("RUNTIME_UNAVAILABLE", `${input.eventsUrl} answered without echoing Slack's challenge; check the control plane's SlackIngress logs`);
      break;
    }
    if (response.status !== 401) throw agentXError("RUNTIME_UNAVAILABLE", `${input.eventsUrl} answered HTTP ${response.status}; check the control plane's SlackIngress logs`);
    await retry(input.eventsUrl);
  }
  const form = `payload=${encodeURIComponent(JSON.stringify({ type: "agentx_init_probe" }))}`;
  for (;;) {
    const response = await send(input.interactivityUrl, form, "application/x-www-form-urlencoded");
    if (response.status !== 401 && response.status < 500) return;
    if (response.status >= 500) throw agentXError("RUNTIME_UNAVAILABLE", `${input.interactivityUrl} answered HTTP ${response.status}; check the control plane's SlackIngress logs`);
    await retry(input.interactivityUrl);
  }
}

export interface SlackApi {
  authTest(token: string): Promise<{ ok: boolean; error?: string; user_id?: string; bot_id?: string; team_id?: string }>;
  botsInfo(token: string, botId: string): Promise<{ ok: boolean; error?: string; bot?: { app_id?: string } }>;
}

export function slackWebApi(fetchImplementation: typeof fetch): SlackApi {
  const call = async (method: string, token: string, query = ""): Promise<unknown> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}${query}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}`);
    return response.json();
  };
  return {
    authTest: async (token) => (await call("auth.test", token)) as Awaited<ReturnType<SlackApi["authTest"]>>,
    botsInfo: async (token, botId) => (await call("bots.info", token, `?bot=${encodeURIComponent(botId)}`)) as Awaited<ReturnType<SlackApi["botsInfo"]>>,
  };
}

async function controlPlaneSlackUrls(context: InitContext): Promise<{ eventsUrl: string; interactivityUrl: string }> {
  const stackName = environmentStackName(context.env, "control-plane");
  const outputs = await (await context.deployment()).deployer.outputs(stackName);
  const eventsUrl = outputs?.SlackEventsUrl;
  const interactivityUrl = outputs?.SlackInteractivityUrl;
  if (eventsUrl === undefined || interactivityUrl === undefined) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} reports no Slack URLs; the control-plane step must finish first`);
  }
  return { eventsUrl, interactivityUrl };
}

export function slackAppStep(api: SlackApi): InitStep<InitContext> {
  return {
    id: "slack-app",
    title: "Create the Slack app",
    async run(context, progress) {
      const { env } = context;
      const { appName } = context.answers.slack;
      const urls = await controlPlaneSlackUrls(context);
      const resuming = progress.current().steps["slack-app"]?.status === "waiting";
      if (resuming) {
        context.write(`Continuing with the Slack app "${appName}". Once an admin approves it, install it from its Install App page.`);
      } else {
        const url = slackCreateAppUrl(slackAppManifest({ appName, ...urls }));
        context.write(`Create the Slack app "${appName}" from AgentX's manifest: pick the workspace, press Next, then Create, then Install to Workspace. If your workspace needs an admin to approve new apps, choose Request to Install.`);
        context.write(`If no browser opens, open: ${url}`);
        if (context.openBrowser !== undefined) await context.openBrowser(url);
      }
      const installed = await context.prompter.choose("Is the Slack app installed in your workspace?", [
        { value: "installed", label: "Yes: I can copy its Bot User OAuth Token" },
        { value: "approval", label: "Not yet: a workspace admin must approve it first" },
      ] as const, { flag: "--slack-install", defaultValue: "installed" });
      if (installed === "approval") {
        return { status: "waiting", message: `Slack is waiting for a workspace admin to approve "${appName}". Once it is installed, run agentx init --env ${env} again; it continues here.` };
      }

      context.write("Copy the Bot User OAuth Token from OAuth & Permissions, and the Signing Secret from Basic Information, App Credentials.");
      const common = { processEnv: context.processEnv, prompter: context.prompter };
      const botToken = checkSlackBotToken(await secretFromSource({ ...common, what: "Slack bot token", flag: "--slack-bot-token", source: context.secretFlags.slackBotToken ?? {} }));
      const signingSecret = checkSlackSigningSecret(await secretFromSource({ ...common, what: "Slack signing secret", flag: "--slack-signing-secret", source: context.secretFlags.slackSigningSecret ?? {} }));

      const auth = await api.authTest(botToken);
      if (!auth.ok) throw agentXError("CONFIG_INVALID", `Slack refused the bot token (${auth.error ?? "no reason given"}); copy it again from OAuth & Permissions`);
      if (auth.bot_id === undefined || auth.user_id === undefined || auth.team_id === undefined) {
        throw agentXError("CONFIG_INVALID", "that token does not belong to a bot user; paste the Bot User OAuth Token (it starts with xoxb-)");
      }
      const earlier = progress.current().slack;
      if (earlier !== undefined && earlier.teamId !== auth.team_id) {
        throw agentXError("CONFIG_INVALID", `that token belongs to Slack workspace ${auth.team_id}, but this install uses ${earlier.teamId}; nothing was saved`);
      }
      const info = await api.botsInfo(botToken, auth.bot_id);
      const appId = info.bot?.app_id;
      if (!info.ok || appId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `Slack bots.info did not return the app id (${info.error ?? "no app_id"})`);

      await context.secrets.put(slackSecretName(env), JSON.stringify({ signingSecret, botToken }));
      await progress.update({ slack: { appId, teamId: auth.team_id, botUserId: auth.user_id } });
      return { status: "done", note: `Slack app ${appId} in workspace ${auth.team_id}` };
    },
  };
}

export async function verifySlackUrls(context: InitContext, progress: ProgressHandle): Promise<void> {
  const name = slackSecretName(context.env);
  const raw = await context.secrets.get(name);
  let signingSecret: string | undefined;
  try { signingSecret = (JSON.parse(raw ?? "") as { signingSecret?: string }).signingSecret; } catch { signingSecret = undefined; }
  if (signingSecret === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} holds no signing secret; run agentx init again to repeat the Slack app step`);
  const { eventsUrl, interactivityUrl } = await controlPlaneSlackUrls(context);
  await probeSlackUrls({ eventsUrl, interactivityUrl, signingSecret, fetch: context.fetch, now: context.now, sleep: context.sleep, write: context.write });
  const appId = progress.current().slack?.appId;
  const page = `https://api.slack.com/apps/${appId ?? ""}/event-subscriptions`;
  context.write(`AgentX now answers Slack's URL check. Open ${page}; if the Request URL is not marked Verified, press Retry.`);
  if (context.openBrowser !== undefined) await context.openBrowser(page);
  if (!(await context.prompter.confirm("Does Slack show the Request URL as Verified?", { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", `Slack has not verified ${eventsUrl}. On ${page}, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again`);
  }
}
```

The slack-service step may run again after a failure in this hook. That redeploys nothing, because
the change set is empty and "No changes" counts as success (15c2). Then it probes again.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-slack-app.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/slack-app.ts tests/support/init-fakes.ts tests/contract/init-slack-app.test.ts
git commit -m "feat(cli): Slack app from a manifest; token and signing secret checked and stored; URLs probed"
```

### Task 10: The release matching this CLI

**Files:**
- Create: `packages/cli/src/version.ts`
- Create: `packages/cli/src/init/release-fetch.ts`
- Modify: `packages/cli/src/main.ts` (use `CLI_VERSION` from `version.ts` instead of its own `__AGENTX_VERSION__` declaration)
- Test: `tests/contract/init-release-fetch.test.ts`; `tests/contract/release-pack-cli.test.ts` must still pass unchanged

**Interfaces:**
- Consumes: `CommandRunner`, `realCommandRunner` (15c2).
- Produces:

```ts
// version.ts
/** The release this CLI was packed from (pack-cli's esbuild define); undefined for a build from source. */
export const RELEASE_VERSION: string | undefined;
export const CLI_VERSION: string;   // RELEASE_VERSION ?? "0.1.0"

// release-fetch.ts
export const RELEASE_REPOSITORY = "PrepLabsAI/AgentX";
export function releaseAssetUrls(version: string): { tarball: string; manifest: string };
export function releaseCacheDir(home: string, version: string): string;   // <home>/.agentx/releases/<version>
/** Downloads the GitHub release's release.json and tarball, extracts it with tar, and checks the extracted release.json is byte-for-byte the published one. loadRelease then checks every file's checksum. */
export async function fetchRelease(input: { version: string | undefined; home: string; fetch: typeof fetch; runner: CommandRunner; write(line: string): void }): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-release-fetch.test.ts
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { fetchRelease, releaseAssetUrls, releaseCacheDir } from "../../packages/cli/src/init/release-fetch.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const runner = realCommandRunner({ write: () => undefined });
const MANIFEST = JSON.stringify({ schemaVersion: 1, version: "1.2.3" });

async function publishedRelease(manifest = MANIFEST): Promise<Buffer> {
  const source = await tmp("agentx-rel-src-");
  await mkdir(join(source, "templates", "us-east-1"), { recursive: true });
  await writeFile(join(source, "release.json"), manifest);
  await writeFile(join(source, "templates", "us-east-1", "access.template.json"), "{}");
  const out = join(await tmp("agentx-rel-tar-"), "agentx-1.2.3.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", source, "."]);
  return readFile(out);
}

function github(files: Record<string, Buffer | string>): typeof fetch & { requested: string[] } {
  const requested: string[] = [];
  const handler = async (url: string | URL | Request) => {
    requested.push(String(url));
    const body = files[String(url)];
    return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body, { status: 200 });
  };
  return Object.assign(handler as typeof fetch, { requested });
}

describe("fetching the release for this CLI", () => {
  it("names the GitHub release assets", () => {
    expect(releaseAssetUrls("1.2.3")).toEqual({
      tarball: "https://github.com/PrepLabsAI/AgentX/releases/download/v1.2.3/agentx-1.2.3.tar.gz",
      manifest: "https://github.com/PrepLabsAI/AgentX/releases/download/v1.2.3/release.json",
    });
  });

  it("downloads and extracts the release into the per-version cache", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const dir = await fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() }), runner, write: () => undefined });
    expect(dir).toBe(releaseCacheDir(home, "1.2.3"));
    expect(await readFile(join(dir, "release.json"), "utf8")).toBe(MANIFEST);
    expect(await readdir(join(dir, "templates", "us-east-1"))).toEqual(["access.template.json"]);
  });

  it("reuses a cached release whose release.json matches, without downloading the tarball again", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const files = { [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() };
    await fetchRelease({ version: "1.2.3", home, fetch: github(files), runner, write: () => undefined });
    const second = github(files);
    await fetchRelease({ version: "1.2.3", home, fetch: second, runner, write: () => undefined });
    expect(second.requested).toEqual([urls.manifest]);
  });

  it("refuses a tarball whose release.json is not the published one, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease("{\"tampered\":true}") }), runner, write: () => undefined }))
      .rejects.toThrow("the downloaded release 1.2.3 does not match its published release.json; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("names the address when the release is not published", async () => {
    await expect(fetchRelease({ version: "9.9.9", home: await tmp("agentx-home-"), fetch: github({}), runner, write: () => undefined }))
      .rejects.toThrow("release 9.9.9 was not found at https://github.com/PrepLabsAI/AgentX/releases/download/v9.9.9/release.json; check the version is published, or pass --release <dir>");
  });

  it("asks a CLI built from source to pass --release", async () => {
    await expect(fetchRelease({ version: undefined, home: await tmp("agentx-home-"), fetch: github({}), runner, write: () => undefined }))
      .rejects.toThrow("this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one)");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-release-fetch.test.ts`
Expected: FAIL, "Cannot find module .../init/release-fetch.js".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/version.ts
// The release version pack-cli bakes in with esbuild's define. A plain tsc build from source has
// no define; typeof on an undeclared identifier never throws, so it falls through to undefined.
declare const __AGENTX_VERSION__: string | undefined;

export const RELEASE_VERSION: string | undefined = typeof __AGENTX_VERSION__ === "string" ? __AGENTX_VERSION__ : undefined;
export const CLI_VERSION = RELEASE_VERSION ?? "0.1.0";
```

In `main.ts`, remove the `declare const __AGENTX_VERSION__` block and its comment, import
`CLI_VERSION` from `./version.js`, and use `.version(CLI_VERSION)`.

```ts
// packages/cli/src/init/release-fetch.ts
// `npx @charterarc/agentx init` needs the release matching the CLI: the GitHub release's
// release.json and tarball. The extracted release.json must equal the published one byte for byte;
// loadRelease then checks every file's sha256 against it.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentXError } from "@agentx/contracts";
import type { CommandRunner } from "../deploy/cdk-engine.js";

export const RELEASE_REPOSITORY = "PrepLabsAI/AgentX";

export function releaseAssetUrls(version: string): { tarball: string; manifest: string } {
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  return { tarball: `${base}/agentx-${version}.tar.gz`, manifest: `${base}/release.json` };
}

export function releaseCacheDir(home: string, version: string): string {
  return join(home, ".agentx", "releases", version);
}

async function download(fetchImplementation: typeof fetch, url: string, version: string): Promise<Buffer> {
  const response = await fetchImplementation(url);
  if (response.status === 404) throw agentXError("CONFIG_INVALID", `release ${version} was not found at ${url}; check the version is published, or pass --release <dir>`);
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `downloading ${url} failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchRelease(input: { version: string | undefined; home: string; fetch: typeof fetch; runner: CommandRunner; write(line: string): void }): Promise<string> {
  const { version } = input;
  if (version === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one)");
  }
  const urls = releaseAssetUrls(version);
  const published = await download(input.fetch, urls.manifest, version);
  const dir = releaseCacheDir(input.home, version);
  const cached = await readFile(join(dir, "release.json")).catch(() => undefined);
  if (cached !== undefined && cached.equals(published)) return dir;

  input.write(`Downloading AgentX release ${version} from GitHub`);
  const tarball = await download(input.fetch, urls.tarball, version);
  await mkdir(dirname(dir), { recursive: true });
  const scratch = await mkdtemp(join(dirname(dir), `.${version}.`));
  try {
    const archive = join(scratch, `agentx-${version}.tar.gz`);
    const extracted = join(scratch, "release");
    await writeFile(archive, tarball);
    await mkdir(extracted);
    await input.runner.run("tar", ["-xzf", archive, "-C", extracted], { cwd: scratch, display: `tar -xzf agentx-${version}.tar.gz` });
    const inside = await readFile(join(extracted, "release.json")).catch(() => undefined);
    if (inside === undefined || !inside.equals(published)) {
      throw agentXError("CONFIG_INVALID", `the downloaded release ${version} does not match its published release.json; try again later, or pass --release <dir>`);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(extracted, dir);
    return dir;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-release-fetch.test.ts tests/contract/release-pack-cli.test.ts tests/contract/cli-main.test.ts`
Expected: PASS. The packed CLI still reports its release version.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/version.ts packages/cli/src/init/release-fetch.ts packages/cli/src/main.ts tests/contract/init-release-fetch.test.ts
git commit -m "feat(cli): init fetches the release matching the CLI and checks it against release.json"
```

### Task 11: The `agentx init` command

**Files:**
- Create: `packages/cli/src/init/commands.ts`
- Modify: `packages/cli/src/main.ts` (the `init` command's options and action; `CliDependencies.init`)
- Modify: `tests/contract/deploy-cli.test.ts`: the test "init without --export explains how to proceed and exits non-zero" becomes "init from a source build without --release says to pass --release". Change it deliberately, and leave every other `init --export` test unchanged.
- Test: `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: every earlier task:
  - `collectInitAnswers`, `persistInitAnswers`, `assertResumeFlagsMatch`, `InitFlags`;
  - `checkPrerequisites`, `awsPrerequisiteChecks`;
  - `confirmInstallPlan`;
  - `runInitSteps`, `InitEvent`;
  - `deployStep`;
  - `githubAppStep`, `githubRestApi`;
  - `slackAppStep`, `verifySlackUrls`, `slackWebApi`;
  - `fetchRelease`, `RELEASE_VERSION`;
  - `prepareDeployment`, `cliErrorFor`, `realCommandRunner`.
- Produces:

```ts
export interface InitCliDependencies {
  /** identity, store, deployer, templatesClients, commandRunner: the same seam agentx deploy uses. */
  deploy?: DeployCliDependencies;
  initSecrets?: InitSecrets;
  prompter?: Prompter;
  checks?: PrerequisiteChecks;
  github?: GitHubApi;
  slack?: SlackApi;
  stackStatus?: StackStatusReader;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  processEnv?: NodeJS.ProcessEnv;
  /** Overrides RELEASE_VERSION; null means a build from source. */
  releaseVersion?: string | null;
}
export interface InitOptions {
  env: string;
  region?: string;
  releaseDir?: string;
  source?: string;
  yes: boolean;
  browser: boolean;
  resume: boolean;
  flags: InitFlags;
  secretFlags: SecretFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  /** --slack-install: answers the Slack step's "is it installed?" question (for --yes). */
  slackInstall?: "installed" | "approval";
}
export type InitResult = InitRunResult & { env: string; resumed: boolean; controlPlaneUrl?: string; nextSteps?: string };
export function initSteps(input: { github: GitHubApi; slack: SlackApi }): InitStep<InitContext>[];
export function nextStepsText(settings: EnvironmentSettings): string;
export async function runInit(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult>;
```

- `agentx init` options, in addition to today's `--export`, `--region`, `--account`, `--release`,
  identity, OIDC, model, boundary and operator-principal flags:
  - `--engine templates|cdk`, `--source <dir>`;
  - `--resume`, `--yes`, `--no-browser`;
  - `--alert-email <address>`, `--alert-webhook-file <path>`, `--alert-webhook-env <NAME>`, `--no-alerts`;
  - `--github-account <login>`, `--github-account-type organization|user`, `--github-app-name <name>`;
  - `--github-app-id <id>`, `--github-installation-id <id>`, `--github-private-key-file <path>`,
    `--github-private-key-env <NAME>`;
  - `--slack-app-name <name>`, `--slack-app-posted-messages accept|ignore`,
    `--slack-install installed|approval`;
  - `--slack-bot-token-file|-env`, `--slack-signing-secret-file|-env`;
  - `--worker-image <digest-ref>`, `--slack-image <digest-ref>` (testing only, until a published
    release carries images).

  `--slack-install` exists so `--yes` can answer the Slack question. The unattended default is
  `installed`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-cli.test.ts
// agentx init end to end through executeCli, with every AWS, GitHub, Slack, browser and clock
// dependency injected. Nothing here reaches AWS, GitHub or Slack; the GitHub manifest listener is
// real, on 127.0.0.1.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { readEnvironmentSettings, settingsParameterName } from "../../packages/cli/src/environments/settings.js";
import { INIT_STEP_IDS, installProgressParameterName, readInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { initSteps, type InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, fakeSlackApi, HOLDER, memoryInitSecrets, passingChecks, scriptedDeployer, scriptedPrompter,
  slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function releaseDir(): Promise<string> {
  const dir = await tmp("agentx-init-release-");
  await mkdir(join(dir, "templates", "us-east-1"), { recursive: true });
  const templates = [];
  for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
    const file = `templates/us-east-1/${part}.template.json`;
    await writeFile(join(dir, file), "{}");
    templates.push({ region: "us-east-1", part, file, sha256: sha256("{}") });
  }
  await writeFile(join(dir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [],
    images: { worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`, slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}` },
  }));
  return dir;
}

async function harness() {
  let clock = T0;
  const store = new MemoryParameterStore();
  // The control plane creates agentx/<env>/slack with a placeholder; the fake deployer does not, so it exists up front.
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: "unset", signingSecret: "placeholder" }) });
  const deployer = scriptedDeployer(allStackOutputs());
  const github = fakeGitHubApi();
  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const home = await tmp("agentx-init-home-");
  const release = await releaseDir();
  const deps: InitCliDependencies = {
    deploy: { identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) }, store, secrets, deployer },
    initSecrets: secrets,
    checks: passingChecks(),
    github,
    slack: fakeSlackApi(),
    stackStatus: { status: async () => undefined },
    fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }),
    openBrowser: browserThatCreatesGitHubApp(opened),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    processEnv: {},
  };
  const run = (argv: string[], overrides: Partial<InitCliDependencies> = {}) =>
    executeCli(["--env", "staging", "init", "--region", "us-east-1", "--release", release, ...argv], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      environments: { home },
      init: { ...deps, ...overrides },
    });
  return { store, secrets, deployer, github, opened, out, err, home, release, run, printed: () => `${out.join("")}${err.join("")}` };
}

// The questions a first run asks with every default taken (Task 4's order), then the plan.
const FIRST_RUN = ["", "", "", "", "", "", "", "", "ops@example.com", "acme", "", "", "", "", true];
const SLACK = ["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true];

describe("agentx init", () => {
  it("lists its steps in the recorded order", () => {
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => step.id)).toEqual([...INIT_STEP_IDS]);
  });

  it("a first run asks, checks, shows the plan, deploys every stack, creates both apps, and writes settings and the local cache", async () => {
    const h = await harness();
    const prompter = scriptedPrompter([...FIRST_RUN, ...SLACK]);
    expect(await h.run([], { prompter })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    const progress = await readInstallProgress(h.store, "staging");
    expect(INIT_STEP_IDS.every((id) => progress?.steps[id]?.status === "done")).toBe(true);
    expect((await readEnvironmentSettings(h.store, "staging"))?.engine).toBe("templates");
    await expect(stat(environmentCachePath(h.home, "staging"))).resolves.toBeDefined();
    const printed = h.printed();
    expect(printed).toContain("Estimated monthly total");
    expect(printed).toContain("AgentX environment staging is deployed. Control plane: https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(printed).toContain("agentx login --env staging");
    for (const secret of [TEST_PRIVATE_KEY.split("\n")[1]!, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, h.secrets.values.get("agentx/staging/callback-signing-key")!]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("resumes at the step that failed and never creates a second GitHub App", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    expect(h.printed()).toContain('init stopped at "Deploy the control plane and runtime": Resource limit exceeded. Run agentx init again to continue from this step.');
    h.deployer.fail.clear();
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter(SLACK) })).toBe(0);
    expect(h.github.conversions).toHaveLength(1);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["control-plane", "runtime", "slack"]);
  });

  it("changes nothing when run again after it finished", async () => {
    const h = await harness();
    await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK]) });
    const before = h.store.values.get(installProgressParameterName("staging"));
    const settingsBefore = h.store.values.get(settingsParameterName("staging"));
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter([]) })).toBe(0);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.get(installProgressParameterName("staging"))).toBe(before);
    expect(h.store.values.get(settingsParameterName("staging"))).toBe(settingsBefore);
    expect(h.printed()).toContain("already done: Deploy the Slack service");
  });

  it("stops before creating anything when a model cannot be used", async () => {
    const h = await harness();
    const denied = Object.assign(new Error("Model use case details have not been submitted for this account."), { name: "AccessDeniedException" });
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN.slice(0, -1)), checks: passingChecks({ converse: async () => { throw denied; } }) })).toBe(2);
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
    expect(h.deployer.requests).toEqual([]);
  });

  it("waits for a Slack admin's approval, exits 0, and continues on the next run", async () => {
    const h = await harness();
    expect(await h.run(["--json"], { prompter: scriptedPrompter([...FIRST_RUN, "approval"]) })).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { status: "waiting", step: "slack-app" } });
    expect(await h.run([], { prompter: scriptedPrompter(SLACK) })).toBe(0);
    expect((await readInstallProgress(h.store, "staging"))?.steps["slack-service"]?.status).toBe("done");
  });

  it("refuses to resume with a different answer", async () => {
    const h = await harness();
    await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, "approval"]) });
    expect(await h.run(["--orchestrator-model", "zai.glm-4.7"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("--orchestrator-model zai.glm-4.7 differs from what this install started with");
  });

  it("refuses the deployment adopted with fixed stack names, and an environment installed without init", async () => {
    const legacy = await harness();
    await legacy.store.put(settingsParameterName("staging"), JSON.stringify({ ...stagingSettings, naming: "legacy" }));
    expect(await legacy.run([], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(legacy.printed()).toContain("environment staging is the deployment adopted with fixed stack names; agentx init cannot install over it");

    const deployed = await harness();
    await deployed.store.put(settingsParameterName("staging"), JSON.stringify(stagingSettings));
    expect(await deployed.run([], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(deployed.printed()).toContain("environment staging is already installed, but not by agentx init");
  });

  it("with --resume and nothing to resume, says how to start", async () => {
    const h = await harness();
    expect(await h.run(["--resume"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("there is no install of environment staging to resume in account 123456789012 (us-east-1); run agentx init without --resume to start one");
  });

  it("runs with no prompts at all under --yes and flags, with a GitHub App made beforehand", async () => {
    const h = await harness();
    const code = await h.run(
      ["--yes", "--no-browser", "--alert-email", "ops@example.com", "--github-account", "acme", "--github-app-id", "424242", "--github-installation-id", "777",
        "--github-private-key-env", "GH_KEY", "--slack-bot-token-env", "BOT", "--slack-signing-secret-env", "SIGNING"],
      { processEnv: { GH_KEY: TEST_PRIVATE_KEY, BOT: TEST_BOT_TOKEN, SIGNING: TEST_SIGNING_SECRET } },
    );
    expect(code).toBe(0);
    expect(h.github.conversions).toEqual([]);
    expect(h.opened).toEqual([]);
    expect((await readInstallProgress(h.store, "staging"))?.github?.installationId).toBe("777");
  });

  it("refuses --github-app-id without the installation and key flags", async () => {
    const h = await harness();
    expect(await h.run(["--github-app-id", "424242"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("--github-app-id, --github-installation-id and --github-private-key-file (or --github-private-key-env) go together");
  });

  it("without --release, a CLI built from source says to pass --release", async () => {
    const out: string[] = [];
    const code = await executeCli(["--env", "staging", "init", "--region", "us-east-1"], { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => out.push(t) }, init: { releaseVersion: null } });
    expect(code).toBe(2);
    expect(out.join("")).toContain("pass --release <dir>");
  });
});
```

In `tests/contract/deploy-cli.test.ts`, replace the body of "init without --export explains how to
proceed and exits non-zero" and rename the test:

```ts
  it("init from a source build without --release says to pass --release, before touching AWS", async () => {
    const io = capture();
    const code = await executeCli(["--env", ENV, "init", "--region", REGION], { ...io, deploy: safeDeployDeps() });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("this agentx was built from source and has no published release to download; pass --release <dir>");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-cli.test.ts tests/contract/deploy-cli.test.ts`
Expected: FAIL. `init/commands.ts` is missing, and `init` without `--export` still prints the old
message.

- [ ] **Step 3: Implement `init/commands.ts`**

```ts
// packages/cli/src/init/commands.ts
// agentx init (FR-015 to FR-020): find the release and region, read any install already under way,
// ask and check and confirm on a first run, then run the steps. Every AWS, GitHub, Slack, browser
// and clock dependency is overridable through InitCliDependencies (main.ts's CliDependencies.init).
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { agentXError } from "@agentx/contracts";
import { openSystemBrowser } from "../auth.js";
import { cliErrorFor, prepareDeployment, realCommandRunner, type DeployCliDependencies, type PreparedDeployment, type Writer } from "../deploy/commands.js";
import { loadRelease } from "../deploy/release.js";
import { stsCallerIdentity } from "../environments/adopt.js";
import { ssmParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { RELEASE_VERSION } from "../version.js";
import { assertResumeFlagsMatch, collectInitAnswers, persistInitAnswers, type InitFlags } from "./answers.js";
import { cloudFormationStatusReader, secretsManagerInitSecrets, type InitContext, type InitSecrets, type PreMadeGitHubApp, type SecretFlags, type StackStatusReader } from "./context.js";
import { deployStep } from "./deploy-steps.js";
import { githubAppStep, githubRestApi, type GitHubApi } from "./github-app.js";
import { readInstallAnswers, type InitAnswers } from "./install-state.js";
import { confirmInstallPlan } from "./plan.js";
import { awsPrerequisiteChecks, checkPrerequisites, type PrerequisiteChecks } from "./prerequisites.js";
import { processPrompter, unattendedPrompter, type Prompter } from "./prompts.js";
import { fetchRelease } from "./release-fetch.js";
import { slackAppStep, slackWebApi, verifySlackUrls, type SlackApi } from "./slack-app.js";
import { runInitSteps, type InitEvent, type InitRunResult, type InitStep } from "./steps.js";

export interface InitCliDependencies {
  deploy?: DeployCliDependencies;
  initSecrets?: InitSecrets;
  prompter?: Prompter;
  checks?: PrerequisiteChecks;
  github?: GitHubApi;
  slack?: SlackApi;
  stackStatus?: StackStatusReader;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  processEnv?: NodeJS.ProcessEnv;
  releaseVersion?: string | null;
}

export interface InitOptions {
  env: string;
  region?: string;
  releaseDir?: string;
  source?: string;
  yes: boolean;
  browser: boolean;
  resume: boolean;
  flags: InitFlags;
  secretFlags: SecretFlags;
  preMadeGitHubApp?: PreMadeGitHubApp;
  slackInstall?: "installed" | "approval";
}

export type InitResult = InitRunResult & { env: string; resumed: boolean; controlPlaneUrl?: string; nextSteps?: string };

export function initSteps(input: { github: GitHubApi; slack: SlackApi }): InitStep<InitContext>[] {
  return [
    {
      id: "prerequisites",
      title: "Check prerequisites",
      async run(context) {
        if (!context.prerequisitesPassed) await context.runPrerequisites();
        return { status: "done" };
      },
    },
    deployStep({ id: "access", title: "Deploy the access stack (IAM roles, artifact bucket, image cache)" }),
    deployStep({ id: "core", title: "Deploy the foundation and identity stacks" }),
    githubAppStep(input.github),
    deployStep({ id: "control-plane", title: "Deploy the control plane and runtime" }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: "Deploy the Slack service", after: verifySlackUrls }),
  ];
}

function eventLine(event: InitEvent): string {
  switch (event.kind) {
    case "step-skipped": return `already done: ${event.title}`;
    case "step-started": return `==> ${event.title}`;
    case "step-done": return `done: ${event.title}`;
    case "step-waiting": return `waiting: ${event.title}`;
  }
}

export function nextStepsText(settings: EnvironmentSettings): string {
  const { env, region } = settings;
  const admin = settings.identity.mode === "cognito"
    ? (() => {
      const pool = settings.identity.issuer.split("/").at(-1) ?? "<user pool id>";
      return [
        `  1. Create your admin user: aws cognito-idp admin-create-user --user-pool-id ${pool} --username <your email> --region ${region}`,
        `     then: aws cognito-idp admin-add-user-to-group --user-pool-id ${pool} --username <your email> --group-name agentx-admin --region ${region}`,
      ];
    })()
    : ["  1. Make sure your own OIDC provider marks you as an AgentX administrator."];
  return [
    "Next, until agentx init does these too (a later AgentX release):",
    ...admin,
    `  2. agentx login --env ${env}`,
    `  3. agentx admin project register and agentx admin slack bind, as in docs/architecture-production.md`,
  ].join("\n");
}

const realSleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

export async function runInit(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  try {
    return await init(options, deps, services);
  } catch (error) {
    throw cliErrorFor(error);
  }
}

async function init(options: InitOptions, deps: InitCliDependencies, services: { stderr: Writer; home: string }): Promise<InitResult> {
  const { env } = options;
  const write = (line: string) => { services.stderr.write(`${line}\n`); };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const fetchImplementation = deps.fetch ?? fetch;
  const processEnv = deps.processEnv ?? process.env;
  const deployDeps = deps.deploy ?? {};
  const runner = deployDeps.commandRunner ?? realCommandRunner(services.stderr);

  // The release comes first: a CLI built from source is told to pass --release before anything else.
  const version = deps.releaseVersion === undefined ? RELEASE_VERSION : deps.releaseVersion ?? undefined;
  const releaseDir = options.releaseDir ?? (await fetchRelease({ version, home: services.home, fetch: fetchImplementation, runner, write }));
  const release = await loadRelease(releaseDir);

  let prompter = deps.prompter;
  if (prompter === undefined) {
    if (options.yes) prompter = unattendedPrompter();
    else if (process.stdin.isTTY !== true) throw agentXError("CONFIG_INVALID", "agentx init asks questions; run it in a terminal, or pass --yes with a flag for every answer");
    else prompter = processPrompter(services.stderr);
  }
  if (options.slackInstall !== undefined) {
    const answer = options.slackInstall;
    const inner = prompter;
    prompter = {
      ...inner,
      async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, promptOptions: { flag: string; defaultValue: T }): Promise<T> {
        return promptOptions.flag === "--slack-install" ? (answer as T) : inner.choose(question, choices, promptOptions);
      },
    };
  }
  const regions = release.regions();
  const region = options.region ?? (await prompter.choose("AWS region", regions.map((value) => ({ value, label: value })), { flag: "--region", defaultValue: regions[0] ?? "us-east-1" }));
  if (!regions.includes(region)) {
    throw agentXError("CONFIG_INVALID", `release ${release.manifest.version} does not cover region ${region}; it covers: ${regions.join(", ") || "no region"}`);
  }
  if (options.flags.engine === "cdk" && options.source === undefined) throw agentXError("CONFIG_INVALID", `the cdk engine needs --source <a checkout of tag v${release.manifest.version}>`);

  const store = deployDeps.store ?? ssmParameterStore(new SSMClient({ region }));
  const secrets = deps.initSecrets ?? secretsManagerInitSecrets(new SecretsManagerClient({ region }));
  const caller = await (deployDeps.identity ?? stsCallerIdentity(new STSClient({ region }))).get();
  const checks = deps.checks ?? awsPrerequisiteChecks({ region, account: caller.account, store, runner, fetch: fetchImplementation });

  const existingSettings = await readEnvironmentSettings(store, env);
  const stored = await readInstallAnswers(store, env);
  if (stored === undefined && existingSettings !== undefined) {
    throw agentXError("CONFIG_INVALID", existingSettings.naming === "legacy"
      ? `environment ${env} is the deployment adopted with fixed stack names; agentx init cannot install over it. Choose another --env`
      : `environment ${env} is already installed, but not by agentx init; there is nothing to resume. Choose another --env, or use agentx deploy --mode upgrade`);
  }
  if (options.resume && stored === undefined) {
    throw agentXError("CONFIG_INVALID", `there is no install of environment ${env} to resume in account ${caller.account} (${region}); run agentx init without --resume to start one`);
  }

  let answers: InitAnswers;
  let prerequisitesPassed = false;
  if (stored === undefined) {
    const collected = await collectInitAnswers({ env, region, account: caller.account, releaseVersion: release.manifest.version, flags: options.flags, prompter, processEnv, now });
    if (collected.answers.engine === "cdk" && options.source === undefined) throw agentXError("CONFIG_INVALID", `the cdk engine needs --source <a checkout of tag v${release.manifest.version}>`);
    await checkPrerequisites({ answers: collected.answers, releaseRegions: regions, caller, checks, prompter, write });
    prerequisitesPassed = true;
    await confirmInstallPlan({ answers: collected.answers, notes: collected.notes, prompter, write: (text) => { services.stderr.write(text); } });
    await persistInitAnswers({ store, secrets, collected });
    answers = collected.answers;
  } else {
    answers = stored;
    if (answers.account !== caller.account) throw agentXError("CONFIG_INVALID", `the install of ${env} started in account ${answers.account}, but your AWS credentials are for account ${caller.account}`);
    if (answers.releaseVersion !== release.manifest.version) {
      throw agentXError("CONFIG_INVALID", `the install of ${env} started with release ${answers.releaseVersion}, but this agentx has release ${release.manifest.version}; run npx @charterarc/agentx@${answers.releaseVersion} init --env ${env}, or pass --release <dir> for ${answers.releaseVersion}`);
    }
    if (answers.engine === "cdk" && options.source === undefined) throw agentXError("CONFIG_INVALID", `the cdk engine needs --source <a checkout of tag v${answers.releaseVersion}>`);
    assertResumeFlagsMatch(answers, options.flags);
    write(`Resuming the install of environment ${env}.`);
  }

  const finalAnswers = answers;
  const activePrompter = prompter;
  let prepared: PreparedDeployment | undefined;
  const context: InitContext = {
    env,
    answers: finalAnswers,
    release,
    holder: caller.arn,
    store,
    secrets,
    prompter: activePrompter,
    write,
    ...(options.browser ? { openBrowser: deps.openBrowser ?? openSystemBrowser } : {}),
    now,
    sleep,
    fetch: fetchImplementation,
    processEnv,
    secretFlags: options.secretFlags,
    ...(options.preMadeGitHubApp === undefined ? {} : { preMadeGitHubApp: options.preMadeGitHubApp }),
    deployment: async () => {
      prepared ??= await prepareDeployment({
        engine: finalAnswers.engine, env, region, account: finalAnswers.account, identityMode: finalAnswers.identity.mode, release,
        ...(options.source === undefined ? {} : { source: options.source }),
        deps: { ...deployDeps, store, secrets, identity: { get: async () => caller } },
        stderr: services.stderr,
      });
      return prepared;
    },
    stackStatus: deps.stackStatus ?? cloudFormationStatusReader(new CloudFormationClient({ region })),
    home: services.home,
    prerequisitesPassed,
    runPrerequisites: () => checkPrerequisites({ answers: finalAnswers, releaseRegions: regions, caller, checks, prompter: activePrompter, write }),
  };

  try {
    const result = await runInitSteps({
      env, store, holder: caller.arn, context, now,
      steps: initSteps({ github: deps.github ?? githubRestApi(fetchImplementation), slack: deps.slack ?? slackWebApi(fetchImplementation) }),
      onEvent: (event) => write(eventLine(event)),
      ...(options.yes ? {} : {
        confirmTakeover: (held: { acquiredAt: string }) => activePrompter.confirm(`Environment ${env} is locked by your own earlier agentx init since ${held.acquiredAt}. Take the lock over? Say yes only if that run is no longer going.`, { defaultValue: false }),
      }),
    });
    const settings = await readEnvironmentSettings(store, env);
    return {
      ...result, env, resumed: stored !== undefined,
      ...(settings === undefined ? {} : { controlPlaneUrl: settings.controlPlaneUrl, nextSteps: nextStepsText(settings) }),
    };
  } finally {
    await prepared?.cleanup();
  }
}
```

- [ ] **Step 4: Wire `init` in `main.ts`**

- Add `init?: InitCliDependencies` to `CliDependencies`.
- Add the options listed in Interfaces to the `init` command, and change its description to
  "install AgentX in this AWS account, step by step, resuming where it stopped; --export writes a
  bundle for a platform team instead".
- Keep the `--export` branch exactly as it is.
- Replace the `interactive install arrives...` throw with a call to `runInit`.

Build the flags from only what was typed:

```ts
      const typed = <T>(name: string, value: T): T | undefined => (command.getOptionValueSource(name) === "cli" ? value : undefined);
      const source = (file?: string, envName?: string) =>
        file === undefined && envName === undefined ? undefined : { ...(file === undefined ? {} : { file }), ...(envName === undefined ? {} : { envName }) };
      const flags: InitFlags = Object.fromEntries(Object.entries({
        engine: typed("engine", options.engine),
        identity: typed("identity", options.identity),
        oidcIssuer: options.oidcIssuer, oidcAudience: options.oidcAudience, oidcClientId: options.oidcClientId,
        adminClaim: options.adminClaim, adminValues: options.adminValues,
        orchestratorModel: typed("orchestratorModel", options.orchestratorModel),
        classifierModel: typed("classifierModel", options.classifierModel),
        workerModel: typed("workerModel", options.workerModel),
        permissionBoundary: options.permissionBoundary, operatorPrincipal: options.operatorPrincipal,
        alertEmail: options.alertEmail,
        alertWebhook: source(options.alertWebhookFile, options.alertWebhookEnv),
        alerts: typed("alerts", options.alerts),
        githubAccount: options.githubAccount, githubAccountType: options.githubAccountType, githubAppName: options.githubAppName,
        slackAppName: options.slackAppName, slackAppPostedMessages: options.slackAppPostedMessages,
        workerImage: options.workerImage, slackImage: options.slackImage,
      }).filter(([, value]) => value !== undefined)) as InitFlags;
      const preMadeGiven = [options.githubAppId, options.githubInstallationId].some((value) => value !== undefined);
      const keySource = source(options.githubPrivateKeyFile, options.githubPrivateKeyEnv);
      if (preMadeGiven && (options.githubAppId === undefined || options.githubInstallationId === undefined || keySource === undefined)) {
        throw agentXError("CONFIG_INVALID", "--github-app-id, --github-installation-id and --github-private-key-file (or --github-private-key-env) go together");
      }
      const result = await runInit({
        env: globals.env,
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.release === undefined ? {} : { releaseDir: options.release }),
        ...(options.source === undefined ? {} : { source: options.source }),
        yes: options.yes, browser: options.browser, resume: options.resume,
        flags,
        secretFlags: Object.fromEntries(Object.entries({
          slackBotToken: source(options.slackBotTokenFile, options.slackBotTokenEnv),
          slackSigningSecret: source(options.slackSigningSecretFile, options.slackSigningSecretEnv),
          githubPrivateKey: keySource,
        }).filter(([, value]) => value !== undefined)),
        ...(preMadeGiven ? { preMadeGitHubApp: { appId: options.githubAppId as string, installationId: options.githubInstallationId as string } } : {}),
        ...(options.slackInstall === undefined ? {} : { slackInstall: options.slackInstall }),
      }, dependencies.init ?? {}, { stderr: services.stderr, home });
```

Print the result:

```ts
      if (globals.json) {
        services.stdout.write(formatSuccess(result, true));
        return;
      }
      if (result.status === "waiting") {
        services.stdout.write(`${result.message}\n`);
        return;
      }
      services.stdout.write(`AgentX environment ${result.env} is deployed. Control plane: ${result.controlPlaneUrl ?? "unknown"}\n${result.nextSteps ?? ""}\n`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-cli.test.ts tests/contract/deploy-cli.test.ts tests/contract/cli-main.test.ts`
Expected: PASS. `cli-main.test.ts`'s root command list is unchanged (`init` already exists).

- [ ] **Step 6: Run the whole gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass, and the legacy template snapshots are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/commands.ts packages/cli/src/main.ts tests/contract/init-cli.test.ts tests/contract/deploy-cli.test.ts
git commit -m "feat(cli): agentx init runs from questions to a deployed Slack service, resuming where it stopped"
```

### Task 12: Documentation and the spec

**Files:**
- Modify: `docs/architecture-production.md` (a section "Installing with agentx init"; `docs/` is gitignored, so `git add -f`)
- Modify: `specs/015-installer/spec.md` (Decisions)

- [ ] **Step 1: Write the section, under 70 lines, in plain words**

Cover:
- `npx @charterarc/agentx init`, and what it needs: AWS admin credentials for the first run, a
  GitHub organization or account, and a Slack workspace where you can create apps.
- The steps, in order, and what the engineer does in each. For the GitHub App, one click on
  GitHub's page and then choosing repositories. For the Slack app: create, install, and paste two
  values into hidden prompts.
- That every answer has a flag, and that secrets are read only from hidden prompts, `--*-file` or
  `--*-env`.
- Resume: run `agentx init` again, and it continues at the first incomplete step. Include the
  Slack admin-approval wait, and what to do about a lock left by a closed terminal.
- `--no-browser`: the SSH tunnel for the GitHub page, and pasting the redirect address.
- Where state lives: `/agentx/<env>/install/*`, `/agentx/<env>/settings`, and the secrets.
- The cost estimate's stated usage, and that it is an estimate.
- The interim next steps (the admin user, login, project register, slack bind) until phase 15d2.

- [ ] **Step 2: Record the decisions in the spec**

Under the spec's Decisions, add these entries dated 2026-09-27. Mark them "phase 15d1 plan; the
owner confirms in the PR":
- **The init step order follows the deploy order.** The order is prerequisites, access,
  foundation and identity, the GitHub App, control plane and runtime, the Slack app, the Slack
  service. It then continues with the admin user, project, connectors, alerts and budget, and the
  end-to-end check. FR-018's numbered list names the same steps; this is the order they run in.
- **The GitHub App has no webhook and subscribes to no events.** AgentX handles no GitHub webhook.
  The manifest asks for contents, pull requests and issues (read and write) and metadata (read).
- **Slack URL verification** is a signed self-probe of both URLs, followed by the engineer
  confirming "Verified" on the app's Event Subscriptions page. Slack has no API for this without an
  app configuration token, and it does not verify interactivity URLs.
- **Install state lives beside settings:** `/agentx/<env>/install/answers` and
  `/agentx/<env>/install/progress`. Settings are still written only once the Slack stack exists.
- **Alert webhook addresses are secrets.** They are stored in `agentx/<env>/alert-endpoint`, and
  settings and output show only their host.

- [ ] **Step 3: Commit**

```bash
git add -f docs/architecture-production.md
git add specs/015-installer/spec.md
git commit -m "docs: installing with agentx init; decisions from phase 15d1"
```

### Task 13: Live install of a throwaway environment through the Slack service (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first,
then reviewed. This task needs:
- the owner's explicit go-ahead;
- an admin AWS session, because the access stack creates IAM roles;
- a GitHub organization or account and a Slack workspace the owner chooses for testing. It must
  never be production's GitHub App or Slack app.

It uses a new environment name, `live15d`, in account 944937319445, `us-east-1`. It never touches a
production stack, `/agentx/production/*`, production's GitHub App, or production's Slack app.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release with a plain version, so settings validate: `npm run release:build -- --version 0.0.2 --out <scratch>/rel`.
    It has no image digests, so the check uses the testing-only image flags.
  - Read production's current image digests from the stack parameters (read-only):
    - `aws cloudformation describe-stacks --stack-name AgentXProductionRuntime --query "Stacks[0].Parameters[?ParameterKey=='WorkerImageUri'].ParameterValue" --output text --region us-east-1`
    - the same for `AgentXSlackOrchestrator` and `OrchestratorImageUri`.
  - Confirm `/agentx/live15d/*` does not exist:
    `aws ssm get-parameters-by-path --path /agentx/live15d --recursive --region us-east-1`
    must return no parameters.

- [ ] **Step 2: Owner approval and an admin session**

Ask the owner to approve. Tell them:
- the six stacks it creates;
- the GitHub App and the Slack app it creates, in the test organization and workspace they named;
- the running cost while it exists: two NAT gateways, the Slack service task, and the capacity
  provider (about $3 a day, from Task 6's figures);
- that everything is torn down at the end.

Then ask for an admin session: CloudShell with the repository, or `aws login` to an admin profile
for this session only.

- [ ] **Step 3: Run `agentx init` interactively**

Run (built CLI):
`node packages/cli/dist/main.js --env live15d init --region us-east-1 --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`

Take the defaults, except:
- the alert address: the owner's email;
- the GitHub account: the owner's test organization or account;
- the Slack workspace: the test workspace.

Record each of the following:
- the prerequisite lines;
- the plan text and cost;
- every step's start and end time;
- every click or paste the engineer made (SC-002 counts at most 15);
- whether GitHub accepted the `127.0.0.1` redirect and the manifest without `hook_attributes`;
- whether Slack's create-from-manifest page accepted the `manifest_json` link;
- how long the Slack probe waited for the ingress's secret cache.

- [ ] **Step 4: Prove resume and "changes nothing"**
  - During the control-plane step, close the terminal. Run the same command again.
  - Expected:
    - it offers to take over your own lock;
    - it waits for any stack still in progress;
    - it continues at `control-plane`;
    - the GitHub App is not created twice.
  - After it finishes, run the command a third time. Expected: every step is "already done", and
    `aws ssm get-parameter --name /agentx/live15d/install/progress` shows the same version number as
    before the run.

- [ ] **Step 5: Verify**
  - `/agentx/live15d/settings` exists, with engine `templates` and version `0.0.2`.
  - `agentx-live15d-slack`'s service is running one task.
  - In the Slack app's Event Subscriptions page, the Request URL shows Verified.
  - `aws secretsmanager describe-secret --secret-id agentx/live15d/github-app` exists. Neither
    `~/.agentx/` nor the terminal log contains `BEGIN`, `xoxb-` or the signing secret. Check with
    `grep -r` over `~/.agentx` and the saved terminal log.
  - Optional, and only with the owner, as a preview of 15d2: create an admin user with the printed
    commands, `agentx login --env live15d`, register a test project and bind a test channel, then
    mention the bot.

- [ ] **Step 6: Tear down**

Give the owner these commands, run under the admin session:
1. Turn termination protection off on `agentx-live15d-access`, `-foundation`, `-identity` and
   `-runtime`:
   `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name <stack> --region us-east-1`.
2. Delete the stacks in reverse order, waiting for each: slack, runtime, control-plane, identity,
   foundation, access.
   `aws cloudformation delete-stack --stack-name <stack> --region us-east-1 && aws cloudformation wait stack-delete-complete --stack-name <stack> --region us-east-1`.
   The runtime is deleted with its stack (DeletionPolicy Delete).
3. Remove what the stacks retain, following the export bundle README's teardown section:
   - the capacity provider (`agentx_live15d_capacity...`): deleting it deletes every workspace
     volume;
   - the Cognito user pool: turn deletion protection off, then delete;
   - the buckets: empty every version and delete marker, then delete. That is the artifact bucket,
     the control plane's artifacts bucket and the thread-sessions bucket;
   - the DynamoDB tables;
   - the log groups;
   - the KMS key: schedule deletion, 7 days;
   - the default boundary policy, if left behind.
4. Force-delete the secrets `agentx/live15d/callback-signing-key`, `agentx/live15d/github-app`,
   `agentx/live15d/slack` and, if created, `agentx/live15d/alert-endpoint`:
   `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery --region us-east-1`.
5. Delete the parameters: `aws ssm delete-parameters --names /agentx/live15d/settings /agentx/live15d/install/answers /agentx/live15d/install/progress --region us-east-1`.
   If `/agentx/live15d/lock` exists, delete it.
6. Delete the GitHub App: its settings page, Advanced, Delete GitHub App.
7. Delete the Slack app: api.slack.com/apps, the app, Basic Information, Delete App.
8. Confirm: `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --region us-east-1`
   shows no `agentx-live15d-*` stack, and
   `aws ssm get-parameters-by-path --path /agentx/live15d --recursive` shows nothing.

- [ ] **Step 7: Record the evidence**

Record the commands, outcomes, timings, the click-and-paste count, and every defect fixed in the PR
description. Record anything that changes a decision above (for example, GitHub refusing a
`127.0.0.1` redirect) as a finding for the owner, before the PR is merged.

## Not in this phase

In phase 15d2 ([phase-15d2-init-finish.md](phase-15d2-init-finish.md)):
- the admin user and login, and the admin-claim check for your own OIDC provider;
- `agentx project add` and the first-project step; `agentx channel add`;
- `agentx connector add linear|jira|asana`;
- alerts (subscription, new alarms, `agentx alerts test`) and the budget;
- the end-to-end Slack reply;
- the operator-role policy additions that let `init --resume` finish under the operator role, and
  the export path's `init --resume`.

In phase 15e:
- `agentx upgrade`, `config`, `doctor` and `destroy`.
