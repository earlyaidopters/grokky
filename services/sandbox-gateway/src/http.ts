export const MAX_JSON_BYTES = 300_000;

export async function boundedJson(request: Request, maximum = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximum) throw new Error("Request body is too large");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximum) {
        await reader.cancel("Request body is too large");
        throw new Error("Request body is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}
