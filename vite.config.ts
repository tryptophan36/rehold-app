import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["lightweight-charts", "wagmi", "viem", "@tanstack/react-query"],
  },
});
