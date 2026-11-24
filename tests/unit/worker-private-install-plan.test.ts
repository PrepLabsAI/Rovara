// Private packages P2a: what the install step decides before any token exists (the repository's `.npmrc` against an allow-list, the manager from the lockfile) and how it reads a run (fixed outcome codes). Pure, no Docker.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyInstallOutput, inspectRepository, installCommand, nameableKey, parseNpmrc, renderDerivedNpmrc, renderUserNpmrc, renderYarnrc, selectManager,
} from "../../packages/worker/src/private-install-plan.js";

const canary = (): string => `ghp_${randomBytes(24).toString("base64url")}`;
const run = (exitCode: number | null, stderr: string, extra: { stdout?: string; timedOut?: boolean } = {}) => ({ exitCode, stdout: extra.stdout ?? "", stderr, ...(extra.timedOut === undefined ? {} : { timedOut: extra.timedOut }) });

describe("the repository's .npmrc is checked against an allow-list", () => {
  const refused: Array<[string, string, string]> = [
    ["script-shell", "script-shell=sh", "script-shell"],
    ["node-options", "node-options=--require /tmp/x.js", "node-options"],
    ["globalconfig", "globalconfig=/etc/x", "globalconfig"],
    ["userconfig", "userconfig=/tmp/x", "userconfig"],
    ["prefix", "prefix=/tmp", "prefix"],
    ["cache", "cache=/tmp/c", "cache"],
    ["proxy", "proxy=http://evil.example:3128", "proxy"],
    ["https-proxy", "https-proxy=http://evil.example:3128", "https-proxy"],
    ["ca", "ca=abc", "ca"],
    ["cafile", "cafile=/tmp/ca.pem", "cafile"],
    ["always-auth", "always-auth=true", "always-auth"],
    ["_auth", "_auth=dXNlcjpwYXNz", "_auth"],
    ["another host's token", "//registry.example.com/:_authToken=abc", "//registry.example.com/:_authToken"],
    ["another host's password", "//registry.example.com/:_password=abc", "//registry.example.com/:_password"],
    ["an unscoped token", "_authToken=abc", "_authToken"],
    ["an env expansion outside the auth line", "loglevel=${EVIL}", "loglevel"],
    ["a registry that is not public", "registry=https://evil.example/", "registry"],
    ["a company scope rerouted to another host", "@acme:registry=https://registry.npmjs.org/", "@acme:registry"],
    ["a scope sent to an unknown host", "@other:registry=https://evil.example/", "@other:registry"],
    ["a plain http registry", "registry=http://registry.npmjs.org/", "registry"],
    ["an INI section", "[section]", "(a line without a name)"],
  ];
  it.each(refused)("refuses %s and names the KEY only", (_label, line, key) => {
    const reading = parseNpmrc(`loglevel=warn\n${line}\n`, ["@acme"]);
    expect(reading).toEqual({ ok: false, key });
  });

  it("never names a value, even when the refused line carries a token-shaped one", () => {
    const token = canary();
    for (const line of [`always-auth=${token}`, `script-shell=${token}`, token, `//registry.example.com/:_authToken=${token}`]) {
      const reading = parseNpmrc(`${line}\n`, []);
      expect(reading.ok).toBe(false);
      expect(JSON.stringify(reading)).not.toContain(token);
    }
  });

  it("keeps harmless switches and the public registry, routes GitHub Packages scopes, and DROPS the auth line whatever its value", () => {
    const reading = parseNpmrc([
      "; a comment", "# another", "", "engine-strict=true", "legacy-peer-deps=true", "save-prefix=~", "loglevel=warn",
      "registry=https://registry.npmjs.org/", "@acme:registry=https://npm.pkg.github.com", "@other:registry=https://registry.npmjs.org/",
      "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}",
    ].join("\n"), ["@acme"]);
    expect(reading).toEqual({
      ok: true, droppedAuth: true, githubScopes: ["@acme"],
      kept: ["engine-strict=true", "legacy-peer-deps=true", "save-prefix=~", "loglevel=warn", "registry=https://registry.npmjs.org/", "@other:registry=https://registry.npmjs.org/"],
    });
  });

  it("a literal committed token on the GitHub Packages line is dropped, not kept", () => {
    const token = canary();
    const reading = parseNpmrc(`@acme:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${token}\n`, ["@acme"]);
    expect(reading).toMatchObject({ ok: true, droppedAuth: true });
    expect(JSON.stringify(reading)).not.toContain(token);
  });

  it("names a key only when it is plain; a line with no name=value is never named", () => {
    expect(nameableKey("script-shell", true)).toBe("script-shell");
    expect(nameableKey(canary(), false)).toBe("(a line without a name)");
    expect(nameableKey("a b", true)).toBe("(a line without a name)");
  });
});

