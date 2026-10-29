import { describe, expect, it } from "vitest";

import { escapeCsvField, toCsv } from "./csv";

describe("escapeCsvField", () => {
  it("passes plain values through", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField(42)).toBe("42");
    expect(escapeCsvField(true)).toBe("true");
  });

  it("renders null and undefined as empty", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("quotes commas, newlines and carriage returns", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx"])(
    "neutralizes the formula prefix in %j",
    (value) => {
      expect(escapeCsvField(value)).toBe(`'${value}`);
    },
  );

  it("neutralizes then quotes when both apply", () => {
    expect(escapeCsvField('=HYPERLINK("x","y")')).toBe(
      '"\'=HYPERLINK(""x"",""y"")"',
    );
  });

  it("does not prefix formula characters that are not leading", () => {
    expect(escapeCsvField("a=b")).toBe("a=b");
    expect(escapeCsvField("user@example.com")).toBe("user@example.com");
  });

  it("leaves negative numbers alone", () => {
    expect(escapeCsvField(-5)).toBe("-5");
  });

  it("serializes dates as ISO strings", () => {
    expect(escapeCsvField(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});

describe("toCsv", () => {
  it("joins header and rows with CRLF", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          [1, "x,y"],
          [null, "z"],
        ],
      ),
    ).toBe('a,b\r\n1,"x,y"\r\n,z');
  });

  it("emits only the header for no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });
});
