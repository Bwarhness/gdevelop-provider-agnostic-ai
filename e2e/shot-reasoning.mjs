import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function clickText(p, re) {
  const h = await p.evaluateHandle(s => {
    const rx = new RegExp(s, 'i');
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const m = [...document.querySelectorAll('*')].filter(e => vis(e) && rx.test((e.innerText || '').trim()) && (e.innerText || '').length < 40).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!m) return null;
    let c = m; while (c && c !== document.body) { const t = c.tagName.toLowerCase(); if (t === 'button' || c.getAttribute('role') === 'button') break; c = c.parentElement; }
    return c && c !== document.body ? c : m;
  }, re.source || re);
  const el = h.asElement(); if (!el) return false;
  try { await el.click({ delay: 30 }); return true; } catch { try { await p.evaluate(n => n.click(), el); return true; } catch { return false; } }
}
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 1000 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await sleep(12000);
for (const re of [/Spørg AI/, /Ask AI/]) { if (await clickText(p, re)) break; }
await sleep(4000);
// Click the reasoning-level selector (the "Medium" pill at the bottom of the chat).
const clicked = await clickText(p, /^Medium$/);
await sleep(1500);
await p.screenshot({ path: `${OUT}/reasoning.png` });
console.log('reasoning selector clicked:', clicked);
// Read the dropdown items + whether any are disabled (crown = premium/locked)
const items = await p.evaluate(() => [...document.querySelectorAll('li,[role="menuitem"],[role="option"]')].map(e => ({ text: (e.innerText || '').trim().slice(0, 30), disabled: e.getAttribute('aria-disabled') === 'true' || e.classList.contains('Mui-disabled') })).filter(i => /medium|high|max/i.test(i.text)));
console.log('reasoning items:', JSON.stringify(items));
await b.close();
