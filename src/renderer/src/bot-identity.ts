import type { AgentIcon } from "../../shared/contracts";

export type BotVariant = AgentIcon;

const BOT_VARIANTS: BotVariant[] = ["lime", "cyan", "coral", "violet", "amber", "mint"];

const ROLE_VARIANTS: Array<{ words: string[]; variant: BotVariant }> = [
  { words: ["tester", "testing", "qa", "quality"], variant: "mint" },
  { words: ["reviewer", "review", "security", "critic", "audit"], variant: "violet" },
  { words: ["builder", "build", "implementer", "implementation", "maker"], variant: "amber" },
  { words: ["explorer", "explore", "researcher", "research", "scout"], variant: "cyan" },
  { words: ["worker", "executor", "execution"], variant: "coral" },
  { words: ["default", "lead", "coordinator", "grokky"], variant: "lime" },
];

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function botVariantForIdentity(identity: string): BotVariant {
  const identityTokens = tokens(identity);
  for (const role of ROLE_VARIANTS) {
    if (role.words.some((word) => identityTokens.includes(word))) return role.variant;
  }
  return BOT_VARIANTS[stableHash(identity) % BOT_VARIANTS.length]!;
}

export function botVariantAt(index: number): BotVariant {
  return BOT_VARIANTS[index % BOT_VARIANTS.length]!;
}
