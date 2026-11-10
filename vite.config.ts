import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { retainAssets } from "./tools/retainAssets.ts";

export default defineConfig({
  plugins: [react(), retainAssets()],
  base: "./",
  build: { outDir: "docs" },
});
