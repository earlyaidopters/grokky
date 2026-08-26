export function commandActivityLabel(command: string): string {
  const value = command.replace(/\s+/g, " ");
  if (/\b(?:npm|pnpm|yarn|bun)\b[^\n]*(?:test|vitest|jest)|\b(?:pytest|cargo test|go test)\b/i.test(value)) return "Running tests";
  if (/\b(?:npm|pnpm|yarn|bun)\b[^\n]*(?:build|compile)|\b(?:cargo build|go build)\b/i.test(value)) return "Building the project";
  if (/\b(?:npm|pnpm|yarn|bun)\b[^\n]*(?:install|add)|\b(?:pip install|bundle install)\b/i.test(value)) return "Installing dependencies";
  if (/\b(?:npm|pnpm|yarn|bun)\b[^\n]*(?:dev|start|serve)|\blocalhost\b/i.test(value)) return "Starting local development";
  if (/\b(?:git status)\b/i.test(value)) return "Checking repository status";
  if (/\b(?:git diff)\b/i.test(value)) return "Reviewing code changes";
  if (/\b(?:git log)\b/i.test(value)) return "Reviewing recent history";
  if (/SKILL\.md|AGENTS\.md|CLAUDE\.md/i.test(value)) return "Reading project guidance";
  if (/package\.json|pyproject\.toml|Cargo\.toml|go\.mod|README(?:\.md)?/i.test(value) && /\b(?:cat|sed|head|tail|bat)\b/i.test(value)) return "Reading project setup";
  if (/\brg\b[^\n]*--files|\bfind\b|\b(?:pwd|ls)\b/i.test(value)) return "Mapping the workspace";
  if (/\brg\b|\bgrep\b/i.test(value)) return "Searching the workspace";
  if (/\b(?:cat|sed|head|tail|bat)\b/i.test(value)) return "Reading source files";
  return "Running a workspace command";
}

export function looksLikeRawCommand(label: string): boolean {
  return /^\/?(?:bin\/)?(?:zsh|bash|sh)\b|^\/?(?:usr\/bin\/)?(?:env\s+)?(?:npm|pnpm|yarn|bun|git|rg|grep|sed|cat|pwd|ls|find)\b/i.test(label.trim());
}
