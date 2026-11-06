import * as http from "node:http";

export interface FormPost {
  port: number;
  /** The Traefik route's host. Sent as the Host header to 127.0.0.1, since *.localhost does not resolve everywhere. */
  host: string;
  path: string;
  form: string;
}

/**
 * POSTs a form to a lane's Traefik. Uses node:http because fetch may drop a custom Host header, which is all
 * Traefik routes on (the same reason as Flisk's own cli/src/utils/agent-sessions.ts:30). Resolves the status code.
 */
export function postForm(request: FormPost, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: request.port,
        path: request.path,
        method: "POST",
        headers: {
          Host: request.host,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(request.form),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(request.form);
  });
}

/** One request to a lane's live app through its Traefik, returning status and body (used by Arena's checks). */
export function laneRequest(
  request: {
    port: number;
    host: string;
    method: "GET" | "POST";
    path: string;
    form?: string;
    /** Extra headers, e.g. a Cookie for a fixed voter id. Host stays the lane's. */
    headers?: Record<string, string>;
  },
  timeoutMs = 15_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = request.form ?? "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port: request.port,
        path: request.path,
        method: request.method,
        headers: {
          ...request.headers,
          Host: request.host,
          ...(request.method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
            : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(request.method === "POST" ? body : undefined);
  });
}
