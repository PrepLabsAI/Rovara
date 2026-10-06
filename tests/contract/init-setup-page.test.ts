// The install page in the cloud: the setup table both sides share (setup-store.ts), the job's relay
// (relay.ts), the page's handler (setup-handler.ts), and a whole install run through them with
// `agentx init --setup-table`. Nothing here reaches AWS, GitHub or Slack.
import { describe, expect, it } from "vitest";
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import { startHubRelay } from "../../packages/cli/src/init/ui/relay.js";
import { setupPageHandler, type SetupRequest } from "../../packages/cli/src/init/ui/setup-handler.js";
import { dynamoSetupStore, GITHUB_NONCE_PLACEHOLDER, memorySetupStore, SETUP_ITEM_TTL_SECONDS, SETUP_LOG_LINES, storableSnapshot } from "../../packages/cli/src/init/ui/setup-store.js";
import { cloudManifestHost } from "../../packages/cli/src/init/ui/index.js";
import { createWizardHub } from "../../packages/cli/src/init/ui/state.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY } from "../../packages/cli/src/init/ui/protocol.js";
import { FINISH, harness, SIGNIN } from "../support/init-ui-harness.js";
import { FAKE_SLACK_CLIENT, fakeSlackApi, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { accessToken, ADMIN_EMAIL } from "../support/setup-fakes.js";
import { SETUP_ORIGIN, setupPageOperator } from "../support/setup-page-operator.js";

const TOKEN = "setup-page-token-0123456789abcdef";
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("test setup: the condition never held");
};
const FAST = { stateWriteMs: 1, pollMs: 2 };
// A made-up token in Slack's format, put together here so no file holds one (push protection).
const CONFIG_TOKEN = ["xoxe", "xoxp-1-NOTAREALTOKENFORTESTS"].join(".");

/** A table in memory that answers the four commands the store sends, as DynamoDB would. */
function fakeDynamo() {
  const items = new Map<string, Record<string, unknown>>();
  const key = (item: { pk?: { S?: string }; sk?: { S?: string } }) => `${item.pk?.S}|${item.sk?.S}`;
  const sent: unknown[] = [];
  return {
    items, sent,
    async send(command: unknown): Promise<unknown> {
      sent.push(command);
      if (command instanceof PutItemCommand) { items.set(key(command.input.Item as never), command.input.Item as Record<string, unknown>); return {}; }
      if (command instanceof GetItemCommand) return { Item: items.get(key(command.input.Key as never)) };
      if (command instanceof DeleteItemCommand) {
        const id = key(command.input.Key as never);
        const old = items.get(id);
        items.delete(id);
        return { Attributes: old };
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as Record<string, { S: string }>;
        const found = [...items.values()].filter((item) => (item.pk as { S: string }).S === values[":pk"]!.S && (item.sk as { S: string }).S.startsWith(values[":answer"]!.S));
        return { Items: found.sort((a, b) => (a.sk as { S: string }).S.localeCompare((b.sk as { S: string }).S)) };
      }
      throw new Error(`test setup: the fake table cannot run ${String(command)}`);
    },
  };
}

describe("the setup table", () => {
  it("keeps answers until the job takes them, in the order they were posted, and each verdict and close request once", async () => {
    const dynamo = fakeDynamo();
    let clock = 1_790_000_000_000;
    const store = dynamoSetupStore({ client: dynamo, table: "setup", env: "staging", now: () => clock });
    const first = await store.putAnswer("q1", "secret-value");
    clock += 1;
    const second = await store.putAnswer("q2", "other");
    const answerItem = [...dynamo.items.values()].find((item) => (item.sk as { S: string }).S === `answer#${first}`)!;
    // An answer may be a secret: it expires within minutes even if no job ever reads it.
    expect((answerItem.expiresAt as { N: string }).N).toBe(String(Math.floor((clock - 1) / 1000) + SETUP_ITEM_TTL_SECONDS));
    expect(await store.takeAnswers()).toEqual([{ key: first, id: "q1", value: "secret-value" }, { key: second, id: "q2", value: "other" }]);
    expect(await store.takeAnswers()).toEqual([]);
    expect([...dynamo.items.keys()].some((id) => id.includes("answer#"))).toBe(false);

    await store.putVerdict(first, { ok: false, error: "must be an email address" });
    expect(await store.takeVerdict(first)).toEqual({ ok: false, error: "must be an email address" });
    expect(await store.takeVerdict(first)).toBeUndefined();
    expect(await store.takeClose()).toBe(false);
    await store.requestClose();
    expect(await store.takeClose()).toBe(true);
    expect(await store.takeClose()).toBe(false);
  });

  it("stores the page's state with its log cut to the last lines an item can hold, and whether the run is over", async () => {
    const dynamo = fakeDynamo();
    const store = dynamoSetupStore({ client: dynamo, table: "setup", env: "staging" });
    const hub = createWizardHub("staging");
    for (let line = 0; line < SETUP_LOG_LINES + 50; line += 1) hub.log(`line ${line}`);
    await store.putState(hub.snapshot(), false);
    const stored = await store.getState();
    expect(stored?.closed).toBe(false);
    expect(stored?.snapshot.log).toHaveLength(SETUP_LOG_LINES);
    expect(stored?.snapshot.log.at(-1)).toBe(`line ${SETUP_LOG_LINES + 49}`);
    expect(storableSnapshot(hub.snapshot())).toEqual(stored?.snapshot);
    expect(await dynamoSetupStore({ client: dynamo, table: "setup", env: "other" }).getState()).toBeUndefined();
  });
});

