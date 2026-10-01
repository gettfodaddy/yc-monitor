const fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n||0);
const gb=n=>`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format((n||0)/1e9)} ГБ`;
const dateTime=v=>v?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'—';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows=document.querySelector('#account-rows');
const isCdn=location.pathname==='/cdn';
let model=null, editingId=null;

function render(data){
  model=data;const accounts=data.accounts||[],totalCdn=accounts.reduce((n,a)=>n+(a.cdnResources||[]).length,0);
  const reported=accounts.filter(a=>a.grantSpentRub!=null),spent=reported.reduce((n,a)=>n+(a.grantSpentRub||0),0),remaining=reported.reduce((n,a)=>n+(a.grantRemainingRub||0),0);
  document.querySelector('#summary-accounts').textContent=accounts.length;document.querySelector('#nav-count').textContent=accounts.length;
  document.querySelector('#summary-accounts-note').textContent=accounts.every(a=>!a.error)?'Подключены к конфигурации':'Есть ошибки подключения';
  document.querySelector('#summary-cdn').textContent=totalCdn;document.querySelector('#summary-spent').textContent=reported.length?`${fmt(spent)} ₽`:'—';
  document.querySelector('#summary-spent-note').textContent=reported.length?`из ${fmt(reported.length*4000)} ₽ · ${reported.length} отчётов`:'Отчёт ещё не получен';document.querySelector('#summary-remaining').textContent=reported.length?`${fmt(remaining)} ₽`:'—';
  const state=document.querySelector('#connection-state');state.innerHTML=`<i></i> ${accounts.length?'API · '+accounts.length+' АККАУНТ':'НЕТ АККАУНТОВ'}`;
  document.querySelector('#nav-accounts').classList.toggle('active',!isCdn);document.querySelector('#nav-cdn').classList.toggle('active',isCdn);
  document.querySelector('#page-title').textContent=isCdn?'CDN-ресурсы':'Аккаунты';document.querySelector('#breadcrumb-page').textContent=isCdn?'CDN-ресурсы':'Аккаунты';
  document.querySelector('#page-description').textContent=isCdn?'Список ресурсов и использованный трафик по аккаунтам':'Состояние стартовых грантов и трафика CDN';
  document.querySelector('#table-title').textContent=isCdn?'Все CDN-ресурсы':'Ваши аккаунты';document.querySelector('#table-description').textContent=isCdn?'Каждая строка показывает ресурс, аккаунт и трафик с начала гранта':'Данные с начала действия стартового гранта';
  document.querySelector('#add-account').hidden=isCdn;
  if(isCdn){
    document.querySelector('#table-head').innerHTML='<tr><th>АККАУНТ</th><th>CDN-РЕСУРС</th><th>СТАТУС</th><th>ТРАФИК С НАЧАЛА ГРАНТА</th></tr>';
    const all=accounts.flatMap(a=>(a.cdnResources||[]).map(r=>({account:a,resource:r})));
    rows.innerHTML=all.length?all.map(({account:a,resource:r})=>`<tr><td><b>${esc(a.name)}</b><small class="account-id">${esc(a.billingAccountId)}</small></td><td>${esc(r.name||r.id)}<small class="account-id">${esc(r.id)}</small></td><td>${r.active?'Активен':'Отключён'}</td><td><b>${gb(r.trafficBytes)}</b></td></tr>`).join(''):'<tr><td colspan="4" class="empty-row">CDN-ресурсы не загружены. Проверьте роли cdn.viewer и доступ сервисного аккаунта.</td></tr>';
    document.querySelector('.summary-grid').hidden=true;
  }else{
    document.querySelector('.summary-grid').hidden=false;
    document.querySelector('#table-head').innerHTML='<tr><th>АККАУНТ</th><th>CDN-РЕСУРСЫ</th><th>ТРАФИК С НАЧАЛА ГРАНТА</th><th>ИСПОЛЬЗОВАНО</th><th>ОСТАТОК ГРАНТА</th><th>ДО ОКОНЧАНИЯ</th><th>ДЕЙСТВИЕ</th></tr>';
    rows.innerHTML=accounts.length?accounts.map(a=>{
      const left=a.grantRemainingRub,used=a.grantSpentRub,pct=used==null?0:Math.min(100,used/40),resources=a.cdnResources||[];
      const cdnList=resources.length?`<details class="cdn-details"><summary>Список и трафик ▾</summary><div class="cdn-list">${resources.map(r=>`<div><span title="${esc(r.name)}">${esc(r.name)}</span><b>${gb(r.trafficBytes)}</b></div>`).join('')}</div></details>`:'<small>Ресурсы не загружены</small>';
      const errors=[a.error,a.metricError,a.billingError].filter(Boolean);return `<tr><td><div class="account-cell"><span class="account-avatar">${esc((a.name||'?').slice(0,1).toUpperCase())}</span><div><div class="account-name">${esc(a.name)}</div><div class="account-id">${esc(a.billingAccountId)}</div></div></div>${errors.length?`<div class="row-error" title="${esc(errors.join(' · '))}">Ошибка синхронизации</div>`:''}</td><td><div class="cdn-cell"><b>${resources.length} ${resources.length===1?'ресурс':'ресурсов'}</b><small>Yandex Cloud CDN</small>${cdnList}</div></td><td><div class="traffic-cell"><b>${gb(a.trafficBytes)}</b><small>с ${esc(a.grantStartDate)}</small></div></td><td><div class="grant-number">${used==null?'Ожидание отчёта':`${fmt(used)} ₽`} <span class="grant-total">/ 4 000 ₽</span></div><div class="grant-bar"><i style="width:${pct}%"></i></div><small class="updated-small">Биллинг: ${dateTime(a.billingUpdatedAt)}</small></td><td><div class="remaining">${left==null?'—':`${fmt(left)} ₽`}</div><div class="account-id">осталось средств</div></td><td><div class="days"><span class="days-ring">${a.daysLeft==null?'—':Math.max(0,a.daysLeft)}</span><span class="days-text">дней<small>до ${esc(a.grantEndDate||'—')}</small></span></div></td><td><button class="edit-account" data-id="${esc(a.billingAccountId)}">Изменить</button></td></tr>`;
    }).join(''):'<tr><td colspan="7" class="empty-row">Добавьте первый аккаунт кнопкой «Добавить аккаунт».</td></tr>';
    rows.querySelectorAll('.edit-account').forEach(button=>button.addEventListener('click',()=>openEdit(button.dataset.id)));
  }
  document.querySelector('#showing').textContent=isCdn?`Показано ${rows.querySelectorAll('tr').length} ресурсов`:`Показано ${accounts.length} аккаунтов`;
  document.querySelector('#updated').textContent=dateTime(data.lastUpdated);
  const errors=accounts.flatMap(a=>[a.error,a.metricError,a.billingError]).filter(Boolean);document.querySelector('#notice').textContent=errors.length?`Есть ошибки API: ${errors.join(' · ')}`:'Автообновление каждую минуту. Отчёты биллинга обновляются по очереди с учётом лимита API.';
}
async function load(){try{const response=await fetch('/api/dashboard',{cache:'no-store'});if(!response.ok)throw new Error(response.status===401?'Требуется вход в панель.':`Ошибка сервера ${response.status}`);render(await response.json());}catch(error){document.querySelector('#connection-state').innerHTML='<i></i> НЕТ СОЕДИНЕНИЯ';document.querySelector('#notice').textContent=`Не удалось получить данные: ${error.message}`;}}
function openEdit(id){const a=model.accounts.find(x=>x.billingAccountId===id);if(!a)return;editingId=id;const f=document.querySelector('#account-form');f.elements.name.value=a.name;f.elements.billingAccountId.value=id;f.elements.billingAccountId.disabled=true;f.elements.grantStartDate.value=a.grantStartDate;f.elements.folders.value=(a.folders||[]).map(x=>`${x.cloudId},${x.folderId}`).join('\n');f.elements.keyFile.required=false;document.querySelector('#dialog-title').textContent='Изменить аккаунт';document.querySelector('#key-hint').textContent='Необязательно: загрузите новый JSON-ключ, чтобы заменить текущий.';document.querySelector('#form-error').textContent='';document.querySelector('#account-dialog').showModal();}
document.querySelector('#add-account').addEventListener('click',()=>{editingId=null;const f=document.querySelector('#account-form');f.reset();f.elements.billingAccountId.disabled=false;f.elements.keyFile.required=true;document.querySelector('#dialog-title').textContent='Добавить аккаунт';document.querySelector('#key-hint').textContent='Загрузите JSON-ключ сервисного аккаунта (id, service_account_id, private_key).';document.querySelector('#form-error').textContent='';document.querySelector('#account-dialog').showModal();});
for(const id of ['dialog-close','dialog-cancel'])document.querySelector(`#${id}`).addEventListener('click',()=>document.querySelector('#account-dialog').close());
document.querySelector('#account-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,error=document.querySelector('#form-error');error.textContent='';try{
  const folders=f.elements.folders.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(line=>{const parts=line.split(',').map(x=>x.trim());if(parts.length!==2)throw new Error('Каждая строка каталогов должна быть в формате cloud-id,folder-id.');return {cloudId:parts[0],folderId:parts[1]};});
  const body={name:f.elements.name.value,billingAccountId:f.elements.billingAccountId.value,grantStartDate:f.elements.grantStartDate.value,folders};const file=f.elements.keyFile.files[0];if(file)body.keyJson=JSON.parse(await file.text());
  const response=await fetch(editingId?`/api/accounts/${encodeURIComponent(editingId)}`:'/api/accounts',{method:editingId?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить аккаунт.');document.querySelector('#account-dialog').close();await load();
}catch(err){error.textContent=err.message;}});
document.querySelector('#search').addEventListener('input',e=>{const q=e.target.value.trim().toLocaleLowerCase('ru');[...rows.querySelectorAll('tr')].forEach(row=>row.hidden=!row.textContent.toLocaleLowerCase('ru').includes(q));});
document.querySelector('#refresh').addEventListener('click',async e=>{const b=e.currentTarget;b.classList.add('busy');b.disabled=true;try{await fetch('/api/refresh',{method:'POST'});await new Promise(r=>setTimeout(r,900));await load();}finally{b.classList.remove('busy');b.disabled=false;}});
load();setInterval(load,60000);
