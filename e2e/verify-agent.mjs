// End-to-end verification of AGENT mode (Phase 3): the GDevelop IDE asks the local
// proxy (-> real Kimi) which emits tool calls; the IDE executes them via
// EditorFunctions, creating a real project + scene. Drives installed Chrome.
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'C:\\Users\\nalar\\AppData\\Local\\Temp\\claude\\C--Users-nalar-gdeveloplocal\\15b5a006-53f7-4dbf-adb9-50cdb05b2842\\scratchpad';
const URL = 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[agent-e2e]', ...a);
const proxyHits = [], consoleErrors = [];

async function shot(page, name) { try { await page.screenshot({ path: `${OUT}\\${name}.png` }); log('shot', name); } catch (e) {} }
async function removeOverlay(page) {
  await page.evaluate(() => { document.querySelectorAll('iframe').forEach(el => { const r = el.getBoundingClientRect(); if (el.id === 'webpack-dev-server-client-overlay' || (r.width > innerWidth*0.8 && r.height > innerHeight*0.8)) el.remove(); }); }).catch(()=>{});
}
async function clickByText(page, re) {
  const h = await page.evaluateHandle((reSrc) => {
    const rx = new RegExp(reSrc, 'i');
    const vis = el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const m = [...document.querySelectorAll('*')].filter(el => vis(el) && rx.test((el.innerText||'').trim()) && (el.innerText||'').length < 80).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];
    if (!m) return null;
    let c = m; while (c && c !== document.body) { const t=c.tagName.toLowerCase(); if (t==='button'||t==='a'||c.getAttribute('role')==='button') break; c=c.parentElement; }
    return c && c!==document.body ? c : m;
  }, re.source || re);
  const el = h.asElement(); if (!el) return false;
  try { await el.click({delay:30}); return true; } catch { try { await page.evaluate(n=>n.click(), el); return true; } catch { return false; } }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport:{width:1600,height:1000}, args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type()==='error') consoleErrors.push(m.text().slice(0,160)); });
  page.on('request', req => { const u=req.url(); if (u.includes('localhost:4000')) proxyHits.push(req.method()+' '+u.replace('http://localhost:4000','')); });

  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:90000 }).catch(()=>{});
  await sleep(10000); await removeOverlay(page);
  for (const re of [/Spørg AI/, /Ask AI/]) { if (await clickByText(page, re)) { log('opened via', re); break; } }
  await sleep(3500); await removeOverlay(page);

  const typed = await page.evaluate(() => { const t=[...document.querySelectorAll('textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width>100;}); if(!t.length) return false; t[t.length-1].focus(); return true; });
  log('input found:', typed);
  if (!typed) { log('NO INPUT'); await shot(page,'agent-noinput'); await browser.close(); process.exit(1); }
  await page.keyboard.type('Create a new empty project called SpaceGame, then add a scene named Level1 and set it as the first scene.');
  await sleep(500); await shot(page, 'agent-01-typed');
  const pos = await page.evaluate(() => { const ta=document.querySelector('textarea'); const r=ta.getBoundingClientRect(); const b=[...document.querySelectorAll('button')].find(x=>{const q=x.getBoundingClientRect();return q.width>0&&q.width<70&&q.height<70&&q.right>r.right-70&&q.right<r.right+20&&q.bottom>r.bottom-70&&q.bottom<r.bottom+20;}); if(b){const q=b.getBoundingClientRect();return{x:q.left+q.width/2,y:q.top+q.height/2};} return {x:r.right-24,y:r.bottom-24}; });
  await page.mouse.click(pos.x, pos.y);
  await sleep(1500);
  // Proven submit path: Ctrl+Enter on the focused textarea.
  if (!proxyHits.some(h => h.includes('POST'))) {
    await page.evaluate(() => { const ta=document.querySelector('textarea'); if (ta) ta.focus(); });
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  }
  log('submitted; waiting for agent loop (real Kimi)...');

  // Wait up to ~200s for the agent loop: POST -> tool calls -> add-message(s) -> summary.
  let done = false;
  for (let i = 0; i < 100; i++) {
    await sleep(2000); await removeOverlay(page);
    // Auto-click any edit-approval prompt (Danish/English), in case auto-edit is off.
    for (const re of [/^(Godkend|Anvend|Tillad|Accept(er)?|Approve|Apply|Allow|Bekræft|Confirm)$/]) { await clickByText(page, re); }
    const addMsg = proxyHits.filter(h=>h.includes('add-message')).length;
    if (addMsg >= 1) done = true; // tools executed by the IDE and results posted back
    if (i % 5 === 0) log(`t=${i*2}s hits=${proxyHits.length} addMsg=${addMsg}`);
    if (done) { await sleep(6000); break; } // let the loop finish + render
  }
  await removeOverlay(page); await shot(page, 'agent-02-result');

  const pageText = await page.evaluate(() => document.body.innerText);
  const createdProject = await page.evaluate(() => /SpaceGame/.test(document.title) || !!document.querySelector('[class*="tab"]') && /SpaceGame|Level1/i.test(document.body.innerText));
  log('=== RESULT ===');
  log('proxy hits:', JSON.stringify(proxyHits));
  log('add-message calls:', proxyHits.filter(h=>h.includes('add-message')).length);
  log('mentions SpaceGame:', /SpaceGame/i.test(pageText), '| mentions Level1:', /Level1/i.test(pageText));
  log('done flag:', done);
  fs.writeFileSync(`${OUT}\\agent-result.json`, JSON.stringify({ proxyHits, done, mentionsSpaceGame:/SpaceGame/i.test(pageText), mentionsLevel1:/Level1/i.test(pageText), consoleErrors:consoleErrors.slice(0,15) }, null, 2));
  await browser.close(); process.exit(0);
})().catch(e => { console.error('[agent-e2e] FATAL', e); process.exit(1); });
