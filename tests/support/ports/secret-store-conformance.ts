// Owner decision 60 (item R2): the conformance suite every `secrets` adapter must pass: Code's own adapter now, Cloud's secret-service adapter later.
import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretValue, type SecretRef, type SecretStore } from "@agentx/contracts";

export interface SecretStoreUnderTest {
  store: SecretStore;
  /** A reference the adapter can hold (the suite sets and reads it). */
  ref: SecretRef;
  /** Makes `ref` hold `value` (a rotation is a second call), or removes it when `value` is undefined. */
  set(ref: SecretRef, value: string | undefined): Promise<void>;
  /** A reference of a kind this adapter does not know. Absent: the adapter knows no kind the suite could name (it knows every kind). */
  unknownRef?: SecretRef;
  dispose?: () => Promise<void>;
}
export interface SecretStoreHarness {
  create(): Promise<SecretStoreUnderTest>;
}

const COMPANY = "org_00000000000000000000";

export function runSecretStoreConformance(name: string, harness: SecretStoreHarness): void {
  async function withStore<T>(body: (under: SecretStoreUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try {
      return await body(under);
    } finally {
      await under.dispose?.();
    }
  }

  describe(`secrets conformance: ${name}`, () => {
    it("answers a SecretValue that gives the value only to reveal() and prints as [secret] everywhere", () => withStore(async (under) => {
      const value = ["fixture", "secret", "value"].join("-");
      await under.set(under.ref, value);
      const read = await under.store.read(COMPANY, under.ref);
      expect(read).toBeInstanceOf(SecretValue);
      expect(read?.reveal()).toBe(value);
      expect(String(read)).toBe("[secret]");
      expect(JSON.stringify({ read })).not.toContain(value);
      // Every way a value gets printed: util.inspect (what console.log uses), util.format with %s, %j and %o, and a template string.
      for (const text of [inspect(read), inspect({ nested: { read } }, { depth: 5 }), format("%s %j %o %O", read, read, read, read), `${String(read)}`]) expect(text).not.toContain(value);
    }));

    it("answers undefined, not an error, when there is no secret", () => withStore(async (under) => {
      await under.set(under.ref, undefined);
      expect(await under.store.read(COMPANY, under.ref)).toBeUndefined();
    }));

    it("reads on every call, so a rotation takes effect at once", () => withStore(async (under) => {
      await under.set(under.ref, "first-value");
      expect((await under.store.read(COMPANY, under.ref))?.reveal()).toBe("first-value");
      await under.set(under.ref, "rotated-value");
      expect((await under.store.read(COMPANY, under.ref))?.reveal()).toBe("rotated-value");
    }));

    it("answers undefined for a kind of reference it does not know", () => withStore(async ({ store, unknownRef }) => {
      if (unknownRef === undefined) return;
      expect(await store.read(COMPANY, unknownRef)).toBeUndefined();
    }));

    it("refuses a reference that is not exactly one source, saying nothing about its value", () => withStore(async ({ store }) => {
      const leaky = ["leaky", "value"].join("-");
      const error = await store.read(COMPANY, { env: leaky, file: `/${leaky}` }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(leaky);
      await expect(store.read(COMPANY, {})).rejects.toBeInstanceOf(Error);
    }));
  });
}