describe("the job's relay", () => {
  it("writes the hub's state, hands each posted answer to the hub, and replies with the hub's verdict", async () => {
    const hub = createWizardHub("staging");
    const store = memorySetupStore();
    const relay = startHubRelay({ hub, store, warn: () => undefined, ...FAST });
    const answer = hub.ask({ kind: "ask", text: "Your email" }, (raw) => (raw.includes("@") ? { value: raw } : { error: "must be an email address" }));
    await until(async () => (await store.getState())?.snapshot.question?.text === "Your email");
    const asked = (await store.getState())!.snapshot.question!;

    const refused = await store.putAnswer(asked.id, "not-an-email");
    await until(async () => (await store.getState())?.snapshot.question?.error === "must be an email address");
    expect(await store.takeVerdict(refused)).toEqual({ ok: false, error: "must be an email address" });

    const again = (await store.getState())!.snapshot.question!;
    const accepted = await store.putAnswer(again.id, "alice@example.com");
    expect(await answer).toBe("alice@example.com");
    await until(async () => (await store.takeVerdict(accepted)) !== undefined);
    // FR-012: the answer never reaches the stored state.
    expect(JSON.stringify(await store.getState())).not.toContain("alice@example.com");

    const stale = await store.putAnswer(again.id, "late@example.com");
    await until(async () => store.answers.size === 0);
    await until(async () => { const verdict = await store.takeVerdict(stale); return verdict !== undefined && !verdict.ok; });

    await store.requestClose();
    await hub.closeRequested();
    await relay.stop();
    expect((await store.getState())?.closed).toBe(true);
  });

  it("says once in the job's log when the table cannot be reached, and keeps going", async () => {
    const hub = createWizardHub("staging");
    const warned: string[] = [];
    const broken = { ...memorySetupStore(), putState: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
    const relay = startHubRelay({ hub, store: broken, warn: (line) => warned.push(line), ...FAST });
    hub.log("one");
    hub.log("two");
    await until(() => warned.length > 0);
    await relay.stop();
    expect(warned).toEqual(["the install page's table could not be written (AccessDeniedException); retrying"]);
  });
});

describe("the setup page's handler", () => {
  const request = (overrides: Partial<SetupRequest> = {}): SetupRequest => ({
    method: "GET", path: "/", query: { [WIZARD_TOKEN_QUERY]: TOKEN }, headers: { host: "setup.example.com", origin: SETUP_ORIGIN }, ...overrides,
  });

  it("refuses a request without the page's token or from another site", async () => {
    const handle = setupPageHandler({ store: memorySetupStore(), env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN } });
    expect((await handle(request({ query: {} }))).status).toBe(401);
    expect((await handle(request({ headers: { host: "evil.example.com" } }))).status).toBe(403);
    expect((await handle(request({ headers: { host: "setup.example.com", origin: "https://evil.example.com" } }))).status).toBe(403);
    expect((await handle(request({ method: "POST", path: "/answer", body: "{}" }))).status).toBe(401);
  });

  it("serves the same page, set to poll for its state, and a new install's state before the job writes any", async () => {
    const store = memorySetupStore();
    const handle = setupPageHandler({ store, env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN } });
    const page = await handle(request());
    expect(page.status).toBe(200);
    expect(page.body).toBe(wizardHtml(TOKEN, { poll: true }));
    expect(page.body).toContain("&poll=1");
    expect(wizardHtml(TOKEN)).not.toContain("poll=1");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");

    const before = JSON.parse((await handle(request({ path: "/state" }))).body) as { installerClosed: boolean; phases?: unknown };
    expect(before).toMatchObject({ ...createWizardHub("staging").snapshot(), installerClosed: false });
    const hub = createWizardHub("staging");
    hub.log("deploying agentx-staging-access");
    await store.putState(hub.snapshot(), true);
    expect(JSON.parse((await handle(request({ path: "/state" }))).body)).toMatchObject({ log: ["deploying agentx-staging-access"], installerClosed: true });
  });

  it("replies to an answer with the job's verdict, or that it was sent when the job has not read it in time", async () => {
    const store = memorySetupStore();
    let clock = 0;
    const handle = setupPageHandler({ store, env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN }, verdictWaitMs: 1_000, now: () => clock, sleep: async (ms) => {
      clock += ms;
      // The job reads the first answer while the page waits, and never the second.
      for (const [key, answer] of store.answers) {
        if (answer.value !== "judged") continue;
        store.answers.delete(key);
        await store.putVerdict(key, { ok: false, error: "that question is out of date" });
      }
    } });
    const post = (body: string) => handle(request({ method: "POST", path: "/answer", query: {}, headers: { host: "setup.example.com", origin: SETUP_ORIGIN, [WIZARD_TOKEN_HEADER]: TOKEN }, body }));
    expect(JSON.parse((await post(JSON.stringify({ id: "q1", value: "judged" }))).body)).toEqual({ ok: false, error: "that question is out of date" });
    const unread = await post(JSON.stringify({ id: "q2", value: "kept" }));
    expect(JSON.parse(unread.body)).toEqual({ ok: true });
    expect([...store.answers.values()]).toEqual([expect.objectContaining({ id: "q2", value: "kept" })]);
    expect((await post("not json")).status).toBe(400);
  });

  it("passes Close installer on to the job", async () => {
    const store = memorySetupStore();
    const handle = setupPageHandler({ store, env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN } });
    await handle(request({ method: "POST", path: "/close", query: {}, headers: { host: "setup.example.com", origin: SETUP_ORIGIN, [WIZARD_TOKEN_HEADER]: TOKEN }, body: "{}" }));
    expect(await store.takeClose()).toBe(true);
  });
});

