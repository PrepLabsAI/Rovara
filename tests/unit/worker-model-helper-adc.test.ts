// TE-F2 part B, M1: in a Vertex round the laptop shell's Google Application Default Credentials (a refresh token in ~/.config/gcloud, or a key file named by GOOGLE_APPLICATION_CREDENTIALS) must never be found, used or sent by a customer's
// test in a helper round. Run with the real google-auth-library under a temporary HOME holding a fake ADC file with a real-looking refresh token built at run time, under the network tripwire.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds } from "../support/model-helper-world.js";

const require = createRequire(import.meta.url);
const { GoogleAuth } = require("google-auth-library") as { GoogleAuth: new (options: object) => { getClient(): Promise<Record<string, unknown>> } };
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanupWorlds();
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rsadc-"));
  dirs.push(dir);
  return dir;
};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const realRefreshToken = (): string => ["1", "", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", String(Date.now())].join("//");

/** The user's machine: a real ADC authorized-user file under HOME, and a key file named by the shell. */
function usersMachine(): { home: string; refresh: string; keyFile: string } {
  const home = tmp();
  const refresh = realRefreshToken();
  mkdirSync(join(home, ".config/gcloud"), { recursive: true });
  writeFileSync(join(home, ".config/gcloud/application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "client.example", client_secret: "client-secret-value", refresh_token: refresh }));
  const keyFile = join(home, "real-key.json");
  writeFileSync(keyFile, JSON.stringify({ type: "service_account", client_email: "real@real.example", private_key: "not-a-key", private_key_id: "x" }));
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("CLOUDSDK_CONFIG", undefined);
  setEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  return { home, refresh, keyFile };
}
const clientOf = async (): Promise<Record<string, unknown>> => new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();

describe("Application Default Credentials in a laptop round", () => {
  it("control: without the round's variables the user's real refresh token IS what google-auth finds", async () => {
    const { refresh } = usersMachine();
    const client = await clientOf();
    expect(client._refreshToken).toBe(refresh);
  });
});
