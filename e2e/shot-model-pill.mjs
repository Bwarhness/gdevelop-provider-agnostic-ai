import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 1000 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
await sleep(16000);
for (const re of ['Spørg AI', 'Ask AI']) { if (await clickText(p, re)) break; }
await sleep(5000);
// The model pill shows the current model name (mimo...). Look for it near the reasoning pill.
const found = await p.evaluate(() => {
  const t = document.body.innerText || '';
  return { hasMimo: /mimo/i.test(t), hasMedium: /medium/i.test(t), bodyHasModelWord: /MiMo|mimo-v2/i.test(t) };
});
await p.screenshot({ path: `${OUT}/model-pill.png` });
// Click the model pill to open its menu and capture options.
const clicked = await clickText(p, 'MiMo');
await sleep(1200);
const menu = await p.evaluate(() => [...document.querySelectorAll('li[role="menuitem"],li')].map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 25));
await p.screenshot({ path: `${OUT}/model-menu.png` });
console.log(JSON.stringify({ found, errors: errors.slice(0, 4), menuSample: menu }, null, 2));
await b.close();
