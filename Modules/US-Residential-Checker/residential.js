'use strict';
// Surge Mac. All network probes explicitly use one named policy and no cookie jar.

function targetName(content) {
  const names = content.split('\n').filter(line=>line.includes('='))
    .map(line=>line.split('=')[0].trim()).filter(name=>/^(?:🏠\s*)?Static Residential(?:\s*🇺🇸)?$/iu.test(name));
  if (names.length !== 1) throw new Error('Static Residential 目标组缺失或重复');
  return names[0];
}
const REPORT = 'us-residential-report-v1';
const mode = typeof $argument === 'string' ? $argument : 'primary';
const ruleVersion = 'us-residential-ippure-v1';
const marker = '# Static Residential sync v1 ';

function api(method, path, body) {
  return new Promise((resolve, reject) => $httpAPI(method, path, body, result => {
    if (!result || result.error) reject(new Error('Surge API failed: ' + path));
    else resolve(result);
  }));
}

function redirectResult(status, headers, base) {
  const label = 'HTTP ' + status + ' 跳转';
  const location = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'location')?.[1];
  if (typeof location !== 'string' || !location.trim()) return label + '（无 Location）';
  try {
    const to = new URL(location, base);
    if (to.protocol === 'https:' || to.protocol === 'http:') return label + ' → ' + to.host + to.pathname;
  } catch (_) {}
  return label + '（目标无法解析）';
}

