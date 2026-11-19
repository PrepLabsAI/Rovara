// The personal-data scanner (SM5): the built-in heuristic scanner finds the usual personal data in a recorded model answer, leaves reserved and fictional values alone so a synthetic fixture passes, and redacts by span.
// Every key-shaped value is built at runtime.
import { describe, expect, it } from "vitest";
import {
  PII_KINDS, PII_SCAN_MAX_CHARS, deepScan, looksBinary, normaliseForScan, PiiScanInputTooLarge, builtinPiiScanner, combinePiiScanners, ibanValid, luhnValid, mergeFindings, piiKindsOf, piiPlaceholder, redactPii, type PiiFinding, type PiiKind, type PiiScanner,
} from "../../packages/contracts/src/index.js";

const scan = (text: string): PiiFinding[] => builtinPiiScanner.scan(text) as PiiFinding[];
const kinds = (text: string): PiiKind[] => piiKindsOf(scan(text));
const textOf = (text: string, finding: PiiFinding) => text.slice(finding.start, finding.end);

describe("what it finds", () => {
  it("finds an email address, and leaves reserved domains alone", () => {
    const text = "write to pat.quill@fakemail-sample.io or sam@example.com or kim@svc.test or lee@host.invalid";
    const found = scan(text);
    expect(found.map((finding) => finding.kind)).toEqual(["email"]);
    expect(textOf(text, found[0]!)).toBe("pat.quill@fakemail-sample.io");
  });
  it("finds phone numbers, and leaves the fictional 555-01xx range alone", () => {
    expect(kinds("call +44 20 7946 0958 now")).toEqual(["phone"]);
    expect(kinds("call 415-867-5309 now")).toEqual(["phone"]);
    expect(kinds("call 415-555-0123 or +1 202 555 0142")).toEqual([]);
    expect(kinds("order 4155550123456789")).toEqual([]);
  });
  it("finds a card number by its Luhn check, and not an ordinary long number or a UUID", () => {
    expect(kinds("card 4111 1111 1111 1111 expires")).toEqual(["card_number"]);
    expect(kinds("card 4111-1111-1111-1111")).toEqual(["card_number"]);
    expect(kinds("card 4111 1111 1111 1112")).toEqual([]);
    expect(kinds("id 123e4567-e89b-12d3-a456-426614174000 and 1700000000123")).toEqual([]);
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  it("finds national ids: a social security number, a UK insurance number, an Aadhaar-shaped number", () => {
    expect(kinds("ssn 123-45-6789")).toEqual(["national_id"]);
    expect(kinds("ssn 000-12-3456 or 666-12-3456 or 912-12-3456")).toEqual([]);
    expect(kinds("nino AB 12 34 56 C")).toEqual(["national_id"]);
    expect(kinds("aadhaar 2345 6789 0123")).toEqual(["national_id"]);
  });
  it("finds an IBAN that passes the mod-97 check", () => {
    expect(kinds("pay GB82 WEST 1234 5698 7654 32 today")).toEqual(["bank_account"]);
    expect(kinds("pay GB82 WEST 1234 5698 7654 33 today")).toEqual([]);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  });
  it("finds IP addresses, and leaves loopback, documentation ranges and version numbers alone", () => {
    expect(kinds("from 8.8.8.8 and 10.0.0.1")).toEqual(["ip_address"]);
    expect(scan("from 8.8.8.8 and 10.0.0.1")).toHaveLength(2);
    expect(kinds("from 2a00:1450:4009:81f::200e")).toEqual(["ip_address"]);
    expect(kinds("loopback 127.0.0.1, ::1, docs 203.0.113.7 198.51.100.4 2001:db8::1, version 1.2.3.4.5, time 12:30:45, 999.1.1.1")).toEqual([]);
  });
  it("finds the account id inside an ARN, built here at run time", () => {
    const account = "2".repeat(12);
    const text = `role arn:aws:iam::${account}:role/x in use`;
    const found = scan(text);
    expect(found.map((finding) => finding.kind)).toEqual(["aws_account"]);
    expect(textOf(text, found[0]!)).toBe(account);
  });
  it("finds people's names: a common first name and a capitalised word, `Last, First`, and the value of a key that names a person", () => {
    expect(kinds("customer Mary Johnson called")).toEqual(["person_name"]);
    expect(kinds("customer Johnson, Mary called")).toEqual(["person_name"]);
    const json = "{\"first_name\": \"Zorbo\", \"model_name\": \"bert-base\", \"name\": \"fraud-v2\"}";
    const found = scan(json);
    expect(found.map((finding) => textOf(json, finding))).toEqual(["Zorbo"]);
    expect(kinds("The Model Score is 0.7 and Hello World")).toEqual([]);
  });
  it("finds a secret the product's redactor would change", () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const text = `config aws_access_key_id=${key} done`;
    expect(kinds(text)).toContain("secret");
  });
  it("finds nothing in a plain model answer", () => {
    expect(scan(JSON.stringify({ score: 0.87, label: "approve", features: [1, 2, 3], model: "xgboost-v3", at: "2026-11-20T10:00:00Z" }))).toEqual([]);
  });
});

describe("reserved domains are exact", () => {
  it("exempts exactly the reserved names, not a longer name that ends in one", () => {
    expect(kinds("a@example.com b@example.org c@example.net d@svc.test e@host.invalid f@name.example g@box.localhost")).toEqual([]);
    expect(kinds("real@gmail.com.invalid")).toEqual(["email"]);
    expect(kinds("real@mail.fakemail-sample.io.test")).toEqual(["email"]);
    expect(kinds("real@notexample.com")).toEqual(["email"]);
    expect(kinds("real@sub.example.com")).toEqual(["email"]);
  });
});

describe("what a text says once it is decoded", () => {
  const EMAIL_ESCAPED = "{\"e\":\"pat.quill\\u0040fakemail-sample.io\"}";
  const NAME_ESCAPED = "{\"customer_name\":\"Jos\\u00e9 Garc\\u00eda\"}";

  it("is blind to a JSON escape when it reads only the text as written (the gap the deep scan closes)", () => {
    expect(scan(EMAIL_ESCAPED)).toEqual([]);
    expect(scan(NAME_ESCAPED)).toEqual([]);
  });
  it("finds an email spelled with a JSON escape, and redacts it as the address it is", async () => {
    const deep = await deepScan(builtinPiiScanner, EMAIL_ESCAPED);
    expect(deep.kinds).toEqual(["email"]);
    expect(JSON.parse(deep.redacted())).toEqual({ e: "[REDACTED:EMAIL]" });
    expect((await deepScan(builtinPiiScanner, deep.redacted())).kinds).toEqual([]);
  });
  it("finds a name under a person's key even when the name is written with escapes, and redacts it", async () => {
    const deep = await deepScan(builtinPiiScanner, NAME_ESCAPED);
    expect(deep.kinds).toEqual(["person_name"]);
    expect(JSON.parse(deep.redacted())).toEqual({ customer_name: "[REDACTED:PERSON_NAME]" });
    expect((await deepScan(builtinPiiScanner, deep.redacted())).kinds).toEqual([]);
    // the same name in a key that is not a person's is not a finding by that rule
    expect((await deepScan(builtinPiiScanner, "{\"model_name\":\"Jos\\u00e9 Garc\\u00eda\"}")).kinds).toEqual([]);
  });
  it("finds an address split across two values, and says so by leaving it in the redacted text for the second scan to refuse", async () => {
    const split = "{\"a\":\"pat.quill@\",\"b\":\"fakemail-sample.io\"}";
    const deep = await deepScan(builtinPiiScanner, split);
    expect(deep.kinds).toEqual(["email"]);
    expect((await deepScan(builtinPiiScanner, deep.redacted())).kinds).toEqual(["email"]);
  });
  it("reads a text as a reader sees it: invisible characters out, full-width digits folded", async () => {
    expect((await deepScan(builtinPiiScanner, "mail pat.quill@fake\u200Bmail-sample.io now")).kinds).toEqual(["email"]);
    expect((await deepScan(builtinPiiScanner, "mail pat.quill@fake\uFEFFmail-sample.io now")).kinds).toEqual(["email"]);
    expect((await deepScan(builtinPiiScanner, "card ４１１１ １１１１ １１１１ １１１１ end")).kinds).toEqual(["card_number"]);
  });
  it("redacts text that is not JSON by span, and leaves what only the normalised text shows for the second scan to refuse", async () => {
    const plain = await deepScan(builtinPiiScanner, "to pat.quill@fakemail-sample.io now");
    expect(plain.redacted()).toBe("to [REDACTED:EMAIL] now");
    const hidden = await deepScan(builtinPiiScanner, "to pat.quill@fake\u200Bmail-sample.io now");
    expect((await deepScan(builtinPiiScanner, hidden.redacted())).kinds).toEqual(["email"]);
  });
  it("treats a control character other than tab, CR and LF as binary", () => {
    expect(looksBinary("a\u0000b")).toBe(true);
    expect(looksBinary("a\u0001b")).toBe(true);
    expect(looksBinary("tab\tcr\rlf\n")).toBe(false);
    expect(normaliseForScan("ａ\u200Bb")).toBe("ab");
  });
});

describe("redaction by span", () => {
  it("replaces each finding with its kind's placeholder and keeps the rest of the text", () => {
    const text = "to pat.quill@fakemail-sample.io, ssn 123-45-6789, thanks";
    const redacted = redactPii(text, scan(text));
    expect(redacted).toBe(`to ${piiPlaceholder("email")}, ssn ${piiPlaceholder("national_id")}, thanks`);
    expect(scan(redacted)).toEqual([]);
  });
  it("keeps JSON valid, because the placeholder holds no quote or backslash", () => {
    const text = JSON.stringify({ contact: "pat.quill@fakemail-sample.io", n: 1 });
    expect(() => { JSON.parse(redactPii(text, scan(text))); }).not.toThrow();
    expect(JSON.parse(redactPii(text, scan(text)))).toEqual({ contact: "[REDACTED:EMAIL]", n: 1 });
  });
  it("joins overlapping spans into one, and orders them", () => {
    const merged = mergeFindings([{ kind: "email", start: 10, end: 20 }, { kind: "person_name", start: 5, end: 12 }, { kind: "phone", start: 40, end: 50 }, { kind: "email", start: 20, end: 25 }, { kind: "ip_address", start: 3, end: 3 }]);
    expect(merged).toEqual([{ kind: "person_name", start: 5, end: 25 }, { kind: "phone", start: 40, end: 50 }]);
    expect(redactPii("abc", [{ kind: "email", start: 10, end: 20 }])).toBe("abc");
  });
  it("has a fixed placeholder for every kind", () => {
    for (const kind of PII_KINDS) expect(piiPlaceholder(kind)).toMatch(/^\[REDACTED:[A-Z_]+\]$/u);
  });
});

describe("the scanner interface", () => {
  it("combines scanners: the union of what each finds, with each one's id", async () => {
    const fixed: PiiScanner = { id: "fixed", scan: (text) => (text.includes("zzz") ? [{ kind: "person_name", start: text.indexOf("zzz"), end: text.indexOf("zzz") + 3 }] : []) };
    const both = combinePiiScanners([builtinPiiScanner, fixed]);
    expect(both.id).toBe("builtin-1+fixed");
    const text = "pat.quill@fakemail-sample.io and zzz";
    expect((await both.scan(text)).map((finding) => finding.kind)).toEqual(["email", "person_name"]);
  });
  it("lets a scanner that fails fail the whole scan, never a clean result", async () => {
    const broken: PiiScanner = { id: "broken", scan: () => Promise.reject(new Error("down")) };
    await expect(combinePiiScanners([builtinPiiScanner, broken]).scan("x")).rejects.toThrow("down");
  });
  it("refuses a text over its size limit rather than reading half of it", () => {
    expect(() => scan("x".repeat(PII_SCAN_MAX_CHARS + 1))).toThrow(PiiScanInputTooLarge);
  });
  it("never returns the text it found", () => {
    const text = "write to pat.quill@fakemail-sample.io";
    expect(JSON.stringify(scan(text))).not.toContain("quill");
  });
});
