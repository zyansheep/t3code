import { describe, expect, it } from "vite-plus/test";

import { formatCostUsd } from "./formatCost";

describe("formatCostUsd", () => {
  it.each([
    [0, "$0.00"],
    [0.004, "<$0.01"],
    [0.015, "$0.01"],
    [1.234, "$1.23"],
    [99.994, "$99.99"],
    [1234.5, "$1,235"],
  ])("formats %s as %s", (amount, label) => {
    expect(formatCostUsd(amount)).toBe(label);
  });
});
