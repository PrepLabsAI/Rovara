// N9 (INTG2): the worker's half. The setup and readiness commands run for real (a local shell, with real Git), so the config file the tools are pointed at is the one a command reads.
// A fake token is built at run time and PLANTED: every case that says "never appears" also proves the token really was in play (a positive control).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { StoredProjectDefinitionSchema, e2eSecretSpellings, prepareRegistriesOf, type PrepareRegistry, type ProjectRegistry, type RegistryCredential } from "../../packages/contracts/src/index.js";
import { ISSUED_TOKENS_PATH, recordIssuedTokens } from "../../packages/worker/src/registry-guard.js";
import { REGISTRY_CONFIG_PREFIX, openRegistrySession, removeLeftoverRegistryConfigs, renderMavenSettings, renderNpmrc, renderPipConf } from "../../packages/worker/src/registry-config.js";
import { createRegistryCredentialProvider } from "../../packages/worker/src/registry-credentials.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { prepareWorkspace, runProjectCommand, type PreparationCommandRunner, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const fakeToken = (seed: string): string => `eyJ${Buffer.from(`${seed}-token-material-${seed.repeat(24)}`).toString("base64url")}.${Buffer.from(seed.repeat(30)).toString("base64url")}`;
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();

const CA: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const CA_PIP: ProjectRegistry = { kind: "codeartifact", name: "internal-pypi", format: "pypi", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const CA_MVN: ProjectRegistry = { kind: "codeartifact", name: "internal-maven", format: "maven", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const registries = (...entries: ProjectRegistry[]): PrepareRegistry[] => prepareRegistriesOf(entries);

async function sourceRepository(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "registries-"));
  const source = join(root, "api-source");
  await mkdir(source, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", source], { env: gitEnv });
  await writeFile(join(source, "README.md"), "# api\n");
  await execFileAsync("git", ["-C", source, "add", "-A"], { env: gitEnv });
  await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "init"], { env: gitEnv });
  return { root, source };
}

function project(setup: string[], readiness: string[] = [], devcontainer = false, revision = 1) {
  const command = (script: string) => ({ cwd: "repo/api", executable: "sh", args: ["-c", script], timeoutSeconds: 60 });
  return StoredProjectDefinitionSchema.parse({
    name: "payments", revision,
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }],
    setup: setup.map(command), readiness: readiness.map(command), orchestratorInstructions: "x",
    ...(devcontainer ? { devcontainer: { repository: "api", configPath: ".devcontainer/devcontainer.json" } } : {}),
  });
}

async function fixture() {
  const { root, source } = await sourceRepository();
  const materializer: RepositoryMaterializer = async (_repo, target) => { await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv }); };
  const workspace = () => mkdtemp(join(root, "ws-"));
  // The real local shell, as a developer's machine runs it.
  const commandRunner: PreparationCommandRunner = (command, index, rootPath) => runProjectCommand(command, index, rootPath, undefined, true);
  return { materializer, workspace, commandRunner };
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
/** Every file under `root` whose bytes carry the token in any spelling. */
async function filesCarrying(root: string, token: string): Promise<string[]> {
  const forms = e2eSecretSpellings(token).filter((form) => form.length >= 6);
  const found: string[] = [];
  for await (const path of walk(root)) {
    const text = (await readFile(path)).toString("latin1");
    if (forms.some((form) => text.includes(form))) found.push(path);
  }
  return found;
}
const providerOf = (tokens: Record<string, string>, calls: string[] = []) => async (registry: string): Promise<RegistryCredential> => {
  calls.push(registry);
  return { username: "aws", token: tokens[registry] ?? "", expiresAt: expiry() };
};
const leftovers = async (root: string) => (await readdir(root)).filter((name) => name.startsWith(REGISTRY_CONFIG_PREFIX));

