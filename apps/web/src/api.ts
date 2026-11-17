import type { ChatResponse, DataStatus, Health } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("The server sent an unreadable response.", "BAD_RESPONSE", res.status);
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(err?.message ?? "Request failed.", err?.code ?? "HTTP_ERROR", res.status);
  }
  return body as T;
}

export async function sendChat(message: string, sessionId?: string, signal?: AbortSignal): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Couldn't reach the assistant. Check your connection and try again.", "NETWORK", 0);
  }
  return parse<ChatResponse>(res);
}

export async function getDataStatus(): Promise<DataStatus> {
  return parse<DataStatus>(await fetch("/api/status"));
}

export async function getHealth(): Promise<Health> {
  return parse<Health>(await fetch("/api/health"));
}

export async function resetSession(sessionId: string): Promise<void> {
  await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Ask the backend to render the latest answer's map as a PNG (via the MCP get_map_image tool). */
export async function downloadMapImage(sessionId: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch("/api/map-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    throw new ApiError("Couldn't reach the assistant. Check your connection and try again.", "NETWORK", 0);
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/png")) {
    await parse(res); // throws the server's friendly error
    throw new ApiError("The map image could not be created.", "MAP_IMAGE_FAILED", res.status);
  }
  return res.blob();
}

/** Trigger a browser download for a Blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
