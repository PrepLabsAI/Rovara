# Phase 15b: Sign-in Stack and Release Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AgentX release produces, from the same CDK code, CloudFormation templates that any
organization can deploy without CDK bootstrap for any environment name, the Lambda code packages
those templates need (deterministic zips with SHA-256 checksums), a manifest tying them to the
worker and Slack image digests, and a self-contained npm package for the CLI. A new Cognito
identity stack gives a fresh install its own sign-in. A guarded GitHub Actions workflow publishes
all of it once the owner has set up the publishing accounts.

**Architecture:**
- **Templates.** A new CDK context `agentxSynthesizer=legacy` synthesizes environment stacks with
  CDK's `LegacyStackSynthesizer`: no bootstrap references, and each Lambda asset becomes three
  template parameters (bucket, key, hash). This was checked locally on 2026-09-26: the control
  plane synthesized with 12 asset parameters and no `cdk-hnb659fds` or `BootstrapVersion`
  references.
- **One template, any environment.** Templates are synthesized once with a placeholder environment
  name, `qqenv-placeholderqq`. At install time, `renderTemplate(text, env)` replaces the
  placeholder's hyphen form and underscore form with the real environment. A test proves that a
  rendered template equals a direct synthesis for that environment, byte for byte. The installer
  (phase 15c) therefore deploys templates identical to what CDK would produce, which satisfies
  FR-012 by construction.
- **Release builder.** `scripts/release/build.ts` runs the synthesis in process, zips each asset
  directory deterministically (Node's `zlib` only, no new dependency), and writes `release.json`.
  `scripts/release/verify.ts` rebuilds from source and compares checksums.
- **CLI package.** `scripts/release/pack-cli.ts` bundles the CLI with esbuild into one file and a
  generated `package.json`.
- **Workflow.** `.github/workflows/release.yml` runs on version tags and is disabled until
  `vars.AGENTX_PUBLISH_ENABLED == 'true'`.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x (`zlib.crc32`, `zlib.deflateRawSync`),
Zod 4, Vitest, AWS CDK v2 2.269.0 (`LegacyStackSynthesizer`, `aws-cognito`), esbuild 0.28.2
(already a dev dependency), GitHub Actions, `yaml` 2.9.1 (already a dependency).

**Spec:** [../spec.md](../spec.md): FR-008 (templates, code packages with checksums, images by
digest, the npm CLI), FR-010 (proof recorded here), FR-012 (templates equal the CDK synthesis),
FR-021 (the identity stack; the bring-your-own-OIDC checks belong to `init`, phase 15d). The
phase map is in [README.md](README.md).

**Branch:** `feat/015b-release-artifacts`, cut from mainline `53705c5`. One PR, against `mainline`
(never stacked).

## Decisions recorded by this plan

- **Pull-through proof (FR-010), 2026-09-26, account 944937319445.** A throwaway AgentCore runtime
  pointing at `<account>.dkr.ecr.us-east-1.amazonaws.com/agentx-spike/docker/library/nginx:stable-alpine`
  through an ECR pull-through cache rule for `public.ecr.aws` reached `READY`. The cached
  repository was created on demand, three manifests were imported, and an invoke reached the
  container (a 502 from nginx, which does not speak the AgentCore protocol).
  - The runtime role needs `ecr:BatchImportUpstreamImage` and `ecr:CreateRepository` on the cache
    prefix. That IAM change belongs to phase 15c.
  - Cached images carried no tags, so images must be referenced by digest.
  - Everything the test created was deleted.
- **The admin group is `agentx-admin`, not `agentx-admins`.** The control plane's `AdminValues`
  default is `["agentx-admin"]` (infra/lib/control-plane.ts), and the live deployment uses it.
  The spec's `agentx-admins` (FR-021) is a typo. Task 1 updates the spec text.
- **Placeholder rendering, not parameterized naming.** Making the environment a CloudFormation
  parameter would require CloudFormation intrinsics for every derived name, including
  hyphen-to-underscore for the AgentCore runtime name. Textual rendering keeps one naming code path
  (`environmentNaming`) and makes FR-012 an exact equality test.
- **No LICENSE file exists at the repository root.** The generated npm `package.json` uses
  `"license": "UNLICENSED"` until the owner adds one. Publishing stays disabled regardless.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv` context, templates are
  byte-identical: `tests/contract/legacy-templates.test.ts` snapshots must not change. Never run
  vitest with `-u`.
- **No regressions.** Every existing test passes with its assertions unchanged, except where a task
  names the assertion it deliberately updates.
- **Placeholder, exact values:**
  - `ENVIRONMENT_PLACEHOLDER = "qqenv-placeholderqq"`;
  - its underscore form is `"qqenv_placeholderqq"`;
  - `EnvironmentNameSchema` refuses any name containing `qqenv`.
- **Identity stack, exact values:**
  - stack part `identity`; stack name `agentx-<env>-identity`;
  - user pool name `agentx-<env>`; admin group `agentx-admin`;
  - hosted UI domain prefix `agentx-<env>-<account id>`;
  - app client callback and logout URL `http://127.0.0.1:8765/callback`; no client secret;
    authorization-code flow only; scopes `openid`, `email`, `profile`;
  - outputs `UserPoolId`, `Issuer` (`https://cognito-idp.<region>.amazonaws.com/<pool id>`),
    `ClientId`, `Audience` (equal to the client id), `HostedUiDomain`.
  - The stack exists only under environment naming, and only when the `agentxIdentity` context is
    not `oidc`.
- **`STACK_PARTS` deploy order:** `foundation`, `identity`, `runtime`, `control-plane`, `slack`.
- **Release layout, exact:**
  - `<out>/release.json`;
  - `<out>/templates/<part>.template.json` for each part;
  - `<out>/packages/<assetId>.zip`.
  - The S3 key parameter value for a package uploaded as `packages/<assetId>.zip` is
    `packages/||<assetId>.zip`, because the legacy synthesizer joins the two halves around `||`.
- **Deterministic zips:**
  - entries sorted by forward-slash relative path;
  - DOS date/time fixed at 1980-01-01 00:00:00;
  - external attributes `0o100644 << 16` for files;
  - deflate with raw deflate at level 9;
  - no directory entries, no extra fields.
- **Nothing publishes by default.** Every job in `release.yml` that pushes, uploads or publishes is
  guarded by `vars.AGENTX_PUBLISH_ENABLED == 'true'`. The workflow never runs on pull requests.
- **Commands:** the gate is `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22 (`export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` on
    the owner's machine).
  - CDK packaging tests can time out under load (issue #59). Rerun that file alone.

## Review Focus

1. **A rendered template that still contains the placeholder**, for example inside a string that
   CDK split or encoded, or one that renders an environment into the wrong form (hyphen where an
   AgentCore name needs an underscore). Task 2's equality test for `staging` and `dev-2` pins both
   forms, and `renderTemplate` refuses output that still contains `qqenv`.
2. **An asset parameter in a template with no matching package in the release**, which would fail
   at deploy time with a missing parameter. Task 3 asserts that every `AssetParameters*` parameter
   in every template is covered by exactly one manifest package entry, and that no package is
   unused.
3. **A zip that differs between two builds of the same commit** (file order, timestamps,
   permissions, a platform-dependent path separator). Task 4 builds twice into different
   directories and compares every checksum. Task 3 unit-tests the zip writer against fixed input
   bytes.
4. **An npm CLI bundle that breaks at run time** because esbuild could not follow a dynamic import
   or `require` in a dependency. Task 5 installs the packed tarball offline into an empty directory
   and runs `agentx --version` and `agentx --help`.
5. **The release workflow publishing when it should not**: on a pull request, on a branch push,
   with the guard unset, or with images referenced by tag instead of digest. Task 6's contract test
   parses the workflow and asserts each of these.

---

### Task 1: Identity stack (Cognito) and the `identity` stack part

**Files:**
- Create: `infra/lib/identity.ts`
- Modify: `packages/contracts/src/environments.ts` (`StackPart` and `STACK_PARTS` add `identity`)
- Modify: `packages/cli/src/environments/settings.ts` (`stacks.identity` optional)
- Modify: `infra/lib/app.ts` (build the identity stack under environment naming)
- Modify: `tests/contract/environments.test.ts` (the one `STACK_PARTS` assertion, deliberately)
- Modify: `specs/015-installer/spec.md` (FR-021 group name `agentx-admin`)
- Test: `tests/contract/identity-stack.test.ts`

**Interfaces:**
- Produces:
  - `export class IdentityStack extends Stack` with props `{ naming: AgentXNaming } & StackProps`.
  - `export const ADMIN_GROUP = "agentx-admin"` and `export const CLI_CALLBACK_URL = "http://127.0.0.1:8765/callback"`
    in `infra/lib/identity.ts`.
  - `StackPart` gains `"identity"`.
  - `EnvironmentSettings.stacks.identity?: string`.
- Consumes: `AgentXNaming`, `environmentNaming`, `legacyNaming` from `infra/lib/naming.ts`;
  `buildAgentXApp` from `infra/lib/app.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/identity-stack.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ADMIN_GROUP, CLI_CALLBACK_URL, IdentityStack } from "../../infra/lib/identity.js";
