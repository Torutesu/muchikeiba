import { defineConfig } from "vite";
// Keep the UI entry small; the 3D renderer is loaded only by presentation.js.
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith("/three.core.js")) return "three-core";
          if (id.endsWith("/three.module.js")) return "three-webgl";
        },
      },
    },
  },
});
