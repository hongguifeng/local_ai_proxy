export type EndpointKind = "responses" | "messages" | "chat" | "completions" | "other";

export function endpointKind(path: string): EndpointKind {
  const lowered = path.toLowerCase().split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  if (lowered === "/responses" || lowered.endsWith("/responses")) {
    return "responses";
  }
  if (lowered === "/messages" || lowered.endsWith("/messages")) {
    return "messages";
  }
  if (lowered === "/chat/completions" || lowered.endsWith("/chat/completions")) {
    return "chat";
  }
  if (lowered === "/completions" || lowered.endsWith("/completions")) {
    return "completions";
  }
  return "other";
}

export function displayEndpoint(path: string | number | boolean | null | undefined): string {
  const value = (path ? String(path) : "").split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  return value || "/";
}
