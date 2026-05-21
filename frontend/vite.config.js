import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1800,
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
  },
});