import { environmentNaming } from "../../infra/lib/naming.js";

function identityTemplate(env = "staging"): Template {
  const app = new App();
  return Template.fromStack(new IdentityStack(app, "Identity", { naming: environmentNaming(env), env: { region: "us-east-1", account: "123456789012" } }));
}

describe("identity stack", () => {
  it("creates an invite-only user pool named for the environment, kept on delete", () => {
    const template = identityTemplate();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "agentx-staging",
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: ["email"],
      DeletionProtection: "ACTIVE",
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
    });
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("creates the admin group the control plane expects", () => {
    expect(ADMIN_GROUP).toBe("agentx-admin");
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "agentx-admin" });
  });

  it("creates a public PKCE app client for the CLI's loopback login", () => {
    expect(CLI_CALLBACK_URL).toBe("http://127.0.0.1:8765/callback");
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      CallbackURLs: ["http://127.0.0.1:8765/callback"],
      LogoutURLs: ["http://127.0.0.1:8765/callback"],
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("uses a hosted UI domain prefix with the environment and account", () => {
    identityTemplate().hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "agentx-staging-123456789012" });
  });

  it("refuses an environment name Cognito would reject in the hosted UI domain", () => {
    for (const env of ["aws-dev", "amazon", "mycognito"]) {
      expect(() => identityTemplate(env), env).toThrow(/Cognito domain/);
    }
  });

  it("outputs what the control plane and the CLI need", () => {
    const outputs = identityTemplate().toJSON().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs).sort()).toEqual(["Audience", "ClientId", "HostedUiDomain", "Issuer", "UserPoolId"]);
    expect(JSON.stringify(outputs.Issuer)).toContain("https://cognito-idp.");
  });

  it("is built only for environments, and not when bringing your own OIDC", () => {
    const names = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c)).map((s) => s.stackName);
    expect(names(buildAgentXApp())).not.toContain("agentx-production-identity");
    expect(names(buildAgentXApp()).some((n) => n.toLowerCase().includes("identity"))).toBe(false);
    expect(names(buildAgentXApp({ agentxEnv: "staging" }))).toContain("agentx-staging-identity");
    expect(names(buildAgentXApp({ agentxEnv: "staging", agentxIdentity: "oidc" }))).not.toContain("agentx-staging-identity");
  }, 240_000);
});
```

In `tests/contract/environments.test.ts`, change the one assertion
`expect(STACK_PARTS).toEqual(["foundation", "runtime", "control-plane", "slack"])` to
`["foundation", "identity", "runtime", "control-plane", "slack"]`, and add
`expect(environmentStackName("staging", "identity")).toBe("agentx-staging-identity")`.

In `tests/contract/environment-settings.test.ts`, add a test that settings with
`stacks.identity: "agentx-staging-identity"` round-trip, and that the existing fixture without
`identity` still parses.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/identity-stack.test.ts tests/contract/environments.test.ts tests/contract/environment-settings.test.ts`
Expected: FAIL, cannot resolve `infra/lib/identity.js`, and the `STACK_PARTS` assertion fails.

