// The conformance suite every `image-registry` adapter must pass: the in-memory fake, Code's local Docker adapter, and Cloud's hosted registry adapter later.
import { describe, expect, it } from "vitest";
import { ImageRegistryError, SavedEnvRegistryAuthSchema, savedEnvRepositoryName, type ImageRegistry } from "@agentx/contracts";

export interface ImageRegistryUnderTest {
  registry: ImageRegistry;
  /** Plays the worker: pushes one image to the repository (making it when it is absent) and returns the image's digest. */
  push: (repository: string) => Promise<string>;
  /** Makes the repository exist the way somebody else would (other settings). Absent: the adapter cannot be squatted (its repositories are always its own). */
  makeForeign?: (repository: string) => Promise<void>;
  dispose?: () => Promise<void>;
}
export interface ImageRegistryHarness {
  create(): Promise<ImageRegistryUnderTest>;
}

const COMPANY = "org_00000000000000000000";
const repositoryFor = (project: string): string => savedEnvRepositoryName({ env: "test", orgId: COMPANY, projectId: project });

export function runImageRegistryConformance(name: string, harness: ImageRegistryHarness): void {
  async function withRegistry<T>(body: (under: ImageRegistryUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try { return await body(under); } finally { await under.dispose?.(); }
  }
  const call = (repository: string) => ({ companyId: COMPANY, repository });

  describe(`image-registry conformance: ${name}`, () => {
    it("says a repository nobody made is absent, and the one a push made is the one Rovara makes", () => withRegistry(async ({ registry, push }) => {
      const repository = repositoryFor("alpha");
      expect(await registry.inspect(call(repository))).toBe("absent");
      await push(repository);
      expect(await registry.inspect(call(repository))).toBe("matches");
    }));

    it("gives a login for the one repository named, short-lived, in the shape a worker accepts", () => withRegistry(async ({ registry, push }) => {
      const repository = repositoryFor("alpha");
      await push(repository);
      const login = await registry.login({ ...call(repository), access: "pull", maxSeconds: 600 });
      expect(SavedEnvRegistryAuthSchema.safeParse(login.auth).success).toBe(true);
      expect(login.auth.repository).toBe(repository);
      expect(login.expiresAtMs).toBeGreaterThan(Date.now());
      expect(login.expiresAtMs).toBeLessThanOrEqual(Date.now() + 601_000);
      expect(Date.parse(login.auth.expiresAt)).toBeLessThanOrEqual(login.expiresAtMs);
    }));

    it("refuses a name that is not a repository Rovara makes (no wildcard, no extra segment) before any registry call", () => withRegistry(async ({ registry }) => {
      for (const repository of ["*", `${repositoryFor("alpha")}/extra`, "rovara-env/test/*", "alpine", ""]) {
        await expect(registry.login({ ...call(repository), access: "push", maxSeconds: 60 })).rejects.toMatchObject({ name: "ImageRegistryError", code: "refused" });
        await expect(registry.list(call(repository))).rejects.toBeInstanceOf(ImageRegistryError);
        await expect(registry.deleteRepository(call(repository))).rejects.toBeInstanceOf(ImageRegistryError);
      }
    }));

    it("lists the images a push made, and deletes by digest without touching the others", () => withRegistry(async ({ registry, push }) => {
      const repository = repositoryFor("alpha");
      expect(await registry.list(call(repository))).toBe("absent");
      const first = await push(repository);
      const second = await push(repository);
      const listed = await registry.list(call(repository));
      expect(listed).not.toBe("absent");
      expect((listed as Array<{ digest: string }>).map((image) => image.digest).sort()).toEqual([first, second].sort());
      await registry.deleteImages({ ...call(repository), digests: [first] });
      expect(((await registry.list(call(repository))) as Array<{ digest: string }>).map((image) => image.digest)).toEqual([second]);
      // A digest the registry does not hold is ignored.
      await registry.deleteImages({ ...call(repository), digests: [`sha256:${"e".repeat(64)}`] });
      expect(((await registry.list(call(repository))) as unknown[]).length).toBe(1);
    }));

    it("keeps one project's repository apart from another's", () => withRegistry(async ({ registry, push }) => {
      const alpha = repositoryFor("alpha");
      const beta = repositoryFor("beta");
      expect(alpha).not.toBe(beta);
      const digest = await push(alpha);
      await push(beta);
      await registry.deleteRepository(call(beta));
      expect(await registry.list(call(beta))).toBe("absent");
      expect(((await registry.list(call(alpha))) as Array<{ digest: string }>).map((image) => image.digest)).toEqual([digest]);
    }));

    it("deletes a repository with its images, and deleting what is not there counts as done", () => withRegistry(async ({ registry, push }) => {
      const repository = repositoryFor("alpha");
      expect(await registry.deleteRepository(call(repository))).toBe("absent");
      await push(repository);
      expect(await registry.deleteRepository(call(repository))).toBe("deleted");
      expect(await registry.list(call(repository))).toBe("absent");
      expect(await registry.deleteRepository(call(repository))).toBe("absent");
    }));

    it("never gives a login for a repository somebody else made first", () => withRegistry(async ({ registry, makeForeign }) => {
      if (makeForeign === undefined) return;
      const repository = repositoryFor("squatted");
      await makeForeign(repository);
      expect(await registry.inspect(call(repository))).toBe("unusable");
      await expect(registry.login({ ...call(repository), access: "push", maxSeconds: 60 })).rejects.toBeInstanceOf(ImageRegistryError);
      await expect(registry.login({ ...call(repository), access: "pull", maxSeconds: 60 })).rejects.toBeInstanceOf(ImageRegistryError);
    }));

    it("refuses a login lifetime that is not a whole number of seconds", () => withRegistry(async ({ registry, push }) => {
      const repository = repositoryFor("alpha");
      await push(repository);
      for (const maxSeconds of [0, -1, 1.5, Number.NaN]) await expect(registry.login({ ...call(repository), access: "push", maxSeconds })).rejects.toBeInstanceOf(ImageRegistryError);
    }));
  });
}
