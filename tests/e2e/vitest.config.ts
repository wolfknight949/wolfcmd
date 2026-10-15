import { defineConfig } from "vitest/config";

// One real app at a time: each scenario starts WolfCmd.exe, so files and tests run in order.
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
