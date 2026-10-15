import { describe, expect, it } from "vitest";

import { dropTarget, dropText, quotePath, translatePath } from "./drop";

describe("N-02 which shell reads the dropped paths", () => {
  it("N-02 PowerShell profiles quote for PowerShell; other shells are POSIX", () => {
    expect(dropTarget("pwsh", false)).toEqual({
      quoting: "powershell",
      style: { kind: "native" },
    });
    expect(dropTarget("windows-powershell", false).quoting).toBe("powershell");
    // A shell on macOS or Linux.
    expect(dropTarget("zsh", false)).toEqual({ quoting: "posix", style: { kind: "native" } });
  });

  it("N-02 cmd, Git Bash and WSL profiles get their own quoting and path style", () => {
    expect(dropTarget("cmd", false)).toEqual({ quoting: "cmd", style: { kind: "native" } });
    expect(dropTarget("git-bash", false)).toEqual({
      quoting: "posix",
      style: { kind: "git-bash" },
    });
    expect(dropTarget("wsl.ubuntu-24.04", false)).toEqual({
      quoting: "posix",
      style: { kind: "wsl", distro: "ubuntu-24.04" },
    });
  });

  it("N-02 an agent keeps the shell's path style but is quoted like prose", () => {
    expect(dropTarget("wsl.ubuntu", true)).toEqual({
      quoting: "agent",
      style: { kind: "wsl", distro: "ubuntu" },
    });
    expect(dropTarget("pwsh", true).quoting).toBe("agent");
  });
});

describe("N-02 paths as the shell sees the disk", () => {
  const windows = { kind: "native" } as const;
  const gitBash = { kind: "git-bash" } as const;
  const wsl = { kind: "wsl", distro: "ubuntu" } as const;

  it("N-02 Windows paths stay as Explorer wrote them", () => {
    expect(translatePath("C:\\Users\\me\\a b.txt", windows)).toBe("C:\\Users\\me\\a b.txt");
  });

  it("N-02 Git Bash gets /c/… and WSL gets /mnt/c/…", () => {
    expect(translatePath("C:\\Users\\me\\a b.txt", gitBash)).toBe("/c/Users/me/a b.txt");
    expect(translatePath("C:\\Users\\me\\a b.txt", wsl)).toBe("/mnt/c/Users/me/a b.txt");
    expect(translatePath("D:\\", wsl)).toBe("/mnt/d");
    expect(translatePath("d:/work/x/", gitBash)).toBe("/d/work/x");
  });

  it("N-02 a file inside this WSL distribution is its Linux path", () => {
    expect(translatePath("\\\\wsl$\\Ubuntu\\home\\me\\x.txt", wsl)).toBe("/home/me/x.txt");
    expect(translatePath("\\\\wsl.localhost\\Ubuntu\\home\\me", wsl)).toBe("/home/me");
    expect(translatePath("\\\\wsl$\\Ubuntu", wsl)).toBe("/");
  });

  it("N-02 another distribution's files and network shares are left alone", () => {
    expect(translatePath("\\\\wsl$\\Debian\\home\\me", wsl)).toBe("\\\\wsl$\\Debian\\home\\me");
    expect(translatePath("\\\\server\\share\\a", wsl)).toBe("\\\\server\\share\\a");
    expect(translatePath("\\\\server\\share\\a b", gitBash)).toBe("//server/share/a b");
  });
});

describe("N-02 quoting", () => {
  it("N-02 PowerShell: single quotes, a quote doubled", () => {
    expect(quotePath("C:\\a b", "powershell")).toBe("'C:\\a b'");
    expect(quotePath("C:\\it's", "powershell")).toBe("'C:\\it''s'");
    expect(quotePath("C:\\$env\\`x", "powershell")).toBe("'C:\\$env\\`x'");
  });

  it("N-02 cmd: double quotes", () => {
    expect(quotePath("C:\\a b", "cmd")).toBe('"C:\\a b"');
    expect(quotePath('C:\\a"b', "cmd")).toBeUndefined();
  });

  it("N-02 POSIX shells: single quotes, a quote written '\\''", () => {
    expect(quotePath("/c/a b", "posix")).toBe("'/c/a b'");
    expect(quotePath("/c/it's", "posix")).toBe("'/c/it'\\''s'");
    expect(quotePath("/c/$HOME/`x`", "posix")).toBe("'/c/$HOME/`x`'");
  });

  it("N-02 agents: a plain path is bare, one that needs it gets double quotes", () => {
    expect(quotePath("C:\\Dev\\app\\main.ts", "agent")).toBe("C:\\Dev\\app\\main.ts");
    expect(quotePath("/mnt/c/Привіт/файл.txt", "agent")).toBe("/mnt/c/Привіт/файл.txt");
    expect(quotePath("C:\\My Pictures\\a.png", "agent")).toBe('"C:\\My Pictures\\a.png"');
  });

  it("N-02 a path with a control character can't be typed on one line", () => {
    for (const quoting of ["powershell", "cmd", "posix", "agent"] as const) {
      expect(quotePath("C:\\a\nb", quoting)).toBeUndefined();
      expect(quotePath("C:\\a\rb", quoting)).toBeUndefined();
      expect(quotePath("", quoting)).toBeUndefined();
    }
  });
});

describe("N-02 the text typed for a drop", () => {
  it("N-02 several files: quoted, space separated, a trailing space, never Enter", () => {
    const text = dropText(["C:\\a b\\x.txt", "C:\\c.txt"], dropTarget("pwsh", false));
    expect(text).toBe("'C:\\a b\\x.txt' 'C:\\c.txt' ");
    expect(text).not.toMatch(/[\r\n]/);
  });

  it("N-02 Git Bash and WSL get translated paths", () => {
    expect(dropText(["C:\\a b"], dropTarget("git-bash", false))).toBe("'/c/a b' ");
    expect(dropText(["C:\\a b"], dropTarget("wsl.ubuntu", false))).toBe("'/mnt/c/a b' ");
  });

  it("N-02 paths that can't be typed safely are left out", () => {
    expect(dropText(["C:\\a\nb", "C:\\c"], dropTarget("cmd", false))).toBe('"C:\\c" ');
    expect(dropText(["C:\\a\nb"], dropTarget("cmd", false))).toBe("");
    expect(dropText([], dropTarget("cmd", false))).toBe("");
  });
});
