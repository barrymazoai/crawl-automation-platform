import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Separate demo entry: no V2 entry, API proxy, or deployment change.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "v3-demo-entry",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0];
          if (path === "/" || path === "/index.html") {
            res.writeHead(302, { Location: "/v3.html" });
            res.end();
            return;
          }
          if (path?.startsWith("/api")) {
            res.writeHead(404);
            res.end("Demo: API disabled");
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    open: false,
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**"],
    },
  },
  build: {
    outDir: "dist-v3",
    rollupOptions: {
      input: fileURLToPath(new URL("./v3.html", import.meta.url)),
    },
  },
});
