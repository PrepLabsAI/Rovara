// A software passkey (WebAuthn authenticator) for the step-up tests: an ES256 key, "none" attestation, and assertions signed over authenticatorData || SHA-256(clientDataJSON).
// Written from the WebAuthn Level 3 data layouts, independently of the server's library, so the server's verification is tested end to end without a browser.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type Cbor = number | string | Uint8Array | CborMap;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a named Map type lets Cbor refer to itself
interface CborMap extends Map<Cbor, Cbor> {}

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65_536) return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

/** The small part of CBOR (RFC 8949) that attestation objects and COSE keys need. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries: Array<[Cbor, Cbor]> = [...value.entries()];
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

export interface FakePasskey {
  id: string;
  /** The JSON a browser's `credential.toJSON()` gives for `navigator.credentials.create`. `tamper` changes one part to prove the server checks it. */
  register(options: { challenge: string }, origin: string, rpId: string, tamper?: { userVerified?: false; origin?: string; rpId?: string; challenge?: string }): Record<string, unknown>;
  /** The JSON for `navigator.credentials.get`. */
  assert(options: { challenge: string }, origin: string, rpId: string, tamper?: { userVerified?: false; origin?: string; rpId?: string; challenge?: string; counter?: number; otherKey?: KeyObject }): Record<string, unknown>;
  counter: number;
}

export function fakePasskey(): FakePasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const coseKey = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const flags = (attested: boolean, userVerified: boolean) => 0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
  const counterBytes = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const self: FakePasskey = {
    id: b64url(credentialId),
    counter: 0,
    register(options, origin, rpId, tamper = {}) {
      const authData = Buffer.concat([
        sha256(tamper.rpId ?? rpId), Buffer.from([flags(true, tamper.userVerified !== false)]), counterBytes(0),
        Buffer.alloc(16), Buffer.from([credentialId.length >> 8, credentialId.length & 255]), credentialId, coseKey,
      ]);
      const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map<Cbor, Cbor>()], ["authData", authData]]));
      return {
        id: self.id, rawId: self.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64url(clientData("webauthn.create", tamper.challenge ?? options.challenge, tamper.origin ?? origin)), attestationObject: b64url(attestationObject), transports: ["internal"] },
      };
    },
    assert(options, origin, rpId, tamper = {}) {
      self.counter = tamper.counter ?? self.counter + 1;
      const authData = Buffer.concat([sha256(tamper.rpId ?? rpId), Buffer.from([flags(false, tamper.userVerified !== false)]), counterBytes(self.counter)]);
      const data = clientData("webauthn.get", tamper.challenge ?? options.challenge, tamper.origin ?? origin);
      const signature = sign("sha256", Buffer.concat([authData, sha256(data)]), tamper.otherKey ?? privateKey);
      return {
        id: self.id, rawId: self.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64url(data), authenticatorData: b64url(authData), signature: b64url(signature) },
      };
    },
  };
  return self;
}
