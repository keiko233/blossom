import { describe, expect, it, vi } from "vitest";

import { getLocale } from "@/paraglide/runtime";

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(getLocale());
    },
  },
}));

import server from "./server";

describe("server locale handling", () => {
  it("isolates concurrent request locales and varies the response by cookie", async () => {
    const responses = await Promise.all(
      ["en", "zh-cn"].map((locale) =>
        server.fetch(
          new Request("http://localhost/", {
            headers: { cookie: `PARAGLIDE_LOCALE=${locale}` },
          }),
        ),
      ),
    );
    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["en", "zh-cn"]);
    for (const response of responses) {
      expect(response.headers.get("vary")).toContain("Cookie");
    }
  });
});
