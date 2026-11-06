import type { LaneStatus, RunResult, ServiceState, UpResult } from "./driver";

/** Flisk's machine output: `{ schemaVersion, data, errors }` (cli/src/utils/machine-output.ts:7-23). */
interface Envelope {
  schemaVersion: number;
  // biome-ignore lint/suspicious/noExplicitAny: shape differs per command; each parser reads what it needs.
  data: any;
  errors: Array<{ code: string; message: string }>;
}

/** Every JSON envelope in the output, in order. `up --wait` prints several, one per line. */
function envelopes(output: string): Envelope[] {
  const found: Envelope[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{"schemaVersion"')) continue;
    try {
      found.push(JSON.parse(line));
    } catch {
      // A partial line (killed process) is not an envelope.
    }
  }
  if (found.length === 0) {
    try {
      const whole = JSON.parse(output);
      if (whole && typeof whole === "object" && "schemaVersion" in whole) found.push(whole);
    } catch {
      // Not JSON at all.
    }
  }
  return found;
}

/**
 * `flisk up --wait --json`. The first envelope is the stack's result; Flisk 1.4.37 then prints UP_FAILED
 * envelopes ("exited before reporting a result") even after a ready stack, so later ones are ignored.
 */
export function parseUp(output: string, exitCode: number): UpResult {
  const result = envelopes(output).find((envelope) => typeof envelope.data?.ok === "boolean");
  if (result?.data.ok === true && exitCode === 0) return { ok: true, failures: [] };
  if (result && Array.isArray(result.data.failures) && result.data.failures.length > 0) {
    return { ok: false, failures: result.data.failures.map((f: { name: string; message: string }) => ({ ...f })) };
  }
  const message = result?.errors?.[0]?.message ?? output.trim().split(/\r?\n/).slice(-3).join("\n");
  return { ok: false, failures: [{ name: "flisk", message: message || `flisk up exited with code ${exitCode}` }] };
}

const SERVICE_STATES = new Set(["ready", "pending", "error", "unknown"]);

/** `flisk status --json`. Running is read from tilt.readiness: tilt.available stays true after `flisk down`. */
export function parseStatus(output: string): LaneStatus {
  const data = envelopes(output)[0]?.data;
  if (!data) return { tiltRunning: false, services: [] };
  const services: ServiceState[] = (data.resources ?? []).map(
    (resource: { name: string; status: string; url?: string | null }) => ({
      name: resource.name,
      status: SERVICE_STATES.has(resource.status) ? resource.status : "unknown",
      url: resource.url ?? null,
    }),
  );
  return { tiltRunning: data.tilt?.readiness != null, services };
}

/** `flisk run <service> --json -- <command>`. */
export function parseRun(output: string): RunResult {
  const data = envelopes(output)[0]?.data;
  if (!data) return { exitCode: 1, stdout: "", stderr: output };
  return { exitCode: data.exitCode ?? 1, stdout: data.stdout ?? "", stderr: data.stderr ?? "" };
}
