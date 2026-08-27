import { ComputerAccessService, type ComputerToolName } from "../src/main/computer-access";
import { defaultComputerAccess } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

export function computerProviderContext(conversation: Conversation) {
  const computerAccess = defaultComputerAccess();
  const service = new ComputerAccessService();
  return {
    images: [],
    readImageDataUrl: async () => { throw new Error("No image fixture is configured"); },
    computerAccess,
    executeTool: (name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }) => service.execute({
      state: computerAccess,
      conversation: options?.readOnly ? { ...conversation, sandboxMode: "read-only", allowCommands: false } : conversation,
      name,
      args,
      approvedTarget: true,
    }),
  };
}
