// TE-F2 part B: the LAPTOP path. A loopback helper child, started for the check round, reached by the same base-URL variables; no container and no block, so the evidence says exactly "model hosts not blocked on this machine".
// The user's shell may hold REAL model keys: they are overridden with the dummy in the commands' environment and never reach the child. Everything is offline: the real child listens on 127.0.0.1 only.
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog, modelHostBlockList } from "../../packages/contracts/src/index.js";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";
import { MODEL_DUMMY_KEY, laptopModelEnvironment, modelFailureBaseUrl, modelKeyVariables, modelRowBaseUrl, isCredentialVariable } from "../../packages/worker/src/model-helper-env.js";
import { LOCAL_HELPER_CHILD_ENVIRONMENT, localModelHelperPlan, type SpawnSeam } from "../../packages/worker/src/model-helper-local.js";
import { withModelHelperRound, type ModelHelperRoundResult } from "../../packages/worker/src/model-helper-round.js";
import { createRepoReplySetSource } from "../../packages/worker/src/model-reply-set-load.js";

const CATALOG = builtinModelCatalog().rows;
const BLOCK = modelHostBlockList(CATALOG, []);
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../../packages/worker/dist/model-helper.js");
const ADC = { cloudsdkConfigDir: "/run/cloudsdk" };
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rsml-"));
  dirs.push(dir);
  return dir;
};
const setEnv = (name: string, value: string): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
};
/** A real-looking key, built at run time (the public repo refuses key-shaped literals). */
const realLookingKey = (): string => ["sk", "proj", "A1b2C3d4E5f6G7h8", String(Date.now()), "Zq9Xw8Vu7Ts6"].join("-");