- [ ] **Step 3: Implement**

`infra/lib/identity.ts`:

```ts
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

export const ADMIN_GROUP = "agentx-admin";
export const CLI_CALLBACK_URL = "http://127.0.0.1:8765/callback";

export interface IdentityStackProps extends StackProps {
  naming: AgentXNaming;
}

/** Sign-in for a fresh install. The control plane's AdminClaim default is cognito:groups. */
export class IdentityStack extends Stack {
  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const env = props.naming.env;
    if (env === undefined) throw new Error("the identity stack exists only for named environments");
    // Cognito refuses hosted UI domain prefixes containing these words; fail at synth, not deploy.
    const reserved = ["aws", "amazon", "cognito"].find((word) => env.includes(word));
    if (reserved !== undefined) throw new Error(`environment name ${env} cannot be used for the Cognito domain (it contains "${reserved}"); choose another name or bring your own OIDC`);

    const pool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `agentx-${env}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: pool.userPoolId,
      groupName: ADMIN_GROUP,
      description: "AgentX administrators",
    });
    const domain = pool.addDomain("HostedUi", { cognitoDomain: { domainPrefix: `agentx-${env}-${this.account}` } });
    const client = pool.addClient("Cli", {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [CLI_CALLBACK_URL],
        logoutUrls: [CLI_CALLBACK_URL],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "Issuer", { value: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}` });
    new CfnOutput(this, "ClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "Audience", { value: client.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: domain.baseUrl() });
  }
}
```

If `authFlows: {}` synthesizes an `ExplicitAuthFlows` value that includes password flows, set it so
that only refresh-token auth is allowed (`ALLOW_REFRESH_TOKEN_AUTH`). Assert the synthesized value in
the test.

In `packages/contracts/src/environments.ts`, add `"identity"` to `StackPart` and put it second in
`STACK_PARTS`. In `settings.ts`, make the stacks object
`z.object({ foundation, identity: z.string().optional(), runtime, "control-plane": ..., slack }).strict()`.

In `infra/lib/app.ts`, under environment naming only, when
`app.node.tryGetContext("agentxIdentity") !== "oidc"`, create
`new IdentityStack(app, "AgentXIdentity", { stackName: naming.stackName("identity"), naming, env: { region } })`
after the foundation stack. Refuse any `agentxIdentity` value other than `cognito`, `oidc` or
unset, with an error naming the value.

In `specs/015-installer/spec.md` FR-021, replace `agentx-admins` with `agentx-admin`.

- [ ] **Step 4: Run the tests, the naming tests and the legacy snapshots**

Run: `npx vitest run tests/contract/identity-stack.test.ts tests/contract/environments.test.ts tests/contract/environment-settings.test.ts tests/contract/environment-naming.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS. The legacy snapshots are unchanged. The two-environment collision test still
passes with the identity stacks included, because pool names and domain prefixes carry the
environment.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/identity.ts infra/lib/app.ts packages/contracts/src/environments.ts packages/cli/src/environments/settings.ts specs/015-installer/spec.md tests/contract/identity-stack.test.ts tests/contract/environments.test.ts tests/contract/environment-settings.test.ts
git commit -m "feat(infra): Cognito identity stack for new environments"
```

### Task 2: Templates for any environment (legacy synthesizer and placeholder rendering)

**Files:**
- Create: `packages/contracts/src/templates.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Modify: `packages/contracts/src/environments.ts` (refuse names containing `qqenv`)
- Modify: `infra/lib/app.ts` (the `agentxSynthesizer` context)
- Test: `tests/contract/template-rendering.test.ts`

**Interfaces:**
- Produces:
  - `ENVIRONMENT_PLACEHOLDER` and `ENVIRONMENT_PLACEHOLDER_UNDERSCORED` in `packages/contracts/src/templates.ts`;
  - `renderTemplate(text: string, env: string): string`;
  - `buildAgentXApp({ agentxEnv, agentxSynthesizer: "legacy" })`, which uses `LegacyStackSynthesizer`
    for every stack. It is refused for legacy naming, because that deployment keeps CDK bootstrap.
- Consumes: Task 1's `STACK_PARTS`; `buildAgentXApp`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/template-rendering.test.ts
import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, ENVIRONMENT_PLACEHOLDER_UNDERSCORED, EnvironmentNameSchema, renderTemplate } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";

function templates(env: string): Map<string, string> {
  const assembly = buildAgentXApp({ agentxEnv: env, agentxSynthesizer: "legacy" }).synth();
  const byPart = new Map<string, string>();
  for (const stack of assembly.stacks) {
    const part = stack.stackName.replace(`agentx-${env}-`, "");
    byPart.set(part, JSON.stringify(stack.template));
  }
  return byPart;
}

describe("templates for any environment", () => {
  it("uses a placeholder that is a valid name and that no real environment can take", () => {
    expect(ENVIRONMENT_PLACEHOLDER).toBe("qqenv-placeholderqq");
    expect(ENVIRONMENT_PLACEHOLDER_UNDERSCORED).toBe("qqenv_placeholderqq");
    expect(EnvironmentNameSchema.safeParse("myqqenv").success).toBe(false);
  });

  it("needs no CDK bootstrap and takes code package locations as parameters", () => {
    for (const [part, text] of templates(ENVIRONMENT_PLACEHOLDER)) {
      expect(text, part).not.toContain("cdk-hnb659fds");
      expect(text, part).not.toContain("BootstrapVersion");
    }
    expect(templates(ENVIRONMENT_PLACEHOLDER).get("control-plane")).toMatch(/AssetParameters[0-9a-f]{64}S3Bucket/);
  }, 300_000);

  it.each(["staging", "dev-2"])("renders to exactly what CDK synthesizes for %s", (env) => {
    const published = templates(ENVIRONMENT_PLACEHOLDER);
    const direct = templates(env);
    expect([...published.keys()].sort()).toEqual([...direct.keys()].sort());
    for (const [part, text] of published) {
      expect(renderTemplate(text, env), part).toBe(direct.get(part));
    }
  }, 600_000);

  it("refuses an invalid environment and refuses output that still holds the placeholder", () => {
    expect(() => renderTemplate("x", "Bad")).toThrow(/environment name/);
    expect(() => renderTemplate("qqenv", "staging")).toThrow(/placeholder/);
  });

  it("is refused for the deployment that predates environments", () => {
    expect(() => buildAgentXApp({ agentxSynthesizer: "legacy" })).toThrow(/named environment/);
  });
});
```

The test `renderTemplate("qqenv", "staging")` must throw, because `qqenv` alone is a fragment of
the placeholder that rendering did not replace.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/template-rendering.test.ts`
Expected: FAIL, `ENVIRONMENT_PLACEHOLDER` is not exported.

- [ ] **Step 3: Implement**

`packages/contracts/src/templates.ts`:

```ts
import { EnvironmentNameSchema } from "./environments.js";

/** A valid environment name no real environment can use (EnvironmentNameSchema refuses "qqenv"). */
export const ENVIRONMENT_PLACEHOLDER = "qqenv-placeholderqq";
/** The same name as naming.ts writes it where hyphens are not allowed (AgentCore names). */
export const ENVIRONMENT_PLACEHOLDER_UNDERSCORED = "qqenv_placeholderqq";

/** Turns a published template (synthesized for the placeholder) into the template for env. */
export function renderTemplate(text: string, env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const rendered = text
    .replaceAll(ENVIRONMENT_PLACEHOLDER, parsed.data)
    .replaceAll(ENVIRONMENT_PLACEHOLDER_UNDERSCORED, parsed.data.replaceAll("-", "_"));
  if (rendered.includes("qqenv")) throw new Error("rendered template still contains the environment placeholder");
  return rendered;
}
```

In `packages/contracts/src/environments.ts`, add
`.refine((name) => !name.includes("qqenv"), "environment name must not contain \"qqenv\" (reserved for published templates)")`.
The placeholder itself must still parse, because `environmentNaming(ENVIRONMENT_PLACEHOLDER)` has
to work. So apply the refine as `name === "qqenv-placeholderqq" || !name.includes("qqenv")`, and
test both sides. Do not import `templates.ts` into `environments.ts`, because that would create a
cycle.

In `infra/lib/app.ts`, read `agentxSynthesizer`:
- unset: behaviour is unchanged;
- `legacy`: requires `naming.env !== undefined` (otherwise throw "the legacy synthesizer is only for
  a named environment"), and constructs the `App` with
  `defaultStackSynthesizer: new LegacyStackSynthesizer()`;
- any other value: throw an error naming it.

Because `buildAgentXApp` constructs the `App` from its context argument, pick the synthesizer
before `new App(...)`.

- [ ] **Step 4: Run the test, then the naming tests and the legacy snapshots**

Run: `npx vitest run tests/contract/template-rendering.test.ts tests/contract/environments.test.ts tests/contract/environment-naming.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS, and the legacy snapshots are unchanged.

If the equality test fails, diff the two JSON strings and find the substring that differs. Do not
loosen the assertion. The likely causes are a name derived from the environment in a way
`renderTemplate` does not reproduce, or a hash that depends on the stack name. Fix the source of
the difference in `naming.ts` or the stack, keeping legacy naming unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/templates.ts packages/contracts/src/index.ts packages/contracts/src/environments.ts infra/lib/app.ts tests/contract/template-rendering.test.ts
git commit -m "feat(infra): bootstrap-free templates that render for any environment"
```

### Task 3: Deterministic code packages and the release builder

**Files:**
- Create: `scripts/release/zip.ts`
- Create: `scripts/release/build.ts`
- Create: `scripts/release/manifest.ts` (the `release.json` schema)
- Modify: `package.json` (script `"release:build": "tsx scripts/release/build.ts"`)
- Test: `tests/contract/release-zip.test.ts`, `tests/contract/release-build.test.ts`

**Interfaces:**
- Produces:

```ts
// scripts/release/zip.ts
export interface ZipEntry { path: string; data: Buffer }
/** Deterministic zip: sorted entries, fixed 1980-01-01 time, 0644 files, raw deflate level 9. */
export function deterministicZip(entries: ZipEntry[]): Buffer;
export async function zipDirectory(directory: string): Promise<Buffer>;

// scripts/release/manifest.ts
export const ReleaseManifestSchema: z.ZodObject<...>;
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

// scripts/release/build.ts
export async function buildRelease(input: { version: string; out: string; gitCommit: string; images?: { worker?: string; slack?: string } }): Promise<ReleaseManifest>;
```

`ReleaseManifestSchema`, exact and `.strict()` at every level:

```ts
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ImageDigest = z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/);
export const ReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  environmentPlaceholder: z.literal("qqenv-placeholderqq"),
  templates: z.array(z.object({ part: z.enum(["foundation", "identity", "runtime", "control-plane", "slack"]), file: z.string(), sha256: Sha256 }).strict()),
  packages: z.array(z.object({
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    file: z.string(),
    sha256: Sha256,
    parts: z.array(z.string()).min(1),
    bucketParameter: z.string(),
    keyParameter: z.string(),
    hashParameter: z.string(),
    keyParameterValue: z.string(),
  }).strict()),
  images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional() }).strict(),
}).strict();
```

`build.ts` is also a CLI:
`tsx scripts/release/build.ts --version <v> --out <dir> [--worker-image <uri@sha256:…>] [--slack-image <uri@sha256:…>]`.
`gitCommit` comes from `git rev-parse HEAD`. The out directory must be empty or absent; the script
refuses to write into a non-empty directory.

- [ ] **Step 1: Write the failing zip test**

```ts
// tests/contract/release-zip.test.ts
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deterministicZip } from "../../scripts/release/zip.js";

