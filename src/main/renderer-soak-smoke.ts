import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { BrowserWindow } from "electron";
import type { MainController } from "./controller";
import type { PersistentState, StateStore } from "./state-store";
import { IPC } from "../shared/contracts";

/** Sustained UI/persistence workload in a temporary profile, with no provider or computer calls. */
export async function runSoakSmoke(window: BrowserWindow, controller: MainController) {
  assert.ok(process.env.GROKKY_USER_DATA_PATH, "Soak requires a disposable profile");
  const duration = Number(process.env.GROKKY_SOAK_MINUTES || 120) * 60_000;
  assert.ok(Number.isFinite(duration) && duration >= 10_000 && duration <= 8 * 60 * 60_000);
  const web = window.webContents;
  web.setBackgroundThrottling(false);
  const internals = controller as unknown as { state: PersistentState; store: StateStore };
  const state = internals.state;
  state.routines = []; state.routineRuns = []; state.attention = [];
  const original = structuredClone(state.conversations[0]!);
  state.conversations = Array.from({ length: 100 }, (_, n) => ({ ...structuredClone(original), id: `soak-session-${n}`, title: `Load fixture ${n + 1}`, status: "idle" as const, messages: [], activities: [], agentRuns: [], agentComputers: [] }));
  const active = state.conversations[0]!;
  active.messages = Array.from({ length: 2000 }, (_, i) => ({ id: `soak-message-${i}`, role: i % 2 ? "assistant" as const : "user" as const, content: `## Result ${i + 1}\n\n` + 'Sustained history fixture with **formatted content**, `code`, and a [reference](https://example.com). '.repeat(8), provider: active.provider, createdAt: Date.now() }));
  state.activeConversationId = active.id;
  await internals.store.save(state);
  web.send(IPC.snapshotChanged, controller.snapshot());
  await web.executeJavaScript("new Promise(r => setTimeout(r, 1500))");
  web.debugger.attach("1.3");
  await web.debugger.sendCommand("Performance.enable");
  const started = performance.now(), samples: unknown[] = [], timings: number[] = [];
  let cycles = 0, baselineHeap = 0;
  const tick = async () => web.executeJavaScript(`(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const start = performance.now();
    document.querySelector('[data-settings-tab="session"]').click(); await frame();
    const dialog = document.querySelector('.settings-dialog');
    if (!dialog?.contains(document.activeElement)) throw new Error('Soak Settings focus escaped');
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await frame();
    if (document.querySelector('.settings-dialog') || document.querySelector('[inert]')) throw new Error('Soak left a modal or inert background');
    const input = document.querySelector('.composer textarea'); input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Disposable sustained typing'); input.dispatchEvent(new Event('input',{bubbles:true}));
    const scroll = document.querySelector('.message-scroll'); scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); await frame();
    if (input.value !== 'Disposable sustained typing') throw new Error('Soak lost the draft');
    if(document.querySelectorAll('article.message').length > 100) throw new Error('Growing history escaped the render limit');
    return performance.now() - start;
  })()`);
  try {
    while (performance.now() - started < duration) {
      const elapsed = performance.now() - started;
      if (cycles > 0 && cycles % 30 === 0) active.messages.push({id:`soak-arrival-${cycles}`,role:"assistant",content:"New reply during sustained activity",provider:active.provider,createdAt:Date.now()});
      active.messages.at(-1)!.content = `Stream update ${cycles}. ` + 'Bounded streamed response. '.repeat(80);
      active.activities = Array.from({ length: 80 }, (_, i) => ({ id: `soak-activity-${i}`, kind: "notice" as const, label: `Progress ${cycles}/${i}`, status: "completed" as const, createdAt: Date.now() }));
      web.send(IPC.snapshotChanged, controller.snapshot());
      timings.push(await tick()); cycles++;
      if (cycles % 10 === 0) {
        await controller.setActiveConversation(state.conversations[1]!.id);
        await controller.setActiveConversation(active.id);
        const reloaded = await internals.store.load();
        assert.equal(reloaded.activeConversationId, active.id);
        assert.equal(reloaded.conversations.find(c => c.id === active.id)?.messages.length, active.messages.length);
      }
      if (cycles % 30 === 0) {
        await web.executeJavaScript(`(async () => {
          const until = async predicate => { const deadline=Date.now()+5000; while(!predicate()) { if(Date.now()>deadline) throw new Error('Soak attachment did not settle'); await new Promise(r=>setTimeout(r,20)); } };
          const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=800;
          const context=canvas.getContext('2d'); context.fillStyle='#b5d985'; context.fillRect(0,0,1280,800);
          const blob=await new Promise(r=>canvas.toBlob(r)); const transfer=new DataTransfer(); transfer.items.add(new File([blob],'soak-image.png',{type:'image/png'}));
          const input=document.querySelector('.composer-image-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
          await until(()=>document.querySelector('.draft-preview-open')); document.querySelector('.draft-preview-open').click();
          await until(()=>document.querySelector('.image-lightbox'));
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await until(()=>!document.querySelector('.image-lightbox'));
          document.querySelector('.draft-preview-remove').click(); await until(()=>!document.querySelector('.draft-preview-open'));
        })()`);
      }
      if (cycles === 5 || cycles % 30 === 0 || elapsed + 1500 >= duration) {
        await web.debugger.sendCommand("HeapProfiler.collectGarbage");
        const { metrics } = await web.debugger.sendCommand("Performance.getMetrics");
        const metric = (name: string) => metrics.find((m: { name: string }) => m.name === name)?.value || 0;
        const heap = metric("JSHeapUsedSize"); if (!baselineHeap) baselineHeap = heap;
        const sample = { seconds: Math.round(elapsed / 1000), cycles, heapMiB: +(heap / 2**20).toFixed(1), nodes: metric("Nodes"), listeners: metric("JSEventListeners"), mainRssMiB: +(process.memoryUsage().rss / 2**20).toFixed(1), cycleMs: timings.at(-1) };
        samples.push(sample); console.log(`grokky-soak-progress:${JSON.stringify(sample)}`);
        assert.ok(heap < baselineHeap + 128 * 2**20, "Retained renderer heap grew over 128 MiB at fixed workload");
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    timings.sort((a,b) => a-b);
    assert.ok(timings[Math.floor(timings.length * .95)]! < 3000, "Soak cycle p95 exceeded 3 seconds");
    const output = join(process.cwd(), "output", "soak"); await mkdir(output, { recursive: true });
    const report = { durationSeconds: (performance.now()-started)/1000, cycles, initialMessages: 2000, finalMessages: active.messages.length, sessions: 100, p50CycleMs: timings[Math.floor(timings.length*.5)], p95CycleMs: timings[Math.floor(timings.length*.95)], maxCycleMs: timings.at(-1), samples };
    await writeFile(join(output, "desktop.json"), JSON.stringify(report,null,2));
    console.log(`grokky-soak-ok:${JSON.stringify({...report,samples: samples.length})}`);
  } finally { web.debugger.detach(); }
}
