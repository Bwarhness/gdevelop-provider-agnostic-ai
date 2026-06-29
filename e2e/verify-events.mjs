// Phase 2 verification: the agent builds a playable platformer INCLUDING events
// (game logic). Confirms /ai-generated-event is hit and the IDE applies the events.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT='C:\\Users\\nalar\\AppData\\Local\\Temp\\claude\\C--Users-nalar-gdeveloplocal\\15b5a006-53f7-4dbf-adb9-50cdb05b2842\\scratchpad';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log('[events-e2e]',...a);
const hits=[],errs=[];
async function shot(p,n){try{await p.screenshot({path:`${OUT}\\${n}.png`});log('shot',n);}catch{}}
async function rmOverlay(p){await p.evaluate(()=>{document.querySelectorAll('iframe').forEach(e=>{const r=e.getBoundingClientRect();if(e.id==='webpack-dev-server-client-overlay'||(r.width>innerWidth*0.8&&r.height>innerHeight*0.8))e.remove();});}).catch(()=>{});}
async function clickByText(p,re){const h=await p.evaluateHandle((s)=>{const rx=new RegExp(s,'i');const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};const m=[...document.querySelectorAll('*')].filter(e=>vis(e)&&rx.test((e.innerText||'').trim())&&(e.innerText||'').length<80).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];if(!m)return null;let c=m;while(c&&c!==document.body){const t=c.tagName.toLowerCase();if(t==='button'||t==='a'||c.getAttribute('role')==='button')break;c=c.parentElement;}return c&&c!==document.body?c:m;},re.source||re);const el=h.asElement();if(!el)return false;try{await el.click({delay:30});return true;}catch{try{await p.evaluate(n=>n.click(),el);return true;}catch{return false;}}}
(async()=>{
  const b=await puppeteer.launch({executablePath:CHROME,headless:'new',defaultViewport:{width:1600,height:1000},args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
  const p=await b.newPage();
  p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));});
  p.on('request',q=>{const u=q.url();if(u.includes('localhost:4000'))hits.push(q.method()+' '+u.replace('http://localhost:4000','').split('?')[0]);});
  await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded',timeout:90000}).catch(()=>{});
  await sleep(10000);await rmOverlay(p);
  for(const re of [/Spørg AI/,/Ask AI/]){if(await clickByText(p,re)){log('opened',re);break;}}
  await sleep(3500);await rmOverlay(p);
  const typed=await p.evaluate(()=>{const t=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>100);if(!t.length)return false;t[t.length-1].focus();return true;});
  if(!typed){log('NO INPUT');await b.close();process.exit(1);}
  await p.keyboard.type('Create a scene called Platformer. Add a Player object (a character sprite) with the Platformer Character behavior. Then add events so the player moves left and right with the arrow keys and jumps with the space key.');
  await sleep(500);
  const pos=await p.evaluate(()=>{const ta=document.querySelector('textarea');const r=ta.getBoundingClientRect();return{x:r.right-24,y:r.bottom-24};});
  await p.mouse.click(pos.x,pos.y);await sleep(1500);
  await p.evaluate(()=>{const ta=document.querySelector('textarea');if(ta)ta.focus();});
  await p.keyboard.down('Control');await p.keyboard.press('Enter');await p.keyboard.up('Control');
  log('submitted; waiting for build incl. events...');
  // Wait until the agent goes quiet (no new proxy activity for ~24s) after at least one events call.
  let lastCount=0, quiet=0;
  for(let i=0;i<170;i++){
    await sleep(2000);await rmOverlay(p);
    for(const re of [/^(Godkend|Anvend|Tillad|Accept(er)?|Approve|Apply|Allow|Bekræft|Confirm)$/]){await clickByText(p,re);}
    const ev=hits.filter(h=>h.includes('POST /ai-generated-event')).length;
    if(hits.length===lastCount){quiet++;}else{quiet=0;lastCount=hits.length;}
    if(i%5===0)log(`t=${i*2}s hits=${hits.length} aiGenEvent(POST)=${ev} quiet=${quiet}`);
    if(ev>=1 && quiet>=12){break;} // ~24s no activity after events
  }
  await rmOverlay(p);await shot(p,'events-01-built');
  // Open the scene's Events tab (label contains "Begivenheder" / "Events") and screenshot.
  await clickByText(p,/Begivenheder|Events/);
  await sleep(4000);await rmOverlay(p);await shot(p,'events-02-sheet');
  const txt=await p.evaluate(()=>document.body.innerText);
  log('=== RESULT ===');
  log('proxy paths:',JSON.stringify([...new Set(hits)]));
  log('ai-generated-event calls:',hits.filter(h=>h.includes('/ai-generated-event')).length);
  log('add-message calls:',hits.filter(h=>h.includes('add-message')).length);
  log('mentions events/jump:',/event|jump|spring|begivenhed/i.test(txt));
  log('console errors (first 8):',JSON.stringify(errs.slice(0,8)));
  fs.writeFileSync(`${OUT}\\events-result.json`,JSON.stringify({hits:[...new Set(hits)],aiGenEvent:hits.filter(h=>h.includes('/ai-generated-event')).length,addMsg:hits.filter(h=>h.includes('add-message')).length,errs:errs.slice(0,15)},null,2));
  await b.close();process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
