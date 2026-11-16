import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { cleanupWorlds, stampSet, startWorld } from "../support/model-helper-world.js";
afterEach(cleanupWorlds);
it.each([false, true])("cut_off_stream closes an incomplete HTTP response (stream=%s), so the SDK sees a dropped connection", async (stream) => {
    const world = await startWorld({ blockState: "not_blocked_here", sets: [stampSet("openai_compatible", [{ id: "answer" }])] });
    try {
        const result = await new Promise<{
            aborted: boolean;
            bytes: string;
        }>((done, reject) => {
            const req = http.request(`${world.base}/p/openai/f/cut_off_stream/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" } }, res => {
                let bytes = "";
                res.on("data", (chunk: Buffer) => { bytes += chunk.toString(); });
                res.on("aborted", () => done({ aborted: true, bytes }));
                res.on("end", () => done({ aborted: false, bytes }));
                res.on("error", () => undefined);
            });
            req.on("error", reject);
            req.end(JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "compat-text" }], stream }));
        });
        expect(result.bytes.length).toBeGreaterThan(0);
        expect(result.bytes).not.toContain("[DONE]");
        expect(result.aborted).toBe(true);
        expect(world.summary().failurePack).toBe(1);
    }
    finally {
        await world.close();
    }
});
