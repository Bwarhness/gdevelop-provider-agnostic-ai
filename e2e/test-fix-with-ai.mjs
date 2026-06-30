// End-to-end test of the "Fix with AI" button on the diagnostic report.
// 1) agent builds a project with an undeclared-variable event (a real diagnostic)
// 2) open the diagnostic report via the command palette (Ctrl+P)
// 3) click "Fix with AI" and confirm a new agent request reaches the proxy.
import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfg = async () => (await fetch('http://localhost:4000/health')).json();

async function clickText(p, src, maxLen = 40) {
  const h = await p.evaluateHandle((s, ml) => {
    const rx = new RegExp(s, 'i');
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const m = [...document.querySelectorAll('*')].filter(e => vis(e) && rx.test((e.innerText || '').trim()) && (e.innerText || '').length < ml).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!m) return null;
    let c = m; while (c && c !== document.body) { const t = c.tagName.toLowerCase(); if (t === 'button' || c.getAttribute('role') === 'button' || c.getAttribute('role') === 'option') break; c = c.parentElement; }
    return c && c !== document.body ? c : m;
  }, src, maxLen);
  const el = h.asElement(); if (!el) return false;
  try { await el.click({ delay: 30 }); return true; } catch { try { await p.evaluate(n => n.click(), el); return true; } catch { return false; } }
}
async function activeRequests() { return (await cfg()).activeRequests; }

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 1000 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
await sleep(16000);

// 1) Ask the agent to build a project with an undeclared variable usage.
for (const re of ['Spørg AI', 'Ask AI']) { if (await clickText(p, re)) break; }
await sleep(4000);
await p.evaluate(() => { const ta = [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 100); if (ta) ta.focus(); });
await p.keyboard.type('Create a new empty project with one scene named Broken. In the Broken scene add exactly one event whose condition compares the scene variable named GhostScore to be greater than 100, with no action. Do NOT create or declare the variable GhostScore anywhere — leave it undeclared.', { delay: 4 });
await sleep(400);
await p.evaluate(() => {
  const ta = [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 100);
  const tr = ta.getBoundingClientRect();
  const btn = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left > tr.left + tr.width / 2 && r.top > tr.top && r.top < tr.bottom + 20 && !b.disabled; }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
  if (btn) btn.click();
});
console.log('agent request sent; waiting for it to finish building...');

// Wait for the agent to go idle (activeRequests back to 0 after having been > 0).
let sawWork = false;
for (let i = 0; i < 75; i++) {
  await sleep(3000);
  const ar = await activeRequests().catch(() => 0);
  if (ar > 0) sawWork = true;
  if (sawWork && ar === 0) break;
}
await sleep(3000);
await p.screenshot({ path: `${OUT}/fix-1-built.png` });
console.log('agent idle. sawWork =', sawWork);

// 2) Open the command palette and run "Open diagnostic report".
// First blur the chat textarea by clicking an empty part of the scene editor.
await p.mouse.click(680, 540);
await sleep(800);
await p.keyboard.down('Control'); await p.keyboard.press('KeyK'); await p.keyboard.up('Control');
await sleep(1500);
// "diagnos" is a safe prefix for both English ("diagnostic") and Danish ("diagnostisk").
await p.keyboard.type('diagnos', { delay: 40 });
await sleep(1500);
await p.screenshot({ path: `${OUT}/fix-2-palette.png` });
// Click the matching command option, else press Enter to run the top match.
let opened = await clickText(p, 'diagnos', 60);
if (!opened) { await p.keyboard.press('Enter'); opened = true; }
await sleep(2500);
await p.screenshot({ path: `${OUT}/fix-3-report.png` });

// 3) Inspect the dialog: is there a "Fix with AI" button? does it list GhostScore?
const report = await p.evaluate(() => {
  const t = document.body.innerText || '';
  const hasDialog = /Diagnostic report/i.test(t);
  const hasFixBtn = !!([...document.querySelectorAll('button')].find(b => /fix with ai/i.test(b.innerText || '')));
  const mentionsVar = /GhostScore|Missing scene variables/i.test(t);
  const noIssues = /No issues found/i.test(t);
  return { hasDialog, hasFixBtn, mentionsVar, noIssues };
});
console.log('report dialog:', JSON.stringify(report));

let proxyResult = 'not-clicked';
if (report.hasFixBtn) {
  const before = await activeRequests().catch(() => 0);
  await clickText(p, 'Fix with AI', 30);
  // a new agent request should be created+sent
  let fired = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const ar = await activeRequests().catch(() => 0);
    if (ar > before) { fired = true; break; }
  }
  await sleep(2000);
  await p.screenshot({ path: `${OUT}/fix-4-sent.png` });
  proxyResult = fired ? 'NEW-REQUEST-SENT' : 'no-new-request-detected';
}
console.log(JSON.stringify({ report, proxyResult, pageErrors: errors.slice(0, 3) }, null, 2));
await b.close();
