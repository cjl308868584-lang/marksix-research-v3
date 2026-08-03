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
