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
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
await sleep(15000);
for (const re of ['Spørg AI', 'Ask AI']) { if (await clickText(p, re)) break; }
await sleep(4000);
await p.evaluate(() => { const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 100; }); if (ta) ta.focus(); });
await p.keyboard.type('What is a sprite in a 2D game? Answer in one short sentence.', { delay: 6 });
await sleep(400);
// Click the send button: the submit button nearest the bottom-right of the textarea.
const clicked = await p.evaluate(() => {
  const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 100; });
  if (!ta) return 'no-textarea';
  const form = ta.closest('div');
  // gather candidate buttons in the chat input region
  const btns = [...document.querySelectorAll('button')].filter(btn => { const r = btn.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !btn.disabled; });
  const tr = ta.getBoundingClientRect();
  // the send button sits inside/near the textarea's bottom-right
  const cand = btns.filter(btn => { const r = btn.getBoundingClientRect(); return r.left > tr.left + tr.width / 2 && r.top > tr.top && r.top < tr.bottom + 20; })
    .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
  if (cand) { cand.click(); return 'clicked-send'; }
  return 'no-send-btn';
});
console.log('send action:', clicked);
let status = 'timeout';
for (let i = 0; i < 45; i++) {
  await sleep(2000);
  const r = await p.evaluate(() => {
    const t = document.body.innerText || '';
    const after = (t.split('one short sentence.')[1] || '');
    return /sprite|billede|grafik|2D|image|object|figur/i.test(after) && after.length > 20;
  });
  if (r) { status = 'reply-received'; break; }
}
await p.screenshot({ path: `${OUT}/send-after2.png` });
console.log('status:', status);
await b.close();
