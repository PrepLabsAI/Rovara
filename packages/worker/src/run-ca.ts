// A certificate authority for ONE eval round (L4-E56, row E6): the eval box reaches outside HTTPS vendors only through Rovara's stand-in, and its client has to trust the stand-in's certificate. So each round makes its own
// authority; the box is told to trust the authority's CERTIFICATE through environment variables only (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, ...; see `evalStandInTrustEnvironment`), never by a change to the image
// or the system's trust store. The authority's KEY is made here, handed to the stand-in helper (its own read-only mount, digest-pinned) and nowhere else: it is never written into the box's checkout, env file or arguments.
// The authority and every certificate it signs live for a day at most and the key is never stored past the round, so a copy of the public certificate trusts nothing once the round is gone.
//
// Pure node:crypto (ECDSA P-256 with SHA-256); the X.509 DER is built here (the repository has no certificate library). Names are DNS names or IP addresses; a leaf is a server certificate only (no CA, serverAuth).
// Nothing here opens a connection.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_BASIC = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EKU = "2.5.29.37";
const OID_SAN = "2.5.29.17";
const OID_SKI = "2.5.29.14";
const OID_AKI = "2.5.29.35";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const HOUR_MS = 3_600_000;
/** How long the authority lasts. Short on purpose: it is made for one round. */
export const RUN_CA_LIFETIME_MS = 30 * HOUR_MS;
export const RUN_CA_COMMON_NAME_PREFIX = "Rovara eval run CA ";

// ---- DER

