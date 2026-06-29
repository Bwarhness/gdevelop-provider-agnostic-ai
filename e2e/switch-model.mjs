// Verifies the in-chat model selector actually switches the running proxy.
import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfg = async () => (await fetch('http://localhost:4000/config')).json();
async function clickText(p, src) {
  const h = await p.evaluateHandle(s => {
    const rx = new RegExp(s, 'i');
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const m = [...document.querySelectorAll('*')].filter(e => vis(e) && rx.test((e.innerText || '').trim()) && (e.innerText || '').length < 40).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!m) return null;
    let c = m; while (c && c !== document.body) { const t = c.tagName.toLowerCase(); if (t === 'button' || c.getAttribute('role') === 'button') break; c = c.parentElement; }
    return c && c !== document.body ? c : m;
  }, src);
  const el = h.asElement(); if (!el) return false;
  try { await el.click({ delay: 30 }); return true; } catch { try { await p.evaluate(n => n.click(), el); return true; } catch { return false; } }
}
const before = await cfg();
console.log('before:', before.model);

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 1000 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
await sleep(16000);
for (const re of ['Spørg AI', 'Ask AI']) { if (await clickText(p, re)) break; }
await sleep(5000);
// Open the model menu by clicking the pill (its label is the current model name).
await clickText(p, 'UltraSpeed');
await sleep(1000);
// Click the exact "MiMo-V2.5-Pro" menu item (NOT ultraspeed) under xiaomi (same credential).
const picked = await p.evaluate(() => {
  const items = [...document.querySelectorAll('li[role="menuitem"]')];
  const target = items.find(li => /^MiMo-V2\.5-Pro\s*·\s*reasoning$/i.test((li.innerText || '').trim()));
  if (!target) return 'not-found';
  target.click();
  return (target.innerText || '').trim();
});
console.log('picked menu item:', picked);
await sleep(2500);
const after = await cfg();
const pill = await p.evaluate(() => {
  // read the model pill label (the button next to "Medium")
  const btns = [...document.querySelectorAll('button')];
  const m = btns.map(b => (b.innerText || '').trim()).find(t => /MiMo/i.test(t));
  return m || null;
});
await p.screenshot({ path: `${OUT}/switched.png` });
console.log(JSON.stringify({ before: before.model, after: after.model, pillLabel: pill, switched: after.model !== before.model }, null, 2));
await b.close();
