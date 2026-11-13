// Spec 061: a workflow document read back from storage, whichever way it was stored. The readers that name no store live in plan-document-reader.ts and are re-exported here.
import { GetObjectCommand } from "@aws-sdk/client-s3";

export * from "./plan-document-reader.js";

/** An object's text, read at most `maxBytes` of it; undefined when it cannot be read. */
export async function readObjectText(s3: { send(command: never): Promise<unknown> }, bucket: string, key: string, maxBytes: number): Promise<string | undefined> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }) as never) as { Body?: { transformToString(encoding?: string): Promise<string> } };
    return object.Body ? await object.Body.transformToString("utf8") : "";
  } catch {
    return undefined;
  }
}
