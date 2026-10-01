import http from 'node:http';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { constants, createSign, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ACCOUNTS_CONFIG || path.join(ROOT, 'config/accounts.json');
const MANAGED_CONFIG_PATH = process.env.MANAGED_CONFIG_PATH || path.join(ROOT, 'data/accounts.json');
const CACHE_PATH = process.env.CACHE_PATH || path.join(ROOT, 'data/cache.json');
const PORT = Number(process.env.PORT || 3000);
const BASIC_USER = process.env.DASHBOARD_USER || '';
const BASIC_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};

let config;
let snapshot = { accounts: [], trafficStates: {}, lastUpdated: null, lastError: null, refreshRunning: false, nextBillingRefreshAt: null };
const tokenCache = new Map();
const encoder = value => Buffer.from(value).toString('base64url');

function basicAuthOk(req) {
  if (!BASIC_USER && !BASIC_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString(); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const user = Buffer.from(decoded.slice(0, split));
  const pass = Buffer.from(decoded.slice(split + 1));
  const expectedUser = Buffer.from(BASIC_USER);
  const expectedPass = Buffer.from(BASIC_PASSWORD);
  return user.length === expectedUser.length && pass.length === expectedPass.length &&
    timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass);
}

function json(res, status, data) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(data));
}

async function authorizedKey(account) {
  const raw = await readFile(account.serviceAccountKeyFile, 'utf8');
  return JSON.parse(raw);
}

async function iamToken(account) {
  const keyPath = account.serviceAccountKeyFile;
  const cached = tokenCache.get(keyPath);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const key = await authorizedKey(account);
  const now = Math.floor(Date.now() / 1000);
  const header = encoder(JSON.stringify({alg:'PS256',typ:'JWT',kid:key.id}));
  const payload = encoder(JSON.stringify({iss:key.service_account_id,sub:key.service_account_id,aud:'https://iam.api.cloud.yandex.net/iam/v1/tokens',iat:now,exp:now+3600}));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('sha256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({key:key.private_key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST});
  const jwt = `${unsigned}.${signature.toString('base64url')}`;
  const response = await fetch('https://iam.api.cloud.yandex.net/iam/v1/tokens', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jwt}), signal:AbortSignal.timeout(30000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`IAM token: ${body.message || response.status}`);
  const expiresAt = Date.parse(body.expiresAt || new Date(Date.now()+3600000).toISOString());
  tokenCache.set(keyPath, {token:body.iamToken,expiresAt});
  return body.iamToken;
}

async function ycFetch(account, url, options={}) {
  const token = await iamToken(account);
  const response = await fetch(url, { ...options, signal:AbortSignal.timeout(30000), headers:{...(options.headers||{}),authorization:`Bearer ${token}`} });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {message:raw.slice(0,500)}; }
  if (!response.ok) throw new Error(`Yandex Cloud API ${response.status}: ${body.message || raw.slice(0,300)}`);
  return body;
}