describe("the token files", () => {
  it("the user config has the routing and exactly ONE host-keyed token line, no unscoped token, no _auth, no always-auth", () => {
    const token = canary();
    const text = renderUserNpmrc(["@b", "@a", "@a"], token);
    expect(text).toBe(`@a:registry=https://npm.pkg.github.com/\n@b:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${token}\n`);
    expect(text.split("\n").filter((line) => line.includes(token))).toHaveLength(1);
    expect(text).not.toMatch(/always-auth|^_auth|^_authToken|:_auth=/mu);
  });

  it("the derived copy is the kept lines plus our routing plus one token line, and nothing of the repository's own auth", () => {
    const token = canary();
    const text = renderDerivedNpmrc(["engine-strict=true", "registry=https://registry.npmjs.org/"], ["@acme"], token);
    expect(text.split("\n").filter((line) => line.includes("_authToken"))).toEqual([`//npm.pkg.github.com/:_authToken=${token}`]);
    expect(text).toContain("engine-strict=true");
    expect(text).not.toMatch(/always-auth|_password|\$\{/u);
  });

  it("the yarn 1 rc routes the scopes and carries the one host-keyed token", () => {
    const token = canary();
    expect(renderYarnrc(["@acme"], token)).toBe(`"@acme:registry" "https://npm.pkg.github.com/"\n"//npm.pkg.github.com/:_authToken" "${token}"\n`);
  });
});

describe("the manager comes from the lockfile, never from the repository's own pin", () => {
  it.each([
    [["npm"], { ok: true, manager: "npm" }],
    [["yarn1"], { ok: true, manager: "yarn1" }],
    [[], { ok: false, outcome: "refused_no_lockfile" }],
    [["npm", "yarn1"], { ok: false, outcome: "refused_ambiguous_lockfile" }],
    [["pnpm"], { ok: false, outcome: "refused_manager_not_in_image" }],
    [["berry"], { ok: false, outcome: "refused_manager_not_in_image" }],
  ] as const)("%j", (lockfiles, expected) => {
    expect(selectManager(lockfiles)).toEqual(expected);
  });

  it("the commands are fixed: the image's own program, scripts off; yarn 1 reads its npm userconfig (a `--no-default-rc` yarn 1 sends no token), the repository's rc files being replaced in the container", () => {
    expect(installCommand("npm")).toEqual(["/usr/local/bin/npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=warn", "--include=dev"]);
    const yarn = installCommand("yarn1");
    expect(yarn.slice(0, 2)).toEqual(["/usr/local/bin/yarn", "install"]);
    for (const flag of ["--frozen-lockfile", "--ignore-scripts", "--non-interactive", "--use-yarnrc"]) expect(yarn).toContain(flag);
    expect(yarn).not.toContain("--no-default-rc");
    expect(yarn.join(" ")).not.toMatch(/\.yarn\/releases|yarn-path/u);
  });
});

describe("inspecting a repository reads files and runs nothing", () => {
  async function repo(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-inspect-"));
    for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
    return directory;
  }

  it("a repository that names GitHub Packages in its lockfile or .npmrc is one the step must handle; others are not", async () => {
    expect((await inspectRepository(await repo({ "package-lock.json": '{"packages":{"x":{"resolved":"https://registry.npmjs.org/x"}}}' }))).namesHost).toBe(false);
    expect((await inspectRepository(await repo({ "package-lock.json": '{"packages":{"x":{"resolved":"https://npm.pkg.github.com/download/@a/x/1/x.tgz"}}}' }))).namesHost).toBe(true);
    expect((await inspectRepository(await repo({ "yarn.lock": "x@1:\n  resolved \"https://registry.yarnpkg.com/x\"\n", ".npmrc": "@acme:registry=https://npm.pkg.github.com/\n" }))).namesHost).toBe(true);
  });

  it("tells yarn 1 from Berry by the lockfile's metadata block, and sees several lockfiles", async () => {
    expect((await inspectRepository(await repo({ "yarn.lock": "# yarn lockfile v1\n\nx@1:\n  version \"1\"\n" }))).lockfiles).toEqual(["yarn1"]);
    expect((await inspectRepository(await repo({ "yarn.lock": "__metadata:\n  version: 8\n" }))).lockfiles).toEqual(["berry"]);
    expect((await inspectRepository(await repo({ "package-lock.json": "{}", "yarn.lock": "x" }))).lockfiles.sort()).toEqual(["npm", "yarn1"]);
    expect((await inspectRepository(await repo({ "pnpm-lock.yaml": "x" }))).lockfiles).toEqual(["pnpm"]);
  });

  it("the lockfile digest changes with the lockfile", async () => {
    const a = await inspectRepository(await repo({ "package-lock.json": "{\"a\":1}" }));
    const b = await inspectRepository(await repo({ "package-lock.json": "{\"a\":2}" }));
    expect(a.lockfileSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(a.lockfileSha256).not.toBe(b.lockfileSha256);
  });

  it("a .npmrc that is a link is 'other', never read through", async () => {
    const directory = await repo({ "package-lock.json": "{}" });
    const elsewhere = join(directory, "real-npmrc");
    await writeFile(elsewhere, "loglevel=warn\n");
    await symlink(elsewhere, join(directory, ".npmrc"));
    expect((await inspectRepository(directory)).npmrc).toEqual({ kind: "other" });
    await mkdir(join(directory, "sub"));
    expect((await inspectRepository(join(directory, "sub"))).npmrc).toEqual({ kind: "absent" });
  });

  it("a .yarnrc is 'absent', a regular file with its text, or 'other' (a link), and never read through", async () => {
    expect((await inspectRepository(await repo({ "yarn.lock": "x" }))).yarnrc).toEqual({ kind: "absent" });
    expect((await inspectRepository(await repo({ "yarn.lock": "x", ".yarnrc": "registry \"https://registry.yarnpkg.com\"\n" }))).yarnrc).toEqual({ kind: "file", text: "registry \"https://registry.yarnpkg.com\"\n" });
    const directory = await repo({ "yarn.lock": "x" });
    await writeFile(join(directory, "real-yarnrc"), "x\n");
    await symlink(join(directory, "real-yarnrc"), join(directory, ".yarnrc"));
    expect((await inspectRepository(directory)).yarnrc).toEqual({ kind: "other" });
  });
});

describe("one run is reduced to a fixed outcome code", () => {
  const token = canary();
  const cases: Array<[string, ReturnType<typeof run>, string]> = [
    ["a clean exit", run(0, ""), "installed"],
    ["E401 from the supported host", run(1, "npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fx"), "untested_refused"],
    ["E403 from the supported host", run(1, "npm error code E403\nnpm error 403 Forbidden - GET https://npm.pkg.github.com/download/@acme/x/1.0.0/x.tgz"), "untested_refused"],
    ["a 404 on a supported scope", run(1, "npm error code E404\nnpm error 404 Not Found - GET https://npm.pkg.github.com/@acme%2fx"), "untested_refused"],
    ["yarn's 401", run(1, 'error An unexpected error occurred: "https://npm.pkg.github.com/@acme%2fx: Request failed \\"401 Unauthorized\\"".'), "untested_refused"],
    ["a 401 from a PUBLIC host", run(1, "npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/left-pad"), "failed_public_registry"],
    ["the host not on the install's egress list", run(1, "npm error code ENOTFOUND\nnpm error errno ENOTFOUND\nnpm error network request to https://npm.pkg.github.com/@acme%2fx failed, reason: getaddrinfo ENOTFOUND npm.pkg.github.com"), "registry_unreachable"],
    ["yarn's DNS failure", run(1, "error An unexpected error occurred: \"https://npm.pkg.github.com/x: getaddrinfo ENOTFOUND npm.pkg.github.com\"."), "registry_unreachable"],
    ["a timeout", run(1, "npm error code ETIMEDOUT"), "failed_network"],
    ["a reset", run(1, "npm error code ECONNRESET\nnpm error network aborted"), "failed_network"],
    ["a temporary DNS failure", run(1, "npm error code EAI_AGAIN"), "failed_network"],
    ["a 503", run(1, "npm error 503 Service Unavailable - GET https://npm.pkg.github.com/x"), "failed_network"],
    ["an engine mismatch", run(1, "npm error code EBADENGINE\nnpm error engine Unsupported engine"), "failed_engine"],
    ["a container timeout", run(null, "", { timedOut: true }), "failed_timeout"],
    ["a clean exit that a timeout ended", run(0, "", { timedOut: true }), "failed_timeout"],
    ["anything else", run(1, "npm error something nobody planned for"), "failed_unknown"],
    ["a version number that looks like a status", run(1, "npm error while installing https://npm.pkg.github.com/x/1.404.0"), "failed_unknown"],
  ];
  it.each(cases)("%s", (_label, result, outcome) => {
    expect(classifyInstallOutput(result)).toBe(outcome);
  });

  it("looks at the output only: the answer never carries a word of it", () => {
    const answer = classifyInstallOutput(run(1, `npm error 401 Unauthorized - GET https://npm.pkg.github.com/x ${token}`));
    expect(answer).toBe("untested_refused");
    expect(answer).not.toContain(token);
  });
});
