// FR-027 to FR-030: the GitHub App is created with GitHub's manifest flow. A one-time listener on
// 127.0.0.1 serves the pre-filled form and receives GitHub's redirect; the conversion's private key
// goes straight into Secrets Manager and is never printed or written to disk. The app has no
// webhook: AgentX handles no GitHub events.
import { createSign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { agentXError } from "@agentx/contracts";
import type { InitContext, ManifestHost, OpenManifestHost } from "./context.js";
import { checkPrivateKeyPem, secretFromSource } from "./prompts.js";
import { problemText } from "./retry.js";
import type { InitStep, ProgressHandle, StepOutcome } from "./steps.js";
import { operatorStop } from "./stop.js";
import { githubCard, type GitHubCardInput } from "./ui/cards.js";
import { STEP_PLAN } from "./ui/journey.js";

export const AGENTX_HOMEPAGE = "https://github.com/PrepLabsAI/Rovara";
export const GITHUB_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 5_000;
/** An installation token is renewed this long before it expires. */
const TOKEN_RENEW_MS = 5 * 60 * 1000;
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

export function manifestFormPage(input: { actionUrl: string; manifest: GitHubManifest; nonce?: string }): string {
  const script = input.nonce === undefined ? "<script>" : `<script nonce="${escapeHtml(input.nonce)}">`;
  return [
    "<!doctype html><meta charset=\"utf-8\"><title>Create the AgentX GitHub App</title>",
    `<form id="manifest-form" method="post" action="${escapeHtml(input.actionUrl)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(input.manifest))}">`,
    "<p>Opening GitHub with the AgentX GitHub App filled in.</p><button type=\"submit\">Continue to GitHub</button></form>",
    `${script}document.getElementById("manifest-form").submit()</script>`,
  ].join("\n");
}

export function parseManifestCallback(pasted: string, expectedState: string): string {
  const text = pasted.trim();
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    const state = url.searchParams.get("state");
    if (state === null || state === "") throw agentXError("CONFIG_INVALID", "that address has no state; paste the whole address GitHub sent your browser to after creating the app, or just its code");
    if (state !== expectedState) throw agentXError("CONFIG_INVALID", "that address is from a different agentx init run (its state does not match); create the app from the page this run printed");
    const code = url.searchParams.get("code");
    if (code === null || code === "") throw agentXError("CONFIG_INVALID", "that address has no code; paste the address GitHub sent your browser to after creating the app");
    return code;
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(text)) throw agentXError("CONFIG_INVALID", "that is not a GitHub manifest code; paste the address GitHub sent your browser to after creating the app");
  return text;
}

export type ManifestListener = ManifestHost;

