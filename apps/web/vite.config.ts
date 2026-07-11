import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "same-origin-assets",
      enforce: "post",
      transformIndexHtml(html) {
        return html.replaceAll(" crossorigin", "");
      },
    },
  ],
  build: { sourcemap: false, target: "es2024", assetsDir: "assets" },
});
