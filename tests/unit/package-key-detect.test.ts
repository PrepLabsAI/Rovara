// Lane P5a (DEC 435 delta D4, D1, D6): the package-key detector. Static (config files, before any install), dynamic (the scrubbed output of ONE failed install), the served state, the quiet reminder card.
// Tokens in these tests are FAKE and built at runtime.
import { describe, expect, it } from "vitest";
import {
  PackageKeyReminderSchema,
  PackageKeyUntestedSchema,
  buildPackageKeyReminders,
  classifyInstallFailure,
  detectStaticPackageKeys,
  packageKeySentence,
  type InstallRepo,
  type PackageKeyFile,
} from "@agentx/contracts";
import { parseLockfile, parseNpmrc, parseYarnrcClassic, parseYarnrcYml } from "../../packages/contracts/src/package-key-parse.js";

const GH = "npm.pkg.github.com";
const FAKE_TOKEN = ["ghp", "_", "Q".repeat(36)].join("");
const noToken = () => false;
const hasToken = (host: string) => host === GH;
const files = (...entries: [string, string][]): PackageKeyFile[] => entries.map(([path, text]) => ({ path, text }));
const repo = (name: string, scopes: string[] = ["@acme"], host = GH): InstallRepo => ({ repo: name, registries: [{ host, scopes }] });

