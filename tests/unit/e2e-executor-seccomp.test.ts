import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2E_EXECUTOR_SECCOMP_PROFILE_SHA256, canonicalJson } from "../../packages/contracts/src/index.js";
import { installedExecutorSeccompProfilePath, verifyExecutorSeccompProfile } from "../../packages/verifier/src/host/executor-seccomp.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), "seccomp-")); dirs.push(dir); return dir; };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type Rule = { names: string[]; action: string; args?: { index: number; value: number; op: string }[]; comment?: string; includes?: Record<string, unknown>; excludes?: Record<string, unknown> };
type Profile = { defaultAction: string; defaultErrnoRet?: number; syscalls: Rule[] };
const readProfile = async () => JSON.parse(await readFile(installedExecutorSeccompProfilePath(), "utf8")) as Profile;
const ours = (profile: Profile) => profile.syscalls.filter((rule) => rule.comment?.startsWith("rovara: "));

/**
 * canonical JSON of Docker's default profile, moby/profiles@6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef seccomp/default.json (raw file sha256
 * 6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6). The executor profile is that file plus the rules marked "rovara: ", nothing else.
 */
const MOBY_DEFAULT_CANONICAL_SHA256 = "a894b5730caa168d88da7fffe8ace974ad05fb84547e1766fa879d75d3ac6ba2";

describe("the executor container's seccomp profile", () => {
  it("is pinned: the shipped bytes are the digest contracts name", async () => {
    expect(sha(await readFile(installedExecutorSeccompProfilePath()))).toBe(E2E_EXECUTOR_SECCOMP_PROFILE_SHA256);
  });

  it("is Docker's default profile plus exactly the rules Chromium's namespace sandbox needs", async () => {
    const profile = await readProfile();
    const base = { ...profile, syscalls: profile.syscalls.filter((rule) => !rule.comment?.startsWith("rovara: ")) };
    expect(sha(canonicalJson(base))).toBe(MOBY_DEFAULT_CANONICAL_SHA256);
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(ours(profile).map((rule) => rule.names.join())).toEqual(["unshare", "clone", "clone", "chroot"]);
    // Every rule of ours is an unconditional ALLOW of a syscall that needs no capability: nothing is keyed to a capability the container lacks.
    for (const rule of ours(profile)) {
      expect(rule.action).toBe("SCMP_ACT_ALLOW");
      expect(JSON.stringify(rule.includes ?? {})).not.toContain("caps");
      expect(JSON.stringify(rule.excludes ?? {})).not.toContain("caps");
    }
  });

  it("allows namespace flags except CLONE_NEWCGROUP (and CLONE_NEWTIME for unshare), and no syscall that is dangerous without CAP_SYS_ADMIN", async () => {
    const profile = await readProfile();
    const [unshare, clone, cloneS390, chroot] = ours(profile) as [Rule, Rule, Rule, Rule];
    // The mask is the set of flags that must NOT be present: SCMP_CMP_MASKED_EQ with datum 0.
    expect(unshare.args).toEqual([{ index: 0, value: 0x02000080, op: "SCMP_CMP_MASKED_EQ" }]);
    expect(clone.args).toEqual([{ index: 0, value: 0x02000000, op: "SCMP_CMP_MASKED_EQ" }]);
    expect(cloneS390.args).toEqual([{ index: 1, value: 0x02000000, op: "SCMP_CMP_MASKED_EQ" }]);
    expect(chroot.args).toBeUndefined();
    const added = ours(profile).flatMap((rule) => rule.names);
    for (const forbidden of ["setns", "mount", "umount2", "pivot_root", "bpf", "perf_event_open", "clone3", "ptrace", "reboot", "sethostname"]) expect(added).not.toContain(forbidden);
    // clone3 stays answered with ENOSYS (Docker's own rule), so glibc falls back to clone, whose flags this profile can see.
    expect(profile.syscalls.some((rule) => rule.names.includes("clone3") && JSON.stringify(rule).includes("\"errnoRet\":38"))).toBe(true);
  });
});

describe("verifying the profile before a container may use it", () => {
  it("returns the installed path when it is the pinned bytes", () => {
    expect(verifyExecutorSeccompProfile()).toBe(installedExecutorSeccompProfilePath());
  });

  it("refuses a file whose digest differs from the pin, by one byte", async () => {
    const dir = await scratch(); const path = join(dir, "profile.json");
    await writeFile(path, `${await readFile(installedExecutorSeccompProfilePath(), "utf8")} `);
    expect(() => verifyExecutorSeccompProfile(path)).toThrow(/executor-seccomp-profile-digest-mismatch/);
  });

  it("refuses a profile that is missing, a symbolic link, or too large to be one", async () => {
    const dir = await scratch();
    expect(() => verifyExecutorSeccompProfile(join(dir, "absent.json"))).toThrow(/executor-seccomp-profile-unreadable/);
    const link = join(dir, "link.json"); await symlink(installedExecutorSeccompProfilePath(), link);
    expect(() => verifyExecutorSeccompProfile(link)).toThrow(/executor-seccomp-profile-unreadable/);
    const large = join(dir, "large.json"); await writeFile(large, "x".repeat(300_000)); await chmod(large, 0o600);
    expect(() => verifyExecutorSeccompProfile(large)).toThrow(/executor-seccomp-profile-unreadable/);
  });
});