describe("the config files", () => {
  const token = fakeToken("r");
  const credential = (registry: PrepareRegistry) => ({ registry, username: "aws", token });
  it("npm: the registry line and the token for that registry's own address (CodeArtifact's documented .npmrc), per scope", () => {
    const [npm] = registries(CA);
    expect(renderNpmrc([credential(npm!)])).toBe(
      `registry=${npm!.url}\n//acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/:_authToken=${token}\n//acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/:always-auth=true\n`,
    );
    expect(renderNpmrc([credential({ ...npm!, scope: "@acme" })])).toContain(`@acme:registry=${npm!.url}\n`);
  });
  it("pip: the user name and the percent-encoded token sit in the index URL; a second index is an extra", () => {
    const [pip] = registries(CA_PIP);
    expect(renderPipConf([{ ...credential(pip!), token: "a/b+c=d-e_f.g~hijklmnop" }])).toBe(
      "[global]\nindex-url = https://aws:a%2Fb%2Bc%3Dd-e_f.g~hijklmnop@acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/pypi/shared/simple/\n",
    );
    expect(renderPipConf([credential(pip!), credential({ ...pip!, name: "second" })])).toContain("extra-index-url = https://aws:");
  });
  it("maven: a server and a repository with the same id (the documented settings.xml)", () => {
    const [maven] = registries(CA_MVN);
    const xml = renderMavenSettings([credential(maven!)]);
    expect(xml).toContain(`<server><id>internal-maven</id><username>aws</username><password>${token}</password></server>`);
    expect(xml).toContain(`<repository><id>internal-maven</id><url>${maven!.url}</url></repository>`);
    expect(xml).toContain("<activeProfile>agentx-registries</activeProfile>");
  });
});

describe("a session", () => {
  it("writes the config outside every repository in a private folder, points the tools at it, and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    const token = fakeToken("s");
    const session = await openRegistrySession({ rootPath: root, registries: registries(CA, CA_PIP, CA_MVN), provider: providerOf({ "internal-npm": token, "internal-pypi": fakeToken("t"), "internal-maven": fakeToken("u") }) });
    // Location: a direct child of the workspace root (a repository's folder is always below it), never a repository.
    expect(session.directory.startsWith(`${root}/${REGISTRY_CONFIG_PREFIX}`)).toBe(true);
    expect(session.directory.slice(root.length + 1)).not.toContain("/");
    expect((await stat(session.directory)).mode & 0o777).toBe(0o700);
    for (const name of ["npmrc", "pip.conf", "settings.xml"]) expect((await stat(join(session.directory, name))).mode & 0o777).toBe(0o600);
    expect(session.environment.NPM_CONFIG_USERCONFIG).toBe(join(session.directory, "npmrc"));
    expect(session.environment.PIP_CONFIG_FILE).toBe(join(session.directory, "pip.conf"));
    expect(session.environment.MAVEN_ARGS).toBe(`-s ${join(session.directory, "settings.xml")}`);
    // The environment holds paths only.
    expect(JSON.stringify(session.environment)).not.toContain(token);
    expect(await filesCarrying(root, token)).toHaveLength(1);
    await session.dispose();
    expect(await leftovers(root)).toEqual([]);
    expect(await filesCarrying(root, token)).toEqual([]);
  });

  it("asks for every token before it writes a file: one refusal leaves nothing on the disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    const calls: string[] = [];
    const provider = async (registry: string): Promise<RegistryCredential> => { calls.push(registry); if (registry === "internal-pypi") throw new Error("denied"); return { token: fakeToken("v"), expiresAt: expiry() }; };
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA, CA_PIP), provider })).rejects.toThrow("denied");
    expect(calls).toEqual(["internal-npm", "internal-pypi"]);
    expect(await leftovers(root)).toEqual([]);
  });

  it.each([
    ["a token with a brace (npm would expand it)", "abc${HOME}defghijklmnop"],
    ["a token with a quote", `abcdefghijklmnop"x`],
    ["a token with a semicolon (an ini comment)", "abcdefghijklmnop;x"],
  ])("refuses %s, with nothing written", async (_name, token) => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA), provider: async () => ({ token, expiresAt: expiry() }) })).rejects.toThrow(/cannot use the credential/);
    expect(await leftovers(root)).toEqual([]);
  });

  it("refuses an expired credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA), provider: async () => ({ token: fakeToken("e"), expiresAt: new Date(Date.now() - 1000).toISOString() }) })).rejects.toThrow(/cannot use the credential/);
  });

  it("never sweeps a repository whose folder happens to start with the prefix, nor a folder with anything of its own in it", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await mkdir(join(root, `${REGISTRY_CONFIG_PREFIX}repo`, ".git"), { recursive: true });
    await writeFile(join(root, `${REGISTRY_CONFIG_PREFIX}repo`, "README.md"), "mine");
    await mkdir(join(root, `${REGISTRY_CONFIG_PREFIX}ours`));
    await writeFile(join(root, `${REGISTRY_CONFIG_PREFIX}ours`, "npmrc"), "x");
    expect(await removeLeftoverRegistryConfigs(root)).toBe(1);
    expect((await readdir(root)).sort()).toEqual([`${REGISTRY_CONFIG_PREFIX}repo`]);
  });

  it("sweeps what a crashed preparation left, including a link (removed itself, never followed), and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await mkdir(join(root, `${REGISTRY_CONFIG_PREFIX}old`));
    await writeFile(join(root, `${REGISTRY_CONFIG_PREFIX}old`, "npmrc"), "x");
    await mkdir(join(root, "repo"));
    await writeFile(join(root, "repo", "keep.txt"), "keep");
    expect(await removeLeftoverRegistryConfigs(root)).toBe(1);
    expect(await readdir(root)).toEqual(["repo"]);
  });
});

