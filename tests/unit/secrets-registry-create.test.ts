// PRIVATE-PACKAGES P1b: the company's package token in the secret service. It is created WITHOUT tags (the company role has no TagResource; its create statement is `.../org-connectors/<company>/pkgreg_*` with no
// tags allowed), saved again as a new version, and deleted with the recovery window. The fake models the IAM answers the infrastructure's statements give (tests/contract/hosted-wiring-infrastructure.test.ts pins them).
import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, RestoreSecretCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { companyRegistrySecretName } from "@agentx/contracts";
import { createCompanyClientFactory } from "../../packages/aws-adapters/src/secrets-manager/tagged-session.js";
import { createSecretsManagerConnectionSecrets } from "../../packages/aws-adapters/src/secrets-manager/connection-secrets.js";
import { isUntaggedCreateName } from "../../packages/aws-adapters/src/secrets-manager/company-names.js";
import { CompanySecretsManagerFake } from "../support/ports/secrets-manager-company-fake.js";
import { companySecretsEnvOf, companySecretsFromEnvironment } from "../../packages/broker/src/aws/company-secrets-sessions.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const token = (tag: string): string => ["ghp", "_", tag.padEnd(36, "x")].join("");
const nameOf = (company: string): string => companyRegistrySecretName("local", company, "npm.pkg.github.com")!;

function setup() {
  const fake = new CompanySecretsManagerFake();
  const clientFor = createCompanyClientFactory({ assumeRole: fake.assumeRole, clientFrom: fake.clientFrom });
  return { fake, clientFor, secrets: createSecretsManagerConnectionSecrets({ env: "local", clientFor }) };
}

describe("which names are created without tags", () => {
  it("exactly `pkgreg_<hostKey>` directly under a company's org-connectors path", () => {
    expect(isUntaggedCreateName(`org-connectors/${A}/pkgreg_ghnpm`)).toBe(true);
    for (const name of [`org-connectors/${A}/pkgreg_`, `org-connectors/${A}/pkgreg_GHNPM`, `org-connectors/${A}/pkgreg_gh-npm`, `org-connectors/${A}/pkgreg_${"a".repeat(33)}`, `org-connectors/${A}/xpkgreg_ghnpm`, `org-connectors/${A}/conn-1`,
      `org-hooks/${A}/pkgreg_ghnpm`, `org-test-accounts/${A}/pkgreg_ghnpm`, `org-connectors/${A}/sub/pkgreg_ghnpm`, `org-connectors/pkgreg_ghnpm`]) expect(isUntaggedCreateName(name), name).toBe(false);
  });
});

