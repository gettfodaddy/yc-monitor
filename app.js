const fmt = n => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n);
const gb = n => `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format((n||0)/1e9)} ГБ`;
const dateTime = value => value ? new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows = document.querySelector('#account-rows');
let model = null;

function render(data) {
  model=data;
  const accounts=data.accounts||[];
  const totalCdn=accounts.reduce((n,a)=>n+(a.cdnResources||[]).length,0);
  const reported=accounts.filter(a=>a.grantSpentRub!==null&&a.grantSpentRub!==undefined);
  const spent=reported.reduce((n,a)=>n+(a.grantSpentRub||0),0);
  const remaining=reported.reduce((n,a)=>n+(a.grantRemainingRub||0),0);
  document.querySelector('#summary-accounts').textContent=accounts.length;
  document.querySelector('#nav-count').textContent=accounts.length;
  document.querySelector('#summary-accounts-note').textContent=accounts.every(a=>!a.error)?'Подключены к конфигурации':'Есть ошибки подключения';
  document.querySelector('#summary-cdn').textContent=totalCdn;
  document.querySelector('#summary-spent').textContent=reported.length?`${fmt(spent)} ₽`:'—';
  document.querySelector('#summary-spent-note').textContent=reported.length?`из ${fmt(reported.length*4000)} ₽ · ${reported.length} отчётов`:'Отчёт ещё не получен';
  document.querySelector('#summary-remaining').textContent=reported.length?`${fmt(remaining)} ₽`:'—';
  const state=document.querySelector('#connection-state');
  state.innerHTML=`<i></i> ${accounts.length?'API · '+accounts.length+' АККАУНТ':'НЕТ АККАУНТОВ'}`;
  rows.innerHTML=accounts.length?accounts.map(a=>{
    const left=a.grantRemainingRub;
    const spentValue=a.grantSpentRub;
    const pct=spentValue===null||spentValue===undefined?0:Math.min(100,spentValue/40);
    const resources=a.cdnResources||[];
    const cdnList=resources.length?`<details class="cdn-details"><summary>Список и трафик ▾</summary><div class="cdn-list">${resources.map(r=>`<div><span title="${esc(r.name)}">${esc(r.name)}</span><b>${gb(r.trafficBytes)}</b></div>`).join('')}</div></details>`:'<small>Ресурсы не загружены</small>';
    const days=a.daysLeft==null?'—':Math.max(0,a.daysLeft);
    const status=a.error||a.billingError||'';
    return `<tr><td><div class="account-cell"><span class="account-avatar">${esc((a.name||'?').slice(0,1).toUpperCase())}</span><div><div class="account-name">${esc(a.name)}</div><div class="account-id">${esc(a.billingAccountId)}</div></div></div>${status?`<div class="row-error" title="${esc(status)}">Ошибка синхронизации</div>`:''}</td><td><div class="cdn-cell"><b>${resources.length} ${resources.length===1?'ресурс':'ресурсов'}</b><small>Yandex Cloud CDN</small>${cdnList}</div></td><td><div class="traffic-cell"><b>${gb(a.trafficBytes)}</b><small>с ${esc(a.grantStartDate)}</small></div></td><td><div class="grant-number">${spentValue==null?'Ожидание отчёта':`${fmt(spentValue)} ₽`} <span class="grant-total">/ 4 000 ₽</span></div><div class="grant-bar"><i style="width:${pct}%"></i></div><small class="updated-small">Биллинг: ${dateTime(a.billingUpdatedAt)}</small></td><td><div class="remaining">${left==null?'—':`${fmt(left)} ₽`}</div><div class="account-id">осталось средств</div></td><td><div class="days"><span class="days-ring">${days}</span><span class="days-text">дней<small>до ${esc(a.grantEndDate||'—')}</small></span></div></td><td class="more">···</td></tr>`;
  }).join(''):'<tr><td colspan="7" class="empty-row">В config/accounts.json пока нет аккаунтов</td></tr>';
  document.querySelector('#showing').textContent=`Показано ${accounts.length} аккаунтов`;
  document.querySelector('#updated').textContent=dateTime(data.lastUpdated);
  const errors=accounts.flatMap(a=>[a.error,a.billingError]).filter(Boolean);
  document.querySelector('#notice').textContent=errors.length?`Есть ошибки API: ${errors.map(esc).join(' · ')}`:`Автообновление каждую минуту. Биллинг: по очереди, чтобы соблюдать лимит API. Данные метрик Yandex Cloud могут запаздывать.`;
}

async function load() {
  try {
    const response=await fetch('/api/dashboard',{cache:'no-store'});
    if(!response.ok) throw new Error(response.status===401?'Требуется вход в панель.':`Ошибка сервера ${response.status}`);
    render(await response.json());
  } catch(error) {
    document.querySelector('#connection-state').innerHTML='<i></i> НЕТ СОЕДИНЕНИЯ';
    document.querySelector('#notice').textContent=`Не удалось получить данные: ${error.message}`;
  }
}

document.querySelector('#search').addEventListener('input',event=>{
  const q=event.target.value.trim().toLocaleLowerCase('ru');
  [...rows.querySelectorAll('tr')].forEach(row=>row.hidden=!row.textContent.toLocaleLowerCase('ru').includes(q));
});
document.querySelector('#refresh').addEventListener('click',async event=>{
  const button=event.currentTarget;
  button.classList.add('busy');button.disabled=true;
  try { await fetch('/api/refresh',{method:'POST'}); await new Promise(r=>setTimeout(r,900)); await load(); }
  finally { button.classList.remove('busy');button.disabled=false; }
});
load();
setInterval(load,60000);
