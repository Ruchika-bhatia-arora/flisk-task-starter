import type { ContainerVerb } from "./arena/checks";
/** One service as Flisk reports it (`flisk status --json` → data.resources[]). */
export interface ServiceState {
  name: string;
  status: "ready" | "pending" | "error" | "unknown";
  url: string | null;
}

export interface LaneStatus {
  /** False when no Tilt answers for the lane: the stack is stopped. */
  tiltRunning: boolean;
  services: ServiceState[];
}

/** `ok` with no failures when every service is ready; otherwise the services that failed and why. */
export interface UpResult {
  ok: boolean;
  failures: Array<{ name: string; message: string }>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Everything Agent Lanes needs from Flisk and Docker. The real one shells out; tests use a fake. */
export interface FliskDriver {
  /** `flisk up --wait --json` in the lane folder; resolves once the stack is ready or has failed. */
  up(laneDir: string, env: Record<string, string>): Promise<UpResult>;
  status(laneDir: string): Promise<LaneStatus>;
  down(laneDir: string): Promise<void>;
  /** Docker's subnet capacity and the networks that exist now (see capacity.ts). */
  networkInventory(): Promise<{ capacity: number; names: string[] }>;
  /** `flisk restart <service>` against the lane's Tilt, so changed code is picked up. */
  restart(laneDir: string, service: string, tiltPort: number): Promise<void>;
  /** Removes the Docker volumes of a lane's Compose projects (`flisk down` keeps volumes). Returns their names. */
  removeVolumes(projectName: string): Promise<string[]>;
  /** Waits until Tilt (on `tiltPort`) has rebuilt these services after `sinceMs`; throws on a failed build. */
  waitForBuilds(laneDir: string, tiltPort: number, services: string[], sinceMs: number): Promise<void>;
  /** Stops or starts one service's container in a lane's Compose projects (`<projectName>-...`). */
  containerAction(projectName: string, service: string, verb: ContainerVerb): Promise<void>;
  restartCount(projectName: string, service: string): Promise<number>;
  /** `flisk run <service> -- <command>` in the lane folder. */
  run(laneDir: string, service: string, command: string[]): Promise<RunResult>;
}