const entries = [
  { path: "b/index.js", data: Buffer.from("console.log('b');\n") },
  { path: "a.js", data: Buffer.from("export const a = 1;\n") },
];

function localHeaders(zip: Buffer): Array<{ name: string; time: number; date: number; data: Buffer }> {
  const found = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    found.push({ name, time: zip.readUInt16LE(offset + 10), date: zip.readUInt16LE(offset + 12), data: inflateRawSync(zip.subarray(start, start + compressedSize)) });
    offset = start + compressedSize;
  }
  return found;
}

describe("deterministic zip", () => {
  it("is byte-identical regardless of input order", () => {
    const one = deterministicZip(entries);
    const two = deterministicZip([...entries].reverse());
    expect(createHash("sha256").update(one).digest("hex")).toBe(createHash("sha256").update(two).digest("hex"));
  });

  it("sorts entries, fixes the timestamp at 1980-01-01, and round-trips the contents", () => {
    const headers = localHeaders(deterministicZip(entries));
    expect(headers.map((h) => h.name)).toEqual(["a.js", "b/index.js"]);
    expect(headers.every((h) => h.time === 0 && h.date === ((0 << 9) | (1 << 5) | 1))).toBe(true);
    expect(headers[0]!.data.toString()).toBe("export const a = 1;\n");
    expect(headers[1]!.data.toString()).toBe("console.log('b');\n");
  });

  it("refuses unsafe or duplicate paths", () => {
    expect(() => deterministicZip([{ path: "../x", data: Buffer.from("") }])).toThrow(/path/);
    expect(() => deterministicZip([{ path: "/abs", data: Buffer.from("") }])).toThrow(/path/);
    expect(() => deterministicZip([{ path: "a", data: Buffer.from("1") }, { path: "a", data: Buffer.from("2") }])).toThrow(/duplicate/);
  });

  it("ends with a valid end-of-central-directory record for the entry count", () => {
    const zip = deterministicZip(entries);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/release-zip.test.ts`
Expected: FAIL, cannot resolve `scripts/release/zip.js`.

- [ ] **Step 3: Implement `zip.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry { path: string; data: Buffer }

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

function checkPath(path: string): void {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`unsafe zip entry path ${JSON.stringify(path)}`);
  }
}

export function deterministicZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    checkPath(entry.path);
    if (seen.has(entry.path)) throw new Error(`duplicate zip entry ${entry.path}`);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(FILE_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export async function zipDirectory(directory: string): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  async function walk(current: string): Promise<void> {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) entries.push({ path: relative(directory, full).split(sep).join("/"), data: await readFile(full) });
      else throw new Error(`unsupported file type in asset directory: ${full}`);
    }
  }
  await walk(directory);
  return deterministicZip(entries);
}
```

A single file over 4 GiB is out of scope, because Lambda's own limits are far smaller. Refuse
entries whose size exceeds `0xffffffff` with a clear error, and test that refusal with a small
stubbed length check if it can be done without allocating 4 GiB. If it can't, document the limit
in a comment.

- [ ] **Step 4: Run the zip test**

Run: `npx vitest run tests/contract/release-zip.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing build test**

