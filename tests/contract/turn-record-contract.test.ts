import { describe, expect, it } from "vitest";
import { redactSecrets, redactText } from "../../packages/contracts/src/redaction.js";
import {
  EMPTY_TURN_OBSERVATION,
  TURN_TEXT_LIMIT,
  TurnRecordSchema,
  capText,
  redactAndCap,
  turnRecordKeys,
  type TurnRecord,
} from "../../packages/contracts/src/turns.js";
import { TURN_ARGUMENT_LIMIT, redactArguments } from "../../packages/contracts/src/turns.js";
import { AiToolTurnRecordSchema, aiToolTurnRecordKeys, isSlackTurnRecord, type AiToolTurnRecord } from "../../packages/contracts/src/turns.js";

const record: TurnRecord = {
  ...EMPTY_TURN_OBSERVATION,
  eventId: "EvTURN00001",
  subject: "T0123456789/C0123456789/1695500000.000001",
  receivedAt: "2026-09-24T10:00:00.000Z",
  requestedBy: { teamId: "T0123456789", userId: "U0123456789" },
  disposition: "answered",
  startedAt: "2026-09-24T10:00:01.000Z",
  finishedAt: "2026-09-24T10:00:03.500Z",
  durationMs: 2_500,
  requestText: "list open issues",
  responseText: "There are no open issues.",
};

