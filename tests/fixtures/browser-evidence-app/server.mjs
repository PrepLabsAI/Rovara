// A tiny web app for the browser-evidence tests: the "project's own start command" is `node ../server.mjs` run in before/ or after/ (the base code and the candidate).
// It serves ./page.html at / and /checkout, two pages that differ only inside masked content, a page that differs only in an email in its text, /health, and 404 for anything else.
// No dependency, no outside call. PORT comes from the environment.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const page = readFileSync("page.html", "utf8");
const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;margin:24px;background:#fff;color:#111}.box{width:600px;height:120px;background:#3a7;color:#fff;padding:8px}</style></head><body>${body}</body></html>`;
const routes = {
  "/": page,
  "/checkout": page,
  "/health": "ok",
  "/masked-a": shell(`<h1>Account</h1><div class="box" data-private>Customer Ada Lovelace, IBAN GB82WEST12345698765432</div><input type="password" value="hunter2-a">`),
  "/masked-b": shell(`<h1>Account</h1><div class="box" data-private>Customer Grace Hopper, card on file, balance 1,024.00</div><input type="password" value="another-b">`),
  "/email-a": shell(`<h1>Profile</h1><p>Signed in as ada@example.com</p>`),
  "/email-b": shell(`<h1>Profile</h1><p>Signed in as grace@example.org</p>`),
  // Re-rendered after load on every frame, inside an open shadow root, inside a same-origin frame: each pair must give the same masked picture.
  "/late-a": shell(`<h1>Profile</h1><p id="who">loading</p><script>const tick = () => { document.getElementById("who").textContent = "Signed in as ada@example.com"; requestAnimationFrame(tick); }; tick(); setInterval(tick, 5);</script>`),
  "/late-b": shell(`<h1>Profile</h1><p id="who">loading</p><script>const tick = () => { document.getElementById("who").textContent = "Signed in as grace@example.org"; requestAnimationFrame(tick); }; tick(); setInterval(tick, 5);</script>`),
  "/shadow-a": shell(`<h1>Profile</h1><x-card></x-card><script>customElements.define("x-card", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>Signed in as ada@example.com</p>"; } });</script>`),
  "/shadow-b": shell(`<h1>Profile</h1><x-card></x-card><script>customElements.define("x-card", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>Signed in as grace@example.org</p>"; } });</script>`),
  "/frame-a": shell(`<h1>Profile</h1><iframe srcdoc="<p>Signed in as ada@example.com</p>" style="width:600px;height:80px;border:0"></iframe>`),
  "/frame-b": shell(`<h1>Profile</h1><iframe srcdoc="<p>Signed in as grace@example.org</p>" style="width:600px;height:80px;border:0"></iframe>`),
  // A key split over two elements: no single text node matches, the joined text does, so no picture is kept.
  "/split": shell(`<h1>Keys</h1><p>Your key <span>sk_live_</span><span>abcdefghijklmnopqrstuv</span></p>`),
  // A page whose own script never yields after load.
  "/busy": shell(`<h1>Busy</h1><script>setTimeout(() => { for (;;) {} }, 0);</script>`),
};
createServer((request, response) => {
  const body = routes[new URL(request.url ?? "/", "http://localhost").pathname];
  if (body === undefined) { response.writeHead(404, { "content-type": "text/plain" }); response.end("not found"); return; }
  response.writeHead(200, { "content-type": body === "ok" ? "text/plain" : "text/html; charset=utf-8" });
  response.end(body);
}).listen(Number(process.env.PORT), "127.0.0.1");
