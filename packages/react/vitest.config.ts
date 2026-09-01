import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Testing Library registers its per-test cleanup via the global afterEach.
    globals: true,
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: { url: "https://app.customer.test/dashboard" },
    },
  },
});
