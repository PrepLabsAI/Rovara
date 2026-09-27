// Shared fakes for the developer sign-in (spec 025 phase 25a). Nothing here reaches AWS, Slack or
// any identity provider. Later tasks add the fake Slack and OIDC providers below.
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import type { PublicSigningJwk, TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";

export const T0 = Date.parse("2026-09-27T12:00:00.000Z");
export const API = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const ISSUER = `${API}/v1/auth`;

export function rsaKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** A KMS client that signs with a local RSA key, and records every command it received. */
export function fakeKms(keys = rsaKeyPair()) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    publicKey: keys.publicKey,
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (command instanceof GetPublicKeyCommand) {
        return { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PublicKey: new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })) };
      }
      if (command instanceof SignCommand) {
        if (input.MessageType !== "RAW" || input.SigningAlgorithm !== "RSASSA_PKCS1_V1_5_SHA_256") throw new Error("unexpected signing request");
        return { Signature: new Uint8Array(cryptoSign("sha256", Buffer.from(input.Message as Uint8Array), keys.privateKey)) };
      }
      throw new Error(`fakeKms does not support ${name}`);
    },
  };
}

/** The signer every server test uses: the real KMS signer over the fake KMS. */
export function localSigner(): TokenSigner & { jwks(): Promise<{ keys: PublicSigningJwk[] }> } {
  const signer = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/test" });
  return { ...signer, jwks: async () => ({ keys: [await signer.publicJwk()] }) };
}
