import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defaultsFromSchema, pruneSettings } from "./schema-defaults";

describe("schema defaults", () => {
  const schema = z.object({
    tls: z
      .object({
        acme: z
          .object({
            dns01_challenge: z.object({ provider: z.string() }).optional(),
          })
          .optional(),
      })
      .optional(),
  });

  it("does not materialise optional object branches", () => {
    expect(defaultsFromSchema(schema)).toEqual({ tls: undefined });
  });

  it("prunes legacy empty optional object branches", () => {
    expect(
      pruneSettings(
        {
          tls: {
            acme: { dns01_challenge: { provider: "" } },
          },
        },
        schema,
      ),
    ).toEqual({});
  });

  it("keeps an enabled branch with meaningful values", () => {
    expect(
      pruneSettings(
        {
          tls: {
            acme: { dns01_challenge: { provider: "cloudflare" } },
          },
        },
        schema,
      ),
    ).toEqual({
      tls: {
        acme: { dns01_challenge: { provider: "cloudflare" } },
      },
    });
  });
});
