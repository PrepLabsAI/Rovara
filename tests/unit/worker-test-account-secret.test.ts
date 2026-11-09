// Test services TS27: a test account's secret is read at run time into the sealed check sandbox only. Fake reader, real files in a private temp directory; every key-shaped string is built at run time.
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { e2eSecretSpellings, testAccountSecretName } from "@agentx/contracts";
import {
  SECRET_REFUSALS, TestAccountSecretError, sweepTestAccountEnvFiles, assertPrivateDirectory, assertPrivateTmpfsDirectory, dockerEnvFileArgs, isTmpfsDirectory, mountOf, namesHoldingSecret, withTestAccountSecrets, withoutTestAccountNames,
  type ReadSecret, type SecretPlace, type SecretRefusal, type WithSecretsInput,
} from "../../packages/worker/src/test-account-secret.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const build = (...parts: string[]): string => parts.join("");
const rand = (length: number): string => "Qk7mP2xR9vLw4NtY8bZc3HdF6gJs1VaUeXoI5".repeat(3).slice(0, length);
const stripeTest = (): string => build("sk", "_", "test", "_", rand(24));
const stripeLive = (): string => build("sk", "_", "live", "_", rand(24));
const token = (letter: string): string => build("T", letter.repeat(30));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ta-secret-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

const grant = (over: Record<string, unknown> = {}) => ({
  orgId: ORG, accountId: "payments-test", family: "http:api.stripe.com", secretName: testAccountSecretName("staging", ORG, "payments-test"), key: "value", region: "us-west-2",
  envNames: ["PAYMENTS_API_KEY"], credentials: { accessKeyId: token("a"), secretAccessKey: token("b"), sessionToken: token("c") }, expiresAt: new Date(NOW + 600_000).toISOString(), ...over,
});

interface Rig { input: WithSecretsInput<string>; registered: string[]; reads: Array<{ secretName: string; accessKeyId: string; versionStage?: string }>; timeline: string[]; directory: string }
function rig(over: { value?: string; text?: string; grants?: unknown[]; place?: SecretPlace; read?: ReadSecret; run?: (envFile: string | undefined) => Promise<string>; verifyDirectory?: (directory: string) => void } = {}): Rig {
  const directory = privateDir();
  const registered: string[] = [];
  const reads: Array<{ secretName: string; accessKeyId: string; versionStage?: string }> = [];
  const timeline: string[] = [];
  const value = over.value ?? stripeTest();
  const input: WithSecretsInput<string> = {
    place: over.place ?? "sealed_check",
    grants: over.grants ?? [grant()],
    now: () => NOW,
    read: over.read ?? ((g) => { reads.push({ secretName: g.secretName, accessKeyId: g.credentials.accessKeyId, versionStage: g.versionStage }); timeline.push(`read:${readdirSync(directory).length}`); return Promise.resolve(over.text ?? JSON.stringify({ value })); }),
    redactor: { register: (spelling) => { registered.push(spelling); timeline.push("register"); } },
    directory,
    verifyDirectory: over.verifyDirectory ?? (() => undefined),
    run: over.run ?? ((envFile) => { timeline.push("run"); return Promise.resolve(envFile === undefined ? "no file" : readFileSync(envFile, "utf8")); }),
  };
  return { input, registered, reads, timeline, directory };
}
const refusal = async (call: Promise<unknown>): Promise<SecretRefusal> => {
  try { await call; } catch (error) {
    expect(error).toBeInstanceOf(TestAccountSecretError);
    return (error as TestAccountSecretError).code;
  }
  throw new Error("expected a refusal");
};

