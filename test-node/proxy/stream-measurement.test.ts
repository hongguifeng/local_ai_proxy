import http from "node:http";
import { createGzip } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  ProxyListener,
  ProxyRequestPipeline,
  type TrafficLogWriter,
} from "../../src/proxy/index.js";

/**
 * The three things a streaming answer has to get right are checked here in separate
 * layers, so a failure names the layer that broke:
 *
 * - streaming order: the client sees an event while the upstream answer is still open;
 * - measured calculation: the numbers written to the log satisfy their relationships,
 *   whatever their size;
 * - protocol content: the log carries the decoded answer, not the encoded bytes.
 *
 * The real streaming integration cases stay in `proxy-listener.test.ts`; these cases
 * deliberately drop everything that is not their own layer.
 */

/** How long a fixture may wait for the delivery event that releases its next phase. */
const DELIVERY_GATE_MS = 5_000;

interface DeliveryWaiter {
  isReady: (chunkCount: number, body: string) => boolean;
  resolve: () => void;
}

interface DeliveryObserver {
  /** Record one downstream chunk, called from the client's "data" handler. */
  note(chunk: Buffer): void;
  /** Chunks the client received, in arrival order. */
  received(): Buffer[];
  /** How many chunks the client received so far. */
  receivedCount(): number;
  /** Resolves once the client received at least `count` chunks. */
  arrived(count: number): Promise<void>;
  /** Resolves once the accumulated body contains `marker`. */
  sawText(marker: string): Promise<void>;
}

/**
 * Downstream delivery as an observable event, so a fixture releases its next phase
 * when the previous bytes really arrived instead of when a timer expires. A starved
 * event loop resumes a compressor callback and an expired timer in the same tick,
 * which is what made the timer-gated cases fail intermittently.
 */
function createDeliveryObserver(): DeliveryObserver {
  const chunks: Buffer[] = [];
  const waiters: DeliveryWaiter[] = [];
  const releaseReady = (): void => {
    const body = Buffer.concat(chunks).toString("utf8");
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter?.isReady(chunks.length, body)) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const waitFor = (isReady: (chunkCount: number, body: string) => boolean): Promise<void> => {
    if (isReady(chunks.length, Buffer.concat(chunks).toString("utf8"))) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push({ isReady, resolve });
    });
  };
  return {
    note(chunk: Buffer): void {
      chunks.push(chunk);
      releaseReady();
    },
    received(): Buffer[] {
      return [...chunks];
    },
    receivedCount(): number {
      return chunks.length;
    },
    arrived(count: number): Promise<void> {
      return waitFor((chunkCount) => chunkCount >= count);
    },
    sawText(marker: string): Promise<void> {
      return waitFor((_chunkCount, body) => body.includes(marker));
    },
  };
}

/** Bound a delivery gate so a stalled fixture fails with its own message. */
function withinDeadline(gate: Promise<void>, deadlineMs: number, unmet: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(unmet));
    }, deadlineMs);
    timer.unref();
    void gate.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(unmet));
      },
    );
  });
}

/** Resolves when zlib emitted every byte written to the compressor before the call. */
function compressorFlushed(compressor: ReturnType<typeof createGzip>): Promise<void> {
  return new Promise((resolve, reject) => {
    compressor.once("error", reject);
    compressor.flush(() => {
      compressor.removeListener("error", reject);
      resolve();
    });
  });
}

function listenServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Test upstream did not bind to TCP."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Send a chat-completions request and collect the downstream body as it arrives. */
function requestStream(
  port: number,
  body: Record<string, unknown>,
  delivery: DeliveryObserver,
): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          delivery.note(chunk);
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

interface StreamFixture {
  listener: ProxyListener;
  upstream: http.Server;
  /** The downstream delivery observed by the client request this fixture serves. */
  delivery: DeliveryObserver;
  /** Resolves with the log's `request_finished` record. */
  finished: () => Promise<Readonly<Record<string, unknown>>>;
  /** Whether the upstream answer had already been ended when asked. */
  upstreamAnswerEnded: () => boolean;
  /** Why the phase gate gave up, when it did. */
  gateFailure: () => unknown;
}

/**
 * Build a listener whose upstream releases SSE events only when the previous bytes
 * were observed downstream. With `singleWrite` every event goes out in one write, so
 * the log has nothing left to release afterwards.
 */