describe("static detection (before any install)", () => {
  it("a GitHub Packages scope in .npmrc with no company token is untested: missing, and says it needs no install", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", `@acme:registry=https://${GH}\n`]), hasCompanyToken: noToken });
    expect(result.untested).toEqual({ state: "untested", reason: "needs_package_key", detail: "missing", registryHost: GH, scopes: ["@acme"] });
    expect(PackageKeyUntestedSchema.parse(result.untested)).toEqual(result.untested);
  });

  it("the same scope WITH a company token for the host is not judged before install (the install decides)", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", `@acme:registry=https://${GH}/\n`]), hasCompanyToken: hasToken });
    expect(result.untested).toBeUndefined();
    expect(result.registries).toEqual([{ host: GH, scopes: ["@acme"], sources: ["npmrc"] }]);
  });

  it("asks only whether a token is set for the host, once per known host, never anything else", () => {
    const asked: string[] = [];
    detectStaticPackageKeys({ repo: "web", files: files([".npmrc", `@acme:registry=https://${GH}\n@b:registry=https://${GH}\n`]), hasCompanyToken: (host) => { asked.push(host); return false; } });
    expect(new Set(asked)).toEqual(new Set([GH]));
  });

  it("finds the host from a lockfile alone (package-lock resolved URL), with the scope from the tarball path", () => {
    const lock = JSON.stringify({ packages: { "node_modules/@acme/ui": { resolved: `https://${GH}/download/@acme/ui/1.2.3/abcdef`, version: "1.2.3" }, "node_modules/left-pad": { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" } } }, null, 2);
    const result = detectStaticPackageKeys({ repo: "web", files: files(["package-lock.json", lock]), hasCompanyToken: noToken });
    expect(result.untested).toMatchObject({ detail: "missing", registryHost: GH, scopes: ["@acme"] });
    expect(result.registries.map((registry) => registry.host)).toEqual([GH]);
  });

  it("reads yarn.lock and pnpm-lock resolved and tarball URLs", () => {
    const yarn = parseLockfile(`"@acme/ui@^1":\n  version "1.0.0"\n  resolved "https://${GH}/download/@acme/ui/1.0.0/aa#bb"\n`);
    const pnpm = parseLockfile(`packages:\n  '@acme/ui@1.0.0':\n    resolution: {tarball: https://${GH}/download/@acme/ui/1.0.0/aa}\n`);
    expect(yarn.refs).toEqual([{ host: GH, scope: "@acme", source: "lockfile" }]);
    expect(pnpm.refs).toEqual([{ host: GH, scope: "@acme", source: "lockfile" }]);
  });

  it("reads Yarn Berry npmScopes and npmRegistryServer (scope names have no @ in the file)", () => {
    const yml = ["nodeLinker: node-modules", "npmScopes:", "  acme:", `    npmRegistryServer: "https://${GH}"`, "  \"other\":", "    npmRegistryServer: https://registry.npmjs.org", "npmRegistryServer: \"https://registry.yarnpkg.com\"", ""].join("\n");
    const result = detectStaticPackageKeys({ repo: "web", files: files([".yarnrc.yml", yml]), hasCompanyToken: noToken });
    expect(result.untested).toMatchObject({ registryHost: GH, scopes: ["@acme"] });
    expect(result.registries).toEqual([{ host: GH, scopes: ["@acme"], sources: ["yarnrc"] }]);
  });

  it("reads classic .yarnrc scope lines and a Berry npmRegistries host key", () => {
    expect(parseYarnrcClassic(`"@acme:registry" "https://${GH}"\nregistry "https://registry.yarnpkg.com"\n`).refs.map((ref) => [ref.host, ref.scope])).toEqual([[GH, "@acme"], ["registry.yarnpkg.com", undefined]]);
    const yml = parseYarnrcYml(["npmRegistries:", `  "//${GH}":`, "    npmAlwaysAuth: true", ""].join("\n"), ".yarnrc.yml");
    expect(yml.refs).toEqual([{ host: GH, source: "yarnrc" }]);
  });

  it("a private non-GitHub host is recorded but needs no verdict before install (only the install can tell)", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", "@corp:registry=https://npm.corp.example.com/\n"]), hasCompanyToken: noToken });
    expect(result.untested).toBeUndefined();
    expect(result.registries).toEqual([{ host: "npm.corp.example.com", scopes: ["@corp"], sources: ["npmrc"] }]);
  });

  it("public registries and git hosts are not private registries", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", "registry=https://registry.npmjs.org/\n@a:registry=https://registry.yarnpkg.com\n"], ["yarn.lock", "  resolved \"https://codeload.github.com/o/r/tar.gz/abc\"\n"]), hasCompanyToken: noToken });
    expect(result).toEqual({ repo: "web", registries: [], committedTokens: [] });
  });

  it("ignores files it does not know, comments, and malformed lines", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files(["README.md", `@acme:registry=https://${GH}`], [".npmrc", `# @acme:registry=https://${GH}\n; x\n@acme:registry\n=oops\n@acme:registry=not a url\n`]), hasCompanyToken: noToken });
    expect(result.untested).toBeUndefined();
    expect(result.registries).toEqual([]);
  });

  it("a nested file is read by its base name", () => {
    const result = detectStaticPackageKeys({ repo: "web", files: files(["packages/ui/.npmrc", `@acme:registry=https://${GH}`]), hasCompanyToken: noToken });
    expect(result.untested?.scopes).toEqual(["@acme"]);
  });

  it("scopes are bounded, sorted and valid only", () => {
    const text = [...Array.from({ length: 12 }, (_, index) => `@s${String(index).padStart(2, "0")}:registry=https://${GH}`), `@BAD NAME:registry=https://${GH}`].join("\n");
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", text]), hasCompanyToken: noToken });
    expect(result.untested?.scopes).toEqual(["@s00", "@s01", "@s02", "@s03", "@s04", "@s05", "@s06", "@s07"]);
  });
});

