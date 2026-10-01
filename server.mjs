import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { constants, createSign, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ACCOUNTS_CONFIG || path.join(ROOT, 'config/accounts.json');
const CACHE_PATH = process.env.CACHE_PATH || path.join(ROOT, 'data/cache.json');
const PORT = Number(process.env.PORT || 3000);
const BASIC_USER = process.env.DASHBOARD_USER || '';
const BASIC_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};

let config;
let snapshot = { accounts: [], lastUpdated: null, lastError: null, refreshRunning: false, nextBillingRefreshAt: null };
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

function integrateSeries(series, startMs, endMs) {
  const ts = series.timeseries?.timestamps || [];
  const values = series.timeseries?.doubleValues || series.timeseries?.int64Values || [];
  const points = ts.map((t,i)=>({t:Number(t),v:Number(values[i])})).filter(p=>Number.isFinite(p.v)&&p.t>=startMs&&p.t<=endMs).sort((a,b)=>a.t-b.t);
  let bytes = 0;
  for (let i=1;i<points.length;i++) {
    const seconds=(points[i].t-points[i-1].t)/1000;
    // Skip long gaps: interpolating across missing data would overstate usage.
    if (seconds > 15*60 || seconds <= 0) continue;
    bytes += ((Math.max(0,points[i-1].v)+Math.max(0,points[i].v))/2)*seconds;
  }
  return bytes;
}

async function readFolderTraffic(account, folderId, startDate, resources) {
  const startMs=Date.parse(`${startDate}T00:00:00Z`), endMs=Date.now();
  const query = '"edge.bytes_sent"{resource="*"}';
  const result = await ycFetch(account, `https://monitoring.api.cloud.yandex.net/monitoring/v2/data/read?folderId=${encodeURIComponent(folderId)}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
      query, fromTime:new Date(startMs).toISOString(), toTime:new Date(endMs).toISOString(),
      downsampling:{maxPoints:'10000',gridAggregation:'AVG',gapFilling:'NULL'}
    })
  });
  const byResource = new Map();
  for (const series of result.metrics || []) {
    const id=series.labels?.resource;
    if (id) byResource.set(id,(byResource.get(id)||0)+integrateSeries(series,startMs,endMs));
  }
  return resources.map(resource=>({...resource,trafficBytes:byResource.get(resource.id)||0}));
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
  const value=Number(report.credit_details?.monetary_grant_credit?.value || 0);
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
  const all=[];
  for (const folder of account.folders || []) {
    const resources=await listCdnResources(account,folder.folderId);
    const withTraffic=await readFolderTraffic(account,folder.folderId,account.grantStartDate,resources);
    all.push(...withTraffic.map(r=>({id:r.id,name:r.cname||r.id,folderId:folder.folderId,active:r.active!==false,trafficBytes:r.trafficBytes||0})));
  }
  current.cdnResources=all;
  current.trafficBytes=all.reduce((sum,r)=>sum+r.trafficBytes,0);
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
    item.error=null;
  }).catch(error=>{item.billingError=error.message;}).finally(()=>{item.billingLoading=false;persist();});
}

async function persist() {
  try { await mkdir(path.dirname(CACHE_PATH),{recursive:true}); await writeFile(CACHE_PATH,JSON.stringify(snapshot,null,2)); } catch (error) { console.error('Cache save failed:',error.message); }
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
  config=JSON.parse(await readFile(CONFIG_PATH,'utf8'));
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
    const { _lastBillingRequestAt, _billingCursor, ...publicSnapshot }=snapshot;
    return json(res,200,{...publicSnapshot,accounts:snapshot.accounts.map(a=>({...a,daysLeft:Math.max(0,a.daysLeft||0)}))});
  }
  if (url.pathname==='/api/refresh' && req.method==='POST') {
    refresh({manual:true});
    return json(res,202,{accepted:true,message:'Обновление запущено; биллинговый отчёт обновляется по очереди с учётом лимита API.'});
  }
  const publicFiles={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'};
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