async function startStreamFixture(
  events: readonly string[],
  singleWrite: boolean,
): Promise<StreamFixture> {
  let markFinished: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
  const finishedRecord = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
    markFinished = resolve;
  });
  const trafficLog: TrafficLogWriter = {
    write(record) {
      if (record.event === "request_finished") {
        markFinished?.(record);
      }
      return Promise.resolve();
    },
    update: () => Promise.resolve(),
  };
  let answerEnded = false;
  let gateFailure: unknown;
  const delivery = createDeliveryObserver();
  const endAnswer = (response: http.ServerResponse): void => {
    answerEnded = true;
    response.end();
  };
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(singleWrite ? events.join("") : (events[0] ?? ""));
    void (async () => {
      if (singleWrite) {
        await withinDeadline(
          delivery.sawText(doneMarker(events)),
          DELIVERY_GATE_MS,
          "the single-write body never reached the client",
        );
        endAnswer(response);
        return;
      }
      for (const event of events.slice(1)) {
        await withinDeadline(
          delivery.arrived(1),
          DELIVERY_GATE_MS,
          "the first released event never reached the client",
        );
        response.write(event);
        await withinDeadline(
          delivery.sawText(event.slice(0, 24)),
          DELIVERY_GATE_MS,
          `event never reached the client: ${event.slice(0, 40)}`,
        );
      }
      endAnswer(response);
    })().catch((error: unknown) => {
      gateFailure = error;
      endAnswer(response);
    });
  });
  const upstreamPort = await listenServer(upstream);
  const pipeline = new ProxyRequestPipeline({
    targets: [
      {
        enabled: true,
        id: "measurement-target",
        modelMappings: [],
        name: "Measurement target",
        targetScheme: "http",
        targetHost: "127.0.0.1",
        targetPort: upstreamPort,
        targetBasePath: "",
        trafficLog,
      },
    ],
  });
  const listener = new ProxyListener({
    host: "127.0.0.1",
    port: 0,
    onRequest: (request, response, context) => pipeline.handle(request, response, context),
  });
  return {
    listener,
    upstream,
    delivery,
    finished: () => finishedRecord,
    upstreamAnswerEnded: () => answerEnded,
    gateFailure: () => gateFailure,
  };
}

/** A marker from the last event, used to wait for a body written in one go. */
function doneMarker(events: readonly string[]): string {
  return (events.at(-1) ?? "").slice(0, 24);
}

function deltaEvent(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;
}

const doneEvent = "data: [DONE]\n\n";

const streamedEvents = [deltaEvent("first"), deltaEvent("second"), deltaEvent("third"), doneEvent];

