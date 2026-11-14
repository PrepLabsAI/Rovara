// TE-F1a: the address checks the key-holding proxy needs, as a COPY of the ones in `packages/worker/src/test-account-proxy.ts` (`proxyHostName`, `looksLikeAddress`, `isForbiddenAddress`), so the Cloud function can import them
// from the contracts package. The worker's copy is left untouched (it is behaviour a Cloud copy already pins); `tests/unit/model-egress-address.test.ts` holds the two to one truth table. Deduplicate when Cloud's copy can follow
// (DEFERRED-CHECKS).
//
// The resolve-check rule (design 7, SSRF): the function resolves the row's host itself, refuses the whole answer when ANY address in it is private, loopback (Lambda's runtime API listens on 127.0.0.1), link-local, shared,
// multicast, reserved or an IPv4-mapped IPv6 address, and connects to the address it checked with the row's host as the TLS name, so a second lookup cannot change where the call goes (rebinding).
import { isIP } from "node:net";

// ---- names

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A host as the proxy compares it: lower case, no trailing dot, plain DNS labels, at least two of them, and a last label that has a letter (so `127.1`, `0x7f.1`, `2130706433` and `1.2.3.4` are never names).
 * Undefined when the text is not such a name. An address of any spelling is not a name.
 */
export function proxyHostName(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 253 || /[^\x21-\x7e]/u.test(raw)) return undefined;
  const name = raw.toLowerCase().replace(/\.$/u, "");
  if (name === "" || isIP(name) !== 0 || name.includes(":") || name.includes("[") || name.includes("%")) return undefined;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return undefined;
  const tld = labels[labels.length - 1] as string;
  if (!/[a-z]/u.test(tld)) return undefined;
  // `xn--` is a legitimate label (an internationalized name); a label made of hex digits behind `0x` is not.
  if (labels.some((label) => /^0x[0-9a-f]*$/u.test(label))) return undefined;
  return name;
}

/** Whether the text is, or can be read as, an address: any IP spelling, a bracketed IPv6, a name with no letter in its last label, or a name with no dot (`localhost`). */
export function looksLikeAddress(raw: string): boolean {
  const name = raw.toLowerCase().replace(/\.$/u, "");
  if (name.startsWith("[") || name.includes(":") || isIP(name) !== 0) return true;
  if (/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/u.test(name)) return true;
  const labels = name.split(".");
  return labels.length < 2 || !/[a-z]/u.test(labels[labels.length - 1] ?? "");
}


// ---- addresses

