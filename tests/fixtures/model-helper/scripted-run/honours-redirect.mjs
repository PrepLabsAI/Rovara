// TE-F2 part B fixture for F1-g (the staging canary and the Linux check): a tiny client that HONOURS its redirect. It reads OPENAI_BASE_URL and OPENAI_API_KEY (the dummy key), asks "hello", and prints the scripted answer.
// Exit 0 and the text "Hello from the scripted reply." mean the helper answered. No SDK: Node's own fetch (plain http base URL).
const base = process.env.OPENAI_BASE_URL ?? "";
const response = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
  body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello there" }] }),
});
const body = await response.json();
console.log(body.choices?.[0]?.message?.content ?? `status ${String(response.status)}`);
process.exit(response.status === 200 ? 0 : 1);