describe("a token committed in a repository file is reported, never with its value", () => {
  it(".npmrc _authToken: file, line and host only", () => {
    const npmrc = `@acme:registry=https://${GH}\n//${GH}/:_authToken=${FAKE_TOKEN}\n`;
    const result = detectStaticPackageKeys({ repo: "web", files: files([".npmrc", npmrc]), hasCompanyToken: noToken });
    expect(result.committedTokens).toEqual([{ file: ".npmrc", line: 2, host: GH }]);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(result)).not.toContain("Q".repeat(8));
    // a committed token is never USED: the company token is still missing, so the repository is untested.
    expect(result.untested?.detail).toBe("missing");
  });

  it("reports the bare, _auth and _password forms, and quoted values; not an env-var reference or an empty value", () => {
    const npmrc = [`_authToken=${FAKE_TOKEN}`, `//r.example.com/:_auth="${FAKE_TOKEN}"`, `//r.example.com/:_password=${FAKE_TOKEN}`, `//${GH}/:_authToken=\${NPM_TOKEN}`, `//${GH}/:_authToken=`].join("\n");
    const parsed = parseNpmrc(npmrc, ".npmrc");
    expect(parsed.committed).toEqual([{ file: ".npmrc", line: 1, host: undefined }, { file: ".npmrc", line: 2, host: "r.example.com" }, { file: ".npmrc", line: 3, host: "r.example.com" }]);
  });

  it("reports Berry npmAuthToken under a scope, a registry and the top level, and not a ${ENV} value", () => {
    const yml = ["npmAuthToken: top-literal-value", "npmScopes:", "  acme:", `    npmRegistryServer: https://${GH}`, `    npmAuthToken: ${FAKE_TOKEN}`, "  env:", "    npmAuthToken: ${NPM_TOKEN}", "npmRegistries:", `  "//other.example.com":`, `    npmAuthIdent: "${FAKE_TOKEN}"`, ""].join("\n");
    const parsed = parseYarnrcYml(yml, ".yarnrc.yml");
    expect(parsed.committed).toEqual([{ file: ".yarnrc.yml", line: 1 }, { file: ".yarnrc.yml", line: 5, host: GH }, { file: ".yarnrc.yml", line: 10, host: "other.example.com" }]);
    expect(JSON.stringify(parsed)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(parsed)).not.toContain("top-literal");
  });
});

const E401 = ["npm error code E401", `npm error 401 Unauthorized - GET https://${GH}/@acme%2fui`, "npm error Unable to authenticate, your authentication token seems to be invalid."].join("\n");
const E403 = ["npm ERR! code E403", `npm ERR! 403 403 Forbidden - GET https://${GH}/download/@acme/ui/1.0.0/abc`, "npm ERR! 403 In most cases, you or one of your dependencies are requesting"].join("\n");
const GH_SENTENCE = ["npm error code E403", "npm error 403 Forbidden - Permission permission_denied: The token provided is not allowed to read organization package @acme/ui"].join("\n");
const ok = (input: Partial<Parameters<typeof classifyInstallFailure>[0]> & { output: string }) => classifyInstallFailure({ exitCode: 1, repos: [repo("web")], hasCompanyToken: noToken, ...input });

