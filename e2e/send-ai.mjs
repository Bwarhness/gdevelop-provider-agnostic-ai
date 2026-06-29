// End-to-end: drive the real IDE's Ask AI, send a prompt, verify a reply renders.
// Confirms the free AI send path still works with the injected permissive `limits`.
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

// Type into the chat textarea / input.
const typed = await p.evaluate(() => {
  const ta = [...document.querySelectorAll('textarea,input[type="text"]')].find(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 0; });
  if (!ta) return false;
  ta.focus();
  return true;
});
await p.keyboard.type('What is a sprite in a 2D game? Answer in one sentence.', { delay: 8 });
await sleep(500);
await p.screenshot({ path: `${OUT}/send-before.png` });

// Submit: press Enter (GDevelop chat sends on Enter).
await p.keyboard.press('Enter');

// Wait for a reply to appear (poll the DOM for new assistant text / a "thinking" then content).
let replyLen = 0, status = 'timeout';
for (let i = 0; i < 40; i++) {
  await sleep(2000);
  const r = await p.evaluate(() => {
    const t = document.body.innerText || '';
    return { hasSprite: /sprite/i.test(t.split('one sentence.')[1] || ''), len: t.length };
  });
  if (r.hasSprite) { status = 'reply-received'; replyLen = r.len; break; }
}
await p.screenshot({ path: `${OUT}/send-after.png` });
console.log(JSON.stringify({ typed, status }, null, 2));
await b.close();
