'use strict';
// Surge Mac. All network probes explicitly use one named policy and no cookie jar.

const TARGET = 'AI Picks';
const REPORT = 'ai-picks-native-us-v1';
const mode = typeof $argument === 'string' ? $argument : 'primary';
const ruleVersion = 'us-native-risk-lt39-v1';
const riskLimit = 39;
const marker = '# AI Picks sync v1 ';

function api(method, path, body) {
  return new Promise((resolve, reject) => $httpAPI(method, path, body, result => {
    if (!result || result.error) reject(new Error('Surge API failed: ' + path));
    else resolve(result);
  }));
}

function request(policy, url) {
  return new Promise(resolve => {
    $httpClient.get({url, policy, timeout: 10, 'auto-cookie': false, 'auto-redirect': false},
      (error, response, body) => {
        if (error) resolve({error: String(error)});
        else if (!response || response.status !== 200) resolve({error: 'HTTP ' + (response?.status || '?'),body,headers:response?.headers});
        else resolve({body,headers:response.headers});
      });
  });
}

function parseJSON(body) {
  try { return JSON.parse(body); } catch (_) { return null; }
}

function americanName(name) {
  return /🇺🇸|美国|美國|美[东西東西]线|(?:^|[^A-Za-z])(?:USA?|United[ _-]+States)(?![A-Za-z])/i.test(name.normalize('NFKC'));
}

function inventory(data) {
  if (!Array.isArray(data.proxies) || !Array.isArray(data['external-policies'])) throw new Error('节点清单不完整');
  const all = data.proxies.filter(name=> !['DIRECT','REJECT','REJECT-TINYGIF'].includes(name))
    .map(name=>({name, policy:name, source:'', external:false}));
  for (const p of data['external-policies']) {
    if (!p.identifier || !p.name || !p.group) throw new Error('订阅节点标识缺失');
    all.push({name:p.name, policy:p.identifier, source:p.group, external:true});
  }
  return all.filter(n=>americanName(n.name));
}

function pageIssue(res) {
  if (/unsupported_country|not available in your (?:country|region)|isn.t available in your (?:country|region)|gemini isn.t currently supported/i.test(res.body || '')) return '地区限制';
  if (Object.entries(res.headers || {}).some(([k,v])=>k.toLowerCase()==='cf-mitigated' && String(v).toLowerCase()==='challenge') ||
      /<title[^>]*>\s*(?:Just a moment|Attention Required)|<title[^>]*>[^<]*captcha/i.test(res.body || '')) return '验证页';
  return res.error || '';
}

// Region tables adapted from oneclickvirt/UnlockTests model/model.go (4b29e75).
const GEMINI_REGIONS = new Set('ABW AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT AZE BDI BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLZ BMU BOL BRA BRB BRN BTN BWA CAF CAN CCK CHE CHL CIV CMR COD COG COK COL COM CPV CRI CUW CXR CYM CYP CZE DEU DJI DMA DNK DOM DZA ECU EGY ERI ESH ESP EST ETH FIN FJI FLK FRA FRO FSM GAB GBR GEO GGY GHA GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRQ ISL ISR ITA JAM JEY JOR JPN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN LBR LBY LCA LIE LKA LSO LTU LUX LVA MAF MAR MCO MDA MDG MDV MEX MHL MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT NAM NCL NER NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN PAK PAN PCN PER PHL PLW PNG POL PRI PRT PRY PSE PYF QAT REU ROU RWA SAU SDN SEN SGP SGS SHN SJM SLB SLE SLV SMR SOM SPM SRB SSD STP SUR SVK SVN SWE SWZ SXM SYC TCA TCD TGO THA TJK TKL TKM TLS TON TTO TUN TUR TUV TWN TZA UGA UKR UMI URY USA UZB VAT VCT VEN VGB VIR VNM VUT WLF WSM YEM ZAF ZMB ZWE'.split(' '));

// Inspect the public product endpoints without signing in or sending browser cookies.
async function chat(policy) {
  const res = await request(policy, 'https://chatgpt.com/');
  const issue = pageIssue(res);
  if (issue) return issue;
  const body = res.body || '';
  return /<title[^>]*>\s*ChatGPT\s*<\/title>/i.test(body) &&
    /chatgpt-theme|oaiusercontent|<html[^>]+chatgpt/i.test(body) ? '通过' : '响应未识别';
}

