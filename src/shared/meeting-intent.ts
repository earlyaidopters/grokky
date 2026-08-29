/** Explicit collaboration intent; ordinary references to meeting notes must not create a meeting artifact. */
export function needsCrewMeeting(prompt: string): boolean {
  return /\b(?:hold|run|start|open|conduct|convene)\s+(?:an?\s+)?(?:(?:crew|review|agent|team)\s+)?meeting\b/i.test(prompt)
    || /\b(?:have|let|make)\s+(?:the\s+)?(?:agents?|crew|team|specialists?)\b.{0,40}\b(?:meet|review|challenge|debate|agree)\b/i.test(prompt)
    || /\b(?:peer review|review together|challenge (?:each other|the other)|agree on|debate together|roundtable)\b/i.test(prompt);
}
