import { describe, expect, it } from "vitest";
import { areaOf, classifyPath, isTestFolderName, languageOf } from "../../packages/broker/src/core/wiki/skip-rules.js";

describe("wiki file map: what is skipped", () => {
  it.each([
    ".env", ".env.local", ".env.production", "app/.env", "config/.ENV", "deploy/server.pem", "keys/id_rsa", "keys/id_ed25519", "a/b/private.key", "store.p12", "x/cert.pfx", "release.jks", "debug.keystore",
    "infra/terraform.tfstate", "infra/prod.tfvars", ".npmrc", ".netrc", ".pypirc", "svc/service-account-prod.json", "app/credentials.json", "app/secrets.yml", "app/my-secret-notes.txt", ".aws/config",
    "secrets/db.txt", "app/.ssh/known_hosts", "a/b/.secrets/x.json", ".git-credentials", "AuthKey_ABC.p8",
  ])("calls %s secret-shaped", (path) => { expect(classifyPath(path)).toBe("secret"); });

  it.each(["src/environment.ts", "docs/env-vars.md", "src/secretary.ts", "src/keyboard.ts", "src/monkey.ts"])("does not call %s secret-shaped", (path) => { expect(classifyPath(path)).not.toBe("secret"); });

  it.each([["package-lock.json", "lockfile"], ["web/yarn.lock", "lockfile"], ["pnpm-lock.yaml", "lockfile"], ["Cargo.lock", "lockfile"], ["go.sum", "lockfile"], ["a/poetry.lock", "lockfile"],
    ["vendor/x/y.php", "vendored"], ["node_modules/a/index.js", "vendored"], ["web/node_modules/a/index.js", "vendored"], ["third_party/lib/a.c", "vendored"],
    ["dist/main.js", "generated"], ["packages/a/build/x.js", "generated"], [".next/server/a.js", "generated"], ["src/gen/api.pb.go", "generated"], ["static/app.min.js", "generated"], ["src/types.generated.ts", "generated"], ["x/foo_pb2.py", "generated"],
    ["logo.png", "asset"], ["fonts/a.woff2", "asset"], ["data/archive.zip", "asset"], ["src/index.ts", undefined], ["README.md", undefined]] as const)("classifies %s as %s", (path, expected) => { expect(classifyPath(path)).toBe(expected); });

  it("lets a secret-shaped name win over a vendored or generated folder, so its path is never listed", () => {
    expect(classifyPath("vendor/app/.env")).toBe("secret");
    expect(classifyPath("dist/keys/server.pem")).toBe("secret");
  });

  it("names languages from the extension and leaves data and docs out of the code mix", () => {
    expect(languageOf("a/b.ts")).toBe("TypeScript");
    expect(languageOf("a/b.tsx")).toBe("TypeScript");
    expect(languageOf("a/b.py")).toBe("Python");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf("a/b.md")).toBeUndefined();
    expect(languageOf("a/b.json")).toBeUndefined();
  });

  it("groups files into areas: the top folder, or two levels under a container folder", () => {
    expect(areaOf("src/a/b.ts")).toBe("src/a");
    expect(areaOf("src/b.ts")).toBe("src");
    expect(areaOf("packages/api/src/x.ts")).toBe("packages/api");
    expect(areaOf("billing/x.ts")).toBe("billing");
    expect(areaOf("README.md")).toBe(".");
  });

  it("spots test folder names", () => {
    for (const name of ["test", "tests", "__tests__", "spec", "e2e", "Tests"]) expect(isTestFolderName(name)).toBe(true);
    for (const name of ["latest", "contest", "src"]) expect(isTestFolderName(name)).toBe(false);
  });
});
