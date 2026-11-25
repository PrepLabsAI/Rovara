import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assembleContext, dockerBuildArguments, entryPresent, IMAGE_FORMAT_VERSION, scriptIdentity, GATEWAY_IMAGE_DOCKERFILE, GATEWAY_IMAGE_ENTRY, GATEWAY_IMAGE_ENTRY_SOURCE, ImageContextError, listContextFiles, main, MAX_CONTEXT_BYTES, MAX_CONTEXT_FILES,
} from "../../scripts/model-gateway-image.js";

// CI-style check of the model gateway's image build, offline: no docker, no registry, no AWS. It builds the exact context, proves the
// package compiles from that context alone, and holds the Dockerfile to the properties the deployment relies on.
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "model-gateway-image-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const dockerfile = readFileSync(GATEWAY_IMAGE_DOCKERFILE, "utf8");
const instructions = dockerfile.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
const DIGEST_PIN = /^FROM public\.ecr\.aws\/docker\/library\/node:22\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}( AS build)?$/u;

/** A small stand-in tree with the fixed files and a gateway source folder, so the refusals can be tried without touching the checkout. */
function fakeTree(name: string): string {
  const tree = join(scratch, name);
  for (const file of listContextFiles(root)) {
    if (file.startsWith("packages/model-gateway/src/")) continue;
    mkdirSync(join(tree, file, ".."), { recursive: true });
    cpSync(join(root, file), join(tree, file));
  }
  mkdirSync(join(tree, "packages/model-gateway/src"), { recursive: true });
  writeFileSync(join(tree, "packages/model-gateway/src/index.ts"), "export const x = 1;\n");
  return tree;
}