async function gemini(policy) {
  const res = await request(policy, 'https://gemini.google.com/?hl=en');
  const issue = pageIssue(res);
  if (issue) return issue;
  const body = res.body || '';
  const region = /,2,1,200,"([A-Z]{3})"/.exec(body)?.[1];
  if (region && GEMINI_REGIONS.has(region)) return '通过';
  if (/456(?:31641|17354),null,true/.test(body)) return '通过';
  return region ? '地区待确认 '+region : '响应未识别';
}

async function ipInfo(policy) {
  const res = await request(policy,'https://my.ippure.com/v1/info');
  const info = !res.error && parseJSON(res.body);
  const score = info?.fraudScore;
  return {
    country: info?.countryCode || '',
    native: typeof info?.isBroadcast === 'boolean' ? !info.isBroadcast : null,
    risk: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
    ipIssue: res.error || ''
  };
}

async function eachNode(nodes, inspect) {
  let cursor = 0;
  async function worker() {
    while (cursor < nodes.length) await inspect(nodes[cursor++]);
  }
  await Promise.all(Array.from({length:Math.min(6,nodes.length)},worker));
}

async function inspect(policy) {
  const [ip,ChatGPT,Gemini] = await Promise.all([ipInfo(policy),chat(policy),gemini(policy)]);
  const eligible = ip.country === 'US' && ip.native === true && ip.risk !== null &&
    ip.risk < riskLimit && ChatGPT === '通过' && Gemini === '通过';
  return {...ip,ai:{ChatGPT,Gemini},eligible};
}

