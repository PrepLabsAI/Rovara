// TE-F2 part B (M2, release 0.5.19; te-f1 design 4.5; the redirect check 1b): the GCE metadata server beside the helper's loop, on `--meta-port`. Vertex's Application Default Credentials ask it for a project and a token before the first model call
// (Python needs GCE_METADATA_HOST and GCE_METADATA_IP, JS needs GCE_METADATA_HOST). The routes and answers are F0a's pure table (`serveMetadataRequest`): every answer carries `Metadata-Flavor: Google`, a request without that request
// header is refused (403), a method other than GET is 405, anything else is 404; the token is a fixed dummy built at run time. This server answers only the helper's `--caller`, refuses CONNECT and upgrades, takes no body, and
// never echoes or forwards a bearer token that arrives (it reads no header but `Metadata-Flavor`). The project id is the connected project's (plain, not secret); absent, the project route answers 500, never a made-up id.
// Like the loop it makes no outbound connection: `createServer` only.
import { createServer, type Server } from "node:http";
import { serveMetadataRequest } from "@agentx/contracts";

const REFUSAL_BODY = '{"error":{"code":"refused","message":"the model helper does not answer this caller"}}';
const normalizeAddress = (address: string | undefined): string => (address ?? "").replace(/^::ffff:/iu, "");

export function createModelMetadataServer(input: { readonly caller: string; readonly projectId?: string | undefined }): Server {
  const meta = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    req.resume();
    const fixed = (status: number, body: string): void => {
      res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), connection: "close" });
      res.end(body);
    };
    if (normalizeAddress(req.socket.remoteAddress) !== input.caller) return fixed(403, REFUSAL_BODY);
    const url = typeof req.url === "string" && req.url.length <= 400 && req.url.startsWith("/") && !req.url.startsWith("//") ? req.url : undefined;
    if (url === undefined || (url.match(/\?/gu) ?? []).length > 1) return fixed(404, "");
    const [path = "/", query = ""] = url.split("?");
    const answer = serveMetadataRequest({ method: req.method ?? "GET", path, query, headers: req.headers }, { projectId: input.projectId ?? "" });
    res.writeHead(answer.status, { ...answer.headers, "content-length": String(Buffer.byteLength(answer.body)), connection: "close" });
    res.end(answer.body);
  });
  meta.on("connect", (_req, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
  meta.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
  meta.on("clientError", (_error, socket) => socket.destroy());
  return meta;
}