describe("the model gateway image context", () => {
  it("is an explicit file list: the package source, its two config files, the base tsconfig, the Dockerfile and the toolchain lock", () => {
    const files = listContextFiles(root);
    expect(files.length).toBeLessThanOrEqual(MAX_CONTEXT_FILES);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      const allowed = file === "tsconfig.base.json" || file === GATEWAY_IMAGE_DOCKERFILE || file.startsWith("environments/model-gateway/toolchain/") || file === "packages/model-gateway/package.json" || file === "packages/model-gateway/tsconfig.json" || (file.startsWith("packages/model-gateway/src/") && file.endsWith(".ts") && !file.endsWith(".test.ts"));
      expect(allowed, file).toBe(true);
      expect(file).not.toMatch(/(^|\/)(\.env|node_modules|dist)(\/|$)|\.tsbuildinfo$|\.pem$|\.key$/u);
    }
  });

  it("assembles into a fresh folder with a manifest whose checksums match the files, and the same twice", () => {
    const out = join(scratch, "context-a");
    // A strict umask must not leak into the image: the container's user reads every copied file.
    const previousUmask = process.umask(0o077);
    let manifest;
    try { manifest = assembleContext(root, out); } finally { process.umask(previousUmask); }
    expect(manifest.totalBytes).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    for (const entry of manifest.files) {
      expect(readFileSync(join(out, entry.path)).byteLength).toBe(entry.bytes);
      expect(statSync(join(out, entry.path)).mode & 0o777, entry.path).toBe(0o644);
    }
    const again = assembleContext(root, join(scratch, "context-b"));
    expect(again.contextSha256).toBe(manifest.contextSha256);
    expect(manifest.contextSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("the context hash also covers this script and its format version: another script or a bumped version is another hash (the release pipeline tags the image by it)", () => {
    const base = assembleContext(root, join(scratch, "id-a")).contextSha256;
    const bumped = assembleContext(root, join(scratch, "id-b"), `${scriptIdentity().split(":")[0]}:${IMAGE_FORMAT_VERSION + 1}`).contextSha256;
    const edited = assembleContext(root, join(scratch, "id-c"), `${"0".repeat(64)}:${IMAGE_FORMAT_VERSION}`).contextSha256;
    expect(new Set([base, bumped, edited]).size).toBe(3);
    expect(scriptIdentity()).toBe(`${createHash("sha256").update(readFileSync(join(root, "scripts/model-gateway-image.ts"))).digest("hex")}:${IMAGE_FORMAT_VERSION}`);
  });

  it("refuses a folder that is not empty, a missing file, a link and a source that is not TypeScript", () => {
    const full = join(scratch, "full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "x");
    expect(() => assembleContext(root, full)).toThrow(ImageContextError);

    const missing = fakeTree("missing");
    rmSync(join(missing, "tsconfig.base.json"));
    expect(() => listContextFiles(missing)).toThrow(/missing/u);

    const linked = fakeTree("linked");
    symlinkSync("/etc/hosts", join(linked, "packages/model-gateway/src/link.ts"));
    expect(() => listContextFiles(linked)).toThrow(/symbolic link/u);

    const stray = fakeTree("stray");
    writeFileSync(join(stray, "packages/model-gateway/src/.env"), "KEY=value\n");
    expect(() => listContextFiles(stray)).toThrow(/not TypeScript/u);
  });

  it("refuses a context over the file or byte limit, and leaves test files out", () => {
    const many = fakeTree("many");
    for (let index = 0; index <= MAX_CONTEXT_FILES; index += 1) writeFileSync(join(many, `packages/model-gateway/src/f${index}.ts`), "export {};\n");
    expect(() => listContextFiles(many)).toThrow(/too many/u);

    const big = fakeTree("big");
    writeFileSync(join(big, "packages/model-gateway/src/big.ts"), `// ${"x".repeat(MAX_CONTEXT_BYTES)}\n`);
    expect(() => assembleContext(big, join(scratch, "big-out"))).toThrow(/size limit/u);

    const withTest = fakeTree("with-test");
    writeFileSync(join(withTest, "packages/model-gateway/src/a.test.ts"), "export {};\n");
    expect(listContextFiles(withTest)).not.toContain("packages/model-gateway/src/a.test.ts");
  });

  it("compiles from the context alone (no other package, no node_modules of the checkout)", () => {
    const out = join(scratch, "context-compile");
    assembleContext(root, out);
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    // @types/node comes from the toolchain in the image; here, link the checkout's copy in where npm ci would put it. Nothing else is linked.
    mkdirSync(join(out, "node_modules/@types"), { recursive: true });
    symlinkSync(join(root, "node_modules/@types/node"), join(out, "node_modules/@types/node"));
    symlinkSync(join(root, "node_modules/undici-types"), join(out, "node_modules/undici-types"));
    const second = spawnSync(process.execPath, [tsc, "-b", "packages/model-gateway", "--pretty", "false"], { cwd: out, encoding: "utf8" });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(existsSync(join(out, "packages/model-gateway/dist/index.js"))).toBe(true);
    // The process entry the Dockerfile's CMD and `test -f` name is real, and compiles to exactly that path.
    expect(entryPresent(root)).toBe(true);
    expect(existsSync(join(out, GATEWAY_IMAGE_ENTRY))).toBe(true);
    expect(readdirSync(join(out, "packages/model-gateway/dist")).some((name) => name.endsWith(".js"))).toBe(true);
  }, 120_000);
});

describe("the model gateway Dockerfile", () => {
  it("pins every base image by digest, in two stages", () => {
    const froms = instructions.filter((line) => line.startsWith("FROM "));
    expect(froms).toHaveLength(2);
    for (const line of froms) expect(line).toMatch(DIGEST_PIN);
    expect(froms[0]).toMatch(/ AS build$/u);
  });

  it("uses the same base pin as the Slack image", () => {
    const slack = existsSync("environments/slack/Dockerfile") ? readFileSync("environments/slack/Dockerfile", "utf8") : undefined;
    if (slack === undefined) return; // environments/slack is not in Rovara Cloud: the pin was copied from the Code repo's slack Dockerfile (same node digest)
    const pin = (text: string) => /node:[^\s@]+@sha256:[0-9a-f]{64}/u.exec(text)?.[0];
    expect(pin(dockerfile)).toBe(pin(slack));
  });

  it("runs as a non-root numeric user, with a health check, a port and the entry the infra relies on", () => {
    expect(instructions).toContain("USER 1000:1000");
    expect(instructions.filter((line) => line.startsWith("USER "))).toHaveLength(1);
    expect(instructions.findIndex((line) => line.startsWith("USER "))).toBeGreaterThan(instructions.findIndex((line, index) => index > 0 && line.startsWith("FROM ")));
    expect(instructions.some((line) => line.startsWith("RUN ") && /apt-get|apk |curl|wget/u.test(line) && instructions.indexOf(line) > instructions.findIndex((l, i) => i > 0 && l.startsWith("FROM ")))).toBe(false);
    expect(dockerfile).toMatch(/^HEALTHCHECK /mu);
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(instructions.at(-1)).toBe(`CMD ["node", "${GATEWAY_IMAGE_ENTRY}"]`);
    // infra/lib/model-gateway.ts (in Rovara Cloud since #45) sets the port and runs the container as 1000:1000 with no command; hold the two to this file once it lands.
    if (existsSync("infra/lib/model-gateway.ts")) {
      const infra = readFileSync("infra/lib/model-gateway.ts", "utf8");
      expect(infra).toContain("MODEL_GATEWAY_PORT = 8080");
      expect(infra).toContain('user: "1000:1000"');
      expect(infra).not.toMatch(/command:\s*\[/u);
      expect(infra).toContain('path: "/healthz"');
      expect(infra).toContain("stopTimeout: Duration.seconds(120)");
      expect(infra).toContain("readonlyRootFilesystem: true");
      // The process the image runs drains on SIGTERM within that stop timeout.
      expect(readFileSync("packages/model-gateway/src/main.ts", "utf8") + readFileSync("packages/model-gateway/src/process.ts", "utf8")).toContain("SIGTERM");
      expect(dockerfile).toContain("/healthz");
    }
  });

  it("copies only the gateway package output and holds no secret, key or build argument", () => {
    const copies = instructions.filter((line) => line.startsWith("COPY "));
    for (const line of copies) expect(line, line).toMatch(/environments\/model-gateway\/toolchain|tsconfig\.base\.json|packages\/model-gateway|--from=build \/build\/packages\/model-gateway/u);
    expect(instructions.some((line) => line.startsWith("ARG "))).toBe(false);
    expect(instructions.some((line) => line.startsWith("ADD "))).toBe(false);
    const environment = instructions.filter((line) => /^ENV |^\s+\w+=/u.test(line)).join("\n");
    expect(environment).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|ANTHROPIC/iu);
    expect(dockerfile).not.toMatch(/sk-ant-|AKIA[0-9A-Z]{16}|-----BEGIN|--mount=type=secret|\.npmrc/u);
    expect(dockerfile).not.toMatch(/node_modules\/\.bin\/tsc -b packages\/(?!model-gateway)/u);
  });

  it("builds the entry in the build stage and fails the build without it", () => {
    expect(instructions.join("\n")).toContain(`test -f ${GATEWAY_IMAGE_ENTRY}`);
    expect(GATEWAY_IMAGE_ENTRY).toBe("packages/model-gateway/dist/main.js");
    expect(GATEWAY_IMAGE_ENTRY_SOURCE).toBe("packages/model-gateway/src/main.ts");
  });

  it("is not ignored from the context by the repository's .dockerignore in a way that matters (the context is assembled, not the checkout)", () => {
    // .dockerignore lists Dockerfile*: harmless here because the build passes --file explicitly and the context folder has its own copy.
    expect(dockerBuildArguments("/ctx", "rovara-model-gateway:x")).toContain(`/ctx/${GATEWAY_IMAGE_DOCKERFILE}`);
  });
});

describe("the toolchain the image build installs", () => {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies: Record<string, string> };
  const rootLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, unknown> };
  const toolPackage = JSON.parse(readFileSync("environments/model-gateway/toolchain/package.json", "utf8")) as { devDependencies: Record<string, string>; dependencies?: unknown };
  const toolLock = JSON.parse(readFileSync("environments/model-gateway/toolchain/package-lock.json", "utf8")) as { lockfileVersion: number; packages: Record<string, unknown> };

  it("pins the compiler and the Node types to the versions the repository uses", () => {
    expect(toolPackage.dependencies).toBeUndefined();
    expect(toolPackage.devDependencies).toEqual({ "@types/node": rootPackage.devDependencies["@types/node"], typescript: rootPackage.devDependencies.typescript });
  });

  it("copies each locked package, with its integrity hash, from the root lockfile", () => {
    expect(toolLock.lockfileVersion).toBe(3);
    const entries = Object.keys(toolLock.packages).filter((key) => key !== "");
    expect(entries.sort()).toEqual(["node_modules/@types/node", "node_modules/typescript", "node_modules/undici-types"]);
    for (const key of entries) {
      // Code's root lockfile marks no `dev` flag where Cloud's did (the toolchain lockfile is Cloud's, unchanged, so the image is too).
      const withoutDev = (entry: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([name]) => name !== "dev"));
      expect(withoutDev(toolLock.packages[key]), key).toEqual(withoutDev(rootLock.packages[key]));
      expect((toolLock.packages[key] as { integrity?: string }).integrity, key).toMatch(/^sha512-/u);
    }
  });
});

