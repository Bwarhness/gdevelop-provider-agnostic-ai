import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 1000 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', e => errors.push('pageerror: ' + e.message));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => errors.push('goto: ' + e.message));
await sleep(15000);
// Detect a webpack compile-error overlay (react-error-overlay iframe or #webpack-dev-server-client-overlay).
const overlay = await p.evaluate(() => {
  const ifr = document.querySelector('iframe');
  const ov = document.querySelector('#webpack-dev-server-client-overlay');
  const bodyText = (document.body.innerText || '').slice(0, 200);
  return {
    hasOverlay: !!ov,
    hasIframe: !!ifr,
    bodyLen: (document.body.innerText || '').length,
    bodyHead: bodyText,
  };
});
// Did the GDevelop app shell mount? look for typical UI text.
const mounted = await p.evaluate(() => {
  const t = document.body.innerText || '';
  return /Ask AI|Spørg AI|Build|Create|Home|File|Scene/i.test(t);
});
await p.screenshot({ path: `${OUT}/unlock.png` });
console.log(JSON.stringify({ overlay, mounted, errors: errors.slice(0, 5) }, null, 2));
await b.close();
