import { describe, expect, it } from "vitest";

import { canonicalNodeKey, tryCanonicalNodeKey } from "../../src/proxy/index.js";

describe("canonical node key", () => {
  it("LB04-01 collapses localhost and 127.0.0.1", () => {
    expect(canonicalNodeKey("http://localhost:9393/v1")).toBe(
      canonicalNodeKey("http://127.0.0.1:9393/v1"),
    );
    expect(canonicalNodeKey("http://localhost:9393/v1")).toBe("http://127.0.0.1:9393/v1");
    expect(canonicalNodeKey("http://[::1]:9393/v1")).toBe("http://127.0.0.1:9393/v1");
  });

  it("LB04-02 drops the default port but keeps an explicit one", () => {
    expect(canonicalNodeKey("http://localhost/v1")).toBe("http://127.0.0.1/v1");
    expect(canonicalNodeKey("http://127.0.0.1:80/v1")).toBe("http://127.0.0.1/v1");
    expect(canonicalNodeKey("https://localhost/v1")).toBe("https://127.0.0.1/v1");
    expect(canonicalNodeKey("https://127.0.0.1:443/v1")).toBe("https://127.0.0.1/v1");
    expect(canonicalNodeKey("http://127.0.0.1:9393/v1")).not.toBe("http://127.0.0.1/v1");
    expect(canonicalNodeKey("https://127.0.0.1:8443/v1")).toBe("https://127.0.0.1:8443/v1");
  });

  it("LB04-02 keeps a non-loopback IPv6 literal unambiguous", () => {
    expect(canonicalNodeKey("http://[2001:db8::1]:9393/v1")).toBe("http://[2001:db8::1]:9393/v1");
    expect(canonicalNodeKey("http://[2001:db8::1]:9393/v1")).not.toBe(
      canonicalNodeKey("http://127.0.0.1:9393/v1"),
    );
  });

  it("LB04-02 trims trailing slashes but keeps distinct base paths", () => {
    expect(canonicalNodeKey("http://127.0.0.1:9393/v1/")).toBe("http://127.0.0.1:9393/v1");
    expect(canonicalNodeKey("http://127.0.0.1:9393/")).toBe("http://127.0.0.1:9393");
    expect(canonicalNodeKey("http://127.0.0.1:9393")).toBe("http://127.0.0.1:9393");
    expect(canonicalNodeKey("http://127.0.0.1:9393/v1")).not.toBe(
      canonicalNodeKey("http://127.0.0.1:9393/v1/chat"),
    );
    expect(canonicalNodeKey("http://127.0.0.1:9393/v1///")).toBe("http://127.0.0.1:9393/v1");
  });

  it("LB04-02 folds host case and scheme case but not path case", () => {
    expect(canonicalNodeKey("HTTP://LOCALHOST:9393/v1")).toBe("http://127.0.0.1:9393/v1");
    expect(canonicalNodeKey("http://GPU-A:9393/v1")).toBe("http://gpu-a:9393/v1");
    expect(canonicalNodeKey("http://127.0.0.1:9393/V1")).not.toBe(
      canonicalNodeKey("http://127.0.0.1:9393/v1"),
    );
  });

  it("LB04-02 never merges a DNS name into the loopback address", () => {
    const key = canonicalNodeKey("http://vllm-win:9393/v1");

    expect(key).toBe("http://vllm-win:9393/v1");
    expect(key).not.toBe(canonicalNodeKey("http://127.0.0.1:9393/v1"));
  });

  it("LB04-02 ignores query and fragment", () => {
    expect(canonicalNodeKey("http://127.0.0.1:9393/v1?api_key=abc#frag")).toBe(
      "http://127.0.0.1:9393/v1",
    );
  });

  it("LB04-02 honours a custom loopback set", () => {
    const options = { loopbackHosts: new Set(["gpu-local"]) };

    expect(canonicalNodeKey("http://gpu-local:9393/v1", options)).toBe(
      canonicalNodeKey("http://127.0.0.1:9393/v1", options),
    );
    expect(canonicalNodeKey("http://localhost:9393/v1", options)).toBe("http://localhost:9393/v1");
  });

  it("LB04-02 reports unparseable URLs without throwing in the safe form", () => {
    expect(tryCanonicalNodeKey("ftp://127.0.0.1:9393/v1")).toBeUndefined();
    expect(tryCanonicalNodeKey("127.0.0.1:9393/v1")).toBeUndefined();
    expect(tryCanonicalNodeKey("http://127.0.0.1:9393/v1")).toBe("http://127.0.0.1:9393/v1");
    expect(() => canonicalNodeKey("127.0.0.1:9393/v1")).toThrow();
  });
});
