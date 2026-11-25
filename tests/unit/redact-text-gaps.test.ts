// REDACT-BLOCK-REASON scope 3: the shapes redactText used to leave alone (payment webhook secrets, Notion, Vercel and DigitalOcean tokens, monitoring DSNs, signature values outside a query, Digest headers, a
// bare password in prose, an AWS secret key in prose). Each shape has positive cases (the value is gone, and a second pass changes nothing) and negative cases (ordinary prose and code are returned as they were).
import { describe, expect, it } from "vitest";
import { redactText } from "../../packages/contracts/src/redaction.js";

// Every secret-shaped value is built at run time: no key-shaped literal is in this file.
const alnum = (length: number, seed = 0): string => Array.from({ length }, (_, i) => "AbCdEfGh1j2K3m4N5p6Q7r8S9tUvWxYz"[(i * 7 + seed) % 32]).join("");
const hex = (length: number): string => "9f3a5c7e".repeat(Math.ceil(length / 8)).slice(0, length);

function leaks(input: string, secret: string): void {
  const once = redactText(input);
  expect(once, input).not.toContain(secret);
  expect(once, input).toContain("[REDACTED]");
  expect(redactText(once), `${input} (second pass)`).toBe(once);
}

function kept(input: string): void {
  expect(redactText(input), input).toBe(input);
}

describe("redactText: provider tokens with a prefix", () => {
  it("masks a payment provider's webhook signing secret", () => {
    const secret = `whsec_${alnum(32)}`;
    leaks(`Webhook signature verification failed for endpoint secret ${secret}, check the dashboard`, secret);
    leaks(`STRIPE ${secret}`, secret);
  });
  it("keeps whsec_ as a bare word, a short name and a lowercase identifier", () => {
    kept("the whsec_ prefix marks a signing secret");
    kept("whsec_handler");
    kept("call whsec_handler_registered_for_every_event now");
  });

  it("masks Notion tokens (secret_ and ntn_)", () => {
    const legacy = `secret_${alnum(43)}`;
    const current = `ntn_${"1234567890"}${alnum(35, 3)}`;
    leaks(`Notion request failed: ${legacy} is not valid`, legacy);
    leaks(`using ${current}`, current);
  });
  it("keeps secret_ names, ntn_ words and long snake_case that only starts with secret_", () => {
    kept("read secret_key from the vault");
    kept("secret_manager_client_initialisation_complete_for_the_service");
    kept("the ntn_value column");
    kept("call secret_value_loader(config)");
  });

  it("masks Vercel tokens (vcp_ and vercel_)", () => {
    const access = `vcp_${alnum(40)}`;
    const blob = `vercel_blob_rw_${alnum(14)}_${alnum(40, 5)}`;
    leaks(`vercel deploy --token failed with ${access}`, access);
    leaks(`BLOB read-write ${blob}`, blob);
  });
  it("keeps vercel_ and vcp_ names that are not random", () => {
    kept("vercel_deployment_environment_variable_name");
    kept("set vercel_url in the config");
    kept("vcp_short");
  });

  it("masks DigitalOcean tokens (dop_v1_, doo_v1_, dor_v1_)", () => {
    for (const prefix of ["dop", "doo", "dor"]) {
      const secret = `${prefix}_v1_${hex(64)}`;
      leaks(`doctl auth failed for ${secret}`, secret);
    }
  });
  it("keeps the DigitalOcean prefix without a token", () => {
    kept("tokens start with dop_v1_ and a hex string");
    kept("dop_v1_notahexvalue");
  });
});

describe("redactText: monitoring DSNs", () => {
  it("masks the public key of a DSN with a numeric project id", () => {
    const key = hex(32);
    leaks(`Sentry init failed: https://${key}@o123456.ingest.sentry.io/4506789`, key);
    leaks(`DSN=https://${alnum(24)}@sentry.example.com:9000/2`, alnum(24));
  });
  it("keeps ordinary user-info URLs and git remotes", () => {
    kept("clone https://git@github.com/org/repo");
    kept("see https://user@example.com/123");
    kept(`open https://${hex(32)}@example.com/docs/page`);
    kept("mail me at name@example.com or visit https://example.com/4506789");
  });
});

