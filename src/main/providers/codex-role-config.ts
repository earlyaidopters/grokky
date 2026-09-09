import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import type { AgentDefinition } from "../../shared/contracts";

/** Register reviewed one-turn roles without modifying the user's agent library. */
export async function temporaryCodexRoles(agents: AgentDefinition[]) {
  const roles = agents.filter(agent => agent.id.startsWith("task:"));
  if (!roles.length) return { overrides: [] as string[], dispose: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "grokky-codex-roles-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const overrides: string[] = [];
    for (const role of roles) {
      if (!/^[a-z][a-z0-9_-]{1,63}$/.test(role.name)) throw new Error("Invalid one-time Codex role name");
      if (agents.filter(agent => agent.name === role.name).length !== 1) throw new Error("Choose a unique name for the one-time role before running this crew");
      const path = join(directory, `${role.name}.toml`);
      await writeFile(path, stringify({ name: role.name, description: role.description, developer_instructions: role.developerInstructions,
        sandbox_mode: role.sandboxMode === "workspace-write" ? "workspace-write" : "read-only",
        ...(role.model ? { model: role.model } : {}), ...(role.reasoning ? { model_reasoning_effort: role.reasoning } : {}),
      }), { mode: 0o600 });
      overrides.push(`agents.${role.name}.config_file=${JSON.stringify(path)}`);
      overrides.push(`agents.${role.name}.description=${JSON.stringify(role.description)}`);
    }
    return { overrides, dispose };
  } catch (error) { await dispose(); throw error; }
}
