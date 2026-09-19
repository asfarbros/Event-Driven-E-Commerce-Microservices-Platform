import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // VITE_* variables live in the monorepo root .env, not in this folder.
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  server: {
    port: 5173,
  },
});