describe("redactText: signature values outside a query string", () => {
  it("masks a bare x-amz-signature and the header echo", () => {
    const signature = hex(64);
    leaks(`x-amz-signature=${signature}`, signature);
    leaks(`{"X-Amz-Signature": "${signature}"}`, signature);
    leaks(`headers X-Amz-Security-Token: ${alnum(60)}`, alnum(60));
    leaks(`X-Amz-Credential=AKIAEXAMPLE/20261125/us-east-1/s3/aws4_request`, "AKIAEXAMPLE/20261125");
  });
  it("masks a long sig= or signature= value without a ? or &", () => {
    const signature = alnum(44);
    leaks(`got sig=${signature} from the sas url`, signature);
    leaks(`signature=${hex(64)}`, hex(64));
  });
  it("still masks the query-string forms and keeps short values and the words", () => {
    leaks(`https://x.test/o?X-Amz-Signature=${hex(64)}&X-Amz-Expires=60`, hex(64));
    kept("signature=ok");
    kept("sig=3");
    kept("the x-amz-signature header is missing");
    kept("signature verification failed");
  });
});

describe("redactText: Digest authentication", () => {
  it("masks the parameters of a Digest challenge and response", () => {
    leaks(`WWW-Authenticate: Digest realm="api", nonce="${hex(32)}", qop="auth"`, hex(32));
    leaks(`Proxy-Authenticate: Digest realm="proxy", nonce="${hex(32)}", opaque="${hex(16)}"`, hex(32));
    leaks(`Digest username="svc", realm="api", response="${hex(32)}", cnonce="${hex(16)}"`, hex(32));
    leaks(`Authorization: Digest username="svc", response="${hex(32)}"`, hex(32));
  });
  it("keeps the word digest in prose, in an HTTP Digest header and in hash notation", () => {
    kept("the digest algorithm is sha256");
    kept("Digest authentication failed");
    kept("Digest: sha-256=abc");
    kept("compute the message digest of the file");
    kept("docker pull image@sha256:abc");
  });
});

describe("redactText: a password in prose", () => {
  it("masks the value after the word password, passwd or passphrase", () => {
    leaks("login failed, password hunter2", "hunter2");
    leaks("the password is Tr0ub4dor&3", "Tr0ub4dor&3");
    leaks("Password was Summer2026! for the admin", "Summer2026!");
    leaks("passphrase correct-horse-9 was used", "correct-horse-9");
    leaks("passwd s3cretValue", "s3cretValue");
  });
  it("keeps ordinary sentences and code that use the word", () => {
    kept("password reset requested");
    kept("the password must be at least 12 characters");
    kept("password is incorrect");
    kept("wrong password for user admin1");
    kept("password policy 2 applies");
    kept("Enter your password again");
    kept("a password manager");
    kept("password hash changed");
    kept("passwords are hashed");
    kept("cat /etc/passwd 2>/dev/null");
    kept("grep root /etc/passwd /etc/shadow");
    kept("password is [REDACTED]");
    kept("password [REDACTED]");
    kept("function readPassword() { return promptUser(); }");
    kept("password 12345");
  });
});

describe("redactText: an AWS secret key in prose", () => {
  const secret = `${alnum(20)}/${alnum(19, 4)}`;
  it("masks 40 characters after the name of the key with no separator", () => {
    expect(secret).toHaveLength(40);
    leaks(`SecretAccessKey ${secret} was printed`, secret);
    leaks(`the AWS secret key is ${secret}`, secret);
    leaks(`secret access key ${secret}`, secret);
  });
  it("keeps the words, a value of another length and a commit hash", () => {
    kept("secret key rotation is quarterly");
    kept("the secret access key was rotated yesterday");
    kept(`secret key ${alnum(39)}`);
    kept(`secret key ${alnum(41)}`);
    kept(`commit ${hex(40)} changed the secret handling`);
  });
});

describe("redactText: the new shapes stay linear on long input", () => {
  it("handles a long run of each prefix quickly", () => {
    const started = Date.now();
    for (const prefix of ["whsec_", "secret_", "ntn_", "vcp_", "vercel_", "dop_v1_", "sig=", "x-amz-signature=", "Digest ", "password ", "secret key "]) {
      redactText(prefix.repeat(5_000));
      redactText(`${prefix}${"a".repeat(100_000)}`);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
