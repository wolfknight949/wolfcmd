import { describe, expect, it } from "vitest";

import { isShellTitle, panelTitle } from "./panel-title";

describe("N-03 panel titles", () => {
  it("n03_title_rule: the user's, a program's own, the agent, the profile, then Terminal", () => {
    expect(panelTitle({ title: "Build" }, "vim", "Command Prompt")).toBe("Build");
    expect(panelTitle({}, "vim", "Command Prompt")).toBe("vim");
    expect(panelTitle({}, "cmd", "Command Prompt")).toBe("Command Prompt");
    expect(panelTitle({}, undefined, "Command Prompt")).toBe("Command Prompt");
    expect(panelTitle({}, undefined, undefined)).toBe("Terminal");
    const agent = { agent: "claude-code", running: true };
    expect(panelTitle({ agent }, "pwsh", "PowerShell", "Claude Code")).toBe("Claude Code");
    expect(panelTitle({ agent }, "✳ Fixing the build", "PowerShell")).toBe("✳ Fixing the build");
  });

  it("n03_title_shell: a shell naming itself or its folder is not a program title", () => {
    for (const title of [
      "cmd",
      "PowerShell",
      "pwsh",
      "bash",
      "MINGW64:/c/dev",
      "C:\\dev",
      "~/src",
    ]) {
      expect(isShellTitle(title), title).toBe(true);
    }
    for (const title of ["vim", "npm test", "htop", "Claude Code"]) {
      expect(isShellTitle(title), title).toBe(false);
    }
  });
});
