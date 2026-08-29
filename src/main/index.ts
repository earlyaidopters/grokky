import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MainController } from "./controller";
import { ComputerAccessService, isValidBrowserLiveViewUrl } from "./computer-access";
import { createElectronComputerHost, createElectronComputerSecrets } from "./computer-host-electron";
import { createElectronAgentBrowserHost } from "./agent-computer-electron";
import { registerIpc } from "./ipc";
import { StateStore } from "./state-store";
import { IPC } from "../shared/contracts";

let mainWindow: BrowserWindow | null = null;

if (process.env.GROKKY_USER_DATA_PATH) app.setPath("userData", process.env.GROKKY_USER_DATA_PATH);

async function createWindow(controller: MainController): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 640,
    minHeight: 700,
    show: false,
    title: "Grokky",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 18, y: 18 },
    } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111310" : "#f2f3ee",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: true,
    },
  });

  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isValidBrowserLiveViewUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.partition = "grokky-live-view";
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    const keepInsideLiveView = (event: Electron.Event, target: string) => {
      if (!isValidBrowserLiveViewUrl(target)) event.preventDefault();
    };
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", keepInsideLiveView);
    contents.on("will-redirect", keepInsideLiveView);
    contents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write");
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const protocol = new URL(url).protocol;
    if (protocol === "https:" || protocol === "http:") void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  controller.attachWindow(mainWindow);
  mainWindow.once("closed", () => controller.shutdown());
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