const concat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
function lengthOf(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length < 0x100) return Uint8Array.of(0x81, length);
  if (length < 0x10000) return Uint8Array.of(0x82, length >> 8, length & 0xff);
  throw new RangeError("a certificate part is too long");
}
const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => { const body = concat(...content); return concat(Uint8Array.of(tag), lengthOf(body.length), body); };
const sequence = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]): Uint8Array => tlv(0x31, ...parts);
const explicit = (tag: number, ...parts: Uint8Array[]): Uint8Array => tlv(0xa0 | tag, ...parts);
const octetString = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);
const boolean = (value: boolean): Uint8Array => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
const utf8 = (text: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(text));
const bitString = (bytes: Uint8Array, unused: number): Uint8Array => tlv(0x03, Uint8Array.of(unused), bytes);
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.slice(start);
  return tlv(0x02, body[0]! >= 0x80 ? concat(Uint8Array.of(0), body) : body);
}
function oid(text: string): Uint8Array {
  const parts = text.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const group = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) group.unshift((rest & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}
function utcTime(ms: number): Uint8Array {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, "0");
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new RangeError("a certificate time is outside UTCTime");
  return tlv(0x17, new TextEncoder().encode(`${two(year % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`));
}
const name = (commonName: string): Uint8Array => sequence(set(sequence(oid(OID_CN), utf8(commonName))));
const algorithm = (): Uint8Array => sequence(oid(ECDSA_SHA256));
const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
const spkiOf = (key: KeyObject): Uint8Array => new Uint8Array((key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" }));
/** The subject key identifier: 20 bytes of the SHA-256 of the key's SPKI (any stable, unique value is a valid identifier). */
const keyIdentifierOf = (key: KeyObject): Uint8Array => new Uint8Array(createHash("sha256").update(spkiOf(key)).digest().subarray(0, 20));
function serial(): Uint8Array { const bytes = randomBytes(16); bytes[0] = (bytes[0]! & 0x7f) | 0x01; return bytes; }

const pem = (label: string, der: Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/.{1,64}/gu, "$&\n").trimEnd()}\n-----END ${label}-----\n`;

interface CertificateInput {
  readonly subjectName: string;
  readonly issuerName: string;
  readonly subjectKey: KeyObject;
  readonly issuerKey: KeyObject;
  readonly issuerKeyIdentifier: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly extensions: Uint8Array[];
}
function certificate(input: CertificateInput): Uint8Array {
  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))), integer(serial()), algorithm(), name(input.issuerName),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)), name(input.subjectName), spkiOf(input.subjectKey),
    explicit(3, sequence(...input.extensions)),
  );
  const signature = new Uint8Array(sign("sha256", tbs, input.issuerKey));
  return sequence(tbs, algorithm(), bitString(signature, 0));
}

export interface RunCa {
  /** The public certificate: the only part that goes anywhere near the eval box. */
  readonly certPem: string;
  /** The private key: for the stand-in helper's mount only. */
  readonly keyPem: string;
}

/** A new authority for one round. `now` is a test seam. */
export function createRunCa(now: () => number = Date.now): RunCa {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const subject = `${RUN_CA_COMMON_NAME_PREFIX}${randomBytes(6).toString("hex")}`;
  const identifier = keyIdentifierOf(publicKey);
  const start = now() - HOUR_MS;
  const der = certificate({
    subjectName: subject, issuerName: subject, subjectKey: publicKey, issuerKey: privateKey, issuerKeyIdentifier: identifier,
    notBefore: start, notAfter: start + RUN_CA_LIFETIME_MS,
    extensions: [
      // pathLenConstraint 0: this authority signs server certificates only, never another authority.
      extension(OID_BASIC, true, sequence(boolean(true), integer(Uint8Array.of(0)))),
      // keyCertSign (bit 5) and cRLSign (bit 6): 0000 0110, one unused bit.
      extension(OID_KEY_USAGE, true, bitString(Uint8Array.of(0x06), 1)),
      extension(OID_SKI, false, octetString(identifier)),
    ],
  });
  return { certPem: pem("CERTIFICATE", der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export interface MintedLeaf { readonly certPem: string; readonly keyPem: string }
export interface LeafMinter {
  /** A server certificate for this DNS name or IP address, signed by the run's authority. The same name gets the same certificate again (cached). Undefined for a name that is not a plain host name or address. */
  mint(host: string): MintedLeaf | undefined;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/u;
const MAX_LEAVES = 256;

function sanOf(host: string): Uint8Array | undefined {
  const family = isIP(host);
  if (family === 4) return tlv(0x87, Uint8Array.from(host.split(".").map(Number)));
  if (family === 0 && host.length <= 253 && HOST.test(host)) return tlv(0x82, new TextEncoder().encode(host));
  return undefined;
}

/** Mints leaf certificates for a run's authority, given its PEM. One leaf key for the whole round (making a key per name would slow a client's first call for nothing); certificates are cached by name. */
export function createLeafMinter(ca: RunCa, now: () => number = Date.now): LeafMinter {
  const authorityKey = createPrivateKey(ca.keyPem);
  const authority = new X509Certificate(ca.certPem);
  const commonName = /(?:^|\n)CN=([^\n]+)/u.exec(authority.subject)?.[1];
  if (commonName === undefined || !commonName.startsWith(RUN_CA_COMMON_NAME_PREFIX)) throw new Error("not a run authority");
  const authorityIdentifier = keyIdentifierOf(authority.publicKey);
  const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leafKeyPem = leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const leafIdentifier = keyIdentifierOf(leaf.publicKey);
  const cache = new Map<string, MintedLeaf>();
  return {
    mint(host: string): MintedLeaf | undefined {
      const lowered = host.toLowerCase();
      const san = sanOf(lowered);
      if (san === undefined) return undefined;
      const cached = cache.get(lowered);
      if (cached !== undefined) return cached;
      if (cache.size >= MAX_LEAVES) cache.clear();
      const start = now() - HOUR_MS;
      const der = certificate({
        subjectName: lowered.length <= 64 ? lowered : "rovara stand-in", issuerName: commonName, subjectKey: leaf.publicKey, issuerKey: authorityKey, issuerKeyIdentifier: authorityIdentifier,
        notBefore: start, notAfter: start + RUN_CA_LIFETIME_MS,
        extensions: [
          extension(OID_BASIC, true, sequence()),
          // digitalSignature (bit 0): 1000 0000, seven unused bits.
          extension(OID_KEY_USAGE, true, bitString(Uint8Array.of(0x80), 7)),
          extension(OID_EKU, false, sequence(oid(OID_SERVER_AUTH))),
          extension(OID_SAN, false, sequence(san)),
          extension(OID_SKI, false, octetString(leafIdentifier)),
          extension(OID_AKI, false, sequence(tlv(0x80, authorityIdentifier))),
        ],
      });
      const minted = { certPem: pem("CERTIFICATE", der), keyPem: leafKeyPem };
      cache.set(lowered, minted);
      return minted;
    },
  };
}

// ---- how the box trusts the authority: environment variables only

/** Where the public certificate is placed inside the box's checkout (the box's one mount) and the variables that point clients at it. */
export const EVAL_CA_RELATIVE_PATH = ".rovara-eval-ca/ca.pem";
export const EVAL_TRUST_VARIABLES = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "PIP_CERT", "DENO_CERT"] as const;

/** The trust lines of the box's env file for a certificate at `path` inside the box (an absolute path). Names and one path only: no key, no PEM text. */
export function evalStandInTrustEnvironment(path: string): [string, string][] {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/u.test(path) || path.split("/").includes("..")) throw new Error("not a certificate path");
  return EVAL_TRUST_VARIABLES.map((variable): [string, string] => [variable, path]);
}
