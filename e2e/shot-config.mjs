import puppeteer from 'puppeteer-core';
const b=await puppeteer.launch({executablePath:'C:\Program Files\Google\Chrome\Application\chrome.exe',headless:'new',defaultViewport:{width:820,height:1000},args:['--no-sandbox']});
const p=await b.newPage();
await p.goto('http://localhost:4000/',{waitUntil:'networkidle2',timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,1500));
await p.screenshot({path:'C:\Users\nalar\AppData\Local\Temp\claude\C--Users-nalar-gdeveloplocal\15b5a006-53f7-4dbf-adb9-50cdb05b2842\scratchpad\config-ui.png'});
await b.close();console.log('shot done');
