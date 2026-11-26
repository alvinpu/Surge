'use strict';
// Surge Mac. All network probes explicitly use one named policy and no cookie jar.

const TARGET = 'AI Pool';
const REPORT = 'usa-ai-report-v4';
const [mode, riskSetting] = (typeof $argument === 'string' ? $argument : 'preview').split('|');
const showRisk = riskSetting === 'on';

function api(method, path, body) {
  return new Promise((resolve, reject) => $httpAPI(method, path, body, result => {
    if (!result || result.error) reject(new Error('Surge API failed: ' + path));
    else resolve(result);
  }));
}

function request(policy, url, redirect = false) {
  return new Promise(resolve => {
    $httpClient.get({url, policy, timeout: 8, 'auto-cookie': false, 'auto-redirect': redirect},
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
const CLAUDE_REGIONS = new Set('AD AE AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BZ CA CG CH CI CL CM CO CR CV CY CZ DE DJ DK DM DO DZ EC EE EG ES FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IS IT JM JO JP KE KG KH KI KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV MA MC MD ME MG MH MK MN MR MT MU MV MW MX MY MZ NA NE NG NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RW SA SB SC SE SG SI SK SL SM SN SR ST SV SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VN VU WS ZA ZM ZW'.split(' '));
const GEMINI_REGIONS = new Set('ABW AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT AZE BDI BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLZ BMU BOL BRA BRB BRN BTN BWA CAF CAN CCK CHE CHL CIV CMR COD COG COK COL COM CPV CRI CUW CXR CYM CYP CZE DEU DJI DMA DNK DOM DZA ECU EGY ERI ESH ESP EST ETH FIN FJI FLK FRA FRO FSM GAB GBR GEO GGY GHA GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRQ ISL ISR ITA JAM JEY JOR JPN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN LBR LBY LCA LIE LKA LSO LTU LUX LVA MAF MAR MCO MDA MDG MDV MEX MHL MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT NAM NCL NER NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN PAK PAN PCN PER PHL PLW PNG POL PRI PRT PRY PSE PYF QAT REU ROU RWA SAU SDN SEN SGP SGS SHN SJM SLB SLE SLV SMR SOM SPM SRB SSD STP SUR SVK SVN SWE SWZ SXM SYC TCA TCD TGO THA TJK TKL TKM TLS TON TTO TUN TUR TUV TWN TZA UGA UKR UMI URY USA UZB VAT VCT VEN VGB VIR VNM VUT WLF WSM YEM ZAF ZMB ZWE'.split(' '));

async function probeAI(policy) {
  const [openai, claude, trace, gemini] = await Promise.all([
    request(policy,'https://api.openai.com/compliance/cookie_requirements'),
    request(policy,'https://claude.ai/',true),
    request(policy,'https://claude.ai/cdn-cgi/trace'),
    request(policy,'https://gemini.google.com/',true)
  ]);
  const chat = pageIssue(openai) || (typeof parseJSON(openai.body)?.cookie_consent_required === 'boolean' ? '通过' : '响应未知');
  const region = /^loc=([A-Z]{2})\s*$/m.exec(trace.body || '')?.[1];
  const claudeResult = pageIssue(claude) || pageIssue(trace) ||
    (!region ? '地区未知' : !CLAUDE_REGIONS.has(region) ? '出口地区 '+region :
      /<title[^>]*>[^<]*Claude|<meta[^>]+content=["']Claude/i.test(claude.body || '') ? '通过' : '页面未知');
  const gRegion = /,2,1,200,"([A-Z]{3})"/.exec(gemini.body || '')?.[1];
  const geminiResult = pageIssue(gemini) || (gRegion ? (GEMINI_REGIONS.has(gRegion) ? '通过' : '出口地区 '+gRegion) :
    /456(?:31641|17354),null,true/.test(gemini.body || '') ? '通过' : '页面未知');
  return {ChatGPT:chat,Claude:claudeResult==='验证页' && CLAUDE_REGIONS.has(region) ? '支持地区 '+region+' · 验证页待确认' : claudeResult,Gemini:geminiResult};
}

async function inspect({name, source, policy}) {
  const ai = await probeAI(policy);
  const row = {name, source, ai, eligible:Object.values(ai).every(result=>result === '通过')};
  if (showRisk) {
    const result = await request(policy, 'https://my.ippure.com/v1/info');
    const score = !result.error ? parseJSON(result.body)?.fraudScore : null;
    row.risk = Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
  }
  return row;
}

function replacement(content, names, sources, local) {
  const lines = content.split('\n');
  const indices = lines.map((line, idx) => line.split('=')[0].trim() === TARGET ? idx : -1).filter(idx => idx >= 0);
  if (indices.length !== 1) throw new Error('目标组缺失或重复');
  const i = indices[0];
  // Accept only the expected smart group with named options, no explicit members.
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
  const passed = r.rows.filter(x=>x.eligible);
  const pending = r.rows.filter(x=>x.ai.ChatGPT === '通过' && x.ai.Gemini === '通过' && x.ai.Claude.includes('验证页'));
  const label = x=>x.name+' ['+(x.source || '本地')+']'+
    (r.showRisk ? ' · IP 风险 '+(x.risk ?? '未知') : '');
  return [r.time,'匹配 '+r.rows.length+' · 三家匿名通过 '+passed.length,
    ...passed.map(label),'ChatGPT、Gemini 通过，Claude 待验证 '+pending.length,
    ...pending.map(label),r.note].join('\n');
}
async function run() {
  if (mode === 'panel') {
    const saved = parseJSON($persistentStore.read(REPORT));
    return {title:'AI Unlock Checker',content:saved ? summary(saved) : '请先运行 AI Unlock Scan 脚本'};
  }
  const sectionName = 'Proxy Group';
  const readSection = () => api('GET','/v1/profiles/section',{name:sectionName});
  const section = await readSection();
  const data = await api('GET','/v1/policies',{include_external:true});
  const nodes = inventory(data);
  if (!nodes.length) throw new Error('来源组没有可检测节点');
  const rows = Array(nodes.length);
  let cursor = 0;
  async function worker() {
    while (cursor < nodes.length) {
      const i = cursor++;
      rows[i] = await inspect(nodes[i]);
    }
  }
  await Promise.all(Array.from({length:Math.min(4,nodes.length)},worker));
  const qualified = rows.filter(x=>x.eligible);
  const passed = [...new Set(qualified.map(x=>x.name))];
  const report = {time:new Date().toISOString(),rows,showRisk,note:'仅检测'};
  if (mode === 'apply') {
    if (!passed.length) report.note = '本轮零通过，保留原组';
    else {
      if (!section.editable || !section.revision) throw new Error('目标配置不可编辑');
      const sources = [...new Set(qualified.map(x=>x.source).filter(Boolean))];
      const local = qualified.some(x=>!x.source);
      if (rows.some(x=>!x.eligible && passed.includes(x.name) && (x.source ? sources.includes(x.source) : local))) throw new Error('同名节点结果冲突，保留原组');
      const content = replacement(section.content,passed,sources,local);
      if (content !== section.content) {
        await api('POST','/v1/profiles/section',{name:sectionName,revision:section.revision,content});
        if ((await readSection()).content !== content) throw new Error('写后读回不一致');
      }
      report.note = '已核对目标配置';
    }
  }
  $persistentStore.write(JSON.stringify(report),REPORT);
  console.log('REPORT '+JSON.stringify(report));
  return {title:'AI Unlock Checker',content:summary(report)};
}
run().then($done).catch(error => {
  console.log('检测失败：'+error.message);
  $done({title:'AI Unlock Checker失败',content:error.message});
});
