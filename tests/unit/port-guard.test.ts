import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NAMES,
  GuardError,
  addedLines,
  cloudImportReason,
  cloudPathRule,
  formatFinding,
  importFindings,
  lineFindings,
  loadPrivatePatterns,
  main,
  nameSourceFromWords,
  runGuard,
  splitNameFindings,
  type Finding,
  type NameSource,
} from "../../scripts/port-guard.js";

// This file feeds the guard what it forbids, so none of the forbidden text is written out here: the names are INVENTED ones that the tests
// put on an injected name list (the real list is hashed in the guard and never appears in the repository), directory names are assembled
// at run time, and key-shaped strings are random. (The guard scans this very file in CI, and GitHub refuses key-shaped strings.)
const j = (...parts: string[]): string => parts.join("");
const ORG = j("o", "rg");
const SPEND = j("spe", "nd");
const AUDIT = j("aud", "it");
const TEAM_RECORD = j("team", "-", "record");
const DEVICES = j("devi", "ces");
const PROSPECT = "Zorblax Corp";
const INVENTED_ID = "424242424242";
const BUILD_DETECTOR = "glorpnik";

/** Invented names on a list built in the test, in the shapes the real list has: one word, a two-word join, a three-word join, a digit form. */
const TEST_SALT = "test-salt";
const INVENTED: NameSource = nameSourceFromWords(
  TEST_SALT,
  {
    "a prospect or customer name": ["zorblaxcorp", "zorblax7", "quennith", "vexlorn"],
    "an internal build-system name": ["zinkforge"],
    "a prospect pilot name": ["zorblaxscout", "zorblaxcrew"],
    "a prospect product name": ["acmewidgetworks"],
    "the staging account id": [INVENTED_ID],
    "the private repository name": ["zorblaxvault"],
  },
  [BUILD_DETECTOR],
  [],
  ["quennith", "zinkforge", "acmewidgetworks"],
);

