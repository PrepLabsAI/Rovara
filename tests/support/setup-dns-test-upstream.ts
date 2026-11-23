import type { Socket } from "node:dgram";
import type { Server } from "node:net";

/** Keep UDP's OS-assigned port while binding TCP to the same number. */
export async function bindDnsTestUpstream(create: () => { udp: Socket; tcp: Server }) {
  return bind(1);

  async function bind(attempt: number): Promise<{ port: number; close: () => Promise<void> }> {
    const { udp, tcp } = create();
    const close = async () => {
      await Promise.all([
        new Promise<void>((resolve) => { try { udp.close(() => resolve()); } catch { resolve(); } }),
        new Promise<void>((resolve) => { tcp.close(() => resolve()); }),
      ]);
    };
    try {
      await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(0, "127.0.0.1", () => { udp.off("error", reject); resolve(); }); });
      const port = udp.address().port;
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", () => { tcp.off("error", reject); resolve(); }); });
      return { port, close };
    } catch (error) {
      await close();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 5) throw error;
      return bind(attempt + 1);
    }
  }
}
