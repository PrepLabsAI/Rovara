// Which websites a setup run may ask about at all. A host list is never a grant: nothing here reads a list of blocked names and allows any of them. The names a run reports only become asks (`requestHostAsk`), and an
// ask grants nothing until the owner approves it. Command output is never parsed for host names; the only source of a name is the run's own DNS watch.
//
// This is the pure part: which hosts are refused WITHOUT a card (an address literal, a name that carries an address, a private name, a name that is not plain ASCII host characters, paste, link-shortener, tunnel,
// webhook-collector and open-hosting suffixes, anything on the production deny list, a name too long to be read whole on a card). The refusal list is fixed words and fixed suffixes; it is not repository text and
// no run can change it.
import { DEFAULT_AGENT_ALLOW_DOMAINS, SetupHostSchema, prodDenyMatchesHost, type TestEnvProdDeny } from "@agentx/contracts";

/** A host longer than this is refused: the card shows the whole name, and a long name can hide its end. */
export const SETUP_HOST_CARD_MAX = 70;

export const SETUP_HOST_REFUSALS = ["not_a_host", "address_literal", "ip_in_name", "private_name", "too_long", "paste_site", "link_shortener", "tunnel", "webhook_sink", "raw_storage", "production", "model_host"] as const;
export type SetupHostRefusal = (typeof SETUP_HOST_REFUSALS)[number];

/** The fixed words a refusal is shown with (never a repository's or a model's words). */
export const SETUP_HOST_REFUSAL_WORDS: Record<SetupHostRefusal, string> = {
  not_a_host: "Not a plain website name.",
  address_literal: "An address, not a website name.",
  ip_in_name: "A name that stands for an address.",
  private_name: "A name that only means something inside one network.",
  too_long: "The name is too long to show whole.",
  paste_site: "A paste or file-drop website.",
  link_shortener: "A link-shortener website.",
  tunnel: "A tunnel to a machine outside the company.",
  webhook_sink: "A website that collects whatever is sent to it.",
  raw_storage: "Storage or hosting that anyone can upload to.",
  production: "On the company's production deny list.",
  model_host: "A model host: the test sandbox is not allowed to reach it.",
};

type SuffixKind = "paste_site" | "link_shortener" | "tunnel" | "webhook_sink" | "raw_storage" | "ip_in_name";
/** Suffixes by kind. A host matches when it IS the suffix or ends with `.<suffix>`. */
const SUFFIXES: ReadonlyArray<readonly [SuffixKind, readonly string[]]> = [
  ["paste_site", ["pastebin.com", "paste.ee", "hastebin.com", "dpaste.org", "dpaste.com", "0bin.net", "rentry.co", "ix.io", "termbin.com", "transfer.sh", "file.io", "anonfiles.com", "gofile.io", "catbox.moe", "temp.sh", "wetransfer.com", "ntfy.sh"]],
  ["link_shortener", ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "tiny.cc", "s.id", "rb.gy", "v.gd"]],
  ["tunnel", ["ngrok.io", "ngrok.app", "ngrok-free.app", "ngrok-free.dev", "ngrok.dev", "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net", "pagekite.me", "tunnelmole.net", "lhr.life", "localhost.run", "playit.gg", "portmap.io", "devtunnels.ms", "bore.pub", "zrok.io", "ts.net", "pinggy.io", "ngrok.com", "duckdns.org", "ddns.net", "no-ip.org", "no-ip.biz", "no-ip.com", "hopto.org", "zapto.org", "sytes.net", "myftp.org"]],
  ["webhook_sink", ["webhook.site", "requestbin.com", "requestbin.net", "pipedream.net", "interact.sh", "oast.fun", "oast.live", "oast.me", "oast.online", "oast.pro", "oast.site", "oastify.com", "burpcollaborator.net", "canarytokens.com", "beeceptor.com", "hookbin.com", "mockbin.org", "requestcatcher.com", "dnslog.cn", "ceye.io", "requestrepo.com"]],
  ["raw_storage", [
    "blob.core.windows.net", "storage.googleapis.com", "r2.cloudflarestorage.com", "r2.dev", "digitaloceanspaces.com", "backblazeb2.com", "wasabisys.com", "s3.amazonaws.com", "amazonaws.com.cn", "firebasestorage.googleapis.com",
    "web.app", "firebaseapp.com", "workers.dev", "pages.dev", "netlify.app", "vercel.app", "herokuapp.com", "glitch.me", "repl.co", "replit.dev",
    "cloudfront.net", "github.io", "azurewebsites.net", "fly.dev", "onrender.com", "surge.sh", "ipfs.io", "gitlab.io", "bitbucket.io", "appspot.com", "azurestaticapps.net",
  ]],
  // A name that resolves to whatever address its first labels spell: a way to name any machine.
  ["ip_in_name", ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me", "rbndr.us", "1u.ms"]],
];
/** `raw.` and `gist.` of GitHub's user-content host: anyone's file (the host itself is a regex so the outbound inventory keeps its one owner for the name). */
const GITHUB_USER_FILES = /^(?:raw|gist)\.githubusercontent\.com$/u;
/** `<id>.lambda-url.<region>.on.aws`: a function URL anyone can create. */
const LAMBDA_URL = /(?:^|\.)lambda-url\.[a-z0-9-]+\.on\.aws$/u;
/** Last labels that name no public website: they mean something only inside one network (or are reserved). */
const PRIVATE_LAST_LABELS: ReadonlySet<string> = new Set(["localhost", "local", "internal", "lan", "arpa", "onion", "test", "example", "invalid", "corp", "localdomain", "intranet", "home", "svc"]);
/** The cloud metadata name (the host itself and anything under it). */
const PRIVATE_SUFFIXES: readonly string[] = ["metadata.goog"];
/** Four numbers joined by dots or dashes anywhere in the name (`10-0-0-5.example.com`, `10.0.0.5.example.com`). */
const IP_IN_NAME = /(?:^|[.-])\d{1,3}([.-])\d{1,3}\1\d{1,3}\1\d{1,3}(?:$|[.-])/u;
const IPV4_ALL_DIGITS = /^[0-9.]+$/u;
/** Plain host characters only, checked on the text AS GIVEN (before it is lower-cased: `K` with a Kelvin sign lower-cases to `k`). */
const ASCII_HOST = /^[A-Za-z0-9.-]+$/u;