describe("a preparation with registries", () => {
  it("runs the setup and readiness commands with the config, scrubs the token from everything the preparation writes, and leaves no file behind", async () => {
    const f = await fixture();
    const token = fakeToken("p");
    const rootPath = await f.workspace();
    // The setup step PRINTS the config (the worst a command can do with stdout): raw, and as base64, JSON and percent-encoded. The readiness step proves the file is read from where the tool is told.
    const manifest = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project(
        ['cat "$NPM_CONFIG_USERCONFIG"; printf %s "$(cat "$NPM_CONFIG_USERCONFIG")" | base64; node -e \'console.log(JSON.stringify(require("fs").readFileSync(process.env.NPM_CONFIG_USERCONFIG,"utf8")))\''],
        ['test -s "$NPM_CONFIG_USERCONFIG" && echo config-present'],
      ),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    });
    expect(manifest.complete).toBe(true);
    // Positive control: the command did read the config (the registry line is not secret and survives; the token is replaced).
    expect(manifest.readinessResults[0]!.stdout).toContain("config-present");
    // The recorded manifest and the whole workspace carry no spelling of the token.
    expect(await filesCarrying(rootPath, token)).toEqual([]);
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("scrubs a failing step's message and the manifest's failure text, and keeps the registry line (positive control)", async () => {
    const f = await fixture();
    const token = fakeToken("f");
    const rootPath = await f.workspace();
    const failure = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      // The bare token on a line of its own (the existing key-based redaction cannot know it) after the config itself.
      project: project(['cat "$NPM_CONFIG_USERCONFIG" >&2; sed -n "s/.*_authToken=//p" "$NPM_CONFIG_USERCONFIG" | head -1 >&2; exit 3']),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("registry=https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/");
    expect(failure?.message).toContain("[redacted]");
    for (const form of e2eSecretSpellings(token)) expect(failure?.message).not.toContain(form);
    expect(await filesCarrying(rootPath, token)).toEqual([]);
    const written = JSON.parse(await readFile(join(rootPath, ".agentx", "preparation-manifest.json"), "utf8")) as { failure?: string; complete: boolean };
    expect(written.complete).toBe(false);
    expect(written.failure).toContain("[redacted]");
    // Even a failed preparation removes the config.
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("stops the preparation when a setup step copied the token into the repository, so a pull request could never carry it", async () => {
    const f = await fixture();
    const token = fakeToken("c");
    const rootPath = await f.workspace();
    const failure = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project(['cp "$NPM_CONFIG_USERCONFIG" .npmrc']),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/left a package registry token where the agent can read it/);
    expect(await readFile(join(rootPath, "repo/api/.npmrc"), "utf8")).toContain(token.slice(0, 20)); // positive control: it really was copied
    expect(await leftovers(rootPath)).toEqual([]);
    // The failure the broker will see does not carry it either, and the workspace is marked so it is never resumed.
    const written = await readFile(join(rootPath, ".agentx", "preparation-manifest.json"), "utf8");
    expect(written).not.toContain(token);
    expect(JSON.parse(written)).toMatchObject({ complete: false, tainted: true });
  });

  describe("the guard (B2, S1)", () => {
    const tainted = async (rootPath: string) => (JSON.parse(await readFile(join(rootPath, ".agentx", "preparation-manifest.json"), "utf8")) as { tainted?: boolean }).tainted === true;
    const attempt = (f: Awaited<ReturnType<typeof fixture>>, rootPath: string, token: string, setup: string[], readiness: string[] = []) => prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project(setup, readiness),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    });

    it("a retry after a refused copy starts from a fresh clone: the copy is gone and the old token is nowhere", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      const first = fakeToken("1");
      const second = fakeToken("2");
      await expect(attempt(f, rootPath, first, ['cp "$NPM_CONFIG_USERCONFIG" .npmrc', "echo second-step"])).rejects.toThrow(/left a package registry token/);
      expect(await tainted(rootPath)).toBe(true);
      expect(await filesCarrying(rootPath, first)).not.toEqual([]); // positive control: the copy is on the disk until the next attempt
      // The retry: the copying step is NOT skipped as done; the tree is wiped and cloned again.
      const manifest = await attempt(f, rootPath, second, ["test ! -e .npmrc && echo clean-clone"], ["echo ready"]);
      expect(manifest.complete).toBe(true);
      expect(manifest.completedSetupSteps).toEqual([0]);
      expect(await filesCarrying(rootPath, first)).toEqual([]);
      expect(await filesCarrying(rootPath, second)).toEqual([]);
      expect(await tainted(rootPath)).toBe(false);
    });

    it("keeps hashes of the issued tokens, never the tokens, for the workspace's life", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      const first = fakeToken("h");
      const second = fakeToken("j");
      await expect(attempt(f, rootPath, first, ["exit 1"])).rejects.toThrow(/exited 1/);
      const sha = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");
      const afterFirst = JSON.parse(await readFile(join(rootPath, ISSUED_TOKENS_PATH), "utf8")) as Array<{ length: number; sha256: string }>;
      expect(afterFirst.map((record) => record.sha256)).toEqual([sha(first)]);
      expect((await stat(join(rootPath, ISSUED_TOKENS_PATH))).mode & 0o777).toBe(0o600);
      // The retry (an ordinary failure is resumed, not wiped) adds its token to the list; the first stays.
      await attempt(f, rootPath, second, ["echo again"]);
      const afterSecond = JSON.parse(await readFile(join(rootPath, ISSUED_TOKENS_PATH), "utf8")) as Array<{ sha256: string }>;
      expect(afterSecond.map((record) => record.sha256)).toEqual([sha(first), sha(second)]);
      // The list holds hashes: neither token is in any file, the list included.
      expect(await filesCarrying(rootPath, first)).toEqual([]);
      expect(await filesCarrying(rootPath, second)).toEqual([]);
    });

    it("a step that fails AFTER copying the token is reported as the leak it is, and the retry still starts clean", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      const first = fakeToken("3");
      const failure = await attempt(f, rootPath, first, ['cp "$NPM_CONFIG_USERCONFIG" .npmrc; exit 3']).then(() => undefined, (error: Error) => error);
      expect(failure?.message).toMatch(/left a package registry token/);
      expect(failure?.message).not.toMatch(/exited 3/);
      expect(await tainted(rootPath)).toBe(true);
      await expect(attempt(f, rootPath, fakeToken("4"), ["test ! -e .npmrc"])).resolves.toMatchObject({ complete: true });
    });

    it("a readiness check that copies the token is caught too", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      await expect(attempt(f, rootPath, fakeToken("r"), [], ['cp "$NPM_CONFIG_USERCONFIG" .npmrc'])).rejects.toThrow(/left a package registry token/);
      expect(await tainted(rootPath)).toBe(true);
    });

    it.each([
      ["a gitignored file in the repository", 'echo .env.local >> .git/info/exclude; cp "$NPM_CONFIG_USERCONFIG" .env.local'],
      ["a file at the workspace root, outside every repository", 'cp "$NPM_CONFIG_USERCONFIG" ../../stash.txt'],
      ["a folder at the workspace root (the Python user base)", 'mkdir -p ../../.agentx-python/lib && cp "$NPM_CONFIG_USERCONFIG" ../../.agentx-python/lib/cfg'],
      ["a hidden cache under node_modules", 'mkdir -p node_modules/.cache && cp "$NPM_CONFIG_USERCONFIG" node_modules/.cache/x'],
      ["a copy that keeps its times (cp -p)", 'touch -t 200001010000 "$NPM_CONFIG_USERCONFIG"; cp -p "$NPM_CONFIG_USERCONFIG" .keep'],
      ["the percent-encoded spelling a pip.conf carries", 'cp "$PIP_CONFIG_FILE" pip-copy.conf'],
    ])("finds %s (anything the agent can read counts)", async (_name, script) => {
      const f = await fixture();
      const rootPath = await f.workspace();
      // Characters a URL must encode, so the pip.conf spelling differs from the raw one.
      const token = `${fakeToken("i")}+/=${fakeToken("i")}`;
      await expect(prepareWorkspace({
        rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project([script]),
        registries: registries(CA, CA_PIP), registryCredentialProvider: providerOf({ "internal-npm": fakeToken("k"), "internal-pypi": token }),
      })).rejects.toThrow(/left a package registry token/);
      expect(await tainted(rootPath)).toBe(true);
    });

    it("a tainted workspace is wiped even when the project moved to a newer revision since", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      await expect(prepareWorkspace({ rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project(['cp "$NPM_CONFIG_USERCONFIG" .npmrc']), registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": fakeToken("a") }) })).rejects.toThrow(/left a package registry token/);
      const next = await prepareWorkspace({ rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project(["test ! -e .npmrc"], [], false, 2), registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": fakeToken("b") }) });
      expect(next).toMatchObject({ complete: true, projectRevision: 2 });
    });

    it.skipIf(process.getuid?.() === 0)("a search that cannot finish is not a clean one: an unreadable folder stops the preparation", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      try {
        const failure = await attempt(f, rootPath, fakeToken("l"), ["mkdir ../../locked && chmod 000 ../../locked"]).then(() => undefined, (error: Error) => error);
        expect(failure?.message).toMatch(/could not finish checking/);
        expect(await tainted(rootPath)).toBe(true);
      } finally {
        await chmod(join(rootPath, "locked"), 0o700).catch(() => undefined);
      }
    });

    it.skipIf(process.getuid?.() === 0)("a file the scan cannot open is an unfinished scan, not a clean one: it taints the workspace and logs why", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      const logged: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
      try {
        const failure = await attempt(f, rootPath, fakeToken("y"), ['echo data > ../../sealed.txt && chmod 000 ../../sealed.txt']).then(() => undefined, (error: Error) => error);
        expect(failure?.message).toMatch(/could not finish checking/);
        expect(await tainted(rootPath)).toBe(true);
      } finally {
        spy.mockRestore();
        await chmod(join(rootPath, "sealed.txt"), 0o600).catch(() => undefined);
      }
      const reason = logged.map((line) => { try { return JSON.parse(line) as { event?: string; reason?: string }; } catch { return {}; } }).find((entry) => entry.event === "registry.scan_unfinished");
      expect(reason?.reason).toBe("unreadable");
      expect(logged.join("\n")).not.toContain("sealed.txt");
    });

    describe("a token committed, stashed or written into .git (the objects are compressed)", () => {
      const gitSteps: Array<[string, string]> = [
        ["a commit", 'cp "$NPM_CONFIG_USERCONFIG" k.txt && git add k.txt && git -c user.name=t -c user.email=t@e.x commit -qm leak && git reset -q --hard HEAD~1'],
        ["a stash", 'cp "$NPM_CONFIG_USERCONFIG" k.txt && git add k.txt && git -c user.name=t -c user.email=t@e.x stash -q'],
        ["a loose object written by hash-object", 'git hash-object -w "$NPM_CONFIG_USERCONFIG" >/dev/null'],
        ["a new branch", "git branch sneaky"],
        ["a tag", "git tag sneaky"],
        ["a repository made by git init", "mkdir ../fresh && git -C ../fresh init -q"],
      ];
      it.each(gitSteps)("stops the preparation on %s and taints the workspace", async (_name, script) => {
        const f = await fixture();
        const rootPath = await f.workspace();
        const failure = await attempt(f, rootPath, fakeToken("g"), [script]).then(() => undefined, (error: Error) => error);
        expect(failure?.message).toMatch(/changed a repository's history or objects/);
        expect(await tainted(rootPath)).toBe(true);
        // The retry starts from a fresh clone.
        await expect(attempt(f, rootPath, fakeToken("h"), ["git branch --list sneaky | wc -l | grep -q '^ *0$'"])).resolves.toMatchObject({ complete: true });
      });

      it("ordinary work in the repository is not a change of history: files, the index and git status", async () => {
        const f = await fixture();
        const rootPath = await f.workspace();
        await expect(attempt(f, rootPath, fakeToken("w"), ["echo x > a.txt && git status --short >/dev/null && git diff --stat >/dev/null"], ["git status --short >/dev/null"])).resolves.toMatchObject({ complete: true });
      });
    });

    it("once a leak is found no later command runs (it could read the copy)", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      await expect(attempt(f, rootPath, fakeToken("z"), [], ['cp "$NPM_CONFIG_USERCONFIG" .npmrc', "echo ran > second-check.txt"])).rejects.toThrow(/left a package registry token/);
      await expect(stat(join(rootPath, "repo/api/second-check.txt"))).rejects.toThrow();
    });

    it("does not read Rovara's own config folder or private state: a clean run passes", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      await expect(attempt(f, rootPath, fakeToken("n"), ["mkdir -p node_modules/.cache && echo harmless > node_modules/.cache/x"], ["echo ok"])).resolves.toMatchObject({ complete: true });
    });

    it("a token issued for this workspace before, found in a file by its hash, stops a new attempt and taints the workspace", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      const old = fakeToken("o");
      await recordIssuedTokens(rootPath, [old]);
      await mkdir(join(rootPath, "leftover"), { recursive: true });
      await writeFile(join(rootPath, "leftover", "notes.txt"), `see registry\n//host/path/:_authToken=${old}\n`);
      await expect(attempt(f, rootPath, fakeToken("p"), [])).rejects.toThrow(/left a package registry token/);
      expect(await tainted(rootPath)).toBe(true);
      expect(await leftovers(rootPath)).toEqual([]);
      // The next attempt wipes the leftover and succeeds.
      await expect(attempt(f, rootPath, fakeToken("q"), [])).resolves.toMatchObject({ complete: true });
      expect(await filesCarrying(rootPath, old)).toEqual([]);
    });

    it("a workspace that holds no old token is not tainted by the hash scan (positive control for the scan itself)", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      await recordIssuedTokens(rootPath, [fakeToken("u")]);
      await expect(attempt(f, rootPath, fakeToken("v"), [])).resolves.toMatchObject({ complete: true });
    });

    it.skipIf(process.getuid?.() === 0)("fails closed and taints the workspace when the config folder cannot be removed (S2)", async () => {
      const f = await fixture();
      const rootPath = await f.workspace();
      // A step that makes the workspace root read-only: the config folder cannot be unlinked from it.
      const failure = await attempt(f, rootPath, fakeToken("s"), ["chmod 555 ../.."]).then(() => undefined, (error: Error) => error);
      try {
        expect(failure?.message).toMatch(/could not remove the package registry config/);
        expect((await readdir(rootPath)).filter((name) => name.startsWith(REGISTRY_CONFIG_PREFIX))).toHaveLength(1); // positive control: it is still there
        expect(await tainted(rootPath)).toBe(true);
      } finally {
        await chmod(rootPath, 0o755);
      }
      await expect(attempt(f, rootPath, fakeToken("w"), [])).resolves.toMatchObject({ complete: true });
      expect(await leftovers(rootPath)).toEqual([]);
    });
  });

  it("a project command's own env wins over the default, and a project without registries is untouched", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const manifest = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project([], ['echo "npmrc=${NPM_CONFIG_USERCONFIG:-unset}"']),
    });
    expect(manifest.readinessResults[0]!.stdout).toContain("npmrc=unset");
  });

  it("refuses a project with a devcontainer before it clones or asks for any token (the config folder is not mounted there)", async () => {
    const f = await fixture();
    const calls: string[] = [];
    await expect(prepareWorkspace({
      rootPath: await f.workspace(), materializer: f.materializer, creationIdentity: "op",
      project: project([], [], true), registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": fakeToken("d") }, calls),
    })).rejects.toThrow(/devcontainer cannot use private package registries/);
    expect(calls).toEqual([]);
  });

  it("a registry whose token cannot be had fails the preparation with no setup command run and no unauthenticated retry", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const ran = vi.fn(f.commandRunner);
    await expect(prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: ran, creationIdentity: "op",
      project: project(["echo should-not-run"]),
      registries: registries(CA), registryCredentialProvider: async () => { throw new Error("Rovara could not get a token for the package registry \"internal-npm\""); },
    })).rejects.toThrow(/internal-npm/);
    expect(ran).not.toHaveBeenCalled();
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("asks for the tokens before the first clone, so a slow clone cannot outlast the grant that authorizes the request", async () => {
    const f = await fixture();
    const order: string[] = [];
    await prepareWorkspace({
      rootPath: await f.workspace(), commandRunner: f.commandRunner, creationIdentity: "op", project: project([]),
      materializer: async (repo, target, credential) => { order.push("clone"); await f.materializer(repo, target, credential); },
      registries: registries(CA), registryCredentialProvider: async () => { order.push("token"); return { token: fakeToken("o"), expiresAt: expiry() }; },
    });
    expect(order).toEqual(["token", "clone"]);
  });

  it("removes a crashed preparation's leftover config at the start of the next one", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await mkdir(join(rootPath, `${REGISTRY_CONFIG_PREFIX}crashed`), { recursive: true });
    await writeFile(join(rootPath, `${REGISTRY_CONFIG_PREFIX}crashed`, "npmrc"), "_authToken=old");
    await prepareWorkspace({ rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project([]) });
    expect(await leftovers(rootPath)).toEqual([]);
  });
});

