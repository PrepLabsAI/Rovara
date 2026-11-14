// IF2: every cloud-account adapter runs these checks against its offline provider world.
import { format, inspect } from "node:util";
import { expect } from "vitest";
import {
  CLOUD_ACCOUNT_PURPOSES, CloudAccountRefusedError, SecretValue,
  type CloudAccount, type CloudAccountCredentials, type CloudAccountPurpose, type ExternalAccountRef, type OrgId,
} from "@agentx/contracts";
import { assertNoSecretLeaks, captureLogs } from "../isolation/leaks.js";
import { runContract, type ContractCheck } from "./plugin-contract-kit.js";

export interface CloudAccountIssuance {
  readonly companyId: OrgId;
  readonly purpose: CloudAccountPurpose;
}

/** Provider fixture controls, never production configuration or credential persistence. */
export interface CloudAccountWorld {
  port: CloudAccount;
  grant(companyId: OrgId, ref: ExternalAccountRef, purpose: CloudAccountPurpose, issue: () => unknown): void;
  /** Configure the offline provider probe used by testConnection, without issuing credentials. */
  setConnectionProbe(companyId: OrgId, ref: ExternalAccountRef, probe: () => Promise<void>): void;
  disconnect(companyId: OrgId, ref: ExternalAccountRef): void;
  setNow(seconds: number): void;
  readonly issuances: readonly CloudAccountIssuance[];
}

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = 1_800_000_000;
const REF: ExternalAccountRef = { provider: "aws", tenant: "shared", accountId: "account" };
const PURPOSE = "invoke_only_endpoint";
const OTHER = "recording_bucket";

/** Runtime-only fake keys: no key-shaped literals in source or fixtures. */
const material = (label: string): string[] => [
  ["AS", "IA", label.toUpperCase().padEnd(16, "X").slice(0, 16)].join(""),
  [label, "secret", "x".repeat(40)].join("-"),
  [label, "session", "y".repeat(60)].join("-"),
];
const payload = (label = "alpha", expiresAt = NOW + 3600): CloudAccountCredentials => {
  const [access, secret, session] = material(label);
  return { provider: "aws", accessKeyId: new SecretValue(access!), secretAccessKey: new SecretValue(secret!), sessionToken: new SecretValue(session!), expiresAt };
};
const plant = (world: CloudAccountWorld, company = A, ref = REF, purpose: CloudAccountPurpose = PURPOSE, label = "alpha"): void => {
  world.setNow(NOW);
  world.grant(company, ref, purpose, () => payload(label));
};
async function refused(run: () => Promise<unknown>): Promise<Error> {
  const result = await run().then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(CloudAccountRefusedError);
  expect((result as Error).message).toBe("cloud account unavailable");
  expect(Object.keys(result as Error)).toEqual(["name"]);
  expect((result as Error).cause).toBeUndefined();
  return result as Error;
}