```ts
// tests/contract/release-build.test.ts
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { ReleaseManifestSchema } from "../../scripts/release/manifest.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const worker = `public.ecr.aws/agentx/agentx-worker@sha256:${"a".repeat(64)}`;

describe("release builder", () => {
  it("writes templates, packages and a manifest whose checksums match the files", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), images: { worker } });
    expect(ReleaseManifestSchema.parse(JSON.parse(await readFile(join(out, "release.json"), "utf8")))).toEqual(manifest);
    expect(manifest.templates.map((t) => t.part)).toEqual(["foundation", "identity", "runtime", "control-plane", "slack"]);
    for (const t of manifest.templates) expect(sha(await readFile(join(out, t.file)))).toBe(t.sha256);
    for (const p of manifest.packages) {
      expect(sha(await readFile(join(out, p.file)))).toBe(p.sha256);
      expect(p.file).toBe(`packages/${p.assetId}.zip`);
      expect(p.keyParameterValue).toBe(`packages/||${p.assetId}.zip`);
    }
    expect(manifest.images).toEqual({ worker });
  }, 600_000);

  it("covers every asset parameter in every template with exactly one package, and ships no unused package", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40) });
    const declared = new Set(manifest.packages.flatMap((p) => [p.bucketParameter, p.keyParameter, p.hashParameter]));
    const used = new Set<string>();
    for (const t of manifest.templates) {
      const template = JSON.parse(await readFile(join(out, t.file), "utf8")) as { Parameters?: Record<string, unknown> };
      for (const name of Object.keys(template.Parameters ?? {}).filter((n) => n.startsWith("AssetParameters"))) {
        expect(declared.has(name), `${t.part}: ${name}`).toBe(true);
        used.add(name);
      }
    }
    expect([...declared].filter((n) => !used.has(n))).toEqual([]);
    expect((await readdir(join(out, "packages"))).sort()).toEqual(manifest.packages.map((p) => `${p.assetId}.zip`).sort());
  }, 600_000);

  it("refuses a non-empty output directory and a malformed image reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    await buildRelease({ version: "1.2.3", out: join(dir, "r"), gitCommit: "b".repeat(40) });
    await expect(buildRelease({ version: "1.2.3", out: join(dir, "r"), gitCommit: "b".repeat(40) })).rejects.toThrow(/not empty/);
    await expect(buildRelease({ version: "1.2.3", out: join(dir, "s"), gitCommit: "b".repeat(40), images: { worker: "public.ecr.aws/x/y:latest" } })).rejects.toThrow(/digest/);
  }, 600_000);
});
```