function request(policy, url) {
  return new Promise(resolve => {
    $httpClient.get({url, policy, timeout: 15, 'auto-cookie': false, 'auto-redirect': false},
      (error, response, body) => {
        if ([300,301,302,303,307,308].includes(response?.status)) {
          resolve({error: redirectResult(response.status, response.headers, url)});
        } else if (error) resolve({error: String(error)});
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

async function eachNode(nodes, inspect) {
  let cursor = 0;
  async function worker() {
    while (cursor < nodes.length) await inspect(nodes[cursor++]);
  }
  await Promise.all(Array.from({length:Math.min(6,nodes.length)},worker));
}

async function inspect(policy) {
  const response = await request(policy, 'https://my.ippure.com/v1/info');
  const info = response.error ? null : parseJSON(response.body);
  const country = info?.countryCode || '';
  const residential = typeof info?.isResidential === 'boolean' ? info.isResidential : null;
  return {country,residential,eligible:country === 'US' && residential === true,issue:response.error || ''};
}

// On a same-round upgrade, reuse the classification already obtained through each policy.
function previousClassifications(state, host, manual, now) {
  if (manual || state.rule !== 'us-residential-consensus-v1' || state.writer !== host ||
      !(state.completed >= roundStart(now)) || !(state.completed >= state.attempted)) return null;
  const saved = parseJSON($persistentStore.read(REPORT));
  const sampled = Date.parse(saved?.time);
  if (!Array.isArray(saved?.rows) || !Number.isFinite(sampled) ||
      Math.abs(sampled-state.completed)>60000) return null;
  return {time:saved.time,byPolicy:new Map(saved.rows.map(n=>[n.policy,n]))};
}

function replacement(content, names, sources, local) {
  const target = targetName(content);
  const lines = content.split('\n');
  const indices = lines.map((line, idx) => line.split('=')[0].trim() === target ? idx : -1).filter(idx => idx >= 0);
  if (indices.length !== 1) throw new Error('目标组缺失或重复');
  const i = indices[0];
  const rhs = lines[i].slice(lines[i].indexOf('=') + 1);
  const fields = rhs.match(/(?:[^,"\n]|"[^"\n]*")+/g) || [];
  if (fields.shift()?.trim() !== 'smart' || fields.some(f => !/^\s*[\w-]+\s*=/.test(f))) throw new Error('目标组结构已变化');
  const keep = fields.filter(f => !/^\s*(include-other-group|include-all-proxies|policy-regex-filter)\s*=/.test(f));
  if (keep.some(f => /^\s*policy-path\s*=/.test(f))) throw new Error('目标组含独立订阅');
  // Encode delimiters as regex escapes so node names cannot change profile syntax.
  const literal = s => Array.from(s, c => /[a-zA-Z0-9\u0080-\u{10FFFF}]/u.test(c) ? c :
    Array.from({length:c.length}, (_,j) => '\\u' + c.charCodeAt(j).toString(16).padStart(4,'0')).join('')).join('');
  const filter = '^(?:' + names.map(literal).join('|') + ')$';
  if (sources.some(g=>/[,"\r\n]/.test(g) || g===target)) throw new Error('来源组名称无法安全引用');
  const includes = (sources.length ? ', include-other-group="' + sources.join(', ') + '"' : '') +
    (local ? ', include-all-proxies=1' : '');
  lines[i] = target + ' = smart' + includes + ', policy-regex-filter=' + filter + keep.map(f=>','+f).join('');
  return lines.join('\n');
}

function summary(r) {
  const passed = r.rows.filter(n=>n.eligible);
  return [r.time,'美国名称 '+r.rows.length+' · IPPure 美国住宅入组 '+passed.length,
    ...passed.map(n=>n.name+' ['+(n.source || '本地')+']'),r.note].join('\n');
}

function roundStart(time) {
  const d = new Date(time);
  d.setHours(6,0,0,0);
  if (d.getTime()>time) d.setDate(d.getDate()-1);
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
  const target = targetName(content);
  const i = lines.findIndex(l=>l.split('=')[0].trim() === target);
  if (i<0) throw new Error('配置中缺少 Static Residential');
  lines.splice(i,0,marker+JSON.stringify(state));
  return lines.join('\n');
}

function skipReason(state,host,phase,now) {
  if (state.until > now) return '另一轮检测正在运行，跳过';
  if (phase !== 'manual' && state.rule === ruleVersion && state.attempted >= roundStart(now)) return '本轮已检测或已启动，跳过';
  if (phase === 'primary' && state.writer && state.writer !== host) return '由上次成功的 Mac 优先刷新，本机等待 06:20 补位';
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
  const manual = mode === 'panel' && typeof $trigger !== 'undefined' && $trigger === 'button';
  if (mode === 'panel' && !manual) {
    const saved = parseJSON($persistentStore.read(REPORT));
    const state = readState((await readSection()).content);
    const latest = state.completed ? '共享配置更新于 '+new Date(state.completed).toISOString()+' · '+state.count+' 条' : '尚无成功刷新记录';
    return {title:'Static Residential',content:saved ? latest+'\n'+summary(saved) : latest};
  }
  if (!manual && !['primary','backup'].includes(mode)) throw new Error('未知运行模式');
  const section = await readSection();
  if (!section.editable || !section.revision) throw new Error('共享配置不可编辑');
  const state = readState(section.content);
  const randomID = () => Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let host = $persistentStore.read('us-residential-device-id');
  if (!host) {
    host = randomID();
    if (!$persistentStore.write(host,'us-residential-device-id')) throw new Error('无法保存本机标识');
  }
  const skip = skipReason(state,host,manual ? 'manual' : mode,Date.now());
  if (skip) {console.log(skip);return {title:'Static Residential',content:skip};}
  const target = targetName(section.content);
  const groupLine = content => content.split('\n').find(l=>l.split('=')[0].trim()===target);
  const original = groupLine(section.content);
  const token = randomID();
  const attempt = {...state,rule:ruleVersion,attempted:Date.now()};
  await write(section,stamp(section.content,{...attempt,token,until:Date.now()+15*60*1000}));
  try {
    const data = await api('GET','/v1/policies',{include_external:true});
    const rows = inventory(data);
    if (!rows.length) throw new Error('没有匹配的美国节点');
    const previous = previousClassifications(state,host,manual,Date.now());
    const results = new Map();
    const policies = [...new Set(rows.map(n=>n.policy))];
    await eachNode(policies,async policy=>{
      const old = previous?.byPolicy.get(policy);
      if (old) {
        const {country,residential} = old;
        results.set(policy,{country,residential,eligible:country === 'US' && residential === true,
          issue:country && residential !== null ? '' : old.issue || ''});
      } else {
        results.set(policy,await inspect(policy));
      }
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
    const report = {time:new Date().toISOString(),rows,note:qualified.length?'Static Residential 已写入并读回':'本轮零条合格，保留上次配置，本轮结束'};
    if (previous) {
      const reused = policies.filter(policy=>previous.byPolicy.has(policy)).length;
      report.note += '；沿用 '+previous.time+' 的 IPPure 记录 '+reused+' 条，新查询 '+(policies.length-reused)+' 条';
    }
    $persistentStore.write(JSON.stringify(report),REPORT);
    console.log(summary(report));
    return {title:'Static Residential',content:summary(report)};
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
  $done({title:'Static Residential 检测失败',content:error.message});
});
