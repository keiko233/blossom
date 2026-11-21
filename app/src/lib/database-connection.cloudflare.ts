import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

export const getHyperdriveConnectionString = (): string | undefined =>
  env.HYPERDRIVE?.connectionString;

export const getFreshHyperdriveConnectionString = (): string | undefined =>
  env.HYPERDRIVE_FRESH?.connectionString ?? env.HYPERDRIVE?.connectionString;

export const getDatabaseRequest = (): Request => getRequest();
