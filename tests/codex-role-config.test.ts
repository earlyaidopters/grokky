import { readFile, access } from "node:fs/promises";
import { parse } from "smol-toml";
import { expect, test } from "vitest";
import { temporaryCodexRoles } from "../src/main/providers/codex-role-config";

test("one-time roles register reviewed configuration and remove temporary files", async () => {
  const roles = await temporaryCodexRoles([{ id: "task:fixture", name: "reviewer_fixture", description: "Review the interface", developerInstructions: "Use this exact reviewed brief", scope: "personal", builtIn: false }]);
  const path = JSON.parse(roles.overrides[0]!.split("=").slice(1).join("="));
  try {
    expect(parse(await readFile(path, "utf8"))).toMatchObject({ name: "reviewer_fixture", developer_instructions: "Use this exact reviewed brief", sandbox_mode: "read-only" });
  } finally { await roles.dispose(); }
  await expect(access(path)).rejects.toThrow();
});
test("normal agent libraries need no temporary override", async () => {
  expect((await temporaryCodexRoles([{ id: "builtin:explorer", name: "explorer", description: "Read", developerInstructions: "Inspect", scope: "built-in", builtIn: true }])).overrides).toEqual([]);
});
