import { defineConfig } from "vite";
import { resolve } from "node:path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => ({
  plugins: [
    nodePolyfills({
      // 只包含需要的 polyfills 以减小包大小
      include: ['buffer', 'process', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    })
  ],
  define: {
    // 定义全局变量以确保兼容性
    global: 'globalThis',
  },
  build: {
    sourcemap: mode === "development",
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "popup/index": resolve(__dirname, "src/popup/index.html"),
        background: resolve(__dirname, "src/background/index.ts")
      },
      output: {
        entryFileNames: chunk =>
          chunk.name === "background" ? "background.js" : "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  esbuild: {
    legalComments: "none"
  }
}));
