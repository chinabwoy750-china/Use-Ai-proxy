
const c = require('./providers-catalog');
const extra = {
  deepseek: { auth:'session', fields:[{key:'DEEPSEEK_TOKEN',label:'Token'},{key:'DEEPSEEK_COOKIE',label:'Cookie',area:true},{key:'DEEPSEEK_URL',label:'URL'}], modelsArr:['deepseek-chat','deepseek-reasoner'], kind:'chat' },
  kimi: { auth:'session', fields:[{key:'KIMI_TOKEN',label:'Access token',area:true},{key:'KIMI_REFRESH_TOKEN',label:'Refresh token',area:true},{key:'KIMI_URL',label:'URL'}], modelsArr:['kimi','kimi-k2'], kind:'chat' },
  perplexity: { auth:'session', fields:[{key:'PERPLEXITY_COOKIE',label:'Session cookie',area:true}], modelsArr:['perplexity','pplx-auto'], kind:'chat' },
  grok: { auth:'session', fields:[{key:'GROK_COOKIE',label:'Cookie',area:true}], modelsArr:['grok'], kind:'chat' },
  uc: { auth:'session', fields:[{key:'UC_COOKIE',label:'Cookie (__client)',area:true}], modelsArr:['uc','glm-image'], kind:'media' },
  mistral: { auth:'apikey', envKey:'MISTRAL_API_KEYS', modelsArr:['codestral','mistral-small'], kind:'chat' },
  huggingface: { auth:'session', fields:[{key:'HF_CHAT_COOKIE',label:'hf-chat'}], modelsArr:['hf'], kind:'chat' },
  opencode: { auth:'session', fields:[{key:'OPENCODE_ENABLED',label:'Enabled 1/0'}], modelsArr:['opencode'], kind:'chat' },
  notrack: { auth:'session', fields:[{key:'NOTRACK_COOKIE',label:'Cookie',area:true}], modelsArr:['notrack'], kind:'chat' },
  t3: { auth:'session', fields:[{key:'T3_COOKIE',label:'Cookie',area:true}], modelsArr:['t3'], kind:'chat' },
  venice: { auth:'session', fields:[{key:'VENICE_COOKIE',label:'Cookie',area:true}], modelsArr:['venice'], kind:'chat' },
  poe: { auth:'session', fields:[{key:'POE_COOKIE',label:'Cookie',area:true}], modelsArr:['poe'], kind:'chat' },
  arena: { auth:'session', fields:[{key:'ARENA_COOKIE',label:'Cookie',area:true}], modelsArr:['arena'], kind:'chat' },
  zenmux: { auth:'session', fields:[{key:'ZENMUX_COOKIE',label:'Cookie',area:true}], modelsArr:['zenmux'], kind:'chat' },
  blackbox: { auth:'session', fields:[{key:'BLACKBOX_COOKIE',label:'Cookie',area:true}], modelsArr:['blackbox'], kind:'chat' },
  inner: { auth:'session', fields:[{key:'INNER_TOKEN',label:'Token/cookie',area:true}], modelsArr:['inner'], kind:'chat' },
  adapta: { auth:'session', fields:[{key:'ADAPTA_COOKIE',label:'Cookie',area:true}], modelsArr:['adapta'], kind:'chat' },
  muse: { auth:'session', fields:[{key:'MUSE_COOKIE',label:'Cookie',area:true}], modelsArr:['muse'], kind:'chat' },
  tinycms: { auth:'session', fields:[{key:'TINYCMS_COOKIE',label:'Cookie',area:true}], modelsArr:['tinycms'], kind:'chat' },
  maxai: { auth:'session', fields:[{key:'MAXAI_COOKIE',label:'Cookie',area:true}], modelsArr:['maxai'], kind:'chat' },
  pollinations: { auth:'apikey', envKey:'POLLINATIONS_KEY', optional:true, modelsArr:['pollinations'], kind:'media' },
  doubao: { auth:'session', fields:[{key:'DOUBAO_COOKIE',label:'Cookie',area:true}], modelsArr:['doubao'], kind:'chat' },
  zai: { auth:'session', fields:[{key:'ZAI_COOKIE',label:'Cookie',area:true},{key:'ZAI_TOKEN',label:'Token'}], modelsArr:['zai'], kind:'chat' },
  yuanbao: { auth:'session', fields:[{key:'YUANBAO_COOKIE',label:'Cookie',area:true}], modelsArr:['yuanbao'], kind:'chat' },
  aistudio: { auth:'session', fields:[{key:'AISTUDIO_COOKIE',label:'Cookie',area:true}], modelsArr:['aistudio'], kind:'chat' },
  v0: { auth:'session', fields:[{key:'V0_COOKIE',label:'Cookie',area:true}], modelsArr:['v0'], kind:'chat' },
  notion: { auth:'session', fields:[{key:'NOTION_COOKIE',label:'Cookie',area:true}], modelsArr:['notion'], kind:'chat' },
  cloudflare: { auth:'apikey', envKey:'CF_API_TOKEN', modelsArr:['cloudflare'], kind:'chat' },
  longcat: { auth:'apikey', envKey:'LONGCAT_API_KEY', modelsArr:['longcat'], kind:'chat' },
  promptql: { auth:'session', fields:[{key:'PROMPTQL_TOKEN',label:'JWT',area:true}], modelsArr:['promptql'], kind:'chat' },
  hyperagent: { auth:'session', fields:[{key:'HYPERAGENT_COOKIE',label:'Cookie',area:true}], modelsArr:['hyperagent'], kind:'chat' },
  conol: { auth:'session', fields:[{key:'CONOL_COOKIE',label:'Cookie',area:true}], modelsArr:['conol'], kind:'chat' },
  twinmind: { auth:'session', fields:[{key:'TWINMIND_TOKEN',label:'JWT',area:true}], modelsArr:['twinmind'], kind:'chat' },
  syntx: { auth:'session', fields:[{key:'SYNTX_TOKEN',label:'JWT',area:true}], modelsArr:['syntx'], kind:'chat' },
  veo: { auth:'session', fields:[{key:'VEO_ENABLED',label:'Enabled 1/0'}], modelsArr:['veo','veo-image'], kind:'media' },
};
const out = c.PROVIDERS.map(p => {
  const e = extra[p.id] || { auth:'session', fields:[{key: p.id.toUpperCase()+'_COOKIE', label:'Cookie', area:true}], modelsArr: String(p.models||p.id).split(/[,\s]+/).filter(Boolean), kind:'chat' };
  return Object.assign({}, p, e, {
    models: e.modelsArr || (typeof p.models === 'string' ? p.models.split(/[,\s]+/).filter(Boolean) : (p.models||[p.id])),
    blurb: p.blurb || (e.auth==='apikey' ? 'API key provider' : 'Web session / cookie provider'),
    keyUrl: p.site,
    suggested: e.modelsArr || [],
  });
});
console.log(JSON.stringify(out));
