import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { assessQualityGate } from "../lib/ai-quality-gate.ts";
import { mergeDrawLists } from "../lib/draw-merge.ts";
import { getZodiac } from "../lib/zodiac.ts";

test("draw refresh upgrades a duplicate issue from single-source to verified", () => {
  const initial = {
    game: "new_macau",
    issue: "2026204",
    verified: false,
    source: "单源",
    special: 8,
  };
  const verifiedCorrection = {
    ...initial,
    verified: true,
    source: "双源",
    special: 9,
  };
  assert.deepEqual(
    mergeDrawLists([initial], [verifiedCorrection]),
    [verifiedCorrection],
  );

  const staleSingleSource = {
    ...initial,
    source: "较旧单源",
    special: 7,
  };
  assert.deepEqual(
    mergeDrawLists([verifiedCorrection], [staleSingleSource]),
    [verifiedCorrection],
  );
});

test("quality gate rejects an unverified latest draw even when an older draw is verified", () => {
  const draws = [
    {
      game: "new_macau" as const,
      drawAt: "2026-07-25T13:32:00.000Z",
      verified: false,
    },
    {
      game: "new_macau" as const,
      drawAt: "2026-07-24T13:32:00.000Z",
      verified: true,
    },
  ];
  const blocked = assessQualityGate({
    game: "new_macau",
    history: { sourceMode: "live", rejectedFutureCount: 0 },
    draws,
    windowSize: 2,
    analysisCutoff: new Date("2026-07-26T00:00:00.000Z"),
    targetConfirmed: true,
  });
  assert.equal(blocked.eligible, false);
  assert.ok(
    blocked.reasons.includes(
      "最近一期尚未完成跨源一致核验，不能形成优势推荐",
    ),
  );

  const eligible = assessQualityGate({
    game: "new_macau",
    history: { sourceMode: "live", rejectedFutureCount: 0 },
    draws: [{ ...draws[0], verified: true }, draws[1]],
    windowSize: 2,
    analysisCutoff: new Date("2026-07-26T00:00:00.000Z"),
    targetConfirmed: true,
  });
  assert.equal(eligible.eligible, true);
});

test("zodiac mapping keeps the verified 05 tiger result and lunar-new-year boundary", () => {
  assert.equal(getZodiac(5, "2026-07-24T21:32:00+08:00"), "虎");
  assert.equal(getZodiac(1, "2026-02-16T21:32:00+08:00"), "蛇");
  assert.equal(getZodiac(1, "2026-02-17T21:32:00+08:00"), "马");
  assert.equal(getZodiac(5, "2026-02-16T21:32:00+08:00"), "牛");
  assert.equal(getZodiac(5, "2026-02-17T21:32:00+08:00"), "虎");
});

test("equal zodiac counts use one deterministic order on server and client", () => {
  const draw = {
    game: "new_macau",
    issue: "2026204",
    drawAt: "2026-07-24T21:32:00+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "测试",
    verified: true,
  };
  assert.deepEqual(
    buildAnalysis([draw]).zodiacs.map(({ name }) => name),
    ["鼠", "牛", "虎", "兔", "龙", "蛇", "马"],
  );
});

let server: ViteDevServer;
let buildAnalysis: (
  draws: unknown[],
) => { zodiacs: Array<{ name: string; count: number }> };
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
  conflictCount: number;
  missingIssueCount: number;
}>;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const loadedLottery = await server.ssrLoadModule("/lib/lottery.ts");
  const loadedData = await server.ssrLoadModule("/lib/lottery-data.ts");
  buildAnalysis = loadedLottery.buildAnalysis;
  loadServerDraws = loadedData.loadServerDraws;
});

after(async () => {
  await server.close();
});