app.whenReady().then(async () => {
  const controller = new MainController(
    new StateStore(join(app.getPath("userData"), "conversations.json"), app.getPath("home")),
    app.getPath("home"),
    app.getVersion(),
    new ComputerAccessService({
      host: createElectronComputerHost(join(app.getPath("temp"), "grokky-captures")),
      secrets: createElectronComputerSecrets(),
    }),
    createElectronAgentBrowserHost(join(app.getPath("userData"), "agent-computer-evidence")),
  );
  await controller.initialize();
  registerIpc(controller);
  await createWindow(controller);

  const smokeExitMs = Number(process.env.GROKKY_SMOKE_EXIT_MS || 0);
  if (smokeExitMs > 0 && mainWindow) {
    try {
      const rendererReady = await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (window.grokky && document.querySelector('.app-shell')) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`,
      );
      if (!rendererReady) throw new Error("renderer did not expose its bridge and app shell");
      const smokeWidth = Number(process.env.GROKKY_SMOKE_WIDTH || 0);
      const smokeHeight = Number(process.env.GROKKY_SMOKE_HEIGHT || 0);
      if (smokeWidth > 0 && smokeHeight > 0) {
        mainWindow.setContentSize(smokeWidth, smokeHeight);
        const [actualWidth, actualHeight] = mainWindow.getContentSize();
        if (actualWidth !== smokeWidth || actualHeight !== smokeHeight) {
          throw new Error(`requested smoke viewport ${smokeWidth}x${smokeHeight}, received ${actualWidth}x${actualHeight}`);
        }
      }
      if (process.env.GROKKY_SMOKE_SCREENSHOT_PATH) {
        const smokeView = process.env.GROKKY_SMOKE_VIEW;
        const smokeConversationCount = controller.snapshot().conversations.length;
        if (smokeView === "light-theme") {
          await mainWindow.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`);
        } else if (smokeView === "image-input") {
          await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const makeImage = (name, primary, secondary, label) => new Promise((resolveImage) => {
              const canvas = document.createElement('canvas');
              canvas.width = 720;
              canvas.height = 440;
              const context = canvas.getContext('2d');
              const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
              gradient.addColorStop(0, primary);
              gradient.addColorStop(1, secondary);
              context.fillStyle = gradient;
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.fillStyle = 'rgba(255,255,255,.92)';
              context.font = '700 38px system-ui';
              context.fillText(label, 46, 78);
              context.fillStyle = 'rgba(255,255,255,.13)';
              context.fillRect(46, 116, 420, 18);
              context.fillRect(46, 151, 560, 18);
              context.fillRect(46, 186, 360, 18);
              context.strokeStyle = 'rgba(255,255,255,.35)';
              context.lineWidth = 2;
              context.strokeRect(46, 245, 628, 142);
              canvas.toBlob((blob) => resolveImage(new File([blob], name, { type: 'image/png' })), 'image/png');
            });
            Promise.all([
              makeImage('grok-bot-reference.png', '#20392e', '#050706', 'Grok Bot reference'),
              makeImage('grokky-current-ui.png', '#163849', '#07090b', 'Grokky current UI'),
            ]).then((files) => {
              const transfer = new DataTransfer();
              files.forEach((file) => transfer.items.add(file));
              const input = document.querySelector('.composer-image-input');
              if (!(input instanceof HTMLInputElement)) throw new Error('image input is missing');
              input.files = transfer.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              const textarea = document.querySelector('.composer textarea');
              if (textarea instanceof HTMLTextAreaElement) {
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(textarea, 'Compare these interface references and preserve the strongest visual mechanics.');
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
              }
              resolve(true);
            }).catch(reject);
          })`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else if (smokeView === "session-delete") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.session-delete')?.focus()`);
        } else if (smokeView === "session-delete-click") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.session-delete')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        } else if (smokeView === "computer-approval") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          const device = snapshot.computerAccess.devices.find((item) => item.id === snapshot.computerAccess.activeDeviceId) || snapshot.computerAccess.devices[0];
          if (!active || !device) throw new Error("computer approval smoke requires an active conversation and computer");
          snapshot.computerAccess.pendingApproval = {
            id: "smoke-computer-approval",
            conversationId: active.id,
            capability: "commands",
            deviceId: device.id,
            deviceName: device.name,
            action: "run_command",
            target: "npm test -- --runInBand --reporter=verbose packages/renderer/tests/authorization-target-with-a-deliberately-long-name.test.ts",
            createdAt: Date.now(),
          };
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else if (smokeView === "typography") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          if (!active) throw new Error("typography smoke requires an active conversation");
          const now = Date.now();
          active.title = "Crew identity check";
          active.messages = [
            { id: "smoke-user", role: "user", content: "Ask explorer and worker to report their assigned task and readiness.", createdAt: now - 2000, provider: active.provider },
            { id: "smoke-assistant", role: "assistant", content: "| Agent name | Assigned task | Readiness |\n| --- | --- | --- |\n| explorer | Independently report identity and readiness for the crew identity check | Ready |\n| worker | Independently report identity and readiness for the crew identity check | Ready |", createdAt: now, provider: active.provider },
          ];
          active.activities = [{
            id: "smoke-coordinator",
            kind: "notice",
            label: "Coordinator update",
            detail: "I’m starting the explorer and worker identity checks in parallel. Each will report only its name, assigned task, and one-word readiness status.",
            status: "completed",
            createdAt: now - 1000,
          }];
          active.selectedAgentIds = [];
          active.agentRuns = [];
          active.status = "idle";
          delete active.error;
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await mainWindow.webContents.executeJavaScript(`
            document.documentElement.dataset.accent = 'ultraviolet';
            const row = document.querySelector('.activity-row');
            if (row instanceof HTMLDetailsElement) row.open = true;
          `);
        } else if (smokeView === "activity-live" || smokeView === "activity-compact") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          if (!active) throw new Error("activity smoke requires an active conversation");
          const now = Date.now();
          active.title = "Workspace audit";
          active.messages = [{ id: "smoke-user", role: "user", content: "Map the workspace and tell me what needs attention.", createdAt: now, provider: active.provider }];
          active.activities = smokeView === "activity-compact"
            ? [
                { id: "smoke-map", kind: "command", label: "/bin/zsh -lc 'pwd && rg --files | sed -n 1,160p'", status: "completed", createdAt: now - 7000 },
                { id: "smoke-note-1", kind: "notice", label: "Coordinator update", detail: "Using the frontend design guidance for this build.", status: "completed", createdAt: now - 6000 },
                { id: "smoke-skill-1", kind: "command", label: "/bin/zsh -lc 'sed -n 1,260p /tmp/.codex/skills/taste/SKILL.md'", status: "completed", createdAt: now - 5000 },
                { id: "smoke-skill-2", kind: "command", label: "/bin/zsh -lc 'sed -n 261,620p /tmp/.codex/skills/taste/SKILL.md'", status: "completed", createdAt: now - 4000 },
                { id: "smoke-skill-3", kind: "command", label: "/bin/zsh -lc 'sed -n 621,900p /tmp/.codex/skills/taste/SKILL.md'", status: "completed", createdAt: now - 3000 },
                { id: "smoke-note-2", kind: "notice", label: "Coordinator update", detail: "Project context is loaded. Moving into implementation.", status: "completed", createdAt: now - 2000 },
                { id: "smoke-skill-4", kind: "command", label: "/bin/zsh -lc 'sed -n 1,320p /tmp/.codex/skills/imagegen/SKILL.md'", status: "completed", createdAt: now - 1000 },
                { id: "smoke-skill-5", kind: "command", label: "/bin/zsh -lc 'sed -n 321,520p /tmp/.codex/skills/imagegen/SKILL.md'", status: "running", createdAt: now },
              ]
            : [
                { id: "smoke-plan", kind: "plan", label: "Mapped the request", detail: "Scope locked to the active workspace.", status: "completed", createdAt: now - 2000 },
                { id: "smoke-files", kind: "files", label: "Reading project structure", detail: "Scanning source, configuration, and test files.", status: "completed", createdAt: now - 1000 },
                { id: "smoke-command", kind: "command", label: "Checking the build", detail: "npm run verify", status: "running", createdAt: now },
              ];
          active.selectedAgentIds = [];
          active.agentRuns = [];
          active.status = "running";
          delete active.error;
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else if (smokeView === "computer-history") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          const device = snapshot.computerAccess.devices.find((item) => item.id === snapshot.computerAccess.activeDeviceId) || snapshot.computerAccess.devices[0];
          if (!active || !device) throw new Error("computer history smoke requires an active conversation and computer");
          const now = Date.now();
          const archivedComputer = {
            id: "archived-lead-seat",
            conversationId: active.id,
            agentId: "grokky-lead",
            agentName: "Grokky lead",
            role: "lead" as const,
            icon: "lime" as const,
            status: "completed" as const,
            isolation: "policy-session" as const,
            deviceId: device.id,
            deviceName: device.name,
            workspaceRoot: active.workingDirectory,
            task: "Inspect the previous turn",
            actions: [{ id: "archived-action", capability: "files" as const, action: "read_file", target: "README.md", status: "completed" as const, detail: "Read project context", createdAt: now - 2_000, updatedAt: now - 1_900 }],
            evidence: [],
            createdAt: now - 3_000,
            updatedAt: now - 1_000,
          };
          active.title = "Historical Watch";
          active.messages = [{
            id: "historical-user-turn",
            role: "user",
            content: "Inspect the previous turn and retain its computer record.",
            createdAt: now - 3_000,
            provider: active.provider,
            crew: {
              agentRuns: [],
              communications: [],
              tasks: [],
              meetings: [],
              agentComputers: [archivedComputer],
              activities: [],
              lastRunOutcome: "delivered" as const,
              updatedAt: now - 1_000,
            },
          }];
          active.activities = [];
          active.agentRuns = [];
          active.crewCommunications = [];
          active.agentTasks = [];
          active.agentMeetings = [];
          active.agentComputers = [];
          active.status = "idle";
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 220));
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.archived-computer-history button')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 180));
        } else if (smokeView === "agent-watch" || smokeView === "agent-watch-auto") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          const device = snapshot.computerAccess.devices.find((item) => item.id === snapshot.computerAccess.activeDeviceId) || snapshot.computerAccess.devices[0];
          if (!active || !device) throw new Error("agent watch smoke requires an active conversation and computer");
          const now = Date.now();
          active.title = "Agent computer watch";
          active.provider = "openrouter";
          active.model = "openai/gpt-5.2";
          active.messages = [{ id: "smoke-user", role: "user", content: "Research the current product page and keep me posted.", createdAt: now - 4_000, provider: "openrouter" }];
          active.agentComputers = [{
            id: "agent-computer-smoke-lead",
            conversationId: active.id,
            agentId: "grokky-lead",
            agentName: "Grokky lead",
            role: "lead",
            icon: "lime",
            status: "working",
            isolation: "cloud-browser",
            deviceId: device.id,
            deviceName: device.name,
            workspaceRoot: active.workingDirectory,
            currentAction: "Reading the product page",
            currentTarget: "https://example.com/product",
            currentUrl: "https://example.com/product",
            pageTitle: "Product overview",
            task: "Research the current product page and return verified findings",
            actions: [
              { id: "smoke-action-1", capability: "files", action: "read_file", target: "README.md", status: "completed", detail: "Read project context", createdAt: now - 3_000, updatedAt: now - 2_800 },
              { id: "smoke-action-unknown", capability: "commands", action: "run_command", target: "npm test", status: "indeterminate", detail: "The run stopped while the command was in flight; its final external outcome is unknown", createdAt: now - 1_600, updatedAt: now - 1_200 },
              { id: "smoke-action-2", capability: "browser", action: "browse_url", target: "https://example.com/product", status: "running", createdAt: now - 900, updatedAt: now - 900 },
            ],
            evidence: [],
            createdAt: now - 3_500,
            updatedAt: now,
          }];
          snapshot.agentComputerLiveViews["agent-computer-smoke-lead"] = process.env.GROKKY_SMOKE_LIVE_VIEW_URL
            || "https://live.browser.run/ui/view?mode=tab&wss=smoke-test";
          active.status = "running";
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (smokeView === "agent-watch") await mainWindow.webContents.executeJavaScript(`document.querySelector('.watch-toolbar')?.click()`);
          if (smokeView === "agent-watch-auto") {
            await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
              const deadline = Date.now() + 3000;
              const check = () => {
                const ready = document.querySelector('.agent-watch-resizer') && document.querySelector('[aria-label="Zoom live desktop in"]');
                if (ready || Date.now() >= deadline) resolve(Boolean(ready));
                else setTimeout(check, 50);
              };
              check();
            })`);
            await mainWindow.webContents.executeJavaScript(`{
              const resizer = document.querySelector('.session-sidebar-resizer');
              if (resizer instanceof HTMLElement) {
                for (let index = 0; index < 6; index += 1) resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
              }
              const watchResizer = document.querySelector('.agent-watch-resizer');
              if (watchResizer instanceof HTMLElement) {
                for (let index = 0; index < 2; index += 1) watchResizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
              }
              document.querySelector('[aria-label="Zoom live desktop in"]')?.click();
            }`);
          }
          await new Promise((resolve) => setTimeout(resolve, 220));
        } else if (["crew-live", "crew-parallel", "crew-synthesis", "crew-tasks", "crew-meeting"].includes(smokeView || "")) {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          const crew = (await controller.getAgents()).filter((agent) => agent.id !== "builtin:default").slice(0, 2);
          if (!active || crew.length < 2) throw new Error("crew live smoke requires an active conversation and two agents");
          const now = Date.now();
          active.title = "Live crew check";
          active.messages = [{ id: "smoke-user", role: "user", content: "Audit the interface together and report what each of you finds.", createdAt: now, provider: active.provider }];
          active.activities = [];
          active.selectedAgentIds = crew.map((agent) => agent.id);
          active.agentRuns = [];
          active.crewCommunications = [];
          active.agentTasks = [];
          active.agentMeetings = [];
          if (smokeView === "crew-parallel") {
            active.agentRuns = crew.slice(0, 1).map((agent, index) => ({
              id: `smoke-thread-${index}`,
              operationId: `smoke-spawn-${index}`,
              threadId: `smoke-thread-${index}`,
              name: agent.name,
              task: index === 0 ? "Trace the renderer state and identify the cause" : "Independently verify the interaction and edge cases",
              status: index === 0 ? "working" : "waiting",
              ...(agent.icon ? { icon: agent.icon } : {}),
              createdAt: now,
              updatedAt: now,
            }));
            active.crewCommunications = crew.slice(0, 1).map((agent, index) => ({
              id: `smoke-assignment-${index}`,
              operationId: `smoke-spawn-${index}`,
              tool: "spawn_agent",
              kind: "assignment",
              senderThreadId: active.id,
              senderName: "Grokky lead",
              receiverThreadId: `smoke-thread-${index}`,
              receiverName: agent.name,
              content: index === 0 ? "Trace the renderer state and identify the cause." : "Independently verify the interaction and edge cases.",
              status: "completed",
              createdAt: now - 1200 + index * 180,
            }));
            active.activities = [
              { id: "smoke-lead-1", kind: "notice", label: "Coordinator update", detail: "The explorer is tracing the renderer while I keep the interaction map current.", status: "completed", createdAt: now - 2_400 },
              { id: "smoke-lead-2", kind: "notice", label: "Coordinator update", detail: "The first evidence is in. I’m routing it to the next specialist without restarting the work.", status: "completed", createdAt: now - 900 },
              { id: "smoke-thread-0:read", kind: "files", label: "Reading the message renderer", status: "running", createdAt: now },
            ];
            active.queuedMessages = [{ id: "smoke-queued", content: "Also compare the empty and interrupted states before you finish.", priority: "normal", createdAt: now }];
          } else if (["crew-synthesis", "crew-tasks", "crew-meeting"].includes(smokeView || "")) {
            active.agentRuns = crew.map((agent, index) => ({
              id: `smoke-thread-${index}`,
              operationId: `smoke-wait-${index}`,
              threadId: `smoke-thread-${index}`,
              name: agent.name,
              task: index === 0 ? "Trace the renderer state and identify the cause" : "Independently verify the interaction and edge cases",
              status: "completed",
              ...(agent.icon ? { icon: agent.icon } : {}),
              result: index === 0 ? "The renderer hid selected crew until the first orchestration event." : "The immediate queued state and live handoff now cover the missing feedback window.",
              createdAt: now,
              updatedAt: now,
            }));
            active.crewCommunications = crew.flatMap((agent, index) => [
              {
                id: `smoke-assignment-${index}`,
                operationId: `smoke-spawn-${index}`,
                tool: "spawn_agent",
                kind: "assignment" as const,
                senderThreadId: active.id,
                senderName: "Grokky lead",
                receiverThreadId: `smoke-thread-${index}`,
                receiverName: agent.name,
                content: index === 0 ? "Trace the renderer state and identify the cause." : "Independently verify the interaction and edge cases.",
                status: "completed" as const,
                createdAt: now - 2200 + index * 180,
              },
              {
                id: `smoke-report-${index}`,
                operationId: `smoke-wait-${index}`,
                tool: "wait",
                kind: "report" as const,
                senderThreadId: `smoke-thread-${index}`,
                senderName: agent.name,
                receiverThreadId: active.id,
                receiverName: "Grokky lead",
                content: index === 0 ? "The renderer hid selected crew until the first orchestration event." : "The queued state and live handoff now cover the missing feedback window.",
                status: "completed" as const,
                createdAt: now - 900 + index * 180,
              },
            ]);
            active.agentTasks = crew.map((agent, index) => ({
              id: `smoke-task-${index}`,
              operationId: `smoke-spawn-${index}`,
              fromThreadId: active.id,
              fromName: "Grokky lead",
              toThreadId: `smoke-thread-${index}`,
              toName: agent.name,
              title: index === 0 ? "Trace the renderer state" : "Verify the interaction edge cases",
              instructions: index === 0 ? "Trace the renderer state and identify the cause." : "Independently verify the interaction and edge cases.",
              acceptanceCriteria: [index === 0 ? "Report the exact renderer cause" : "Return independent verification evidence"],
              status: "completed" as const,
              result: index === 0 ? "The selected crew was hidden before orchestration began." : "Queued state and live handoff now cover the feedback window.",
              createdAt: now - 2200 + index * 180,
              updatedAt: now - 900 + index * 180,
            }));
            active.agentMeetings = [{
              id: "smoke-meeting",
              title: "Interface review",
              agenda: "Challenge the renderer diagnosis and agree on the smallest complete fix.",
              participantThreadIds: crew.map((_, index) => `smoke-thread-${index}`),
              participantNames: crew.map((agent) => agent.name),
              status: "completed" as const,
              contributions: crew.map((agent, index) => ({
                id: `smoke-meeting-turn-${index}`,
                speakerThreadId: `smoke-thread-${index}`,
                speakerName: agent.name,
                kind: index === 0 ? "response" as const : "challenge" as const,
                content: index === 0 ? "Show the crew immediately after send." : "Also preserve queued agents until their handoff starts.",
                createdAt: now - 700 + index * 180,
              })),
              decisions: ["Show selected crew immediately and preserve queued handoffs."],
              actionItems: ["Keep the task and meeting ledgers attached to the originating turn."],
              createdAt: now - 800,
              updatedAt: now - 300,
            }];
          }
          active.status = "running";
          delete active.error;
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (["crew-synthesis", "crew-tasks", "crew-meeting"].includes(smokeView || "")) {
            const targetTab = smokeView === "crew-tasks" ? "tasks" : smokeView === "crew-meeting" ? "meeting" : "messages";
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.crew-tab[aria-controls^="crew-panel-${targetTab}-"]')?.click()`);
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        } else if (smokeView === "delete-dialog" || smokeView === "delete-cancel" || smokeView === "delete-complete") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.toolbar-actions .icon-button.danger')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (smokeView === "delete-cancel") {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.delete-cancel')?.click()`);
          } else if (smokeView === "delete-complete") {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.delete-confirm')?.click()`);
          }
        } else if (smokeView === "crew" || smokeView === "crew-dismiss" || smokeView === "crew-escape" || smokeView === "crew-inside" || smokeView === "crew-select-one") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.crew-picker-trigger')?.click()`);
          if (smokeView === "crew-dismiss") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.workspace-toolbar')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
          } else if (smokeView === "crew-escape") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          } else if (smokeView === "crew-inside") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.crew-picker-list > button')?.click()`);
          } else if (smokeView === "crew-select-one") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.crew-picker-list > button:last-child')?.click()`);
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        } else if (smokeView === "agents" || smokeView === "agent-editor" || smokeView === "agent-select") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="agents"]')?.click()`);
          if (smokeView === "agent-editor" || smokeView === "agent-select") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.agent-template-strip > button:nth-child(2)')?.click()`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.agent-icon-picker > button:nth-child(5)')?.click()`);
            if (smokeView === "agent-select") {
              await new Promise((resolve) => setTimeout(resolve, 100));
              await mainWindow.webContents.executeJavaScript(`document.querySelector('.agent-form-grid .select-menu-trigger')?.click()`);
            }
          }
        } else if (smokeView === "skills") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="skills"]')?.click()`);
        } else if (smokeView === "computer" || smokeView === "computer-pair") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="computer"]')?.click()`);
          if (smokeView === "computer-pair") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.computer-section-heading button')?.click()`);
          }
        } else if (smokeView === "web-settings") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="session"]')?.click()`);
        } else if (smokeView === "preflight-access") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          if (!active) throw new Error("access preflight smoke requires an active conversation");
          active.projectMode = "project";
          active.workingDirectory = process.cwd();
          active.sandboxMode = "workspace-write";
          active.allowCommands = false;
          active.messages = [];
          active.activities = [];
          active.agentRuns = [];
          active.status = "idle";
          delete active.error;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 200));
          await mainWindow.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('grokky:starter', { detail: 'Build a beautiful website and spin it up on local host' }))`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.send-button')?.click()`);
        } else if (smokeView === "project-menu" || smokeView === "access-menu") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          if (!active) throw new Error("composer menu smoke requires an active conversation");
          if (smokeView === "project-menu") await controller.updateConversation(active.id, { projectMode: "project", workingDirectory: process.cwd() });
          const selector = smokeView === "project-menu" ? ".project-picker-trigger" : ".access-picker-trigger";
          await new Promise((resolve) => setTimeout(resolve, 150));
          await mainWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
        } else if (smokeView === "model-menu" || smokeView === "reasoning-menu" || smokeView === "openrouter-model-menu") {
          const snapshot = controller.snapshot();
          const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId) || snapshot.conversations[0];
          if (!active) throw new Error("toolbar menu smoke requires an active conversation");
          const now = Date.now();
          active.provider = smokeView === "openrouter-model-menu" ? "openrouter" : "codex";
          active.model = smokeView === "openrouter-model-menu" ? "openai/gpt-5.2" : "gpt-5.6-sol";
          active.messages = [{ id: "smoke-user", role: "user", content: "Can you trace why this layer is appearing in the wrong place?", createdAt: now, provider: active.provider }];
          active.activities = [];
          active.agentRuns = [];
          active.status = "idle";
          delete active.error;
          active.updatedAt = now;
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const menuSelector = smokeView === "model-menu"
            ? ".model-field .select-menu-trigger"
            : smokeView === "reasoning-menu"
              ? ".reasoning-field .select-menu-trigger"
              : ".model-field .model-combobox > input";
          await mainWindow.webContents.executeJavaScript(`(() => {
            const trigger = document.querySelector(${JSON.stringify(menuSelector)});
            if (trigger instanceof HTMLInputElement) trigger.focus();
            else if (trigger instanceof HTMLButtonElement) trigger.click();
          })()`);
        } else if (smokeView === "settings-select") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="session"]')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.settings-body .select-menu-trigger')?.click()`);
        } else if (smokeView === "accent-palette") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="session"]')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.signal-palette [data-palette="electric-blue"]')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        } else if (smokeView === "mcp" || smokeView === "connectors") {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-tab="session"]')?.click()`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-view="${smokeView}"]')?.click()`);
        }
        if (["skills", "mcp", "connectors"].includes(smokeView || "")) {
          await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
            const deadline = Date.now() + 3000;
            const check = () => {
              if (document.querySelector('.capability-row, .capability-empty') || Date.now() >= deadline) resolve(true);
              else setTimeout(check, 50);
            };
            check();
          })`);
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (process.env.GROKKY_SMOKE_LAYOUT_ASSERT === "1") {
          const layout = await mainWindow.webContents.executeJavaScript(`(async () => {
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const requestedViewport = { width: ${smokeWidth || 0}, height: ${smokeHeight || 0} };
            const selectors = ['.app-shell', '.brand-row', '.workspace-toolbar', '.message-scroll', '.composer-wrap', '.sidebar-footer'];
            const bounds = Object.fromEntries(selectors.map((selector) => {
              const rect = document.querySelector(selector)?.getBoundingClientRect();
              return [selector, rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } : null];
            }));
            const violations = Object.entries(bounds).flatMap(([selector, rect]) => {
              if (!rect) return [selector + ' is missing'];
              const failures = [];
              if (rect.top < -0.5) failures.push(selector + ' is above the viewport');
              if (rect.left < -0.5) failures.push(selector + ' is left of the viewport');
              if (rect.right > viewport.width + 0.5) failures.push(selector + ' is right of the viewport');
              if (rect.bottom > viewport.height + 0.5) failures.push(selector + ' is below the viewport');
              return failures;
            });
            if (requestedViewport.width > 0 && viewport.width !== requestedViewport.width) violations.push('viewport width does not match the requested smoke width');
            if (requestedViewport.height > 0 && viewport.height !== requestedViewport.height) violations.push('viewport height does not match the requested smoke height');
            const footer = bounds['.sidebar-footer'];
            if (footer && footer.height < 108) violations.push('.sidebar-footer collapsed below its required height');
            document.querySelectorAll('.sidebar-footer button').forEach((button, index) => {
              const rect = button.getBoundingClientRect();
              if (rect.height < 30) violations.push('.sidebar-footer button ' + index + ' collapsed');
            });
            if (['session-delete', 'session-delete-click'].includes(${JSON.stringify(smokeView)})) {
              const entry = document.querySelector('.session-entry')?.getBoundingClientRect();
              const item = document.querySelector('.session-item')?.getBoundingClientRect();
              const action = document.querySelector('.session-delete')?.getBoundingClientRect();
              if (!entry || !action) violations.push('session delete action is missing');
              if (document.querySelectorAll('.session-delete').length !== 1) violations.push('sidebar exposes more than one delete action');
              if (entry && action && (action.top < entry.top || action.bottom > entry.bottom || action.left < entry.left || action.right > entry.right)) {
                violations.push('session delete action is not contained by its chat row');
              }
              if (item && action && item.right > action.left + 0.5) violations.push('session delete action overlaps its chat button');
              const transform = document.querySelector('.session-delete') ? getComputedStyle(document.querySelector('.session-delete')).transform : '';
              if (transform && transform !== 'none') violations.push('session delete action shifts when focused or pressed');
            }
            if (${JSON.stringify(smokeView)} === 'session-delete-click') {
              const dialog = document.querySelector('.delete-dialog[role="alertdialog"]');
              if (!dialog) violations.push('one session delete click did not open confirmation');
              if (document.querySelectorAll('.session-entry').length !== ${smokeConversationCount}) violations.push('opening sidebar delete confirmation changed the conversation count');
            }
            if (['agent-editor', 'agent-select'].includes(${JSON.stringify(smokeView)})) {
              const choices = document.querySelectorAll('.agent-icon-picker > button');
              if (choices.length !== 6) violations.push('agent icon picker does not expose six choices');
              if (document.querySelectorAll('.agent-icon-picker > button[aria-pressed="true"]').length !== 1) violations.push('agent icon picker does not have exactly one selected choice');
              const actions = document.querySelector('.agent-editor-actions')?.getBoundingClientRect();
              const dialog = document.querySelector('.settings-dialog')?.getBoundingClientRect();
              if (!actions || !dialog || actions.top < dialog.top || actions.bottom > dialog.bottom) violations.push('agent editor actions are not persistently visible');
              if (document.querySelector('.agent-form select')) violations.push('agent editor still exposes a native select control');
            }
            if (${JSON.stringify(smokeView)} === 'agents') {
              const hero = document.querySelector('.agent-hero')?.getBoundingClientRect();
              const templateCopy = document.querySelector('.agent-template-strip small');
              if (!hero || hero.height > 150) violations.push('agent settings hero is still visually oversized');
              if (!templateCopy || getComputedStyle(templateCopy).whiteSpace !== 'normal') violations.push('agent template descriptions are still truncated to one line');
            }
            if (${JSON.stringify(smokeView)} === 'skills') {
              const firstDescription = document.querySelector('.capability-row .settings-copy small');
              if (!firstDescription || Number.parseFloat(getComputedStyle(firstDescription).fontSize) < 11) violations.push('skill descriptions are too small to scan comfortably');
            }
            if (['skills', 'mcp', 'connectors'].includes(${JSON.stringify(smokeView)})) {
              const capabilityList = document.querySelector('.capability-list');
              const overflowY = capabilityList ? getComputedStyle(capabilityList).overflowY : '';
              if (!capabilityList) violations.push('capability list is missing');
              if (!['auto', 'scroll'].includes(overflowY)) violations.push('capability list does not allow vertical scrolling');
              if (${JSON.stringify(smokeView)} === 'skills' && capabilityList instanceof HTMLElement) {
                if (capabilityList.scrollHeight <= capabilityList.clientHeight) {
                  violations.push('skills smoke fixture does not exercise an overflowing list');
                } else {
                  capabilityList.scrollTop = 120;
                  if (capabilityList.scrollTop === 0) violations.push('skills list could not be scrolled');
                }
              }
            }
            if (${JSON.stringify(smokeView)} === 'web-settings') {
              const dialog = document.querySelector('.settings-dialog[role="dialog"]');
              if (!dialog) violations.push('settings dialog did not open');
              const toggle = dialog?.querySelector('input[aria-label="Live web search"]');
              if (!toggle) violations.push('live web search toggle is missing');
              if (!toggle?.checked) violations.push('live web search is not enabled by default');
              const status = document.querySelector('.web-access-status.enabled');
              if (!status || status.textContent?.trim() !== 'Web on') violations.push('composer does not show Web on');
              if (dialog?.querySelector('select')) violations.push('settings still exposes a native select control');
              const settingsBody = dialog?.querySelector('.settings-body');
              if (settingsBody && getComputedStyle(settingsBody).backgroundImage !== 'none') violations.push('settings content still uses a distracting grid background');
            }
            if (${JSON.stringify(smokeView)} === 'image-input') {
              const previews = document.querySelectorAll('.composer-image-preview');
              const input = document.querySelector('.composer-image-input');
              const attach = document.querySelector('.composer-attach-button');
              const send = document.querySelector('.composer > .send-button');
              const composer = document.querySelector('.composer')?.getBoundingClientRect();
              const previewRow = document.querySelector('.composer-image-previews')?.getBoundingClientRect();
              const attachRect = attach?.getBoundingClientRect();
              const sendRect = send?.getBoundingClientRect();
              if (previews.length !== 2) violations.push('composer did not stage both selected images');
              if (!(input instanceof HTMLInputElement) || !input.accept.includes('image/png') || !input.multiple) violations.push('image picker does not expose the expected image formats and multiple selection');
              if (attach?.textContent?.trim() !== '2') violations.push('attachment control does not show the staged image count');
              if (!document.querySelector('.composer-image-preview button[aria-label^="Remove"]')) violations.push('staged images cannot be removed');
              if (!document.querySelector('.composer textarea')?.textContent && !(document.querySelector('.composer textarea') instanceof HTMLTextAreaElement && document.querySelector('.composer textarea').value.includes('Compare these interface'))) violations.push('image fixture prompt did not render');
              if (!previewRow) violations.push('image preview row is missing');
              if (composer && previewRow && (previewRow.top < composer.top - 0.5 || previewRow.bottom > composer.bottom + 0.5)) violations.push('image preview row escaped the composer');
              if (!attachRect || !sendRect) violations.push('composer media or send control is missing');
              if (attachRect && sendRect && Math.abs(attachRect.height - sendRect.height) > 0.5) violations.push('composer media and send controls have different heights');
              if (attachRect && sendRect && Math.abs(attachRect.bottom - sendRect.bottom) > 0.5) violations.push('composer media and send controls do not share a baseline');
            }
            if (${JSON.stringify(smokeView)} === 'project-menu') {
              const menu = document.querySelector('.project-picker-popover');
              const trigger = document.querySelector('.project-picker-trigger');
              if (!menu) violations.push('project picker did not open');
              if (!menu?.querySelector('.project-search input')) violations.push('project search is missing');
              if (!menu?.textContent?.includes('Choose or create project')) violations.push('choose or create project action is missing');
              if (!menu?.textContent?.includes("Don't work in a project")) violations.push('no-project action is missing');
              if (!trigger?.classList.contains('has-project')) violations.push('selected project is not reflected in the trigger');
              const rect = menu?.getBoundingClientRect();
              if (rect && (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height)) violations.push('project picker escaped the viewport');
            }
            if (${JSON.stringify(smokeView)} === 'access-menu') {
              const menu = document.querySelector('.access-picker-popover');
              if (!menu) violations.push('access picker did not open');
              if (menu?.querySelectorAll('button').length !== 3) violations.push('access picker does not expose three modes');
              if (!menu?.textContent?.includes('Full access')) violations.push('full access option is missing');
              const description = menu?.querySelector('small');
              if (description && getComputedStyle(description).whiteSpace !== 'normal') violations.push('access descriptions are still constrained to one line');
              const rect = menu?.getBoundingClientRect();
              if (rect && (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height)) violations.push('access picker escaped the viewport');
            }
            if (${JSON.stringify(smokeView)} === 'preflight-access') {
              const menu = document.querySelector('.access-picker-popover');
              const trigger = document.querySelector('.access-picker-trigger');
              const note = document.querySelector('.composer-preflight-note');
              const draft = document.querySelector('.composer textarea');
              if (!menu) violations.push('access preflight did not open the access picker');
              if (!trigger?.classList.contains('needs-attention')) violations.push('access preflight did not identify the relevant control');
              if (note?.textContent?.trim() !== 'Choose Full access to continue') violations.push('access preflight guidance is missing or unclear');
              if (draft?.value !== 'Build a beautiful website and spin it up on local host') violations.push('access preflight did not preserve the draft');
              if (document.querySelector('.toast')) violations.push('access preflight incorrectly displayed a global error toast');
              if (document.body.textContent?.includes('Error invoking remote method')) violations.push('raw IPC implementation detail leaked into the UI');
              if (document.querySelector('.message.user')) violations.push('access preflight sent the message before access was granted');
              const rect = menu?.getBoundingClientRect();
              if (rect && (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height)) violations.push('access preflight picker escaped the viewport');
            }
            if (['model-menu', 'reasoning-menu', 'openrouter-model-menu', 'settings-select', 'agent-select'].includes(${JSON.stringify(smokeView)})) {
              const menu = document.querySelector('.select-menu-popover, .model-combobox-popover');
              if (!menu) violations.push('custom select menu did not open');
              const rect = menu?.getBoundingClientRect();
              if (rect && (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height)) violations.push('custom select menu escaped the viewport');
              if (document.querySelector('select')) violations.push('a native select is still rendered');
            }
            if (['model-menu', 'reasoning-menu', 'openrouter-model-menu'].includes(${JSON.stringify(smokeView)})) {
              const menu = document.querySelector('.workspace-toolbar .select-menu-popover, .workspace-toolbar .model-combobox-popover');
              const message = document.querySelector('.message.user');
              const menuRect = menu?.getBoundingClientRect();
              const messageRect = message?.getBoundingClientRect();
              if (!menuRect || !messageRect) {
                violations.push('toolbar menu overlap fixture is incomplete');
              } else {
                const overlap = {
                  left: Math.max(menuRect.left, messageRect.left),
                  right: Math.min(menuRect.right, messageRect.right),
                  top: Math.max(menuRect.top, messageRect.top),
                  bottom: Math.min(menuRect.bottom, messageRect.bottom),
                };
                if (overlap.right <= overlap.left || overlap.bottom <= overlap.top) {
                  violations.push('toolbar menu smoke does not exercise a message overlap');
                } else {
                  const target = document.elementFromPoint((overlap.left + overlap.right) / 2, (overlap.top + overlap.bottom) / 2);
                  if (!target || !menu.contains(target)) violations.push('message content paints above the toolbar menu');
                }
              }
            }
            if (${JSON.stringify(smokeView)} === 'openrouter-model-menu') {
              const choices = [...document.querySelectorAll('.model-combobox-popover [role="option"]')].map((option) => option.textContent?.trim());
              for (const expected of ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'openai/gpt-chat-latest']) {
                if (!choices.includes(expected)) violations.push('OpenRouter model menu is missing ' + expected);
              }
            }
            if (${JSON.stringify(smokeView)} === 'accent-palette') {
              const palette = document.querySelector('.signal-palette');
              if (!palette) violations.push('signal palette picker did not render');
              if (palette?.querySelectorAll('[data-palette]').length !== 5) violations.push('signal palette picker does not expose five options');
              if (palette?.querySelectorAll('[aria-pressed="true"]').length !== 1) violations.push('signal palette picker does not have exactly one selected option');
              if (!palette?.querySelector('[data-palette="electric-blue"][aria-pressed="true"]')) violations.push('electric blue did not become selected');
              if (document.documentElement.dataset.accent !== 'electric-blue') violations.push('electric blue was not applied to the document');
            }
            if (['mcp', 'connectors'].includes(${JSON.stringify(smokeView)})) {
              const dialog = document.querySelector('.settings-dialog[role="dialog"]');
              const expectedTitle = ${JSON.stringify(smokeView)} === 'mcp' ? 'MCP servers' : 'Connectors';
              if (!dialog) violations.push('capability settings dialog did not open');
              if (dialog?.querySelector('.settings-header h2')?.textContent?.trim() !== expectedTitle) violations.push('requested capability tab is not active');
              if (!dialog?.querySelector('.settings-intro')) violations.push('capability introduction is missing');
            }
            if (['computer', 'computer-pair'].includes(${JSON.stringify(smokeView)})) {
              const dialog = document.querySelector('.settings-dialog[role="dialog"]');
              if (!dialog) violations.push('settings dialog did not open');
              if (dialog?.querySelector('.settings-header h2')?.textContent?.trim() !== 'Computer access') violations.push('computer access tab is not active');
              if (!dialog?.querySelector('.computer-hero')) violations.push('computer access hero is missing');
              if (dialog?.querySelectorAll('.computer-capability-row').length !== 5) violations.push('computer access does not show all five capabilities');
              if (!dialog?.querySelector('.device-row.selected')) violations.push('computer access has no selected device');
              if (!dialog?.querySelector('.network-section')) violations.push('browser allowlist is missing');
              if (${JSON.stringify(smokeView)} === 'computer-pair' && !dialog?.querySelector('.pair-runner-form')) violations.push('runner pairing form did not open');
            }
            if (${JSON.stringify(smokeView)} === 'computer-approval') {
              const dialog = document.querySelector('.computer-approval-dialog[role="alertdialog"]');
              if (!dialog) violations.push('computer approval dialog did not open');
              if (dialog?.querySelectorAll('footer button').length !== 3) violations.push('computer approval dialog does not show three decisions');
              if (!dialog?.textContent?.includes('Allow all for this run') && !dialog?.textContent?.includes('Allow all for this agent run')) violations.push('computer approval dialog does not explain run-wide approval');
              if (!dialog?.textContent?.includes('npm test')) violations.push('computer approval dialog does not identify the command target');
              if (document.activeElement?.textContent?.trim() !== 'Deny') violations.push('computer approval dialog did not focus the safe action');
              const target = dialog?.querySelector('.computer-approval-target code');
              if (!target || target.textContent?.trim() !== 'npm test -- --runInBand --reporter=verbose packages/renderer/tests/authorization-target-with-a-deliberately-long-name.test.ts') violations.push('computer approval dialog does not expose the exact target');
              if (target && getComputedStyle(target).whiteSpace !== 'pre-wrap') violations.push('computer approval target is still visually truncated');
              const lastAction = dialog?.querySelector('footer button:last-child');
              if (lastAction instanceof HTMLButtonElement) {
                lastAction.focus();
                lastAction.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
                if (!dialog.contains(document.activeElement)) violations.push('computer approval focus escaped the modal');
              }
            }
            if (${JSON.stringify(smokeView)} === 'activity-live') {
              const panel = document.querySelector('.activity-panel');
              if (!panel) violations.push('live activity panel did not render');
              if (panel?.querySelectorAll('.activity-row').length !== 3) violations.push('live activity panel is missing expected rows');
              if (!panel?.querySelector('.activity-live-mark.running')) violations.push('live activity marker is missing');
              const toggle = panel?.querySelector('.activity-toggle');
              const list = panel?.querySelector('.activity-list');
              if (!(toggle instanceof HTMLButtonElement) || !(list instanceof HTMLElement)) violations.push('activity timeline disclosure is missing');
              else {
                const firstRow = list.querySelector('.activity-row');
                if (firstRow instanceof HTMLDetailsElement) firstRow.open = true;
                toggle.click();
                await new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
                if (!list.hidden || toggle.getAttribute('aria-expanded') !== 'false' || !panel?.classList.contains('collapsed')) violations.push('activity timeline did not collapse');
                toggle.click();
                await new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
                if (list.hidden || toggle.getAttribute('aria-expanded') !== 'true' || !panel?.classList.contains('expanded')) violations.push('activity timeline did not expand again');
                if (firstRow instanceof HTMLDetailsElement && !firstRow.open) violations.push('activity timeline forgot the expanded row state');
              }
            }
            if (${JSON.stringify(smokeView)} === 'activity-compact') {
              const panel = document.querySelector('.activity-panel');
              if (!panel) violations.push('compact activity panel did not render');
              if (panel?.querySelectorAll('.activity-row').length !== 3) violations.push('eight raw actions were not condensed into three semantic phases');
              if (!panel?.textContent?.includes('Mapping the workspace')) violations.push('workspace mapping label is missing');
              if (!panel?.textContent?.includes('Reading project guidance')) violations.push('project guidance label is missing');
              if (!panel?.textContent?.includes('Progress notes')) violations.push('progress notes label is missing');
              if (!panel?.textContent?.includes('3 phases · 8 actions')) violations.push('phase and action summary is missing');
              if ([...(panel?.querySelectorAll('.activity-label strong') || [])].some((label) => label.textContent?.includes('/bin/zsh'))) violations.push('raw shell plumbing is visible as an activity label');
              if (panel?.querySelectorAll('.activity-label strong b').length !== 2) violations.push('grouped activity counts are missing');
            }
            if (['agent-watch', 'agent-watch-auto'].includes(${JSON.stringify(smokeView)})) {
              const drawer = document.querySelector('.agent-watch-drawer');
              if (!drawer) violations.push('agent Watch drawer did not open');
              if (!drawer?.textContent?.includes('Grokky lead')) violations.push('agent Watch drawer does not identify the computer owner');
              if (!drawer?.textContent?.includes('Agent computer watch')) violations.push('agent Watch drawer does not identify the active conversation');
              if (!drawer?.textContent?.includes('Reading the product page')) violations.push('agent Watch drawer does not show the live action');
              if (!drawer?.textContent?.includes('Outcome unknown')) violations.push('agent Watch drawer does not distinguish an indeterminate action');
              if (!drawer?.textContent?.includes('Cloud desktop') || !drawer?.textContent?.includes('Live & interactive')) violations.push('agent desktop does not expose its live cloud stream state');
              if (!document.querySelector('.session-sidebar-resizer[role="separator"]')) violations.push('session sidebar resizer is missing');
              if (!drawer?.querySelector('.agent-live-viewer webview')) violations.push('agent desktop isolated live stream surface is missing');
              if (!drawer?.querySelector('.agent-live-toolbar')) violations.push('agent desktop zoom and full-screen controls are missing');
              const desktopSectionRect = drawer?.querySelector('.agent-desktop-section')?.getBoundingClientRect();
              const liveViewportRect = drawer?.querySelector('.agent-live-viewport')?.getBoundingClientRect();
              if (!liveViewportRect || liveViewportRect.height < 240) violations.push('agent desktop live viewport is too short to watch');
              if (desktopSectionRect && liveViewportRect && liveViewportRect.bottom > desktopSectionRect.bottom + 0.5) violations.push('agent desktop live viewport is clipped by its section');
              if (drawer?.querySelector('output[aria-label="Live desktop zoom"]')?.textContent !== '125%') violations.push('agent desktop zoom control did not update the live viewport');
              if (!drawer?.querySelector('.agent-watch-resizer[role="separator"]')) violations.push('agent desktop sidebar resizer is missing');
              if (${JSON.stringify(smokeView)} === 'agent-watch-auto' && Number(document.querySelector('.session-sidebar-resizer')?.getAttribute('aria-valuenow')) !== 388) violations.push('keyboard sidebar resizing did not update and persist the requested width');
              if (${JSON.stringify(smokeView)} === 'agent-watch-auto' && Number(drawer?.querySelector('.agent-watch-resizer')?.getAttribute('aria-valuenow')) !== 518) violations.push('keyboard agent desktop resizing did not update and persist the requested width');
              if (window.innerWidth > 1320 && getComputedStyle(drawer).position !== 'relative') violations.push('wide agent desktop is not docked beside the chat');
              if (${JSON.stringify(smokeView)} === 'agent-watch' && document.activeElement !== drawer) violations.push('manually opened agent Watch drawer did not receive focus');
            }
            if (${JSON.stringify(smokeView)} === 'computer-history') {
              const history = document.querySelector('.archived-computer-history');
              const drawer = document.querySelector('.agent-watch-drawer');
              if (!history?.textContent?.includes('Computer history')) violations.push('historical turn does not expose computer history');
              if (!history?.textContent?.includes('1 action · 0 frames')) violations.push('historical seat does not expose action and frame counts');
              if (!drawer?.textContent?.includes('Historical Watch') || !drawer?.textContent?.includes('Grokky lead')) violations.push('historical lead seat did not open in Watch');
              if (drawer?.textContent?.includes('Stop run')) violations.push('historical Watch incorrectly exposes a live stop action');
              if (document.activeElement !== drawer) violations.push('historical Watch drawer did not receive focus');
            }
            if (${JSON.stringify(smokeView)} === 'typography') {
              const table = document.querySelector('.message.assistant .message-content table');
              const activity = document.querySelector('.activity-row[open]');
              const detail = activity?.querySelector('pre');
              const heading = document.querySelector('.activity-heading');
              if (!table) violations.push('typography fixture is missing the response table');
              if (!activity || !detail) violations.push('typography fixture is missing the expanded run detail');
              if (table && !getComputedStyle(table).fontFamily.includes('Avenir Next')) violations.push('response table is not using the product copy font');
              if (detail && !getComputedStyle(detail).fontFamily.includes('Avenir Next')) violations.push('prose activity detail is still using the code font');
              if (heading && getComputedStyle(heading).textTransform !== 'none') violations.push('run record heading is still forced to uppercase');
            }
            if (['crew-dismiss', 'crew-escape'].includes(${JSON.stringify(smokeView)})) {
              if (document.querySelector('.crew-picker-popover')) violations.push('crew picker did not dismiss');
              if (document.querySelector('.crew-picker-trigger')?.getAttribute('aria-expanded') !== 'false') violations.push('crew picker trigger still reports expanded');
            }
            if (${JSON.stringify(smokeView)} === 'crew-inside') {
              if (!document.querySelector('.crew-picker-popover')) violations.push('crew picker dismissed after an internal interaction');
              if (document.querySelector('.crew-picker-trigger')?.getAttribute('aria-expanded') !== 'true') violations.push('crew picker trigger no longer reports expanded');
            }
            if (${JSON.stringify(smokeView)} === 'crew') {
              if (!document.querySelector('.crew-picker-popover')) violations.push('crew picker did not remain open');
              if (document.querySelector('.crew-picker-trigger')?.getAttribute('aria-expanded') !== 'true') violations.push('crew picker trigger does not report expanded');
              const agentIds = [...document.querySelectorAll('.crew-picker-list [data-agent-id]')].map((item) => item.getAttribute('data-agent-id'));
              if (new Set(agentIds).size !== agentIds.length) violations.push('crew picker rendered duplicate agent identities');
              const description = document.querySelector('.crew-picker-list small');
              if (!description || getComputedStyle(description).whiteSpace !== 'normal') violations.push('crew role descriptions are still truncated to one line');
            }
            if (${JSON.stringify(smokeView)} === 'crew-select-one') {
              const selectedAgents = [...document.querySelectorAll('.crew-picker-list > button.selected')];
              if (selectedAgents.length !== 1) violations.push('selecting one crew member selected more than one row');
              if (document.querySelector('.crew-picker-trigger')?.textContent?.replace(/\s+/g, ' ').trim() !== 'Crew 1') violations.push('crew picker trigger does not report one selected agent');
            }
            if (['crew-live', 'crew-parallel', 'crew-synthesis', 'crew-tasks', 'crew-meeting'].includes(${JSON.stringify(smokeView)})) {
              const expectedStage = ${JSON.stringify(smokeView)} === 'crew-live' ? 'starting' : ${JSON.stringify(smokeView)} === 'crew-parallel' ? 'parallel' : 'synthesizing';
              const resolvedFixture = ['crew-synthesis', 'crew-tasks', 'crew-meeting'].includes(${JSON.stringify(smokeView)});
              const panel = document.querySelector('.message.user .crew-run-panel.stage-' + expectedStage);
              if (!panel) violations.push('live crew panel is not attached to the user message');
              if (!resolvedFixture && panel?.querySelectorAll('.crew-run-row').length !== 2) violations.push('overview tab does not show both selected agents');
              if (!resolvedFixture && panel?.querySelector('.crew-lead-node')) violations.push('overview tab still shows the permanent lead footer');
              if (panel?.querySelectorAll('.crew-tab[role="tab"]').length !== 4) violations.push('live crew panel does not offer overview, tasks, meeting, and messages tabs');
              if (panel?.querySelector('.crew-flow-bridge, .crew-handoff-bar, .crew-run-metrics')) violations.push('live crew panel still shows redundant orchestration chrome');
              if (document.querySelector('.composer-bot')) violations.push('crew run still duplicates its presence with the solo composer mascot');
              const mailbox = panel?.querySelector('.crew-mailbox');
              if (!resolvedFixture && mailbox) violations.push('messages transcript is open by default');
              if (resolvedFixture) {
                const tasksTab = panel?.querySelector('.crew-tab[aria-controls^="crew-panel-tasks-"]');
                const meetingTab = panel?.querySelector('.crew-tab[aria-controls^="crew-panel-meeting-"]');
                if (tasksTab?.querySelector('small')?.textContent !== '2') violations.push('tasks tab does not expose the typed assignment count');
                if (meetingTab?.querySelector('small')?.textContent !== '1') violations.push('meeting tab does not expose the observed meeting count');
              }
              if (${JSON.stringify(smokeView)} === 'crew-tasks') {
                const tasksTab = panel?.querySelector('.crew-tab[aria-controls^="crew-panel-tasks-"]');
                const board = panel?.querySelector('.crew-task-board[role="tabpanel"]');
                if (tasksTab?.getAttribute('aria-selected') !== 'true') violations.push('tasks tab did not expose its selected state');
                if (board?.querySelectorAll('.crew-task').length !== 2) violations.push('tasks tab does not render both typed assignments');
                if (!board?.textContent?.includes('Detected checks · 1')) violations.push('tasks tab does not label inferred checks truthfully');
                if (!board?.textContent?.includes('Reported evidence')) violations.push('tasks tab omits reported evidence disclosures');
              }
              if (${JSON.stringify(smokeView)} === 'crew-meeting') {
                const meetingTab = panel?.querySelector('.crew-tab[aria-controls^="crew-panel-meeting-"]');
                const meeting = panel?.querySelector('.crew-meeting-room[role="tabpanel"]');
                if (meetingTab?.getAttribute('aria-selected') !== 'true') violations.push('meeting tab did not expose its selected state');
                if (meeting?.querySelectorAll('.crew-meeting-transcript > li').length !== 2) violations.push('meeting tab omits observed contributions');
                if (!meeting?.textContent?.includes('Decided')) violations.push('meeting tab does not expose its resolved status');
                if (!meeting?.textContent?.includes('Decisions') || !meeting?.textContent?.includes('Next actions')) violations.push('meeting tab omits the moderated outcomes');
              }
              if (${JSON.stringify(smokeView)} === 'crew-synthesis') {
                if (!mailbox) violations.push('messages tab did not open on request');
                const messagesTab = panel?.querySelector('.crew-tab[aria-controls^="crew-panel-messages-"]');
                if (messagesTab?.getAttribute('aria-selected') !== 'true' || messagesTab?.querySelector('small')?.textContent !== '4') violations.push('messages tab does not expose its selected state and count');
                if (messagesTab?.querySelector('small') && getComputedStyle(messagesTab.querySelector('small')).borderTopStyle !== 'none') violations.push('messages count is still rendered as a boxed badge');
                if (mailbox?.querySelectorAll('.crew-message-group').length !== 3) violations.push('messages tab does not group consecutive messages by sender');
                if (mailbox?.querySelectorAll('.crew-message-group > .bot-mascot').length !== 3) violations.push('messages tab repeats avatars inside speaker groups');
                if (mailbox?.querySelectorAll('.crew-transcript-message').length !== 4) violations.push('messages tab does not show every runtime exchange');
                if (mailbox?.querySelectorAll('.crew-mailbox-content').length !== 4) violations.push('messages tab does not show every message body');
                if (mailbox?.querySelector('details')) violations.push('messages tab still hides messages behind disclosures');
                if (mailbox?.textContent?.includes('Delivered')) violations.push('messages tab repeats normal delivery states');
                const sender = mailbox?.querySelector('.crew-message-group-header strong');
                if (sender && getComputedStyle(sender).textTransform !== 'none') violations.push('messages tab still presents speaker names as system-log labels');
                if (!mailbox?.textContent?.includes('The queued state and live handoff now cover the missing feedback window.')) violations.push('messages tab omits a specialist report body');
                if (mailbox?.textContent?.includes('spawn_agent')) violations.push('messages tab exposes raw tool names');
              }
              if (${JSON.stringify(smokeView)} === 'crew-parallel' && panel && panel.getBoundingClientRect().height > 330) violations.push('default live crew panel is still visually oversized');
              if (${JSON.stringify(smokeView)} === 'crew-parallel' && !panel?.querySelector('.crew-run-row.is-queued')) violations.push('dependent specialist disappears before its handoff');
              if (${JSON.stringify(smokeView)} === 'crew-parallel' && !panel?.textContent?.includes('Queued for handoff')) violations.push('dependent specialist is not labelled as queued for handoff');
              if (document.querySelector('.activity-heading span')?.textContent === 'Grokky is working') violations.push('generic working state is still shown instead of crew progress');
            }
            if (${JSON.stringify(smokeView)} === 'delete-dialog') {
              const dialog = document.querySelector('.delete-dialog[role="alertdialog"]');
              if (!dialog) violations.push('delete confirmation dialog did not open');
              if (!dialog?.querySelector('.delete-cancel') || !dialog?.querySelector('.delete-confirm')) violations.push('delete confirmation actions are missing');
              if (!document.activeElement?.classList.contains('delete-cancel')) violations.push('delete confirmation did not focus the safe action');
              if (document.querySelectorAll('.session-entry').length !== ${smokeConversationCount}) violations.push('opening delete confirmation changed the conversation count');
            }
            if (${JSON.stringify(smokeView)} === 'delete-cancel') {
              if (document.querySelector('.delete-dialog')) violations.push('delete confirmation stayed open after cancel');
              if (document.querySelectorAll('.session-entry').length !== ${smokeConversationCount}) violations.push('canceling deletion changed the conversation count');
            }
            if (${JSON.stringify(smokeView)} === 'delete-complete') {
              const expectedCount = Math.max(1, ${smokeConversationCount} - 1);
              if (document.querySelector('.delete-dialog')) violations.push('delete confirmation stayed open after deletion');
              if (document.querySelectorAll('.session-entry').length !== expectedCount) violations.push('confirmed deletion did not remove exactly one conversation');
            }
            return { viewport, bounds, violations };
          })()`);
          if (layout.violations.length) throw new Error(`Layout escaped the viewport: ${layout.violations.join(", ")}`);
          console.log(`grokky-layout-ok:${layout.viewport.width}x${layout.viewport.height}`);
        }
        const screenshot = await mainWindow.webContents.capturePage();
        await writeFile(process.env.GROKKY_SMOKE_SCREENSHOT_PATH, screenshot.toPNG());
        console.log(`grokky-screenshot-ok:${process.env.GROKKY_SMOKE_SCREENSHOT_PATH}`);
      }
      console.log("grokky-renderer-ok");
    } catch (error) {
      console.error("Grokky renderer smoke failed:", error);
      app.exit(2);
      return;
    }
    setTimeout(() => app.quit(), smokeExitMs).unref();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(controller);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