const coveredBySuffix = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);

/**
 * Why a host is refused without a card, or undefined when it may be asked about. Pure and total: any text gives an answer. The checks, in order: a colon (an IPv6 address is an `address_literal`, a
 * `host:port` or a URL is `not_a_host`), anything but ASCII letters, digits, dots and hyphens in the text as given, an address in digits, a private last label, the contract's host shape, the length,
 * an address in the name, the fixed suffix lists, then the company's production deny list. A name that is not understood is refused, never passed on.
 */
export function refuseSetupHost(host: string, prodDeny?: TestEnvProdDeny, sandboxDenied?: readonly string[]): SetupHostRefusal | undefined {
  if (typeof host !== "string") return "not_a_host";
  const raw = host.endsWith(".") ? host.slice(0, -1) : host;
  if (raw === "") return "not_a_host";
  if (raw.startsWith("[") || (raw.match(/:/gu) ?? []).length >= 2) return "address_literal";
  if (raw.includes(":")) return IPV4_ALL_DIGITS.test(raw.slice(0, raw.indexOf(":"))) ? "address_literal" : "not_a_host";
  if (!ASCII_HOST.test(raw)) return "not_a_host";
  const lower = raw.toLowerCase();
  if (IPV4_ALL_DIGITS.test(lower) || /^0x[0-9a-f]+$/u.test(lower)) return "address_literal";
  const labels = lower.split(".");
  if (PRIVATE_LAST_LABELS.has(labels[labels.length - 1]!) || PRIVATE_SUFFIXES.some((suffix) => coveredBySuffix(lower, suffix))) return "private_name";
  // A dynamic-DNS name (`<name>.ddns.<anything>`) points wherever its owner says.
  if (labels.includes("ddns")) return "tunnel";
  if (!SetupHostSchema.safeParse(lower).success) return "not_a_host";
  if (lower.length > SETUP_HOST_CARD_MAX) return "too_long";
  if (IP_IN_NAME.test(lower)) return "ip_in_name";
  if (LAMBDA_URL.test(lower) || GITHUB_USER_FILES.test(lower)) return "raw_storage";
  for (const [kind, suffixes] of SUFFIXES) if (suffixes.some((suffix) => coveredBySuffix(lower, suffix))) return kind;
  if (prodDeny !== undefined && prodDenyMatchesHost(prodDeny, lower)) return "production";
  // FIX-0518: a model host the test sandbox is denied (the laptop's deny list) is not one a setup run can ask back in, and is never "already allowed".
  if (sandboxDenied !== undefined && sandboxDenied.length > 0 && listCovers(sandboxDenied, lower)) return "model_host";
  return undefined;
}

/** Whether any label is punycode (`xn--`): the card says "international name", because it may look like another name. */
export const isInternationalName = (host: string): boolean => host.split(".").some((label) => label.startsWith("xn--"));

/** A wildcard entry (`*.example.com`) covers subdomains only, as the DNS firewall reads it. */
function listCovers(list: readonly string[], host: string): boolean {
  return list.some((entry) => { const e = entry.toLowerCase(); return e.startsWith("*.") ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e; });
}
/** Whether the host is already reachable by default or by the project's own list (so no ask is needed). */
export function hostAlreadyAllowed(host: string, projectDomains: readonly string[]): boolean {
  return listCovers(DEFAULT_AGENT_ALLOW_DOMAINS, host) || listCovers(projectDomains, host);
}