/** `port` is for tests; the default 0 asks the system for a free port. */
export async function startManifestListener(input: { state: string; page: (redirectUrl: string, nonce?: string) => string; timeoutMs: number; port?: number }): Promise<ManifestListener> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolvePromise, reject) => { resolveCode = resolvePromise; rejectCode = reject; });
  code.catch(() => undefined); // a timeout nobody awaits (the --no-browser path) must not crash the process
  let redirectUrl = "";
  let port = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    // DNS-rebinding defence: a page on another name that resolves to 127.0.0.1 sends its own Host.
    if (request.headers.host !== `127.0.0.1:${port}`) return send(403, "<p>Forbidden.</p>");
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
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(agentXError("CONFIG_INVALID", `could not open a local port on 127.0.0.1 for the GitHub App page (${error.code ?? error.name}); check that no firewall or security tool blocks local ports and run agentx init again, or pass --github-app-id, --github-installation-id and --github-private-key-file for a GitHub App made beforehand`));
    };
    server.once("error", onError);
    server.listen(input.port ?? 0, "127.0.0.1", () => { server.removeListener("error", onError); resolvePromise(); });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  redirectUrl = `http://127.0.0.1:${port}/github/created`;
  // closeAllConnections too: a browser's keep-alive socket would otherwise hold the process open.
  const stop = () => { server.close(); server.closeAllConnections(); };
  // On timeout the listener stops too, so it cannot outlive the wait on the --no-browser path.
  const timer = setTimeout(() => {
    stop();
    rejectCode(agentXError("CONFIG_INVALID", `no GitHub App was created within ${Math.round(input.timeoutMs / 60_000)} minutes; run agentx init again`));
  }, input.timeoutMs);
  return {
    port,
    startUrl: `http://127.0.0.1:${port}/github/start`,
    redirectUrl,
    code,
    close: () => { clearTimeout(timer); stop(); },
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
  /** expiresAt is epoch milliseconds. */
  installationToken(jwt: string, installationId: string): Promise<{ token: string; expiresAt: number }>;
  repositoryCount(token: string): Promise<number>;
  /** Spec 048 FR-020 and FR-028: a public lookup of an owner. undefined: GitHub has no such owner.
   * Throws when GitHub could not answer (network, rate limit). Optional: a client without it skips. */
  owner?(login: string): Promise<{ login: string; type: "User" | "Organization" } | undefined>;
  /** Spec 048 FR-028. Best effort (Ruling 8): GitHub shows a private app by its slug only to its
   * owner, so undefined means "not visible", not "free". Throws when GitHub could not answer.
   * Optional: a client without it skips the check. */
  appBySlug?(slug: string): Promise<{ owner: { login: string } } | undefined>;
}

/** Spec 048 FR-028: the slug GitHub makes from an app's name (lower case, runs of anything else to
 * one hyphen), which is how a taken name is found. */
export function githubAppSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The headers every GitHub REST call sends. */
const GITHUB_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agentx-cli" } as const;

export function githubRestApi(fetchImplementation: typeof fetch): GitHubApi {
  const call = async (what: string, path: string, init: { method?: string; token?: string } = {}): Promise<unknown> => {
    const response = await fetchImplementation(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...GITHUB_HEADERS,
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
    });
    // Never include the body: a conversion response carries the private key.
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${response.status}`);
    return response.json();
  };
  /** A public GET: undefined for a 404, the status alone in any other refusal. */
  const lookup = async (what: string, path: string): Promise<unknown> => {
    const response = await fetchImplementation(`${API}${path}`, { headers: GITHUB_HEADERS });
    if (response.status === 404) return undefined;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${response.status}`);
    return response.json();
  };
  return {
    async owner(login) {
      const found = (await lookup("owner lookup", `/users/${encodeURIComponent(login)}`)) as { login?: string; type?: string } | undefined;
      return found === undefined ? undefined : { login: found.login ?? login, type: found.type === "Organization" ? "Organization" : "User" };
    },
    async appBySlug(slug) {
      const found = (await lookup("app lookup", `/apps/${encodeURIComponent(slug)}`)) as { owner?: { login?: string } } | undefined;
      return found === undefined ? undefined : { owner: { login: found.owner?.login ?? "" } };
    },
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
      const created = (await call("installation token", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: "POST", token: jwt })) as { token: string; expires_at?: string };
      const expiresAt = Date.parse(created.expires_at ?? "");
      // An unreadable expiry counts as already expired, so the token is simply fetched again.
      return { token: created.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
    },
    async repositoryCount(token) {
      return ((await call("repository list", "/installation/repositories?per_page=1", { token })) as { total_count: number }).total_count;
    },
  };
}

export function githubAppSecretName(env: string): string {
  return `agentx/${env}/github-app`;
}

export interface AppSecret { appId: string; slug: string; account: string; privateKey: string }

