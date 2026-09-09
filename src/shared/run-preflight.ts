const projectNouns = /\b(?:repository|repo|codebase|source code|workspace|project folder|files?|frontend|backend|website|web site|webpage|app|application|component|api|localhost)\b/i;
const projectActions = /\b(?:build|create|implement|fix|edit|change|update|refactor|debug|test|run|launch|start|write|redesign|spin)\b/i;
const developmentCommands = /\b(?:localhost|local host|dev server|development server|install (?:the )?(?:dependencies|packages)|npm|pnpm|yarn|bun|run (?:the )?(?:app|site|server|tests?|build)|start (?:the )?(?:app|site|server)|launch (?:the )?(?:app|site|server)|spin up (?:(?:the|a) )?(?:app|site|server|container|service)|serve (?:the )?(?:app|site))\b/i;
const commandNegation = /\b(?:do not|don't|never|without|must not|should not|no need to|avoid)\b/i;
const interactiveBrowser = /\b(?:use (?:your|the) (?:computer|browser)|open (?:the )?(?:browser|website|web ?page|site|url)|go (?:on|to)\b|navigate (?:to|around)|browse (?:to|the|this)|click (?:on|the)|scroll (?:through|down|up|the)|type (?:into|in) (?:the )?(?:page|field|form)|explore (?:the )?(?:website|site|page|it))\b/i;
const browserNegation = /\b(?:do not|don't|never|must not|should not|avoid)\b/i;

export function hasPositiveIntent(prompt: string, intent: RegExp): boolean {
  return prompt.split(/(?<=[.!?;\n])|\b(?:but|however|instead)\b/i)
    .some((clause) => intent.test(clause) && !commandNegation.test(clause));
}

export function requestsAgentDelegation(prompt: string): boolean {
  return hasPositiveIntent(prompt, /\b(?:delegate|(?:spin up|spawn|use|ask|have|start|launch)\b.{0,80}\b(?:agents?|specialists?|crew|subagents?))\b/i);
}

export function requestsBrowserWorkflow(prompt: string): boolean {
  return hasPositiveIntent(prompt, /\b(?:browser|flight|navigate|click|date picker|fill (?:in|out)|go (?:on|to)|search (?:on|the web)|website)\b/i);
}

export function requiresProjectDirectory(prompt: string): boolean {
  return prompt.split(/(?<=[.!?;\n])/).some((clause) => projectNouns.test(clause) && projectActions.test(clause) && !commandNegation.test(clause));
}

export function requiresDevelopmentCommands(prompt: string): boolean {
  return hasPositiveIntent(prompt, developmentCommands)
    || (projectNouns.test(prompt) && hasPositiveIntent(prompt, /\bspin it up\b/i));
}

export function requiresInteractiveBrowser(prompt: string): boolean {
  return prompt
    .split(/(?<=[.!?;\n])/)
    .some((clause) => interactiveBrowser.test(clause) && !browserNegation.test(clause));
}
