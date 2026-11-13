// TE-F2 part B, M1: on a laptop the user's REAL Google Application Default Credentials (a refresh token in ~/.config/gcloud, or a key file named by GOOGLE_APPLICATION_CREDENTIALS) must never be found, used or sent by a customer's
// test in a helper round. Run with the real google-auth-library under a temporary HOME holding a fake ADC file with a real-looking refresh token built at run time, under the network tripwire.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog } from "../../packages/contracts/src/index.js";
import { writeDummyAdc } from "../../packages/worker/src/model-helper-adc.js";
import { laptopModelEnvironment } from "../../packages/worker/src/model-helper-env.js";
import { cleanupWorlds, request, startWorld } from "../support/model-helper-world.js";
import { installModelNetworkTripwire } from "../support/model-network-tripwire.js";

const require = createRequire(import.meta.url);
const { GoogleAuth } = require("google-auth-library") as { GoogleAuth: new (options: object) => { getClient(): Promise<Record<string, unknown>> } };
const CATALOG = builtinModelCatalog().rows;
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
  it("with the round's variables google-auth finds only the dummy service account; the real refresh token is never used, never in the environment, never in a file the round made", async () => {
    const { refresh, keyFile } = usersMachine();
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", keyFile); // the shell names a real key file too
    const run = tmp();
    const adc = await writeDummyAdc({ dir: run, tokenUri: "http://127.0.0.1:1/token", projectId: "rovara-test-project" });
    const result = laptopModelEnvironment({ rows: CATALOG, rowIds: ["vertex"], baseUrl: "http://127.0.0.1:5555", metadataHostPort: "127.0.0.1:5556", projectId: "rovara-test-project", adc, inherited: process.env });
    expect(result.ok).toBe(true);
    const env = result.ok ? result.environment : {};
    for (const [name, value] of Object.entries(env)) setEnv(name, value);
    const tripwire = installModelNetworkTripwire({ resolver: new Set(), ports: { 443: 1, 80: 1 } });
    let client: Record<string, unknown>;
    try {
      client = await clientOf();
    } finally {
      tripwire.restore();
    }
    expect(client.email).toBe("rovara-helper@rovara-test.iam.gserviceaccount.invalid");
    expect(client._refreshToken).toBeUndefined();
    expect(tripwire.refused).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(refresh);
    expect(readdirSync(adc.cloudsdkConfigDir)).toEqual([]);
    expect(readFileSync(adc.credentialsFile, "utf8")).not.toContain(refresh);
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(adc.credentialsFile);
    expect(env.CLOUDSDK_CONFIG).toBe(adc.cloudsdkConfigDir);
    expect(JSON.parse(readFileSync(adc.credentialsFile, "utf8"))).toMatchObject({ type: "service_account", token_uri: "http://127.0.0.1:1/token" });
  });
  it("the dummy file's token route is the helper's: POST /token answers the dummy token and echoes nothing", async () => {
    const w = await startWorld();
    try {
      const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${realRefreshToken()}`;
      const reply = await request(`${w.meta as string}/token`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(JSON.parse(reply.body)).toEqual({ access_token: ["rovara", "dummy", "token"].join("-"), expires_in: 3600, token_type: "Bearer" });
      expect(reply.body).not.toContain("assertion");
      expect(w.ledgerText()).not.toContain("assertion");
      expect((await request(`${w.meta as string}/token`, { method: "GET" })).status).toBe(403);
    } finally {
      await w.close();
    }
  });
});
