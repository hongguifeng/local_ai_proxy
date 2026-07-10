import type { RuntimeTargetEndpoint } from "../config/schema.js";

export function joinTargetPath(basePath: string, requestTarget: string): string {
  if (/^https?:\/\//i.test(requestTarget)) {
    throw new TypeError("Absolute-form request targets are not supported");
  }
  if (requestTarget.includes("#")) {
    throw new TypeError("Request targets must not contain fragments");
  }

  const queryIndex = requestTarget.indexOf("?");
  const rawPath = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : requestTarget.slice(queryIndex);
  const requestPath = rawPath ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : "/";
  if (!basePath) {
    return `${requestPath}${query}`;
  }
  if (requestPath === basePath || requestPath.startsWith(`${basePath}/`)) {
    return `${requestPath}${query}`;
  }
  return `${basePath}${requestPath}${query}`;
}

export function targetHostHeader(endpoint: RuntimeTargetEndpoint): string {
  const defaultPort = endpoint.protocol === "https:" ? 443 : 80;
  const hostname =
    endpoint.hostname.includes(":") && !endpoint.hostname.startsWith("[")
      ? `[${endpoint.hostname}]`
      : endpoint.hostname;
  return endpoint.port === defaultPort ? hostname : `${hostname}:${endpoint.port.toString()}`;
}