/** A key-shaped string built at run time: gitleaks's access-key rule wants four letters and sixteen of A-Z and 2-7. */
function fakeAccessKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return `${j("AK", "IA")}${Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const hasGitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A lane in a temp repository: `base` is code/next, the work is committed on top by `commit()`. */
class Lane {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "port-guard-test-"));
    roots.push(this.dir);
    git(this.dir, "init", "-q", "-b", "code-next");
    this.write("README.md", "base\n");
    this.write("packages/broker/src/tasks.ts", 'export const tasks = 1;\n');
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "base");
    git(this.dir, "branch", "base");
    git(this.dir, "switch", "-q", "-c", "lane");
  }
  write(path: string, text: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  commit(message = "lane"): void {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", message);
  }
  guard(options: { gitleaks?: "run" | "off"; allowGuardEdits?: boolean; gitleaksBin?: string; names?: NameSource } = {}): Finding[] {
    return runGuard({ cwd: this.dir, range: "base..lane", gitleaks: "off", names: INVENTED, ...options }).findings;
  }
}

let lane: Lane;
beforeEach(() => {
  lane = new Lane();
});

const rules = (findings: Finding[]): string[] => findings.map((finding) => finding.rule);

describe("port-guard on a temp repository", () => {
  it("passes a clean range", () => {
    lane.write("packages/worker/src/engine.ts", 'import { tasks } from "../../broker/src/tasks.js";\nexport const engine = tasks;\n');
    lane.write("docs/notes.md", "A plain note about a worker.\n");
    lane.commit();
    expect(lane.guard()).toEqual([]);
  });

  it("passes an empty range", () => {
    expect(lane.guard()).toEqual([]);
  });

  describe("rule (a): Cloud-only paths", () => {
    it.each([
      ["a company directory", `packages/broker/src/${ORG}/members.ts`],
      ["a budget directory", `packages/broker/src/${SPEND}/limits.ts`],
      ["an audit directory", `packages/broker/src/${AUDIT}/outbox.ts`],
      ["a team record directory", `packages/broker/src/${TEAM_RECORD}/store.ts`],
      ["a devices directory", `packages/broker/src/${DEVICES}/sessions.ts`],
      ["a directory in any case", `packages/broker/src/${ORG.toUpperCase()}/x.ts`],
      ["a Cloud-only contracts file", `packages/contracts/src/${ORG}-node.ts`],
      ["the Cloud web UI package", "packages/ui/src/App.tsx"],
      ["the Cloud web package", "packages/web/package.json"],
      ["the audit verifier package", `packages/${AUDIT}-verifier/src/index.ts`],
      ["the Cloud upgrade command", "packages/cli/src/upgrade/plan.ts"],
      ["a Cloud CDK stack", `infra/lib/${AUDIT}-ledger.ts`],
      ["a Cloud CDK stack for the web app", "infra/lib/web-app.ts"],
    ])("fails %s", (_name, path) => {
      lane.write(path, "export {};\n");
      lane.commit();
      const findings = lane.guard();
      expect(rules(findings)).toContain("cloud-path");
      expect(findings.find((f) => f.rule === "cloud-path")?.file).toBe(path);
    });

    it("lets a lane edit public's own six upgrade files and import them, but not add to that directory", () => {
      lane.write("packages/cli/src/upgrade/run.ts", "export const run = 1;\n");
      lane.write("packages/cli/src/main.ts", 'import { run } from "./upgrade/run.js";\nexport const main = run;\n');
      lane.commit();
      expect(lane.guard()).toEqual([]);
      lane.write("packages/cli/src/upgrade/plan.ts", "export const plan = 1;\n");
      lane.commit();
      expect(rules(lane.guard())).toEqual(["cloud-path"]);
    });

    it("keeps the company-scoped key scheme that Code ports on purpose", () => {
      lane.write(`packages/contracts/src/${ORG}-scoped-keys.ts`, "export const key = 1;\n");
      lane.commit();
      expect(lane.guard()).toEqual([]);
    });

    it("still fails a Cloud-only file that a later commit deletes, because the history is pushed too", () => {
      lane.write(`packages/broker/src/${ORG}/members.ts`, "export {};\n");
      lane.commit("add");
      git(lane.dir, "rm", "-q", "-r", `packages/broker/src/${ORG}`);
      git(lane.dir, "commit", "-q", "-m", "remove");
      const findings = lane.guard();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ rule: "cloud-path", file: `packages/broker/src/${ORG}/members.ts` });
      expect(findings[0]!.commit).toMatch(/^[0-9a-f]{8}$/);
    });

    it("lets a lane delete a Cloud-only file", () => {
      git(lane.dir, "switch", "-q", "base");
      lane.write(`packages/broker/src/${ORG}/members.ts`, "export {};\n");
      lane.commit("legacy");
      git(lane.dir, "switch", "-q", "lane");
      git(lane.dir, "reset", "-q", "--hard", "base");
      git(lane.dir, "rm", "-q", "-r", `packages/broker/src/${ORG}`);
      git(lane.dir, "commit", "-q", "-m", "drop");
      expect(lane.guard()).toEqual([]);
    });
  });

  describe("rule (b): imports of Cloud-only code", () => {
    it.each([
      ["a relative import of a Cloud-only directory", `import { m } from "./${ORG}/members.js";\n`],
      ["a relative import that climbs out of the package", `import { m } from "../../broker/src/${SPEND}/limits.js";\n`],
      ["a directory import with no file name", `import { m } from "./${AUDIT}";\n`],
      ["a Cloud-only contracts file", `import { m } from "../../contracts/src/${ORG}-budget.js";\n`],
      ["an export from", `export * from "./${TEAM_RECORD}/store.js";\n`],
      ["a dynamic import", `const m = await import("./${ORG}/members.js");\n`],
      ["a require", `const m = require("./${ORG}/members.js");\n`],
      ["a side-effect import", `import "./${ORG}/members.js";\n`],
      ["a test mock", `vi.mock("./${ORG}/members.js");\n`],
      ["a multi-line import", `import {\n  a,\n  b,\n} from "./${ORG}/members.js";\n`],
      ["the Cloud web UI package", `import { App } from "@agentx/${j("u", "i")}";\n`],
      ["the audit verifier package", `import { verify } from "@rovara/${AUDIT}-verifier";\n`],
      ["a Cloud-only subpath of a package", `import { out } from "@agentx/broker/${AUDIT}/outbox";\n`],
    ])("fails %s", (_name, source) => {
      lane.write("packages/worker/src/engine.ts", source);
      lane.commit();
      const findings = lane.guard();
      expect(rules(findings)).toContain("cloud-import");
      expect(findings.find((f) => f.rule === "cloud-import")?.file).toBe("packages/worker/src/engine.ts");
    });

    it("fails a file that already had the import when a later change touches it", () => {
      lane.write("packages/worker/src/engine.ts", `import { m } from "./${ORG}/members.js";\nexport const a = 1;\n`);
      lane.commit();
      git(lane.dir, "branch", "-f", "base");
      lane.write("packages/worker/src/engine.ts", `import { m } from "./${ORG}/members.js";\nexport const a = 2;\n`);
      lane.commit();
      expect(rules(lane.guard())).toContain("cloud-import");
    });

    it("fails an import added in one commit and removed in the next", () => {
      lane.write("packages/worker/src/engine.ts", `import { m } from "./${ORG}/members.js";\n`);
      lane.commit("add");
      lane.write("packages/worker/src/engine.ts", "export const a = 1;\n");
      lane.commit("remove");
      expect(rules(lane.guard())).toContain("cloud-import");
    });

    it("fails a package file that names a Cloud-only package", () => {
      lane.write("packages/worker/package.json", '{ "dependencies": { "@agentx/ui": "*" } }\n');
      lane.commit();
      expect(rules(lane.guard())).toContain("cloud-import");
    });

    it("lets ordinary imports through", () => {
      lane.write(
        "packages/worker/src/engine.ts",
        'import { readFileSync } from "node:fs";\nimport { z } from "zod";\nimport { tasks } from "../../broker/src/tasks.js";\nimport { x } from "@agentx/contracts";\nexport const a = [readFileSync, z, tasks, x];\n',
      );
      lane.commit();
      expect(lane.guard()).toEqual([]);
    });
  });

  describe("rule (c): the internal build-system detector", () => {
    it.each([
      `packages/worker/src/env-detect/${BUILD_DETECTOR}.ts`,
      `packages/worker/src/env-detect/${BUILD_DETECTOR}.test.ts`,
      `tests/unit/env-detect-${BUILD_DETECTOR}.test.ts`,
    ])("fails %s", (path) => {
      lane.write(path, "export {};\n");
      lane.commit();
      expect(rules(lane.guard())).toContain("build-detector");
    });

    it("passes the generic detector files", () => {
      lane.write("packages/worker/src/env-detect/node.ts", "export {};\n");
      lane.write("packages/worker/src/env-detect/node.test.ts", "export {};\n");
      lane.commit();
      expect(lane.guard()).toEqual([]);
    });
  });

  describe("rule (d): private names on added lines", () => {
    it.each([
      ["a prospect name", `// built for ${PROSPECT}\n`],
      ["the same name in one word", `const x = "${PROSPECT.replaceAll(" ", "").toLowerCase()}";\n`],
      ["a person's first name", "// ask Quennith about it\n"],
      ["another person's first name", "// ask Vexlorn about it\n"],
      ["an internal build host", 'const host = "zinkforge.internal";\n'],
      ["a pilot", "// the Zorblax scout\n"],
      ["a team", "// the zorblax-crew setup\n"],
      ["a three-word product", "// Acme Widget Works Engine\n"],
      ["a camel-case join", "const acmeWidgetWorks = 1;\n"],
      ["a snake-case join", "const zorblax_corp = 1;\n"],
      ["a name followed by a digit", "const quennith2 = 1;\n"],
      ["the staging account", `const a = "${INVENTED_ID}";\n`],
      ["an account id inside an ARN", `const arn = "arn:aws:iam::${"4".repeat(12)}:role/x";\n`],
      ["an account id inside an ARN with a region", `const arn = "arn:aws:sns:us-east-1:${"5".repeat(12)}:topic";\n`],
      ["an API Gateway host", `const url = "https://${"k3j4h5g6f7"}.execute-api.us-east-1.amazonaws.com/v1";\n`],
      ["a rovara dev host", `const url = "https://app.rovara.${j("d", "ev")}/x";\n`],
      ["the private repository", "// see Zorblax Vault\n"],
    ])("fails %s", (_name, line) => {
      lane.write("packages/worker/src/engine.ts", line);
      lane.commit();
      const findings = lane.guard();
      expect(rules(findings)).toEqual(["private-name"]);
      expect(findings[0]).toMatchObject({ file: "packages/worker/src/engine.ts", line: 1 });
    });

    it("fails in Markdown and JSON too, and reports the right line", () => {
      lane.write("docs/notes.md", `one\ntwo\nthree ${PROSPECT}\n`);
      lane.commit();
      expect(lane.guard()).toMatchObject([{ rule: "private-name", file: "docs/notes.md", line: 3 }]);
    });

    it("lets the AWS documentation placeholders through", () => {
      lane.write(
        "packages/worker/src/engine.ts",
        'const a = "arn:aws:iam::123456789012:role/x";\nconst b = "arn:aws:sts::111122223333:assumed-role/y";\nconst c = "https://abc123.execute-api.us-east-1.amazonaws.com";\nconst d = "execute-api.us-east-1.amazonaws.com";\nconst e = "arn:aws:iam::aws:policy/Z";\n',
      );
      lane.commit();
      expect(lane.guard()).toEqual([]);
    });

    it("does not read lines the range did not add", () => {
      git(lane.dir, "switch", "-q", "base");
      lane.write("docs/old.md", `old ${PROSPECT}\n`);
      lane.commit("legacy");
      git(lane.dir, "switch", "-q", "lane");
      git(lane.dir, "reset", "-q", "--hard", "base");
      lane.write("docs/old.md", `old ${PROSPECT}\nnew line\n`);
      lane.commit();
      // the legacy line is context; only the new line is added
      expect(lane.guard()).toEqual([]);
    });

    it("never prints the matched text", () => {
      lane.write("docs/notes.md", `${PROSPECT} ${INVENTED_ID}\n`);
      lane.commit();
      const printed = lane.guard().map(formatFinding).join("\n");
      expect(printed).not.toMatch(/zorblax/i);
      expect(printed).not.toContain(INVENTED_ID);
    });
  });

  describe("links and scan switches", () => {
    it("fails a symlink", () => {
      symlinkSync("README.md", join(lane.dir, "link"));
      lane.commit();
      expect(rules(lane.guard())).toEqual(["link"]);
    });

    it("fails an inline allow comment and a gitleaks config", () => {
      lane.write("packages/worker/src/engine.ts", `export const a = 1; // gitleaks:${"allow"}\n`);
      lane.write(".gitleaks.toml", "title = 'x'\n");
      lane.commit();
      const findings = lane.guard();
      expect(findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["scan-bypass"]));
      expect(findings.filter((f) => f.rule === "scan-bypass")).toHaveLength(2);
    });

    it("flags edits to the guard and the CI workflow unless the guard's own lane allows them", () => {
      lane.write("scripts/port-guard.ts", "export {};\n");
      lane.write(".github/workflows/ci.yml", "name: CI\n");
      lane.commit();
      expect(lane.guard().filter((f) => f.rule === "guard-files")).toHaveLength(2);
      expect(lane.guard({ allowGuardEdits: true })).toEqual([]);
    });
  });

  describe("rule (e): gitleaks", () => {
    it("fails loudly when gitleaks is missing", () => {
      lane.write("docs/notes.md", "hello\n");
      lane.commit();
      expect(() => lane.guard({ gitleaks: "run", gitleaksBin: "gitleaks-that-is-not-installed" })).toThrow(/gitleaks is not installed/);
    });

    it.skipIf(!hasGitleaks)("passes a clean range", () => {
      lane.write("docs/notes.md", "hello\n");
      lane.commit();
      expect(lane.guard({ gitleaks: "run" })).toEqual([]);
    });

    it.skipIf(!hasGitleaks)("finds a key-shaped secret, prints where and which rule, and never the value", () => {
      const secret = fakeAccessKey();
      lane.write("packages/worker/src/engine.ts", `export const credentials = { accessKeyId: "${secret}" };\n`);
      lane.commit();
      const findings = lane.guard({ gitleaks: "run" });
      const leak = findings.find((f) => f.rule === "secret");
      expect(leak).toMatchObject({ file: "packages/worker/src/engine.ts", line: 1 });
      expect(findings.map(formatFinding).join("\n")).not.toContain(secret);
    });

    it.skipIf(!hasGitleaks)("finds a secret that a later commit removes", () => {
      const secret = fakeAccessKey();
      lane.write("packages/worker/src/engine.ts", `export const accessKeyId = "${secret}";\n`);
      lane.commit("add");
      lane.write("packages/worker/src/engine.ts", "export const accessKeyId = 1;\n");
      lane.commit("remove");
      expect(rules(lane.guard({ gitleaks: "run" }))).toContain("secret");
    });

    it.skipIf(!hasGitleaks)("ignores a config and ignore file the lane brings along", () => {
      const secret = fakeAccessKey();
      lane.write("packages/worker/src/engine.ts", `export const accessKeyId = "${secret}"; // gitleaks:${"allow"}\n`);
      lane.write(".gitleaks.toml", '[allowlist]\npaths = [".*"]\n');
      lane.commit();
      expect(rules(lane.guard({ gitleaks: "run" }))).toContain("secret");
    });
  });

  describe("the range", () => {
    it("refuses a bare revision, an unknown revision and an option", () => {
      expect(() => runGuard({ cwd: lane.dir, range: "base", gitleaks: "off" })).toThrow(GuardError);
      expect(() => runGuard({ cwd: lane.dir, range: "nothing..lane", gitleaks: "off" })).toThrow(/not a commit/);
      expect(() => runGuard({ cwd: lane.dir, range: "--output=x..lane", gitleaks: "off" })).toThrow(/not a revision/);
    });

    it("judges only the lane's work when the base has moved on", () => {
      git(lane.dir, "switch", "-q", "base");
      lane.write(`docs/other.md`, `later work on the base ${PROSPECT}\n`);
      lane.commit("base moved");
      git(lane.dir, "switch", "-q", "lane");
      lane.write("docs/mine.md", "mine\n");
      lane.commit();
      expect(runGuard({ cwd: lane.dir, range: "base..lane", gitleaks: "off", names: INVENTED }).findings).toEqual([]);
    });
  });

  it("the command line exits 1 on a finding and prints file:line and rule, 0 when clean", () => {
    lane.write("docs/notes.md", `x ${PROSPECT}\n`);
    lane.commit();
    // the command line knows the hashed default list and, here, an invented name from a private list file
    const listDir = mkdtempSync(join(tmpdir(), "port-guard-list-"));
    roots.push(listDir);
    writeFileSync(join(listDir, "names.txt"), "zorblax\\s*corp\n");
    const run = (): { status: number | null; stderr: string } => {
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/port-guard.ts"), "--range", "base..lane"], {
        cwd: lane.dir,
        encoding: "utf8",
        env: { ...process.env, PATH: process.env.PATH ?? "", PORT_GUARD_PRIVATE_NAMES: join(listDir, "names.txt") },
      });
      return { status: result.status, stderr: result.stderr };
    };
    if (!hasGitleaks) return;
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("docs/notes.md:1  [private-name]");
    git(lane.dir, "reset", "-q", "--hard", "base");
    lane.write("docs/notes.md", "fine\n");
    lane.commit();
    expect(run().status).toBe(0);
  });
});

