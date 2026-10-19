import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/**
 * Opens `path` for reading only if it is a regular file, deciding on the open handle and not on the path. A path checked first and opened after can be
 * swapped in between by a container that still runs (a symbolic link would then read a file of the worker, a FIFO would block the open for good). Here a
 * symbolic link fails the open (`O_NOFOLLOW`), a FIFO opens without waiting (`O_NONBLOCK`) and is refused by `fstat` on the handle, and so is anything else
 * that is not a regular file. The caller owns the returned handle and must close it.
 */
export async function openRegularFile(path: string): Promise<{ handle: FileHandle; size: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    return { handle, size: info.size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** The last `maxBytes` of a regular file, read from the handle; throws like `openRegularFile` for anything else. */
export async function readRegularFileTail(path: string, maxBytes: number): Promise<Buffer> {
  const { handle, size } = await openRegularFile(path);
  try {
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
