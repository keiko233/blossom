import { createEnv } from "@t3-oss/env-core";
import { createServerOnlyFn } from "@tanstack/react-start";

import { serverEnvSchema } from "./env-schema";

export { serverEnvSchema };

const buildEnv = createServerOnlyFn(() =>
  createEnv({
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    server: serverEnvSchema.shape,
  }),
);

let cachedEnv: ReturnType<typeof buildEnv> | undefined;

export const getServerEnv = () => {
  cachedEnv ??= buildEnv();
  return cachedEnv;
};