describe("port-guard hardening (review of lane L0)", () => {
  it("reads the text of a file that a gitattributes entry or a NUL byte marks as binary", () => {
    lane.write(".gitattributes", "*.md binary\n");
    lane.write("docs/notes.md", `${PROSPECT}\n`);
    lane.write("docs/nul.txt", `x\0\n${PROSPECT}\n`);
    lane.commit();
    const files = lane.guard().filter((f) => f.rule === "private-name").map((f) => f.file).sort();
    expect(files).toEqual(["docs/notes.md", "docs/nul.txt"]);
  });

  it.skipIf(!hasGitleaks)("finds a secret in a file that gitleaks's default config skips by name or marks as binary", () => {
    const secret = `${j("gh", "p_")}${Array.from(randomBytes(36), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
    lane.write("assets/logo.svg", `<svg><!-- token = ${secret} --></svg>\n`);
    lane.write("package-lock.json", `{ "resolved": "https://user:${secret}@registry.example.com/x.tgz" }\n`);
    lane.write(".gitattributes", "*.cfg binary\n");
    lane.write("conf/app.cfg", `token = ${secret}\n`);
    lane.commit();
    const files = lane.guard({ gitleaks: "run" }).filter((f) => f.rule === "secret").map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(["assets/logo.svg", "package-lock.json", "conf/app.cfg"]));
  });

  it.skipIf(!hasGitleaks)("finds a secret in any added file, whatever its name (every blob gets the second pass)", () => {
    // a different key in each file: gitleaks reports one finding per distinct secret
    for (const path of ["go.mod", "src/jquery.js", "vendor/github.com/x/y.txt", "src/x-gitleaks.toml"]) lane.write(path, `value = "${fakeAccessKey()}"\n`);
    lane.commit();
    const files = lane.guard({ gitleaks: "run" }).filter((f) => f.rule === "secret" || f.rule === "scan-bypass").map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(["go.mod", "src/jquery.js", "vendor/github.com/x/y.txt", "src/x-gitleaks.toml"]));
  });

  it.skipIf(!hasGitleaks)("finds a secret an evil merge slips in, and does not blame a clean merge of a stale side branch", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "-m", "clean merge", "side");
    expect(lane.guard({ gitleaks: "run" })).toEqual([]);
    git(lane.dir, "switch", "-q", "-c", "side2", "base");
    lane.write("docs/side2.md", "side2\n");
    lane.commit("side2");
    git(lane.dir, "switch", "-q", "lane");
    git(lane.dir, "merge", "-q", "--no-ff", "--no-commit", "side2");
    lane.write("docs/slipped.txt", `key = "${fakeAccessKey()}"\n`);
    lane.commit("evil merge");
    git(lane.dir, "rm", "-q", "docs/slipped.txt");
    git(lane.dir, "commit", "-q", "-m", "tidy");
    expect(rules(lane.guard({ gitleaks: "run" }))).toContain("secret");
  });

  it("checks the message of a merge commit too", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "-m", `merge ${PROSPECT} work`, "side");
    expect(lane.guard().map((f) => f.file)).toEqual(["(commit message or author)"]);
  });

  it("stays fast on a long line of host-name characters", () => {
    const started = Date.now();
    expect(lineFindings(`${"a".repeat(100_000)}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("sees a symlink, and a file of any name, introduced inside a merge's own resolution", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "--no-commit", "side");
    symlinkSync("README.md", join(lane.dir, "slipped-link"));
    lane.commit("evil merge");
    git(lane.dir, "rm", "-q", "slipped-link");
    git(lane.dir, "commit", "-q", "-m", "tidy");
    const findings = lane.guard();
    expect(findings).toMatchObject([{ rule: "link", file: "slipped-link" }]);
    expect(findings[0]!.commit).toMatch(/^[0-9a-f]{8}$/);
  });

  it.skipIf(!hasGitleaks)("finds a secret in a vendored file added by an evil merge and removed after it", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "--no-commit", "side");
    lane.write("go.mod", `key = "${fakeAccessKey()}"\n`);
    lane.commit("evil merge");
    git(lane.dir, "rm", "-q", "go.mod");
    git(lane.dir, "commit", "-q", "-m", "tidy");
    expect(rules(lane.guard({ gitleaks: "run" }))).toContain("secret");
  });

  it.each([
    ["a script tag in html", '<script src="./' + ORG + '/x.js"></script>\n', "page.html"],
    ["a line comment inside import()", 'const m = await import(\n  // why\n  "./' + ORG + '/x.js");\n', "engine.ts"],
    ["import.meta.glob", 'const m = import.meta.glob("./' + ORG + '/*.ts");\n', "engine.ts"],
    ["import.meta.glob with an array", 'const m = import.meta.glob(["./ok/*.ts", "./' + ORG + '/*.ts"], { eager: true });\n', "engine.ts"],
    ["require.context", 'const c = require.context("./' + ORG + '", true);\n', "engine.ts"],
    ["createRequire", 'const m = createRequire(import.meta.url)("./' + ORG + '/x.js");\n', "engine.ts"],
    ["a declare module", 'declare module "./' + ORG + '/x.js" { export const a: 1; }\n', "engine.ts"],
    ["a css @import", '@import "./' + ORG + '/x.css";\n', "engine.html"],
  ])("fails %s", (_name, source, file) => {
    lane.write(`packages/worker/src/${file}`, source);
    lane.commit();
    expect(rules(lane.guard())).toContain("cloud-import");
  });

  it.each([
    ["a digit for the last word", "// Zorblax 7\n"],
    ["a Cyrillic look-alike letter", "// Zorblax C\u043erp\n"],
    ["a Greek look-alike letter", "// zorblax c\u03bfrp\n"],
    ["full-width letters", "// \uff5a\uff4f\uff52\uff42\uff4c\uff41\uff58 \uff43\uff4f\uff52\uff50\n"],
    ["zero-width characters", "// Zor\u200bblax Co\u2060rp\n"],
    ["a Cyrillic look-alike in another name", "// ask Qu\u0435nnith\n"],
    ["a name broken over two lines", "// built for Zorblax\n// Corp last year\n"],
    ["a three-word name broken over three lines", "// Acme\n// Widget\n// Works\n"],
    ["a name broken over three lines in a comment block", "/*\n * Que\n * nni\n * th\n */\n"],
  ])("fails %s", (_name, text) => {
    lane.write("packages/worker/src/engine.ts", text);
    lane.commit();
    expect(rules(lane.guard())).toEqual(["private-name"]);
  });

  it("fails a name broken over two lines of a commit message, and not two lines that merely follow each other", () => {
    lane.write("docs/a.md", "x\n");
    git(lane.dir, "add", "-A");
    git(lane.dir, "commit", "-q", "-m", "port from Zorblax\nCorp work");
    expect(lane.guard().map((f) => f.file)).toEqual(["(commit message or author)"]);
    lane.write("docs/b.md", "the working zorblax\nplan is fine\n");
    lane.commit("a second commit");
    expect(lane.guard().filter((f) => f.file === "docs/b.md")).toEqual([]);
  });

  it("allows the audit-sink port, a Code interface, and still refuses the Cloud audit ledger beside it", () => {
    lane.write(`packages/contracts/src/${AUDIT}-sink.ts`, "export interface AuditSink {}\n");
    lane.write(`packages/contracts/src/${AUDIT}-sink.test.ts`, "export {};\n");
    lane.commit();
    expect(lane.guard()).toEqual([]);
    lane.write(`packages/contracts/src/${AUDIT}-ledger.ts`, "export {};\n");
    lane.write(`packages/contracts/src/${AUDIT}-sink-store.ts`, "export {};\n");
    lane.write(`packages/broker/src/${AUDIT}/sink.ts`, "export {};\n");
    lane.commit();
    expect(lane.guard().map((f) => f.file).sort()).toEqual([
      `packages/broker/src/${AUDIT}/sink.ts`,
      `packages/contracts/src/${AUDIT}-ledger.ts`,
      `packages/contracts/src/${AUDIT}-sink-store.ts`,
    ]);
  });

  it.skipIf(!hasGitleaks)("does not re-judge a flagged fixture the lane did not touch, but judges the lines it adds, of any file name", () => {
    git(lane.dir, "switch", "-q", "base");
    lane.write("tests/old-fixture.test.ts", `export const fixture = "${fakeAccessKey()}";\nexport const a = 1;\n`);
    lane.commit("legacy fixture");
    git(lane.dir, "switch", "-q", "lane");
    git(lane.dir, "reset", "-q", "--hard", "base");
    lane.write("tests/old-fixture.test.ts", `export const fixture = "${"x".repeat(5)}";\nexport const a = 2;\n`);
    lane.commit("edit");
    // the legacy key is not on a line the lane adds or keeps; here the lane keeps it and changes another line
    git(lane.dir, "reset", "-q", "--hard", "base");
    const kept = `${readFileSync(join(lane.dir, "tests/old-fixture.test.ts"), "utf8")}export const b = 3;\n`;
    lane.write("tests/old-fixture.test.ts", kept);
    lane.commit("append");
    expect(lane.guard({ gitleaks: "run" })).toEqual([]);
    lane.write("yarn.lock", `# added\nkey "${fakeAccessKey()}"\n`);
    lane.commit("lock");
    expect(lane.guard({ gitleaks: "run" }).map((f) => f.file)).toEqual(["yarn.lock"]);
  });

  it("re-check 3: a 100k-line added lockfile is scanned in linear time, and a secret deep inside it is still found", () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `package-${String(i)}@1.0.${String(i % 97)}:\n  resolved "https://registry.example.test/p/-/p-${String(i)}.tgz"`);
    lines.splice(73_219, 0, `key "${fakeAccessKey()}"`);
    lane.write("yarn.lock", `${lines.join("\n")}\n`);
    lane.commit("big lock");
    const started = performance.now();
    const found = lane.guard({ gitleaks: "run" });
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(found.map((f) => f.file)).toEqual(["yarn.lock"]);
  }, 120_000);

  it("re-check 3: a private key added over several lines of a file gitleaks would skip by name is found", () => {
    const pem = ["-----BEGIN RSA PRIVATE ", "KEY-----"].join("") + "\n" + "MIIEowIBAAKCAQEA".concat("q".repeat(60)) + "\n" + "x".repeat(64) + "\n" + ["-----END RSA PRIVATE ", "KEY-----"].join("");
    lane.write("yarn.lock", `# lock\n${pem}\n`);
    lane.commit("pem");
    expect(lane.guard({ gitleaks: "run" }).map((f) => f.file)).toContain("yarn.lock");
  }, 60_000);

  it("reads a name split mid-word over CRLF lines, and typographic hyphens", () => {
    lane.write("packages/worker/src/engine.ts", "// Que\r\n// nnith\r\n");
    lane.write("packages/worker/src/other.ts", "// zorblax\u2011vault\n");
    lane.commit();
    expect(lane.guard().map((f) => f.file).sort()).toEqual(["packages/worker/src/engine.ts", "packages/worker/src/other.ts"]);
  });

  it.each([
    ["a css file", '@import "./' + ORG + '/x.css";\n', "styles.css"],
    ["a comment between from and the string", 'import { a } from /* c */ "./' + ORG + '/x.js";\n', "engine.ts"],
    ["import.meta.glob with a type argument", 'const m = import.meta.glob<Mod>("./' + ORG + '/*.ts");\n', "engine.ts"],
    ["createRequire with a call inside", 'const m = createRequire(fileURLToPath(import.meta.url))("./' + ORG + '/x.js");\n', "engine.ts"],
    ["a later importScripts argument", 'importScripts("./ok.js", "./' + ORG + '/x.js");\n', "worker.ts"],
    ["import.meta.resolve", 'const p = import.meta.resolve("./' + ORG + '/x.js");\n', "engine.ts"],
    ["a worker", 'const w = new Worker("./' + ORG + '/w.js");\n', "engine.ts"],
    ["an iframe", '<iframe src="./' + ORG + '/page.html"></iframe>\n', "page.html"],
  ])("fails %s", (_name, source, file) => {
    lane.write(`packages/worker/src/${file}`, source);
    lane.commit();
    expect(rules(lane.guard())).toContain("cloud-import");
  });

  it("refuses a Cloud-only directory under the contracts folder", () => {
    lane.write(`packages/contracts/src/${AUDIT}-ledger/index.ts`, "export {};\n");
    lane.commit();
    expect(rules(lane.guard())).toEqual(["cloud-path"]);
  });

  it("checks commit messages, author names and file names, not only file contents", () => {
    lane.write(`docs/${PROSPECT.replaceAll(" ", "-")}/plan.md`, "fine\n");
    git(lane.dir, "add", "-A");
    git(lane.dir, "-c", `user.name=${PROSPECT}`, "commit", "-q", "-m", "port from Zorblax Vault");
    const findings = lane.guard().filter((f) => f.rule === "private-name");
    const where = findings.map((f) => f.file);
    expect(where).toEqual(expect.arrayContaining(["(commit message or author)"]));
    expect(where.some((file) => file.startsWith("docs/"))).toBe(true);
    expect(findings.filter((f) => f.file === "(commit message or author)")).toHaveLength(3); // author, committer, message
  });

  it("sees what an evil merge slips in, even when the next commit removes it", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "--no-commit", "side");
    lane.write(`packages/broker/src/${ORG}/evil.ts`, "export {};\n");
    lane.write("docs/evil.md", `${PROSPECT}\n`);
    lane.commit("merge");
    git(lane.dir, "rm", "-q", "-r", `packages/broker/src/${ORG}`, "docs/evil.md");
    git(lane.dir, "commit", "-q", "-m", "tidy");
    const findings = lane.guard();
    expect(rules(findings)).toEqual(expect.arrayContaining(["cloud-path", "private-name"]));
    expect(findings.find((f) => f.rule === "private-name")).toMatchObject({ file: "docs/evil.md", line: 1 });
  });

  it("does not blame a clean merge for the work it brings in from a side branch", () => {
    lane.write("docs/side.md", "side\n");
    git(lane.dir, "switch", "-q", "-c", "side");
    lane.commit("side");
    git(lane.dir, "switch", "-q", "lane");
    lane.write("docs/lane.md", "lane\n");
    lane.commit("lane");
    git(lane.dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(lane.guard()).toEqual([]);
  });

  it.each([
    ["a template literal", "const m = await import(`../../broker/src/" + ORG + "/x.js`);\n"],
    ["a comment before the string", 'const m = await import(/* why */ "./' + ORG + '/x.js");\n'],
    ["require.resolve", 'const p = require.resolve("./' + ORG + '/x.js");\n'],
    ["a triple-slash reference", '/// <reference path="./' + ORG + '/x.d.ts" />\n'],
    ["new URL", 'const u = new URL("./' + ORG + '/x.js", import.meta.url);\n'],
    ["a requireActual", 'const m = await vi.importActual("./' + ORG + '/x.js");\n'],
    ["a package-imports alias", 'import { m } from "#' + ORG + '/x.js";\n'],
  ])("fails %s", (_name, source) => {
    lane.write("packages/worker/src/engine.ts", source);
    lane.commit();
    expect(rules(lane.guard())).toContain("cloud-import");
  });

  it("fails a package file or tsconfig that points a path or dependency into Cloud-only code", () => {
    lane.write("packages/worker/tsconfig.json", `{ "compilerOptions": { "paths": { "@x/*": ["../broker/src/${ORG}/*"] } } }\n`);
    lane.write("packages/mcp/package.json", `{ "dependencies": { "x": "file:../${j("w", "eb")}" } }\n`);
    lane.commit();
    expect(lane.guard().filter((f) => f.rule === "cloud-import").map((f) => f.file).sort()).toEqual(["packages/mcp/package.json", "packages/worker/tsconfig.json"]);
  });

  it("flags an edit to the port:guard script and a stack nested under infra/lib", () => {
    lane.write("package.json", '{ "scripts": { "port:guard": "true" } }\n');
    lane.write(`infra/lib/stacks/${AUDIT}-stack.ts`, "export {};\n");
    lane.write("docs/enterprise.md", "x\n");
    lane.commit();
    const findings = lane.guard();
    expect(findings.filter((f) => f.rule === "guard-files")).toHaveLength(1);
    expect(findings.filter((f) => f.rule === "cloud-path").map((f) => f.file).sort()).toEqual([`infra/lib/stacks/${AUDIT}-stack.ts`, "docs/enterprise.md"].sort());
  });

  it("reports a second private name on another line of the same file", () => {
    lane.write("docs/notes.md", `one ${PROSPECT}\ntwo\nthree ${PROSPECT}\n`);
    lane.commit();
    expect(lane.guard().map((f) => f.line)).toEqual([1, 3]);
  });

  it("keeps the right file name when diff.noprefix is set", () => {
    git(lane.dir, "config", "diff.noprefix", "true");
    lane.write("b/notes.md", `${PROSPECT}\n`);
    lane.commit();
    expect(lane.guard()).toMatchObject([{ file: "b/notes.md", line: 1 }]);
  });

  it.each([
    ["an ECR registry host", `const r = "${"5".repeat(12)}.dkr.ecr.us-west-2.amazonaws.com/x";\n`],
    ["an account field", `const a = { Account: "${"5".repeat(12)}" };\n`],
    ["an account id variable", `const accountId = '${"5".repeat(12)}';\n`],
    ["the internal build host spelled with a space", "// zink forge\n"],
  ])("fails %s", (_name, line) => {
    lane.write("packages/worker/src/engine.ts", line);
    lane.commit();
    expect(rules(lane.guard())).toEqual(["private-name"]);
  });
});

