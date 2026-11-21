import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";

import { SwitchField } from "./settings-ui";

it("renders a switch with a standalone hint", () => {
  const html = renderToString(
    createElement(SwitchField, {
      label: "Example",
      hint: "Helpful text",
      checked: false,
      onCheckedChange: () => {},
    }),
  );
  expect(html).toContain("Helpful text");
});