describe("streaming measurement layers", () => {
  it("[AI-14] delivers a released event while the upstream answer is still open", async () => {
    const fixture = await startStreamFixture(streamedEvents, false);
    const address = await fixture.listener.start();
    const clientPromise = requestStream(
      address.port,
      { model: "measurement-model", stream: true, messages: [] },
      fixture.delivery,
    );
    await fixture.delivery.arrived(1);
    // Sampled at the moment the first chunk landed: the proxy forwarded it without
    // waiting for the upstream to finish, which is the whole streaming contract.
    const answerStillOpen = !fixture.upstreamAnswerEnded();
    const client = await clientPromise;

    expect(client.status).toBe(200);
    expect(fixture.gateFailure()).toBeUndefined();
    expect(answerStillOpen).toBe(true);
    expect(fixture.delivery.receivedCount()).toBeGreaterThanOrEqual(2);
    // The first chunk the client received carries only the first event: nothing
    // else had been written when it arrived, so the answer was streamed, not
    // buffered until complete.
    const firstChunk = fixture.delivery.received()[0];
    expect(firstChunk).toBeDefined();
    expect(firstChunk?.toString("utf8")).toBe(streamedEvents[0]);
    expect(client.text).toBe(streamedEvents.join(""));

    await fixture.listener.close();
    await closeServer(fixture.upstream);
  });

  it("[AI-14] keeps the measured decode window inside the measured request", async () => {
    const fixture = await startStreamFixture(streamedEvents, false);
    const address = await fixture.listener.start();
    await requestStream(
      address.port,
      { model: "measurement-model", stream: true, messages: [] },
      fixture.delivery,
    );

    const record = await fixture.finished();
    expect(fixture.gateFailure()).toBeUndefined();
    // The calculation layer states relationships, not magnitudes: a magnitude
    // threshold measures how busy the machine is, while these hold whatever the
    // real delivery gap turns out to be.
    const firstTokenMs = record["first_token_ms"];
    const windowMs = record["decode_window_ms"];
    const durationMs = record["duration_ms"];
    expect(firstTokenMs).toEqual(expect.any(Number));
    expect(durationMs).toEqual(expect.any(Number));
    expect(windowMs).toEqual(expect.any(Number));
    expect(Number(firstTokenMs)).toBeLessThan(Number(durationMs));
    expect(Number(windowMs)).toBeGreaterThan(0);
    expect(Number(windowMs)).toBeLessThanOrEqual(Number(durationMs) - Number(firstTokenMs));

    await fixture.listener.close();
    await closeServer(fixture.upstream);
  });

  it("[AI-14] reports a zero decode window when every event arrives in one observation", async () => {
    const events = [deltaEvent("first"), deltaEvent("second"), doneEvent];
    const fixture = await startStreamFixture(events, true);
    const address = await fixture.listener.start();
    const client = await requestStream(
      address.port,
      { model: "measurement-model", stream: true, messages: [] },
      fixture.delivery,
    );

    expect(client.status).toBe(200);
    expect(fixture.delivery.receivedCount()).toBe(1);
    const record = await fixture.finished();
    // The answer still streamed, so a first token was observed; the window is zero
    // because nothing was generated after that first observation.
    expect(record["first_token_ms"]).toEqual(expect.any(Number));
    expect(Number(record["decode_window_ms"])).toBe(0);
    expect(Number(record["duration_ms"])).toBeGreaterThan(0);

    await fixture.listener.close();
    await closeServer(fixture.upstream);
  });

  it("[AI-14] reports no first token when the stream carries only bookkeeping", async () => {
    const bookkeeping = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"output_tokens":10}}}\n\n',
      doneEvent,
    ];
    const fixture = await startStreamFixture(bookkeeping, false);
    const address = await fixture.listener.start();
    await requestStream(
      address.port,
      { model: "measurement-model", stream: true, messages: [] },
      fixture.delivery,
    );

    const record = await fixture.finished();
    expect(record["first_token_ms"]).toBeUndefined();
    expect(Number(record["decode_window_ms"])).toBe(0);

    await fixture.listener.close();
    await closeServer(fixture.upstream);
  });

  it("[AI-14] measures the answer on decoded events, not on the encoded bytes", async () => {
    const events = [deltaEvent("first"), deltaEvent("second"), doneEvent];
    let markFinished: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
    const finishedRecord = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      markFinished = resolve;
    });
    const trafficLog: TrafficLogWriter = {
      write(record) {
        if (record.event === "request_finished") {
          markFinished?.(record);
        }
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
    };
    const delivery = createDeliveryObserver();
    let gateFailure: unknown;
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "content-encoding": "gzip",
      });
      const gzip = createGzip();
      gzip.on("data", (chunk: Buffer) => response.write(chunk));
      gzip.on("end", () => response.end());
      gzip.write(events[0] ?? "");
      void (async () => {
        await compressorFlushed(gzip);
        await withinDeadline(
          delivery.arrived(1),
          DELIVERY_GATE_MS,
          "the first compressed chunk never reached the client",
        );
        for (const event of events.slice(1)) {
          gzip.write(event);
        }
        gzip.end();
      })().catch((error: unknown) => {
        gateFailure = error;
        response.end();
      });
    });
    const upstreamPort = await listenServer(upstream);
    const pipeline = new ProxyRequestPipeline({
      targets: [
        {
          enabled: true,
          id: "measurement-compressed-target",
          modelMappings: [],
          name: "Measurement compressed target",
          targetScheme: "http",
          targetHost: "127.0.0.1",
          targetPort: upstreamPort,
          targetBasePath: "",
          trafficLog,
        },
      ],
    });
    const listener = new ProxyListener({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request, response, context) => pipeline.handle(request, response, context),
    });
    const address = await listener.start();
    const client = await requestStream(
      address.port,
      { model: "measurement-model", stream: true, messages: [] },
      delivery,
    );
    expect(client.status).toBe(200);
    expect(gateFailure).toBeUndefined();

    const record = await finishedRecord;
    // A first token and a non-zero window are only possible when the log parsed the
    // decoded events: gzip bytes carry no parseable SSE content, so if the decoder
    // were ever bypassed both of these would fail.
    expect(Number(record["first_token_ms"])).toBeLessThan(Number(record["duration_ms"]));
    expect(Number(record["decode_window_ms"])).toBeGreaterThan(0);
    // The content layer at the same boundary: the log carries the plain events.
    const response = record["response"] as Record<string, unknown>;
    const body = response["body"] as Record<string, unknown>;
    expect(body["text"]).toBe(events.join(""));
    const summary = body["stream_summary"] as Record<string, unknown>;
    expect(summary["content"]).toBe("firstsecond");
    expect(summary["done_seen"]).toBe(true);

    await listener.close();
    await closeServer(upstream);
  });
});