describe("the variables", () => {
  it("M2: AI-provider and cloud credentials are UNSET (case-insensitively, by name rule and explicit list); database, ssh and monitoring variables are deliberately kept; the dummy goes in the model key variables", () => {
    const secret = realLookingKey();
    // [name, expectation]: "unset" (removed from the command's environment), "dummy" (model key variable set to the dummy), "kept" (not touched: absent from the set and the unset list)
    const TABLE: Array<[string, "unset" | "dummy" | "kept"]> = [
      ["ANTHROPIC_AUTH_TOKEN", "dummy"], ["AZURE_OPENAI_AD_TOKEN", "dummy"], ["OPENAI_ADMIN_KEY", "dummy"], ["HF_TOKEN", "dummy"], ["OPENAI_API_KEY", "dummy"],
      ["AWS_ACCESS_KEY_ID", "unset"], ["AWS_SECRET_ACCESS_KEY", "unset"], ["AWS_SESSION_TOKEN", "unset"], ["AWS_PROFILE", "unset"], ["AWS_BEARER_TOKEN_BEDROCK", "unset"], ["AWS_SHARED_CREDENTIALS_FILE", "unset"],
      ["openai_api_key", "unset"], ["github_token", "unset"], ["npm_token", "unset"], ["NPM_TOKEN", "unset"], ["NODE_AUTH_TOKEN", "unset"], ["GITHUB_TOKEN", "unset"], ["GH_TOKEN", "unset"], ["STRIPE_APIKEY", "unset"],
      ["APIKEY", "unset"], ["API_KEY", "unset"], ["OPENAI_APIKEY", "unset"], ["SECRETKEY", "unset"], ["SECRET_KEY", "unset"], ["CREDENTIALS", "unset"], ["TOKEN", "unset"], ["AZURE_CLIENT_SECRET", "unset"],
      ["npm_config__authToken", "unset"], ["VAULT_TOKEN", "unset"], ["SNYK_TOKEN", "unset"], ["PASSPHRASE", "unset"], ["GPG_PASSPHRASE", "unset"], ["Some_Vendor_ApiKey", "unset"], ["MY_CREDENTIALS", "unset"], ["TOKENIZER", "unset"],
      ["DATABASE_URL", "kept"], ["REDIS_URL", "kept"], ["DB_PASSWORD", "kept"], ["DB_PASS", "kept"], ["DB_PWD", "kept"], ["MYSQL_PWD", "kept"], ["PGPASSWORD", "kept"], ["POSTGRES_PASSWORD", "kept"], ["SSH_AUTH_SOCK", "kept"], ["SENTRY_DSN", "kept"],
      ["GCLOUD_PROJECT", "kept"], ["GOOGLE_CLOUD_QUOTA_PROJECT", "kept"], ["TOKENIZERS_PARALLELISM", "kept"], ["SERVICE_AUTH", "kept"], ["BASIC_AUTH", "kept"], ["SLACK_WEBHOOK_URL", "kept"], ["SESSIONKEY", "kept"], ["DOCKER_CONFIG", "kept"], ["KUBECONFIG", "kept"],
      ["GOOGLE_CLOUD_PROJECT", "kept"], ["NPM_CONFIG__AUTH", "kept"], ["SIGNING_KEY", "kept"], ["KEYBOARD", "kept"], ["MONKEY", "kept"], ["PRIMARY_KEY", "kept"], ["SORT_KEY", "kept"], ["TURNKEY", "kept"], ["SSH_KEY", "kept"], ["CONFIG_KEY_PATH", "kept"],
      ["PATH", "kept"], ["HOME", "kept"], ["UNRELATED", "kept"],
      // the vendor-prefixed rule (the second re-check's probe list): every AI or cloud vendor name carrying KEY, AUTH, BEARER, CREDENTIAL or PAT, PRIVATE_KEY, SERVICE_ACCOUNT, GH_PAT and GITHUB_PAT; checked BEFORE any *_PASS/*_PWD/*_PASSWORD exemption
      ...["GEMINI_KEY", "OPENAI_KEY", "ANTHROPIC_KEY", "MISTRAL_KEY", "GROQ_KEY", "AZURE_OPENAI_KEY", "COHERE_KEY", "LLM_KEY", "AI_KEY", "MODEL_KEY", "OPENAI_AUTH", "ANTHROPIC_AUTH", "LLM_AUTH", "AZURE_AD_AUTH", "VERTEX_PRIVATE_KEY", "GOOGLE_PRIVATE_KEY",
        "GCP_SA_KEY", "GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "BEDROCK_BEARER", "OPENAI_BEARER", "GITHUB_PAT", "GH_PAT", "ANTHROPIC_OAUTH", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_ACCESS_KEY", "AWS_ACCESS_KEY", "AZURE_CLIENT_CERTIFICATE_PATH",
        "HUGGINGFACE_KEY", "GITHUB_TOKEN_PASSWORD", "OPENAI_API_KEY_PASS", "ANTHROPIC_API_KEY_PWD", "OPENAI_APIKEY_PASSWORD", "GOOGLE_API_CREDENTIAL", "OPENAI_CREDENTIAL", "SERVICE_ACCOUNT", "GCLOUD_SERVICE_KEY", "VERTEX_AI_KEY", "VERTEXAI_KEY",
        "DEEPSEEK_KEY", "PORTKEY_KEY", "HELICONE_AUTH", "COHERE_AUTH", "xai_key", "Together_Key", "Perplexity_Auth", "FIREWORKS_PAT", "OPENROUTER_KEY", "HF_KEY", "HUGGING_AUTH", "CLOUDSDK_AUTH_X", "GCP_CREDENTIAL", "MY_CREDENTIAL", "app_credential", "SERVICE_CREDENTIAL"].map((name): [string, "unset"] => [name, "unset"]),
      // deliberately KEPT: a vendor name with none of the words, and a bare non-vendor *_KEY name
      ["AZURE_OPENAI_ENDPOINT", "kept"], ["AZURE_API_BASE", "kept"], ["OPENAI_ORG_ID", "kept"], ["OPENAI_PROJECT", "kept"], ["OAUTH_JSON", "kept"], ["AZURE_CLIENT_ID", "kept"], ["AZURE_TENANT_ID", "kept"], ["CLOUDSDK_CORE_ACCOUNT", "kept"],
      ["AWS_SSO_SESSION", "kept"], ["OPENAI_SESSION", "kept"], ["STRIPE_KEY", "kept"], ["CACHE_KEY", "kept"],
    ];
    const inherited = Object.fromEntries(TABLE.map(([name]) => [name, secret]));
    const result = laptopModelEnvironment({ rows: CATALOG, rowIds: ["openai"], baseUrl: "http://h:1", metadataHostPort: "127.0.0.1:9", adc: ADC, inherited });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [name, expectation] of TABLE) {
      if (expectation === "unset") {
        expect(result.unset, name).toContain(name);
        expect(result.environment[name], name).toBeUndefined();
      } else if (expectation === "dummy") {
        expect(result.environment[name], name).toBe(MODEL_DUMMY_KEY);
        expect(result.unset, name).not.toContain(name);
      } else {
        expect(result.environment[name], name).toBeUndefined();
        expect(result.unset, name).not.toContain(name);
      }
    }
    // the explicit list is unset even when the shell does not hold the name (a profile file may set it later)
    const empty = laptopModelEnvironment({ rows: CATALOG, rowIds: ["openai"], baseUrl: "http://h:1", metadataHostPort: "127.0.0.1:9", adc: ADC, inherited: {} });
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK"]) expect(empty.ok ? empty.unset : [], name).toContain(name);
    expect(JSON.stringify(result.environment)).not.toContain(secret);
    expect(isCredentialVariable("openai_api_key")).toBe(true);
    expect(isCredentialVariable("DB_PASSWORD")).toBe(false);
  });
  it("point the row's client at the helper, add the companions, and override EVERY key variable with the dummy; Vertex gets the metadata server and an emptied key-file path", () => {
    const gemini = laptopModelEnvironment({ rows: CATALOG, rowIds: ["gemini", "vertex"], baseUrl: "http://127.0.0.1:5555", metadataHostPort: "127.0.0.1:5556", projectId: "rovara-test-project", adc: ADC, inherited: {} });
    expect(gemini.ok).toBe(true);
    const env = gemini.ok ? gemini.environment : {};
    expect(env).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:5555/p/gemini", GOOGLE_VERTEX_BASE_URL: "http://127.0.0.1:5555/p/vertex", GCE_METADATA_HOST: "127.0.0.1:5556", GCE_METADATA_IP: "127.0.0.1:5556",
      GOOGLE_CLOUD_PROJECT: "rovara-test-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "", CLOUDSDK_CONFIG: ADC.cloudsdkConfigDir,
    });
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CO_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) expect(env[name], name).toBe(MODEL_DUMMY_KEY);
    expect(modelKeyVariables(CATALOG)).toEqual(expect.arrayContaining(["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]));
  });
  it("the OpenAI-compatible row's URL carries /v1, a row with its own prefix keeps it, and two rows that want one variable with different values are a conflict", () => {
    const openai = CATALOG.find((row) => row.id === "openai") as (typeof CATALOG)[number];
    const viaGoogle = CATALOG.find((row) => row.id === "gemini-openai") as (typeof CATALOG)[number];
    expect(modelRowBaseUrl(openai, "http://h:1/")).toBe("http://h:1/p/openai/v1");
    expect(modelRowBaseUrl(viaGoogle, "http://h:1")).toBe("http://h:1/p/gemini-openai/v1beta/openai");
    expect(laptopModelEnvironment({ rows: CATALOG, rowIds: ["openai", "gemini-openai"], baseUrl: "http://h:1", metadataHostPort: "127.0.0.1:9", adc: ADC, inherited: {} })).toEqual({ ok: false, reason: "conflict" });
    expect(laptopModelEnvironment({ rows: CATALOG, rowIds: ["nope"], baseUrl: "http://h:1", metadataHostPort: "127.0.0.1:9", adc: ADC, inherited: {} })).toEqual({ ok: false, reason: "unknown_row" });
  });
  it("the failure base URL is a pure function of the row, the mode and afterCalls", () => {
    const openai = CATALOG.find((row) => row.id === "openai") as (typeof CATALOG)[number];
    expect(modelFailureBaseUrl(openai, "http://h:1", { mode: "rate_limit", afterCalls: 2 })).toBe("http://h:1/p/openai/f/rate_limit/n/2/v1");
    expect(modelFailureBaseUrl(openai, "http://h:1", { mode: "token_limit", variant: "input" })).toBe("http://h:1/p/openai/f/token_limit.input/v1");
  });
});

