import { createServer } from "node:http";

// A small storefront for the anonymous-scenario path (Task 3.3). It has no project contract, no accounts and no seed: it listens on the port the host gives it in PORT (4317 when
// the variable is not set) and shows every visitor the same welcome page. The admin area is behind a sign-in it does not implement, so a signed-out visitor sees the welcome
// marker and no admin link.
const port = Number(process.env.PORT ?? 4317);

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inferred shop</title></head>
<body>
  <h1 data-testid="welcome">Welcome to the shop</h1>
  <p data-testid="visitor">You are browsing as a visitor.</p>
  <a data-testid="sign-in-link" href="/signin">Sign in</a>
</body>
</html>
`;

export function createApplication() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://shop.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
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
  createApplication().listen(port, "0.0.0.0");
}