export function cloudAccountChecks(): ContractCheck<CloudAccountWorld>[] {
  return [
    { name: "issues all four purposes separately, including the exact 3600-second maximum", run: async (world) => {
      expect([...CLOUD_ACCOUNT_PURPOSES]).toEqual(["invoke_only_endpoint", "device_farm_project", "recording_bucket", "test_account_confirm"]);
      for (const purpose of CLOUD_ACCOUNT_PURPOSES) {
        plant(world, A, REF, purpose, purpose);
        const value = await world.port.credentialsFor(A, REF, purpose);
        expect(value.provider).toBe("aws");
        expect(value.expiresAt).toBe(NOW + 3600);
        expect([value.accessKeyId.reveal(), value.secretAccessKey.reveal(), value.sessionToken.reveal()]).toEqual(material(purpose));
      }
      expect(world.issuances).toEqual(CLOUD_ACCOUNT_PURPOSES.map((purpose) => ({ companyId: A, purpose })));
    } },
    { name: "company B cannot use A's reference; shared raw ids still return each company's own credentials", run: async (world) => {
      plant(world);
      expect((await world.port.credentialsFor(A, REF, PURPOSE)).sessionToken.reveal()).toBe(material("alpha")[2]);
      await world.port.testConnection(A, REF);
      await refused(() => world.port.credentialsFor(B, REF, PURPOSE));
      await refused(() => world.port.testConnection(B, REF));
      expect(world.issuances).toEqual([{ companyId: A, purpose: PURPOSE }]);
      plant(world, B, REF, PURPOSE, "bravo");
      for (const [company, label] of [[B, "bravo"], [A, "alpha"]] as const) {
        expect((await world.port.credentialsFor(company, REF, PURPOSE)).sessionToken.reveal()).toBe(material(label)[2]);
        await world.port.testConnection(company, REF);
      }
      expect(world.issuances).toEqual([{ companyId: A, purpose: PURPOSE }, { companyId: B, purpose: PURPOSE }, { companyId: A, purpose: PURPOSE }]);
    } },
    { name: "all reference components matter and connection checks issue no credentials", run: async (world) => {
      plant(world);
      await world.port.testConnection(A, REF);
      for (const ref of [{ ...REF, provider: "other" }, { ...REF, tenant: "other" }, { ...REF, accountId: "other" }]) {
        await refused(() => world.port.testConnection(A, ref));
        await refused(() => world.port.credentialsFor(A, ref, PURPOSE));
      }
      expect(world.issuances).toEqual([]);
    } },
    { name: "a purpose grant never widens to a different purpose or a runtime wildcard/list", run: async (world) => {
      plant(world);
      await refused(() => world.port.credentialsFor(A, REF, OTHER));
      for (const purpose of ["*", "", "all", `${PURPOSE},${OTHER}`, [PURPOSE, OTHER], { purpose: PURPOSE }, null]) {
        await refused(() => world.port.credentialsFor(A, REF, purpose as CloudAccountPurpose));
      }
      expect(world.issuances).toEqual([]);
      expect((await world.port.credentialsFor(A, REF, PURPOSE)).sessionToken.reveal()).toBe(material("alpha")[2]);
    } },
    { name: "external ids are stable per company and never shared, including concurrent reads", run: async (world) => {
      const [a, b, again] = await Promise.all([world.port.externalIdFor(A), world.port.externalIdFor(B), world.port.externalIdFor(A)]);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      expect(a).not.toBe(b);
      expect(again).toBe(a);
      expect(await world.port.externalIdFor(B)).toBe(b);
      expect(world.issuances).toEqual([]);
    } },
    { name: "expired-at-now and expired credentials are refused on every read", run: async (world) => {
      plant(world);
      world.setNow(NOW + 3599);
      expect((await world.port.credentialsFor(A, REF, PURPOSE)).expiresAt).toBe(NOW + 3600);
      world.setNow(NOW + 3600);
      await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      world.setNow(NOW + 3601);
      await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      expect(world.issuances).toEqual([{ companyId: A, purpose: PURPOSE }]);
    } },
    { name: "accepts the fixed 60-second clock-skew margin without changing expiry", run: async (world) => {
      plant(world);
      for (const lifetime of [3601, 3660]) {
        world.grant(A, REF, PURPOSE, () => payload("alpha", NOW + lifetime));
        expect((await world.port.credentialsFor(A, REF, PURPOSE)).expiresAt).toBe(NOW + lifetime);
      }
      expect(world.issuances).toEqual([{ companyId: A, purpose: PURPOSE }, { companyId: A, purpose: PURPOSE }]);
    } },
    { name: "overlong credentials are refused, never relabelled", run: async (world) => {
      plant(world);
      const tooLong = payload("alpha", NOW + 3661);
      world.grant(A, REF, PURPOSE, () => tooLong);
      await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      expect(tooLong.expiresAt).toBe(NOW + 3661);
      expect(world.issuances).toEqual([]);
    } },
    { name: "invalid expiry and clock numbers fail closed", run: async (world) => {
      plant(world);
      for (const expiresAt of [NaN, Infinity, -Infinity, NOW + 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
        world.grant(A, REF, PURPOSE, () => payload("alpha", expiresAt));
        await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      }
      world.grant(A, REF, PURPOSE, () => payload());
      for (const now of [NaN, Infinity, -Infinity, NOW + 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
        world.setNow(now);
        await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      }
      expect(world.issuances).toEqual([]);
    } },
    { name: "provider payloads require exactly the approved fields and SecretValue for each secret", run: async (world) => {
      plant(world);
      const good = payload();
      const bad: unknown[] = [null, {}, { ...good, provider: "other" }, { ...good, extra: material("alpha")[0] }];
      for (const field of ["accessKeyId", "secretAccessKey", "sessionToken"] as const) {
        bad.push({ ...good, [field]: good[field].reveal() }, { ...good, [field]: undefined });
      }
      for (const candidate of bad) {
        world.grant(A, REF, PURPOSE, () => candidate);
        await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      }
      const other = { ...REF, provider: "other" };
      world.grant(A, other, PURPOSE, () => ({ ...good, provider: "other" }));
      await refused(() => world.port.credentialsFor(A, other, PURPOSE));
      expect(world.issuances).toEqual([]);
    } },
    { name: "credential provider must match the account provider", run: async (world) => {
      plant(world);
      const other = { ...REF, provider: "other" };
      world.grant(A, other, PURPOSE, () => payload());
      await refused(() => world.port.credentialsFor(A, other, PURPOSE));
      expect(world.issuances).toEqual([]);
    } },
    { name: "provider failures use fixed words without causes or input echo", run: async (world) => {
      plant(world);
      const secrets = material("failure");
      world.grant(A, REF, PURPOSE, () => { throw new Error(secrets.join(" ")); });
      const captured = await captureLogs(async () => {
        await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
        for (const value of secrets) {
          await refused(() => world.port.credentialsFor(A, { ...REF, accountId: value }, PURPOSE));
          await refused(() => world.port.testConnection(A, { ...REF, accountId: value }));
        }
      });
      assertNoSecretLeaks(captured.lines, secrets);
      expect(world.issuances).toEqual([]);
    } },
    { name: "connection provider failures use fixed words without causes, leaks or input echo", run: async (world) => {
      const secrets = material("connection-failure");
      const ref = { ...REF, accountId: secrets[0]! };
      plant(world, A, ref);
      let probes = 0;
      world.setConnectionProbe(A, ref, async () => {
        probes += 1;
        await Promise.resolve();
        throw new Error(secrets.join(" "), { cause: { input: ref, secret: secrets[1] } });
      });
      const captured = await captureLogs(async () => {
        const error = await refused(() => world.port.testConnection(A, ref));
        return [error, inspect(error, { depth: 10 }), JSON.stringify(error), format("%s %j %o %O", error, error, error, error)];
      });
      expect(probes).toBe(1);
      assertNoSecretLeaks([...captured.result, ...captured.lines], secrets);
      expect(world.issuances).toEqual([]);
      // A different company cannot reach the planted provider, even with the identical reference.
      await refused(() => world.port.testConnection(B, ref));
      expect(probes).toBe(1);
    } },
    { name: "malformed companies and references are refused at the boundary", run: async (world) => {
      plant(world);
      for (const company of ["", "bad\u0000company", "bad company", "bad#company", "*", "ORG_aaaaaaaaaaaaaaaaaaaa", "org_short", "org_x/../org_y"]) {
        await refused(() => world.port.credentialsFor(company, REF, PURPOSE));
        await refused(() => world.port.testConnection(company, REF));
        await refused(() => world.port.externalIdFor(company));
      }
      for (const ref of [null, {}, { ...REF, tenant: "bad\u0000tenant" }, { ...REF, extra: "no" }]) {
        await refused(() => world.port.credentialsFor(A, ref as ExternalAccountRef, PURPOSE));
        await refused(() => world.port.testConnection(A, ref as ExternalAccountRef));
      }
    } },
    { name: "disconnect is live and never removes another company's grants", run: async (world) => {
      plant(world);
      plant(world, B, REF, PURPOSE, "bravo");
      world.disconnect(A, REF);
      await refused(() => world.port.testConnection(A, REF));
      await refused(() => world.port.credentialsFor(A, REF, PURPOSE));
      expect((await world.port.credentialsFor(B, REF, PURPOSE)).sessionToken.reveal()).toBe(material("bravo")[2]);
    } },
    { name: "payload serialization and structured logs redact every secret; the ledger records issuance without credentials", run: async (world) => {
      plant(world);
      const captured = await captureLogs(async () => {
        const value = await world.port.credentialsFor(A, REF, PURPOSE);
        for (const field of ["accessKeyId", "secretAccessKey", "sessionToken"] as const) {
          expect(value[field]).toBeInstanceOf(SecretValue);
          expect(String(value[field])).toBe("[secret]");
        }
        // Positive control: the issued payload really contains all the planted material.
        expect([value.accessKeyId.reveal(), value.secretAccessKey.reveal(), value.sessionToken.reveal()]).toEqual(material("alpha"));
        console.info({ event: "issued", credentials: value });
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Exercise String(payload) as part of the credential redaction contract.
        return [JSON.stringify(value), String(value), inspect(value, { depth: 10 }), format("%s %j %o %O", value, value, value, value)];
      });
      expect(captured.lines.some((line) => line.includes("issued") && line.includes("[secret]"))).toBe(true);
      expect(world.issuances).toEqual([{ companyId: A, purpose: PURPOSE }]);
      assertNoSecretLeaks([...captured.result, ...captured.lines, world.issuances, inspect(world.issuances)], material("alpha"));
    } },
  ];
}

export function runCloudAccountConformance(name: string, makeWorld: () => CloudAccountWorld | Promise<CloudAccountWorld>): void {
  runContract(`cloud-account conformance: ${name}`, cloudAccountChecks(), makeWorld);
}