test("history loader cross-verifies the latest issue with an independent endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const marksixUrls: string[] = [];
  const newMacauUrls: string[] = [];
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
      marksixUrls.push(url);
      return Response.json({
        expect: latestIssue,
        openTime: history[0].preDrawTime,
        openCode: history[0].preDrawCode,
      });
    }
    if (url.startsWith("https://macaumarksix.com/")) {
      newMacauUrls.push(url);
      return Response.json([{
        expect: latestIssue,
        openTime: history[0].preDrawTime,
        openCode: history[0].preDrawCode,
      }]);
    }
    if (url.startsWith("https://history.macaumarksix.com/")) {
      return Response.json([{
        expect: latestIssue,
        openTime: history[0].preDrawTime,
        openCode: history[0].preDrawCode,
      }]);
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
    assert.equal(marksixUrls.length, 1);
    assert.equal(newMacauUrls.length, 1);
    assert.match(marksixUrls[0], /[?&]type=newMacau(?:&|$)/);
    assert.match(result.draws[0].source, /交叉一致/);
    assert.equal(result.draws.slice(1).some((draw) => draw.verified), false);
    assert.match(result.warning ?? "", /多源一致/);
    assert.match(result.warning ?? "", /不等同于官方认证/);
    assert.equal(result.rejectedFutureCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hong Kong history is formally verified against the official HKJC feed", async () => {
  const originalFetch = globalThis.fetch;
  const history = [
    {
      preDrawIssue: "2026070",
      preDrawTime: "2026-07-30 21:30:00",
      preDrawCode: "1,2,3,4,5,6,7",
    },
    {
      preDrawIssue: "2026069",
      preDrawTime: "2026-07-28 21:30:00",
      preDrawCode: "8,9,10,11,12,13,14",
    },
  ];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({ errorCode: 0, result: { data: history } });
    }
    if (url.startsWith("https://info.cld.hkjc.com/")) {
      return Response.json({
        data: {
          lotteryDraws: [
            {
              year: "2026",
              no: 70,
              drawDate: "2026-07-30",
              drawResult: { drawnNo: [1, 2, 3, 4, 5, 6], xDrawnNo: 7 },
            },
            {
              year: "2026",
              no: 69,
              drawDate: "2026-07-28",
              drawResult: { drawnNo: [8, 9, 10, 11, 12, 13], xDrawnNo: 14 },
            },
          ],
        },
      });
    }
    return new Response("source unavailable", { status: 503 });
  };
  try {
    const result = await loadServerDraws(
      "hk",
      10,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    assert.equal(result.draws.length, 2);
    assert.ok(result.draws.every((draw) => draw.verified));
    assert.ok(result.draws.every((draw) => /香港赛马会/.test(draw.source)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two agreeing Hong Kong sources verify a draw ahead of the lagging history feed", async () => {
  const originalFetch = globalThis.fetch;
  const latestCode = "37,07,16,01,32,22,23";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: [{
          preDrawIssue: "2026082",
          preDrawTime: "2026-07-30 21:30:00",
          preDrawCode: "14,17,01,02,35,23,48",
        }] },
      });
    }
    if (url.startsWith("https://api3.marksix6.net/")) {
      return Response.json({
        expect: "2026083",
        openTime: "2026-08-01 21:32:32",
        openCode: latestCode,
      });
    }
    if (url.startsWith("https://www.kj1868.cc/")) {
      return Response.json({
        status: "10",
        data: { data: [{
          period: "2026083",
          lottery_date: "2026-08-01",
          numbers: latestCode,
        }] },
      });
    }
    if (url.startsWith("https://info.cld.hkjc.com/")) {
      return Response.json({ errors: [{ message: "WHITELIST_ERROR" }] });
    }
    return new Response("unexpected upstream", { status: 404 });
  };

  try {
    const result = await loadServerDraws(
      "hk",
      10,
      new Date("2026-08-01T14:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, "2026083");
    assert.equal(result.draws[0].verified, true);
    assert.match(result.draws[0].source, /Marksix6.*开奖1868/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new Macau latest result verifies even when the older cross-check is stale", async () => {
  const originalFetch = globalThis.fetch;
  const latestIssue = "2026212";
  const latestCode = "43,32,16,39,19,27,06";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: [{
          preDrawIssue: latestIssue,
          preDrawTime: "2026-07-31 21:32:32",
          preDrawCode: latestCode,
        }] },
      });
    }
    if (url.startsWith("https://api3.marksix6.net/")) {
      return Response.json({
        expect: "2026211",
        openTime: "2026-07-30 21:32:32",
        openCode: "13,12,39,37,38,08,01",
      });
    }
    if (url.startsWith("https://macaumarksix.com/")) {
      return Response.json([{
        expect: latestIssue,
        openTime: "2026-07-31 21:32:32",
        openCode: latestCode,
      }]);
    }
    if (url.startsWith("https://history.macaumarksix.com/")) {
      return Response.json([{
        expect: latestIssue,
        openTime: "2026-07-31 21:32:32",
        openCode: latestCode,
      }]);
    }
    return new Response("unexpected upstream", { status: 404 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, latestIssue);
    assert.equal(result.draws[0].verified, true);
    assert.match(result.draws[0].source, /新澳门开奖独立接口/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two agreeing latest sources verify a draw missing from the lagging history feed", async () => {
  const originalFetch = globalThis.fetch;
  const latestIssue = "2026213";
  const latestCode = "09,05,12,22,01,15,35";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: [{
          preDrawIssue: "2026211",
          preDrawTime: "2026-07-30 21:32:32",
          preDrawCode: "13,12,39,37,38,08,01",
        }] },
      });
    }
    if (url.startsWith("https://api3.marksix6.net/")) {
      return Response.json({
        expect: latestIssue,
        openTime: "2026-08-01 21:32:32",
        openCode: latestCode,
      });
    }
    if (url.startsWith("https://macaumarksix.com/")) {
      return Response.json([{
        expect: latestIssue,
        openTime: "2026-08-01 21:32:32",
        openCode: latestCode,
      }]);
    }
    if (url.startsWith("https://history.macaumarksix.com/")) {
      return Response.json([]);
    }
    return new Response("unexpected upstream", { status: 404 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-08-01T14:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, latestIssue);
    assert.equal(result.draws[0].verified, true);
    assert.match(result.draws[0].source, /Marksix6.*新澳门开奖独立接口/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new Macau year history unwraps the documented data envelope and verifies formal samples", async () => {
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 40 }, (_, index) => ({
    expect: String(2026213 - index),
    openTime: `2026-07-${String(30 - (index % 28)).padStart(2, "0")} 21:32:32`,
    openCode: [1, 2, 3, 4, 5, 6, 7].map((value) => ((value + index - 1) % 49) + 1).join(","),
  }));
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: {
          data: rows.map((row) => ({
            preDrawIssue: row.expect,
            preDrawTime: row.openTime,
            preDrawCode: row.openCode,
          })),
        },
      });
    }
    if (url.includes("/history/macaujc2/y/2026")) {
      return Response.json({ result: true, code: 200, data: rows });
    }
    return new Response("source unavailable", { status: 503 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      40,
      new Date("2026-07-30T15:59:00.000Z"),
    );
    assert.equal(result.draws.length, 40);
    assert.ok(result.draws.every((draw) => draw.verified));
    assert.equal(result.missingIssueCount, 0);
    assert.equal(result.conflictCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a same-issue source conflict is never promoted to verified consensus", async () => {
  const originalFetch = globalThis.fetch;
  const issue = "2026213";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({ errorCode: 0, result: { data: [{
        preDrawIssue: issue,
        preDrawTime: "2026-08-01 21:32:32",
        preDrawCode: "09,05,12,22,01,15,35",
      }] } });
    }
    if (url.startsWith("https://api3.marksix6.net/")) {
      return Response.json({
        expect: issue,
        openTime: "2026-08-01 21:32:32",
        openCode: "09,05,12,22,01,15,35",
      });
    }
    if (url.startsWith("https://macaumarksix.com/")) {
      return Response.json([{
        expect: issue,
        openTime: "2026-08-01 21:32:32",
        openCode: "08,05,12,22,01,15,35",
      }]);
    }
    if (url.startsWith("https://history.macaumarksix.com/")) {
      return Response.json({ result: true, code: 200, data: [] });
    }
    return new Response("unexpected upstream", { status: 404 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-08-01T14:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, issue);
    assert.equal(result.draws[0].verified, false);
    assert.equal(result.conflictCount, 1);
    assert.match(result.warning ?? "", /跨源结果冲突/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the audited 2026212 migration remains verifiable during source outages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: [{
          preDrawIssue: "2026212",
          preDrawTime: "2026-07-31 21:32:32",
          preDrawCode: "43,32,16,39,19,27,06",
        }] },
      });
    }
    return new Response("source unavailable", { status: 503 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, "2026212");
    assert.equal(result.draws[0].verified, true);
    assert.match(result.draws[0].source, /迁移核验快照/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the verified 2026212 result advances history even when the primary feed stops at 2026211", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://api.api16868.com/")) {
      return Response.json({
        errorCode: 0,
        result: { data: [{
          preDrawIssue: "2026211",
          preDrawTime: "2026-07-30 21:32:32",
          preDrawCode: "13,12,39,37,38,08,01",
        }] },
      });
    }
    return new Response("source unavailable", { status: 503 });
  };

  try {
    const result = await loadServerDraws(
      "new_macau",
      10,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    assert.equal(result.draws[0].issue, "2026212");
    assert.equal(result.draws[0].verified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
