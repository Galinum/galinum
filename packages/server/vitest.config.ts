import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@galinum/core/contract": fileURLToPath(
        new URL("../core/src/management-contract.ts", import.meta.url),
      ),
      "@galinum/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@galinum/dashboard/mount": fileURLToPath(
        new URL("../dashboard/src/mount.tsx", import.meta.url),
      ),
    },
  },
});
