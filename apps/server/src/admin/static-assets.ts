import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerStaticAssets(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: resolve(webRoot),
    prefix: "/",
    setHeaders(response, path) {
      if (path.endsWith(".html")) response.setHeader("cache-control", "no-cache");
      else if (/[.-][a-f0-9]{8,}\.[A-Za-z0-9]+$/u.test(path))
        response.setHeader("cache-control", "public, max-age=31536000, immutable");
      else response.setHeader("cache-control", "no-cache");
    },
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/" || path.endsWith(".html")) void reply.header("cache-control", "no-cache");
    else if (/[.-][a-f0-9]{8,}\.[A-Za-z0-9]+$/u.test(path))
      void reply.header("cache-control", "public, max-age=31536000, immutable");
    done(null, payload);
  });
  app.get("/", (_request, reply) => reply.sendFile("index.html"));
}