export function parseAppSecret(raw: string, name: string): AppSecret {
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

async function createWithManifest(context: InitContext, api: GitHubApi, show: (card: GitHubCardInput) => void): Promise<AppSecret & { owner: { login: string; type: string } }> {
  const { account, accountType, appName } = context.answers.github;
  const state = randomBytes(16).toString("hex");
  const actionUrl = githubNewAppUrl({ account, accountType, state });
  const openHost: OpenManifestHost = context.manifestHost ?? startManifestListener;
  const listener = await openHost({
    state,
    page: (redirectUrl, nonce) => manifestFormPage({ actionUrl, manifest: githubAppManifest({ appName, redirectUrl }), ...(nonce === undefined ? {} : { nonce }) }),
    timeoutMs: GITHUB_WAIT_MS,
  });
  try {
    context.write(`Create the GitHub App "${appName}" for ${account}: GitHub opens with everything filled in; press Create GitHub App.`);
    show({ stage: "create", appName, account, startUrl: listener.startUrl });
    let code: string;
    let opened = false;
    if (context.openBrowser !== undefined) {
      // On the page the address is a button, not a browser that might not open.
      if (context.surface === undefined) context.write(`If no browser opens, open ${listener.startUrl}`);
      opened = await context.openBrowser(listener.startUrl);
    }
    if (opened) {
      code = await listener.code;
    } else {
      // --no-browser, or a browser that would not open: the engineer opens the page and pastes the redirect.
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
    title: STEP_PLAN["github-app"].title,
    async run(context, progress) {
      // A GitHub card left waiting when the step fails would say it still waits: the page shows
      // the failure instead. With no page nothing is shown, and the error is the same either way.
      let waiting = false;
      const show = (card: GitHubCardInput) => {
        waiting = card.stage !== "done";
        context.surface?.card(githubCard(card));
      };
      try {
        return await runGitHubAppStep(context, progress, api, show);
      } catch (error) {
        if (waiting) context.surface?.card(githubCard({ stage: "failed", problem: problemText(error) }));
        throw error;
      }
    },
  };
}

async function runGitHubAppStep(context: InitContext, progress: ProgressHandle, api: GitHubApi, show: (card: GitHubCardInput) => void): Promise<StepOutcome> {
  const { account, accountType, appName } = context.answers.github;
  const name = githubAppSecretName(context.env);
  const requireArn = async () => {
    const arn = await context.secrets.arn(name);
    if (arn === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `secret ${name} was just stored but cannot be described; run agentx init again`);
    return arn;
  };
  const jwtFor = (appId: string, privateKey: string) => githubAppJwt({ appId, privateKey, nowSeconds: Math.floor(context.now() / 1000) });

  let app = progress.current().github;
  let privateKey: string | undefined;
  const preMade = context.preMadeGitHubApp;
  if (app !== undefined && preMade !== undefined && app.appId !== preMade.appId) {
    throw agentXError("CONFIG_INVALID", `this install already uses GitHub App ${app.appId}, not ${preMade.appId} from --github-app-id; pass --github-app-id ${app.appId}, or leave the GitHub App flags off to continue with the recorded app`);
  }
  if (app === undefined) {
    const leftover = await context.secrets.get(name);
    if (leftover !== undefined) {
      const recovered = parseAppSecret(leftover, name);
      if (preMade !== undefined && recovered.appId !== preMade.appId) {
        throw agentXError("CONFIG_INVALID", `secret ${name} holds GitHub App ${recovered.appId}, not ${preMade.appId} from --github-app-id; pass --github-app-id ${recovered.appId}, or delete the secret (aws secretsmanager delete-secret --secret-id ${name} --force-delete-without-recovery) and run agentx init again`);
      }
      privateKey = recovered.privateKey;
      app = { account: recovered.account, appId: recovered.appId, slug: recovered.slug, privateKeySecretArn: await requireArn() };
      await progress.update({ github: app });
      context.write(`Found the GitHub App ${recovered.slug} an earlier run created.`);
    }
  }
  // Spec 048 FR-032: an app GitHub already made but whose key never reached Secrets Manager (a
  // crash between the two). Offered only on a fresh resume (no --github-app-id of its own):
  // --github-app-id picks a specific app by id, which the recovery flow has no way to confirm.
  const pending = progress.current().githubPending;
  let recovering: "finish" | "replace" | undefined;
  if (app === undefined && pending !== undefined && preMade === undefined) {
    const settingsUrl = `${appSettingsUrl({ login: pending.account, type: accountType === "organization" ? "Organization" : "User" }, pending.slug)}/advanced`;
    show({ stage: "recover", appName, slug: pending.slug, settingsUrl });
    recovering = await context.prompter.choose<"finish" | "replace">(`Finish with the GitHub app ${pending.slug}, or replace it?`, [
      { value: "finish", label: "Finish with this app: make a new private key on its GitHub page and paste it" },
      { value: "replace", label: "Replace it: delete it on GitHub, then make a new one" },
    ], { flag: "--github-app-recovery", defaultValue: "finish" });
    if (recovering === "replace" && !(await context.prompter.confirm(`Have you deleted ${pending.slug} on GitHub?`, { defaultValue: true }))) {
      throw operatorStop(`the GitHub app ${pending.slug} is still there; delete it on GitHub, then continue the install`);
    }
  }
  if (app === undefined) {
    const created = preMade !== undefined ? await usePreMadeApp(context, api, preMade.appId)
      : recovering === "finish" && pending !== undefined ? await usePreMadeApp(context, api, pending.appId)
        : await createWithManifest(context, api, show);
    if (created.owner.login.toLowerCase() !== account.toLowerCase()) {
      // An app made beforehand is the owner's own: point at the flag, never tell them to delete it.
      if (preMade !== undefined) {
        throw agentXError("CONFIG_INVALID", `GitHub App ${preMade.appId} belongs to ${created.owner.login}, not ${account}; nothing was saved. Check --github-app-id and run agentx init again`);
      }
      throw agentXError("CONFIG_INVALID", `the GitHub App was created under ${created.owner.login}, not ${account}; nothing was saved. Delete it at ${appSettingsUrl(created.owner, created.slug)}/advanced and run agentx init again`);
    }
    // FR-032: recorded before the key is stored. GitHub shows the key only once, so a run that stops
    // between here and the store can still find the app and offer to finish with it or replace it.
    await progress.update({ githubPending: { account, appId: created.appId, slug: created.slug } });
    try {
      await context.secrets.create(name, JSON.stringify({ appId: created.appId, slug: created.slug, account, privateKey: created.privateKey }));
    } catch (error) {
      // Only the error's name: never its message or cause, which could echo the request.
      const reason = error instanceof Error ? error.name : "unknown error";
      const next = preMade !== undefined
        ? "fix that and run agentx init again"
        : `GitHub cannot show the key again, so delete the app at ${appSettingsUrl(created.owner, created.slug)}/advanced and run agentx init again`;
      throw agentXError("RUNTIME_UNAVAILABLE", `could not store the private key of the ${preMade !== undefined ? "" : "new "}GitHub App ${created.slug} in ${name} (${reason}); ${next}`);
    }
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
    show({ stage: "install", appName, slug: app.slug, account, installUrl });
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
  let token: { token: string; expiresAt: number } | undefined;
  for (;;) {
    if (token === undefined || context.now() >= token.expiresAt - TOKEN_RENEW_MS) token = await api.installationToken(jwtFor(app.appId, privateKey), installationId);
    if ((await api.repositoryCount(token.token)) > 0) break;
    if (!told) {
      context.write(`The app is installed but can see no repositories. Choose at least one at ${installationSettingsUrl(accountType, account, installationId)}`);
      show({ stage: "repositories", appName, slug: app.slug, account, settingsUrl: installationSettingsUrl(accountType, account, installationId) });
      told = true;
    }
    if (context.now() >= deadline) throw agentXError("CONFIG_INVALID", `the GitHub App can see no repositories; choose at least one at ${installationSettingsUrl(accountType, account, installationId)}, then run agentx init again`);
    await context.sleep(POLL_MS);
  }
  await progress.update({ github: { ...app, installationId } });
  show({ stage: "done", appName, slug: app.slug, account });
  return { status: "done", note: `GitHub App ${app.slug} installed on ${account}` };
}
