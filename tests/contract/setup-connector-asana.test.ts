// FR-036 to FR-039: agentx connector add asana. The bot user signs in once, with no browser opened
// here and only --expect-account's sign-in kept (FR-037). One refresh gets an access token (a
// rotated refresh token is written back at once), then get_project as the bot is the test read
// (FR-038); the project gets a new revision only after that read (C3: the sign-in itself stores
// and registers the credential, as authorizeCredential always has).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeCredential, type AuthorizeInput } from "../../packages/cli/src/admin/authorize.js";
import { createCliProgram } from "../../packages/cli/src/main.js";
import { addAsana, ASANA_GUIDE } from "../../packages/cli/src/setup/connectors/asana.js";
import { vendorApi } from "../../packages/cli/src/setup/connectors/vendors.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { startFakeAsana } from "../support/fake-asana.js";
import { memoryInitSecrets, scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeVendors } from "../support/setup-fakes.js";

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
  await writeProjectFile(configDir, {
    name: "payments-api", revision: 1,
    repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
  });
});
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

function input(overrides: { script?: Array<string | boolean>; plane?: ReturnType<typeof fakeControlPlane>; vendors?: ReturnType<typeof fakeVendors>; lines?: string[]; secrets?: ReturnType<typeof memoryInitSecrets> } = {}) {
  const plane = overrides.plane ?? fakeControlPlane();
  return {
    env: "staging", session, projectName: "payments-api", secrets: overrides.secrets ?? memoryInitSecrets(),
    prompter: scriptedPrompter(overrides.script ?? []),
    processEnv: {}, write: (line: string) => { overrides.lines?.push(line); },
    services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION, vendors: overrides.vendors ?? fakeVendors() },
    flags: {},
  };
}

const SECRET = `asana-client-secret-${"s".repeat(40)}`;
const CLIENT_ID = "1200000000000001";
const BOT = "agentx-bot@example.com";
const GID = "1210000000000010";
const SECRET_NAME = "agentx/staging/connectors/asana";

function fakeAuthorize(signedInAs = BOT) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    authorize: async (options: { secrets: { read(n: string): Promise<string | undefined>; write(n: string, v: string): Promise<void> }; secretName: string; expectAccount?: string; openBrowser?: unknown; showUrl: (url: string, redirect: string) => void }) => {
      calls.push({ secretName: options.secretName, expectAccount: options.expectAccount, openBrowser: options.openBrowser });
      options.showUrl("https://app.asana.com/-/oauth_authorize?x=1", "(the Asana app's redirect URL must be exactly http://localhost:8765/callback)");
      if (signedInAs !== options.expectAccount) throw Object.assign(new Error(`AUTH_REQUIRED: the sign-in was for ${signedInAs}, not ${options.expectAccount}; nothing was stored or registered.`), { name: "AgentXError" });
      const app = JSON.parse((await options.secrets.read(options.secretName))!) as Record<string, string>;
      await options.secrets.write(options.secretName, JSON.stringify({ ...app, refreshToken: "refresh-1" }));
      return { registered: true };
    },
  };
}

/** AuthorizeSecrets over the same map as `secrets` (the InitSecrets the connector store writes), so
 * the sign-in and the connector see one Secrets Manager. */
function authorizeSecretsOver(secrets: ReturnType<typeof memoryInitSecrets>) {
  return { read: async (name: string) => secrets.values.get(name), write: async (name: string, value: string) => { secrets.values.set(name, value); }, tag: async () => undefined };
}

function withAuthorize(base: ReturnType<typeof input>, secrets: ReturnType<typeof memoryInitSecrets>, authorize = fakeAuthorize().authorize) {
  return { ...base, services: { ...base.services, authorize, authorizeSecrets: authorizeSecretsOver(secrets) } };
}

