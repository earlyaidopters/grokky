import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshot, AppSettings, ConversationPatch, GrokkyApi } from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { userFacingError } from "../shared/errors";

let snapshotListener: ((_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => void) | undefined;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T;
  } catch (error) {
    throw new Error(userFacingError(error, "Grokky could not complete that request"));
  }
}

const api: GrokkyApi = {
  startPhone: (id) => invoke(IPC.phoneStart, id),
  confirmPhone: () => invoke(IPC.phoneConfirm),
  disconnectPhone: () => invoke(IPC.phoneDisconnect),
  resumePhone: () => invoke(IPC.phoneResume),
  getSnapshot: () => invoke(IPC.snapshotGet),
  createConversation: () => invoke(IPC.conversationCreate),
  setActiveConversation: (conversationId) => invoke(IPC.conversationActivate, conversationId),
  updateConversation: (conversationId, patch: ConversationPatch) => invoke(IPC.conversationUpdate, conversationId, patch),
  deleteConversation: (conversationId) => invoke(IPC.conversationDelete, conversationId),
  sendMessage: (conversationId, text, priority = "normal", images = []) => invoke(IPC.messageSend, conversationId, text, priority, images),
  getImageAttachmentData: (attachmentId) => invoke(IPC.imageAttachmentData, attachmentId),
  getAgentComputerEvidenceData: (evidenceId) => invoke(IPC.agentComputerEvidenceData, evidenceId),
  cancelRun: (conversationId) => invoke(IPC.runCancel, conversationId),
  chooseWorkingDirectory: (conversationId) => invoke(IPC.directoryChoose, conversationId),
  chooseOpenRouterCredential: () => invoke(IPC.credentialChoose),
  updateSettings: (patch: Partial<AppSettings>) => invoke(IPC.settingsUpdate, patch),
  refreshProviderStatuses: () => invoke(IPC.providersRefresh),
  getCapabilities: () => invoke(IPC.capabilitiesGet),
  setSkillEnabled: (path, enabled) => invoke(IPC.skillToggle, path, enabled),
  setMcpEnabled: (id, enabled) => invoke(IPC.mcpToggle, id, enabled),
  setConnectorEnabled: (id, enabled) => invoke(IPC.connectorToggle, id, enabled),
  createRoutine: (draft) => invoke(IPC.routineCreate, draft),
  updateRoutine: (id, patch) => invoke(IPC.routineUpdate, id, patch),
  deleteRoutine: (id) => invoke(IPC.routineDelete, id),
  runRoutine: (id) => invoke(IPC.routineRun, id),
  resolveAttention: (id) => invoke(IPC.attentionResolve, id),
  resolveAgentProposal: (conversationId, proposalId, action, draft) => invoke(IPC.agentProposalResolve, conversationId, proposalId, action, draft),
  getAgents: () => invoke(IPC.agentsGet),
  createAgent: (draft) => invoke(IPC.agentCreate, draft),
  updateAgent: (id, draft) => invoke(IPC.agentUpdate, id, draft),
  deleteAgent: (id) => invoke(IPC.agentDelete, id),
  setComputerAccessEnabled: (enabled) => invoke(IPC.computerEnabled, enabled),
  setComputerCapability: (id, level) => invoke(IPC.computerCapability, id, level),
  requestComputerPermission: (id) => invoke(IPC.computerPermission, id),
  testComputerCapability: (id) => invoke(IPC.computerTest, id),
  pairComputer: (endpoint, code) => invoke(IPC.computerPair, endpoint, code),
  selectComputer: (deviceId) => invoke(IPC.computerSelect, deviceId),
  revokeComputer: (deviceId) => invoke(IPC.computerRevoke, deviceId),
  updateComputerNetworkAllowlist: (domains) => invoke(IPC.computerNetworkAllowlist, domains),
  resolveComputerApproval: (id, decision) => invoke(IPC.computerApprovalResolve, id, decision),
  openExternal: (url) => invoke(IPC.externalOpen, url),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    if (snapshotListener) ipcRenderer.removeListener(IPC.snapshotChanged, snapshotListener);
    snapshotListener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, snapshotListener);
  },
};

contextBridge.exposeInMainWorld("grokky", api);
