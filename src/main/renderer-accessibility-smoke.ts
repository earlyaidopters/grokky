import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { MainController } from "./controller";
import { IPC } from "../shared/contracts";

export async function runScreenAccessibilitySmoke(window: BrowserWindow, name: string) {
  const web = window.webContents;
  await web.executeJavaScript(await readFile(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8"));
  web.sendInputEvent({type:"mouseMove",x:0,y:0});
  await web.executeJavaScript(`Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished))`);
  const report = await web.executeJavaScript(`axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}}).then(r=>({
    violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),
    review:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))
  }))`);
  const directory=join(process.cwd(),'output','accessibility','screens'); await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`),JSON.stringify(report,null,2));
  if(report.violations.length || report.review.some((r:{id:string})=>r.id==='aria-prohibited-attr')) throw new Error(`Screen accessibility failed: ${name}; see output/accessibility/screens`);
}

/** Runs axe against rendered application states, using the disposable smoke profile. */
export async function runAccessibilitySmoke(window: BrowserWindow, controller: MainController) {
  const web = window.webContents;
  await web.executeJavaScript(await readFile(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8"));
  const results: Array<{ state: string; violations: unknown[]; incomplete: number; passes: number; review: Array<{ id: string }> }> = [];
  const settle = () => web.executeJavaScript(`(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished));
    await new Promise(r => requestAnimationFrame(r));
  })()`);
  const audit = async (state: string) => {
    web.sendInputEvent({type:"mouseMove",x:0,y:0});
    await settle();
    await web.executeJavaScript(`(() => {
      for(const el of document.querySelectorAll('[aria-controls]')) {
        for(const id of el.getAttribute('aria-controls').split(/\\s+/)) if(!document.getElementById(id)) throw new Error('Missing controlled element: '+id);
      }
    })()`);
    const report = await web.executeJavaScript(`axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }).then(r => ({violations:r.violations.map(v => ({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n => ({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.length,review:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),passes:r.passes.length}))`);
    results.push({ state, ...report });
    console.log(`grokky-a11y:${state}:${report.violations.length} violations`);
  };
  const click = async (selector: string) => {
    await web.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle();
  };
  const escape = async () => {
    await web.executeJavaScript("(document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))"); await settle();
  };
  for (const theme of ["light", "dark"] as const) {
    for (const accentPalette of ["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"] as const) {
    const variant = `${theme}/${accentPalette}`;
    await controller.updateSettings({ theme, accentPalette }); await settle();
    await audit(`${variant}/empty-conversation`);
    const snapshot = controller.snapshot();
    const active = snapshot.conversations.find(c => c.id === snapshot.activeConversationId)!;
    active.messages = [
      {id:'a11y-user',role:'user',content:'Review this interface and describe the result.',provider:active.provider,createdAt:Date.now()},
      {id:'a11y-assistant',role:'assistant',content:'## Interface result\n\nThe controls are ready for review. Read the [example source](https://example.com).\n\n| Check | Result |\n| --- | --- |\n| Keyboard | Ready |',provider:active.provider,createdAt:Date.now()},
    ];
    web.send(IPC.snapshotChanged, snapshot); await audit(`${variant}/messages`);
    await click('[data-settings-tab="session"]');
    for (const tab of ["session", "agents", "computer", "skills", "mcp", "connectors"]) {
      await click(`[data-settings-view="${tab}"]`); await audit(`${variant}/settings/${tab}`);
    }
    await escape();
    for (const feature of ["routines", "attention"]) {
      await click(`[data-feature-center="${feature}"]`); await audit(`${variant}/${feature}`); await escape();
    }
    await click('.model-field .select-menu-trigger'); await audit(`${variant}/model-menu`); await escape();
    }
  }
  const output = join(process.cwd(), "output", "accessibility"); await mkdir(output, { recursive: true });
  await writeFile(join(output, "desktop.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.violations.length || r.review.some(rule => rule.id === "aria-prohibited-attr"));
  if (failed.length) throw new Error(`Accessibility violations in ${failed.map(r => r.state).join(', ')}. See output/accessibility/desktop.json`);
}
