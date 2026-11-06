/**
 * Docker gives every network a subnet from its address pools, and Flisk creates 7 networks per stack (backend,
 * database, infisical-network, proxy, traefik-private, traefik-public, verdaccio-network). On Docker's default
 * pools that is room for about four stacks: the real limit on parallel lanes is subnets, not memory.
 */
export const NETWORKS_PER_LANE = 7;

/** Docker's default-address-pools: 172.17.0.0/12 split into /16s (15 usable) and 192.168.0.0/16 into /20s (16). */
const DEFAULT_POOL_SUBNETS = 31;

export interface AddressPool {
  Base: string;
  Size: number;
}

export function subnetCapacity(pools: AddressPool[] | null | undefined): number {
  if (!pools || pools.length === 0) return DEFAULT_POOL_SUBNETS;
  return pools.reduce((sum, pool) => {
    const prefix = Number(pool.Base.split("/")[1]);
    return sum + (pool.Size >= prefix ? 2 ** (pool.Size - prefix) : 0);
  }, 0);
}

/** Networks without a subnet: Docker's built-in host and none. */
const NO_SUBNET = new Set(["host", "none"]);

export interface NetworkRoom {
  capacity: number;
  used: number;
  free: number;
  /** How many more Flisk lanes fit. */
  lanes: number;
}

export function networkRoom(capacity: number, networkNames: string[]): NetworkRoom {
  const used = networkNames.filter((name) => !NO_SUBNET.has(name)).length;
  const free = Math.max(0, capacity - used);
  return { capacity, used, free, lanes: Math.floor(free / NETWORKS_PER_LANE) };
}
