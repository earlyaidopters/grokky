import { dialog, ipcMain, shell } from "electron";
import type { MainController } from "./controller";
import { IPC } from "../shared/contracts";
import {
  requireComputerAccessLevel,
  requireComputerApprovalDecision,
  requireComputerCapability,
  requireId,
  requireImageInputs,
  requireMessageOrImages,
  requireMessagePriority,
  requireNetworkAllowlist,
  requirePairingCode,
  requireRunnerEndpoint,
  validateAgentDraft,
  validateConversationPatch,
  validateSettingsPatch,
} from "../shared/validation";

export function registerIpc(controller: MainController): void {
  ipcMain.handle(IPC.snapshotGet, () => controller.snapshot());
  ipcMain.handle(IPC.conversationCreate, () => controller.createConversation());
  ipcMain.handle(IPC.conversationActivate, (_event, conversationId) => controller.setActiveConversation(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.conversationUpdate, (_event, conversationId, patch) => controller.updateConversation(
    requireId(conversationId, "conversation ID"),
    validateConversationPatch(patch),
  ));
  ipcMain.handle(IPC.conversationDelete, (_event, conversationId) => controller.deleteConversation(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.messageSend, (_event, conversationId, text, priority, imageInputs) => {
    const images = requireImageInputs(imageInputs);
    return controller.sendMessage(
      requireId(conversationId, "conversation ID"),
      requireMessageOrImages(text, images.length),
      requireMessagePriority(priority),
      images,
    );
  });
  ipcMain.handle(IPC.imageAttachmentData, (_event, attachmentId) => controller.getImageAttachmentData(
    requireId(attachmentId, "attachment ID"),
  ));
  ipcMain.handle(IPC.runCancel, (_event, conversationId) => controller.cancelRun(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.directoryChoose, async (_event, conversationId) => {
    const id = requireId(conversationId, "conversation ID");
    const result = await dialog.showOpenDialog({ title: "Choose Grokky workspace", properties: ["openDirectory", "createDirectory"] });
    const pathname = result.canceled ? null : result.filePaths[0] ?? null;
    if (pathname) await controller.updateConversation(id, { workingDirectory: pathname });
    return pathname;
  });
  ipcMain.handle(IPC.credentialChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose an env file containing OPENROUTER_API_KEY",
      properties: ["openFile", "showHiddenFiles"],
    });
    const pathname = result.canceled ? null : result.filePaths[0] ?? null;
    if (pathname) await controller.updateSettings({ openRouterCredentialPath: pathname });
    return pathname;
  });
  ipcMain.handle(IPC.settingsUpdate, (_event, patch) => controller.updateSettings(validateSettingsPatch(patch)));
  ipcMain.handle(IPC.providersRefresh, () => controller.refreshProviderStatuses());
  ipcMain.handle(IPC.capabilitiesGet, () => controller.getCapabilities());
  ipcMain.handle(IPC.skillToggle, (_event, pathname, enabled) => {
    if (typeof pathname !== "string" || pathname.length > 4_000 || typeof enabled !== "boolean") throw new Error("Invalid skill update");
    return controller.setSkillEnabled(pathname, enabled);
  });
  ipcMain.handle(IPC.mcpToggle, (_event, id, enabled) => {
    if (typeof id !== "string" || id.length > 240 || typeof enabled !== "boolean") throw new Error("Invalid MCP update");
    return controller.setMcpEnabled(id, enabled);
  });
  ipcMain.handle(IPC.connectorToggle, (_event, id, enabled) => {
    if (typeof id !== "string" || id.length > 240 || typeof enabled !== "boolean") throw new Error("Invalid connector update");
    return controller.setConnectorEnabled(id, enabled);
  });
  ipcMain.handle(IPC.agentsGet, () => controller.getAgents());
  ipcMain.handle(IPC.agentCreate, (_event, draft) => controller.createAgent(validateAgentDraft(draft)));
  ipcMain.handle(IPC.agentUpdate, (_event, id, draft) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(id)) throw new Error("Invalid agent ID");
    return controller.updateAgent(id, validateAgentDraft(draft));
  });
  ipcMain.handle(IPC.agentDelete, (_event, id) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(id)) throw new Error("Invalid agent ID");
    return controller.deleteAgent(id);
  });
  ipcMain.handle(IPC.computerEnabled, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid computer access setting");
    return controller.setComputerAccessEnabled(enabled);
  });
  ipcMain.handle(IPC.computerCapability, (_event, capability, level) => controller.setComputerCapability(
    requireComputerCapability(capability),
    requireComputerAccessLevel(level),
  ));
  ipcMain.handle(IPC.computerPermission, (_event, capability) => controller.requestComputerPermission(requireComputerCapability(capability)));
  ipcMain.handle(IPC.computerTest, (_event, capability) => controller.testComputerCapability(requireComputerCapability(capability)));
  ipcMain.handle(IPC.computerPair, (_event, endpoint, code) => controller.pairComputer(requireRunnerEndpoint(endpoint), requirePairingCode(code)));
  ipcMain.handle(IPC.computerSelect, (_event, deviceId) => controller.selectComputer(requireId(deviceId, "computer ID")));
  ipcMain.handle(IPC.computerRevoke, (_event, deviceId) => controller.revokeComputer(requireId(deviceId, "computer ID")));
  ipcMain.handle(IPC.computerNetworkAllowlist, (_event, domains) => controller.updateComputerNetworkAllowlist(requireNetworkAllowlist(domains)));
  ipcMain.handle(IPC.computerApprovalResolve, (_event, approvalId, decision) => controller.resolveComputerApproval(
    requireId(approvalId, "approval ID"),
    requireComputerApprovalDecision(decision),
  ));
  ipcMain.handle(IPC.externalOpen, async (_event, value) => {
    if (typeof value !== "string") throw new Error("Invalid URL");
    const url = new URL(value);
    if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("Only web links can be opened");
    await shell.openExternal(url.toString());
  });
}
