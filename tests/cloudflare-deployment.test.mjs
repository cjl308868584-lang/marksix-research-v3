import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production build emits exactly one real DB binding", async () => {
  const config = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  const databases = config.d1_databases.filter(({ binding }) => binding === "DB");

  assert.deepEqual(databases, [
    {
      binding: "DB",
      database_name: "marksix-research-v3-db",
      database_id: "b55d1eaa-847a-4079-ab17-a140c2ae3345",
    },
  ]);
  assert.equal(
    new Set(config.compatibility_flags).size,
    config.compatibility_flags.length,
    "compatibility flags must not be duplicated in the generated deploy config",
  );
});

test("GitHub deployment workflow uses repository secrets and never embeds credentials", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(workflow, /npm run deploy:cloudflare/);
  assert.doesNotMatch(workflow, /gho_|cfoac_|AI_API_KEY:\s*[^$]/);
});

test("the Worker hands runtime secrets to server routes", async () => {
  const worker = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const runtimeEnv = await readFile(
    new URL("../lib/runtime-env.ts", import.meta.url),
    "utf8",
  );

  assert.match(worker, /__marksixBindings\s*=\s*bindings/);
  assert.match(runtimeEnv, /__marksixBindings/);
});

test("legacy migration cannot block the post-draw learning cycle", async () => {
  const service = await readFile(
    new URL("../lib/research-v3-service.ts", import.meta.url),
    "utf8",
  );

  assert.match(service, /signal:\s*AbortSignal\.timeout\(3_000\)/);
  assert.match(
    service,
    /https:\/\/marksix-research-v3-cn\.v308868584\.chatgpt\.site/,
  );
  assert.match(
    service,
    /api\/research\/forecast\?game=\$\{game\}/,
  );
});

test("an unverified draw preserves the frozen forecast without retrying the task", async () => {
  const route = await readFile(
    new URL("../app/api/internal/research/settle-and-learn/route.ts", import.meta.url),
    "utf8",
  );

  const start = route.indexOf('if (envelope.cycleStatus === "awaiting_verification")');
  const awaitingBranch = route.slice(start, route.indexOf("    const response = {", start + 80));
  assert.match(awaitingBranch, /completeResearchTask/);
  assert.doesNotMatch(awaitingBranch, /failResearchTask|status:\s*425|Retry-After/);
});

test("unverified latest results bypass settlement until independent verification", async () => {
  const service = await readFile(
    new URL("../lib/research-v3-service.ts", import.meta.url),
    "utf8",
  );

  assert.ok(
    service.indexOf("if (!latest.verified)") <
      service.indexOf("settleResearchV3Forecasts("),
    "an unverified result must not enter settlement or learning",
  );
});
