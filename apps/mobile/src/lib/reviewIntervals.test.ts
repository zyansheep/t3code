import { describe, expect, it } from "vite-plus/test";

import { reviewIntervalLabel } from "./reviewIntervals";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("reviewIntervalLabel", () => {
  it.each([
    [0, "<1m"],
    [59, "<1m"],
    [60, "1m"],
    [10 * MINUTE, "10m"],
    [59 * MINUTE + 40, "1h"],
    [HOUR, "1h"],
    [5.4 * HOUR, "5h"],
    [23.6 * HOUR, "1d"],
    [3 * DAY, "3d"],
    [29.7 * DAY, "1mo"],
    [36 * DAY, "1.2mo"],
    [90 * DAY, "3mo"],
    [364 * DAY, "12.1mo"],
    [365 * DAY, "1y"],
    [2.1 * 365 * DAY, "2.1y"],
    [-5, "<1m"],
    [Number.NaN, "<1m"],
  ])("labels %s seconds %s", (seconds, label) => {
    expect(reviewIntervalLabel(seconds)).toBe(label);
  });
});
