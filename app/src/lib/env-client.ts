import { createEnv } from "@t3-oss/env-core";

import { clientEnvSchema } from "./env-schema";

export { clientEnvSchema };

export const clientEnv = createEnv({
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
  clientPrefix: "VITE_",
  client: clientEnvSchema.shape,
});