describe("the worker's request for a token", () => {
  const invocation = { workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", payload: { repositoryGrant: "signed-grant" } } as never;
  it("names the registry and presents the preparation's grant, and reads a strict answer", async () => {
    const token = fakeToken("w");
    const send = vi.fn(async () => new Response(JSON.stringify({ credential: { username: "aws", token, expiresAt: expiry() } }), { status: 200 }));
    const credential = await createRegistryCredentialProvider({ controlPlaneUrl: "https://broker.example/", invocation, fetchImplementation: send })("internal-npm");
    expect(credential.token).toBe(token);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://broker.example/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/registry-credentials");
    expect(init.headers).toMatchObject({ "x-agentx-repository-grant": "signed-grant" });
    expect(JSON.parse(init.body as string)).toEqual({ registry: "internal-npm" });
  });
  it("carries nothing of a refusal or an unreadable answer: a fixed sentence naming the registry", async () => {
    for (const response of [new Response(`denied ${fakeToken("n")}`, { status: 403 }), new Response(JSON.stringify({ credential: { token: "short" } }), { status: 200 }), new Response("not json", { status: 200 })]) {
      const failure = await createRegistryCredentialProvider({ controlPlaneUrl: "https://broker.example", invocation, fetchImplementation: async () => response })("internal-npm").then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('Rovara could not get a token for the package registry "internal-npm"');
      expect(failure?.message).not.toContain("denied");
    }
  });
  it("is listed on /ping, so the broker sends registries to this worker", () => {
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("prepare.registries.v1");
  });
});

void dirname;
