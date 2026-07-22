import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished lottery research dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>六合智研｜港澳开奖与 AI 多维分析<\/title>/i);
  assert.match(html, /让每一期数据/);
  assert.match(html, /北京时间/);
  assert.match(html, /香港六合彩/);
  assert.match(html, /澳门六合彩/);
  assert.match(html, /六维研判实验室/);
  assert.match(html, /历史开奖记录/);
  assert.match(html, /不构成投注建议/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Your site is taking shape/i);
});

test("keeps the product implementation free of starter preview artifacts", async () => {
  const [page, layout, dashboard, packageJson, lotteryRoute, analyzeRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/LotteryDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/lottery/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<LotteryDashboard \/>/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(dashboard, /开奖前 3 分钟自动开启开奖台/);
  assert.match(dashboard, /FOCUS_OPTIONS/);
  assert.match(lotteryRoute, /info\.cld\.hkjc\.com/);
  assert.match(lotteryRoute, /api3\.marksix6\.net/);
  assert.match(analyzeRoute, /AI_API_KEY/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../lib/lottery.ts", import.meta.url));
  await access(templateRoot);
});
