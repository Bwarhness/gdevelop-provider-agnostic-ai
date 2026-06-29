import puppeteer from 'puppeteer-core';
const OUT = 'C:/Users/nalar/AppData/Local/Temp/claude/C--Users-nalar-gdeveloplocal/15b5a006-53f7-4dbf-adb9-50cdb05b2842/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 900, height: 1150 }, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.goto('http://localhost:4000/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
await sleep(2500);
const opts = await p.evaluate(() => {
  const sel = document.getElementById('ompModels');
  if (!sel) return { found: false };
  return { found: true, count: sel.options.length, sample: [...sel.options].slice(0, 8).map(o => o.textContent) };
});
const sel = await p.evaluate(() => {
  const s = document.getElementById('ompModels');
  if (!s) return 'no-select';
  const i = [...s.options].findIndex(o => /xiaomi.*ultraspeed/i.test(o.textContent));
  if (i < 0) return 'no-ultraspeed-option';
  s.selectedIndex = i; return s.options[i].textContent;
});
await p.screenshot({ path: `${OUT}/config-ui.png` });
console.log(JSON.stringify({ opts, ultraspeedOption: sel }, null, 2));
await b.close();
