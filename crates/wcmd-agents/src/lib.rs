//! `wcmd-agents`: the AI agent CLIs WolfCmd knows (N-06): the registry (built-in agents from
//! `resources/agents/*.toml`, plus the agents N-09 plugins declare), where each one is
//! installed, and the line that starts or resumes it in a panel's shell.

mod launch;
mod locate;
mod plugins;
mod registry;

pub use launch::Start;
pub use locate::LaunchShell;
pub use plugins::PluginProblem;
pub use registry::{Agent, AgentRegistry, Agents, Listed, Source, TitlePattern};
