import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // node:sqlite is a built-in Node 22.5+ module; keep vite from trying to
    // bundle/resolve it (it would otherwise strip the node: prefix and fail).
    server: { deps: { external: ["node:sqlite"] } },
  },
  ssr: { external: ["node:sqlite"] },
});