async function listCdnResources(account, folderId) {
  const all = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({folderId,pageSize:'1000'});
    if (pageToken) query.set('pageToken', pageToken);
    const data = await ycFetch(account, `https://cdn.api.cloud.yandex.net/cdn/v1/resources?${query}`);
    all.push(...(data.resources || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

function metricPoints(series,startMs,endMs) {
  const timestamps=series.timeseries?.timestamps||[],values=series.timeseries?.doubleValues||series.timeseries?.int64Values||[];
  return timestamps.map((t,i)=>({t:Number(t),raw:values[i]})).filter(p=>p.raw!==null&&p.raw!==undefined&&Number.isFinite(Number(p.raw))&&p.t>=startMs&&p.t<=endMs).map(p=>({t:p.t,v:Number(p.raw)})).sort((a,b)=>a.t-b.t);
}

function integratePoints(points,baseline,maxGapMs) {
  let previous=baseline,bytes=0;
  for(const point of points){
    if(previous){const seconds=(point.t-previous.t)/1000;if(seconds>0&&seconds*1000<=maxGapMs)bytes+=((Math.max(0,previous.v)+Math.max(0,point.v))/2)*seconds;}
    previous=point;
  }
  return {bytes,lastPoint:points.at(-1)||baseline||null};
}

async function readFolderTraffic(account,folderId,fromMs,endMs,resources,gridInterval) {
  const readMetric=(metric,resourceName=null)=>ycFetch(account,`https://monitoring.api.cloud.yandex.net/monitoring/v2/data/read?folderId=${encodeURIComponent(folderId)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      query:`"${metric}"{service="yccdn"${resourceName?`,resource="${resourceName}"`:''}}`,fromTime:new Date(fromMs).toISOString(),toTime:new Date(endMs).toISOString(),
      downsampling:{gridInterval:String(gridInterval),gridAggregation:'AVG',gapFilling:'NULL'}
    })
  });
  const metricNames=['edge.bytes_sent','origin.bytes_fetched'];
  const results=await Promise.all(metricNames.map(async metric=>({metric,result:await readMetric(metric)})));
  const grouped=new Map();
  const diagnostics={};
  const addSeries=(metric,series)=>{
    const resourceLabel=series.labels?.resource??series.labels?.resource_id??series.labels?.resourceId;if(!resourceLabel)return false;
    const normalized=String(resourceLabel).replace(/\.$/,'').toLowerCase();const resource=resources.find(item=>item.id===resourceLabel||String(item.name||'').replace(/\.$/,'').toLowerCase()===normalized);if(!resource)return false;const id=resource.id;
    let byMetric=grouped.get(id);if(!byMetric){byMetric=new Map();grouped.set(id,byMetric);}
    let times=byMetric.get(metric);if(!times){times=new Map();byMetric.set(metric,times);}
    for(const point of metricPoints(series,fromMs,endMs))times.set(point.t,(times.get(point.t)||0)+point.v);
    return true;
  };
  for(const {metric,result} of results){const series=result.metrics||[];diagnostics[metric]={series:series.length,points:0,labels:series[0]?Object.keys(series[0].labels||{}):[]};for(const item of series){addSeries(metric,item);diagnostics[metric].points+=metricPoints(item,fromMs,endMs).length;}}
  // Retry by the resource label from Monitoring (the CDN CNAME), not the CDN API resource ID.
  const missing=[];
  for(const resource of resources)for(const metric of metricNames){const points=(grouped.get(resource.id)?.get(metric)?.size||0);if(!points)missing.push({resource,metric});}
  const fallback=await Promise.all(missing.map(async ({resource,metric})=>{try{return {resource,metric,result:await readMetric(metric,resource.name||resource.id)};}catch(error){return {resource,metric,error};}}));
  const fallbackErrors=[];
  for(const item of fallback){if(item.error){fallbackErrors.push(`${item.resource.name}: ${item.metric}: ${item.error.message}`);continue;}for(const series of item.result.metrics||[]){if(!addSeries(item.metric,series))addSeries(item.metric,{...series,labels:{...(series.labels||{}),resource:item.resource.id}});}}
  for(const metric of metricNames){const resourceSeries=new Set();let points=0;for(const resource of resources){const series=grouped.get(resource.id)?.get(metric);if(series?.size){resourceSeries.add(resource.id);points+=series.size;}}diagnostics[metric].matchedResources=resourceSeries.size;diagnostics[metric].matchedPoints=points;}
  const names=results.flatMap(x=>(x.result.metrics||[]).map(m=>m.name));
  if(Object.values(diagnostics).every(item=>item.matchedPoints===0)){
    try{const query=new URLSearchParams({folderId,nameFilter:'bytes'});const metadata=await ycFetch(account,`https://monitoring.api.cloud.yandex.net/monitoring/v2/metrics/names?${query}`);diagnostics.availableMetricNames=(metadata.names||[]).filter(name=>/cdn|edge\.bytes|origin\.bytes/i.test(name)).slice(0,30);}
    catch(error){diagnostics.metricDiscoveryError=error.message;}
    try{const query=new URLSearchParams({folderId,selectors:'{service="yccdn"}',pageSize:'1000'});const metadata=await ycFetch(account,`https://monitoring.api.cloud.yandex.net/monitoring/v2/metrics?${query}`);diagnostics.resourceLabels=(metadata.metrics||[]).filter(metric=>metricNames.includes(metric.name)).map(metric=>({name:metric.name,resource:metric.labels?.resource,folder_id:metric.labels?.folder_id,service:metric.labels?.service})).slice(0,30);}
    catch(error){diagnostics.seriesDiscoveryError=error.message;}
  }
  const metricExists=Object.fromEntries(metricNames.map(metric=>[metric,diagnostics[metric].matchedResources>0]));
  const maxGapMs=Math.max(10*60*1000,gridInterval*2);
  return {resources:resources.map(resource=>({id:resource.id,metrics:Object.fromEntries(metricNames.map(metric=>[metric,[...((grouped.get(resource.id)||new Map()).get(metric)||new Map())].map(([t,v])=>({t,v})).sort((a,b)=>a.t-b.t)])),metricAvailable:Object.fromEntries(metricNames.map(metric=>[metric,Boolean((grouped.get(resource.id)?.get(metric)?.size)||metricExists[metric])])),maxGapMs})),diagnostics,returnedNames:[...new Set(names)],fallbackErrors};
}

/* Usage is accumulated in the cache so historical traffic remains available
   after Monitoring's rolling history window moves past the grant start. */
async function syncFolderTraffic(account,folderId,resources) {
  snapshot.trafficStates ||= {};
  const now=Date.now(),grantStart=Date.parse(`${account.grantStartDate}T00:00:00Z`);
  for(const resource of resources){const state=snapshot.trafficStates[`${account.billingAccountId}:${resource.id}`];if(state&&state.measurementVersion!==3){state.initialized=false;state.edgeBytes=0;state.originBytes=0;state.totalBytes=0;state.lastPoints={};state.availableMetrics={};state.measurementVersion=3;state.noDataBackfillAt=0;}if(state?.totalBytes===0&&!state.lastPoints?.['edge.bytes_sent']&&!state.lastPoints?.['origin.bytes_fetched']&&now-(state.noDataBackfillAt||0)>=15*60*1000){state.initialized=false;state.availableMetrics={};state.noDataBackfillAt=now;}}
  const states=resources.map(r=>snapshot.trafficStates[`${account.billingAccountId}:${r.id}`]);
  const needsBackfill=states.some(s=>!s?.initialized);
  const checked=states.filter(s=>s?.initialized).map(s=>Math.max((s.lastCheckedAt||now)-10*60*1000,(Math.max(s.lastPoints?.['edge.bytes_sent']?.t||0,s.lastPoints?.['origin.bytes_fetched']?.t||0))-3*60*1000));
  const fromMs=needsBackfill?grantStart:Math.max(grantStart,Math.min(...checked,now-10*60*1000));
  // Keep the historical read below Monitoring's 10,000-point request ceiling.
  const periodMs=Math.max(1,now-fromMs),gridInterval=needsBackfill?Math.max(3*60*1000,Math.ceil(periodMs/3500/60000)*60000):3*60*1000;
  const read=await readFolderTraffic(account,folderId,fromMs,now,resources,gridInterval),byId=new Map(read.resources.map(m=>[m.id,m]));
  const synced=resources.map(resource=>{
    const key=`${account.billingAccountId}:${resource.id}`,state=snapshot.trafficStates[key]||{edgeBytes:0,originBytes:0,initialized:false,lastPoints:{},availableMetrics:{}};
    state.edgeBytes??=state.totalBytes||0;state.originBytes??=0;state.lastPoints||={};state.availableMetrics||={};
    state.measurementVersion=3;
    if(state.lastPoint&&!state.lastPoints['edge.bytes_sent'])state.lastPoints['edge.bytes_sent']=state.lastPoint;
    const measured=byId.get(resource.id);
    for(const metric of ['edge.bytes_sent','origin.bytes_fetched']){const points=measured?.metrics?.[metric]||[],baseline=state.lastPoints[metric]||null;if(points.length){const added=integratePoints(points.filter(p=>!baseline||p.t>baseline.t),baseline,measured.maxGapMs);state[metric==='edge.bytes_sent'?'edgeBytes':'originBytes']+=added.bytes;state.lastPoints[metric]=added.lastPoint;}if(measured?.metricAvailable?.[metric])state.availableMetrics[metric]=true;}
    if(state.totalBytes===0&&!state.lastPoints['edge.bytes_sent']&&!state.lastPoints['origin.bytes_fetched']&&!state.noDataBackfillAt)state.noDataBackfillAt=now;
    // User-facing CDN traffic is bytes delivered to clients. Origin fetches are
    // a separate subset/operational measure and must not be added to delivery.
    state.totalBytes=state.edgeBytes;state.available=state.availableMetrics['edge.bytes_sent']===true;
    state.initialized=true;state.lastCheckedAt=now;snapshot.trafficStates[key]=state;
    return {...resource,trafficBytes:state.totalBytes,edgeBytes:state.edgeBytes,originBytes:state.originBytes,trafficAvailable:state.available,edgeTrafficAvailable:state.availableMetrics['edge.bytes_sent']===true,originTrafficAvailable:state.availableMetrics['origin.bytes_fetched']===true};
  });
  return {resources:synced,diagnostics:read.diagnostics,returnedNames:read.returnedNames,fallbackErrors:read.fallbackErrors};
}
function grpcJson(args, body) {
  return new Promise((resolve,reject)=>{
    const child=spawn('grpcurl',args,{stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>child.kill('SIGKILL'),30000); timer.unref();
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>stdout+=chunk); child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(stderr.trim()||`grpcurl exited ${code}`));});
  });
}

