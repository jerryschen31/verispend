import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "migrations")
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests build on each other's state within a file (e.g. budget
        // accumulation across the MCP flow), so keep storage shared and run
        // files sequentially in one worker.
        isolatedStorage: false,
        singleWorker: true,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_KEY: "test-admin-key",
            SESSION_SECRET: "test-session-secret",
            BASE_URL: "http://example.com",
            EMAIL_FROM: "approvals@test.local",
            KINDE_DOMAIN: "https://test-kinde.example",
            KINDE_CLIENT_ID: "test-client-id",
            KINDE_CLIENT_SECRET: "test-client-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
