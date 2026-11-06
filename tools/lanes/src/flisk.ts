import type { ContainerVerb } from "./arena/checks";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FliskDriver, LaneStatus, RunResult, UpResult } from "./driver";
import { subnetCapacity } from "./capacity";
import { parseRun, parseStatus, parseUp } from "./parse";

/** The Flisk version whose JSON contracts Lanes was built and tested against. */
export const FLISK_VERSION = "1.4.37";

/**
 * Variables a lane must not inherit from the shell: Flisk reads the shell before the lane's .env
 * (cli/src/utils/host-port-config.ts:243-249), so an exported FLISK_HTTP_PORT would override every lane.
 */
const LANE_OWNED_ENV = ["FLISK_HTTP_PORT", "FLISK_HTTPS_PORT", "FLISK_POSTGRES_PORT", "TILT_PORT"];

function laneEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !LANE_OWNED_ENV.includes(key)) env[key] = value;
  }
  // Docker Desktop links its CLI into ~/.docker/bin, which a fresh install does not put on PATH.
  const extraPath = [join(homedir(), ".docker", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  env.PATH = [...extraPath, env.PATH ?? ""].join(":");
  return { ...env, ...extra };
}

async function exec(
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? laneEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Finds the flisk executable once (LANES_FLISK_BIN, or the pinned npm package), so polls do not pay for npx. */
async function resolveFlisk(): Promise<string[]> {
  if (process.env.LANES_FLISK_BIN) return process.env.LANES_FLISK_BIN.split(" ");
  const found = await exec(["npx", "-y", "-p", `@flisk-sh/flisk@${FLISK_VERSION}`, "which", "flisk"]);
  const path = found.stdout.trim().split("\n").at(-1);
  if (found.exitCode === 0 && path) return [path];
  return ["npx", "-y", `@flisk-sh/flisk@${FLISK_VERSION}`];
}

export class RealFlisk implements FliskDriver {
  private flisk: Promise<string[]> | undefined;
  private launchGate: Promise<void> = Promise.resolve();

  private async run_(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    this.flisk ??= resolveFlisk();
    return exec([...(await this.flisk), ...args], { cwd: options.cwd, env: laneEnv(options.env) });
  }

  /**
   * `flisk up --wait` in the lane. Tilt launches are serialised: every Tilt registers itself in the shared
   * ~/.tilt-dev/config, and two launched within milliseconds can lose one entry ("No tilt apiserver found:
   * tilt-10403"); Flisk then never sees that lane become ready and --wait hangs until its timeout. The next lane
   * launches once this lane's Tilt answers (or after 60 s); image builds still overlap.
   */
  async up(laneDir: string, env: Record<string, string>): Promise<UpResult> {
    const previous = this.launchGate;
    let release = () => {};
    this.launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.flisk ??= resolveFlisk();
    const proc = Bun.spawn([...(await this.flisk), "up", "--wait", "--json", "--wait-timeout", "900"], {
      cwd: laneDir,
      env: laneEnv(env),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    waitForTilt(Number(env.TILT_PORT), proc.exited, 60_000).finally(release);
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return parseUp(stdout, exitCode);
  }

  async status(laneDir: string): Promise<LaneStatus> {
    return parseStatus((await this.run_(["status", "--json"], { cwd: laneDir })).stdout);
  }

  async down(laneDir: string): Promise<void> {
    const result = await this.run_(["down", "--project", laneDir, "--prune-networks", "--json"], { cwd: laneDir });
    if (result.exitCode !== 0) throw new Error(`flisk down failed: ${(result.stderr || result.stdout).trim()}`);
  }

  async networkInventory(): Promise<{ capacity: number; names: string[] }> {
    const [pools, networks] = await Promise.all([
      exec(["docker", "info", "--format", "{{json .DefaultAddressPools}}"]),
      exec(["docker", "network", "ls", "--format", "{{.Name}}"]),
    ]);
    let parsed = null;
    try {
      parsed = JSON.parse(pools.stdout.trim() || "null");
    } catch {
      parsed = null;
    }
    return { capacity: subnetCapacity(parsed), names: networks.stdout.split("\n").filter(Boolean) };
  }

  async waitForBuilds(_laneDir: string, tiltPort: number, services: string[], sinceMs: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      const listed = await exec(["tilt", "get", "uiresources", "--port", String(tiltPort), "-o", "json"]);
      if (listed.exitCode === 0) {
        const items: TiltResource[] = JSON.parse(listed.stdout).items ?? [];
        const states = services.map((service) => buildState(items.find((item) => item.metadata?.name === service), sinceMs));
        const failed = states.find((state) => state.error);
        if (failed?.error) throw new Error(failed.error);
        const busy = states.some((state) => state.building);
        const allRebuilt = states.every((state) => state.rebuilt);
        // A change Tilt does not rebuild for (or one it picked up before `since`) leaves nothing to wait for.
        if (!busy && (allRebuilt || Date.now() - started > NO_BUILD_GRACE_MS)) return;
      }
      if (Date.now() - started > BUILD_TIMEOUT_MS) throw new Error(`no rebuild of ${services.join(", ")} within 5 min`);
      await Bun.sleep(2000);
    }
  }

  async containerAction(projectName: string, service: string, verb: ContainerVerb): Promise<void> {
    const name = await laneContainer(projectName, service);
    const result = await exec(["docker", verb, name]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker ${verb} ${name} failed`);
  }

  async restartCount(projectName: string, service: string): Promise<number> {
    const name = await laneContainer(projectName, service);
    const result = await exec(["docker", "inspect", "-f", "{{.RestartCount}}", name]);
    return Number(result.stdout.trim()) || 0;
  }

  async restart(laneDir: string, service: string, tiltPort: number): Promise<void> {
    const result = await this.run_(["restart", service, "--port", String(tiltPort), "--json"], { cwd: laneDir });
    if (result.exitCode !== 0) throw new Error(`flisk restart ${service} failed: ${(result.stderr || result.stdout).trim()}`);
  }

  async run(laneDir: string, service: string, command: string[]): Promise<RunResult> {
    return parseRun((await this.run_(["run", service, "--json", "--", ...command], { cwd: laneDir })).stdout);
  }

  /**
   * Removes volumes whose Compose project is one of the lane's (`<project>-<stack>-autogenerated`,
   * `<project>-<infra>`). Lane names have no hyphen, so `alpha-lane-` can never match another lane's project.
   */
  async removeVolumes(projectName: string): Promise<string[]> {
    const listed = await exec(["docker", "volume", "ls", "--format", '{{.Name}}\t{{.Label "com.docker.compose.project"}}']);
    const names = listed.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([name, project]) => name && project?.startsWith(`${projectName}-`))
      .map(([name]) => name);
    if (names.length > 0) await exec(["docker", "volume", "rm", ...names]);
    return names;
  }
}

interface TiltResource {
  metadata?: { name?: string };
  status?: {
    updateStatus?: string;
    pendingBuildSince?: string;
    currentBuild?: { startTime?: string };
    buildHistory?: Array<{ finishTime?: string; error?: string }>;
  };
}

/** A build may take a moment to be noticed after an edit; after this long with none, nothing is coming. */
const NO_BUILD_GRACE_MS = 15_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;

function buildState(resource: TiltResource | undefined, sinceMs: number): { building: boolean; rebuilt: boolean; error?: string } {
  const status = resource?.status ?? {};
  const building = Boolean(status.currentBuild?.startTime || status.pendingBuildSince);
  const last = status.buildHistory?.[0];
  const rebuilt = Boolean(last?.finishTime && Date.parse(last.finishTime) >= sinceMs);
  const error = rebuilt && last?.error ? `${resource?.metadata?.name} failed to build: ${last.error.split("\n")[0]}` : undefined;
  return { building, rebuilt, error };
}

/** The container of `service` in one of the lane's Compose projects (all start with `<projectName>-`). */
async function laneContainer(projectName: string, service: string): Promise<string> {
  const listed = await exec([
    "docker", "ps", "-a",
    "--filter", `label=com.docker.compose.service=${service}`,
    "--format", '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  const match = listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, project]) => project?.startsWith(`${projectName}-`));
  if (!match) throw new Error(`no ${service} container in lane ${projectName}`);
  return match[0];
}

/** Resolves once the Tilt on `port` answers its API, the launching process ends, or `limitMs` passes. */
async function waitForTilt(port: number, exited: Promise<number>, limitMs: number): Promise<void> {
  let done = false;
  exited.then(() => {
    done = true;
  });
  const deadline = Date.now() + limitMs;
  while (!done && Date.now() < deadline) {
    if ((await exec(["tilt", "get", "session", "--port", String(port)])).exitCode === 0) return;
    await Bun.sleep(1000);
  }
}

/**
 * A port is free when nothing answers on it (IPv4 or IPv6 loopback) and it can be bound on 127.0.0.1, where Docker
 * Desktop publishes. Checking for a listener matters: a server on *:8081 over IPv6 does not stop an IPv4 bind.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port, timeout: 300 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
  if ((await answers("127.0.0.1")) || (await answers("::1"))) return false;
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
