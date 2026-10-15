// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { DRAG_THRESHOLD_PX, holdsPress, isDrag, replayInit } from "./mouse-select";

const press = { button: 0, shiftKey: false, altKey: false, isTrusted: true };
const agentTracking = { agentPanel: true, tracking: "any" };

describe("drag selection in agent panels", () => {
  it("holds_a_left_press_in_an_agent_panel_that_tracks_the_mouse", () => {
    expect(holdsPress(press, agentTracking)).toBe(true);
  });

  it("leaves_plain_shells_and_programs_without_mouse_tracking_alone", () => {
    expect(holdsPress(press, { agentPanel: false, tracking: "any" })).toBe(false);
    expect(holdsPress(press, { agentPanel: true, tracking: "none" })).toBe(false);
  });

  it("other_buttons_shift_alt_and_replayed_presses_pass", () => {
    expect(holdsPress({ ...press, button: 2 }, agentTracking)).toBe(false);
    expect(holdsPress({ ...press, shiftKey: true }, agentTracking)).toBe(false);
    expect(holdsPress({ ...press, altKey: true }, agentTracking)).toBe(false);
    expect(holdsPress({ ...press, isTrusted: false }, agentTracking)).toBe(false);
  });

  it("a_small_wobble_is_still_a_click", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + DRAG_THRESHOLD_PX, y: 10 })).toBe(true);
  });

  it("a_drag_is_replayed_with_shift_at_the_press_position", () => {
    const event = new MouseEvent("mousedown", { clientX: 40, clientY: 50, button: 0, detail: 1 });
    expect(replayInit(event, true)).toMatchObject({ clientX: 40, clientY: 50, shiftKey: true });
    expect(replayInit(event, false)).toMatchObject({ shiftKey: false, detail: 1, bubbles: true });
  });
});