describe("only a sealed check round gets a secret", () => {
  it("refuses every other place before it parses a grant, reads, checks a directory or writes", async () => {
    for (const place of ["setup_run", "setup_agent", "working_sandbox", "task_agent", "team_runner"] as const) {
      const r = rig({ place, verifyDirectory: () => { throw new Error("should not be reached"); } });
      expect(await refusal(withTestAccountSecrets(r.input)), place).toBe("not_sealed");
      expect(r.reads).toEqual([]);
      expect(r.registered).toEqual([]);
      expect(readdirSync(r.directory)).toEqual([]);
    }
    // Not even for no grants at all, or a grant that would not parse.
    expect(await refusal(withTestAccountSecrets(rig({ place: "team_runner", grants: [] }).input))).toBe("not_sealed");
    expect(await refusal(withTestAccountSecrets(rig({ place: "working_sandbox", grants: [{ junk: 1 }] }).input))).toBe("not_sealed");
  });
});

describe("the env file", () => {
  it("holds NAME=value for each variable of each grant, mode 0600, and is gone when the command ends", async () => {
    const value = stripeTest();
    const second = stripeTest().replace(/.$/u, "Y");
    const r = rig({
      grants: [grant({ envNames: ["PAYMENTS_API_KEY", "PAYMENTS_KEY_COPY"] }), grant({ accountId: "other-test", secretName: testAccountSecretName("staging", ORG, "other-test"), envNames: ["OTHER_KEY"] })],
      read: (g) => Promise.resolve(JSON.stringify({ value: g.secretName.endsWith("other-test") ? second : value })),
    });
    let path = "";
    let mode = 0;
    const body = await withTestAccountSecrets({ ...r.input, run: (envFile) => { path = envFile!; mode = statSync(envFile!).mode & 0o777; return Promise.resolve(readFileSync(envFile!, "utf8")); } });
    expect(body).toBe(`PAYMENTS_API_KEY=${value}\nPAYMENTS_KEY_COPY=${value}\nOTHER_KEY=${second}\n`);
    expect(mode).toBe(0o600);
    expect(path.startsWith(`${r.directory}/ta-`)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(r.directory)).toEqual([]);
  });

  it("is removed when the command fails, and the failure comes back as it was", async () => {
    const r = rig({ run: () => Promise.reject(new Error("the test failed")) });
    await expect(withTestAccountSecrets(r.input)).rejects.toThrow("the test failed");
    expect(readdirSync(r.directory)).toEqual([]);
  });

  it("says so in a fixed word when it cannot remove the file", async () => {
    const r = rig({ run: (envFile) => { unlinkSync(envFile!); return Promise.resolve("done"); } });
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("cleanup_failed");
  });

  it("writes no file for no grants and hands the command no path", async () => {
    const r = rig({ grants: [] });
    expect(await withTestAccountSecrets(r.input)).toBe("no file");
    expect(r.reads).toEqual([]);
  });

  it("reads each secret with its own grant's credentials and name", async () => {
    const r = rig({ grants: [grant(), grant({ accountId: "other-test", secretName: testAccountSecretName("staging", ORG, "other-test"), envNames: ["OTHER_KEY"], credentials: { accessKeyId: token("x"), secretAccessKey: token("y"), sessionToken: token("z") } })] });
    await withTestAccountSecrets(r.input);
    expect(r.reads).toEqual([
      { secretName: testAccountSecretName("staging", ORG, "payments-test"), accessKeyId: token("a"), versionStage: "AWSCURRENT" },
      { secretName: testAccountSecretName("staging", ORG, "other-test"), accessKeyId: token("x"), versionStage: "AWSCURRENT" },
    ]);
  });

  it("does not touch the worker's own environment", async () => {
    const before = JSON.stringify(process.env);
    const value = stripeTest();
    await withTestAccountSecrets(rig({ value }).input);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(JSON.stringify(process.env)).not.toContain(value);
    expect(process.env.PAYMENTS_API_KEY).toBeUndefined();
  });
});