- [ ] **Step 6: Run it to verify it fails, then implement `manifest.ts` and `build.ts`**

Run: `npx vitest run tests/contract/release-build.test.ts`
Expected: FAIL, cannot resolve `scripts/release/build.js`.

`buildRelease` does the following, in order:
1. Validate `images` against `ImageDigest` before any work. A tag reference fails with "image must
   be referenced by digest".
2. Refuse a non-empty `out` directory.
3. Synthesize in process:
   `buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy", agentxRegion: "us-east-1", outdir })`.
   The synthesis happens in a temporary directory. `buildAgentXApp` must forward an `outdir`
   context key to `new App({ outdir })`; add that to `app.ts` with a test that the default is
   unchanged.
4. For each part in `STACK_PARTS` order, write `templates/<part>.template.json` as
   `JSON.stringify(template, null, 2) + "\n"`.
5. From each stack's `assets`, keep `packaging: "zip"`. Group by asset id across stacks, recording
   each part that uses it. `zipDirectory(join(assembly.directory, asset.path))` writes
   `packages/<id>.zip`. Record the parameter names from the asset metadata and
   `keyParameterValue: "packages/||<id>.zip"`. Any asset with other packaging (a Docker image
   asset) is an error naming it, because images are published separately.
6. Write `release.json` as validated, pretty JSON, in a stable order: templates in part order,
   packages sorted by asset id.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/release-zip.test.ts tests/contract/release-build.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/release package.json tests/contract/release-zip.test.ts tests/contract/release-build.test.ts infra/lib/app.ts
git commit -m "feat(release): deterministic code packages and the release builder"
```

### Task 4: Release verification and the CI determinism check

**Files:**
- Create: `scripts/release/verify.ts`
- Modify: `package.json` (script `"release:verify": "tsx scripts/release/verify.ts"`)
- Modify: `.github/workflows/ci.yml`, or the file that holds the `CI` workflow (add one step to the
  `local` job)
- Test: `tests/contract/release-verify.test.ts`

**Interfaces:**
- Produces: `verifyRelease(input: { dir: string }): Promise<{ ok: true } | { ok: false; problems: string[] }>`.
  It reads `release.json`, checks every file's checksum, then rebuilds from the current source into
  a temporary directory (same version and gitCommit, no images) and compares template and package
  checksums. CLI: `tsx scripts/release/verify.ts <dir>` exits 1 and prints each problem.
- Consumes: Task 3's `buildRelease`, `ReleaseManifestSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/release-verify.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { verifyRelease } from "../../scripts/release/verify.js";

describe("release verification", () => {
  it("passes for a release built from the current source", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-verify-")), "r");
    await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    expect(await verifyRelease({ dir })).toEqual({ ok: true });
  }, 900_000);

  it("names a tampered package and a tampered template", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-verify-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    await writeFile(join(dir, manifest.packages[0]!.file), "tampered");
    await writeFile(join(dir, manifest.templates[0]!.file), "{}\n");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.packages[0]!.file))).toBe(true);
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 900_000);
});
```

- [ ] **Step 2: Run it to verify it fails, implement `verify.ts`, and run it to see it pass**

Run: `npx vitest run tests/contract/release-verify.test.ts`
Expected: first FAIL (module missing), then PASS after the implementation.

- [ ] **Step 3: Add the CI determinism step**

In the CI workflow's `local` job, after `npm run infra:synth`, add:

```yaml
      - name: Release builds are reproducible
        run: |
          npm run release:build -- --version 0.0.0-ci --out "$RUNNER_TEMP/release-a"
          npm run release:build -- --version 0.0.0-ci --out "$RUNNER_TEMP/release-b"
          diff "$RUNNER_TEMP/release-a/release.json" "$RUNNER_TEMP/release-b/release.json"
          npm run release:verify -- "$RUNNER_TEMP/release-a"
```

Add a contract test, appended to `tests/contract/release-verify.test.ts`, that parses the CI
workflow with `yaml` and asserts that this step exists in the `local` job and runs after the synth
step.

- [ ] **Step 4: Run it locally the same way, then commit**

Run the four commands above locally with a temporary directory in place of `$RUNNER_TEMP`.
Expected: `diff` prints nothing, and verify exits 0.

```bash
git add scripts/release/verify.ts package.json .github/workflows tests/contract/release-verify.test.ts
git commit -m "feat(release): verify releases and check reproducibility in CI"
```

### Task 5: The publishable CLI package

**Files:**
- Create: `scripts/release/pack-cli.ts`
- Modify: `packages/cli/src/main.ts` (version from a build-time constant)
- Modify: `package.json` (script `"release:pack-cli": "tsx scripts/release/pack-cli.ts"`)
- Test: `tests/contract/release-pack-cli.test.ts`

**Interfaces:**
- Produces:
  - `packCli(input: { version: string; out: string; name?: string }): Promise<{ tarball: string }>`.
    The default `name` is `@charterarc/agentx`.
  - `pack-cli.ts` writes `out/package/bin/agentx.mjs` (a single esbuild bundle), a generated
    `out/package/package.json`, and `README.md`, then runs `npm pack` into `out`.
  - `main.ts` uses `declare const __AGENTX_VERSION__: string | undefined;` and
    `.version(typeof __AGENTX_VERSION__ === "string" ? __AGENTX_VERSION__ : "0.1.0")`.

The generated `package.json` (exact keys):
- `name`, `version`, `"type": "module"`;
- `"bin": { "agentx": "bin/agentx.mjs" }`;
- `"engines": { "node": ">=22.19.0" }`;
- `"license": "UNLICENSED"`;
- `"files": ["bin", "README.md"]`;
- `"description": "AgentX installer and administration CLI"`;
- no `dependencies`, because everything is bundled.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/release-pack-cli.test.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { packCli } from "../../scripts/release/pack-cli.js";

const run = promisify(execFile);

describe("publishable CLI package", () => {
  it("installs offline into an empty directory and runs", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-"));
    const { tarball } = await packCli({ version: "1.2.3", out });
    const manifest = JSON.parse(await readFile(join(out, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "@charterarc/agentx", version: "1.2.3", bin: { agentx: "bin/agentx.mjs" }, license: "UNLICENSED" });
    expect(manifest.dependencies).toBeUndefined();

    const project = await mkdtemp(join(tmpdir(), "agentx-install-"));
    await run("npm", ["init", "-y"], { cwd: project });
    await run("npm", ["install", "--offline", "--no-audit", "--no-fund", tarball], { cwd: project });
    const bin = join(project, "node_modules", ".bin", "agentx");
    expect((await run(bin, ["--version"])).stdout.trim()).toBe("1.2.3");
    const help = (await run(bin, ["--help"])).stdout;
    expect(help).toContain("env");
    expect(help).toContain("admin");
  }, 300_000);
});
```

