// A tiny web app for the browser-evidence tests: the "project's own start command" is `node ../server.mjs` run in before/ or after/ (the base code and the candidate).
// It serves ./page.html at / and /checkout, two pages that differ only inside masked content, a page that differs only in an email in its text, /health, and 404 for anything else.
// No dependency, no outside call. PORT comes from the environment.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const page = readFileSync("page.html", "utf8");
const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;margin:24px;background:#fff;color:#111}.box{width:600px;height:120px;background:#3a7;color:#fff;padding:8px}</style></head><body>${body}</body></html>`;
// Slice 4: pages that work on the base code and break on the candidate (BE_REGRESS=1 is set only for the candidate's app): one answers 500, one never yields after load.
const regress = process.env.BE_REGRESS === "1";
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
  // An avatar from another origin (aborted by the driver) whose alt text is an email: the browser paints the alt text in its place.
  "/alt-a": shell(`<h1>Profile</h1><img src="https://cdn.example.com/a.png" alt="ada@example.com" width="300" height="40">`),
  "/alt-b": shell(`<h1>Profile</h1><img src="https://cdn.example.com/a.png" alt="grace@example.org" width="300" height="40">`),
  // A sign-in page: a "Password:" label, its field and a "Forgot password?" link must not withhold the picture.
  "/signin": shell(`<h1>Sign in</h1><form><label>Email: <input type="email" value="ada@example.com"></label><br><label>Password: <input type="password" value="hunter2-x"></label><br><a href="/forgot">Forgot password?</a> <button>Sign in</button></form>`),
  // Secrets split over inline elements inside a shadow root, a labelled value in separate inline elements, and a dt/dd pair: each must be withheld.
  "/shadow-split": shell(`<h1>Keys</h1><x-keys></x-keys><script>customElements.define("x-keys", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>Your key <span>sk_live_</span><span>abcdefghijklmnopqrstuv</span>, owner <mark>ada</mark>@example.com</p>"; } });</script>`),
  "/split-label": shell(`<h1>Settings</h1><p><b>Password:</b> <code>hunter2x</code></p>`),
  "/dl-label": shell(`<h1>Settings</h1><dl><dt>API key:</dt><dd>abcd1234</dd></dl>`),
  // A labelled value with a no-break space (one text node: scrubbed in place, so the two pages look the same), a value beside a Copy button or a Show link, and a label from a component's template beside a slotted value: each must be withheld.
  "/nbsp-label": shell(`<h1>Settings</h1><p>Password:&nbsp;hunter2x</p>`),
  "/nbsp-label-b": shell(`<h1>Settings</h1><p>Password:&nbsp;swordfish9</p>`),
  "/dl-copy": shell(`<h1>Settings</h1><dl><dt>API key:</dt><dd><code>abcd1234</code> <button>Copy</button></dd></dl>`),
  "/div-show": shell(`<h1>Settings</h1><div>Password:</div><div>hunter2x <a href="#">Show</a></div>`),
  "/link-label": shell(`<h1>Settings</h1><p><a href="#"><b>Password:</b> hunter2x</a></p>`),
  "/copy-button": shell(`<h1>Settings</h1><dl><dt>API key:</dt><dd><button>abcd1234</button></dd></dl>`),
  "/dd-link": shell(`<h1>Settings</h1><dl><dt>Token:</dt><dd><a href="#">abcd1234</a></dd></dl>`),
  // Shown: a masked row ("Password: •••••••• [Change]") and years on separate lines of a <pre>.
  "/dots-row": shell(`<h1>Settings</h1><p>Password: •••••••• <button>Change</button></p>`),
  "/dots-split": shell(`<h1>Settings</h1><p><span>Password:</span> <span>••••••••</span> <button>Change</button></p>`),
  // A control between label and value, a value inside a link or button with more text, a label that is itself a link, must be withheld; an environment-style line is scrubbed in place (same picture for two values).
  "/ctrl-before": shell(`<h1>Settings</h1><p>API key: <button>Hide key</button> <code>abcd1234</code></p>`),
  "/chip-copy": shell(`<h1>Settings</h1><p>API key: <button class="copy"><code>abcd1234</code> <span>Copy</span></button></p>`),
  "/link-badge": shell(`<h1>Keys</h1><ul><li>API key: <a href="/keys/1">abcd1234 <span>prod</span></a></li></ul>`),
  "/label-link": shell(`<h1>Settings</h1><p><a href="/docs">API key</a>: <code>abcd1234</code></p>`),
  "/label-link-dt": shell(`<h1>Settings</h1><dl><dt><a href="/docs">Token</a>:</dt><dd>abcd1234</dd></dl>`),
  "/env-line": shell(`<h1>Config</h1><pre>DB_HOST=db\nDB_PASSWORD=hunter2x</pre>`),
  "/env-line-b": shell(`<h1>Config</h1><pre>DB_HOST=db\nDB_PASSWORD=swordfish9</pre>`),
  "/env-split": shell(`<h1>Config</h1><pre><span>GITHUB_TOKEN</span>=<span>ghx1234567</span></pre>`),
  "/pre-years": shell(`<h1>History</h1><pre>2019\n2020\n2021\n2022\n2023</pre>`),
  "/slot-label": shell(`<h1>Settings</h1><x-field>abcd1234</x-field><script>customElements.define("x-field", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<dl><dt>API key:</dt><dd><slot></slot></dd></dl>"; } });</script>`),
  // Sign-in forms laid out on one line: they must be shown.
  "/signin-inline": shell(`<h1>Sign in</h1><form><label>Password:</label> <input type="password" value="hunter2-y"><button>Sign in</button></form><p><label>Password: <input type="password"></label> <a href="/forgot">Forgot?</a></p>`),
  "/regress-ok": shell(`<h1>Fine</h1><p>This page works.</p>`),
  "/regress-busy": regress ? shell(`<h1>Busy</h1><script>setTimeout(() => { for (;;) {} }, 0);</script>`) : shell(`<h1>Fine</h1><p>This page works.</p>`),
  // A page whose own script never yields after load.
  "/busy": shell(`<h1>Busy</h1><script>setTimeout(() => { for (;;) {} }, 0);</script>`),
};
// Data that arrives after load (a normal app fetch), D ms late, written by the fetch's continuation: /late-fetch/<ms>/<a|b>.
const lateFetch = (d, who) => shell(`<h1>Profile</h1><p id="w">Signed in as •••</p><script>addEventListener("load", () => fetch("/slow?ms=${d}").then(() => { document.getElementById("w").textContent = "Signed in as ${who === "a" ? "ada@example.com" : "grace@example.org"}"; }));</script>`);
// Slice 3, an app behind a login: BE_USER and BE_PASS are the one account. A form post with them sets a session cookie and sends the person to /dashboard; anything else is sent back to /login. /expired never holds a session.
const account = { user: process.env.BE_USER, pass: process.env.BE_PASS };
const signedIn = (request) => account.user !== undefined && (request.headers.cookie ?? "").split(/;\s*/u).includes(`session=${encodeURIComponent(account.user)}`);
const loginPage = (note) => shell(`<h1>Sign in</h1>${note}<form method="post" action="/login"><label>Email <input id="email" name="email" type="text"></label><br><label>Password <input id="password" name="password" type="password"></label><br><button type="submit">Sign in</button></form>`);
const escapeHtml = (text) => text.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const signedPages = {
  "/dashboard": () => shell(`<h1>Dashboard</h1><p>Signed in as ${escapeHtml(account.user ?? "")}</p>`),
  "/account": () => shell(`<h1>Account</h1><p>Signed in as ${escapeHtml(account.user ?? "")}</p><div class="box">Plan: team</div>`),
  "/account-urlencoded": () => shell(`<h1>Account</h1><p>Signed in as ${encodeURIComponent(account.user ?? "")}</p><div class="box">Plan: team</div>`),
  "/profile-field": () => shell(`<h1>Profile</h1><label>Name <input id="name" type="text" value="${escapeHtml(account.user ?? "")}"></label><div class="box">Plan: team</div>`),
};
const staticPages = {
  "/account-static": shell(`<h1>Account</h1><p>Signed in as •••</p><div class="box">Plan: team</div>`),
  "/account-other": shell(`<h1>Account</h1><p>Signed in as somebody-else-1</p><div class="box">Plan: team</div>`),
  "/prefilled-a": shell(`<h1>Settings</h1><label>Email <input id="email" type="text" value="alice-visible-1"></label>`),
  "/prefilled-b": shell(`<h1>Settings</h1><label>Email <input id="email" type="text" value="bob-visible-22"></label>`),
};
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/login" && request.method === "GET") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(loginPage(url.searchParams.has("error") ? "<p>Invalid credentials</p>" : "")); return; }
  if (url.pathname === "/login" && request.method === "POST") {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const form = new URLSearchParams(text);
      const ok = account.user !== undefined && form.get("email") === account.user && form.get("password") === account.pass;
      response.writeHead(303, { location: ok ? "/dashboard" : "/login?error=1", ...(ok ? { "set-cookie": `session=${encodeURIComponent(account.user)}; Path=/; HttpOnly` } : {}) });
      response.end();
    });
    return;
  }
  if (url.pathname === "/expired") { response.writeHead(303, { location: "/login" }); response.end(); return; }
  if (url.pathname === "/away") { response.writeHead(303, { location: "http://other.example/login" }); response.end(); return; }
  if (Object.hasOwn(signedPages, url.pathname)) {
    if (!signedIn(request)) { response.writeHead(303, { location: "/login" }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(signedPages[url.pathname]());
    return;
  }
  if (Object.hasOwn(staticPages, url.pathname)) { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(staticPages[url.pathname]); return; }
  if (url.pathname === "/slow") { setTimeout(() => { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); }, Math.min(5_000, Number(url.searchParams.get("ms")) || 0)); return; }
  const late = /^\/late-fetch\/(\d{1,4})\/(a|b)$/.exec(url.pathname);
  if (late !== null) { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(lateFetch(Number(late[1]), late[2])); return; }
  if (url.pathname === "/regress") {
    if (regress) { response.writeHead(500, { "content-type": "text/plain" }); response.end("boom"); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(shell(`<h1>Fine</h1><p>This page works.</p>`));
    return;
  }
  // Slice 4: a candidate that breaks AND prints someone's address on its error page (the recording would show it): the video of this page, and of the whole run, is withheld.
  if (url.pathname === "/regress-leaky") {
    if (regress) { response.writeHead(500, { "content-type": "text/html; charset=utf-8" }); response.end(shell(`<h1>Error</h1><p>Could not load the account of ada@example.com</p>`)); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(shell(`<h1>Fine</h1><p>This page works.</p>`));
    return;
  }
  const body = routes[url.pathname];
  if (body === undefined) { response.writeHead(404, { "content-type": "text/plain" }); response.end("not found"); return; }
  response.writeHead(200, { "content-type": body === "ok" ? "text/plain" : "text/html; charset=utf-8" });
  response.end(body);
}).listen(Number(process.env.PORT), "127.0.0.1");
