import path from "node:path";
import { defineConfig } from "vitest/config";

// Gone standard Vitest config (gone-standards patterns/testing): node environment,
// colocated *.test.ts, explicit imports. Playwright specs in e2e/ run separately.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["{app,lib,components}/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