function repo(): { root: string; source: ReturnType<typeof createRepoReplySetSource> } {
  const root = tmp();
  const env = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  mkdirSync(join(root, ".rovara/mocks/model"), { recursive: true });
  writeFileSync(join(root, ".rovara/mocks/model/openai_compatible.json"), JSON.stringify({ version: 1, family: "openai_compatible", replies: [{ id: "chat", match: {}, response: { text: "Hello from the laptop script.", finish: "stop" } }] }));
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  return { root, source: createRepoReplySetSource({ repositoryRoot: root, baseCommit: git("rev-parse", "HEAD"), workingRoot: root, scratchRoot: tmp() }) };
}

describe("the loopback child", () => {
  it("is built before the tests run (the dist of this package)", () => {
    expect(existsSync(ENTRY), "run `tsc -b` first: the laptop child is dist/model-helper.js").toBe(true);
  });
  it("never receives a real key from the user's shell: its whole environment is fixed", async () => {
    const key = realLookingKey();
    for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]) setEnv(name, key);
    setEnv("NODE_OPTIONS", "--require /nonexistent");
    const { source } = repo();
    let childEnv: NodeJS.ProcessEnv | undefined;
    const seam: SpawnSeam = (command, args, options) => {
      childEnv = options.env;
      return spawn(command, args as string[], options);
    };
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, spawn: seam, scratchRoot: tmp(), onResult: () => undefined });
    const started = await plan.start(new AbortController().signal);
    try {
      expect(childEnv).toEqual({ ...LOCAL_HELPER_CHILD_ENVIRONMENT });
      expect(JSON.stringify(childEnv)).not.toContain(key);
      expect(started?.commandEnvironment.OPENAI_API_KEY).toBe(MODEL_DUMMY_KEY);
      expect(JSON.stringify(started?.commandEnvironment)).not.toContain(key);
    } finally {
      await started?.stop();
    }
  });
  it("a real round: the project's command reaches the helper through its redirect with the DUMMY key, gets the scripted reply, and the evidence says 'model hosts not blocked on this machine'", async () => {
    const key = realLookingKey();
    setEnv("OPENAI_API_KEY", key);
    setEnv("GEMINI_API_KEY", key);
    setEnv("AGENTX_TASK_SHELL", "local");
    setEnv("AWS_SECRET_ACCESS_KEY", key);
    setEnv("GEMINI_KEY", key);
    setEnv("STRIPE_KEY", "stripe-test-value");
    setEnv("NPM_TOKEN", key);
    setEnv("DATABASE_URL", "postgres://local/test");
    const { root, source } = repo();
    const results: ModelHelperRoundResult[] = [];
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, scratchRoot: tmp(), onResult: (result) => results.push(result) });
    const runners = withModelHelperRound(plan, createCheckRunners({ rootPath: root, local: true }));
    const script = `
      const http = require("node:http");
      const url = new URL(process.env.OPENAI_BASE_URL + "/chat/completions");
      const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY } }, (res) => {
        let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, key: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY, creds: process.env.GOOGLE_APPLICATION_CREDENTIALS, aws: process.env.AWS_SECRET_ACCESS_KEY, geminiKey: process.env.GEMINI_KEY, stripe: process.env.STRIPE_KEY, npm: process.env.NPM_TOKEN, db: process.env.DATABASE_URL, text })));
      });
      req.end(body);`;
    const result = await runners.runProjectCommand({ cwd: ".", executable: process.execPath, args: ["-e", script], timeoutSeconds: 30 }, new AbortController().signal);
    await runners.endRound?.();
    expect(result.exitCode, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as { status: number; key: string; gemini: string; creds: string; aws?: string; geminiKey?: string; stripe?: string; npm?: string; db?: string; text: string };
    expect(out.status).toBe(200);
    expect(out.key).toBe(MODEL_DUMMY_KEY);
    expect(out.gemini).toBe(MODEL_DUMMY_KEY);
    expect(out.creds).toBe("");
    // unset (absent, not blank) in the command; a database URL is untouched
    expect(out.aws).toBeUndefined();
    // the review's probe: a vendor-prefixed KEY name never reaches the child; a bare non-vendor *_KEY name is deliberately kept
    expect(out.geminiKey).toBeUndefined();
    expect(out.stripe).toBe("stripe-test-value");
    expect(out.npm).toBeUndefined();
    expect(out.db).toBe("postgres://local/test");
    expect(out.text).toContain("Hello from the laptop script.");
    expect(result.stdout).not.toContain(key);
    expect(results).toHaveLength(1);
    const evidence = results[0]?.evidence;
    expect(evidence?.lines[0]).toBe("model hosts not blocked on this machine");
    expect(evidence).toMatchObject({ result: "ran", countsTowardProof: 1 });
    expect(results[0]?.summary).toMatchObject({ blockState: "not_blocked_here", scripted: { before_task: 1, task_made: 0 } });
    // the helper child and its files are gone after the round
    expect(results[0]?.summary?.trusted).toBe(true);
  }, 60_000);
  it("a project with no reply set starts no helper and its commands run unchanged", async () => {
    const root = tmp();
    const source = createRepoReplySetSource({ repositoryRoot: root, baseCommit: "1".repeat(40), workingRoot: root, scratchRoot: tmp() });
    let started = false;
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, spawn: (...args) => { started = true; return spawn(args[0], args[1] as string[], args[2]); }, scratchRoot: tmp(), onResult: () => undefined });
    expect(await plan.start(new AbortController().signal)).toBeUndefined();
    expect(started).toBe(false);
  });
});