describe("agentx connector add asana (FR-036 to FR-039)", () => {
  it("stores the app's client, signs the bot in with --no-browser and --expect-account, reads the project, then scopes it", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const auth = fakeAuthorize();
    const vendors = fakeVendors({ asanaProject: { name: "Payments" } });
    const lines: string[] = [];
    // client id, client secret, bot email, project gid
    const base = input({ plane, vendors, secrets, lines, script: [CLIENT_ID, SECRET, BOT, GID] });
    const result = await addAsana({ ...base, services: { ...base.services, authorize: auth.authorize, authorizeSecrets: authorizeSecretsOver(secrets) } });
    expect(result).toEqual({ ref: "asana", revision: 2 });
    expect(lines[0]).toBe(ASANA_GUIDE);
    // FR-037: no browser is opened, and only the bot's sign-in is accepted.
    expect(auth.calls).toEqual([{ secretName: SECRET_NAME, expectAccount: BOT, openBrowser: undefined }]);
    expect(lines.join("\n")).toContain("Open this address in a private window signed in as agentx-bot@example.com");
    expect(vendors.calls).toEqual(["asanaAccessToken", `asanaProject ${GID}`]);
    expect(lines.join("\n")).toContain("The bot user sees the Asana project Payments.");
    const registered = plane.registered.at(-1) as { definition: { integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.integrations.connectors[0]).toMatchObject({ name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: "payments", projectGid: GID }] });
    for (const text of [lines.join("\n"), JSON.stringify(plane.registered)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("refresh-1");
    }
  });

  it("writes back a refresh token Asana rotated during the test read", async () => {
    const secrets = memoryInitSecrets();
    const base = input({ secrets, vendors: fakeVendors({ asanaProject: { name: "Payments" }, asanaRotates: "refresh-2" }), script: [CLIENT_ID, SECRET, BOT, GID] });
    await addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize().authorize, authorizeSecrets: authorizeSecretsOver(secrets) } });
    expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: "refresh-2" });
  });

  it("writes a rotated refresh token back before the project read, so a failed read still leaves the live token stored", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaProject: undefined, asanaRotates: "refresh-2" }), script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana(withAuthorize(base, secrets))).rejects.toThrow(/cannot see, or could not read, project/);
    expect((JSON.parse(secrets.values.get(SECRET_NAME)!) as { refreshToken?: string }).refreshToken).toBe("refresh-2");
    expect(plane.registered).toEqual([]);
  });

  it("refuses when the bot cannot see, or could not read, the project, before saving the revision", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaProject: undefined }), script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize().authorize, authorizeSecrets: authorizeSecretsOver(secrets) } }))
      .rejects.toThrow(`the bot cannot see, or could not read, project ${GID}; invite it to the project (${BOT}, as a guest with Editor access: docs/connectors/asana.md, Step 1) or try again: agentx connector add asana --project payments-api`);
    expect(plane.registered).toEqual([]);
  });

  it("passes on the refusal of a sign-in by the wrong account (FR-037)", async () => {
    const secrets = memoryInitSecrets();
    const base = input({ secrets, script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize("owner@example.com").authorize, authorizeSecrets: authorizeSecretsOver(secrets) } }))
      .rejects.toThrow("the sign-in was for owner@example.com, not agentx-bot@example.com");
  });

  it("with the real sign-in, refuses another Asana account before a refresh token is stored or the credential registered, and closes the listener", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const vendors = fakeVendors();
    let port = 0;
    // Asana's token endpoint answers the code exchange for the owner, not the bot; everything else
    // goes to the fake control plane.
    const fetchImplementation: typeof fetch = async (url, init) => {
      const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      if (href === "https://app.asana.com/-/oauth_token") {
        return Response.json({ access_token: "access-owner", refresh_token: "refresh-owner", data: { name: "Owner", email: "owner@example.com" } });
      }
      return plane.fetch(url, init);
    };
    const authorize = (options: AuthorizeInput) => authorizeCredential({
      ...options, fetchImplementation, listenPort: 0, onListening: (bound) => { port = bound; },
      // Plays the browser the engineer opens in a private window.
      showUrl: (url, redirect) => {
        options.showUrl(url, redirect);
        const state = new URL(url).searchParams.get("state")!;
        void fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=${state}`).then((response) => response.text());
      },
    });
    const lines: string[] = [];
    const base = input({ plane, secrets, vendors, lines, script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana({ ...base, services: { ...base.services, fetch: fetchImplementation, authorize, authorizeSecrets: authorizeSecretsOver(secrets) } }))
      .rejects.toThrow("the sign-in was for Owner <owner@example.com>, not agentx-bot@example.com; nothing was stored or registered");
    expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
    expect(plane.credentials.map((entry) => entry.ref)).toEqual(["github-agentx-sdlc"]);
    expect(plane.registered).toEqual([]);
    expect(vendors.calls).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/refresh-owner|access-owner|code-1/);
    // The listener is closed: nothing answers on its port any more.
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  describe("a rerun over a working connector", () => {
    const EXISTING = JSON.stringify({ clientId: CLIENT_ID, clientSecret: `old-${SECRET}`, refreshToken: "refresh-old" });

    /** addAsana with the real sign-in: the browser answers `callback`, Asana's token endpoint answers
     * the code exchange for `email`, and the control plane is the fake. */
    async function rerun(options: { callback: (state: string) => string; email: string; secrets?: ReturnType<typeof memoryInitSecrets> }) {
      const plane = fakeControlPlane();
      const secrets = options.secrets ?? memoryInitSecrets({ [SECRET_NAME]: EXISTING });
      const vendors = fakeVendors({ asanaProject: { name: "Payments" } });
      let port = 0;
      const fetchImplementation: typeof fetch = async (url, init) => {
        const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
        if (href === "https://app.asana.com/-/oauth_token") return Response.json({ access_token: "access-new", refresh_token: "refresh-new", data: { name: "Someone", email: options.email } });
        return plane.fetch(url, init);
      };
      const authorize = (authorizeInput: AuthorizeInput) => authorizeCredential({
        ...authorizeInput, fetchImplementation, listenPort: 0, onListening: (bound) => { port = bound; },
        showUrl: (url, redirect) => {
          authorizeInput.showUrl(url, redirect);
          void fetch(`http://127.0.0.1:${port}/callback?${options.callback(new URL(url).searchParams.get("state")!)}`).then((response) => response.text());
        },
      });
      const base = input({ plane, secrets, vendors, script: [CLIENT_ID, SECRET, BOT, GID] });
      const run = addAsana({ ...base, services: { ...base.services, fetch: fetchImplementation, authorize, authorizeSecrets: authorizeSecretsOver(secrets) } });
      return { run, secrets, plane };
    }

    it("leaves the stored secret byte-identical when the sign-in is by another account", async () => {
      const { run, secrets, plane } = await rerun({ callback: (state) => `code=code-1&state=${state}`, email: "owner@example.com" });
      await expect(run).rejects.toThrow("not agentx-bot@example.com; nothing was stored or registered");
      expect(secrets.values.get(SECRET_NAME)).toBe(EXISTING);
      expect(plane.registered).toEqual([]);
    });

    it("leaves the stored secret byte-identical when the sign-in is cancelled", async () => {
      const { run, secrets, plane } = await rerun({ callback: (state) => `error=access_denied&state=${state}`, email: BOT });
      await expect(run).rejects.toThrow("the sign-in was refused or cancelled (access_denied); nothing was stored");
      expect(secrets.values.get(SECRET_NAME)).toBe(EXISTING);
      expect(plane.registered).toEqual([]);
    });

    it("replaces the whole secret, with the new client, once the bot's new sign-in succeeds", async () => {
      const { run, secrets } = await rerun({ callback: (state) => `code=code-1&state=${state}`, email: BOT });
      expect(await run).toEqual({ ref: "asana", revision: 2 });
      expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: "refresh-new" });
    });

    it("after a first run whose sign-in failed (a client-only secret), a successful rerun stores the client and the refresh token", async () => {
      const secrets = memoryInitSecrets();
      const first = await rerun({ secrets, callback: (state) => `error=access_denied&state=${state}`, email: BOT });
      await expect(first.run).rejects.toThrow("the sign-in was refused or cancelled");
      expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
      const second = await rerun({ secrets, callback: (state) => `code=code-1&state=${state}`, email: BOT });
      expect(await second.run).toEqual({ ref: "asana", revision: 2 });
      expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: "refresh-new" });
    });
  });

  it("explains a refused refresh and saves no revision", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaRefuses: "refresh" }), script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana(withAuthorize(base, secrets))).rejects.toThrow("Asana refused to renew the bot user's sign-in, so the project was not changed; run agentx connector add asana --project payments-api again to sign in again");
    expect(plane.registered).toEqual([]);
  });

  it("explains an access token Asana MCP refuses (F28) and saves no revision", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaRefuses: "read" }), script: [CLIENT_ID, SECRET, BOT, GID] });
    await expect(addAsana(withAuthorize(base, secrets))).rejects.toThrow("Asana MCP refused the bot user's access token, so the project was not changed; check the app type is Asana MCP (docs/connectors/asana.md, Step 2), then run agentx connector add asana --project payments-api again");
    expect(plane.registered).toEqual([]);
  });

  it("explains any other failure of the project read, with no vendor text, and saves no revision", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const raw = "MCP tool not allowed or unavailable: vendor said secret-ish things";
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaReadError: raw }), script: [CLIENT_ID, SECRET, BOT, GID] });
    const failure = addAsana(withAuthorize(base, secrets));
    await expect(failure).rejects.toThrow(`could not read Asana project ${GID} through Asana MCP (Error), so the project was not changed; check that the Asana app type is Asana MCP (see the Asana guide, docs/connectors/asana.md, Step 2), then rerun agentx connector add asana --project payments-api`);
    await expect(failure).rejects.not.toThrow(/vendor said/);
    expect(plane.registered).toEqual([]);
  });

  it("refuses a project that still uses the older integrations.githubMcp setting, before any sign-in or store", async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), "agentx-projects-legacy-"));
    try {
      await writeProjectFile(legacyDir, {
        name: "payments-api", revision: 1,
        repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
        integrations: { githubMcp: { tools: [{ name: "list_issues", access: "read" }] } },
      });
      const secrets = memoryInitSecrets();
      const vendors = fakeVendors();
      const auth = fakeAuthorize();
      const lines: string[] = [];
      const base = withAuthorize(input({ secrets, vendors, lines, script: [CLIENT_ID, SECRET, BOT, GID] }), secrets, auth.authorize);
      await expect(addAsana({ ...base, services: { ...base.services, configDir: legacyDir } })).rejects.toThrow("project payments-api uses the older integrations.githubMcp setting");
      expect(secrets.values.size).toBe(0);
      expect(auth.calls).toEqual([]);
      expect(vendors.calls).toEqual([]);
      expect(lines).toEqual([]);
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("checks the Client ID, the bot email and the project GID before storing anything", async () => {
    const secrets = memoryInitSecrets();
    const auth = fakeAuthorize();
    await expect(addAsana(withAuthorize({ ...input({ secrets }), flags: { asanaClientId: "not-digits" } }, secrets, auth.authorize))).rejects.toThrow("the Client ID is digits");
    await expect(addAsana(withAuthorize({ ...input({ secrets, script: [SECRET] }), flags: { asanaClientId: CLIENT_ID, asanaBotEmail: "not-an-email" } }, secrets, auth.authorize))).rejects.toThrow("must be an email address");
    await expect(addAsana(withAuthorize({ ...input({ secrets, script: [SECRET] }), flags: { asanaClientId: CLIENT_ID, asanaBotEmail: BOT, asanaProject: "payments" } }, secrets, auth.authorize))).rejects.toThrow("the GID is digits");
    expect(secrets.values.size).toBe(0);
    expect(auth.calls).toEqual([]);
  });
});

