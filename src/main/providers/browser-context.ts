import type { ChatMessages } from "@openrouter/sdk/models";

/** Preserve the full local transcript, but send only two recent computer frames by default. */
export function browserRequestMessages(messages: ChatMessages[], preserveImages = false): ChatMessages[] {
  if (preserveImages) return messages;
  let remaining = 2;
  return [...messages].reverse().map((message): ChatMessages => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    if (!message.content.some((item) => item.type === "image_url")) return message;
    if (remaining-- > 0) return message;
    return { ...message, content: message.content.filter((item) => item.type !== "image_url") };
  }).reverse();
}

export function needsHistoricalFrames(prompt: string): boolean {
  return /(compar|earlier|previous|historic|before and after)[\s\S]{0,100}(screenshot|image|frame)|(screenshot|image|frame)[\s\S]{0,100}(compar|earlier|previous|historic|before and after)/i.test(prompt);
}
