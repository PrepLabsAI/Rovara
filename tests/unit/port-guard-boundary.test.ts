import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BOUNDARY_FILE,
  DEFAULT_NAMES,
  GuardError,
  addedFileRule,
  adaptersPackageRule,
  awsImportFindings,
  awsImportReason,
  boundary,
  cloudImportReason,
  cloudPathRule,
  hasPrivateBranch,
  importFindings,
  lineFindings,
  loadBoundary,
  nameSourceFromWords,
  parseBoundary,
  runGuard,
  splitNameFindings,
  useBoundaryFile,
  withBoundary,
  type BoundaryData,
  type Finding,
} from "../../scripts/port-guard.js";

// Lane W0-4 (decision 71/72): Cloud starts consuming Code, so neither side may leak into the other. These tests cover the rules added for that:
// a vendor/ folder, `cloud-*` packages, private branch names, the private repository name (on a list of invented names), and the AWS line
// (only the four generic adapters are public). Like the rest of the guard's tests, none of the forbidden text is written out: the words are
// assembled at run time.
const j = (...parts: string[]): string => parts.join("");
const VENDOR = j("ven", "dor");
const CLD = j("clo", "ud");
const INTEG = j("in", "teg");
const CC = j("c", "c");
const AWS = j("a", "ws");
const INFRA = j("in", "fra");
const ADAPTERS = "packages/aws-adapters";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A lane in a temp repository: `base` is code/next, the work is committed on top by `commit()`. */
class Lane {
  readonly dir: string;
  constructor(existing: Readonly<Record<string, string>> = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "port-guard-boundary-"));
    roots.push(this.dir);
    git(this.dir, "init", "-q", "-b", "code-next");
    this.write("README.md", "base\n");
    for (const [path, text] of Object.entries(existing)) this.write(path, text);
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
  guard(options: { allowGuardEdits?: boolean } = {}): Finding[] {
    return runGuard({ cwd: this.dir, range: "base..lane", gitleaks: "off", names: DEFAULT_NAMES, ...options }).findings;
  }
}

const rules = (findings: Finding[]): string[] => findings.map((finding) => finding.rule);
/** One import line. The module name is passed in, so no `from "<module>"` literal sits in this file (the guard scans its own tests too). */
const imp = (name: string, module: string): string => `import { ${name} } from "${module}";\n`;
const SDK = (service: string): string => j("@aws-sdk/", "client-", service);

