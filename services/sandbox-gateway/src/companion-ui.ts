export const companionHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#17241d"><meta name="apple-mobile-web-app-capable" content="yes"><title>Grokky Remote</title>
<style>
:root{color-scheme:dark;--bg:#17241d;--panel:#23332a;--line:#405448;--text:#eff5ef;--muted:#b2c2b6;--green:#bbf075}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:760px;margin:auto;padding:22px 18px calc(22px + env(safe-area-inset-bottom))}header{display:flex;align-items:center;justify-content:space-between;gap:12px}header strong{font-size:26px;letter-spacing:-1px}header small{color:var(--muted)}h1{font-size:26px;font-weight:600;letter-spacing:-.7px;line-height:1.2;margin:24px 0 10px}p{color:var(--muted);margin:8px 0 16px}.owner{display:flex;align-items:center;gap:8px;padding:12px 0;border-top:1px solid var(--line);font-size:14px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green)}.screen{overflow:auto;border:1px solid var(--line);border-radius:12px;max-height:58vh;background:#fff;overscroll-behavior:contain}.screen img{display:block;width:100%;max-width:none;height:auto;cursor:default}.screen.zoom img{width:1280px}.screen.human img{cursor:crosshair}button,input,textarea{font:inherit;border-radius:11px;border:1px solid var(--line);padding:12px;color:var(--text);background:var(--panel);min-height:46px}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}button.primary{background:var(--green);color:#18291e;font-weight:650;border-color:transparent;width:100%;margin-top:14px}.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.row button{flex:1;white-space:nowrap}.row input{flex:1;min-width:140px}.row label{font-size:13px;display:flex;align-items:center;gap:7px}textarea{width:100%;min-height:72px}label{display:block;color:var(--muted);font-size:13px;margin-top:10px}.approval{padding:15px;border:1px solid var(--line);border-radius:12px;margin-top:14px;background:var(--panel);overflow-wrap:anywhere}.approval p{font-size:14px}.approval strong{display:block}.quiet{font-size:12px;margin-top:20px;text-align:center}.error{color:#ffd7ad;overflow-wrap:anywhere;min-height:22px;font-size:14px}#empty{padding:55px 20px;color:#536458;text-align:center;background:#ecf1ed}.hidden{display:none!important}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--green);outline-offset:2px}#inputtext{min-width:0;width:100%}.controls{max-width:760px}.controls .row button{min-width:65px}@media(min-width:700px){main{padding:25px}.screen{max-height:65vh}}@media(orientation:landscape) and (max-height:550px){.screen{max-height:none}}
</style></head><body><main>
<header><strong>grokky.</strong><small id="connection">Connecting…</small></header>
<h1 id="title">Your computer, within reach.</h1><p id="detail">Pair this phone from Grokky on your Mac.</p>
<div class="owner"><span class="dot"></span><span id="owner">Waiting for pairing</span></div>
<div class="screen" id="screen"><div id="empty">The current browser frame appears here.</div><img id="frame" alt="Current cloud browser. Take control to tap an element." class="hidden" draggable="false"></div>
<div class="row"><button id="zoom">Zoom in</button><button id="refresh" disabled>Refresh frame</button></div>
<div class="approval hidden" id="approval"><strong id="approval-action"></strong><p id="approval-target"></p><div class="row"><button id="allow">Allow once</button><button id="deny">Deny</button></div></div>
<div class="controls hidden" id="controls"><div class="row"><button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Escape">Esc</button><button data-key="Backspace">⌫</button></div>
<div class="row"><button data-scroll="up">Scroll up</button><button data-scroll="down">Scroll down</button></div>
<label for="inputtext">Type into the selected browser field</label><div class="row"><input id="inputtext" type="password" autocomplete="off" placeholder="Text or password" maxlength="2000"><button id="type">Type</button></div>
<label for="note">Optional instruction when you hand it back</label><textarea id="note" placeholder="Keep the option I selected…" maxlength="1000"></textarea></div>
<button class="primary" id="main" disabled>Take control</button><div class="row"><button id="stop" disabled>Stop task</button><button id="unpair">Forget this phone</button></div>
<p class="error" id="error" role="status" aria-live="polite"></p><p class="quiet">Your Mac must stay awake and Grokky must stay open.<br>Human input stays out of the model transcript while you have control.</p>
</main><script>
(() => {
const $ = (id) => document.getElementById(id);
let room='',token='',snapshot,online=false,pending='',sentAt=0,stopped=false,polling=false;
const fragment=location.hash.slice(1);history.replaceState(null,'',location.pathname);
try{const saved=JSON.parse(sessionStorage.getItem('grokky-phone')||'null');if(saved){room=saved.room;token=saved.token;}}catch{}
const api=async(route,body,auth=token)=>{const res=await fetch('/companion/phone/'+room+'/'+route,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+auth},body:JSON.stringify(body||{}),cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await res.json();if(!res.ok)throw new Error(data.error||'Connection failed');return data;};
function render(){const human=online&&snapshot?.owner==='human';$('connection').textContent=online?'Connected to your Mac':'Desktop offline';$('owner').textContent= !snapshot?'Waiting for desktop confirmation':snapshot.owner==='human'?'You are in control':snapshot.owner==='pausing'?'Switching control…':snapshot.owner==='stopped'?'Task stopped':'Grokky is in control';
if(snapshot){$('title').textContent=snapshot.title;$('detail').textContent=snapshot.detail;}
if(snapshot?.frame&&online){if($('frame').dataset.id!==snapshot.frame.id){$('frame').src=snapshot.frame.data;$('frame').dataset.id=snapshot.frame.id;}$('frame').classList.remove('hidden');$('empty').classList.add('hidden');}
if(!online){$('frame').classList.add('hidden');$('empty').classList.remove('hidden');$('empty').textContent='Waiting for your Mac. Browser input is disabled.';}
$('screen').classList.toggle('human',human);$('controls').classList.toggle('hidden',!human);$('main').textContent=human?'Return to Grokky':'Take control';
const unavailable=!online||!snapshot||Boolean(pending)||snapshot.owner==='pausing'||snapshot.owner==='stopped';
$('main').disabled=unavailable||Boolean(snapshot?.approval);$('stop').disabled=unavailable;$('refresh').disabled=!human||Boolean(pending);$('type').disabled=!human||Boolean(pending);
document.querySelectorAll('[data-key],[data-scroll]').forEach(b=>b.disabled=!human||Boolean(pending));
$('approval').classList.toggle('hidden',!snapshot?.approval||!online);if(snapshot?.approval){$('approval-action').textContent=snapshot.approval.action;$('approval-target').textContent=snapshot.approval.target;}$('allow').disabled=Boolean(pending);$('deny').disabled=Boolean(pending);
}
async function poll(){if(stopped||polling||!token)return;polling=true;try{const result=await api('poll',{receiptId:pending||undefined,frameId:snapshot?.frame?.id});online=result.online&&result.confirmed;snapshot=result.snapshot?{...result.snapshot,frame:result.snapshot.frame||snapshot?.frame}:undefined;if(!result.confirmed){$('detail').textContent='Confirm this phone in Grokky on your desktop.';}
if(pending&&result.receipt){$('error').textContent=result.receipt.ok?'':result.receipt.detail;pending='';}
if(pending&&Date.now()-sentAt>60000){$('error').textContent='The action outcome is unknown. Inspect or refresh before another action.';pending='';}
}catch(e){online=false;$('error').textContent=e.message;}finally{polling=false;render();}}
async function command(kind,extra={}){if(!online||pending||!snapshot)return;pending=crypto.randomUUID();sentAt=Date.now();$('error').textContent='';render();try{await api('command',{id:pending,epoch:snapshot.epoch,kind,...extra});}catch(e){$('error').textContent=e.message;if(!/timeout|fetch|network/i.test(e.message))pending='';}finally{render();}}
$('main').onclick=()=>command(snapshot?.owner==='human'?'resume':'takeover',{text:$('note').value});
$('stop').onclick=()=>command('stop');$('refresh').onclick=()=>command('refresh');
$('allow').onclick=()=>command('approve',{approvalId:snapshot?.approval?.id});$('deny').onclick=()=>command('deny',{approvalId:snapshot?.approval?.id});
$('type').onclick=()=>{const text=$('inputtext').value;$('inputtext').value='';if(text)command('type',{text,frameId:snapshot?.frame?.id});};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>command('key',{text:b.dataset.key,frameId:snapshot?.frame?.id}));
document.querySelectorAll('[data-scroll]').forEach(b=>b.onclick=()=>command('scroll',{text:b.dataset.scroll,frameId:snapshot?.frame?.id}));
$('zoom').onclick=()=>{$('screen').classList.toggle('zoom');$('zoom').textContent=$('screen').classList.contains('zoom')?'Fit to screen':'Zoom in';};
let down;
$('frame').onpointerdown=e=>{down={x:e.clientX,y:e.clientY};};
$('frame').onpointerup=e=>{if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>8||snapshot?.owner!=='human')return;const r=$('frame').getBoundingClientRect();command('tap',{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,frameId:snapshot.frame.id});down=undefined;};
$('unpair').onclick=()=>{sessionStorage.removeItem('grokky-phone');token='';stopped=true;online=false;snapshot=undefined;$('detail').textContent='Phone credentials removed. Disconnect the phone session in Grokky to revoke access.';render();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
(async()=>{try{if(fragment){const match=fragment.match(/^([a-f0-9]{32})\.([a-f0-9]{64})$/);if(!match)throw new Error('Invalid pairing link');room=match[1];const result=await api('claim',{},match[2]);token=result.token;sessionStorage.setItem('grokky-phone',JSON.stringify({room,token}));}await poll();}catch(e){$('error').textContent=e.message;}setInterval(()=>{if(!document.hidden)void poll();},2000);})();
})();
</script></body></html>`;
