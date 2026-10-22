import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

// A small storefront for the anonymous-scenario path (Task 3.3). It has no project contract, no accounts and no seed: it listens on the port the host gives it in PORT and shows every
// visitor the same welcome page. The admin area is behind a sign-in it does not implement, so a signed-out visitor sees the welcome marker and no admin link. Like any storefront it
// gives each visitor an id, in a cookie and in local storage, and prints it: a visitor id is no credential.

function page(visitorId) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inferred shop</title></head>
<body>
  <h1 data-testid="welcome">Welcome to the shop</h1>
  <p data-testid="visitor">You are browsing as a visitor.</p>
  <p data-testid="visitor-id">${visitorId}</p>
  <a data-testid="sign-in-link" href="/signin">Sign in</a>
  <script>localStorage.setItem("visitor_id", ${JSON.stringify(visitorId)});</script>
</body>
</html>
`;
}

export function createApplication() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://shop.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      const visitorId = `visitor-${randomUUID()}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `visitor=${visitorId}; Path=/` });
      response.end(page(visitorId));
      return;
    }
    if (request.method === "GET" && url.pathname === "/signin") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><title>Sign in</title><h1 data-testid="signin-heading">Sign in</h1>');
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/products") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ products: [{ id: "p1", name: "Mug" }, { id: "p2", name: "Pen" }] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/orders") {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  // There is no default port: the host gives the app its port in PORT, and an app started without one does not start.
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1) {
    console.error("PORT is not set: the host gives the app its port");
    process.exit(1);
  }
  createApplication().listen(port, "0.0.0.0");
}