describe("the boundary data both guards read", () => {
  it("holds exactly the four generic AWS adapters (decision 72, O2) and the Cloud-only package names", () => {
    const data = boundary();
    expect(data.publicAwsAdapters.adapters.map((adapter) => adapter.id).sort()).toEqual(["dynamodb", "s3", "secrets-manager", "sqs"]);
    expect(data.publicAwsAdapters.adapters.map((adapter) => adapter.port).sort()).toEqual(["objects", "queue", "secrets", "storage"]);
    expect(data.cloudOnlyPackages).toEqual(expect.arrayContaining(["@agentx/ui", "@agentx/web", "@rovara/audit-verifier"]));
    for (const adapter of data.publicAwsAdapters.adapters) {
      for (const sdk of adapter.sdk) expect(sdk).toMatch(/^@aws-sdk\//);
    }
  });

  it("is the file the guard names, and the guard counts an edit to it as a guard edit", () => {
    const text = readFileSync(BOUNDARY_FILE, "utf8");
    expect(parseBoundary(text, BOUNDARY_FILE)).toEqual(boundary());
    const lane = new Lane({ [BOUNDARY_FILE]: text });
    lane.write(BOUNDARY_FILE, text.replace('"version": 1', '"version": 2'));
    lane.commit();
    expect(lane.guard().map((f) => `${f.rule}:${f.file}`)).toContain(`guard-files:${BOUNDARY_FILE}`);
    expect(lane.guard({ allowGuardEdits: true })).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["missing the adapters", '{"cloudOnlyPackages":[],"cloudOnlyPackagePatterns":[],"awsSdkPublicPaths":[],"publicNpmPackages":[]}'],
    ["an adapter with a bad id", JSON.stringify({ ...boundary(), publicAwsAdapters: { package: "p", dir: "d", adapters: [{ id: "Bad Id", port: "x", sdk: [] }] } })],
    ["a package pattern that is not a regular expression", JSON.stringify({ ...boundary(), cloudOnlyPackagePatterns: ["("] })],
  ])("refuses data that is %s, loudly", (_name, text) => {
    expect(() => parseBoundary(text, "x.json")).toThrow(GuardError);
  });
});

describe("a vendor/ folder", () => {
  it.each([`${VENDOR}/rovara-code/package.json`, `packages/cli/${VENDOR}/x.ts`, `${VENDOR.toUpperCase()}/a.md`])("is refused as a path: %s", (path) => {
    expect(cloudPathRule(path)?.rule).toBe("cloud-path");
  });

  it("is not confused with names that merely start with it", () => {
    expect(cloudPathRule(`tests/fixtures/${VENDOR}s/a.json`)).toBeNull();
    expect(cloudPathRule(`packages/cli/src/setup/connectors/${VENDOR}s.ts`)).toBeNull();
    expect(cloudPathRule(`docs/${VENDOR}-notes.md`)).toBeNull();
  });

  it("is refused as an import", () => {
    expect(cloudImportReason("packages/a/src/x.ts", `../../../${VENDOR}/rovara-code/y.js`)).not.toBeNull();
    expect(cloudImportReason("packages/a/src/x.ts", `some-package/${VENDOR}/y`)).not.toBeNull();
  });

  it("fails a lane that adds one, through the whole run", () => {
    const lane = new Lane();
    lane.write(`${VENDOR}/rovara-code/README.md`, "a copy\n");
    lane.commit();
    expect(lane.guard().map((f) => `${f.rule}:${f.file}`)).toEqual([`cloud-path:${VENDOR}/rovara-code/README.md`]);
  });
});

describe("Cloud-only packages named cloud-*", () => {
  it.each([`@agentx/${CLD}`, `@preplabsai/${CLD}-x`, `@agentx/${CLD}-contracts`, `@rovara/${CLD}-web`, `@agentx/${CLD}-adapters/dynamo`, `@rovara/${CLD}-tools`])("refuses importing %s", (specifier) => {
    expect(cloudImportReason("packages/worker/src/a.ts", specifier)).not.toBeNull();
  });

  it("does not refuse a package whose name only starts the same way", () => {
    expect(cloudImportReason("packages/worker/src/a.ts", `@agentx/${CLD}y`)).toBeNull();
    expect(cloudImportReason("packages/worker/src/a.ts", `${CLD}-sdk`)).toBeNull();
    expect(cloudImportReason("packages/worker/src/a.ts", `@aws-cdk/${CLD}-assembly-schema`)).toBeNull();
  });

  it("refuses the package directory, an import, and a package file that names one", () => {
    expect(cloudPathRule(`packages/${CLD}-contracts/src/a.ts`)?.rule).toBe("cloud-path");
    const lane = new Lane();
    lane.write("packages/worker/src/a.ts", `import { x } from "@agentx/${CLD}-contracts";\nexport const a = x;\n`);
    lane.write("packages/worker/package.json", `{ "dependencies": { "@agentx/${CLD}-contracts": "*" } }\n`);
    lane.commit();
    const findings = lane.guard();
    expect(findings.map((f) => `${f.rule}:${f.file}`).sort()).toEqual(["cloud-import:packages/worker/package.json", "cloud-import:packages/worker/src/a.ts"]);
  });
});

describe("private branch names and the private repository name", () => {
  it.each([
    ["an integration branch", `${INTEG}/0513`],
    ["an integration branch in a remote ref", `private/${INTEG}/0510`],
    ["a Cloud lane branch", `${CC}/w0-4-guards`],
    ["a Cloud lane branch in a remote ref", `origin/${CC}/consume`],
    ["in a sentence", `merged from ${INTEG}/0512 yesterday`],
    ["in any case", `${CC.toUpperCase()}/Consume`],
  ])("refuses %s on an added line", (_name, text) => {
    expect(lineFindings(text)).toEqual(["a private branch name (integration and Cloud lane branches are never public)"]);
  });

  it.each([
    "port/w0-4-guards",
    `a ${CC} line to the reviewer`,
    `cc: someone`,
    `src/a${CC}/x.ts`,
    `${INTEG}ration/notes`,
    `the ${INTEG} word alone`,
    `${CC}-sdk`,
  ])("leaves ordinary text alone: %s", (text) => {
    expect(lineFindings(text)).toEqual([]);
  });

  it("refuses it in a file name, a commit message and a file's text, whichever carries it", () => {
    const lane = new Lane();
    lane.write(`docs/${INTEG}/0513.md`, "notes\n");
    lane.write("docs/ok.md", `see ${CC}/consume\n`);
    lane.commit(`from ${INTEG}/0513`);
    const hits = lane.guard().map((f) => `${f.rule}:${f.file}`);
    expect(hits).toEqual(expect.arrayContaining([`private-name:docs/${INTEG}/0513.md`, "private-name:docs/ok.md", "private-name:(commit message or author)"]));
  });

  it("keeps the salted-hash list for the private repository name and the other protected words (no word is written in the guard)", () => {
    const labels = DEFAULT_NAMES.entries.map((entry) => entry.label);
    expect(labels).toContain("the private repository name");
    for (const entry of DEFAULT_NAMES.entries) expect(entry.sha).toMatch(/^[0-9a-f]{64}$/);
    const source = readFileSync("scripts/port-guard.ts", "utf8");
    expect(source).not.toMatch(new RegExp(`${INTEG}/0|${CC}/[a-z]`, "i"));
  });

  it("matches the private repository name, in the shapes it is written, when it is on the list (invented name here)", () => {
    const names = nameSourceFromWords("s", { "the private repository name": ["zorblaxvault"] });
    for (const text of ["PrepLabs/Zorblax-Vault", "ZorblaxVault", "zorblax_vault.git", "https://example.com/zorblax-vault"]) {
      expect(lineFindings(text, names)).toEqual(["the private repository name"]);
    }
    expect(lineFindings("a vault of zorblax", names)).toEqual([]);
  });
});

describe("the AWS line: four generic adapters are public, everything else AWS stays private", () => {
  it("refuses a NEW file under an aws/ directory but lets Code's existing files there be edited", () => {
    const lane = new Lane({ [`packages/core/src/${AWS}/existing.ts`]: "export const a = 1;\n" });
    lane.write(`packages/core/src/${AWS}/existing.ts`, "export const a = 2;\n");
    lane.commit("edit");
    expect(lane.guard()).toEqual([]);
    lane.write(`packages/core/src/${AWS}/handler.ts`, "export const h = 1;\n");
    lane.commit("add");
    const findings = lane.guard();
    expect(findings.map((f) => `${f.rule}:${f.file}`)).toEqual([`cloud-aws:packages/core/src/${AWS}/handler.ts`]);
    expect(findings[0]!.detail).toMatch(/Cloud AWS handler/);
  });

  it("refuses a NEW file under infra/ (Cloud's CDK) but lets an existing one be edited", () => {
    const lane = new Lane({ [`${INFRA}/lib/app.ts`]: "export const app = 1;\n" });
    lane.write(`${INFRA}/lib/app.ts`, "export const app = 2;\n");
    lane.commit("edit");
    expect(lane.guard()).toEqual([]);
    lane.write(`${INFRA}/lib/queue-stack.ts`, "export const q = 1;\n");
    lane.commit("add");
    expect(lane.guard().map((f) => `${f.rule}:${f.file}`)).toEqual([`cloud-aws:${INFRA}/lib/queue-stack.ts`]);
  });

  it("still fails a new aws/ file that a later commit deletes, because the history is pushed too", () => {
    const lane = new Lane();
    lane.write(`packages/core/src/${AWS}/handler.ts`, "export {};\n");
    lane.commit("add");
    git(lane.dir, "rm", "-q", `packages/core/src/${AWS}/handler.ts`);
    git(lane.dir, "commit", "-q", "-m", "remove");
    expect(rules(lane.guard())).toEqual(["cloud-aws"]);
  });

  it("names the rule for a path on its own (the tree test uses this)", () => {
    expect(addedFileRule(`a/${AWS}/b.ts`)?.rule).toBe("cloud-aws");
    expect(addedFileRule(`${INFRA}/bin/x.ts`)?.rule).toBe("cloud-aws");
    expect(addedFileRule("packages/aws-adapters/src/s3/store.ts")).toBeNull();
    expect(addedFileRule(`packages/${AWS}-notes/x.ts`)).toBeNull();
    expect(addedFileRule("docs/aws-setup.md")).toBeNull();
  });

  describe("the adapters package", () => {
    it.each(["dynamodb/store.ts", "dynamodb/store.test.ts", "sqs/queue.ts", "s3/objects.ts", "secrets-manager/secrets.ts", "index.ts", "dynamodb.ts", "sqs.test.ts"])("takes %s", (rest) => {
      expect(adaptersPackageRule(`${ADAPTERS}/src/${rest}`)).toBeNull();
      expect(cloudPathRule(`${ADAPTERS}/src/${rest}`)).toBeNull();
    });

    it.each(["ec2/workers.ts", "cognito/identity.ts", "slack/events.ts", "lambda.ts", "model-gateway/keys.ts", "shared/helpers.ts", "dynamodbx/store.ts"])("refuses %s, a private adapter in the public package", (rest) => {
      expect(adaptersPackageRule(`${ADAPTERS}/src/${rest}`)).not.toBeNull();
      expect(cloudPathRule(`${ADAPTERS}/src/${rest}`)?.rule).toBe("cloud-aws");
    });

    it("reads the package's other files (manifest, readme, tests folder) as fine, in any case and with ./ or backslashes", () => {
      for (const path of [`${ADAPTERS}/package.json`, `${ADAPTERS}/README.md`, `${ADAPTERS}/tsconfig.json`]) expect(adaptersPackageRule(path)).toBeNull();
      expect(adaptersPackageRule(`./${ADAPTERS.toUpperCase()}/SRC/EC2/x.ts`)).not.toBeNull();
      expect(adaptersPackageRule(`${ADAPTERS.replaceAll("/", "\\")}\\src\\ec2\\x.ts`)).not.toBeNull();
    });

    it("fails a lane that puts a private adapter there, and passes one that adds the four", () => {
      const lane = new Lane();
      lane.write(`${ADAPTERS}/src/dynamodb/store.ts`, 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nimport { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";\nexport const s = [DynamoDBClient, DynamoDBDocumentClient];\n');
      lane.write(`${ADAPTERS}/src/sqs/queue.ts`, 'import { SQSClient } from "@aws-sdk/client-sqs";\nexport const q = SQSClient;\n');
      lane.write(`${ADAPTERS}/src/s3/objects.ts`, 'import { S3Client } from "@aws-sdk/client-s3";\nimport { Upload } from "@aws-sdk/lib-storage";\nexport const o = [S3Client, Upload];\n');
      lane.write(`${ADAPTERS}/src/secrets-manager/secrets.ts`, 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";\nexport const s = SecretsManagerClient;\n');
      lane.write(`${ADAPTERS}/src/index.ts`, 'export * from "./sqs/queue.js";\n');
      lane.commit("the four");
      expect(lane.guard()).toEqual([]);
      lane.write(`${ADAPTERS}/src/ec2/workers.ts`, imp("EC2Client", SDK("ec2")) + 'export const w = EC2Client;\n');
      lane.commit("private");
      const hits = lane.guard().map((f) => `${f.rule}:${f.file}`);
      expect(hits).toContain(`cloud-aws:${ADAPTERS}/src/ec2/workers.ts`);
    });

    it("refuses a client for another service even inside an allowed adapter's folder, and the CDK, in an existing file too", () => {
      const lane = new Lane({ [`${ADAPTERS}/src/sqs/queue.ts`]: 'import { SQSClient } from "@aws-sdk/client-sqs";\nexport const q = SQSClient;\n' });
      lane.write(`${ADAPTERS}/src/sqs/queue.ts`, 'import { SQSClient } from "@aws-sdk/client-sqs";\n' + imp("SNSClient", SDK("sns")) + imp("Stack", j("aws-cdk", "-lib")) + 'export const q = [SQSClient, SNSClient, Stack];\n');
      lane.commit();
      const findings = lane.guard();
      expect(findings.filter((f) => f.rule === "cloud-aws").map((f) => f.line).sort()).toEqual([2, 3]);
      expect(findings.every((f) => f.file === `${ADAPTERS}/src/sqs/queue.ts`)).toBe(true);
    });
  });

  describe("AWS SDK imports elsewhere", () => {
    it.each([
      ["a service client that is not on the list", "@aws-sdk/client-ec2"],
      ["a service client library that is not on the list", "@aws-sdk/lib-something"],
      ["a client subpath", "@aws-sdk/client-lambda/dist-types/x"],
      ["the CDK", "aws-cdk-lib"],
      ["a CDK subpath", "aws-cdk-lib/aws-iam"],
      ["a CDK package", "@aws-cdk/cloud-assembly-schema"],
    ])("refuses %s in a NEW file", (_name, specifier) => {
      expect(awsImportReason("packages/worker/src/new.ts", specifier, true)).not.toBeNull();
    });

    it.each(["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-sqs", "@aws-sdk/client-s3", "@aws-sdk/client-secrets-manager", "@aws-sdk/types", "@smithy/node-http-handler", "zod", "node:fs", "./x.js"])(
      "lets %s through in a new file",
      (specifier) => {
        expect(awsImportReason("packages/worker/src/new.ts", specifier, true)).toBeNull();
      },
    );

    it("does not judge a file Code already had, and lets the install flow under the CLI use any client", () => {
      expect(awsImportReason("packages/worker/src/old.ts", "@aws-sdk/client-ec2", false)).toBeNull();
      expect(awsImportReason("packages/cli/src/doctor/new.ts", "@aws-sdk/client-sts", true)).toBeNull();
      expect(awsImportReason("packages/worker/src/new.ts", "@aws-sdk/client-sts", true)).not.toBeNull();
    });

    it("fails a lane that adds a Cloud handler's imports in a new file and passes the same import in the install flow", () => {
      const lane = new Lane({ "packages/worker/src/old.ts": "export const o = 1;\n" });
      lane.write("packages/worker/src/old.ts", imp("EC2Client", SDK("ec2")) + 'export const o = EC2Client;\n');
      lane.write("packages/cli/src/doctor/probe.ts", imp("STSClient", SDK("sts")) + 'export const p = STSClient;\n');
      lane.commit("install flow and an edit");
      expect(lane.guard()).toEqual([]);
      lane.write("packages/worker/src/placement.ts", imp("EC2Client", SDK("ec2")) + 'export const p = EC2Client;\n');
      lane.commit("a new handler");
      const findings = lane.guard();
      expect(findings.map((f) => `${f.rule}:${f.file}:${f.line}`)).toEqual(["cloud-aws:packages/worker/src/placement.ts:1"]);
    });

    it("sees an import added in one commit and removed in the next", () => {
      const lane = new Lane();
      lane.write("packages/worker/src/placement.ts", imp("EC2Client", SDK("ec2")));
      lane.commit("add");
      lane.write("packages/worker/src/placement.ts", "export const p = 1;\n");
      lane.commit("remove");
      expect(rules(lane.guard())).toContain("cloud-aws");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Review of lane W0-4 (the Opus review's findings A-H1, A-M2, A-M3, A-M4, A-L2 and the mutations that survived).

const NEXT = j("ne", "xt");
const BRANCH = "a private branch name (integration and Cloud lane branches are never public)";
const SDK_STS = j("@aws-sdk/", "client-", "sts");
const CDK = j("aws-cdk", "-lib");

describe("a sanctioned AWS adapter and text fixtures (A-H1)", () => {
  const BEDROCK = "packages/core/src/plugins/model-provider/bedrock";

  it("lets the Bedrock model-provider plug-in import the one client the data names, in its own folder only", () => {
    expect(awsImportReason(`${BEDROCK}/credentials.ts`, SDK_STS, true)).toBeNull();
    expect(awsImportReason(`${BEDROCK}/credentials.ts`, SDK("ec2"), true)).not.toBeNull();
    expect(awsImportReason(`${BEDROCK}/credentials.ts`, CDK, true)).not.toBeNull();
    expect(awsImportReason("packages/core/src/plugins/model-provider/other/credentials.ts", SDK_STS, true)).not.toBeNull();
    expect(awsImportReason(`${BEDROCK}-extra/credentials.ts`, SDK_STS, true)).not.toBeNull();
    expect(boundary().awsSdkSanctioned.map((entry) => entry.id)).toEqual(["bedrock-model-provider"]);
  });

  it("does not read an import that is text inside a string in a test file, but still reads a real one, and a string outside tests", () => {
    const asText = `const cdk = \`${imp("Queue", j(CDK, "/aws-sqs"))}new Queue();\`;\n`;
    expect(awsImportFindings("tests/unit/x.test.ts", asText, true)).toEqual([]);
    expect(awsImportFindings("tests/unit/x.test.ts", `const t = 'x'; ${imp("Queue", j(CDK, "/aws-sqs"))}`, true)).toHaveLength(1);
    expect(awsImportFindings("tests/unit/x.test.ts", imp("Queue", j(CDK, "/aws-sqs")), true)).toHaveLength(1);
    expect(awsImportFindings("packages/worker/src/x.ts", asText, true)).toHaveLength(1);
  });

  it("opens no path for a real AWS client: the shipped data has no fixture paths, so a real import under tests/fixtures or an env-detect test name is read", () => {
    expect(boundary().awsImportFixturePaths).toEqual([]);
    const real = `export { EC2Client } from "${SDK("ec2")}";\n`;
    for (const path of ["tests/fixtures/ec2.ts", "tests/unit/worker-env-detect-evil.ts", "tests/unit/worker-env-detect-x.test.ts"]) {
      expect(awsImportFindings(path, real, true), path).toHaveLength(1);
    }
    expect(awsImportFindings("tests/fixtures/stack.ts", imp("Queue", j(CDK, "/aws-sqs")), true)).toHaveLength(1);
  });

  it("still lets data name fixture paths (the key stays), for one path only", () => {
    withBoundary({ ...boundary(), awsImportFixturePaths: ["tests/fixtures/"] }, () => {
      expect(awsImportFindings("tests/fixtures/stack.ts", imp("Queue", j(CDK, "/aws-sqs")), true)).toEqual([]);
      expect(awsImportFindings("tests/other/stack.ts", imp("Queue", j(CDK, "/aws-sqs")), true)).toHaveLength(1);
    });
  });

  it("does not let the fixture or sanctioned paths excuse the adapters package", () => {
    const data = boundary();
    const widened: BoundaryData = { ...data, awsImportFixturePaths: ["packages/aws-adapters/"], awsSdkSanctioned: [{ id: "x", dir: "packages/aws-adapters/", sdk: [SDK("ec2")], reason: "x" }] };
    withBoundary(widened, () => {
      expect(awsImportReason("packages/aws-adapters/src/sqs/a.ts", SDK("ec2"), true)).not.toBeNull();
    });
  });

  it("(A9) does not let awsSdkPublicPaths excuse the adapters package either", () => {
    withBoundary({ ...boundary(), awsSdkPublicPaths: ["packages/aws-adapters/", "packages/"] }, () => {
      expect(awsImportReason("packages/aws-adapters/src/sqs/queue.ts", SDK("ec2"), false)).not.toBeNull();
      expect(awsImportReason("packages/aws-adapters/src/sqs/queue.ts", SDK("ec2"), true)).not.toBeNull();
      expect(awsImportReason("packages/worker/src/new.ts", SDK("ec2"), true)).toBeNull();
    });
  });
});

describe("history that is already public (A-H1)", () => {
  const rule = "private-name";
  const FILE = "docs/old.md";

  function laneWithOldName(): { lane: Lane; commit: string } {
    const lane = new Lane();
    lane.write(FILE, `from ${INTEG}/0512, lane I2\n`);
    lane.commit("old");
    const commit = git(lane.dir, "rev-parse", "HEAD").trim();
    // the tip no longer has the text (as on public code/next): only the commit's own patch shows it
    lane.write(FILE, "from an internal branch\n");
    lane.commit("fixed");
    return { lane, commit };
  }
  const withException = (commit: string, overrides: Partial<{ rule: string; file: string; commit: string }> = {}): BoundaryData => ({
    ...boundary(),
    knownHistory: [{ commit, rule, file: FILE, reason: "a test", ...overrides }],
  });

  it("flags the commit without an exception, and excuses it by commit, rule and file together", () => {
    const { lane, commit } = laneWithOldName();
    expect(lane.guard().map((f) => f.rule)).toContain(rule);
    withBoundary(withException(commit), () => expect(lane.guard()).toEqual([]));
  });

  it("excuses nothing else: not another commit, another rule, another file or a short sha", () => {
    const { lane, commit } = laneWithOldName();
    for (const overrides of [{ commit: "0".repeat(40) }, { rule: "cloud-aws" }, { file: "docs/other.md" }]) {
      withBoundary(withException(commit, overrides), () => expect(rules(lane.guard())).toContain(rule));
    }
    lane.write("docs/new.md", `again ${INTEG}/0512\n`);
    lane.commit("new");
    withBoundary(withException(commit), () => expect(lane.guard().map((f) => f.file)).toEqual(["docs/new.md"]));
    expect(() => parseBoundary(JSON.stringify({ ...boundary(), knownHistory: [{ commit: commit.slice(0, 8), rule, file: FILE, reason: "x" }] }), "x")).toThrow(GuardError);
  });

  it("lists the one real exception, by full sha", () => {
    expect(boundary().knownHistory.map((entry) => `${entry.commit.slice(0, 8)} ${entry.rule}`)).toEqual(["45eb9a7d private-name"]);
  });
});

describe("the data file the guard trusts (A-M2: A17 and A18)", () => {
  const scriptsDir = dirname(new URL(import.meta.url).pathname).replace(/tests\/unit$/, "scripts");

  /** Runs the guard module copied to a folder of its own, from inside another folder (a checkout), and prints what boundary() gives. */
  function probe(options: { dataBeside?: string; dataInCheckout?: string }): string {
    const root = mkdtempSync(join(tmpdir(), "port-guard-trust-"));
    roots.push(root);
    const trusted = join(root, "trusted");
    const checkout = join(root, "checkout");
    mkdirSync(trusted, { recursive: true });
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    copyFileSync(join(scriptsDir, "port-guard.ts"), join(trusted, "port-guard.ts"));
    if (options.dataBeside !== undefined) writeFileSync(join(trusted, "boundary-allowlist.json"), options.dataBeside);
    if (options.dataInCheckout !== undefined) writeFileSync(join(checkout, BOUNDARY_FILE), options.dataInCheckout);
    git(checkout, "init", "-q");
    const code = `import(${JSON.stringify(join(trusted, "port-guard.ts"))}).then((m) => { try { console.log("loaded " + JSON.stringify(m.boundary().awsSdkPublicPaths)); } catch (e) { console.log(e.constructor.name + ": " + e.message); } });`;
    const result = spawnSync(process.execPath, ["-e", code], { cwd: checkout, encoding: "utf8" });
    return result.stdout.trim() + result.stderr.trim();
  }
  const real = readFileSync(join(scriptsDir, "boundary-allowlist.json"), "utf8");
  const widened = JSON.stringify({ ...JSON.parse(real), awsSdkPublicPaths: ["packages/"] });

  it("reads the file beside the guard, and not the checkout's, when both exist (A18)", () => {
    expect(probe({ dataBeside: real, dataInCheckout: widened })).toBe('loaded ["packages/cli/src/"]');
  });

  it("refuses to run a trusted copy that has no data file beside it, even in a checkout that has one (A18)", () => {
    const out = probe({ dataInCheckout: widened });
    expect(out).toMatch(/^GuardError: could not find the boundary data/);
    expect(out).not.toContain("loaded");
  });

  it("never turns a missing, empty or malformed file into empty data (A17)", () => {
    expect(() => loadBoundary(join(tmpdir(), "port-guard-no-such-file.json"))).toThrow(GuardError);
    for (const text of ["", "{}", "[]", "null"]) {
      const file = join(mkdtempSync(join(tmpdir(), "port-guard-data-")), "d.json");
      roots.push(dirname(file));
      writeFileSync(file, text);
      expect(() => loadBoundary(file), text).toThrow(GuardError);
    }
    expect(probe({ dataBeside: "{}" })).toMatch(/^GuardError/);
  });

  it("takes another file when told with --boundary", () => {
    const file = join(mkdtempSync(join(tmpdir(), "port-guard-data-")), "d.json");
    roots.push(dirname(file));
    writeFileSync(file, widened);
    try {
      useBoundaryFile(file);
      expect(boundary().awsSdkPublicPaths).toEqual(["packages/"]);
    } finally {
      useBoundaryFile(undefined);
    }
    expect(boundary().awsSdkPublicPaths).toEqual(["packages/cli/src/"]);
  });
});

describe("private branch names, the ways they hide and the text that only looks like one (A-M3)", () => {
  it.each([
    ["URL-encoded slash", `${INTEG}%2F0513`],
    ["URL-encoded slash in lower case", `${CC}%2fw0-4`],
    ["a backslash", `${INTEG}\\0513`],
    ["spaces around the slash", `${INTEG} / 0513`],
    ["a tab and spaces", `${INTEG}\t/  0513`],
    ["the Cloud integration branch", `${CLD}/${NEXT}`],
    ["the Cloud integration branch after origin/", `origin/${CLD}/${NEXT}`],
    ["spaces in the Cloud integration branch", `${CLD} / ${NEXT}`],
    ["a ref path", `refs/heads/${CC}/consume`],
    ["a remote ref", `refs/remotes/origin/${INTEG}/0510`],
    ["a lane name after private/", `private/${CC}/w0-4-guards`],
    ["a path with the integration branch as a folder", `docs/${INTEG}/0513.md`],
    ["a full-width slash", `${INTEG}\uFF0F0513`],
    ["a double-encoded slash", `${INTEG}%252F0513`],
    ["a triple-encoded slash", `${CC}%25252Fw0-4`],
    ["an HTML character reference (decimal)", `${INTEG}&#47;0513`],
    ["an HTML character reference (hex)", `${CC}&#x2F;consume`],
    ["a named HTML reference", `${CLD}&sol;${NEXT}`],
    ["a GitHub tree URL", `https://example.com/org/repo/tree/${CC}/consume`],
    ["a GitHub tree URL for the integration branch", `https://example.com/org/repo/tree/${INTEG}/0513`],
    ["a GitHub tree URL for the Cloud integration branch", `https://example.com/org/repo/tree/${CLD}/${NEXT}`],
    ["a GitHub blob URL", `https://example.com/org/repo/blob/${CC}/consume/README.md`],
    ["a GitHub compare URL, branch after three dots", `https://example.com/org/repo/compare/main...${CC}/consume`],
    ["a GitHub compare URL, integration branch after three dots", `https://example.com/org/repo/compare/main...${INTEG}/0513`],
    ["a GitHub compare URL, branch after two dots", `https://example.com/org/repo/compare/main..${CC}/consume`],
    ["a GitHub compare URL, branch before the dots", `https://example.com/org/repo/compare/${INTEG}/0513...main`],
    ["a doubled slash", `${INTEG}//0513`],
    ["an escaped slash in JSON", `"${INTEG}\\/0513"`],
    ["a zero-width character", `${INTEG}\u200B/0513`],
  ])("refuses %s", (_name, text) => {
    expect(lineFindings(text)).toEqual([BRANCH]);
    expect(hasPrivateBranch(text)).toBe(true);
  });

  it.each([
    ["a URL with a /cc/ path segment", `https://example.com/${CC}/abc`],
    ["the licence shorthand", `${CC.toUpperCase()}/BY-4.0`],
    ["the licence shorthand in lower case", `licensed ${CC}/by-sa`],
    ["a test folder named after the prefix", `tests/${INTEG}/fixtures/a.ts`],
    ["a relative folder named after the prefix", `../${INTEG}/helpers.ts`],
    ["the prefix and a slash only", `${INTEG}/`],
    ["a framework config file", `${CLD}/${NEXT}.config.js`],
    ["a framework folder", `src/${CLD}/${NEXT}/page.tsx`],
    ["a word that ends in the prefix", `acc/${INTEG}x/y`],
    ["the word on its own", `the ${CLD} ${NEXT} step`],
    ["a lane-looking name with no letter after the slash", `${CC}/0`],
    ["a copy line", `${CC}: someone`],
    ["the mail header words", `${CC}/bcc`],
    ["the mail header words in a sentence", `fill the ${CC}/bcc fields`],
    ["a URL with a /cc/ segment after tree", `https://example.com/tree/main/${CC}/`],
    ["a relative path with dots", `../${CC}/x.ts`],
    ["a compare URL between ordinary branches", "https://example.com/org/repo/compare/main...release"],
    ["a version range with dots", `1.2...${CC}`],
  ])("leaves %s alone", (_name, text) => {
    expect(lineFindings(text)).toEqual([]);
    expect(hasPrivateBranch(text)).toBe(false);
  });

  it("finds a name that is broken over lines, in a file, and says so", () => {
    expect(splitNameFindings([`see ${INTEG}/`, "0513 for it"])).toEqual([BRANCH]);
    expect(splitNameFindings([`see ${CC}/`, "consume for it"])).toEqual([BRANCH]);
    expect(splitNameFindings([`// ${CLD}`, `// /${NEXT}`])).toEqual([BRANCH]);
    expect(splitNameFindings([`${INTEG.slice(0, 2)}`, `${INTEG.slice(2)}/0513`])).toEqual([BRANCH]);
    expect(splitNameFindings(["a plain line", "and another"])).toEqual([]);
    // a name that one line holds whole is the line rule's finding, not the split rule's
    expect(splitNameFindings([`${INTEG}/0513`, "next line"])).toEqual([]);
    const lane = new Lane();
    lane.write("docs/a.md", `see ${INTEG}/\n0513 for it\n`);
    lane.commit();
    expect(lane.guard().map((f) => `${f.rule}:${f.file}:${f.detail.includes("split over lines")}`)).toEqual(["private-name:docs/a.md:true"]);
  });

  it("finds a name split over the lines of a commit message", () => {
    const lane = new Lane();
    lane.write("docs/a.md", "plain\n");
    lane.commit(`subject\n\nbased on ${INTEG}/\n0513`);
    expect(lane.guard().map((f) => f.file)).toEqual(["(commit message or author)"]);
  });
});

describe("the Cloud-only package list (A-M4) and the data that drives it (A13, A14)", () => {
  it.each(["@agentx/model-proxy", "@agentx/design-tokens", "@agentx/model-proxy/dist/a", `@preplabsai/${CLD}-x`, `@agentx/${CLD}`])("refuses importing %s", (specifier) => {
    expect(cloudImportReason("packages/worker/src/a.ts", specifier)).not.toBeNull();
  });

  it.each(["packages/model-proxy/src/a.ts", "packages/design-tokens/package.json", `packages/${CLD}/src/a.ts`, `packages/${CLD}-x/src/a.ts`])("refuses the folder %s", (path) => {
    expect(cloudPathRule(path)?.rule).toBe("cloud-path");
  });

  it("refuses a package file that names them", () => {
    const lane = new Lane();
    lane.write("packages/worker/package.json", '{ "dependencies": { "@agentx/model-proxy": "*" } }\n');
    lane.commit();
    expect(rules(lane.guard())).toEqual(["cloud-import"]);
  });

  it("(A14) refuses the names the code knows even when the data lists none", () => {
    withBoundary({ ...boundary(), cloudOnlyPackages: [], cloudOnlyPackagePatterns: [] }, () => {
      expect(cloudImportReason("packages/worker/src/a.ts", "@agentx/ui")).not.toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", `@agentx/${CLD}-x`)).not.toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", "@agentx/model-proxy")).not.toBeNull();
    });
  });

  it("(A13) refuses a name that only the data lists, by name and by pattern, and nothing else", () => {
    const invented = "@acme/secret-thing";
    expect(cloudImportReason("packages/worker/src/a.ts", invented)).toBeNull();
    withBoundary({ ...boundary(), cloudOnlyPackages: [invented], cloudOnlyPackagePatterns: ["^@acme/private-"] }, () => {
      expect(cloudImportReason("packages/worker/src/a.ts", invented)).not.toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", `${invented}/deep`)).not.toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", "@acme/private-widgets")).not.toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", "@acme/public-widgets")).toBeNull();
      expect(cloudImportReason("packages/worker/src/a.ts", "zod")).toBeNull();
    });
  });

  it("refuses a relative import that climbs out of the repository, but not the same text inside a string, in a test, or a path that stays inside", () => {
    expect(importFindings("packages/a/src/x.ts", 'import x from "../../../../x.js";\n').map((f) => f.detail)).toEqual([expect.stringContaining("outside the repository")]);
    expect(importFindings("packages/a/src/x.ts", 'import x from "../../../b/x.js";\n')).toEqual([]);
    expect(importFindings("tests/unit/x.test.ts", "const t = 'import x from \"../../../x.js\"';\n")).toEqual([]);
    expect(importFindings("tests/unit/x.test.ts", 'import x from "../../../../x.js";\n')).toEqual([]);
  });
});
