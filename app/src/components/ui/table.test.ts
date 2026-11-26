import { describe, expect, it } from "vitest";

import { tableVariants } from "./table";

describe("tableVariants", () => {
  it("keeps pane containers overflow-visible without overflow-x-auto so sticky headers attach to the viewport scroller", () => {
    const paneClasses = tableVariants({ variant: "pane" }).split(/\s+/);
    expect(paneClasses).toContain("overflow-visible");
    expect(paneClasses).not.toContain("overflow-x-auto");
  });

  it("keeps horizontal scrolling on default and card table containers", () => {
    expect(tableVariants({ variant: "default" }).split(/\s+/)).toContain(
      "overflow-x-auto",
    );
    expect(tableVariants({ variant: "card" }).split(/\s+/)).toContain(
      "overflow-x-auto",
    );
  });
});
