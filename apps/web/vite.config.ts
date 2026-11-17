import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    // The browser only ever talks to the backend; GIS services are reached through MCP on the server.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  test: { environment: "jsdom", include: ["test/**/*.test.tsx", "test/**/*.test.ts"] },
} as never);
