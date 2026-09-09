import { ipcMain, type BrowserWindow } from "electron";
import { IPC, type AppSnapshot } from "../shared/contracts";

/** Synthetic renderer/IPC checks. No relay, model, or user's conversation state. */
export async function runPhonePairingRendererSmoke(window: BrowserWindow, snapshot: AppSnapshot, conversationId: string, computerId: string): Promise<void> {
  const active = snapshot.conversations.find((item) => item.id === conversationId)!;
  const evaluate = (source: string) => window.webContents.executeJavaScript(source);
  const until = async (expression: string) => {
    const ready = await evaluate(`new Promise(resolve => {
      const deadline = Date.now() + 4000;
      const check = () => { if (${expression}) resolve(true); else if (Date.now() > deadline) resolve(false); else setTimeout(check, 25); }; check();
    })`);
    if (!ready) throw new Error(`Phone readiness fixture timed out: ${expression}`);
  };
  const publish = () => window.webContents.send(IPC.snapshotChanged, snapshot);
  let calls = 0;
  ipcMain.removeHandler(IPC.phoneStart);
  ipcMain.handle(IPC.phoneStart, (_event, id, seat) => {
    calls += 1;
    if (id !== conversationId || seat !== computerId) throw new Error("Pairing targeted the wrong browser");
    throw new Error("The task ended before pairing could start");
  });
  try {
    await until(`document.querySelector('.phone-control-toggle')`);
    await evaluate(`document.querySelector('.phone-control-toggle').click()`);
    snapshot.phonePairing = { [computerId]: { ready: false, reason: "This task is not running. Send a cloud-browser task in the chat, then pair while Grokky is working." } };
    publish();
    await until(`document.querySelector('.phone-control-content button')?.disabled && document.querySelector('.phone-control-content').textContent.includes('not running')`);
    await evaluate(`document.querySelector('.phone-control-content button').click()`);
    if (calls) throw new Error("Unavailable pairing reached IPC");

    active.status = "running";
    snapshot.phonePairing[computerId] = { ready: true };
    publish();
    await until(`document.querySelector('.phone-control-content button')?.disabled === false`);
    await evaluate(`document.querySelector('.phone-control-content button').click()`);
    await until(`document.querySelector('.phone-control [role="alert"]')?.textContent.includes('ended before pairing')`);
    if (calls !== 1) throw new Error("Ready pairing did not make exactly one IPC request");
    await evaluate(`if ([...document.querySelectorAll('[role="alert"]')].filter(e => e.textContent.includes('ended before pairing')).length !== 1) throw new Error('Pairing error appeared twice');`);

    // Another seat in this SAME conversation must never reveal its QR or connection controls here.
    snapshot.phone = { conversationId, computerId: "another-seat", owner: "agent", inviteUrl: "https://example.com/phone#fixture", confirmed: false, claimed: false, expiresAt: Date.now() + 60_000 };
    publish();
    await until(`document.querySelector('.phone-control-content').textContent.includes('Another browser session') && document.querySelector('.phone-control-content button')?.disabled`);
    await evaluate(`if (document.querySelector('.phone-control img') || document.querySelector('.phone-control-content').textContent.includes('Copy pairing link')) throw new Error('Private pairing shown on wrong seat');`);

    delete snapshot.phone;
    snapshot.phonePairing = { "another-seat": { ready: true } };
    publish();
    await until(`document.querySelector('.phone-control-content').textContent.includes('earlier browser session') && document.querySelector('.phone-control-content button')?.disabled`);
    active.status = "idle";
    snapshot.phonePairing[computerId] = { ready: false, reason: "This task is not running. Send a cloud-browser task in the chat, then pair while Grokky is working." };
    publish();
    await until(`document.querySelector('.phone-control-content').textContent.includes('not running')`);
  } finally {
    ipcMain.removeHandler(IPC.phoneStart);
  }
}
