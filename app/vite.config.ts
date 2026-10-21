import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The dev server needs inline scripts for hot reload, so the strict policy is added to builds only.
const productionCsp: Plugin = {
  name: "production-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:",
      },
      injectTo: "head-prepend",
    },
  ],
};

// Relative base so the built files load from file:// inside Electron.
export default defineConfig({
  base: "./",
  plugins: [react(), productionCsp],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
