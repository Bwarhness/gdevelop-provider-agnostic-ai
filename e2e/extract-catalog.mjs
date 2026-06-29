// Extract GDevelop's full condition/action instruction catalog from the running
// IDE's WASM (window.gd) and write it to ai-proxy/src/instruction-catalog.json.
// This is the reference the events-generation prompt needs (valid type.value + params).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'C:\\Users\\nalar\\gdeveloplocal\\ai-proxy\\src\\instruction-catalog.json';

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', e => console.error('[pageerror]', e.message.slice(0, 120)));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await p.waitForFunction(() => !!(window.gd && window.gd.JsPlatform && window.gd.JsPlatform.get), { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));

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
    let name = ''; try { name = ext.getName(); } catch (er) {}
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
const conds = catalog.filter(c => c.kind === 'condition').length;
console.log(`Wrote ${catalog.length} instructions (${conds} conditions, ${catalog.length - conds} actions) to instruction-catalog.json`);
// sample a few well-known ones with FULL param structure (codeOnly marked)
for (const t of ['KeyPressed', 'SimulateJumpKey', 'Hide', 'MettreX', 'Create', 'SetNumberVariable', 'ModVarScene', 'PlaySound']) {
  const m = catalog.find(c => c.type === t || c.type.endsWith('::' + t));
  if (m) console.log(`  ${m.kind} ${m.type}  params=[${m.params.map((x, i) => `${i}:${x.type}${x.codeOnly ? '(codeOnly)' : ''}${x.extraInfo ? '=' + x.extraInfo : ''}`).join(', ')}]`);
}
await b.close();
