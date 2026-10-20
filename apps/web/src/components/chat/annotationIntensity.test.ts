import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import { annotationIntensityTitle } from "./annotationIntensity";

function press(
  overrides: Partial<ShortcutEventLike>,
  options: { platform?: string; terminalFocus?: boolean } = {},
) {
  const event: ShortcutEventLike = {
    key: ".",
    code: "Period",
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

describe("chat Japanese shortcuts", () => {
  it("map Alt+Shift+Period to heavier and Alt+Shift+Comma to lighter by physical key", () => {
    // Shift turns the keys into > and < on US layouts, and Option into other symbols on macOS.
    expect(press({ key: ">", code: "Period", altKey: true, shiftKey: true })).toBe(
      "annotations.heavier",
    );
    expect(press({ key: "<", code: "Comma", altKey: true, shiftKey: true })).toBe(
      "annotations.lighter",
    );
    expect(
      press({ key: "˘", code: "Period", altKey: true, shiftKey: true }, { platform: "MacIntel" }),
    ).toBe("annotations.heavier");
    expect(
      press({ key: "¯", code: "Comma", altKey: true, shiftKey: true }, { platform: "MacIntel" }),
    ).toBe("annotations.lighter");
  });

  it("ignore other keys, other modifiers and the focused terminal", () => {
    expect(press({ key: ">", code: "Period", shiftKey: true })).toBeNull();
    expect(press({ key: ".", code: "Period", altKey: true })).toBeNull();
    expect(
      press({ key: ">", code: "Period", altKey: true, shiftKey: true, ctrlKey: true }),
    ).toBeNull();
    expect(press({ key: "?", code: "Slash", altKey: true, shiftKey: true })).toBeNull();
    expect(
      press({ key: ">", code: "Period", altKey: true, shiftKey: true }, { terminalFocus: true }),
    ).toBeNull();
  });
});

describe("annotationIntensityTitle", () => {
  const until = new Date(2026, 9, 18, 21, 40).getTime();

  // ICU may put a narrow no-break space before PM.
  const title = (level: number, at: number) =>
    annotationIntensityTitle({ level, until: at }, "en-US").replace(/\s/g, " ");

  it("names the direction, the level and when it ends", () => {
    expect(title(1, until)).toBe("Chat Japanese: heavier (+1) until 9:40 PM");
    expect(title(-2, until)).toBe("Chat Japanese: lighter (-2) until 9:40 PM");
    expect(title(0, 0)).toBe("Chat Japanese: normal");
  });

  it("names the ends of the scale off and full", () => {
    expect(title(-3, until)).toBe("Chat Japanese: off until 9:40 PM");
    expect(title(3, until)).toBe("Chat Japanese: full (+3) until 9:40 PM");
  });
});
