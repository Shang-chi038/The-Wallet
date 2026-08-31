import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // No minifier name-mangling games: reviewers and auditors should be able to
    // read the shipped bundle. Extension review benefits from this too.
    sourcemap: true,
    target: "esnext",
    rollupOptions: {
      /**
       * The approval window is an extension page opened with
       * `chrome.windows.create`, so unlike the popup and the onboarding tab it
       * is not named anywhere in the manifest -- and crxjs only discovers HTML
       * entries the manifest points at. Declaring it here is what gets it built.
       *
       * It is deliberately NOT added to `web_accessible_resources` to make it
       * discoverable instead: that would let any website frame the approval
       * screen, which is a clickjacking primitive aimed at the one surface in
       * this extension where a click authorises a signature.
       */
      input: {
        approval: fileURLToPath(new URL("./src/ui/approval/index.html", import.meta.url)),
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