/** The 16 bytes of an IPv6 address (compressed, with an embedded dotted IPv4 tail, or with a zone), or undefined. Node's `isIP` has already said it is IPv6. */
function ipv6Bytes(address: string): number[] | undefined {
  const text = address.split("%")[0] as string;
  let head = text;
  let tail4: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (dotted !== null) {
    tail4 = dotted.slice(1, 5).map(Number);
    if (tail4.some((part) => part > 255)) return undefined;
    head = `${text.slice(0, text.length - (dotted[0]).length)}0:0`;
  }
  const sides = head.split("::");
  if (sides.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":").map((group) => (/^[0-9a-f]{1,4}$/iu.test(group) ? Number.parseInt(group, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  const left = parse(sides[0] as string);
  const right = sides.length === 2 ? parse(sides[1] as string) : [];
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if (sides.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...left, ...Array.from({ length: sides.length === 2 ? missing : 0 }, () => 0), ...right];
  if (tail4.length === 4) {
    groups[6] = (tail4[0] as number) * 256 + (tail4[1] as number);
    groups[7] = (tail4[2] as number) * 256 + (tail4[3] as number);
  }
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/**
 * Whether an address is one a test account must never be reached at: loopback, private, link-local (the metadata address included), shared, multicast, reserved, unspecified. For IPv6, by prefix on the 16 bytes:
 * ::/96 (unspecified, loopback and IPv4-compatible), ::ffff:0:0/96 (every IPv4-mapped address, whatever its IPv4), 64:ff9b::/96 and 64:ff9b:1::/48 (translation), 100::/64, 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4: it carries an
 * IPv4 address that could be anything), fc00::/7, fe80::/10, fec0::/10 (deprecated site-local) and ff00::/8. Anything that is not an address at all is forbidden.
 */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 0) return true;
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true;
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  const first = (bytes[0] as number) * 256 + (bytes[1] as number);
  const second = (bytes[2] as number) * 256 + (bytes[3] as number);
  return zeros(0, 12) // ::/96
    || (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) // ::ffff:0:0/96
    || (first === 0x0064 && second === 0xff9b && zeros(4, 12)) // 64:ff9b::/96
    || (first === 0x0064 && second === 0xff9b && bytes[4] === 0x00 && bytes[5] === 0x01) // 64:ff9b:1::/48 (RFC 8215 local-use translation)
    || (first === 0x0100 && zeros(2, 8)) // 100::/64
    || (first === 0x2001 && second === 0x0000) // 2001::/32
    || (first === 0x2001 && second === 0x0db8) // 2001:db8::/32
    || first === 0x2002 // 2002::/16
    || (first & 0xfe00) === 0xfc00 // fc00::/7
    || (first & 0xffc0) === 0xfe80 // fe80::/10
    || (first & 0xffc0) === 0xfec0 // fec0::/10
    || (first & 0xff00) === 0xff00; // ff00::/8
}


export const MODEL_EGRESS_PORT = 443;
/** Domains no model call may go to, whatever a row or a company gateway says: AWS's own API and function-URL domains (an exit to anyone's account, and Lambda's own endpoints). Cloud adds Rovara's own domains through `options`. */
export const MODEL_EGRESS_DENIED_SUFFIXES = ["amazonaws.com", "amazonaws.com.cn", "on.aws", "lambda-url.on.aws"] as const;

export type ConnectPlan =
  | { readonly ok: true; readonly address: string; readonly port: 443; readonly scheme: "https"; readonly tlsServerName: string; readonly verifyCertificate: true; readonly followRedirects: false }
  | { readonly ok: false; readonly refusal: "ssrf" };

/** The name to hand the resolver: the fully qualified form (a trailing dot), so the machine's search domains can never turn `api.example.com` into `api.example.com.internal`. Undefined for a host that is not a plain public name. */
export function lookupNameFor(host: string): string | undefined {
  const name = proxyHostName(host);
  return name === undefined || name !== host || looksLikeAddress(host) ? undefined : `${name}.`;
}

/**
 * The address to connect to and the TLS name to verify, from the resolver's whole answer for `host`. Run it on EVERY call, not only when a row or source is saved (an answer changes, and so does a host's owner). Refuses (`ssrf`) a host
 * that is not a plain public name, a host under a denied suffix, an empty answer, and an answer in which ANY address is forbidden (one private address among public ones is a rebinding or split-horizon attempt, not a choice
 * to make). The first address of the checked answer is used. The plan is https only, with the certificate verified against the host's name, and it never follows a redirect.
 */
export function planConnection(host: string, answers: readonly string[], options: { readonly denySuffixes?: readonly string[] } = {}): ConnectPlan {
  const name = proxyHostName(host);
  if (name === undefined || name !== host || looksLikeAddress(host)) return { ok: false, refusal: "ssrf" };
  const denied = [...MODEL_EGRESS_DENIED_SUFFIXES, ...(options.denySuffixes ?? [])];
  if (denied.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) return { ok: false, refusal: "ssrf" };
  const first = answers[0];
  if (first === undefined || answers.length > 64 || answers.some((answer) => typeof answer !== "string" || isForbiddenAddress(answer))) return { ok: false, refusal: "ssrf" };
  return { ok: true, address: first, port: MODEL_EGRESS_PORT, scheme: "https", tlsServerName: name, verifyCertificate: true, followRedirects: false };
}
