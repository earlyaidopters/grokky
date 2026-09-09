import type { BrowserWindow } from "electron";
import type { MainController } from "./controller";
import { IPC } from "../shared/contracts";

export const interactionSmokeViews = new Set(["reader-scroll", "model-keyboard", "feature-keyboard", "new-session-feedback"]);

/** Disposable Electron fixtures. These do not invoke a model or an external tool. */
export async function runRendererInteractionSmoke(window: BrowserWindow, controller: MainController, view: string) {
  const web = window.webContents;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const check = async (source: string) => {
    const error = await web.executeJavaScript(`(() => { try { ${source}; return null; } catch (error) { return error.message; } })()`);
    if (error) throw new Error(`${view}: ${error}`);
  };
  const key = async (keyCode: string, modifiers: Array<"shift"> = []) => {
    web.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    web.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause();
  };
  const snapshot = controller.snapshot();
  const active = snapshot.conversations.find((entry) => entry.id === snapshot.activeConversationId)!;

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
    await check(`if (document.querySelector('.model-combobox input').value !== 'fixture/custom-model') throw new Error('Custom model ID could not be committed');
      document.querySelector('.model-combobox input').click();`);
    await pause();
    await key("Tab");
    await check(`if (document.querySelector('.model-combobox-popover')) throw new Error('Tab left the model menu open');`);
    await controller.updateConversation(active.id, { provider: "codex", model: "gpt-5.6-sol" });
    await pause();
    await check(`document.querySelector('.model-field .select-menu-trigger').focus();`);
    await key("Down");
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
    await pause();
    await check(`if (document.querySelectorAll('.session-entry').length !== window.beforeSessionCount + 1) throw new Error('Repeated clicks created duplicate sessions');
      if (!document.activeElement?.matches('.composer textarea')) throw new Error('New session did not focus its composer');
      if (document.querySelector('.new-session').disabled) throw new Error('New session remained disabled');`);
  }
}
