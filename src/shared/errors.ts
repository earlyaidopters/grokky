export function userFacingError(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const cleaned = source
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return cleaned || fallback;
}