async function grantSpent(account) {
  const token=await iamToken(account);
  const now=new Date();
  const request={billing_account_id:account.billingAccountId,start_date:`${account.grantStartDate}T00:00:00Z`,end_date:now.toISOString(),aggregation_period:'DAY'};
  const raw=await grpcJson(['-H',`authorization: Bearer ${token}`,'-d',JSON.stringify(request),'billing.api.cloud.yandex.net:443','yandex.cloud.billing.usage_records.v1.ConsumptionCoreService/GetBillingAccountUsageReport']);
  const report=JSON.parse(raw);
  const details=report.credit_details ?? report.creditDetails ?? {};
  const credit=details.monetary_grant_credit ?? details.monetaryGrantCredit ?? {};
  const money=credit.value ?? credit;
  const value=typeof money==='object' ? Number(money.units||0)+Number(money.nanos||0)/1e9 : Number(money||0);
  return Math.abs(value);
}

function grantExpiry(account) {
  const date=new Date(`${account.grantStartDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()+Number(config.grantDurationDays||60));
  return date;
}

function initialAccount(account) {
  return {name:account.name,billingAccountId:account.billingAccountId,grantStartDate:account.grantStartDate,grantEndDate:grantExpiry(account).toISOString().slice(0,10),grantSpentRub:null,grantRemainingRub:null,daysLeft:null,cdnResources:[],trafficBytes:0,lastUpdated:null,error:null};
}

async function syncCdn(account, current) {
  current.metricError=null;
  current.metricWarning=null;
  const all=[];
  for (const folder of account.folders || []) {
    const resources=await listCdnResources(account,folder.folderId);
    const folderItems=resources.map(r=>{const old=current.cdnResources.find(item=>item.id===r.id);return {id:r.id,name:r.cname||r.id,folderId:folder.folderId,active:r.active!==false,trafficBytes:old?.trafficBytes||0,edgeBytes:old?.edgeBytes||0,originBytes:old?.originBytes||0,trafficAvailable:old?.trafficAvailable||false};});
    all.push(...folderItems);
    current.cdnResources=[...all];
    try {
      if(!folderItems.length)continue;
      const traffic=await syncFolderTraffic(account,folder.folderId,folderItems);
      const byId=new Map(traffic.resources.map(r=>[r.id,r]));
      current.metricDiagnostics=traffic.diagnostics;current.metricReturnedNames=traffic.returnedNames;
      if(traffic.resources.some(r=>!r.trafficAvailable)){const edge=traffic.diagnostics['edge.bytes_sent'],origin=traffic.diagnostics['origin.bytes_fetched'],found=traffic.diagnostics.availableMetricNames||[],labels=traffic.diagnostics.resourceLabels||[];const labelSummary=labels.map(item=>`${item.name} → ${item.resource||'без resource'}`).join(', ');const warning=`Monitoring не отдал точки: edge.bytes_sent — ${edge.matchedResources} ресурсов/${edge.matchedPoints} точек, origin.bytes_fetched — ${origin.matchedResources} ресурсов/${origin.matchedPoints} точек; имена: ${found.join(', ')||'не найдены'}; метки resource: ${labelSummary||'не получены'}`;current.metricWarning=[current.metricWarning,warning].filter(Boolean).join(' · ');}
      if(traffic.fallbackErrors.length)current.metricWarning=[current.metricWarning,`Ошибка чтения метрик по ID CDN: ${traffic.fallbackErrors.join(' · ')}`].filter(Boolean).join(' · ');
      for(const item of folderItems){const measured=byId.get(item.id);item.trafficBytes=measured.trafficBytes;item.edgeBytes=measured.edgeBytes;item.originBytes=measured.originBytes;item.trafficAvailable=measured.trafficAvailable;}
    } catch(error) { current.metricError=error.message; }
  }
  current.cdnResources=all;
  current.trafficBytes=all.reduce((sum,r)=>sum+r.edgeBytes,0);
}

function spawnBillingReport(account) {
  const item=snapshot.accounts.find(x=>x.billingAccountId===account.billingAccountId);
  if (!item) return;
  item.billingLoading=true;
  grantSpent(account).then(spent=>{
    const grant=Number(config.grantAmountRub||4000);
    item.grantSpentRub=Math.min(spent,grant);
    item.grantRemainingRub=Math.max(0,grant-spent);
    item.billingUpdatedAt=new Date().toISOString();
    item.billingError=null;
  }).catch(error=>{item.billingError=error.message;}).finally(()=>{item.billingLoading=false;persist();});
}

async function persist() {
  try { await mkdir(path.dirname(CACHE_PATH),{recursive:true}); await writeFile(CACHE_PATH,JSON.stringify(snapshot,null,2)); } catch (error) { console.error('Cache save failed:',error.message); }
}

async function persistConfig() {
  await mkdir(path.dirname(MANAGED_CONFIG_PATH),{recursive:true});
  const temp=`${MANAGED_CONFIG_PATH}.tmp`;
  await writeFile(temp,JSON.stringify(config,null,2),{mode:0o600});
  await rename(temp,MANAGED_CONFIG_PATH);
  await chmod(MANAGED_CONFIG_PATH,0o600);
}

async function readBody(req, limit=2_000_000) {
  let raw='';
  for await (const chunk of req) { raw+=chunk; if(raw.length>limit) throw new Error('Request too large'); }
  return JSON.parse(raw||'{}');
}

function validateAccount(input, existing=null) {
  const name=String(input.name||'').trim();
  const billingAccountId=String(input.billingAccountId||'').trim();
  const grantStartDate=String(input.grantStartDate||'');
  const folders=Array.isArray(input.folders)?input.folders:[];
  if(!name || !/^[a-zA-Z0-9_-]{4,80}$/.test(billingAccountId) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(grantStartDate) || !Number.isFinite(Date.parse(`${grantStartDate}T00:00:00Z`))) throw new Error('Проверьте название, Billing ID и дату начала гранта.');
  if(!folders.length || folders.some(f=>!/^[-a-zA-Z0-9]{5,80}$/.test(String(f.cloudId||'')) || !/^[-a-zA-Z0-9]{5,80}$/.test(String(f.folderId||'')))) throw new Error('Добавьте хотя бы одну пару Cloud ID и Folder ID.');
  const serviceAccountKeyFile=existing?.serviceAccountKeyFile||'';
  return {name,billingAccountId,grantStartDate,folders:folders.map(f=>({cloudId:String(f.cloudId),folderId:String(f.folderId)})),serviceAccountKeyFile};
}

async function storeKey(account, keyJson) {
  if(!keyJson) return;
  const key=typeof keyJson==='string'?JSON.parse(keyJson):keyJson;
  if(!key?.id || !key?.service_account_id || !key?.private_key) throw new Error('JSON ключа должен содержать id, service_account_id и private_key.');
  const dir=path.join(path.dirname(CACHE_PATH),'secrets');
  await mkdir(dir,{recursive:true});
  const target=path.join(dir,`${account.billingAccountId}.json`);
  await writeFile(target,JSON.stringify(key,null,2),{mode:0o600});
  await chmod(target,0o600);
  account.serviceAccountKeyFile=target;
}

async function refresh({manual=false}={}) {
  if (snapshot.refreshRunning) return;
  snapshot.refreshRunning=true;
  snapshot.lastError=null;
  const now=Date.now();
  const accountConfigs=config.accounts||[];
  const items=accountConfigs.map(account=>{
    let current=snapshot.accounts.find(x=>x.billingAccountId===account.billingAccountId);
    if (!current) { current=initialAccount(account); snapshot.accounts.push(current); }
    const remaining=Math.max(0,grantExpiry(account).getTime()-now);
    current.daysLeft=Math.ceil(remaining/86400000);
    current.grantEndDate=grantExpiry(account).toISOString().slice(0,10);
    current.error=null;
    return {account,current};
  });
  try {
    await Promise.all(items.map(async ({account,current})=>{
      try { await syncCdn(account,current); current.lastUpdated=new Date().toISOString(); }
      catch(error) { current.error=error.message; }
    }));
    // Usage Records API is rate-limited to one request/minute/IP. Rotate accounts
    // so a fleet of billing reports cannot exceed the published rate limit.
    if (items.length && now-(snapshot._lastBillingRequestAt||0)>=60000) {
      const index=(snapshot._billingCursor||0)%items.length;
      const {account}=items[index];
      snapshot._billingCursor=(index+1)%items.length;
      snapshot._lastBillingRequestAt=now;
      snapshot.nextBillingRefreshAt=new Date(now+60000).toISOString();
      spawnBillingReport(account);
    }
    snapshot.lastUpdated=new Date().toISOString();
  } catch(error) { snapshot.lastError=error.message; }
  finally { snapshot.refreshRunning=false; await persist(); }
}

async function load() {
  try { config=JSON.parse(await readFile(MANAGED_CONFIG_PATH,'utf8')); }
  catch { config=JSON.parse(await readFile(CONFIG_PATH,'utf8')); await persistConfig(); }
  if (!Array.isArray(config.accounts)) throw new Error('config.accounts must be an array');
  try { snapshot={...snapshot,...JSON.parse(await readFile(CACHE_PATH,'utf8'))}; } catch {}
  for (const account of config.accounts) if (!snapshot.accounts.some(x=>x.billingAccountId===account.billingAccountId)) snapshot.accounts.push(initialAccount(account));
  await persist();
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if (url.pathname==='/healthz') return json(res,200,{ok:true});
  if (!basicAuthOk(req)) { res.writeHead(401,{'www-authenticate':'Basic realm="YC Monitor"','cache-control':'no-store'}); return res.end('Authentication required'); }
  if (url.pathname==='/api/dashboard' && req.method==='GET') {
    const { _lastBillingRequestAt, _billingCursor, trafficStates, ...publicSnapshot }=snapshot;
    return json(res,200,{...publicSnapshot,accounts:snapshot.accounts.map(a=>({...a,daysLeft:Math.max(0,a.daysLeft||0),folders:config.accounts.find(c=>c.billingAccountId===a.billingAccountId)?.folders||[]}))});
  }
  if (url.pathname==='/api/refresh' && req.method==='POST') {
    refresh({manual:true});
    return json(res,202,{accepted:true,message:'Обновление запущено; биллинговый отчёт обновляется по очереди с учётом лимита API.'});
  }
  if (url.pathname==='/api/accounts' && req.method==='POST') {
    try {
      const body=await readBody(req); const account=validateAccount(body);
      if(config.accounts.some(a=>a.billingAccountId===account.billingAccountId)) return json(res,409,{error:'Аккаунт с таким Billing ID уже существует.'});
      await storeKey(account,body.keyJson); if(!account.serviceAccountKeyFile) return json(res,400,{error:'Загрузите JSON-ключ сервисного аккаунта.'});
      config.accounts.push(account); await persistConfig(); snapshot.accounts.push(initialAccount(account)); refresh(); return json(res,201,{ok:true});
    } catch(error) { return json(res,400,{error:error.message}); }
  }
  if (url.pathname.startsWith('/api/accounts/') && req.method==='PUT') {
    try {
      const id=decodeURIComponent(url.pathname.slice('/api/accounts/'.length)); const index=config.accounts.findIndex(a=>a.billingAccountId===id);
      if(index<0) return json(res,404,{error:'Аккаунт не найден.'});
      const body=await readBody(req); const account=validateAccount({...body,billingAccountId:id},config.accounts[index]);
      await storeKey(account,body.keyJson); config.accounts[index]=account; await persistConfig(); refresh(); return json(res,200,{ok:true});
    } catch(error) { return json(res,400,{error:error.message}); }
  }
  const publicFiles={'/':'index.html','/index.html':'index.html','/accounts':'index.html','/cdn':'index.html','/styles.css':'styles.css','/app.js':'app.js','/logo.svg':'logo.svg','/favicon.svg':'favicon.svg'};
  const file=publicFiles[url.pathname];
  if (file) {
    try { const data=await readFile(path.join(ROOT,file)); res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':'no-store'}); return res.end(data); }
    catch { return json(res,404,{error:'Not found'}); }
  }
  return json(res,404,{error:'Not found'});
});

await load();
if (!BASIC_USER || BASIC_PASSWORD.length < 16 || BASIC_PASSWORD === 'replace-with-a-long-random-password') {
  throw new Error('Set DASHBOARD_USER and a unique DASHBOARD_PASSWORD of at least 16 characters in .env before exposing the dashboard.');
}
server.listen(PORT,'0.0.0.0',()=>console.log(`YC Monitor listening on ${PORT}`));
setTimeout(()=>refresh(),1500);
setInterval(()=>refresh(),Number(config.refreshIntervalSeconds||60)*1000);
