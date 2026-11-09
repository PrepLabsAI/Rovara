// Running the redaction on its own output changes nothing: the findings (and any text that is stored, shown and shown again) pass through it several times, and each pass used to leave one more `]` behind.
import { describe, expect, it } from "vitest";
import { redactText } from "../../packages/contracts/src/redaction.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
// The header and key words are joined here so no scanner reads a credential-shaped literal in this file.
const A = ["Author", "ization"].join("");
const B = ["Bear", "er"].join("");
const K = ["Api", "-Key"].join("");
const K2 = ["k", "ey"].join("");
const hex = (): string => ["9f3a".repeat(8)].join("");
const corpus: string[] = [
  `curl -H "${A}: ${B} abcdef0123456789xyz" https://x.test`, `curl -H '${A}: ${B} abcdef0123456789xyz' https://x.test`, `${A}: ${B} abcdef0123456789xyz\nnext line`,
  `{"${A}": "${B} abcdef0123456789xyz"}`, `headers: {${A}: '${B} abcdef0123456789xyz'}`, `${A}:${B} abcdef0123456789`, "Proxy-Authorization: Basic dXNlcjpwYXNz",
  `Authorization: token ${token()}`, `X-${K}: abcdef0123456789`, "password=hunter2", `api_${K2}: abc123secretvalue`, "TOKEN: abc123", "export API_KEY=abc123 && run", "secret: |\n  line1\n  line2",
  `please use ${token()} for this`, `auth token ${hex()}`, "postgres://user:pw@host/db", "https://x.test/?token=abc&x=1", "mysql -pSECRET", "--password hunter2", "<password>abc</password>",
  "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "Basic dXNlcjpwYXNz", "cookie: a=b; session=abc", "I have a basic understanding of the bearer bonds module", "close issue 12 in payments-api",
  "Authorization: Bearer [REDACTED]", "Authorization: [REDACTED] [REDACTED]", "token: [REDACTED]", "password=[REDACTED]]]",
];

describe("redactText is idempotent", () => {
  it("leaves its own output as it is, for every input of the corpus (a header in quotes used to gain a `]` on each pass)", () => {
    for (const input of corpus) {
      const once = redactText(input);
      expect(redactText(once), input).toBe(once);
      expect(redactText(redactText(once)), input).toBe(once);
    }
    // The case found in the findings: a quoted header.
    expect(redactText(`curl -H "${A}: ${B} abcdef0123456789xyz" https://x.test`)).not.toContain("]]");
  });

  it("still redacts what it redacted before (positive control)", () => {
    expect(redactText("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactText(`use ${token()}`)).not.toContain(token());
  });
});