describe("the Asana vendor calls", () => {
  const CLIENT = { clientId: CLIENT_ID, clientSecret: SECRET };
  const REFRESH = `asana-refresh-original-${"r".repeat(40)}`;

  /** Sends Asana's real token endpoint and MCP server to the fake. */
  function toFake(fake: Awaited<ReturnType<typeof startFakeAsana>>): typeof fetch {
    return (url, init) => {
      const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      if (href === "https://app.asana.com/-/oauth_token") return fetch(fake.tokenUrl, init);
      if (href === "https://mcp.asana.com/v2/mcp") return fetch(fake.mcpUrl, init);
      throw new Error(`unexpected fetch ${href}`);
    };
  }

  it("refreshes once, returns a rotated refresh token, and reads the project's name with get_project", async () => {
    const fake = await startFakeAsana({ ...CLIENT, refreshToken: REFRESH, tasks: {}, projects: { [GID]: { name: "Payments" } } });
    try {
      fake.rotate = true;
      const api = vendorApi(toFake(fake));
      const tokens = await api.asanaAccessToken({ ...CLIENT, refreshToken: REFRESH });
      expect(tokens.refreshToken).toMatch(/^asana-refresh-rotated-/);
      expect(await api.asanaProject({ accessToken: tokens.accessToken, projectGid: GID })).toEqual({ name: "Payments" });
      expect(await api.asanaProject({ accessToken: tokens.accessToken, projectGid: "1210000000000099" })).toBeUndefined();
      expect(fake.calls).toEqual([{ name: "get_project", arguments: { project_id: GID } }, { name: "get_project", arguments: { project_id: "1210000000000099" } }]);
    } finally {
      await fake.close();
    }
  });

  it("returns no refresh token when Asana did not rotate it", async () => {
    const fake = await startFakeAsana({ ...CLIENT, refreshToken: REFRESH, tasks: {} });
    try {
      const tokens = await vendorApi(toFake(fake)).asanaAccessToken({ ...CLIENT, refreshToken: REFRESH });
      expect(tokens).toEqual({ accessToken: expect.stringMatching(/^asana-access-/) as unknown });
    } finally {
      await fake.close();
    }
  });

  it("maps a refused refresh and a refused access token to VendorRefused, carrying no vendor text (F28)", async () => {
    const fake = await startFakeAsana({ ...CLIENT, refreshToken: REFRESH, tasks: {} });
    try {
      const api = vendorApi(toFake(fake));
      await expect(api.asanaAccessToken({ ...CLIENT, refreshToken: "not-the-token" })).rejects.toMatchObject({ name: "VendorRefused", message: "Asana refused the credential" });
      await expect(api.asanaProject({ accessToken: "not-issued", projectGid: GID })).rejects.toMatchObject({ name: "VendorRefused", message: "Asana refused the credential" });
    } finally {
      await fake.close();
    }
  });
});

describe("agentx connector add asana, the command", () => {
  it("takes the client secret only from a file or an environment variable, and --project from the root program (F9)", () => {
    const asana = createCliProgram().commands.find((command) => command.name() === "connector")
      ?.commands.find((command) => command.name() === "add")?.commands.find((command) => command.name() === "asana");
    expect(asana?.options.map((option) => option.long)).toEqual([
      "--region", "--asana-client-id", "--asana-client-secret-file", "--asana-client-secret-env", "--asana-bot-email", "--asana-project",
    ]);
  });
});