describe("the hashed name list and the private extended list", () => {
  const find = (text: string, names: NameSource = INVENTED): string[] => lineFindings(text, names);
  const label = "a prospect or customer name";

  it("matches a word, a two-word join and a three-word join, however the words are separated or cased", () => {
    expect(find("quennith")).toEqual([label]);
    expect(find("QUENNITH, said the report")).toEqual([label]);
    expect(find("Zorblax Corp")).toEqual([label]);
    expect(find("zorblax_corp zorblax-corp ZorblaxCorp zorblax.corp")).toEqual([label]);
    expect(find("Acme Widget Works")).toEqual(["a prospect product name"]);
    expect(find("acme/widget/works")).toEqual(["a prospect product name"]);
    expect(find("quennith2")).toEqual([label]);
    expect(find("Zorblax 7")).toEqual([label]);
  });

  it("does not match a common word on its own, a longer word that merely contains a name, or words that are not adjacent", () => {
    expect(find("zorblax")).toEqual([]);
    expect(find("scout crew corp widget works acme")).toEqual([]);
    expect(find("zorblaxcorpse")).toEqual([]);
    expect(find("zorblax is not a corp")).toEqual([]);
  });

  it("says which kind of name it found and never prints the name", () => {
    expect(find("zorblax scout")).toEqual(["a prospect pilot name"]);
    expect(find("zorblax vault")).toEqual(["the private repository name"]);
    expect(find("code 424242424242 here")).toEqual(["the staging account id"]);
  });

  it("refuses a listed word glued inside a longer word only when the list marks it so", () => {
    expect(find("quennithson")).toEqual([label]);
    expect(find("mrquennith")).toEqual([label]);
    expect(find("/home/quennithsmith/work")).toEqual([label]);
    expect(find("zinkforges and xzinkforge")).toEqual(["an internal build-system name"]);
    expect(find("zorblaxcorpse")).toEqual([]);
  });

  it("catches the detector in any file under env-detect, in a module named without an extension, and in code of any extension", () => {
    for (const path of [
      `packages/worker/src/env-detect/${BUILD_DETECTOR}.md`,
      `packages/worker/src/env-detect/fixtures/${BUILD_DETECTOR}/a.json`,
      `packages/worker/src/env-detect/${BUILD_DETECTOR}`,
      `packages/worker/src/${BUILD_DETECTOR}.mjs`,
    ]) expect(cloudPathRule(path, INVENTED)?.rule, path).toBe("build-detector");
    expect(cloudPathRule("packages/worker/src/env-detect/node.md", INVENTED)).toBeNull();
    expect(cloudImportReason("packages/worker/src/x.ts", `./env-detect/${BUILD_DETECTOR}`, INVENTED)).not.toBeNull();
    expect(cloudImportReason("packages/worker/src/x.ts", "./env-detect/node", INVENTED)).toBeNull();
  });

  it("holds hashes only in the default list: nothing readable, nothing to read back", () => {
    expect(DEFAULT_NAMES.entries.length).toBeGreaterThan(8);
    expect(DEFAULT_NAMES.patterns).toEqual([]);
    for (const entry of [...DEFAULT_NAMES.entries, ...DEFAULT_NAMES.detectors]) {
      expect(entry.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(entry.fnv)).toBe(true);
      expect(Object.keys(entry).filter((key) => key !== "len").sort()).toEqual(["fnv", "label", "sha"]);
      if ("len" in entry) expect(Number.isInteger(entry.len)).toBe(true);
    }
  });

  it("catches a name in a path, a commit message and a split over lines through the injected list", () => {
    expect(splitNameFindings(["// Zorblax", "// Corp"], INVENTED)).toEqual([label]);
    expect(splitNameFindings(["// Quen", "// nith"], INVENTED)).toEqual([label]);
    expect(splitNameFindings(["// quennith", "// quennith"], INVENTED)).toEqual([]);
  });

  describe("the private extended list", () => {
    const withPatterns = (...patterns: string[]): NameSource => ({ ...nameSourceFromWords(TEST_SALT, {}), patterns: patterns.map((p) => new RegExp(p, "i")) });
    const privateLabel = "a name from the private list";

    it("reads one regular expression per line and skips blank lines and comments", () => {
      const dir = mkdtempSync(join(tmpdir(), "port-guard-list-"));
      roots.push(dir);
      const file = join(dir, "names.txt");
      writeFileSync(file, "# the controller's list\n\nflibjabbet\r\n  glim[o0]rn  \n");
      const patterns = loadPrivatePatterns(file);
      expect(patterns.map(String)).toEqual(["/flibjabbet/i", "/glim[o0]rn/i"]);
      expect(find("a glim0rn here", { ...nameSourceFromWords(TEST_SALT, {}), patterns })).toEqual([privateLabel]);
    });

    it("fails clearly on a list that cannot be read or holds a bad pattern", () => {
      const dir = mkdtempSync(join(tmpdir(), "port-guard-list-"));
      roots.push(dir);
      expect(() => loadPrivatePatterns(join(dir, "missing.txt"))).toThrow(GuardError);
      writeFileSync(join(dir, "bad.txt"), "(unclosed\n");
      expect(() => loadPrivatePatterns(join(dir, "bad.txt"))).toThrow(/not a regular expression/);
    });

    it("applies the same look-alike folding, split-over-lines and CRLF logic as the hashed list", () => {
      const names = withPatterns("flibjabbet");
      lane = new Lane();
      lane.write("docs/a.md", "plain flibjabbet\n");
      lane.write("docs/b.md", "look-alike fl\u0456bjabbet\n");
      lane.write("docs/c.md", "split flib\njabbet\n");
      lane.write("docs/d.md", "// fli\r\n// bjabbet\r\n");
      lane.write("docs/e.md", "zero\u200bwidth fli\u200bbjabbet\n");
      lane.write("docs/fine.md", "nothing here\n");
      lane.commit();
      expect(lane.guard({ names }).map((f) => f.file).sort()).toEqual(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"]);
    });
  });

  it("stays fast on a 100,000-line file", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `const name${String(i)} = "value-${String(i % 97)}"; // resolved package-${String(i)}`);
    const started = Date.now();
    for (const line of text) lineFindings(line, INVENTED);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("the command line says when the extended list was not loaded, and does not say it when the list is given", () => {
    const lane2 = new Lane();
    lane2.write("docs/a.md", "fine\n");
    lane2.commit();
    const dir = mkdtempSync(join(tmpdir(), "port-guard-list-"));
    roots.push(dir);
    writeFileSync(join(dir, "names.txt"), "flibjabbet\n");
    const run = (env: Record<string, string>): string => {
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/port-guard.ts"), "--range", "base..lane"], {
        cwd: lane2.dir,
        encoding: "utf8",
        env: { ...process.env, PORT_GUARD_PRIVATE_NAMES: "", ...env },
      });
      return result.stdout;
    };
    expect(run({}).match(/extended name list was not loaded/g)).toHaveLength(1);
    expect(run({ PORT_GUARD_PRIVATE_NAMES: join(dir, "names.txt") })).not.toContain("not loaded");
  });
});