- [ ] **Step 2: Run it to verify it fails, implement, and run it to see it pass**

`packCli` calls esbuild with:
- `entryPoints: ["packages/cli/src/main.ts"]`, `bundle: true`, `platform: "node"`;
- `format: "esm"`, `target: "node22"`;
- `outfile: join(out, "package/bin/agentx.mjs")`;
- `define: { __AGENTX_VERSION__: JSON.stringify(version) }`;
- `banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }`,
  so that bundled CommonJS dependencies can call `require`;
- `legalComments: "none"`.

Then set the file mode to 0755, write the `package.json` and a short `README.md`, and run
`npm pack --pack-destination <out>` in `out/package`. Return the tarball path.

Run: `npx vitest run tests/contract/release-pack-cli.test.ts`
Expected: first FAIL (module missing), then PASS.

If `--version` fails because `main.ts` only runs its program when executed directly, check how
`main.ts` decides that. Make sure the bundled entry runs the CLI. Do it without changing how
`executeCli` is imported by tests.

- [ ] **Step 3: Commit**

```bash
git add scripts/release/pack-cli.ts packages/cli/src/main.ts package.json tests/contract/release-pack-cli.test.ts
git commit -m "feat(release): self-contained npm package for the CLI"
```

### Task 6: The guarded release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `tests/contract/release-workflow.test.ts`

**Interfaces:**
- Consumes:
  - `npm run release:build`, `npm run release:verify`, `npm run release:pack-cli`;
  - `environments/base/Dockerfile` (worker) and `environments/slack/Dockerfile` (Slack service).
- Workflow inputs from repository variables:
  - `AGENTX_PUBLISH_ENABLED`;
  - `AGENTX_PUBLISH_ROLE_ARN`: the AWS role GitHub assumes through OIDC to push to ECR Public;
  - `AGENTX_ECR_PUBLIC_ALIAS`;
  - `AGENTX_NPM_PACKAGE`: the default is `@charterarc/agentx`.
- No npm token: publishing uses npm trusted publishing (OIDC). The owners publish the first
  version by hand, then enable the trusted publisher for `release.yml`. The workflow upgrades npm
  to 11 and runs `npm publish --provenance`.

The workflow, exact structure:

```yaml
name: Release

on:
  push:
    tags: ["v[0-9]+.[0-9]+.[0-9]+"]
  workflow_dispatch:
    inputs:
      version:
        description: "Version to publish (x.y.z); must match an existing tag vX.Y.Z"
        required: true

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci
      - run: npm run typecheck && npm run lint && npm test && npm run infra:synth

  images:
    needs: test
    if: vars.AGENTX_PUBLISH_ENABLED == 'true'
    runs-on: ubuntu-24.04-arm
    permissions: { contents: read, id-token: write }
    outputs:
      worker: ${{ steps.push.outputs.worker }}
      slack: ${{ steps.push.outputs.slack }}
    steps:
      - uses: actions/checkout@v5
      - uses: aws-actions/configure-aws-credentials@v5
        with: { role-to-assume: "${{ vars.AGENTX_PUBLISH_ROLE_ARN }}", aws-region: us-east-1 }
      - uses: aws-actions/amazon-ecr-login@v2
        with: { registry-type: public }
      - id: push
        env:
          ALIAS: ${{ vars.AGENTX_ECR_PUBLIC_ALIAS }}
          VERSION: ${{ inputs.version || github.ref_name }}
        run: |
          VERSION="${VERSION#v}"
          for image in worker slack; do
            dockerfile=environments/base/Dockerfile; [ "$image" = slack ] && dockerfile=environments/slack/Dockerfile
            repo="public.ecr.aws/$ALIAS/agentx-$image"
            docker buildx build --platform linux/arm64 --file "$dockerfile" --tag "$repo:$VERSION" --push --metadata-file "$RUNNER_TEMP/$image.json" .
            digest=$(jq -r '."containerimage.digest"' "$RUNNER_TEMP/$image.json")
            echo "$image=$repo@$digest" >> "$GITHUB_OUTPUT"
          done

  release:
    needs: images
    if: vars.AGENTX_PUBLISH_ENABLED == 'true'
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci
      - env:
          VERSION: ${{ inputs.version || github.ref_name }}
          WORKER: ${{ needs.images.outputs.worker }}
          SLACK: ${{ needs.images.outputs.slack }}
          GH_TOKEN: ${{ github.token }}
        run: |
          VERSION="${VERSION#v}"
          npm run release:build -- --version "$VERSION" --out "$RUNNER_TEMP/release" --worker-image "$WORKER" --slack-image "$SLACK"
          npm run release:verify -- "$RUNNER_TEMP/release"
          (cd "$RUNNER_TEMP/release" && tar -czf "$RUNNER_TEMP/agentx-$VERSION.tar.gz" .)
          gh release create "v$VERSION" --verify-tag --title "AgentX $VERSION" --notes-from-tag "$RUNNER_TEMP/agentx-$VERSION.tar.gz" "$RUNNER_TEMP/release/release.json"

  npm:
    needs: release
    if: vars.AGENTX_PUBLISH_ENABLED == 'true'
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm, registry-url: "https://registry.npmjs.org" }
      - run: npm ci
      # Trusted publishing (OIDC, no stored token) needs a newer npm than Node 22 ships.
      - run: npm install -g npm@11
      - env:
          VERSION: ${{ inputs.version || github.ref_name }}
          NAME: ${{ vars.AGENTX_NPM_PACKAGE || '@charterarc/agentx' }}
        run: |
          VERSION="${VERSION#v}"
          npm run release:pack-cli -- --version "$VERSION" --name "$NAME" --out "$RUNNER_TEMP/cli"
          npm publish "$RUNNER_TEMP"/cli/*.tgz --access public --provenance
```