describe("L3: files an earlier round left behind", () => {
  const leftover = (directory: string, name = `ta-${"0123456789abcdef01234567"}.env`, text = "PAYMENTS_API_KEY=left-over-value\n"): string => {
    const path = join(directory, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it("wipes and removes every ta-*.env file, counts them, and touches nothing else in the directory", () => {
    const directory = privateDir();
    const first = leftover(directory);
    const second = leftover(directory, `ta-${"fedcba9876543210fedcba98"}.env`, "OTHER=also-left");
    const unrelated = join(directory, "keep.env");
    writeFileSync(unrelated, "KEEP=1");
    const lookalike = join(directory, "ta-short.env");
    writeFileSync(lookalike, "KEEP=2");
    const link = join(directory, `ta-${"aaaaaaaaaaaaaaaaaaaaaaaa"}.env`);
    symlinkSync(unrelated, link);
    expect(sweepTestAccountEnvFiles(directory)).toBe(3);
    expect(existsSync(first) || existsSync(second) || existsSync(link)).toBe(false);
    // The link was removed, not followed: the file it pointed to is as it was.
    expect(readFileSync(unrelated, "utf8")).toBe("KEEP=1");
    expect(readFileSync(lookalike, "utf8")).toBe("KEEP=2");
    expect(sweepTestAccountEnvFiles(directory)).toBe(0);
  });

  it("overwrites a file's content before removing it (what a hard link or a snapshot would otherwise keep)", () => {
    const directory = privateDir();
    const path = leftover(directory, undefined, "SECRET=abcdefghijklmnop\n");
    const alias = join(directory, "alias-of-the-same-file");
    linkSync(path, alias);
    expect(sweepTestAccountEnvFiles(directory)).toBe(1);
    expect(readFileSync(alias, "utf8")).not.toContain("abcdefghijklmnop");
    expect(readFileSync(alias).every((byte) => byte === 0)).toBe(true);
  });

  it("stops the round that finds one, after wiping it, with no read and no new file; the next round runs", async () => {
    const r = rig();
    const old = leftover(r.directory);
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("leftover_files");
    expect(existsSync(old)).toBe(false);
    expect(r.reads).toEqual([]);
    expect(r.registered).toEqual([]);
    expect(readdirSync(r.directory)).toEqual([]);
    expect(await withTestAccountSecrets(r.input)).toContain("PAYMENTS_API_KEY=");
    expect(readdirSync(r.directory)).toEqual([]);
  });

  it("also checks a round that has no grants, and a directory it cannot list is a fixed refusal", async () => {
    const r = rig({ grants: [] });
    leftover(r.directory);
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("leftover_files");
    expect(() => sweepTestAccountEnvFiles(join(r.directory, "missing"))).toThrow(TestAccountSecretError);
  });

  it("does not sweep for a place that may not have a secret (the refusal comes first)", async () => {
    const r = rig({ place: "team_runner" });
    const old = leftover(r.directory);
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("not_sealed");
    expect(existsSync(old)).toBe(true);
  });
});

describe("the redactor", () => {
  it("is taught every spelling of the value, the secret's whole text and the grant's session secrets before the file exists", async () => {
    const value = stripeTest();
    const r = rig({ value });
    await withTestAccountSecrets(r.input);
    for (const spelling of e2eSecretSpellings(value)) expect(r.registered).toContain(spelling);
    expect(r.registered).toContain(JSON.stringify({ value }));
    expect(r.registered).toContain(token("b"));
    expect(r.registered).toContain(token("c"));
    expect(r.registered).toContain(Buffer.from(value).toString("base64"));
    expect(r.registered).toContain(encodeURIComponent(value));
    // Everything was registered before the command ran, and the directory was still empty when the value was read.
    expect(r.timeline.lastIndexOf("register")).toBeLessThan(r.timeline.indexOf("run"));
    expect(r.timeline.filter((entry) => entry.startsWith("read:"))).toEqual(["read:0"]);
  });

  it("hides a value it refuses, and hides the secret text of a secret that has no usable value", async () => {
    const live = stripeLive();
    const r = rig({ value: live });
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("refused_value");
    expect(r.registered).toContain(live);
    expect(readdirSync(r.directory)).toEqual([]);
    const text = JSON.stringify({ other: stripeTest() });
    const odd = rig({ text });
    expect(await refusal(withTestAccountSecrets(odd.input))).toBe("no_value");
    expect(odd.registered).toContain(text);
  });
});

describe("refusals carry a fixed word and nothing else", () => {
  it("covers a grant that does not parse, has expired, or names a variable twice, without reading", async () => {
    for (const [grants, code] of [
      [[{ not: "a grant" }], "bad_grant"],
      [[grant({ secretName: testAccountSecretName("staging", ORG, "someone-else") })], "bad_grant"],
      [[{ ...grant(), extra: 1 }], "bad_grant"],
      [[grant({ expiresAt: new Date(NOW).toISOString() })], "grant_expired"],
      [[grant({ expiresAt: new Date(NOW - 1).toISOString() })], "grant_expired"],
      [[grant(), grant({ accountId: "other-test", secretName: testAccountSecretName("staging", ORG, "other-test") })], "env_conflict"],
    ] as const) {
      const r = rig({ grants: [...grants] });
      expect(await refusal(withTestAccountSecrets(r.input))).toBe(code);
      expect(r.reads).toEqual([]);
      expect(readdirSync(r.directory)).toEqual([]);
    }
  });

  it("covers an unreadable secret, a secret without the key, and one that is not JSON, never quoting the cause", async () => {
    const secretMessage = `AccessDenied for ${token("q")} on arn:aws:secretsmanager:us-west-2:111122223333:secret:x`;
    const failing = rig({ read: () => Promise.reject(new Error(secretMessage)) });
    const error = await withTestAccountSecrets(failing.input).then(() => undefined, (caught: unknown) => caught as TestAccountSecretError);
    if (error === undefined) throw new Error("expected a refusal");
    expect(error.code).toBe("unreadable");
    expect(error.message).not.toContain(token("q"));
    expect(error.message).not.toContain("arn:");
    expect(await refusal(withTestAccountSecrets(rig({ read: () => Promise.resolve(undefined) }).input))).toBe("unreadable");
    expect(await refusal(withTestAccountSecrets(rig({ text: JSON.stringify({ other: stripeTest() }) }).input))).toBe("no_value");
    expect(await refusal(withTestAccountSecrets(rig({ text: stripeTest() }).input))).toBe("no_value");
    expect(await refusal(withTestAccountSecrets(rig({ text: JSON.stringify({ value: "" }) }).input))).toBe("no_value");
    expect(await refusal(withTestAccountSecrets(rig({ text: JSON.stringify({ value: 7 }) }).input))).toBe("no_value");
    expect(await refusal(withTestAccountSecrets(rig({ value: "has\nnewline" }).input))).toBe("refused_value");
  });

  it("has a fixed message for every word, none of which holds a value", () => {
    for (const code of SECRET_REFUSALS) {
      const message = new TestAccountSecretError(code).message;
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/sk_|AKIA|arn:|=/u);
    }
  });
});

describe("the directory", () => {
  it("is checked before any value is read", async () => {
    const r = rig({ verifyDirectory: () => { throw new TestAccountSecretError("bad_directory"); } });
    expect(await refusal(withTestAccountSecrets(r.input))).toBe("bad_directory");
    expect(r.reads).toEqual([]);
  });

  it("must be an absolute, real, private directory of the worker", () => {
    const dir = privateDir();
    const code = (call: () => void): string | undefined => { try { call(); } catch (error) { return (error as TestAccountSecretError).code; } return undefined; };
    expect(code(() => assertPrivateDirectory(dir))).toBeUndefined();
    expect(code(() => assertPrivateDirectory("relative/dir"))).toBe("bad_directory");
    expect(code(() => assertPrivateDirectory(join(dir, "missing")))).toBe("bad_directory");
    const file = join(dir, "file");
    writeFileSync(file, "x");
    expect(code(() => assertPrivateDirectory(file))).toBe("bad_directory");
    const link = join(dir, "link");
    symlinkSync(dir, link);
    expect(code(() => assertPrivateDirectory(link))).toBe("bad_directory");
    chmodSync(dir, 0o750);
    expect(code(() => assertPrivateDirectory(dir))).toBe("bad_directory");
    chmodSync(dir, 0o707);
    expect(code(() => assertPrivateDirectory(dir))).toBe("bad_directory");
    chmodSync(dir, 0o700);
    expect(code(() => assertPrivateDirectory(dir))).toBeUndefined();
  });

  it("is also on tmpfs, where mountinfo can say so, and fails closed where it cannot", () => {
    const dir = privateDir();
    // A temporary directory of this machine is rarely tmpfs, and /proc/self/mountinfo is Linux's: either way the answer is "no" unless the file system is memory-backed.
    const onTmpfs = (() => { try { return isTmpfsDirectory(readFileSync("/proc/self/mountinfo", "utf8"), dir); } catch { return false; } })();
    const verdict = (() => { try { assertPrivateTmpfsDirectory(dir); return "ok"; } catch (error) { return (error as TestAccountSecretError).code; } })();
    expect(verdict).toBe(onTmpfs ? "ok" : "bad_directory");
    expect(() => assertPrivateTmpfsDirectory("relative/dir")).toThrow(TestAccountSecretError);
  });

  it("reads the mount of a path from mountinfo and calls only tmpfs and ramfs memory-backed", () => {
    const info = [
      "22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p1 rw",
      "30 22 0:25 / /run rw,nosuid,nodev shared:23 - tmpfs tmpfs rw,size=1m",
      "31 30 0:26 / /run/rovara/secrets rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1m,mode=700",
      "32 22 0:27 / /var/lib/docker rw - overlay overlay rw",
      "33 22 0:28 / /mnt/with\\040space rw - ramfs ramfs rw",
    ].join("\n");
    expect(mountOf(info, "/run/rovara/secrets/x")).toEqual({ mountPoint: "/run/rovara/secrets", type: "tmpfs" });
    expect(isTmpfsDirectory(info, "/run/rovara/secrets")).toBe(true);
    expect(isTmpfsDirectory(info, "/run/rovara/secrets/deeper/dir")).toBe(true);
    expect(isTmpfsDirectory(info, "/run/other")).toBe(true);
    expect(isTmpfsDirectory(info, "/tmp/x")).toBe(false);
    expect(isTmpfsDirectory(info, "/var/lib/docker/x")).toBe(false);
    expect(isTmpfsDirectory(info, "/runaway")).toBe(false);
    expect(isTmpfsDirectory(info, "/mnt/with space/x")).toBe(true);
    expect(isTmpfsDirectory("", "/run")).toBe(false);
  });
});

describe("the one docker exec", () => {
  it("takes the env file as one argument and nothing that could be a second one", () => {
    expect(dockerEnvFileArgs("/run/rovara/secrets/ta-0123456789abcdef01234567.env")).toEqual(["--env-file", "/run/rovara/secrets/ta-0123456789abcdef01234567.env"]);
    for (const bad of ["relative.env", "/run/a b.env", "/run/a\nb.env", "/run/a=b.env", "/run/a\tb", ""]) expect(() => dockerEnvFileArgs(bad), JSON.stringify(bad)).toThrow(TestAccountSecretError);
  });
});

describe("keeping the names out of everything else", () => {
  it("removes a grant's variable names from an environment, whatever they hold", () => {
    const environment = { PATH: "/usr/bin", PAYMENTS_API_KEY: "left-over", OTHER: "kept", HOME: "/home/w" };
    expect(withoutTestAccountNames(environment, [grant()])).toEqual({ PATH: "/usr/bin", OTHER: "kept", HOME: "/home/w" });
    expect(withoutTestAccountNames(environment, [])).toEqual(environment);
  });

  it("names the variables that hold a registered spelling, and only by name", () => {
    const value = stripeTest();
    const environment = { A: value, B: `prefix-${value}-suffix`, C: Buffer.from(value).toString("base64"), D: "harmless", E: "short" };
    expect(namesHoldingSecret(environment, e2eSecretSpellings(value))).toEqual(["A", "B", "C"]);
    expect(namesHoldingSecret({ D: "harmless" }, e2eSecretSpellings(value))).toEqual([]);
    // A spelling too short to be a secret ("abc") would match anything, so it is not looked for.
    expect(namesHoldingSecret({ A: "abcdefgh", B: "xyz" }, ["abc", "xyz"])).toEqual([]);
  });
});
