import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Local development bridge only. The API credential never enters client code.
export default defineConfig(({ command }) => {
  const token =
    command === "serve"
      ? readFileSync(
          new URL("../v3-api/.local/api-token", import.meta.url),
          "utf8",
        ).trim()
      : "";
  if (command === "serve" && !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Start V3 dev:local first");
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "v3-local-boundary",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const path = req.url?.split("?")[0] ?? "";
            const deny = () => {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: {
                    code: "LOCAL_ONLY",
                    message: "Same-origin local workspace required",
                  },
                }),
              );
            };
            if (req.headers.host !== "127.0.0.1:4181") return deny();
            if (
              req.headers.origin &&
              req.headers.origin !== "http://127.0.0.1:4181"
            )
              return deny();
            if (path.startsWith("/api")) {
              if (
                !path.startsWith("/api/v3/") ||
                req.headers["x-v3-client"] !== "local-workspace"
              )
                return deny();
              if (
                req.headers["sec-fetch-site"] &&
                req.headers["sec-fetch-site"] !== "same-origin"
              )
                return deny();
              if (
                req.method !== "GET" &&
                req.headers.origin !== "http://127.0.0.1:4181"
              )
                return deny();
            }
            if (path === "/" || path === "/index.html") {
              res.writeHead(302, { Location: "/v3-live.html" });
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 4181,
      strictPort: true,
      cors: false,
      fs: {
        strict: true,
        deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.local/**"],
      },
      proxy: {
        "/api/v3/": {
          target: "http://127.0.0.1:4180",
          headers: { Authorization: `Bearer ${token}` },
          proxyTimeout: 15000,
        },
      },
    },
    build: {
      outDir: "dist-v3-live",
      rollupOptions: {
        input: fileURLToPath(new URL("./v3-live.html", import.meta.url)),
      },
    },
  };
});
