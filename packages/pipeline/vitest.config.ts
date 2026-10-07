import { defineConfig } from "vitest/config";

// Vitest config: node environment,
// tests colocated with source as *.test.ts, explicit imports (no globals).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**"],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20_000,
  },
});