describe("dynamic detection (one failed install)", () => {
  it("npm E401 on GitHub Packages is needs_package_key: missing", () => {
    expect(ok({ output: E401 })).toEqual({ outcome: "needs_package_key", host: GH, otherHosts: [], repos: [{ repo: "web", untested: { state: "untested", reason: "needs_package_key", detail: "missing", registryHost: GH, scopes: ["@acme"] } }] });
  });

  it("npm E403 on GitHub Packages is needs_package_key", () => {
    expect(ok({ output: E403 })).toMatchObject({ outcome: "needs_package_key", host: GH });
  });

  it("GitHub's 'not allowed to read organization package' sentence counts, even with no URL on its line", () => {
    expect(ok({ output: "npm error Permission permission_denied: not allowed to Read organization package", repos: [repo("web", [])] })).toMatchObject({ outcome: "needs_package_key", host: GH });
    expect(ok({ output: GH_SENTENCE })).toMatchObject({ outcome: "needs_package_key", host: GH });
  });

  it("refused when a token was used, missing when none was; the token is only ever asked about by host", () => {
    expect(ok({ output: E401, hasCompanyToken: hasToken })).toMatchObject({ repos: [{ untested: { detail: "refused" } }] });
    expect(ok({ output: E401, hasCompanyToken: noToken })).toMatchObject({ repos: [{ untested: { detail: "missing" } }] });
  });

  it("GitHub Packages hides a package the token cannot read as a 404: that is a refusal on a private host", () => {
    expect(ok({ output: `npm error code E404\nnpm error 404 Not Found - GET https://${GH}/@acme%2fui`, hasCompanyToken: hasToken })).toMatchObject({ repos: [{ untested: { detail: "refused" } }] });
  });

  it("each status word alone is enough: '404 Not Found', '403 Forbidden' and '401 Unauthorized' lines with no E-code line", () => {
    for (const status of ["404 Not Found", "403 Forbidden", "401 Unauthorized"]) expect(ok({ output: `npm error ${status} - GET https://${GH}/@acme%2fui` })).toMatchObject({ outcome: "needs_package_key", host: GH });
  });

  it("yarn 1, Yarn Berry (status and URL on separate lines) and pnpm outputs", () => {
    const yarn = `error An unexpected error occurred: "https://${GH}/download/@acme/ui/1.0.0/x: Request failed \\"401 Unauthorized\\"".`;
    const berry = ["➤ YN0035: │ @acme/ui@npm:^1.0.0: The remote server failed to provide the requested resource", "➤ YN0035: │   Response Code: 403 (Forbidden)", "➤ YN0035: │   Request Method: GET", `➤ YN0035: │   Request URL: https://${GH}/@acme%2fui`].join("\n");
    const pnpm = `ERR_PNPM_FETCH_401  GET https://${GH}/@acme%2fui: Unauthorized - 401`;
    for (const output of [yarn, berry, pnpm]) expect(ok({ output })).toMatchObject({ outcome: "needs_package_key", host: GH });
  });

  it("a private host of the repo's own (a scope routed by .npmrc) counts for 401 and 403; the scope is kept", () => {
    const output = "npm error code E401\nnpm error 401 Unauthorized - GET https://npm.corp.example.com/@corp%2fkit";
    expect(ok({ output, repos: [repo("api", ["@corp"], "npm.corp.example.com")] })).toMatchObject({ outcome: "needs_package_key", host: "npm.corp.example.com", repos: [{ untested: { registryHost: "npm.corp.example.com", scopes: ["@corp"] } }] });
  });

  it("a shared ROOT install marks every repository under it untested, not failed", () => {
    const result = ok({ output: E401, repos: [repo("web"), repo("api", []), repo("docs", ["@other"])] });
    expect(result).toMatchObject({ outcome: "needs_package_key" });
    if (result.outcome !== "needs_package_key") throw new Error("expected needs_package_key");
    expect(result.repos.map((row) => row.repo)).toEqual(["web", "api", "docs"]);
    expect(result.repos.map((row) => row.untested.scopes)).toEqual([["@acme"], ["@acme"], ["@acme", "@other"]]);
    for (const row of result.repos) expect(PackageKeyUntestedSchema.safeParse(row.untested).success).toBe(true);
  });

  it("a second refusing host is named, the first is the state", () => {
    const output = `${E401}\nnpm error 403 Forbidden - GET https://npm.corp.example.com/@corp%2fkit`;
    expect(ok({ output, repos: [{ repo: "web", registries: [{ host: GH, scopes: [] }, { host: "npm.corp.example.com", scopes: ["@corp"] }] }] })).toMatchObject({ host: GH, otherHosts: ["npm.corp.example.com"] });
  });
});

