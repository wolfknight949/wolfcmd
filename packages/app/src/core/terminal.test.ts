import { describe, expect, it, vi } from "vitest";

import { createAckCounter, openTerminal, routeStreamMessage } from "./terminal";

describe("N-02 terminal stream routing", () => {
  const handlers = () => ({
    onOutput: vi.fn(),
    onExit: vi.fn(),
    onCwd: vi.fn(),
    onAgentExit: vi.fn(),
  });

  it("passes raw output bytes through unchanged", () => {
    const on = handlers();
    const bytes = new Uint8Array([104, 105]);
    routeStreamMessage(bytes.buffer, on);
    expect(on.onOutput).toHaveBeenCalledExactlyOnceWith(bytes);
  });

  it("reports the exit code", () => {
    const on = handlers();
    routeStreamMessage({ exited: { code: 3 } }, on);
    expect(on.onExit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("reports an unknown exit code as null", () => {
    const on = handlers();
    routeStreamMessage({ exited: { code: null } }, on);
    expect(on.onExit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("reports the shell's folder and ignores a malformed one", () => {
    const on = handlers();
    routeStreamMessage({ cwd: "C:\\src" }, on);
    routeStreamMessage({ cwd: 42 }, on);
    expect(on.onCwd).toHaveBeenCalledExactlyOnceWith("C:\\src");
    expect(on.onExit).not.toHaveBeenCalled();
  });

  it("N-06 reports that the panel's agent ended", () => {
    const on = handlers();
    routeStreamMessage({ agentExited: true }, on);
    routeStreamMessage({ agentExited: "yes" }, on);
    expect(on.onAgentExit).toHaveBeenCalledOnce();
    expect(on.onExit).not.toHaveBeenCalled();
  });

  it("ignores anything else", () => {
    const on = handlers();
    routeStreamMessage("noise", on);
    routeStreamMessage(null, on);
    expect(on.onOutput).not.toHaveBeenCalled();
    expect(on.onExit).not.toHaveBeenCalled();
  });
});

describe("N-02 output acknowledgements", () => {
  it("stays silent for small (interactive) output", () => {
    const send = vi.fn();
    const ack = createAckCounter(send, 100);
    for (let i = 0; i < 99; i++) ack(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("acks everything processed once a step is reached", () => {
    const send = vi.fn();
    const ack = createAckCounter(send, 100);
    ack(60);
    ack(70);
    expect(send).toHaveBeenCalledExactlyOnceWith(130);
    ack(100);
    expect(send).toHaveBeenLastCalledWith(100);
  });
});

const ptyOpen = vi.hoisted(() => vi.fn());
const ptyWrite = vi.hoisted(() => vi.fn());
const ptyDetach = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
vi.mock("@wolfcmd/bindings", () => ({
  commands: {
    ptyOpen,
    ptyWrite,
    ptyDetach,
    ptyAck: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
    ptyResize: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
  },
}));

describe("N-02 opening a panel's session", () => {
  const options = (panelId: string) => ({
    cols: 80,
    rows: 24,
    profile: undefined,
    cwd: undefined,
    panelId,
    onOutput: vi.fn(),
    onCwd: vi.fn(),
    onAgentExit: vi.fn(),
    onExit: vi.fn(),
  });

  it("opens one panel's views in order, and closing a view only detaches", async () => {
    const order: string[] = [];
    let finishFirst: () => void = () => undefined;
    ptyOpen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push("open 1");
          finishFirst = () => {
            resolve({
              status: "ok",
              data: {
                sessionId: 7,
                profileName: "cmd",
                profileId: "cmd",
                integrated: true,
                agentExited: false,
                agentWorking: false,
                attachment: 1,
                attached: false,
              },
            });
          };
        }),
    );
    ptyOpen.mockImplementationOnce(() => {
      order.push("open 2");
      return Promise.resolve({
        status: "ok",
        data: {
          sessionId: 7,
          profileName: "cmd",
          profileId: "cmd",
          integrated: true,
          agentExited: true,
          agentWorking: true,
          attachment: 2,
          attached: true,
        },
      });
    });
    ptyWrite.mockResolvedValue({ status: "ok", data: null });
    ptyDetach.mockResolvedValue({ status: "ok", data: null });

    const first = openTerminal(options("p1"));
    const second = openTerminal(options("p1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second open waits for the first (React StrictMode mounts a panel twice).
    expect(order).toEqual(["open 1"]);
    finishFirst();
    const view = await first;
    const attached = await second;
    expect(order).toEqual(["open 1", "open 2"]);
    expect(view.attached).toBe(false);
    expect(attached.attached).toBe(true);

    expect(attached.agentExited).toBe(true);
    expect(attached.agentWorking).toBe(true);
    expect(attached.profileId).toBe("cmd");

    attached.write("a");
    attached.startAgent("claude\r", "claude-code");
    attached.write("b");
    // N-06: the agent's line carries its id, numbered with the keystrokes around it.
    expect(ptyWrite.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { sessionId: 7, attachment: 2, seq: 1, data: "a" },
      { sessionId: 7, attachment: 2, seq: 2, data: "claude\r", agent: "claude-code" },
      { sessionId: 7, attachment: 2, seq: 3, data: "b" },
    ]);
    view.detach();
    expect(ptyDetach).toHaveBeenCalledExactlyOnceWith({ sessionId: 7, attachment: 1 });
  });

  it("n06_strict_mode_open: a view disposed before its open never starts the shell", async () => {
    ptyOpen.mockReset();
    ptyOpen.mockResolvedValue({
      status: "ok",
      data: {
        sessionId: 9,
        profileName: "cmd",
        profileId: "cmd",
        integrated: true,
        agentExited: false,
        agentWorking: false,
        attachment: 1,
        attached: false,
      },
    });
    // StrictMode: the first mount opens and is disposed at once, the second opens.
    let firstDisposed = false;
    const first = openTerminal({ ...options("p2"), cancelled: () => firstDisposed });
    firstDisposed = true;
    const second = openTerminal({ ...options("p2"), cancelled: () => false });
    await expect(first).rejects.toThrow(/closed before/);
    // The second view started the shell itself (so its agent gets its start line).
    expect((await second).attached).toBe(false);
    expect(ptyOpen).toHaveBeenCalledOnce();
  });
});