describe("the build script", () => {
  it("never pushes and never takes a registry address", () => {
    for (const tag of ["123456789012.dkr.ecr.us-west-2.amazonaws.com/gateway:x", "registry.example.com/gateway:x", "UPPER:x", "name", "name:", "name:a b"]) expect(() => dockerBuildArguments("/ctx", tag), tag).toThrow(ImageContextError);
    const args = dockerBuildArguments("/ctx", "rovara-model-gateway:abc123");
    expect(args).toContain("--load");
    expect(args).not.toContain("--push");
    expect(args.join(" ")).not.toMatch(/push|output|registry/iu);
    expect(args).toContain("linux/arm64");
  });

  it("refuses a --push flag and unknown words with the usage line and runs nothing", () => {
    const calls: unknown[] = [];
    const run = ((...call: unknown[]) => { calls.push(call); return { status: 0 }; }) as unknown as typeof spawnSync;
    for (const argv of [["build", "--push", "x"], ["build", "--tag"], ["context"], ["context", "--out", "a", "--out", "b"], ["frobnicate"], []]) expect(main(argv, root, run), argv.join(" ")).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("builds no image without the process entry, and says why", () => {
    const calls: unknown[] = [];
    const run = ((...call: unknown[]) => { calls.push(call); return { status: 0 }; }) as unknown as typeof spawnSync;
    const tree = fakeTree("no-entry");
    expect(entryPresent(tree)).toBe(false);
    expect(main(["build"], tree, run)).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("with the entry present, assembles the context and runs docker once with the local arguments", () => {
    const calls: Array<[string, string[]]> = [];
    const run = ((command: string, args: string[]) => { calls.push([command, args]); return { status: 0 }; }) as unknown as typeof spawnSync;
    const tree = fakeTree("with-entry");
    writeFileSync(join(tree, "packages/model-gateway/src/main.ts"), "export {};\n");
    expect(main(["build", "--tag", "rovara-model-gateway:t1"], tree, run)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("docker");
    expect(calls[0]![1]).toContain("rovara-model-gateway:t1");
    expect(calls[0]![1]).not.toContain("--push");
  });

  it("writes the context with the entry flag set", () => {
    expect(main(["context", "--out", join(scratch, "cli-context")], root, spawnSync)).toBe(0);
  });
});
