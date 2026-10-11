// The fake browser tab the end-to-end tests use: it runs only the scripts and reads only the styles that carry the nonce
// of the response's content-security-policy, as a browser does, and its Date answers the tab's own clock.
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeStorage } from "../support/fake-dom.js";
import { openTaskPage } from "../support/page-browser.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const reader = { developerId: "d".repeat(64), name: "Maya" };

function host(html: string, csp: string | undefined) {
  return {
    db: new FakeDynamoDb(), taskId: () => TASK,
    handler: (async () => ({ statusCode: 200, body: html, headers: csp === undefined ? {} : { "content-security-policy": csp } })) as never,
  };
}
const csp = (nonce: string) => `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`;

describe("the fake browser tab", () => {
  it("runs only scripts with the nonce the content-security-policy names, and reads only styles with it", async () => {
    const html = `<html><head><style nonce="good">a{color:red}</style><style nonce="evil">b{color:blue}</style><style>c{}</style></head><body>
      <script nonce="good">sessionStorage.setItem("good", "1");</script>
      <script nonce="evil">sessionStorage.setItem("evil", "1");</script>
      <script>sessionStorage.setItem("plain", "1");</script></body></html>`;
    const storage = fakeStorage();
    const tab = await openTaskPage(host(html, csp("good")), reader, { storage });
    expect([...storage.map.keys()]).toEqual(["good"]);
    expect(tab.nonce).toBe("good");
    expect(tab.styles().map((style) => style.textContent)).toEqual(["a{color:red}"]);
  });

  it("runs no script when the response names no nonce", async () => {
    const storage = fakeStorage();
    await openTaskPage(host(`<body><script nonce="x">sessionStorage.setItem("x", "1");</script></body>`, undefined), reader, { storage });
    expect([...storage.map.keys()]).toEqual([]);
  });

  it("a Date with no arguments is the tab's virtual clock", async () => {
    const storage = fakeStorage();
    const tab = await openTaskPage(host(`<body><script nonce="n">setTimeout(function () { sessionStorage.setItem("at", String(new Date().getTime())); sessionStorage.setItem("fixed", new Date(5).toISOString()); }, 60000);</script></body>`, csp("n")), reader, { storage });
    await tab.advance(60_000);
    expect(storage.getItem("at")).toBe(String(tab.clock.now));
    expect(storage.getItem("fixed")).toBe("1970-01-01T00:00:00.005Z");
  });
});
