import { describe, expect, it } from "vitest";

import {
  flipFolder,
  MAX_SESSION_NAME,
  remoteControlName,
  remoteControlOn,
  sessionName,
} from "./remote-control";

const off = { remote_control: false, remote_control_folders: {} };
const on = { remote_control: true, remote_control_folders: {} };

describe("N-06 remote control", () => {
  it("is off by default and follows the setting without a folder", () => {
    expect(remoteControlOn(off, "C:\\Dev\\game")).toBe(false);
    expect(remoteControlOn(on, null)).toBe(true);
  });

  it("a folder's choice wins both ways, by folder key", () => {
    const always = { remote_control: false, remote_control_folders: { "c:/dev/game": true } };
    expect(remoteControlOn(always, "C:\\Dev\\Game\\")).toBe(true);
    expect(remoteControlOn(always, "C:\\Dev\\other")).toBe(false);
    const never = { remote_control: true, remote_control_folders: { "c:/dev/game": false } };
    expect(remoteControlOn(never, "c:/dev/game")).toBe(false);
  });

  it("flipping keeps only a choice that differs from the setting", () => {
    const first = flipFolder(off, "C:\\Dev\\Game");
    expect(first).toEqual({ "c:/dev/game": true });
    expect(
      flipFolder({ remote_control: false, remote_control_folders: first }, "C:\\Dev\\Game"),
    ).toEqual({});
    expect(flipFolder(on, "/home/me/game")).toEqual({ "/home/me/game": false });
  });

  it("names the session after workspace and tab in safe characters", () => {
    expect(sessionName("wolfcmd", "Design")).toBe("wolfcmd · Design");
    expect(sessionName("wolfcmd", "wolfcmd")).toBe("wolfcmd");
    expect(sessionName("", "Tab 2")).toBe("Tab 2");
    expect(sessionName("my\"game'", "a%b!c\nd")).toBe("my game · a b c d");
    expect(sessionName("", '"%!')).toBe("WolfCmd");
    expect(Array.from(sessionName("x".repeat(80), "y")).length).toBe(MAX_SESSION_NAME);
    expect(remoteControlName(off, "C:\\Dev\\game", "game", "Tab 1")).toBeUndefined();
    expect(remoteControlName(on, null, "game", "Tab 1")).toBe("game · Tab 1");
  });
});
