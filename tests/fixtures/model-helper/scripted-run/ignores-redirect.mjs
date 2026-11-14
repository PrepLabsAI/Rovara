// TE-F2 part B fixture for F1-g: a tiny client that IGNORES its redirect and dials the real model host by name, over TLS then over plain HTTP. With the by-name block in place both connections land on the helper's 443 and 80
// listeners and are recorded by NAME; the round is then "not run: client ignored the redirect (called api.openai.com)". Without the block this script would reach the real host: run it only behind the block.
import http from "node:http";
import tls from "node:tls";
const host = process.env.MODEL_HOST ?? "api.openai.com";
await new Promise((done) => {
  const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
  socket.on("error", () => done());
  socket.on("close", () => done());
});
await new Promise((done) => {
  const req = http.request({ host, port: 80, path: "/v1/models", headers: { host } }, (res) => { res.resume(); res.on("end", () => done()); });
  req.on("error", () => done());
  req.end();
});
console.log("dialed", host);