describe("the GitHub App from the setup page", () => {
  const FORM = { state: "a".repeat(32), html: `<form action="https://github.com/settings/apps/new?state=${"a".repeat(32)}"></form><script nonce="${GITHUB_NONCE_PLACEHOLDER}">submit()</script>` };
  const handler = (store = memorySetupStore()) => ({ store, handle: setupPageHandler({ store, env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN } }) });
  const github = (query: Record<string, string>) => ({ method: "GET", path: "/github/created", query, headers: { host: "setup.example.com", "sec-fetch-site": "cross-site" } });

  it("serves the job's form with a fresh nonce under its own strict policy, only while the job waits on it", async () => {
    const { store, handle } = handler();
    const start = { method: "GET", path: "/github/start", query: { [WIZARD_TOKEN_QUERY]: TOKEN }, headers: { host: "setup.example.com" } };
    expect((await handle(start)).status).toBe(404);
    await store.putGitHubManifest(FORM);
    const first = await handle(start);
    const nonce = /nonce="([^"]+)"/.exec(first.body)?.[1] ?? "";
    expect(nonce).not.toBe(GITHUB_NONCE_PLACEHOLDER);
    expect(first.headers["content-security-policy"]).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`);
    expect(/nonce="([^"]+)"/.exec((await handle(start)).body)?.[1]).not.toBe(nonce);
  });

  it("takes GitHub's redirect, with no token, only with the waiting form's state, once", async () => {
    const { store, handle } = handler();
    expect((await handle(github({ code: "c0de", state: FORM.state }))).status).toBe(400);
    await store.putGitHubManifest(FORM);
    expect((await handle(github({ code: "c0de", state: "b".repeat(32) }))).status).toBe(400);
    expect((await handle(github({ state: FORM.state }))).status).toBe(400);
    const sent = await handle(github({ code: "c0de", state: FORM.state }));
    expect(sent).toMatchObject({ status: 200, body: expect.stringContaining("GitHub sent AgentX the new app") as unknown });
    expect(await store.takeGitHubCode(FORM.state)).toBe("c0de");
    expect((await handle(github({ code: "again", state: FORM.state }))).status).toBe(400);
  });

  it("is waited on by the job as long as the step lasts, and dropped when the step ends", async () => {
    const store = memorySetupStore();
    const host = await cloudManifestHost({ store, url: SETUP_ORIGIN, pollMs: 1 })({ state: FORM.state, page: (redirect, nonce) => `${redirect}|${nonce ?? ""}`, timeoutMs: 1 });
    expect(host).toMatchObject({ startUrl: `${SETUP_ORIGIN}/github/start`, redirectUrl: `${SETUP_ORIGIN}/github/created` });
    expect(await store.getGitHubManifest()).toEqual({ state: FORM.state, html: `${SETUP_ORIGIN}/github/created|${GITHUB_NONCE_PLACEHOLDER}` });
    // Long past the 15 minutes the local page allows: the code still arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.putGitHubCode(FORM.state, "late-code");
    expect(await host.code).toBe("late-code");
    host.close();
    await until(async () => (await store.getGitHubManifest()) === undefined);
  });
});

describe("agentx init --setup-table", () => {
  it("runs a whole install with every question answered on the setup page, through the table", async () => {
    const h = await harness();
    const store = memorySetupStore();
    const slack = fakeSlackApi();
    const handle = setupPageHandler({ store, env: "staging", origin: SETUP_ORIGIN, auth: { kind: "token", token: TOKEN }, verdictWaitMs: 200, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) });
    // Nothing is asked before the first step: no one can reach the page yet. The flags the
    // bootstrap stack passes and the defaults answer the settings and the plan.
    // Add to Slack: the operator pastes one configuration token; Slack's page and its redirect back
    // are played by the operator, and nobody confirms the request URL by hand.
    const operator = setupPageOperator({ script: ["token", CONFIG_TOKEN, ...SIGNIN, ...FINISH], handle, token: TOKEN });
    // The admin signed in on the setup page, which left their sign-in for the job (setup-auth.ts).
    await store.putAdminToken(`sealed:${accessToken({ "cognito:groups": ["agentx-admin"] })}`, Date.now() + 3_600_000);
    const running = operator.run();
    const code = await h.run(
      [
        "--setup-table", "agentx-setup", "--setup-url", SETUP_ORIGIN, "--admin-email", ADMIN_EMAIL, "--github-account", "acme",
      ],
      {
        setupStore: () => store, setupRelayTiming: FAST, slack,
        setupSeal: { seal: async (plain) => `sealed:${plain}`, open: async (sealed) => sealed.replace(/^sealed:/, "") },
      },
    );
    await running;
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    // The GitHub App was made from the setup page's own form, and GitHub's redirect came back there.
    expect(operator.clicked).toContain(`${SETUP_ORIGIN}/github/start`);
    expect(h.github.conversions).toEqual(["0123456789abcdef0123"]);
    expect(await store.getGitHubManifest()).toBeUndefined();
    expect(slack.manifests.map((each) => each.method)).toEqual(["create", "update"]);
    expect(slack.manifests[0]?.manifest.settings.event_subscriptions).toBeUndefined();
    expect(slack.manifests[1]?.manifest.settings.event_subscriptions?.request_url).toMatch(/\/slack\/events$/);
    expect(slack.manifests[0]?.manifest.oauth_config.redirect_urls).toContain(`${SETUP_ORIGIN}/slack/callback`);
    expect(slack.exchanged).toEqual(["slack-code-0123"]);
    expect(operator.asked).not.toContain("Does Slack show the Request URL as Verified?");
    const stored = JSON.parse(h.secrets.values.get("agentx/staging/slack") ?? "{}") as Record<string, string>;
    expect(stored).toMatchObject({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET, clientId: FAKE_SLACK_CLIENT.clientId });
    expect(JSON.stringify(stored)).not.toContain(CONFIG_TOKEN);
    expect(operator.asked).not.toContain("Your settings");
    expect(operator.asked).not.toContain("Create all of this?");
    expect(operator.states.at(-1)).toMatchObject({ installerClosed: true });
    expect(operator.states.at(-1)?.cards?.some((card) => card.id === "ready")).toBe(true);
    // Nothing is served from the job's own machine.
    expect(h.err.join("")).toContain(`The AgentX installer is on its setup page: ${SETUP_ORIGIN}`);
    expect(h.err.join("")).not.toContain("127.0.0.1");
  });

  it("refuses --setup-table without --setup-url, and with --yes or --no-ui", async () => {
    const h = await harness();
    expect(await h.run(["--setup-table", "agentx-setup"])).toBe(2);
    expect(h.printed()).toContain("--setup-table and --setup-url go together");
    expect(await h.run(["--setup-table", "agentx-setup", "--setup-url", SETUP_ORIGIN, "--yes"])).toBe(2);
    expect(h.printed()).toContain("--setup-table asks every question on the setup page; leave out --no-ui and --yes");
  });
});
