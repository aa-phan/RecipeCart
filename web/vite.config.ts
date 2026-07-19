import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// RecipeCart web SPA (Phase 3). Dev-server proxies /api to the Fastify API
// (default port 3001, per src/api's API_PORT default) so the Vite dev server
// and the local API can run side-by-side without CORS issues.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