describe("dynamic detection never misclassifies", () => {
  it.each([
    ["ENOTFOUND on the private host (a DNS block or a network error)", `npm error code ENOTFOUND\nnpm error network request to https://${GH}/@acme%2fui failed, reason: getaddrinfo ENOTFOUND ${GH}`],
    ["ETIMEDOUT / ECONNRESET", `npm error code ETIMEDOUT\nnpm error network request to https://${GH}/@acme%2fui failed, reason: connect ETIMEDOUT 140.82.112.34:443\nnpm error code ECONNRESET`],
    ["a public 404", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/no-such-package-xyz\nnpm error 404 'no-such-package-xyz@*' is not in this registry."],
    ["a public 403 (a rate limit or a blocked package)", "npm error code E403\nnpm error 403 403 Forbidden - GET https://registry.npmjs.org/some-pkg"],
    ["a 403 from an unrelated host", "npm error 403 Forbidden - GET https://cdn.unrelated.example.org/file.tgz"],
    ["a git dependency 403", "npm error command git --no-replace-objects ls-remote ssh://git@github.com/o/r.git\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"],
    ["a build failure", "npm error code 1\nnpm error command failed\nsh: tsc: command not found\nError: Cannot find module 'x' (E-401 is in the file name e-401.js)"],
    ["a test failure that prints 401", "FAIL src/auth.test.ts\n  expected status 401 Unauthorized to equal 200"],
  ])("%s is `other`", (_name, output) => {
    expect(ok({ output, repos: [repo("web")] })).toEqual({ outcome: "other" });
  });

  it("a 403 on a public registry beside a good private fetch is still `other` (no cross-line borrowing when the line names its own URL)", () => {
    const output = `npm http fetch GET 200 https://${GH}/@acme%2fui 40ms\nnpm error 403 Forbidden - GET https://registry.npmjs.org/x`;
    expect(ok({ output })).toEqual({ outcome: "other" });
  });

  it("an install that exited 0 is never a failure, whatever its warnings say", () => {
    expect(ok({ output: E401, exitCode: 0 })).toEqual({ outcome: "other" });
  });

  it("no repositories, empty output and a huge line do not throw or classify", () => {
    expect(ok({ output: E401, repos: [] })).toEqual({ outcome: "other" });
    expect(ok({ output: "" })).toEqual({ outcome: "other" });
    expect(ok({ output: `401${" ".repeat(200_000)}Unauthorized` })).toEqual({ outcome: "other" });
  });

  it("a killed install (exit null) is judged by its output", () => {
    expect(ok({ output: E401, exitCode: null })).toMatchObject({ outcome: "needs_package_key" });
  });
});

describe("the served state and the quiet reminder card", () => {
  const state = (detail: "missing" | "refused", scopes: string[] = ["@acme"], host = GH) => ({ state: "untested", reason: "needs_package_key", detail, registryHost: host, scopes }) as const;

  it("the state is exactly D1's shape and rejects extra or invalid fields", () => {
    expect(PackageKeyUntestedSchema.safeParse(state("missing")).success).toBe(true);
    for (const bad of [{ ...state("missing"), extra: 1 }, { ...state("missing"), detail: "gone" }, { ...state("missing"), registryHost: "Bad Host" }, { ...state("missing"), scopes: ["acme"] }, { ...state("missing"), scopes: Array.from({ length: 9 }, (_, index) => `@s${String(index)}`) }, { ...state("missing"), state: "ready" }]) {
      expect(PackageKeyUntestedSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("one card per company and host, however many repositories and projects, with the plain sentence", () => {
    const cards = buildPackageKeyReminders([
      { companyId: "c1", projectId: "p1", repo: "web", state: state("missing") },
      { companyId: "c1", projectId: "p1", repo: "web", state: state("missing") },
      { companyId: "c1", projectId: "p2", repo: "api", state: state("refused", ["@b"]) },
      { companyId: "c1", repo: "corp", state: state("missing", ["@corp"], "npm.corp.example.com") },
      { companyId: "c2", projectId: "p9", repo: "web", state: state("missing") },
    ]);
    expect(cards.map((card) => [card.companyId, card.registryHost])).toEqual([["c1", "npm.corp.example.com"], ["c1", GH], ["c2", GH]]);
    const github = cards[1]!;
    expect(github.repos.map((row) => [row.repo, row.projectId])).toEqual([["api", "p2"], ["web", "p1"]]);
    expect(github.sentence).toBe("api, web need a package token to install and test.");
    expect(github).toMatchObject({ scopes: ["@acme", "@b"], detail: "refused", needsYou: false, badge: false, notification: false });
    expect(cards[2]!.sentence).toBe("web needs a package token to install and test.");
    expect(packageKeySentence(["web"])).toBe("web needs a package token to install and test.");
    for (const card of cards) expect(PackageKeyReminderSchema.safeParse(card).success).toBe(true);
  });

  it("the card can never claim to be a Needs-you item, a badge or a notification", () => {
    const card = buildPackageKeyReminders([{ companyId: "c1", repo: "web", state: state("missing") }])[0]!;
    for (const flag of ["needsYou", "badge", "notification"] as const) expect(PackageKeyReminderSchema.safeParse({ ...card, [flag]: true }).success).toBe(false);
  });

  it("nothing in, no card", () => {
    expect(buildPackageKeyReminders([])).toEqual([]);
  });
});