- [ ] **Step 1: Write the failing contract test**

```ts
// tests/contract/release-workflow.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Job { if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps: Array<{ run?: string; uses?: string; env?: Record<string, string> }> }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> }

async function workflow(): Promise<Workflow> {
  return YAML.parse(await readFile(".github/workflows/release.yml", "utf8")) as Workflow;
}

describe("release workflow", () => {
  it("runs only on version tags or by hand, never on pull requests or branch pushes", async () => {
    const wf = await workflow();
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v[0-9]+.[0-9]+.[0-9]+"] });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("guards every publishing job and runs the tests first", async () => {
    const wf = await workflow();
    for (const name of ["images", "release", "npm"]) {
      expect(wf.jobs[name]?.if, name).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true'");
    }
    expect(wf.jobs.images?.needs).toBe("test");
    expect(wf.jobs.test?.if).toBeUndefined();
  });

  it("grants OIDC and write access only where they are needed", async () => {
    const wf = await workflow();
    expect(wf.jobs.test?.permissions).toBeUndefined();
    expect(wf.jobs.images?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.jobs.release?.permissions).toEqual({ contents: "write" });
    expect(wf.jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("builds arm64 images, passes digests (not tags) to the release, and verifies before publishing", async () => {
    const wf = await workflow();
    const push = wf.jobs.images!.steps.map((s) => s.run ?? "").join("\n");
    expect(push).toContain("--platform linux/arm64");
    expect(push).toContain("containerimage.digest");
    expect(push).toContain("@$digest");
    const release = wf.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(release.indexOf("release:verify")).toBeGreaterThan(release.indexOf("release:build"));
    expect(release.indexOf("gh release create")).toBeGreaterThan(release.indexOf("release:verify"));
    expect(release).toContain("--worker-image \"$WORKER\"");
    expect(wf.jobs.release!.steps.some((s) => s.env?.GH_TOKEN === "${{ github.token }}")).toBe(true);
  });

  it("never prints secrets", async () => {
    const text = await readFile(".github/workflows/release.yml", "utf8");
    expect(text).not.toMatch(/echo[^\n]*secrets\./);
    expect(text).not.toMatch(/set -x/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, write the workflow, and run it to see it pass**

Run: `npx vitest run tests/contract/release-workflow.test.ts`
Expected: first FAIL (file missing), then PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml tests/contract/release-workflow.test.ts
git commit -m "feat(release): guarded release workflow for images, templates and the CLI"
```

### Task 7: Documentation and the spec record

**Files:**
- Create: `docs/releases.md`
- Modify: `specs/015-installer/spec.md` (Decisions: pull-through proven; templates by placeholder rendering)
- Modify: `specs/015-installer/plans/README.md` (15b row links this plan)

- [ ] **Step 1: Write `docs/releases.md` (under 80 lines)**

Cover:
- what a release contains, with the layout from Global Constraints;
- how templates render for an environment, and why the placeholder is reserved;
- how to cut a release: tag `vX.Y.Z` on mainline, and the workflow publishes if enabled;
- how to check a release locally with `npm run release:build` and `npm run release:verify`.

Then add the one-time owner setup, which nothing publishes without:
1. Create an ECR Public registry alias, then `agentx-worker` and `agentx-slack` repositories.
2. Create an IAM role that GitHub's OIDC provider can assume for `repo:PrepLabsAI/AgentX:ref:refs/tags/v*`.
   It needs `ecr-public:*` on those two repositories plus `ecr-public:GetAuthorizationToken` and
   `sts:GetServiceBearerToken`.
3. Reserve the npm package name, and add `NPM_TOKEN` or configure trusted publishing.
4. Set `AGENTX_PUBLISH_ROLE_ARN`, `AGENTX_ECR_PUBLIC_ALIAS`, `AGENTX_NPM_PACKAGE` and finally
   `AGENTX_PUBLISH_ENABLED=true`.
5. Add a LICENSE file. The npm package says `UNLICENSED` until then.

- [ ] **Step 2: Update the spec's Decisions**

Replace the "Images come to private ECR in the account" bullet's last two sentences with the proven
result (dated 2026-09-26, with the role permissions and the digest rule from this plan's Decisions).
Add a bullet: "Published templates are synthesized once for a reserved placeholder environment and
rendered for the real environment at install, proven equal to a direct synthesis (FR-012)."

- [ ] **Step 3: Run the full gate and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass, and the legacy snapshots are unchanged.

```bash
git add docs/releases.md specs/015-installer/spec.md specs/015-installer/plans/README.md
git commit -m "docs: releases guide; record the pull-through proof and template rendering"
```

## Not in this phase

- Installing anything from a release: the deploy engines, the artifact bucket, the pull-through
  rule and the runtime role's extra ECR permissions are phase 15c.
- The bring-your-own-OIDC checks and creating the first admin user are phase 15d.
- Actually publishing a release. That needs the owner setup in Task 7 and stays disabled until then.
