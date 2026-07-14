import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number.parseInt(process.env.PI_PR_REVIEW_PORT ?? "", 10) || 43133;
const webPort = Number.parseInt(process.env.PI_REVIEW_WEB_PORT ?? "", 10) || 5173;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-web",
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
