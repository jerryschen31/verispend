import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      // Optional because it exists only in the vitest miniflare environment.
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}

export {};
