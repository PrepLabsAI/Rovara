import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { SDK_EXTERNAL_TCP_PROBE } from "../support/model-sdk-compat-sandbox-probe.js";

afterEach(() => { vi.useRealTimers(); });

function probe() {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const connect = vi.fn((_port: number, _host: string, listener?: () => void) => {
        if (listener) socket.once("connect", listener);
        return socket;
    });
    const log = vi.fn();
    // Only inert sockets enter this context; no imports or real network calls.
    const pending = runInNewContext(`(async () => { ${SDK_EXTERNAL_TCP_PROBE} })()`, {
        net: { connect }, setTimeout, clearTimeout, console: { log },
    }) as Promise<void>;
    const outcome = pending.then(() => "refused", (error: Error) => error.message);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.slice(0, 2)).toEqual([9, "192.0.2.1"]);
    return { socket, outcome, log };
}

it("fails a hanging external TCP probe at exactly 2 seconds with visible escaped-or-hung output", async () => {
    const { socket, outcome, log } = probe();
    const settled = vi.fn();
    void outcome.then(settled);
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith("escaped-or-hung");
    expect(log).toHaveBeenCalledExactlyOnceWith("escaped-or-hung");
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it("fails an external TCP connection immediately and clears the deadline", async () => {
    const { socket, outcome, log } = probe();
    socket.emit("connect");
    expect(await outcome).toBe("escaped-or-hung");
    expect(log).toHaveBeenCalledExactlyOnceWith("escaped-or-hung");
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it.each(["EPERM", "EACCES", "ECONNREFUSED", "ENETUNREACH"])("only accepts sandbox permission refusals (%s)", async code => {
    const { socket, outcome, log } = probe();
    socket.emit("error", { code });
    const refused = ["EPERM", "EACCES"].includes(code);
    expect(await outcome).toBe(refused ? "refused" : "wrong-refusal");
    expect(log.mock.calls).toEqual(refused ? [] : [["wrong-refusal"]]);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
