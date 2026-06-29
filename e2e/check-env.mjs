import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args:['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://localhost:3000', { waitUntil:'domcontentloaded', timeout:90000 }).catch(()=>{});
await new Promise(r=>setTimeout(r, 9000));
const v = await p.evaluate(() => window.__localAi || '(window.__localAi not set)');
console.log('window.__localAi =', JSON.stringify(v));
await b.close();
