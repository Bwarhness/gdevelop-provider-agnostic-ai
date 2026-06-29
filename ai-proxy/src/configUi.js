// Self-contained provider-configuration UI served by the proxy at GET /.
// Lets users pick/configure the OpenAI-compatible backend without editing .env.

export const PROVIDER_PRESETS = {
  'Kimi (oh-my-pi)': { baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding', authSource: 'omp-kimi', extraHeaders: '{"User-Agent":"KimiCLI/1.0","X-Msh-Platform":"kimi_cli"}' },
  'Xiaomi MiMo UltraSpeed (oh-my-pi)': { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-pro-ultraspeed', authSource: 'omp:xiaomi', extraHeaders: '{}' },
  'OpenAI': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', authSource: '', extraHeaders: '{}' },
  'Moonshot/Kimi (API key)': { baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-0905-preview', authSource: '', extraHeaders: '{}' },
  'Ollama (local)': { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', authSource: '', extraHeaders: '{}' },
  'vLLM (local)': { baseUrl: 'http://localhost:8000/v1', model: 'your-model', authSource: '', extraHeaders: '{}' },
  'Gemini (OpenAI-compat)': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', authSource: '', extraHeaders: '{}' },
};

export const CONFIG_UI_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>GDevelop AI Proxy — Provider config</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:dark}
 body{font:14px/1.5 system-ui,sans-serif;background:#0f1117;color:#e6e6e6;margin:0;padding:2rem;max-width:760px;margin:auto}
 h1{font-size:1.3rem} h2{font-size:1rem;margin-top:1.5rem;color:#9aa4b2}
 label{display:block;margin:.6rem 0 .2rem;color:#c4ccd6}
 input,select,textarea{width:100%;box-sizing:border-box;background:#1b1f2a;border:1px solid #2c3340;color:#e6e6e6;border-radius:6px;padding:.5rem;font:inherit}
 textarea{min-height:48px}
 .row{display:flex;gap:1rem}.row>div{flex:1}
 button{background:#5b5bd6;color:#fff;border:0;border-radius:6px;padding:.55rem 1rem;font:inherit;cursor:pointer;margin:.3rem .3rem 0 0}
 button.secondary{background:#2c3340}
 .presets button{background:#222838;border:1px solid #2c3340;font-size:.85rem}
 #status{margin-top:1rem;padding:.6rem .8rem;border-radius:6px;white-space:pre-wrap;display:none}
 .ok{background:#143524;border:1px solid #1f6f43}.err{background:#3a1620;border:1px solid #7a2233}
 small{color:#7a8493}
</style></head><body>
<h1>🎮 GDevelop AI Proxy</h1>
<p><small>Route GDevelop's "Ask AI" to any OpenAI-compatible LLM. Changes apply immediately to the running proxy.</small></p>

<h2>Agent (oh-my-pi model)</h2>
<p><small>Pick a provider/model from your local oh-my-pi install. ✓ = credential available.</small></p>
<div class="row">
 <div style="flex:3"><select id="ompModels"><option value="">— Loading oh-my-pi models… —</option></select></div>
 <div style="flex:1"><button class="secondary" onclick="useOmp()">Use this agent</button></div>
</div>

<h2>Presets</h2>
<div class="presets" id="presets"></div>

<h2>Provider</h2>
<label>Base URL <input id="baseUrl" placeholder="https://api.openai.com/v1"></label>
<label>Model <input id="model" placeholder="gpt-4o"></label>
<div class="row">
 <div><label>Auth source <select id="authSource"><option value="">API key</option><option value="omp-kimi">oh-my-pi Kimi (auto-refresh)</option><option value="omp:xiaomi">oh-my-pi Xiaomi</option></select></label></div>
 <div><label>API key <input id="apiKey" type="password" placeholder="(leave blank to keep current)"></label></div>
</div>
<div class="row">
 <div><label>Temperature <input id="temperature" type="number" step="0.1" min="0" max="2"></label></div>
 <div><label>Max tokens <input id="maxTokens" type="number" min="1"></label></div>
</div>
<label>Extra headers (JSON) <textarea id="extraHeaders" placeholder='{}'></textarea></label>

<div>
 <button onclick="save()">Save</button>
 <button class="secondary" onclick="test()">Test connection</button>
 <button class="secondary" onclick="load()">Reload</button>
</div>
<div id="status"></div>

<script>
const PRESETS = ${JSON.stringify(PROVIDER_PRESETS)};
const $=id=>document.getElementById(id);
function show(msg,ok){const s=$('status');s.textContent=msg;s.className=ok?'ok':'err';s.style.display='block';}
function fill(c){$('baseUrl').value=c.baseUrl||'';$('model').value=c.model||'';$('authSource').value=c.authSource||'';$('temperature').value=c.temperature;$('maxTokens').value=c.maxTokens;$('extraHeaders').value=JSON.stringify(c.extraHeaders||{},null,0);}
async function load(){const r=await fetch('/config');const c=await r.json();fill(c);show('Loaded current config. Key is '+(c.hasKey?'set':'not set')+'.',true);}
async function save(){
 let headers={};try{headers=JSON.parse($('extraHeaders').value||'{}')}catch(e){return show('Extra headers is not valid JSON.',false)}
 const body={baseUrl:$('baseUrl').value.trim(),model:$('model').value.trim(),authSource:$('authSource').value,temperature:parseFloat($('temperature').value),maxTokens:parseInt($('maxTokens').value),extraHeaders:headers};
 const k=$('apiKey').value;if(k)body.apiKey=k;
 const r=await fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const c=await r.json();$('apiKey').value='';fill(c);show('Saved. Provider is now '+c.baseUrl+' ('+c.model+').',true);
}
async function test(){
 show('Testing…',true);
 const r=await fetch('/config/test',{method:'POST'});const t=await r.json();
 if(t.ok)show('✅ '+t.message,true);else show('❌ '+t.message,false);
}
const pc=$('presets');Object.keys(PRESETS).forEach(name=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>{const p=PRESETS[name];$('baseUrl').value=p.baseUrl;$('model').value=p.model;$('authSource').value=p.authSource;$('extraHeaders').value=p.extraHeaders;show('Filled "'+name+'". Set the API key (if needed) and click Save.',true);};pc.appendChild(b);});

// oh-my-pi model picker: maps a model's provider to the right auth source.
let OMP=[];
function ompAuthSource(p){if(p==='kimi-code')return'omp-kimi';if(p==='ollama'||p==='llama.cpp'||p==='lm-studio')return'';return'omp:'+p;}
function ompHeaders(p){return p==='kimi-code'?'{"User-Agent":"KimiCLI/1.0","X-Msh-Platform":"kimi_cli"}':'{}';}
async function loadOmp(){
 try{const r=await fetch('/omp-models');const j=await r.json();OMP=(j.models||[]);}catch(e){OMP=[];}
 const sel=$('ompModels');sel.innerHTML='';
 if(!OMP.length){sel.innerHTML='<option value="">(no oh-my-pi models found)</option>';return;}
 OMP.forEach((m,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=(m.hasCredential?'✓ ':'   ')+m.provider+' · '+(m.name||m.id)+(m.reasoning?'  (reasoning)':'');sel.appendChild(o);});
}
function useOmp(){
 const i=$('ompModels').value;if(i==='')return;const m=OMP[Number(i)];if(!m)return;
 $('baseUrl').value=m.baseUrl;$('model').value=m.id;$('authSource').value=ompAuthSource(m.provider);$('extraHeaders').value=ompHeaders(m.provider);
 const needsKey=!m.hasCredential&&!(m.provider==='ollama'||m.provider==='llama.cpp'||m.provider==='lm-studio');
 save().then(()=>{if(needsKey)show('Saved '+m.provider+' · '+m.id+', but no oh-my-pi credential was found — set an API key above and Save again.',false);});
}
loadOmp();
load();
</script></body></html>`;
