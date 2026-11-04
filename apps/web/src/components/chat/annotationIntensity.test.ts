import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import { durationLabel } from "./annotationIntensity";

function press(
  overrides: Partial<ShortcutEventLike>,
  options: { platform?: string; terminalFocus?: boolean } = {},
) {
  const event: ShortcutEventLike = {
    key: "E",
    code: "KeyE",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
  return resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
    platform: options.platform ?? "Linux x86_64",
    context: { terminalFocus: options.terminalFocus ?? false },
  });
}

describe("chat English-only shortcut", () => {
  it("maps Alt+Shift+E to English only by physical key", () => {
    expect(press({ altKey: true, shiftKey: true })).toBe("annotations.englishOnly");
    // Option turns E into another character on macOS.
    expect(press({ key: "´", altKey: true, shiftKey: true }, { platform: "MacIntel" })).toBe(
      "annotations.englishOnly",
    );
  });

  it("ignores other modifiers, the focused terminal, and the retired heavier and lighter keys", () => {
    expect(press({ altKey: true })).toBeNull();
    expect(press({ altKey: true, shiftKey: true, ctrlKey: true })).toBeNull();
    expect(press({ altKey: true, shiftKey: true }, { terminalFocus: true })).toBeNull();
    expect(press({ key: ">", code: "Period", altKey: true, shiftKey: true })).toBeNull();
    expect(press({ key: "<", code: "Comma", altKey: true, shiftKey: true })).toBeNull();
  });
});

describe("durationLabel", () => {
  it("names a time left to the minute", () => {
    expect(durationLabel(42 * 60_000)).toBe("42 min");
    expect(durationLabel(20_000)).toBe("1 min");
    expect(durationLabel(60 * 60_000 - 400)).toBe("1 hour");
    expect(durationLabel(125 * 60_000)).toBe("2 h 5 min");
    expect(durationLabel(180 * 60_000)).toBe("3 hours");
  });
});
