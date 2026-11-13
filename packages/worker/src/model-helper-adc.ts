// TE-F2 part B (M2, release 0.5.19): the DUMMY Google Application Default Credentials of a laptop round. A Google client (Python or JS google-auth) finds credentials in this order: `GOOGLE_APPLICATION_CREDENTIALS`, then
// `$CLOUDSDK_CONFIG/application_default_credentials.json` (or `~/.config/gcloud/...`), then the metadata server. On a laptop the second place holds the user's REAL refresh token, and the first may name a real key file. A round
// therefore makes, in its own worker-owned directory: an EMPTY config directory (`CLOUDSDK_CONFIG` points at it, so the real file is never found) and a dummy service-account file whose key is a throwaway RSA key made now and whose
// token URI is the helper's `/token` route (model-helper-metadata.ts), so a client that finds it signs a request with a key that is worth nothing and gets the dummy token back. Nothing here is a real credential; nothing is
// read from the user's files; the files live in the run directory and go with it.
import { generateKeyPair } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { GCE_PLACEHOLDER_EMAIL } from "@agentx/contracts";

export interface DummyAdc {
  readonly credentialsFile: string;
  readonly cloudsdkConfigDir: string;
}

/** Writes `<dir>/adc.json` (a dummy service-account file, 0600) and an empty `<dir>/cloudsdk` (0700). `tokenUri` is `http://127.0.0.1:<meta port>/token`. */
export async function writeDummyAdc(input: { readonly dir: string; readonly tokenUri: string; readonly projectId?: string | undefined }): Promise<DummyAdc> {
  const { privateKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const cloudsdkConfigDir = join(input.dir, "cloudsdk");
  await mkdir(cloudsdkConfigDir, { recursive: true, mode: 0o700 });
  const credentialsFile = join(input.dir, "adc.json");
  await writeFile(
    credentialsFile,
    JSON.stringify({
      type: "service_account",
      project_id: input.projectId ?? "rovara-test-project",
      private_key_id: "rovara0000000000000000000000000000000000",
      private_key: privateKey,
      client_email: GCE_PLACEHOLDER_EMAIL,
      client_id: "100000000000000000000",
      token_uri: input.tokenUri,
    }),
    { mode: 0o600 },
  );
  return { credentialsFile, cloudsdkConfigDir };
}