describe("the company's package token in the secret service", () => {
  // MUTANT T1: the token's create carries tags (the role cannot tag: AccessDenied) / an ordinary secret is created untagged.
  it("a save creates the secret with NO tags under the company's own name; a second save is a new version; the value is the token", async () => {
    const { fake, secrets } = setup();
    const v1 = await secrets.put(A, nameOf(A), token("One"));
    const v2 = await secrets.put(A, nameOf(A), token("Two"));
    expect(v1).not.toBe(v2);
    expect(fake.secrets.get(nameOf(A))?.tags).toEqual({});
    const creates = fake.calls.filter((call): call is CreateSecretCommand => call instanceof CreateSecretCommand);
    expect(creates).toHaveLength(2);
    for (const create of creates) expect(create.input.Tags).toBeUndefined();
    expect(await secrets.read(A, nameOf(A))).toBe(token("Two"));
    expect(await secrets.read(A, nameOf(A), v1)).toBe(token("One"));
  });

  it("an ordinary connection secret is still created WITH the company's tag", async () => {
    const { fake, secrets } = setup();
    await secrets.put(A, `agentx/local/org-connectors/${A}/shared-secret`, "x");
    expect(fake.secrets.get(`agentx/local/org-connectors/${A}/shared-secret`)?.tags).toEqual({ "rovara:org": A, "rovara:use": "connector" });
  });

  // MUTANT T2: the statement's reach widens (an untagged create of any name, or another company's pkgreg name, is allowed).
  it("the role model refuses an untagged create of anything but the company's own pkgreg name, and another company's session cannot read, replace or delete it", async () => {
    const { fake, clientFor, secrets } = setup();
    await secrets.put(A, nameOf(A), token("One"));
    const a = await clientFor(A);
    for (const name of [`agentx/local/org-connectors/${A}/other-secret`, `agentx/local/org-hooks/${A}/pkgreg_ghnpm`, `agentx/local/org-connectors/${B}/pkgreg_ghnpm`]) {
      await expect(a.send(new CreateSecretCommand({ Name: name, SecretString: "x" })), name).rejects.toMatchObject({ name: "AccessDeniedException" });
    }
    const b = await clientFor(B);
    await expect(b.send(new GetSecretValueCommand({ SecretId: nameOf(A) }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(b.send(new CreateSecretCommand({ Name: nameOf(A), SecretString: "x" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(secrets.put(B, nameOf(A), "x")).rejects.toThrow(/^that secret does not belong to this company$/u);
    await expect(secrets.scheduleDelete(B, nameOf(A))).rejects.toThrow(/^that secret does not belong to this company$/u);
    expect(await secrets.read(B, nameOf(A))).toBeUndefined();
    expect(fake.secrets.get(nameOf(A))?.deleted).toBe(false);
  });

  // MUTANT T3: the delete forgets the recovery window.
  it("a delete schedules the deletion WITH the 7 day recovery window, and a save while it waits says the removal is in progress", async () => {
    const { fake, secrets } = setup();
    await secrets.put(A, nameOf(A), token("One"));
    await secrets.scheduleDelete(A, nameOf(A));
    expect(fake.deletions).toEqual([{ SecretId: nameOf(A), RecoveryWindowInDays: 7 }]);
    expect(await secrets.read(A, nameOf(A))).toBeUndefined();
    await expect(secrets.put(A, nameOf(A), token("Two"))).rejects.toThrow(/^this connection is being removed; remove it again, then add a new one$/u);
  });
});

describe("adopting the company's package token (putRegistryToken)", () => {
  const hooks = (order: string[]) => ({ beforeRestore: async () => { order.push("audit-before-restore"); } });

  // MUTANT P1: the first write is not an untagged create, or a second secret is made for an existing name.
  it("creates the secret untagged when there is none, and writes a NEW VERSION into one that already exists (an orphan): one secret, two versions, nothing deleted or restored", async () => {
    const { fake, secrets } = setup();
    const order: string[] = [];
    const first = await secrets.putRegistryToken(A, nameOf(A), token("One"), hooks(order));
    expect(first).toMatchObject({ created: true, restored: false });
    expect(fake.secrets.get(nameOf(A))?.tags).toEqual({});
    const second = await secrets.putRegistryToken(A, nameOf(A), token("Two"), hooks(order));
    expect(second).toMatchObject({ created: false, restored: false });
    expect(second.versionId).not.toBe(first.versionId);
    expect([...fake.secrets.keys()]).toEqual([nameOf(A)]);
    expect(await secrets.read(A, nameOf(A), first.versionId)).toBe(token("One"));
    expect(await secrets.read(A, nameOf(A), second.versionId)).toBe(token("Two"));
    expect(fake.calls.some((call) => call instanceof DeleteSecretCommand || call instanceof RestoreSecretCommand)).toBe(false);
    expect(order).toEqual([]);
  });

  // MUTANT P2: a secret scheduled for deletion is not restored (the save is blocked for the whole window), or is restored before the audit hook.
  it("a secret scheduled for deletion is restored AFTER the audit hook runs, then a new version is written into it", async () => {
    const { fake, secrets } = setup();
    const order: string[] = [];
    await secrets.putRegistryToken(A, nameOf(A), token("One"), hooks(order));
    await secrets.scheduleDelete(A, nameOf(A));
    expect(fake.secrets.get(nameOf(A))?.deleted).toBe(true);
    const write = await secrets.putRegistryToken(A, nameOf(A), token("Two"), { beforeRestore: async () => { order.push(`audit-before-restore:restored=${String(fake.calls.some((call) => call instanceof RestoreSecretCommand))}`); } });
    expect(write).toMatchObject({ created: false, restored: true });
    expect(order).toEqual(["audit-before-restore:restored=false"]);
    expect(fake.secrets.get(nameOf(A))?.deleted).toBe(false);
    expect(await secrets.read(A, nameOf(A))).toBe(token("Two"));
  });

  it("an audit hook that throws stops the restore: the secret stays scheduled and nothing is written", async () => {
    const { fake, secrets } = setup();
    await secrets.putRegistryToken(A, nameOf(A), token("One"), hooks([]));
    await secrets.scheduleDelete(A, nameOf(A));
    await expect(secrets.putRegistryToken(A, nameOf(A), token("Two"), { beforeRestore: async () => { throw new Error("audit down"); } })).rejects.toThrow("audit down");
    expect(fake.calls.some((call) => call instanceof RestoreSecretCommand)).toBe(false);
    expect(fake.secrets.get(nameOf(A))?.deleted).toBe(true);
  });

  // MUTANT P3: the adoption reaches another company's secret or a name that is not a package token.
  it("refuses, before any call, another company's name, any name that is not `pkgreg_<hostKey>` under org-connectors, and a value that is not text; another company's orphan is untouched", async () => {
    const { fake, secrets } = setup();
    await secrets.putRegistryToken(B, nameOf(B), token("Bee"), hooks([]));
    await secrets.scheduleDelete(B, nameOf(B));
    const before = fake.calls.length;
    for (const name of [nameOf(B), `agentx/local/org-connectors/${A}/conn-1`, `agentx/local/org-hooks/${A}/pkgreg_ghnpm`, `agentx/local/org-connectors/${A}/pkgreg_ghnpm/extra`]) {
      await expect(secrets.putRegistryToken(A, name, token("Aye"), hooks([])), name).rejects.toThrow();
    }
    await expect(secrets.putRegistryToken(A, nameOf(A), null as unknown as string, hooks([]))).rejects.toThrow();
    expect(fake.calls.length).toBe(before);
    expect(fake.secrets.get(nameOf(B))?.deleted).toBe(true);
  });

  it("the role model: RestoreSecret is allowed on the company's own pkgreg name only (another company's, another family's and another leaf's are AccessDenied)", async () => {
    const { fake, clientFor, secrets } = setup();
    await secrets.putRegistryToken(A, nameOf(A), token("One"), hooks([]));
    await secrets.scheduleDelete(A, nameOf(A));
    fake.seed(`agentx/local/org-connectors/${A}/conn-1`, "x", { "rovara:org": A });
    const a = await clientFor(A);
    await expect(a.send(new RestoreSecretCommand({ SecretId: nameOf(B) }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new RestoreSecretCommand({ SecretId: `agentx/local/org-connectors/${A}/conn-1` }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new RestoreSecretCommand({ SecretId: nameOf(A) }))).resolves.toBeDefined();
  });
});

describe("putRegistryToken restores ONLY a secret that is scheduled for deletion (Opus delta review, fdce8bb3b)", () => {
  // MUTANT D1: any InvalidRequestException (not only "scheduled for deletion") leads to the audit hook and a RestoreSecret.
  it("an InvalidRequestException on a secret that is NOT scheduled for deletion is refused: no restore audit, no RestoreSecret, no second write", async () => {
    const sent: string[] = [];
    const invalidRequest = Object.assign(new Error("some other invalid request"), { name: "InvalidRequestException" });
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        if (command.constructor.name === "DescribeSecretCommand") return {};
        if (command.constructor.name === "RestoreSecretCommand") return {};
        throw invalidRequest;
      },
    };
    const secrets = createSecretsManagerConnectionSecrets({ env: "local", clientFor: async () => client });
    let audited = 0;
    await expect(secrets.putRegistryToken(A, nameOf(A), token("One"), { beforeRestore: async () => { audited += 1; } })).rejects.toThrow();
    expect(audited).toBe(0);
    expect(sent).not.toContain("RestoreSecretCommand");
    expect(sent.filter((name) => name === "CreateSecretCommand")).toHaveLength(1);
    expect(String(sent)).not.toContain(token("One"));
  });
});

describe("the hosted company secret store (aws/company-secrets-sessions.ts)", () => {
  const ROLE = "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-company-secrets";
  const build = (environment: Record<string, string | undefined>) => {
    const fake = new CompanySecretsManagerFake();
    return { fake, store: companySecretsFromEnvironment(environment, { assumeRole: fake.assumeRole, clientFrom: fake.clientFrom }) };
  };

  it("is built only where the install has the company-secrets role (a role ARN); otherwise nothing, and nothing falls back to the broker's own identity", () => {
    expect(build({}).store).toBeUndefined();
    for (const bad of ["", "not-an-arn", "arn:aws:iam::123456789012:user/x", "arn:aws:iam::12345:role/x"]) expect(build({ COMPANY_SECRETS_ROLE_ARN: bad }).store, bad).toBeUndefined();
    expect(build({ COMPANY_SECRETS_ROLE_ARN: ROLE }).store).toBeDefined();
  });

  it("names the install's environment (AGENTX_ENV, else production on the legacy install)", () => {
    expect(companySecretsEnvOf({ AGENTX_ENV: "staging" })).toBe("staging");
    expect(companySecretsEnvOf({})).toBe("production");
    expect(companySecretsEnvOf({ AGENTX_ENV: "" })).toBe("production");
  });

  it("makes one company-tagged session per company, asks STS for none before the company id is valid, and writes the package token untagged", async () => {
    const { fake, store } = build({ COMPANY_SECRETS_ROLE_ARN: ROLE, AGENTX_ENV: "local" });
    const secrets = store!.secrets;
    await expect(secrets.put("not-a-company", `agentx/local/org-connectors/${A}/pkgreg_ghnpm`, "x")).rejects.toThrow(/^the secret reference is not valid$/u);
    expect(fake.sessions).toEqual([]);
    await secrets.put(A, nameOf(A), token("One"));
    await secrets.put(B, nameOf(B), token("Two"));
    await secrets.put(A, nameOf(A), token("Three"));
    expect(fake.sessions.map((session) => session.tags)).toEqual([[{ Key: "rovara:org", Value: A }], [{ Key: "rovara:org", Value: B }]]);
    expect(fake.secrets.get(nameOf(A))?.tags).toEqual({});
    expect(fake.secrets.get(nameOf(B))?.tags).toEqual({});
    expect(await secrets.read(A, nameOf(A))).toBe(token("Three"));
  });
});
