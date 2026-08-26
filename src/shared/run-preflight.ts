const projectNouns = /\b(?:repository|repo|codebase|source code|workspace|project folder|files?|frontend|backend|website|web site|webpage|app|application|component|api|localhost)\b/i;
const projectActions = /\b(?:build|create|implement|fix|edit|change|update|refactor|debug|test|run|launch|start|write|redesign|spin)\b/i;
const developmentCommands = /\b(?:localhost|local host|dev server|development server|install (?:the )?(?:dependencies|packages)|npm|pnpm|yarn|bun|run (?:the )?(?:app|site|server|tests?|build)|start (?:the )?(?:app|site|server)|launch (?:the )?(?:app|site|server)|spin (?:it )?up|serve (?:the )?(?:app|site))\b/i;

export function requiresProjectDirectory(prompt: string): boolean {
  return projectNouns.test(prompt) && projectActions.test(prompt);
}

export function requiresDevelopmentCommands(prompt: string): boolean {
  return developmentCommands.test(prompt);
}