describe("port-guard pieces", () => {
  it("reads added lines and their numbers from a patch, including lines that look like headers", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old one",
      "-old two",
      "+++ looks like a header",
      "+two",
      "+three",
      "@@ -9 +11 @@",
      "-gone",
      "+kept",
      "\\ No newline at end of file",
      "diff --git a/b.ts b/b.ts",
      "deleted file mode 100644",
      "--- a/b.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(addedLines(patch)).toEqual([
      { file: "a.ts", line: 1, text: "++ looks like a header" },
      { file: "a.ts", line: 2, text: "two" },
      { file: "a.ts", line: 3, text: "three" },
      { file: "a.ts", line: 11, text: "kept" },
    ]);
  });

  it("unquotes a path git quotes", () => {
    const patch = ['diff --git "a/we\\"ird" "b/we\\"ird"', '+++ "b/we\\"ird"', "@@ -0,0 +1 @@", "+x"].join("\n");
    expect(addedLines(patch)).toEqual([{ file: 'we"ird', line: 1, text: "x" }]);
  });

  it("resolves relative imports against the importing file", () => {
    expect(cloudImportReason("packages/a/src/x.ts", `../../b/src/${ORG}/y.js`)).not.toBeNull();
    expect(cloudImportReason("packages/a/src/x.ts", "./y.js")).toBeNull();
    expect(cloudImportReason("packages/a/src/x.ts", "node:fs")).toBeNull();
    expect(cloudImportReason("packages/a/src/x.ts", "zod")).toBeNull();
  });

  it("recognises Cloud-only paths and nothing near them", () => {
    expect(cloudPathRule(`packages/broker/src/${ORG}/a.ts`)).not.toBeNull();
    expect(cloudPathRule(`packages/broker/src/${ORG}anizer/a.ts`)).toBeNull();
    expect(cloudPathRule(`docs/${AUDIT}-ledger-notes.md`)).toBeNull();
    expect(cloudPathRule("packages/uikit/a.ts")).toBeNull();
    expect(cloudPathRule("packages/worker/src/engine.ts")).toBeNull();
  });

  it("finds import specifiers in source and leaves strings that are not imports", () => {
    expect(importFindings("packages/a/src/x.ts", `const s = "${ORG}/members";\n`)).toEqual([]);
    expect(lineFindings("nothing to see")).toEqual([]);
  });

  it("main refuses bad arguments with status 2", () => {
    expect(main(["--nope"])).toBe(2);
    expect(main(["--range"])).toBe(2);
  });
});
