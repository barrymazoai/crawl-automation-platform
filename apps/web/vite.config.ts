import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 8787, proxy: { "/api": { target: process.env.VITE_BACKEND_URL ?? "http://localhost:8080", changeOrigin: true } } },
  build: { sourcemap: true },
});

