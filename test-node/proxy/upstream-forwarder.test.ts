import http from "node:http";

import { describe, expect, it } from "vitest";

import { openUpstreamResponse } from "../../src/proxy/upstream-forwarder.js";

describe("openUpstreamResponse", () => {
  it("uses a fresh upstream connection for every request", async () => {
    const remotePorts = new Set<number>();
    const connectionHeaders: (string | undefined)[] = [];
    const upstream = http.createServer((request, response) => {
      if (request.socket.remotePort !== undefined) {
        remotePorts.add(request.socket.remotePort);
      }
      connectionHeaders.push(request.headers.connection);
      response.end("ok");
    });
    const port = await listenServer(upstream);

    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await openUpstreamResponse({
          target: {
            targetScheme: "http",
            targetHost: "127.0.0.1",
            targetPort: port,
          },
          method: "GET",
          path: "/fresh-connection",
          headers: [
            ["Host", `127.0.0.1:${port}`],
            ["Connection", "keep-alive"],
          ],
          body: new Uint8Array(),
        });
        await consume(response);
      }

      expect(connectionHeaders).toEqual(["close", "close"]);
      expect(remotePorts.size).toBe(2);
    } finally {
      await closeServer(upstream);
    }
  });
});

async function consume(response: http.IncomingMessage): Promise<void> {
  for await (const chunk of response) {
    // Consume the complete body so the request lifecycle has finished.
    void chunk;
  }
}

function listenServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Upstream test server did not bind to a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
