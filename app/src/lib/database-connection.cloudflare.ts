import { env } from "cloudflare:workers";

export const getHyperdriveConnectionString = (): string | undefined =>
  env.HYPERDRIVE?.connectionString;
