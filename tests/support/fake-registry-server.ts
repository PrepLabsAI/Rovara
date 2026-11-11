// A small stand-in for the registry container's HTTP API (v2): enough of tags, manifests and deletes for the local image registry adapter, in an in-process server on 127.0.0.1.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRegistryServer {
  address: string;
  /** What a worker's push does: stores a manifest under a tag. Returns its digest. */
  push(repository: string, tag: string, content?: string): string;
  /** Every request, as `METHOD path`. */
  requests: string[];
  /** Makes deletes answer this status (a registry with deletes off answers 405). */
  deleteStatus: number;
  /** Makes every request answer 503 until false. */
  down: boolean;
  close(): Promise<void>;
}

export async function startFakeRegistryServer(): Promise<FakeRegistryServer> {
  const repositories = new Map<string, Map<string, string>>();
  const manifests = new Map<string, string>();
  const state = { deleteStatus: 202, down: false };
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? ""}`);
    if (state.down) { response.writeHead(503).end(); return; }
    const path = decodeURIComponent((request.url ?? "").split("?")[0]!);
    const tags = /^\/v2\/(.+)\/tags\/list$/u.exec(path);
    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/u.exec(path);
    if (tags !== null) {
      const held = repositories.get(tags[1]!);
      if (held === undefined) { response.writeHead(404).end(JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] })); return; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: tags[1], tags: [...held.keys()] }));
      return;
    }
    if (manifest !== null) {
      const held = repositories.get(manifest[1]!);
      const reference = manifest[2]!;
      if (request.method === "DELETE") {
        if (state.deleteStatus !== 202) { response.writeHead(state.deleteStatus).end(); return; }
        if (held === undefined || ![...held.values()].includes(reference)) { response.writeHead(404).end(); return; }
        for (const [tag, digest] of [...held]) if (digest === reference) held.delete(tag);
        if (held.size === 0) repositories.delete(manifest[1]!);
        response.writeHead(202).end();
        return;
      }
      const digest = held?.get(reference) ?? ([...(held?.values() ?? [])].includes(reference) ? reference : undefined);
      if (digest === undefined) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "docker-content-digest": digest, "content-type": "application/vnd.oci.image.manifest.v1+json" }).end(request.method === "HEAD" ? undefined : manifests.get(digest) ?? "{}");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    address, requests,
    get deleteStatus() { return state.deleteStatus; }, set deleteStatus(value) { state.deleteStatus = value; },
    get down() { return state.down; }, set down(value) { state.down = value; },
    push(repository, tag, content = `${repository}:${tag}:${String(manifests.size)}`) {
      const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      manifests.set(digest, content);
      const held = repositories.get(repository) ?? new Map<string, string>();
      held.set(tag, digest);
      repositories.set(repository, held);
      return digest;
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
