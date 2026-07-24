import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let loadServerDraws: (
  game: "hk" | "macau" | "new_macau",
  limit: number,
  asOf?: Date,
) => Promise<{
  draws: Array<{
    issue: string;
    source: string;
    verified: boolean;
  }>;
  sourceMode: "live" | "snapshot";
  warning: string | null;
  rejectedFutureCount: number;
}>;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const loadedData = await server.ssrLoadModule("/lib/lottery-data.ts");
  loadServerDraws = loadedData.loadServerDraws;
});

after(async () => {
  await server.close();
});

test("history loader cross-verifies the latest issue with an independent endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const latestIssue = "2026204";
  const history = Array.from({ length: 10 }, (_, index) => {
    const values = Array.from(
      { length: 7 },
      (__, valueIndex) => ((index * 7 + valueIndex) % 49) + 1,
    );
    return {
      preDrawIssue: String(Number(latestIssue) - index),
      preDrawTime: new Date(
        Date.UTC(2026, 6, 23 - index, 13, 32),
      ).toISOString(),
      preDrawCode: values.join(","),
    };
  });
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: history },
      });
    }
    if (url.startsWith("https://api3.marksix6.net/")) {
      return Response.json({
        expect: latestIssue,
        openTime: history[0].preDrawTime,
        openCode: history[0].preDrawCode,
      });
    }
    return new Response("unexpected upstream", { status: 404 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-07-24T09:00:00.000Z"),
    );
    assert.equal(result.sourceMode, "live");
    assert.equal(result.draws.length, 10);
    assert.equal(result.draws[0].issue, latestIssue);
    assert.equal(result.draws[0].verified, true);
    assert.match(result.draws[0].source, /交叉一致/);
    assert.equal(result.draws.slice(1).some((draw) => draw.verified), false);
    assert.match(result.warning ?? "", /独立接口交叉一致校验/);
    assert.equal(result.rejectedFutureCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