function replacement(content, names, sources, local) {
  const lines = content.split('\n');
  const indices = lines.map((line, idx) => line.split('=')[0].trim() === TARGET ? idx : -1).filter(idx => idx >= 0);
  if (indices.length !== 1) throw new Error('目标组缺失或重复');
  const i = indices[0];
  // Accept only the expected smart group with named options, no explicit members.
  const standby = TARGET + ' = select, 🇺🇸USA';
  if (!names.length) {
    lines[i] = standby;
    return lines.join('\n');
  }
  if (lines[i].trim() === standby) lines[i] = TARGET + ' = smart, evaluate-before-use=1';
  const rhs = lines[i].slice(lines[i].indexOf('=') + 1);
  const fields = rhs.match(/(?:[^,"\n]|"[^"\n]*")+/g) || [];
  if (fields.shift()?.trim() !== 'smart' || fields.some(f => !/^\s*[\w-]+\s*=/.test(f))) throw new Error('目标组结构已变化');
  const keep = fields.filter(f => !/^\s*(include-other-group|include-all-proxies|policy-regex-filter)\s*=/.test(f));
  if (keep.some(f => /^\s*policy-path\s*=/.test(f))) throw new Error('目标组含独立订阅');
  // Encode delimiters as regex escapes so node names cannot change profile syntax.
  const literal = s => Array.from(s, c => /[a-zA-Z0-9\u0080-\u{10FFFF}]/u.test(c) ? c :
    Array.from({length:c.length}, (_,j) => '\\u' + c.charCodeAt(j).toString(16).padStart(4,'0')).join('')).join('');
  const filter = '^(?:' + names.map(literal).join('|') + ')$';
  if (sources.some(g=>/[,"\r\n]/.test(g) || g===TARGET)) throw new Error('来源组名称无法安全引用');
  const includes = (sources.length ? ', include-other-group="' + sources.join(', ') + '"' : '') +
    (local ? ', include-all-proxies=1' : '');
  lines[i] = TARGET + ' = smart' + includes + ', policy-regex-filter=' + filter + keep.map(f=>','+f).join('');
  return lines.join('\n');
}

function summary(r) {
  const dual = r.rows.filter(both);
  return [r.time,'匹配 '+r.rows.length+' · 两家通过 '+dual.length+' · 美国原生且风险低于 39 并通过 '+r.rows.filter(x=>x.eligible).length,
    ...r.rows.filter(x=>x.eligible).map(x=>x.name+' · '+x.risk+' 分'),r.note].join('\n');
}

function both(n) {
  return n.ai.ChatGPT === '通过' && n.ai.Gemini === '通过';
}

function roundStart(time) {
  const d = new Date(time);
  d.setHours(6,30,0,0);
  if (d.getTime()>time) d.setDate(d.getDate()-1);
  while (![0,3].includes(d.getDay())) d.setDate(d.getDate()-1);
  return d.getTime();
}

function readState(content) {
  const lines = content.split('\n').filter(l=>l.startsWith(marker));
  if (!lines.length) return {};
  const value = parseJSON(lines[0].slice(marker.length));
  if (lines.length !== 1 || !value || typeof value !== 'object') throw new Error('共享刷新记录格式异常');
  return value;
}

function stamp(content, state) {
  const lines = content.split('\n').filter(l=>!l.startsWith(marker));
  const i = lines.findIndex(l=>l.split('=')[0].trim() === TARGET);
  if (i<0) throw new Error('配置中缺少 AI Picks');
  lines.splice(i,0,marker+JSON.stringify(state));
  return lines.join('\n');
}

function skipReason(state,host,phase,now) {
  if (state.rule === ruleVersion && state.attempted >= roundStart(now)) return '本轮已检测或已启动，跳过';
  if (state.until > now) return '另一轮检测正在运行，跳过';
  if (phase === 'primary' && state.writer && state.writer !== host) return '由上次成功的 Mac 优先刷新，本机等待 07:00 补位';
  return '';
}

async function run() {
  const sectionName = 'Proxy Group';
  const readSection = () => api('GET','/v1/profiles/section',{name:sectionName});
  async function write(section, content) {
    await api('POST','/v1/profiles/section',{name:sectionName,revision:section.revision,content});
    const saved = await readSection();
    if (saved.content.trimEnd() !== content.trimEnd()) throw new Error('共享配置写后读回不一致');
    return saved;
  }
  if (mode==='panel') {
    const saved = parseJSON($persistentStore.read(REPORT));
    const state = readState((await readSection()).content);
    const latest = state.completed ? '共享配置更新于 '+new Date(state.completed).toISOString()+' · '+state.count+' 条' : '尚无成功刷新记录';
    return {title:'AI Picks',content:saved ? latest+'\n'+summary(saved) : latest};
  }
  if (!['primary','backup'].includes(mode)) throw new Error('未知运行模式');
  const section = await readSection();
  if (!section.editable || !section.revision) throw new Error('共享配置不可编辑');
  const state = readState(section.content);
  const randomID = () => Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let host = $persistentStore.read('ai-picks-device-id');
  if (!host) {
    host = randomID();
    if (!$persistentStore.write(host,'ai-picks-device-id')) throw new Error('无法保存本机标识');
  }
  const skip = skipReason(state,host,mode,Date.now());
  if (skip) {console.log(skip);return {title:'AI Picks',content:skip};}
  const groupLine = content => content.split('\n').find(l=>l.split('=')[0].trim()===TARGET);
  const original = groupLine(section.content);
  const token = randomID();
  const attempt = {...state,rule:ruleVersion,attempted:Date.now()};
  await write(section,stamp(section.content,{...attempt,token,until:Date.now()+15*60*1000}));
  try {
    const data = await api('GET','/v1/policies',{include_external:true});
    const rows = inventory(data);
    if (!rows.length) throw new Error('没有匹配的美国节点');
    const results = new Map();
    await eachNode([...new Set(rows.map(n=>n.policy))],async policy=>{
      results.set(policy,await inspect(policy));
    });
    for (const n of rows) Object.assign(n,results.get(n.policy));
    const qualified = rows.filter(n=>n.eligible);
    const passed = [...new Set(qualified.map(n=>n.name))];
    const current = await readSection();
    if (readState(current.content).token !== token || groupLine(current.content)!==original) throw new Error('检测期间目标组或写入权已变化');
    let content = current.content;
    let next = attempt;
    if (qualified.length) {
      const sources = [...new Set(qualified.map(n=>n.source).filter(Boolean))];
      const local = qualified.some(n=>!n.source);
      if (rows.some(n=>!n.eligible && passed.includes(n.name) && (n.source ? sources.includes(n.source) : local))) throw new Error('同名节点结果冲突');
      content = replacement(content,passed,sources,local);
      next = {...attempt,writer:host,completed:Date.now(),count:qualified.length};
    }
    const {token:oldToken,until:oldUntil,...finished} = next;
    await write(current,stamp(content,finished));
    const report = {time:new Date().toISOString(),rows,note:qualified.length?'AI Picks 已写入并读回':'本轮零条合格，保留上次配置，本轮结束'};
    $persistentStore.write(JSON.stringify(report),REPORT);
    console.log(summary(report));
    return {title:'AI Picks',content:summary(report)};
  } catch(error) {
    const current = await readSection();
    if (readState(current.content).token === token) {
      const {token:t,until:u,...previous} = attempt;
      await write(current,stamp(current.content,previous));
    }
    throw error;
  }
}
run().then($done).catch(error => {
  console.log('检测失败：'+error.message);
  $done({title:'AI Picks 检测失败',content:error.message});
});
