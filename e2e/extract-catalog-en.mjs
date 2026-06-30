// Re-extract GDevelop's instruction catalog in ENGLISH (the IDE normally runs in the
// user's locale = Danish). We force the GDevelop language preference to 'en' before boot
// so getSentence()/getFullName()/getDescription() return the English source strings.
// Writes to a temp file first for inspection; promote to src/instruction-catalog.json after.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.argv[2] || 'C:\\Users\\nalar\\AppData\\Local\\Temp\\claude\\C--Users-nalar-gdeveloplocal\\15b5a006-53f7-4dbf-adb9-50cdb05b2842\\scratchpad\\instruction-catalog-en.json';

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--lang=en-US'] });
const p = await b.newPage();
await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
// Force GDevelop's language to English before the app reads its preferences.
await p.evaluateOnNewDocument(() => {
  try { localStorage.setItem('gd-preferences', JSON.stringify({ language: 'en' })); } catch (e) {}
});
p.on('pageerror', e => console.error('[pageerror]', e.message.slice(0, 120)));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await p.waitForFunction(() => !!(window.gd && window.gd.JsPlatform && window.gd.JsPlatform.get), { timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));

const catalog = await p.evaluate(() => {
  const gd = window.gd;
  const platform = gd.JsPlatform.get();
  const exts = platform.getAllPlatformExtensions();
  const seen = new Set();
  const out = [];
  const readParams = m => {
    const params = [];
    const n = m.getParametersCount();
    for (let i = 0; i < n; i++) {
      const pm = m.getParameter(i);
      let codeOnly = false; try { codeOnly = pm.isCodeOnly(); } catch (e) {}
      let optional = false; try { optional = pm.isOptional(); } catch (e) {}
      let extra = ''; try { extra = pm.getExtraInfo(); } catch (e) {}
      let desc = ''; try { desc = pm.getDescription(); } catch (e) {}
      params.push({ type: pm.getType(), desc, optional, codeOnly, extraInfo: extra || undefined });
    }
    return params;
  };
  const collect = (instructions, kind, scope) => {
    let keys; try { keys = instructions.keys(); } catch (e) { return; }
    for (let j = 0; j < keys.size(); j++) {
      const type = keys.at(j);
      const dk = kind + '|' + type;
      if (seen.has(dk)) continue;
      let m; try { m = instructions.get(type); } catch (e) { continue; }
      let hidden = false; try { hidden = m.isHidden(); } catch (e) {}
      if (hidden) continue;
      seen.add(dk);
      let sentence = ''; try { sentence = m.getSentence(); } catch (e) {}
      let fullName = ''; try { fullName = m.getFullName(); } catch (e) {}
      let description = ''; try { description = m.getDescription(); } catch (e) {}
      out.push({ type, kind, scope, fullName, description, sentence, params: readParams(m) });
    }
  };
  const objectTypes = ['', 'Sprite', 'TextObject::Text', 'TiledSpriteObject::TiledSprite', 'PanelSpriteObject::PanelSprite', 'Scene3D::Cube3DObject'];
  for (let e = 0; e < exts.size(); e++) {
    const ext = exts.at(e);
    collect(ext.getAllConditions(), 'condition', 'free');
    collect(ext.getAllActions(), 'action', 'free');
    for (const ot of objectTypes) {
      try { collect(ext.getAllConditionsForObject(ot), 'condition', 'object:' + (ot || 'base')); } catch (er) {}
      try { collect(ext.getAllActionsForObject(ot), 'action', 'object:' + (ot || 'base')); } catch (er) {}
    }
    let bts; try { bts = ext.getBehaviorsTypes(); } catch (er) { bts = null; }
    if (bts) for (let k = 0; k < bts.size(); k++) {
      const bt = bts.at(k);
      try { collect(ext.getAllConditionsForBehavior(bt), 'condition', 'behavior:' + bt); } catch (er) {}
      try { collect(ext.getAllActionsForBehavior(bt), 'action', 'behavior:' + bt); } catch (er) {}
    }
  }
  return out;
});

fs.writeFileSync(OUT, JSON.stringify(catalog, null, 0), 'utf8');
console.log(`Wrote ${catalog.length} instructions to ${OUT}`);
// Show a few known ones to verify the language.
for (const t of ['PlatformBehavior::SimulateJumpKey', 'SetStringObjectVariable', 'TextObject::SetText', 'CompareTimer', 'Create']) {
  const m = catalog.find(c => c.type === t);
  if (m) console.log(`  ${m.type} [${m.kind === 'condition' ? 'c' : 'a'}] "${m.sentence}"`);
}
await b.close();
