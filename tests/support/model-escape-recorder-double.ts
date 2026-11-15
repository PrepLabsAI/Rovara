// TE-F2 part B test double for the `ModelHostRecorderPort` (F1-b's recorder module reads names in production): reads the TLS hello's server name (port 443) or the Host header (port 80) from the first bytes.
import type { ModelHostRecorderPort } from "../../packages/worker/src/model-helper-recorder-port.js";

function sniOf(bytes: Uint8Array): string | undefined {
  const buf = Buffer.from(bytes);
  try {
    if (buf[0] !== 0x16) return undefined;
    let at = 5 + 4 + 2 + 32; // record header, handshake header, version, random
    at += 1 + (buf[at] ?? 0); // session id
    at += 2 + buf.readUInt16BE(at); // cipher suites
    at += 1 + (buf[at] ?? 0); // compression
    const end = at + 2 + buf.readUInt16BE(at);
    at += 2;
    while (at + 4 <= end) {
      const type = buf.readUInt16BE(at);
      const length = buf.readUInt16BE(at + 2);
      if (type === 0) return buf.subarray(at + 4 + 5, at + 4 + length).toString("latin1");
      at += 4 + length;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
function hostHeaderOf(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString("latin1");
  const match = /^host:\s*([^\r\n]+)/imu.exec(text);
  return match?.[1]?.trim();
}
export const nameReadingRecorder: ModelHostRecorderPort = {
  observe: ({ port, firstBytes }) => ({ host: port === 443 ? sniOf(firstBytes) : hostHeaderOf(firstBytes) }),
};
