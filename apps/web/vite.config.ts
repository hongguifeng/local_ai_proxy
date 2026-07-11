import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "same-origin-assets",
      enforce: "post",
      transformIndexHtml(html) {
        return html.replaceAll(" crossorigin", "").replace(' type="module"', " defer");
      },
    },
  ],
  build: { sourcemap: false, target: "es2022", assetsDir: "assets" },
});
