import { describe, expect, it, vi } from "vitest";

import { agentList, pluginProblemsLine } from "./agents";

const agentListCommand = vi.hoisted(() => vi.fn());
vi.mock("@wolfcmd/bindings", () => ({ commands: { agentList: agentListCommand } }));

describe("N-06 the agent list", () => {
  it("n06_agent_list_retry: a failed read is read again next time; a good one is kept", async () => {
    const list = { agents: [], problems: [] };
    agentListCommand
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue({ status: "ok", data: list });
    await expect(agentList()).rejects.toThrow("ipc down");
    await expect(agentList()).resolves.toEqual(list);
    await agentList();
    expect(agentListCommand).toHaveBeenCalledTimes(2);
  });
});

describe("N-09 the Agents menu's plugin problems line", () => {
  it("n09 shows nothing while every plugin loads", () => {
    expect(pluginProblemsLine([])).toBeUndefined();
  });

  it("n09 counts plugins, not problems, and lists each problem in the tooltip", () => {
    const line = pluginProblemsLine([
      { plugin: "cursor", message: "agent `codex`: a built-in agent has this id" },
      { plugin: "cursor", message: "agent #2: missing field `command`" },
    ]);
    expect(line?.label).toBe("1 plugin has a problem");
    expect(line?.details).toBe(
      "cursor: agent `codex`: a built-in agent has this id\ncursor: agent #2: missing field `command`",
    );
  });

  it("n09 several plugins", () => {
    const line = pluginProblemsLine([
      { plugin: "a", message: "no plugin.toml in this folder" },
      { plugin: "b", message: "plugin.toml: expected a value" },
    ]);
    expect(line?.label).toBe("2 plugins have problems");
  });
});
