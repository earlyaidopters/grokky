import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ? "+local" : ""); } catch { return "unknown"; } })();
const buildIdentity = JSON.stringify(`${commit} · ${new Date().toISOString()}`);

export default defineConfig({
  main: {
    define: { __GROKKY_BUILD__: buildIdentity },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "runner-service": resolve("src/main/runner-service.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
