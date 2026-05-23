import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: true,
  banner: {
    js: "import { createRequire as __tidymacCreateRequire } from 'node:module'; const require = __tidymacCreateRequire(import.meta.url);"
  },
  bundle: true,
  noExternal: [/.*/]
});
