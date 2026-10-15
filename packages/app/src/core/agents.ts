// N-06: the agents the Agents button lists, and the line a panel types to start one.
import {
  type AgentInfo,
  type AgentList,
  type AgentStart,
  commands,
  type PluginProblem,
} from "@wolfcmd/bindings";

import { unwrap } from "./ipc";

let cached: Promise<AgentList> | undefined;

/** Reads the list; a read that failed is forgotten, so the next call reads again. */
function read(): Promise<AgentList> {
  const reading = commands.agentList().then(unwrap);
  cached = reading;
  reading.catch(() => {
    if (cached === reading) cached = undefined;
  });
  return reading;
}

/** The agents and the plugin problems. Read once per run, and again by `reloadAgents`. */
export function agentList(): Promise<AgentList> {
  return cached ?? read();
}

/**
 * N-09: reads the list again (the Agents menu opening), so a plugin added, changed or removed
 * shows without a restart. The core reads the plugins folder only when it changed.
 */
export function reloadAgents(): Promise<AgentList> {
  return read();
}

/** The agents, installed ones first. */
export async function listAgents(): Promise<AgentInfo[]> {
  return (await agentList()).agents;
}

/**
 * N-09: the Agents menu's calm line about plugins that couldn't be used, and the details for
 * its tooltip (one line per problem); `undefined` while every plugin loads.
 */
export function pluginProblemsLine(
  problems: readonly PluginProblem[],
): { readonly label: string; readonly details: string } | undefined {
  if (problems.length === 0) return undefined;
  const plugins = new Set(problems.map((p) => p.plugin)).size;
  return {
    label: plugins === 1 ? "1 plugin has a problem" : `${String(plugins)} plugins have problems`,
    details: problems.map((p) => `${p.plugin}: ${p.message}`).join("\n"),
  };
}

/** The line to type in the panel's shell. */
export async function agentCommand(
  agent: string,
  start: AgentStart,
  profile: string | undefined,
  remoteControl: string | undefined,
): Promise<string> {
  return unwrap(
    await commands.agentCommand({
      agent,
      start,
      profile: profile ?? null,
      remoteControl: remoteControl ?? null,
    }),
  );
}
