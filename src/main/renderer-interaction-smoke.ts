import type { BrowserWindow } from "electron";
import type { MainController } from "./controller";
import { IPC } from "../shared/contracts";
import { runAccessibilitySmoke } from "./renderer-accessibility-smoke";
import { runSoakSmoke } from "./renderer-soak-smoke";

export const interactionSmokeViews = new Set(["access-keyboard", "large-history", "ui-accessibility", "ui-soak", "reader-scroll", "model-keyboard", "feature-keyboard", "new-session-feedback", "agent-proposal", "settings-unsaved", "theme-matrix", "ui-performance", "draft-preview", "zoom-motion"]);

/** Disposable Electron fixtures. These do not invoke a model or an external tool. */
export async function runRendererInteractionSmoke(window: BrowserWindow, controller: MainController, view: string) {
  if (view === "ui-accessibility") return runAccessibilitySmoke(window, controller);
  if (view === "ui-soak") return runSoakSmoke(window, controller);
  const web = window.webContents;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const check = async (source: string) => {
    const error = await web.executeJavaScript(`(() => { try { ${source}; return null; } catch (error) { return error.message; } })()`);
    if (error) throw new Error(`${view}: ${error}`);
  };
  const waitFor = async (predicate: string) => {
    await web.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (${predicate}) resolve(true);
        else if (Date.now() >= deadline) reject(new Error('Timed out waiting for renderer state'));
        else setTimeout(poll, 25);
      }; poll();
    })`);
  };
  const key = async (keyCode: string, modifiers: Array<"shift"> = []) => {
    if (!window.isFocused()) window.focus();
    if (!web.isFocused()) web.focus();
    await waitFor("document.hasFocus()");
    web.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    web.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause();
  };
  const snapshot = controller.snapshot();
  const active = snapshot.conversations.find((entry) => entry.id === snapshot.activeConversationId)!;

  if (view === "access-keyboard") {
    await controller.updateConversation(active.id, {provider:"codex",sandboxMode:"workspace-write",allowCommands:false}); await pause();
    await check(`document.querySelector('.access-picker-trigger').focus()`); await key("Down");
    await waitFor(`document.activeElement.matches('[role="menuitemradio"][aria-checked="true"]')`);
    await key("Home");
    await check(`if(!document.activeElement.textContent.includes('Read only')) throw new Error('Access Home missed first choice: '+document.activeElement.outerHTML)`);
    await key("Return");
    await waitFor(`!document.querySelector('.access-picker-popover') && document.querySelector('.access-picker-trigger').textContent.includes('Read only')`);
    await check(`if(!document.activeElement.matches('.access-picker-trigger')) throw new Error('Access selection did not restore focus')`);
    await key("Down"); await key("End");
    await check(`if(!document.activeElement.textContent.includes('Full access')) throw new Error('Access menu End key missed the last choice')`);
    await key("Tab"); await check(`if(document.querySelector('.access-picker-popover')) throw new Error('Tab did not close access menu'); if(document.activeElement === document.body) throw new Error('Tab lost access menu focus')`);
    await check(`document.querySelector('.access-picker-trigger').focus()`); await key("Down"); await key("Escape");
    await check(`if(document.querySelector('.access-picker-popover') || !document.activeElement.matches('.access-picker-trigger')) throw new Error('Access Escape did not restore focus')`);
  }

  if (view === "large-history") {
    const internals = controller as unknown as { state: { conversations: typeof snapshot.conversations } };
    const real = internals.state.conversations.find(c => c.id === active.id)!;
    real.messages = Array.from({length: 250}, (_, i) => ({id: `history-${i}`, role: i % 2 ? "assistant" as const : "user" as const, content: `Historical message ${i}. ` + "Readable history content. ".repeat(20), provider: real.provider, createdAt: Date.now()}));
    real.agentRuns = []; real.activities = []; real.agentComputers = [];
    web.send(IPC.snapshotChanged, controller.snapshot()); await pause();
    await check(`if (document.querySelectorAll('article.message').length !== 100) throw new Error('Large history was not bounded initially');
      const scroll = document.querySelector('.message-scroll'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll'));
      window.historyAnchor = document.querySelector('article.message'); window.historyAnchorTop = window.historyAnchor.getBoundingClientRect().top;
      document.querySelector('.load-earlier-messages').focus(); document.querySelector('.load-earlier-messages').click();`); await pause();
    await check(`if (document.activeElement !== window.historyAnchor) throw new Error('Loading history lost keyboard focus');
      if (document.querySelectorAll('article.message').length !== 200) throw new Error('Earlier history was not loaded');
      if (Math.abs(window.historyAnchor.getBoundingClientRect().top-window.historyAnchorTop)>3) throw new Error('Loading earlier history moved the reading anchor');`);
    const second = await controller.createConversation(); await pause();
    await controller.setActiveConversation(active.id); await pause();
    await check(`if (document.querySelectorAll('article.message').length !== 200) throw new Error('Session navigation lost loaded history');
      const scroll = document.querySelector('.message-scroll'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll'));
      document.querySelector('.load-earlier-messages').click();`); await pause();
    await check(`if (document.querySelectorAll('article.message').length !== 250 || document.querySelector('.load-earlier-messages')) throw new Error('Oldest history is unreachable');`);
    real.messages.push({id:'history-incoming',role:'assistant',content:'Arrived while reading earlier messages',provider:real.provider,createdAt:Date.now()});
    web.send(IPC.snapshotChanged, controller.snapshot()); await pause();
    await check(`if(document.querySelectorAll('article.message').length !== 251) throw new Error('Incoming reply removed the older messages being read');
      const scroll=document.querySelector('.message-scroll');scroll.scrollTop=scroll.scrollHeight;scroll.dispatchEvent(new Event('scroll'));`);
    real.messages.push({id:'history-following',role:'assistant',content:'Arrived while following latest',provider:real.provider,createdAt:Date.now()});
    web.send(IPC.snapshotChanged, controller.snapshot()); await pause();
    await check(`if(document.querySelectorAll('article.message').length !== 100) throw new Error('Following a growing session did not bound history');`);
    await controller.deleteConversation(second);
  }

  if (view === "reader-scroll") {
    active.status = "idle";
    active.messages = Array.from({ length: 24 }, (_, index) => ({ id: `reading-${index}`, role: index % 2 ? "assistant" as const : "user" as const, content: `Message ${index + 1}\n\n` + "A deliberately long reply for testing the reading position. ".repeat(12), createdAt: Date.now(), provider: active.provider }));
    active.activities = []; active.agentRuns = []; active.agentComputers = [];
    const second = { ...structuredClone(active), id: "reading-second", title: "Another conversation", messages: [] };
    snapshot.conversations.push(second);
    web.send(IPC.snapshotChanged, snapshot);
    await pause();
    await check(`const scroll = document.querySelector('.message-scroll');
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 4) throw new Error('Initial conversation did not open at latest');
      scroll.scrollTop = 320; scroll.dispatchEvent(new Event('scroll'));
      window.readingTop = scroll.scrollTop;`);
    await pause();
    active.messages.at(-1)!.content += "\n\nA growing reply. ".repeat(40);
    active.activities.push({ id: "reading-update", kind: "notice", label: "New progress", status: "completed", createdAt: Date.now() });
    web.send(IPC.snapshotChanged, snapshot);
    await pause();
    await check(`const scroll = document.querySelector('.message-scroll');
      if (Math.abs(scroll.scrollTop - window.readingTop) > 2) throw new Error('Incoming activity moved the reader');
      if (!document.querySelector('.jump-to-latest')) throw new Error('No way to return to latest');`);
    snapshot.activeConversationId = second.id;
    web.send(IPC.snapshotChanged, snapshot); await pause();
    snapshot.activeConversationId = active.id;
    web.send(IPC.snapshotChanged, snapshot); await pause();
    await check(`const scroll = document.querySelector('.message-scroll');
      if (Math.abs(scroll.scrollTop - window.readingTop) > 2) throw new Error('Switching sessions lost the reading position');
      document.querySelector('.jump-to-latest').click();`);
    await pause();
    active.messages.at(-1)!.content += "\n\nContinue following this reply. ".repeat(50);
    web.send(IPC.snapshotChanged, snapshot); await pause();
    await check(`const scroll = document.querySelector('.message-scroll');
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 4) throw new Error('Following did not resume after Back to latest');
      if (document.querySelector('.jump-to-latest')) throw new Error('Latest control stayed after catching up');`);
  }

  if (view === "model-keyboard") {
    await controller.updateConversation(active.id, { provider: "openrouter", model: "openai/gpt-5.2" });
    await pause();
    await check(`document.querySelector('.model-combobox input').focus();`);
    await pause();
    await key("Down");
    await check(`const input = document.querySelector('.model-combobox input');
      const option = document.getElementById(input.getAttribute('aria-activedescendant'));
      if (!option || document.activeElement !== input) throw new Error('Arrow navigation lost input focus or active option');
      window.chosenModel = option.querySelector('span').textContent;`);
    await key("Return");
    await waitFor(`document.querySelector('.model-combobox input')?.value === window.chosenModel && !document.querySelector('.model-combobox-popover')`);
    await check(`const input = document.querySelector('.model-combobox input');
      if (input.value !== window.chosenModel || document.querySelector('.model-combobox-popover')) throw new Error('Enter did not commit the highlighted model');
      input.click();`);
    await pause();
    await key("Escape");
    await check(`const input = document.querySelector('.model-combobox input');
      if (document.querySelector('.model-combobox-popover') || document.activeElement !== input) throw new Error('Escape lost model field focus');
      input.click(); input.select();`);
    await web.insertText("fixture/custom-model");
    await key("Return");
    await waitFor(`document.querySelector('.model-combobox input')?.value === 'fixture/custom-model' && !document.querySelector('.model-combobox-popover')`);
    await check(`if (document.querySelector('.model-combobox input').value !== 'fixture/custom-model') throw new Error('Custom model ID could not be committed');
      document.querySelector('.model-combobox input').click();`);
    await pause();
    await key("Tab");
    await check(`if (document.querySelector('.model-combobox-popover')) throw new Error('Tab left the model menu open');`);
    await controller.updateConversation(active.id, { provider: "codex", model: "gpt-5.6-sol" });
    await pause();
    await check(`document.querySelector('.model-field .select-menu-trigger').focus();`);
    await key("Down");
    await waitFor(`document.activeElement?.matches('.model-field [role="option"]')`);
    await check(`if (!document.activeElement?.matches('.model-field [role="option"]')) throw new Error('Codex model list did not open from the keyboard');`);
    await key("Escape");
    await check(`if (document.querySelector('.model-field .select-menu-popover') || !document.activeElement?.matches('.model-field .select-menu-trigger')) throw new Error('Codex model list did not restore focus');`);

  }

  if (view === "feature-keyboard") {
    const now = Date.now();
    snapshot.routines = [{ id: "keyboard-routine", conversationId: active.id, name: "Keyboard routine", instruction: "A disposable interaction fixture", schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, enabled: false, nextRunAt: now + 60_000, consecutiveFailures: 0, createdAt: now, updatedAt: now }];
    web.send(IPC.snapshotChanged, snapshot); await pause();
    await check(`const trigger = document.querySelector('[data-feature-center="routines"]'); trigger.focus(); trigger.click();`);
    await pause();
    await check(`const dialog = document.querySelector('.feature-center');
      if (!dialog.contains(document.activeElement)) throw new Error('Work control did not take focus');
      dialog.querySelector('button').focus();`);
    await key("Tab", ["shift"]);
    await check(`const buttons = [...document.querySelectorAll('.feature-center button:not(:disabled)')];
      if (document.activeElement !== buttons.at(-1)) throw new Error('Shift Tab escaped the dialog');`);
    await key("Tab");
    await check(`if (document.activeElement !== document.querySelector('.feature-center button')) throw new Error('Tab did not wrap inside the dialog');
      document.querySelector('.routine-actions .danger').click();`);
    await pause();
    await check(`if (document.activeElement?.textContent !== 'Keep routine') throw new Error('Routine confirmation did not focus the safe action');`);
    await key("Escape");
    await check(`if (!document.querySelector('.feature-center') || document.querySelector('.routine-delete-confirm')) throw new Error('Escape did not dismiss just the routine confirmation');
      if (!document.activeElement?.matches('.routine-actions .danger')) throw new Error('Routine confirmation lost its trigger');`);
    await key("Escape");
    await check(`if (document.querySelector('.feature-center') || !document.activeElement?.matches('[data-feature-center="routines"]')) throw new Error('Closing work control did not restore focus');`);
  }

  if (view === "new-session-feedback") {
    await check(`const trigger = document.querySelector('.new-session');
      window.beforeSessionCount = document.querySelectorAll('.session-entry').length;
      trigger.click(); trigger.click();`);
    await web.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (document.querySelectorAll('.session-entry').length === window.beforeSessionCount + 1 && !document.querySelector('.new-session').disabled) requestAnimationFrame(() => requestAnimationFrame(resolve));
        else if (Date.now() >= deadline) reject(new Error('New session did not finish saving'));
        else setTimeout(poll, 25);
      }; poll();
    })`);
    await check(`if (document.querySelectorAll('.session-entry').length !== window.beforeSessionCount + 1) throw new Error('Repeated clicks created duplicate sessions');
      if (!document.activeElement?.matches('.composer textarea')) throw new Error('New session did not focus its composer');
      if (document.querySelector('.new-session').disabled) throw new Error('New session remained disabled');`);
  }
  if (view === "agent-proposal") {
    await controller.updateSettings({ multiAgentEnabled: true, maxAgentThreads: 6 });
    await controller.sendMessage(active.id, "Create a new accessibility agent named interface_reviewer");
    await pause();
    await check(`const card = document.querySelector('.agent-proposal');
      if (!card || !card.textContent.includes('Use once')) throw new Error('Explicit request did not produce a reviewable role');
      [...card.querySelectorAll('button')].find(b => b.textContent === 'Edit role').click();`);
    await pause();
    await check(`const input = document.querySelector('.proposal-fields input'); input.focus(); input.select();`);
    await web.insertText("reviewed_accessibility");
    await check(`const button = [...document.querySelectorAll('.agent-proposal button')].find(b => b.textContent === 'Use once'); button.click(); button.click();`);
    await pause();
    const selected = controller.snapshot().conversations.find(c => c.id === active.id)!;
    if (selected.pendingAgent?.name !== "reviewed_accessibility" || selected.status !== "idle") throw new Error("Reviewed role was not selected without starting a model");
    if (selected.selectedAgentIds.filter(id => id === selected.pendingAgent!.id).length !== 1) throw new Error("Repeated click selected duplicate roles");
    await check(`if (!document.querySelector('.agent-proposal').textContent.includes('next turn only')) throw new Error('Use once confirmation missing');`);
    await controller.sendMessage(active.id, "Suggest a new documentation specialist"); await pause();
    await check(`document.querySelector('[aria-label="Dismiss role proposal"]').click();`); await pause();
    await check(`if (!document.querySelector('.agent-proposal.resolved')) throw new Error('Dismiss did not resolve the proposal');`);
  }

  if (view === "settings-unsaved") {
    await check(`const trigger = document.querySelector('[data-settings-tab="session"]'); trigger.focus(); trigger.click();`); await pause();
    await check(`const input = document.querySelector('.session-identity-card input'); if (!input) throw new Error('Missing session identity'); input.focus(); input.select();`);
    await web.insertText("Unsaved identity fixture");
    await key("Escape");
    await check(`if (!document.querySelector('.confirm-dialog') || document.activeElement.textContent !== 'Keep editing') throw new Error('Dirty settings did not protect the draft');
      if (!document.querySelector('.workspace').closest('[inert]')) throw new Error('Background is not inert');`);
    await key("Escape");
    await check(`if (document.querySelector('.confirm-dialog') || !document.querySelector('.settings-dialog')) throw new Error('Escape closed both dialogs');
      if (document.querySelector('.session-identity-card input').value !== 'Unsaved identity fixture') throw new Error('Draft was lost');`);
    await key("Escape");
    await check(`document.querySelector('.confirm-dialog .danger').click();`); await pause();
    await check(`if (document.querySelector('.settings-dialog') || document.querySelector('[inert]')) throw new Error('Closing nested dialogs left the app inert');
      if (!document.activeElement.matches('[data-settings-tab="session"]')) throw new Error('Settings did not restore its trigger focus');`);
  }

  if (view === "theme-matrix") {
    for (const theme of ["light", "dark"] as const) {
      for (const accentPalette of ["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"] as const) {
        await controller.updateSettings({ theme, accentPalette }); await pause();
        await check(`document.querySelector('[data-settings-tab="session"]').click();`); await pause();
        for (const tab of ["session", "agents", "computer", "skills", "mcp", "connectors"]) {
          await check(`document.querySelector('[data-settings-view="${tab}"]').click();`); await pause();
          await check(`const panel = document.querySelector('.settings-dialog'); const rect = panel.getBoundingClientRect();
            if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) throw new Error('${theme}/${accentPalette}/${tab} escaped the viewport');
            if (panel.scrollWidth > panel.clientWidth + 2) throw new Error('${theme}/${accentPalette}/${tab} has horizontal overflow');
            if (!panel.contains(document.activeElement)) throw new Error('Settings lost keyboard focus');`);
        }
        await key("Escape");
      }
    }
    await check(`document.querySelector('[data-settings-tab="agents"]').click();`); await pause();
  }

  if (view === "ui-performance") {
    active.messages = Array.from({ length: 80 }, (_, index) => ({ id: `perf-${index}`, role: index % 2 ? "assistant" as const : "user" as const, content: `Fixture message ${index + 1}. ` + "Readable long-history content. ".repeat(35), createdAt: Date.now(), provider: active.provider }));
    web.send(IPC.snapshotChanged, snapshot); await pause();
    const metrics = await web.executeJavaScript(`(async () => {
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const until = async predicate => { const deadline = performance.now() + 5000; while (!predicate()) { if (performance.now() > deadline) throw new Error('Performance action did not settle'); await new Promise(r => setTimeout(r, 10)); } };
      const measure = async (operation, open, ready, close) => {
        const samples = [];
        for (let i = 0; i < 35; i++) {
          const start = performance.now(); open(i); await until(ready); await frame();
          if (i >= 5) samples.push(performance.now() - start);
          await close(); await frame();
        }
        samples.sort((a,b) => a-b);
        return { operation, samples: samples.length, p50: samples[15], p95: samples[28], max: samples.at(-1) };
      };
      const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const results = [];
      results.push(await measure('Settings open with 80 messages', () => document.querySelector('[data-settings-tab="session"]').click(), () => Boolean(document.querySelector('.settings-dialog')), escape));
      results.push(await measure('Model menu open with 80 messages', () => document.querySelector('.model-field .select-menu-trigger').click(), () => Boolean(document.querySelector('.model-field .select-menu-popover')), escape));
      results.push(await measure('Composer input with 80 messages', i => {
        const input = document.querySelector('.composer textarea'); input.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Synthetic typing sample ' + i);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, () => !document.querySelector('.composer .send-button').disabled, () => {}));
      let count = 0;
      results.push(await measure('New session through persistence', () => { count = document.querySelectorAll('.session-entry').length; document.querySelector('.new-session').click(); }, () => document.querySelectorAll('.session-entry').length === count + 1 && !document.querySelector('.new-session').disabled, () => {}));
      return results;
    })()`);
    for (const metric of metrics) console.log(`grokky-ui-performance:${JSON.stringify(metric)}`);
  }

  if (view === "draft-preview") {
    await web.executeJavaScript(`(async () => {
      const input = document.querySelector('.composer textarea'); input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Retain my selection in this draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'preview.png', { type: 'image/png' }));
      const file = document.querySelector('.composer-image-input'); file.files = transfer.files; file.dispatchEvent(new Event('change', { bubbles: true }));
    })()`); await pause();
    await check(`const button = document.querySelector('.draft-preview-open'); button.focus(); button.click();`); await pause();
    await check(`const dialog = document.querySelector('.image-lightbox'); if (!dialog?.contains(document.activeElement)) throw new Error('Attachment preview did not contain focus');`);
    await key("Escape");
    await check(`if (!document.activeElement.matches('.draft-preview-open')) throw new Error('Preview did not return focus');
      const input = document.querySelector('.composer textarea'); input.focus(); input.setSelectionRange(7, 14); input.dispatchEvent(new Event('select', { bubbles: true })); input.blur();`);
    await controller.createConversation();
    await waitFor(`document.querySelector('.composer textarea')?.value === ''`);
    await controller.setActiveConversation(active.id);
    await waitFor(`document.querySelector('.composer textarea')?.value === 'Retain my selection in this draft'`);
    await pause();
    await check(`const input = document.querySelector('.composer textarea');
      if (input.selectionStart !== 7 || input.selectionEnd !== 14) throw new Error('Draft selection was not restored: ' + input.selectionStart + ':' + input.selectionEnd);
      if (!document.querySelector('.draft-preview-open')) throw new Error('Draft image was lost');
      document.querySelector('.draft-preview-remove').click();`); await pause();
    await check(`if (document.querySelector('.composer-image-preview')) throw new Error('Remove attachment did not work');`);
  }

  if (view === "zoom-motion") {
    web.setZoomFactor(2); await pause();
    await check(`document.querySelector('[data-settings-tab="session"]').click();`); await pause();
    for (const tab of ["session", "agents", "computer", "skills", "mcp", "connectors"]) {
      await check(`document.querySelector('[data-settings-view="${tab}"]').click();`); await pause();
      await check(`const panel = document.querySelector('.settings-dialog'); const r = panel.getBoundingClientRect();
        if (r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1 || panel.scrollWidth > panel.clientWidth + 2) throw new Error('Settings ${tab} does not fit at 200% zoom');`);
    }
    await key("Escape"); web.setZoomFactor(1); await pause();
    web.debugger.attach("1.3");
    try {
      await web.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await check(`if (!matchMedia('(prefers-reduced-motion: reduce)').matches) throw new Error('Reduced-motion fixture not active');
        const button = document.querySelector('.new-session');
        if (parseFloat(getComputedStyle(button).transitionDuration) > .001) throw new Error('Reduced motion leaves control transitions active');`);
    } finally { web.debugger.detach(); }
  }

}
