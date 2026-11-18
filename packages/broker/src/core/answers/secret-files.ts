// Files the answer service never opens or cites (lead 4, J1; wiki design review fix 5: "code readers refuse secret-shaped files in code"). A secret-shaped NAME is refused outright, and a file whose
// text holds a private key block is refused even when its name looks harmless. The same refusal covers the code read the model asks for AND the re-read that checks a citation, so a model cannot use
// the check as a way to learn whether a secret file holds some text, and a refusal says the same words as a file that is not there (no oracle for which names exist).
import { redactText } from "@agentx/contracts";
import { isSafeCitedPath } from "../citations/citation-check.js";

const SECRET_DIRS = /^(?:\.?secrets?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.git|\.?credentials?|\.env|private[-_]?keys?|keys|certs?|certificates)$/iu;
const SECRET_FILE = new RegExp([
  String.raw`^\.env(?:\..*)?$`, String.raw`^.*\.env$`,
  String.raw`^.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|p8|ppk|tfstate|tfvars|gpg|asc)$`,
  String.raw`^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$`,
  String.raw`^\.(?:npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg|pgpass|envrc|vault-token)$`, String.raw`^.*\.tfstate(?:\..*)?$`, String.raw`^.*\.keytab$`,
  String.raw`^credentials?(?:\..*)?$`, String.raw`^kubeconfig(?:\..*)?$`,
  String.raw`^service[-_]?account.*\.json$`,
].join("|"), "iu");
// "secretary" is not a secret: a name is secret-shaped when "secret" stands as a word of its own (start, end or beside a separator).
const SECRET_WORD = /(?:^|[^a-z])secrets?(?:[^a-z]|$)/iu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/u;

/** Whether the path may not be opened or cited: an unsafe path, a secret-shaped file name, or any folder of the path that is secret-shaped. */
export function secretShapedPath(path: string): boolean {
  if (!isSafeCitedPath(path)) return true;
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  for (const folder of segments.slice(0, -1)) if (SECRET_DIRS.test(folder) || SECRET_WORD.test(folder) || SECRET_FILE.test(folder)) return true;
  return SECRET_FILE.test(name) || SECRET_WORD.test(name) || SECRET_DIRS.test(name);
}

/** The text with every line redacted on its own, so the lines keep their numbers (a redaction that spans lines would shift them). What the model is shown and what a citation is checked against are the same text. */
export const redactedLines = (text: string): string => text.split(/\r\n|\r|\n/u).map((line) => redactText(line)).join("\n");

/** Whether a file's text holds a private key block. */
export const holdsPrivateKey = (text: string): boolean => PRIVATE_KEY_BLOCK.test(text);
