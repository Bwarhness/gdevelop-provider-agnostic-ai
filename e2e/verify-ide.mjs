// End-to-end verification of the provider-agnostic AI chat inside the GDevelop IDE.
// Drives the installed Chrome via puppeteer-core: loads localhost:3000, opens the
// "Ask AI" feature, sends a message, and confirms a reply arrives through the local
// proxy (localhost:4000). Screenshots each step.
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'C:\\Users\\nalar\\AppData\\Local\\Temp\\claude\\C--Users-nalar-gdeveloplocal\\15b5a006-53f7-4dbf-adb9-50cdb05b2842\\scratchpad';
const URL = 'http://localhost:3000';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

const proxyHits = [];
const consoleErrors = [];

async function shot(page, name) {
  const p = `${OUT}\\${name}.png`;
  try { await page.screenshot({ path: p, fullPage: false }); log('screenshot', p); } catch (e) { log('screenshot failed', name, e.message); }
}

// Remove the react-scripts / webpack dev error overlay (dev-only, blocks clicks).
async function removeOverlay(page) {
  await page.evaluate(() => {
    for (const sel of ['#webpack-dev-server-client-overlay', 'iframe[style*="z-index: 2147483647"]', 'iframe']) {
      document.querySelectorAll(sel).forEach(el => {
        const r = el.getBoundingClientRect();
        if (el.id === 'webpack-dev-server-client-overlay' || (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8)) el.remove();
      });
    }
  }).catch(() => {});
}

// Find a clickable element whose visible text matches `re`, then click the nearest
// clickable ancestor (so clicking a <span> inside a <button> still fires the handler).
async function clickByText(page, re, tag = '*') {
  const handle = await page.evaluateHandle((reSrc, tag) => {
    const rx = new RegExp(reSrc, 'i');
    const els = [...document.querySelectorAll(tag)];
    const isVisible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const matches = els.filter(el => isVisible(el) && rx.test((el.innerText || el.textContent || '').trim()) && (el.innerText || '').length < 80);
    matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    let el = matches[0];
    if (!el) return null;
    // climb to nearest button / link / role=button
    let clickable = el;
    while (clickable && clickable !== document.body) {
      const tagN = clickable.tagName.toLowerCase();
      if (tagN === 'button' || tagN === 'a' || clickable.getAttribute('role') === 'button' || clickable.getAttribute('role') === 'tab') break;
      clickable = clickable.parentElement;
    }
    return clickable && clickable !== document.body ? clickable : el;
  }, re.source || re, tag);
  const el = handle.asElement();
  if (!el) return false;
  try { await el.click({ delay: 30 }); return true; } catch (e) {
    try { await page.evaluate(n => n.click(), el); return true; } catch (e2) { log('click failed', re, e2.message); return false; }
  }
}

async function listAiElements(page) {
  return page.evaluate(() => {
    const out = [];
    const isVisible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const el of document.querySelectorAll('button, a, [role="button"], [role="tab"], div, span')) {
      const t = (el.innerText || '').trim();
      if (t && t.length < 60 && /\bAI\b|Ask AI|assistant/i.test(t) && isVisible(el)) {
        out.push({ tag: el.tagName, text: t.replace(/\s+/g, ' ').slice(0, 50) });
      }
    }
    // dedupe
    return [...new Map(out.map(o => [o.tag + '|' + o.text, o])).values()].slice(0, 25);
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--disable-features=Translate'],
  });
  const page = await browser.newPage();

  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 200)));
  page.on('request', req => { if (req.url().includes('localhost:4000')) proxyHits.push(req.method() + ' ' + req.url()); });

  log('navigating to', URL);
  try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch (e) { log('goto warn', e.message); }
  await sleep(10000); // let the WASM core + React mount
  await removeOverlay(page);
  await shot(page, 'e2e-01-initial');

  // Dismiss any initial dialog (best effort).
  for (const re of [/^(Got it|Continue|Close|Skip|Later|No thanks|Luk|Forts)$/]) {
    if (await clickByText(page, re, 'button')) { log('dismissed dialog via', re); await sleep(1500); }
  }
  await removeOverlay(page);

  log('AI elements found:', JSON.stringify(await listAiElements(page)));

  // Try to open Ask AI ("Spørg AI'en" is the Danish homepage CTA).
  let opened = false;
  for (const re of [/Spørg AI/, /Ask AI/, /AI assistant/, /\bAsk\b/]) {
    if (await clickByText(page, re)) { log('clicked', re); opened = true; await sleep(4000); break; }
  }
  await removeOverlay(page);
  await shot(page, 'e2e-02-after-open');

  await removeOverlay(page);
  // Find a text input / textarea and type a question.
  const typed = await page.evaluate(() => {
    const els = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 0; });
    if (!els.length) return false;
    els[els.length - 1].focus();
    return true;
  });
  log('found text input:', typed);
  if (typed) {
    await page.keyboard.type('How do I make my player jump?');
    await sleep(800);
    await shot(page, 'e2e-03-typed');
    // Submit: the send control is an icon button at the bottom-right of the textarea.
    const sendPos = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return null;
      const tr = ta.getBoundingClientRect();
      // Find a small icon button overlapping the textarea's bottom-right.
      const btn = [...document.querySelectorAll('button')].find(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.width < 70 && r.height < 70 &&
          r.right > tr.right - 70 && r.right < tr.right + 20 &&
          r.bottom > tr.bottom - 70 && r.bottom < tr.bottom + 20;
      });
      if (btn) { const r = btn.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: 'button' }; }
      return { x: tr.right - 24, y: tr.bottom - 24, found: 'fallback-coord' };
    });
    log('send target:', JSON.stringify(sendPos));
    if (sendPos) await page.mouse.click(sendPos.x, sendPos.y);
    await sleep(1500);
    // Fallback: also try Ctrl+Enter / Cmd+Enter submit shortcuts.
    if (!proxyHits.some(h => h.includes('POST'))) {
      await page.evaluate(() => { const ta = document.querySelector('textarea'); if (ta) ta.focus(); });
      await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
    }
    log('waiting for POST + reply...');
    for (let i = 0; i < 40 && !proxyHits.some(h => h.includes('POST') && h.includes('/ai-request')); i++) await sleep(1000);
    // give the poll loop time to fetch the 'ready' assistant message
    for (let i = 0; i < 25; i++) { await removeOverlay(page); if (/Mock LLM reply|Platformer Character behavior/i.test(await page.evaluate(() => document.body.innerText))) break; await sleep(1000); }
    await removeOverlay(page);
    await shot(page, 'e2e-04-reply');
  }

  // Did the mock reply render?
  const replyVisible = await page.evaluate(() =>
    /Mock LLM reply|Platformer Character behavior/i.test(document.body.innerText)
  );

  log('=== RESULT ===');
  log('proxy hits:', JSON.stringify(proxyHits, null, 0));
  log('mock reply visible in page:', replyVisible);
  log('console errors (first 10):', JSON.stringify(consoleErrors.slice(0, 10), null, 0));

  fs.writeFileSync(`${OUT}\\e2e-result.json`, JSON.stringify({ proxyHits, replyVisible, consoleErrors: consoleErrors.slice(0, 20) }, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('[e2e] FATAL', e); process.exit(1); });
