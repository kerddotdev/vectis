import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
  build: { outDir: "renderer", emptyOutDir: true },
});