describe("turn record contract", () => {
  it("accepts a minimal record and refuses unknown fields", () => {
    expect(TurnRecordSchema.parse(record)).toEqual(record);
    expect(TurnRecordSchema.safeParse({ ...record, secret: "x" }).success).toBe(false);
  });

  it("refuses text over the limit and more than 50 calls", () => {
    expect(TurnRecordSchema.safeParse({ ...record, requestText: "a".repeat(TURN_TEXT_LIMIT + 1) }).success).toBe(false);
    const call = { name: "agentx_submit_task", arguments: "{}", argumentsFingerprint: "a".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 1 };
    expect(TurnRecordSchema.safeParse({ ...record, calls: Array.from({ length: 51 }, () => call) }).success).toBe(false);
  });

  it("caps text and says so", () => {
    expect(capText("abc", 2)).toEqual({ text: "ab", truncated: true });
    expect(capText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("keys a record by thread and Slack receive time, expiring 30 days later", () => {
    expect(turnRecordKeys(record)).toEqual({
      pk: "THREAD#T0123456789/C0123456789/1695500000.000001",
      sk: "TURN#2026-09-24T10:00:00.000Z#EvTURN00001",
      exportPk: "TURNS",
      exportSk: "2026-09-24T10:00:00.000Z#EvTURN00001",
      expiresAt: Date.parse("2026-09-24T10:00:00.000Z") / 1000 + 30 * 86_400,
    });
  });
});

describe("secret redaction", () => {
  it.each([
    ["ghp_0123456789abcdefghijABCDEFGHIJ012345"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["xoxb-1234567890-0987654321-abcdefghijklmnop"],
    ["lin_api_0123456789abcdefghijABCDEFGHIJ"],
    ["ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AKIAABCDEFGHIJKLMNOP"],
  ])("removes the token %s from free text", (token) => {
    const redacted = redactText(`please use ${token} for this`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes bearer headers, URL user-info, token query parameters and private keys", () => {
    const text = [
      "Authorization: Bearer abc.def.ghi-12345",
      "clone https://user:hunter2@github.com/example/demo.git",
      "https://api.example.test/x?access_token=s3cr3t&page=2",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactText(text);
    for (const secret of ["abc.def.ghi-12345", "hunter2", "s3cr3t", "MIIEow"]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("page=2");
  });

  it("replaces values under credential-named keys at any depth and keeps other values", () => {
    expect(redactSecrets({ title: "Fix login", nested: { apiKey: "k", password: "p" }, list: [{ token: "t" }] }))
      .toEqual({ title: "Fix login", nested: { apiKey: "[REDACTED]", password: "[REDACTED]" }, list: [{ token: "[REDACTED]" }] });
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("close issue 12 in payments-api")).toBe("close issue 12 in payments-api");
    expect(redactText("I have a basic understanding of the bearer bonds module")).toBe("I have a basic understanding of the bearer bonds module");
  });

  it("removes a JWT from free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19hX3NpZ25hdHVyZQ";
    const redacted = redactText(`please use ${jwt} for auth`);
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes a bearer header made only of letters", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyzABCDEF";
    const redacted = redactText(text);
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes key=value and key: value secrets from free text", () => {
    expect(redactText("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactText("api_key: abc123secretvalue")).toBe("api_key: [REDACTED]");
    expect(redactText("aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY")).toBe(
      "aws_secret_access_key = [REDACTED]",
    );
  });

  it("removes credential values from pasted JSON text", () => {
    const redacted = redactText('{"apiKey":"sk-live-4242424242424242","password":"hunter2"}');
    expect(redacted).not.toContain("sk-live-4242424242424242");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"password":"[REDACTED]"');
  });

  it("removes a quoted Authorization value nested in pasted JSON", () => {
    const redacted = redactText('{"headers":{"Authorization":"Basic dXNlcjpwYXNz"}}');
    expect(redacted).not.toContain("dXNlcjpwYXNz");
    expect(redacted).toContain('"Authorization":"[REDACTED]"');
  });

  it("removes credentials from non-HTTP connection strings", () => {
    const cases: Array<[string, string]> = [
      ["postgres://admin:S3cret!@db.example.com:5432/app", "S3cret!"],
      ["redis://user:hunter2@cache.example.com:6379", "hunter2"],
      ["amqp://guest:guestpass@mq.example.com:5672/vhost", "guestpass"],
    ];
    for (const [url, secret] of cases) {
      const redacted = redactText(url);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[REDACTED]@");
    }
  });

  it("redacts any query parameter whose name contains a credential term", () => {
    const text = "https://api.example.test/oauth?client_secret=abcdef123&refresh_token=ghijkl456&ok=1";
    const redacted = redactText(text);
    expect(redacted).not.toContain("abcdef123");
    expect(redacted).not.toContain("ghijkl456");
    expect(redacted).toContain("ok=1");
  });

  it("redacts an AWS-style signed-URL signature parameter", () => {
    const text = "https://bucket.s3.amazonaws.com/key?X-Amz-Signature=deadbeefcafef00d&X-Amz-Expires=900";
    const redacted = redactText(text);
    expect(redacted).not.toContain("deadbeefcafef00d");
    expect(redacted).toContain("X-Amz-Expires=900");
  });

  it("redacts passphrase, pwd, cookie and auth object keys", () => {
    expect(redactSecrets({ passphrase: "a", pwd: "b", cookie: "c", auth: "d", note: "keep" })).toEqual({
      passphrase: "[REDACTED]",
      pwd: "[REDACTED]",
      cookie: "[REDACTED]",
      auth: "[REDACTED]",
      note: "keep",
    });
  });

  it("does not redact token-count fields, only real credentials (over-redaction)", () => {
    expect(redactSecrets({ tokenCount: 5, max_tokens: 100, input_tokens: 50, apiKey: "k" })).toEqual({
      tokenCount: 5,
      max_tokens: 100,
      input_tokens: 50,
      apiKey: "[REDACTED]",
    });
  });

  it("redacts a truncated private key with no END line to the end of the text", () => {
    const secret = "MIIEowIBAAKCAQEAsomeverylongbase64";
    const redacted = redactText(`-----BEGIN RSA PRIVATE KEY-----\n${secret}`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  it("stops a truncated private key redaction at a blank line", () => {
    const redacted = redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIEowmore\n\nplease also see the report");
    expect(redacted).not.toContain("MIIEowmore");
    expect(redacted).toContain("please also see the report");
  });

  it.each([
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN"],
    ["sk-live-4242424242424242424242424242"],
  ])("removes the API key %s from free text", (token) => {
    const redacted = redactText(`use ${token} please`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes a Slack webhook URL", () => {
    const url = "https://hooks.slack.com/services/T0123456789/B0123456789/abcdefghijklmnopqrstuvwx";
    const redacted = redactText(`post to ${url} now`);
    expect(redacted).not.toContain(url);
    expect(redacted).toContain("[REDACTED]");
  });

  it("catches vendor tokens glued to an underscore or another word", () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    expect(redactText(`x_${token}`)).not.toContain(token);
    expect(redactText(`token${token}`)).not.toContain(token);
  });

  it("does not flag ordinary prose that merely contains the words bearer or basic", () => {
    expect(redactText("Basic auth-examples of the flow")).toBe("Basic auth-examples of the flow");
  });
});

describe("capText and redactAndCap", () => {
  it("does not split a surrogate pair when capping", () => {
    const text = "hi\u{1F600}!";
    expect(capText(text, 3)).toEqual({ text: "hi", truncated: true });
  });

  it("redacts before capping so a truncated secret cannot leak", () => {
    const secret = `ghp_${"a".repeat(40)}`;
    const text = `please use ${secret} now`;
    const limit = 20;

    const capThenRedact = redactText(capText(text, limit).text);
    expect(capThenRedact).toBe("please use ghp_aaaaa");

    const result = redactAndCap(text, limit);
    expect(result.text).not.toContain("aaaaa");
  });
});

describe("secret redaction, fix round 2", () => {
  const expectRedacted = (input: string, secret: string) => {
    const out = redactText(input);
    expect(out, `${input} -> ${out}`).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  };
  const expectSame = (input: string) => expect(redactText(input)).toBe(input);

  it.each([
    ["letters", "a".repeat(160_000)],
    ["token run", "token".repeat(32_000)],
    ["eyJ run", "eyJ-".repeat(40_000)],
    ["authorization then spaces", `authorization:${" ".repeat(159_986)}`],
    ["scheme-like run", "a+".repeat(80_000)],
    ["query token run", `?${"token".repeat(31_999)}`],
    ["user-info run", `a://b:${"c".repeat(159_994)}`],
    ["repeated user-info", "a://b:".repeat(26_666)],
    ["password= run", "password=".repeat(17_777)],
    ["bearer then letters", `bearer ${"a".repeat(159_993)}`],
    ["private key headers", "-----BEGIN PRIVATE KEY-----".repeat(5_925)],
    ["mixed", "Authorization: Bearer abc123 password=x postgres://u:p@h ?token=1 eyJabcdefghij.eyJabcdefghij.abcdefghij ".repeat(1_600)],
  ])("redacts 160,000 characters of %s in linear time", (_name, input) => {
    const started = performance.now();
    redactText(input);
    const elapsed = performance.now() - started;
    console.log(`redactText ${_name} (${input.length} chars): ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it("bounds the work redactAndCap does on a very long input", () => {
    const input = "a".repeat(1_000_000);
    const started = performance.now();
    const result = redactAndCap(input, TURN_TEXT_LIMIT);
    const elapsed = performance.now() - started;
    console.log(`redactAndCap 1,000,000 chars: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(TURN_TEXT_LIMIT);
  });

  it("drops a partial token at the redaction ceiling so a straddling secret cannot leak a prefix", () => {
    const limit = 100;
    // The long password value shrinks to a marker, so text near the 4x ceiling survives the cap.
    const lead = `password=${"v".repeat(300)} `;
    for (let pad = 0; pad < 60; pad += 1) {
      const head = lead + "x".repeat(pad) + " ";
      const token = `ghp_${"0123456789".repeat(4)}`;
      const dsn = "postgres://user:hunter2secretpw@db/app";
      for (const secret of [token, dsn]) {
        const result = redactAndCap(`${head}${secret} tail`, limit);
        expect(result.text).not.toMatch(/ghp_|hunter2|01234/);
        expect(result.text.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("redacts any value under a credential key, not only strings", () => {
    expect(redactSecrets({ password: 123456, list: { secret: { value: "hunter2" } }, Authorization: ["Bearer abc"], apiKey: ["k"] })).toEqual({
      password: "[REDACTED]",
      list: { secret: "[REDACTED]" },
      Authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
    expect(redactSecrets({ tokenCount: 5, maxTokens: 9, token_count: 3, output_tokens: 7, usage: { input_tokens: 1 } })).toEqual({
      tokenCount: 5,
      maxTokens: 9,
      token_count: 3,
      output_tokens: 7,
      usage: { input_tokens: 1 },
    });
  });

  it("does not treat words ending in sk- as API keys", () => {
    for (const text of ["task-management system", "risk-assessment framework", "desk-reservation-tool", "whisk-together-eggs"]) expectSame(text);
    expectRedacted("use sk-abcdefghijklmnop now", "abcdefghijklmnop");
  });

  it.each([
    ['{"password":"ab\\"cdefghXYZ"}', "cdefghXYZ"],
    ["password='hunter two words'", "two"],
    ["password: 'correct horse battery'", "horse"],
    ["client_secret: 's3cr3t value'", "value"],
    ["Cookie: session=abc123xyz; csrftoken=def456uvw", "abc123xyz"],
    ["Cookie: session=abc123xyz; csrftoken=def456uvw", "def456uvw"],
    ["Cookie: a=1; sessionid=zzzsecretzzz", "zzzsecretzzz"],
    ["redis://:pa55word@cache:6379/0", "pa55word"],
    ["postgres://user:ab/cdEFGH@db/app", "cdEFGH"],
    ["postgres://user:p@ssW0rdQ@db/app", "ssW0rdQ"],
    ["Authorization: Bearer abcdefg", "abcdefg"],
  ])("closes the leak in %s", (input, secret) => expectRedacted(input, secret));

  it("keeps the host of a connection string whose password has / or @", () => {
    expect(redactText("postgres://user:p@ssW0rdQ@db/app")).toBe("postgres://[REDACTED]@db/app");
    expect(redactText("postgres://user:ab/cdEFGH@db/app")).toBe("postgres://[REDACTED]@db/app");
    expect(redactText("https://user:pw@host.example/path?email=a@b.com")).toBe("https://[REDACTED]@host.example/path?email=a@b.com");
  });

  it.each([
    ["passwd=hunter2abc", "hunter2abc"],
    ["pass=hunter2abc", "hunter2abc"],
    ["DB_PASS=hunter2abc", "hunter2abc"],
    ["PGPASSWORD=hunter2abc psql", "hunter2abc"],
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGsecret\n-----END PGP PRIVATE KEY BLOCK-----", "lQOYBGsecret"],
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGsecret", "lQOYBGsecret"],
    ["https://acct.blob.core.windows.net/c?sv=2020&sig=AbCdEf%2Bsecret", "AbCdEf"],
    ["https://x.com/cb?code=oauthcode123&state=x", "oauthcode123"],
    ["glpat-abcdefghijklmnopqrst", "abcdefghijklmnopqrst"],
    ["AIzaSyA-abcdefghijklmnopqrstuvwxyz12345", "abcdefghijklmnopqrstuvwxyz"],
    ["curl -u admin:S3cretPw https://x", "S3cretPw"],
    ["curl --user admin:S3cretPw https://x", "S3cretPw"],
    ["bearer: abc123def456", "abc123def456"],
  ])("redacts the new shape %s", (input, secret) => expectRedacted(input, secret));

  it.each([
    "https://example.com/?keyword=shoes",
    "https://example.com/?monkey=1",
    "https://example.com/?zip_code=12345&promo_code=SPRING",
    "the author: Jane Doe",
    "authors: Alice, Bob",
    "authority: the court",
    "tokenizer: cl100k",
    "tokenUsage: high",
    "secretary: Bob",
    "cookieConsent: yes",
    "compass=north",
    "Basic internationalization",
    "bearer instrumentalities",
    "Secret Santa: Bob",
    "keyboard=qwerty",
    "set max_tokens=4096",
    "see redis://cache:6379",
    "ssh://git@github.com/org/repo",
    "https://host.example:8080/path?email=a@b.com",
  ])("leaves the look-alike %s alone", (text) => expectSame(text));

  it("does not redact look-alike object keys", () => {
    const value = { author: "Jane", authors: ["A"], authority: "court", tokenizer: "cl100k", tokenUsage: "high", secretary: "Bob", cookieConsent: "yes", keyboard: "qwerty" };
    expect(redactSecrets(value)).toEqual(value);
  });

  it("redactArguments redacts the parsed object and returns capped JSON", () => {
    const args = { query: "x", headers: { Authorization: 'Basic "quoted" dXNlcjpwYXNz' }, cfg: 'password="abc def"', password: 42 };
    const json = redactArguments(args);
    expect(JSON.parse(json)).toEqual({ query: "x", headers: { Authorization: "[REDACTED]" }, cfg: 'password="[REDACTED]"', password: "[REDACTED]" });
    for (const secret of ["dXNlcjpwYXNz", "abc def", "42"]) expect(json).not.toContain(secret);

    const long = redactArguments({ body: "b".repeat(5_000) });
    expect(long.length).toBeLessThanOrEqual(TURN_ARGUMENT_LIMIT);
    expect(long.startsWith('{"body":"bbb')).toBe(true);
    expect(redactArguments({ a: "abcdef" }, 5)).toBe('{"a":');
  });
});

describe("secret redaction, fix round 3", () => {
  const leaks = (input: string, secret: string) => {
    const out = redactText(input);
    expect(out, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`).not.toContain(secret);
  };

  it.each([
    ["DB_PASSWORD_PROD=hunter2abc", "hunter2abc"],
    ["SECRET_KEY_BASE=abcdef0123456789abcdef", "abcdef0123456789"],
    ["API_KEY_PRODUCTION=hunter2abc", "hunter2abc"],
    ["client_secret_value=hunter2abc", "hunter2abc"],
    ["secret_token_value=hunter2abc", "hunter2abc"],
    ["password_confirmation: hunter2abc", "hunter2abc"],
    ["passwordConfirm=hunter2abc", "hunter2abc"],
    ["session_id=hunter2abcsess", "hunter2abcsess"],
    ["A_VERY_LONG_ENVIRONMENT_VARIABLE_PREFIX_FOR_SOME_SERVICE_INTEGRATION_PASSWORD=hunter2abc", "hunter2abc"],
    ["app.integrations.salesforce.production.oauth2.client.credentials.secret=hunter2abc", "hunter2abc"],
  ])("redacts the suffixed credential name %s", leaks);

  it("redacts suffixed credential object keys and keeps metadata keys", () => {
    expect(redactSecrets({ DB_PASSWORD_PROD: "hunter2abc", passwordConfirmation: "hunter2abc", secretKeyBase: "abc123", AccountKey: "abc123+/==", SharedAccessKey: "abc" })).toEqual({
      DB_PASSWORD_PROD: "[REDACTED]",
      passwordConfirmation: "[REDACTED]",
      secretKeyBase: "[REDACTED]",
      AccountKey: "[REDACTED]",
      SharedAccessKey: "[REDACTED]",
    });
    const metadata = { accessTokenExpiry: "2026-10-01", tokenType: "bearer", secretName: "prod/db", passwordPolicy: "12 chars", passwordResetUrl: "https://x", tokenizer: "bpe", SharedAccessKeyName: "Root", api_key_id: "AKID" };
    expect(redactSecrets(metadata)).toEqual(metadata);
  });

  it.each([
    ["password         = hunter2abc", "hunter2abc"],
    ["password\t\t\t\t\t\t\t\t\t= hunter2abc", "hunter2abc"],
    ["password         : hunter2abc", "hunter2abc"],
    ["password:\n  hunter2abcdef\n", "hunter2abcdef"],
    ["Authorization:\n  Bearer abcdefghijk123", "abcdefghijk123"],
    ["password: |\n  hunter2abcdef\n  second line\n", "hunter2abcdef"],
    ["password: |\n  hunter2abcdef\n  second line\n", "second line"],
    ["password: >-\n  hunter2abcdef\n", "hunter2abcdef"],
    ["Bearer abcdefghijklmnopqrstuvwxyzABCDEF", "abcdefghijklmnopqrstuvwxyz"],
    ["bearer: abcdefghijklmnop", "abcdefghijklmnop"],
    ["Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["curl -H 'X-Custom: Basic dXNlcjpwYXNz' https://x", "dXNlcjpwYXNz"],
    ['{"auth_header":"Basic dXNlcjpwYXNz"}', "dXNlcjpwYXNz"],
    ["https://dXNlcjpwYXNz@example.com/x", "dXNlcjpwYXNz"],
    ["'password' => 'hunter2abc',", "hunter2abc"],
    [":password => \"hunter2abc\"", "hunter2abc"],
    ['password := "hunter2abc"', "hunter2abc"],
  ])("closes the regression %s", leaks);

  it("keeps the structure around => and := separators", () => {
    expect(redactText("'password' => 'hunter2abc',")).toBe("'password' => '[REDACTED]',");
    expect(redactText('password := "hunter2abc"')).toBe('password := "[REDACTED]"');
  });

  it.each([
    ["use sk_live_51Habcdefghijklmnopqrstuvwxyz0123 for stripe", "51Habcdefghijklmno"],
    ["rk_live_51Habcdefghijklmnopqrstuvwxyz0123", "51Habcdefghijklmno"],
    ["sk_test_51Habcdefghijklmnopqrstuvwxyz0123", "51Habcdefghijklmno"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123"],
    ["SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["hf_abcdefghijklmnopqrstuvwxyz0123456", "abcdefghijklmnopqrstuvwxyz"],
    ["xoxe-1-abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123"],
    ["here is the session token FwoGZXIvYXdzEBYaDHqa0AP1nvGbGbRSHyKsARabcdefghijk", "FwoGZXIvYXdzEBYa"],
    ["IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQ", "IQoJb3JpZ2luX2Vj"],
    ["twilio SK0123456789abcdef0123456789abcdef auth 0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
    ["DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcDEF123+/xyz==;EndpointSuffix=core.windows.net", "abcDEF123"],
    ["Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=abcDEF123+/xyz=", "abcDEF123"],
    ["<password>hunter2abc</password>", "hunter2abc"],
    ['<add key="ApiKey" value="hunter2abc"/>', "hunter2abc"],
    ["<add name='DbPassword' value='hunter2abc' />", "hunter2abc"],
    ["mysql -uroot -phunter2abc db", "hunter2abc"],
    ["mysql -u root -p hunter2abc db", "hunter2abc"],
    ["psql --password hunter2abc", "hunter2abc"],
    ["docker login -u me -p hunter2abc", "hunter2abc"],
    ["gh auth login --token abcdef123456", "abcdef123456"],
    ["tool --api-key=abcdef123456", "abcdef123456"],
    ["redis-cli -a hunter2abc ping", "hunter2abc"],
    ["password=abc,hunter2tail", "hunter2tail"],
    ["password=abc&hunter2tail", "hunter2tail"],
    ["password=abc}hunter2tail", "hunter2tail"],
    ["password=correct horse", "horse"],
    ["-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB12\n\nMIIEpAIBAAKCAQEAsecretbody\n", "MIIEpAIBAAKCAQEAsecretbody"],
    ['{"password ":"hunter2abc"}', "hunter2abc"],
    ['"{\\\\\\"password\\\\\\":\\\\\\"hunter2abc\\\\\\"}"', "hunter2abc"],
    ["postgres://user:pa?ss1word@db.example.com/x", "ss1word"],
    ["postgres://user:pa#ss1word@db.example.com/x", "ss1word"],
    ["postgres://user:pass word@db.example.com/x", "word"],
    ["user:hunter2abc@db.example.com:5432", "hunter2abc"],
    ["| password | hunter2abc |", "hunter2abc"],
    ["password: `hunter2abc`", "hunter2abc"],
    ["Cookie:\tsid=zzzsecretzzz", "zzzsecretzzz"],
  ])("redacts the new shape %s", leaks);

  it("keeps URL context values separate and a host after a query @", () => {
    expect(redactText("https://x.test/a?token=abc&page=2")).toBe("https://x.test/a?token=[REDACTED]&page=2");
    expect(redactText("https://user:pw@host.example/path?email=a@b.com")).toBe("https://[REDACTED]@host.example/path?email=a@b.com");
  });

  it.each([
    "the task-management board", "keyword=foo&monkey=bar", "author: Jane", "authority: FAA", "tokenizer: bpe", "tokenUsage: 12",
    "secretary: Bob", "cookieConsent: yes", "a basic understanding of bearer bonds", "max_tokens=1024", "input_tokens: 512",
    "compass: north", "bypass: true", "risk-adjusted returns", "ask-me-anything-thread", "https://github.com/org/repo/blob/main/src/auth.ts",
    "promo_code=SAVE10", "zip_code=94107", "passage: the book", "passport: US", "pwdless", "keyboard=us",
    "Our ARR grew; see https://example.com/report?quarter=q3&id=12", "sk-learn-is-not-a-thing", "token budget: 4000", "tokens: 4000",
    "the secret sauce: great people", "Bearer bonds 2024 issue", "basic 101 course", "user@example.com:8080", "https://example.com:8443/path",
    "ssh git@github.com:org/repo.git", "https://user@example.com/path", "mailto:a@b.com", "http://localhost:3000/api@v2",
    "docker run -p 8080:80 nginx", "psql -h db -p 5432 app", "cat password | grep x", "tokenExpiry: 3600", "password_policy: strict",
  ])("leaves %s alone", (text) => expect(redactText(text)).toBe(text));

  it("redactArguments redacts name/value pairs, header tuples and argv arrays", () => {
    const cases: Array<[unknown, string]> = [
      [{ env: [{ name: "DB_PASSWORD", value: "hunter2abc" }] }, "hunter2abc"],
      [{ headers: [{ name: "Authorization", value: "Basic dXNlcjpwYXNz" }] }, "dXNlcjpwYXNz"],
      [{ headers: [["Authorization", "Bearer abcdefghijk123"]] }, "abcdefghijk123"],
      [{ args: ["--password", "hunter2abc"] }, "hunter2abc"],
      [{ args: ["mysql", "-p", "hunter2abc"] }, "hunter2abc"],
      [{ "password ": "hunter2abc" }, "hunter2abc"],
      [{ tokens: { ghp_abcdefghijklmnopqrstuvwxyz0123: 1 } }, "abcdefghijklmnop"],
      [{ AccountKey: "abc123+/==" }, "abc123"],
    ];
    for (const [value, secret] of cases) expect(redactArguments(value), JSON.stringify(value)).not.toContain(secret);
    expect(JSON.parse(redactArguments({ env: [{ name: "REGION", value: "us-east-1" }], args: ["docker", "run", "-p", "8080:80"] }))).toEqual({
      env: [{ name: "REGION", value: "us-east-1" }],
      args: ["docker", "run", "-p", "8080:80"],
    });
  });

  it("redactArguments returns a fixed marker instead of throwing on unserializable values", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(redactArguments(circular)).toBe("[unrecordable arguments]");
    let deep: unknown = "x";
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(redactArguments(deep)).toBe("[unrecordable arguments]");
  });

  it("redactArguments scales linearly for a long argv array and many keys", () => {
    const inputs = (scale: number) => [
      Array.from({ length: 25_000 * scale }, () => "-p"),
      Object.fromEntries(Array.from({ length: 10_000 * scale }, (_, i) => [`key${i}`, `password=x${i}`])),
    ] as const;
    const small = inputs(1);
    const large = inputs(2);
    const duration = (input: ReturnType<typeof inputs>) => {
      const started = performance.now();
      for (const value of input) redactArguments(value);
      return performance.now() - started;
    };

    // Warm JIT paths before measuring, then alternate order so either input can encounter a pause.
    duration(small);
    duration(large);
    const ratios = Array.from({ length: 5 }, (_, index) => {
      let smallDuration: number;
      let largeDuration: number;
      if (index % 2 === 0) {
        smallDuration = duration(small);
        largeDuration = duration(large);
      } else {
        largeDuration = duration(large);
        smallDuration = duration(small);
      }
      return largeDuration / Math.max(smallDuration, 0.1);
    }).sort((left, right) => left - right);
    const medianRatio = ratios[Math.floor(ratios.length / 2)]!;
    console.log(`redactArguments median 2N/N ratio: ${medianRatio.toFixed(2)} (${ratios.map((ratio) => ratio.toFixed(2)).join(", ")})`);
    expect(medianRatio).toBeLessThan(3.25);
  });

  it("redactAndCap keeps content when the text past the ceiling has no whitespace", () => {
    const cjk = "秘密のない普通の文章です。".repeat(2_000);
    const result = redactAndCap(cjk, 1_000);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(1_000);
    const b64 = `${"QUJD".repeat(50)},${"QUJD".repeat(300)}`;
    expect(redactAndCap(b64, 100).text.length).toBe(100);
  });

  it.each([
    ["password: newline run", "password:\n".repeat(16_000)],
    ["indented block", `password: |\n${"  x\n".repeat(40_000)}`],
    ["xml tags", "<a key='x' ".repeat(14_545)],
    ["long flags", "--password ".repeat(14_545)],
    ["client flags", "mysql -p ".repeat(17_777)],
    ["basic base64", "Basic QUJD ".repeat(14_545)],
    ["sk dashes", "sk-".repeat(53_333)],
    ["bare user-info", "user:pass@".repeat(16_000)],
    ["colon runs", "a:".repeat(80_000)],
    ["keys then spaces", `password${" ".repeat(159_990)}`],
  ])("redacts 160,000 characters of %s in linear time", (name, input) => {
    const started = performance.now();
    redactText(input);
    const elapsed = performance.now() - started;
    console.log(`redactText ${name} (${input.length} chars): ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("AI-tool turn records (spec 025 FR-037)", () => {
  const aiRecord: AiToolTurnRecord = {
    origin: "ai_tool",
    taskId: "44444444-4444-4444-8444-444444444444",
    turnId: "55555555-5555-4555-8555-555555555555",
    action: "start",
    phase: "accepted",
    developer: { developerId: "d".repeat(64), provider: "slack", displayName: "Maya Chen", slackUserId: "U0MAYA001" },
    client: "Claude Code",
    receivedAt: "2026-09-27T12:00:00.000Z",
    project: "payments",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    outcome: "accepted",
    startedAt: "2026-09-27T12:00:00.000Z",
    finishedAt: "2026-09-27T12:00:00.200Z",
    durationMs: 200,
    requestText: "Fix the flaky retry test",
    responseText: "STARTING",
  };

  it("round-trips, with no Slack event ID or Slack requester", () => {
    expect(AiToolTurnRecordSchema.parse(aiRecord)).toEqual(aiRecord);
    expect(AiToolTurnRecordSchema.safeParse({ ...aiRecord, eventId: "EvX1234" }).success).toBe(false);
  });

  it("is keyed by task and exported on the same time index, kept 30 days", () => {
    expect(aiToolTurnRecordKeys(aiRecord)).toEqual({
      pk: "TASK#44444444-4444-4444-8444-444444444444",
      sk: "TURN#2026-09-27T12:00:00.000Z#55555555-5555-4555-8555-555555555555",
      exportPk: "TURNS",
      exportSk: "2026-09-27T12:00:00.000Z#55555555-5555-4555-8555-555555555555",
      expiresAt: Math.floor(Date.parse(aiRecord.receivedAt) / 1000) + 30 * 86_400,
    });
  });

  it("still parses Slack records written before origin existed, and with origin slack", () => {
    const slack = TurnRecordSchema.parse(record);
    expect(slack).not.toHaveProperty("origin");
    expect(TurnRecordSchema.parse({ ...slack, origin: "slack" }).origin).toBe("slack");
    expect(TurnRecordSchema.safeParse({ ...slack, origin: "ai_tool" }).success).toBe(false);
  });

  it("round-trips a completed record carrying the result summary as response text (owner decision 3)", () => {
    const completed: AiToolTurnRecord = {
      ...aiRecord,
      phase: "completed",
      outcome: "succeeded",
      responseText: "Fixed the flaky retry test and opened a pull request.",
    };
    expect(AiToolTurnRecordSchema.parse(completed)).toEqual(completed);
  });

  it("round-trips a refused record with an error code (owner decision 3)", () => {
    const refused: AiToolTurnRecord = {
      ...aiRecord,
      phase: "refused",
      outcome: "refused",
      responseText: "The project's developer task limit is reached.",
      error: { code: "WORKSPACE_LIMIT" },
    };
    expect(AiToolTurnRecordSchema.parse(refused)).toEqual(refused);
  });

  it("isSlackTurnRecord is false for an AI-tool record and true for a Slack record with or without origin", () => {
    expect(isSlackTurnRecord(aiRecord)).toBe(false);
    const slack = TurnRecordSchema.parse(record);
    expect(slack).not.toHaveProperty("origin");
    expect(isSlackTurnRecord(slack)).toBe(true);
    expect(isSlackTurnRecord({ ...slack, origin: "slack" })).toBe(true);
  });
});

// Fix round 1 (review of spec 025 phase 25b, Task 4): TEXT_PATTERNS did not cover AgentX's own
// minted tokens (packages/broker/src/developer/tokens.ts: randomToken("agxr_" | "agxc_")), so a
// leaked refresh token or authorization code in free text was not redacted.
describe("secret redaction, fix round 4 (AgentX's own tokens)", () => {
  it.each([
    [`agxr_${"A".repeat(43)}`],
    [`agxc_${"B".repeat(43)}`],
  ])("removes the AgentX token %s from free text", (token) => {
    const redacted = redactText(`please use ${token} for this`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  it("does not overmatch the bare prefix in ordinary prose", () => {
    expect(redactText("the agxr_ prefix marks a refresh token, agxc_ an authorization code")).toBe(
      "the agxr_ prefix marks a refresh token, agxc_ an authorization code",
    );
  });
});
