import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshot, AppSettings, ConversationPatch, GrokkyApi } from "../shared/contracts";
import { IPC } from "../shared/contracts";

let snapshotListener: ((_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => void) | undefined;

const api: GrokkyApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet),
  createConversation: () => ipcRenderer.invoke(IPC.conversationCreate),
  setActiveConversation: (conversationId) => ipcRenderer.invoke(IPC.conversationActivate, conversationId),
  updateConversation: (conversationId, patch: ConversationPatch) => ipcRenderer.invoke(IPC.conversationUpdate, conversationId, patch),
  deleteConversation: (conversationId) => ipcRenderer.invoke(IPC.conversationDelete, conversationId),
  sendMessage: (conversationId, text) => ipcRenderer.invoke(IPC.messageSend, conversationId, text),
  cancelRun: (conversationId) => ipcRenderer.invoke(IPC.runCancel, conversationId),
  chooseWorkingDirectory: (conversationId) => ipcRenderer.invoke(IPC.directoryChoose, conversationId),
  chooseOpenRouterCredential: () => ipcRenderer.invoke(IPC.credentialChoose),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  refreshProviderStatuses: () => ipcRenderer.invoke(IPC.providersRefresh),
  getCapabilities: () => ipcRenderer.invoke(IPC.capabilitiesGet),
  setSkillEnabled: (path, enabled) => ipcRenderer.invoke(IPC.skillToggle, path, enabled),
  setMcpEnabled: (id, enabled) => ipcRenderer.invoke(IPC.mcpToggle, id, enabled),
  setConnectorEnabled: (id, enabled) => ipcRenderer.invoke(IPC.connectorToggle, id, enabled),
  getAgents: () => ipcRenderer.invoke(IPC.agentsGet),
  createAgent: (draft) => ipcRenderer.invoke(IPC.agentCreate, draft),
  updateAgent: (id, draft) => ipcRenderer.invoke(IPC.agentUpdate, id, draft),
  deleteAgent: (id) => ipcRenderer.invoke(IPC.agentDelete, id),
  setComputerAccessEnabled: (enabled) => ipcRenderer.invoke(IPC.computerEnabled, enabled),
  setComputerCapability: (id, level) => ipcRenderer.invoke(IPC.computerCapability, id, level),
  requestComputerPermission: (id) => ipcRenderer.invoke(IPC.computerPermission, id),
  testComputerCapability: (id) => ipcRenderer.invoke(IPC.computerTest, id),
  pairComputer: (endpoint, code) => ipcRenderer.invoke(IPC.computerPair, endpoint, code),
  selectComputer: (deviceId) => ipcRenderer.invoke(IPC.computerSelect, deviceId),
  revokeComputer: (deviceId) => ipcRenderer.invoke(IPC.computerRevoke, deviceId),
  updateComputerNetworkAllowlist: (domains) => ipcRenderer.invoke(IPC.computerNetworkAllowlist, domains),
  resolveComputerApproval: (id, decision) => ipcRenderer.invoke(IPC.computerApprovalResolve, id, decision),
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    if (snapshotListener) ipcRenderer.removeListener(IPC.snapshotChanged, snapshotListener);
    snapshotListener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, snapshotListener);
  },
};

contextBridge.exposeInMainWorld("grokky", api);
