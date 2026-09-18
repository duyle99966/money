/* =========================================================================
   Sổ chung — ứng dụng chia đôi chi tiêu cho đúng hai người.
   Mọi số tiền là số nguyên VND. Không dùng float cho tiền.
   Lưu trữ: capability `db` của artifact (chia sẻ giữa hai người);
   nếu không có thì rơi về localStorage (chỉ máy hiện tại).
   ========================================================================= */

const PEOPLE = {
  duy:    { username:'duy',    name:'Duy',    role:'ADMIN' },
  nguyen: { username:'nguyen', name:'Nguyen', role:'USER'  },
};
const CATEGORIES = ['Food','Drinks','Transport','Entertainment','Shopping','Bills','Other'];
const CAT_VI = {Food:'Ăn uống',Drinks:'Đồ uống',Transport:'Di chuyển',Entertainment:'Giải trí',Shopping:'Mua sắm',Bills:'Hóa đơn',Other:'Khác'};

/* ---------------- money ---------------- */
const vnd = n => new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫';
const other = u => u === 'duy' ? 'nguyen' : 'duy';
const nameOf = u => (PEOPLE[u]||{}).name || u;
// Quy tắc chia: người ứng tiền nhận phần lẻ (ceil), người còn lại floor.
// Tổng hai phần luôn = tổng giao dịch, không mất đồng nào.
function split(amount, paidBy){
  const a = Math.trunc(amount);
  const payer = Math.ceil(a/2), rest = a - payer;
  return { [paidBy]: payer, [other(paidBy)]: rest };
}
const owedOf = t => split(t.amount, t.paid_by)[other(t.paid_by)];       // nợ gốc
const remainOf = t => Math.max(0, owedOf(t) - (t.repaid||0));           // còn lại
function statusOf(t){
  const r = remainOf(t);
  if (r === 0) return 'SETTLED';
  if ((t.repaid||0) > 0) return 'PARTIALLY_SETTLED';
  return 'OPEN';
}
const STATUS_VI = {OPEN:'Chưa trả',PARTIALLY_SETTLED:'Trả một phần',SETTLED:'Đã xong'};

/* ---------------- storage ---------------- */
const LS = 'sochung.v1';
const Store = {
  db:null, local:{txns:{},settlements:{},activity:{},config:{}},
  async init(){
    try { this.db = await claude.use('db'); } catch(e){ this.db = null; }
    if (!this.db){
      try { this.local = JSON.parse(localStorage.getItem(LS)) || this.local; } catch(e){}
    }
    return !!this.db;
  },
  _flush(){ try{ localStorage.setItem(LS, JSON.stringify(this.local)); }catch(e){} },
  async set(col,id,data){
    if (this.db) return this.db.doc(col+'/'+id).set(data);
    this.local[col] = this.local[col]||{}; this.local[col][id] = data; this._flush(); Data.reload();
  },
  async del(col,id){
    if (this.db) return this.db.doc(col+'/'+id).delete();
    delete (this.local[col]||{})[id]; this._flush(); Data.reload();
  },
  watch(col, cb){
    if (this.db){
      return this.db.collection(col).onSnapshot(
        s => cb(s.docs.map(d => ({ id:d.id, ...d.data }))),
        e => toast('Lỗi dữ liệu: ' + e.code)
      );
    }
    cb(Object.entries(this.local[col]||{}).map(([id,v]) => ({id,...v})));
    return () => {};
  }
};

/* ---------------- state ---------------- */
const Data = { txns:[], settlements:[], activity:[], config:{}, ready:false };
let me = null;
let route = { path:'dashboard', param:null };
let uiFilter = { status:'ALL', q:'', sort:'new' };

function reload(){ Data.reload(); }
Data.reload = () => {
  if (!Store.db){
    ['txns','settlements','activity'].forEach(c => {
      Data[c] = Object.entries(Store.local[c]||{}).map(([id,v])=>({id,...v}));
    });
    Data.config = Store.local.config || {};
  }
  render();
};

/* ---------------- derived ---------------- */
const sortedTxns = () => [...Data.txns].sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.created_at||'').localeCompare(a.created_at||''));

// Net balance: dương = nguyen nợ duy; âm = duy nợ nguyen.
function netBalance(){
  let net = 0;
  for (const t of Data.txns){
    const r = remainOf(t);
    net += (t.paid_by === 'duy') ? r : -r;
  }
  return net;
}
function balanceText(){
  const n = netBalance();
  if (n === 0) return { debtor:null, creditor:null, amount:0, text:'Đã cân bằng' };
  const debtor = n > 0 ? 'nguyen' : 'duy';
  return { debtor, creditor:other(debtor), amount:Math.abs(n),
           text:`${nameOf(debtor)} nợ ${nameOf(other(debtor))}` };
}
function myStats(){
  let paid=0, share=0, total=0, iOwe=0, owedMe=0;
  for (const t of Data.txns){
    total += t.amount;
    const s = split(t.amount, t.paid_by);
    share += s[me.username];
    if (t.paid_by === me.username){ paid += t.amount; owedMe += remainOf(t); }
    else iOwe += remainOf(t);
  }
  return { count:Data.txns.length, total, paid, share, iOwe, owedMe };
}

/* ---------------- permissions (mirror của RLS ở backend) ---------------- */
const isAdmin = () => me && me.role === 'ADMIN';
const canEdit = t => isAdmin() || t.created_by === me.username;
const canDelete = t => isAdmin() || t.created_by === me.username;
// Người còn nợ (hoặc admin) mới được xác nhận trả.
const canMarkPaid = t => remainOf(t) > 0 && (isAdmin() || other(t.paid_by) === me.username);

/* ---------------- activity ---------------- */
const now = () => new Date().toISOString();
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
async function log(action, entity_type, entity_id, metadata){
  await Store.set('activity', rid(), { user_id:me.username, action, entity_type, entity_id,
    metadata:metadata||{}, created_at:now() });
  const rest = [...Data.activity].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).slice(300);
  for (const old of rest) Store.del('activity', old.id);
}

/* ---------------- auth (prototype) ---------------- */
/* Prototype: mật khẩu được so sánh với hash lưu trong DB, không nằm cứng trong
   logic đăng nhập. Khi lên production thật, thay toàn bộ khối này bằng
   Supabase Auth (xem file schema kèm theo) — frontend không giữ mật khẩu. */
async function sha(s){
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sochung|'+s));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const DEFAULT_PW = '1';
async function credsDoc(){
  if (Store.db){
    const d = await Store.db.doc('config/auth').get();
    return d.exists ? d.data : null;
  }
  return Store.local.config.auth || null;
}
async function saveCreds(obj){
  if (Store.db) await Store.db.doc('config/auth').set(obj);
  else { Store.local.config.auth = obj; Store._flush(); }
}
async function checkLogin(username, password){
  const u = (username||'').trim().toLowerCase();
  if (!PEOPLE[u]) return null;
  let creds = await credsDoc();
  if (!creds){ const d = await sha(DEFAULT_PW); creds = { duy:d, nguyen:d }; await saveCreds(creds); }
  const h = await sha(password||'');
  return creds[u] === h ? PEOPLE[u] : null;
}

/* ---------------- session ---------------- */
const SESS = 'sochung.session';
function saveSession(u){ try{ localStorage.setItem(SESS, JSON.stringify({u, at:Date.now()})); }catch(e){} }
function readSession(){
  try{
    const s = JSON.parse(localStorage.getItem(SESS)||'null');
    if (!s) return null;
    if (Date.now() - s.at > 1000*60*60*24*14) return null;   // hết hạn sau 14 ngày
    return PEOPLE[s.u] || null;
  }catch(e){ return null; }
}
function logout(){
  log('LOGOUT','session',me.username,{}).catch(()=>{});
  localStorage.removeItem(SESS); me = null;
  document.getElementById('appView').classList.remove('on');
  document.getElementById('loginView').style.display = '';
}

/* ---------------- helpers ---------------- */
const esc = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el = (id) => document.getElementById(id);
const todayISO = () => new Date().toISOString().slice(0,10);
function fmtDate(d){
  if (!d) return '—';
  const x = new Date(d+(d.length===10?'T00:00:00':''));
  return x.toLocaleDateString('vi-VN',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtDT(d){
  const x = new Date(d);
  return x.toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit'}) + ' ' +
         x.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
}
function toast(msg){
  const r = el('toastRoot'); r.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  setTimeout(()=>{ r.innerHTML=''; }, 2600);
}
function parseAmount(v){
  const digits = String(v||'').replace(/[^\d]/g,'');
  return digits ? parseInt(digits,10) : 0;
}

/* =========================== RENDER =========================== */
const NAV = [
  {p:'dashboard',   t:'Tổng quan',   m:'Tổng quan'},
  {p:'transactions',t:'Giao dịch',   m:'Giao dịch'},
  {p:'new',         t:'Tạo giao dịch',m:null},
  {p:'settlements', t:'Cân nợ',      m:'Cân nợ'},
  {p:'history',     t:'Lịch sử trả', m:null},
  {p:'activity',    t:'Nhật ký',     m:null},
  {p:'settings',    t:'Cài đặt',     m:'Cài đặt'},
  {p:'admin',       t:'Quản trị',    m:null, admin:true},
];

function render(){
  if (!me) return;
  const b = balanceText();
  el('sideBal').textContent = b.amount ? b.text + ' ' + vnd(b.amount) : 'Đã cân bằng';
  el('meAv').textContent = nameOf(me.username)[0];
  el('meName').textContent = nameOf(me.username);
  el('meRole').textContent = me.role === 'ADMIN' ? 'Quản trị viên' : 'Thành viên';

  const unpaid = Data.txns.filter(t => t.paid_by !== me.username && remainOf(t) > 0).length;
  el('nav').innerHTML = NAV.filter(n=>!n.admin||isAdmin()).map(n =>
    `<a href="#/${n.p}" class="${route.path===n.p?'active':''}">${esc(n.t)}${
      n.p==='transactions'&&unpaid?`<span class="badge">${unpaid}</span>`:''}</a>`).join('');
  el('mnav').innerHTML = NAV.filter(n=>n.m && (!n.admin||isAdmin())).map(n =>
    `<a href="#/${n.p}" class="${route.path===n.p?'active':''}">${esc(n.m)}</a>`).join('');

  const fn = ({dashboard:vDashboard,transactions:vTransactions,detail:vDetail,new:vNew,
               settlements:vSettlements,history:vHistory,activity:vActivity,
               settings:vSettings,admin:vAdmin})[route.path] || vDashboard;
  el('main').innerHTML = fn();
  if (route.path === 'new') bindForm();
}

/* ---- dashboard ---- */
function vDashboard(){
  const b = balanceText(), s = myStats();
  const meOwes = b.debtor === me.username;
  const cls = b.amount === 0 ? '' : (meOwes ? 'debit' : 'credit');
  const line = b.amount === 0 ? 'Hai bên không nợ nhau'
    : meOwes ? `Bạn đang nợ ${nameOf(b.creditor)}` : `${nameOf(b.debtor)} đang nợ bạn`;
  const recent = sortedTxns().slice(0,5);
  const unpaid = Data.txns.filter(t => t.paid_by !== me.username && remainOf(t) > 0);

  return `
  <div class="page-head">
    <div><h2>Xin chào, ${esc(nameOf(me.username))}</h2>
    <p>Mọi giao dịch được chia đôi tự động. Bạn chỉ cần ghi lại ai đã trả.</p></div>
    <div class="actions">
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>
    </div>
  </div>

  ${unpaid.length ? `<div class="notice">
      <span>Bạn có ${unpaid.length} khoản chưa trả, tổng ${vnd(unpaid.reduce((a,t)=>a+remainOf(t),0))}.</span>
      <a class="btn sm" href="#/settlements">Cân nợ ngay</a></div>` : ''}

  <section class="hero">
    <p class="who-line">${esc(line)}</p>
    <p class="amount ${cls}">${vnd(b.amount)}</p>
    <p class="sub">${Data.txns.length} giao dịch · tổng chi ${vnd(s.total)} · quy tắc chia 50/50</p>
    <div class="hero-actions">
      <a class="btn" href="#/transactions">Xem giao dịch</a>
      ${b.amount ? `<a class="btn" href="#/settlements">Cân nợ</a>`:''}
    </div>
  </section>

  <div class="grid cards">
    ${stat('Số giao dịch', s.count, false)}
    ${stat('Tổng đã chi', vnd(s.total))}
    ${stat('Bạn đã ứng trước', vnd(s.paid))}
    ${stat('Phần của bạn', vnd(s.share))}
    ${stat('Bạn còn nợ', vnd(s.iOwe), 'debit')}
    ${stat('Người khác nợ bạn', vnd(s.owedMe), 'credit')}
  </div>

  <section class="section panel">
    <h3>Giao dịch gần đây</h3>
    ${recent.length ? `<div class="tbl-wrap">${txnTable(recent)}</div>`
      : `<div class="empty"><b>Chưa có giao dịch nào</b>Ghi khoản đầu tiên để bắt đầu theo dõi.</div>`}
  </section>`;
}
const stat = (k,v,cls) => `<div class="stat"><div class="k">${esc(k)}</div>
  <div class="v ${cls||''}">${typeof v==='number'?v:v}</div></div>`;

/* ---- transactions ---- */
function txnTable(list){
  return `<table>
  <thead><tr><th>Ngày</th><th>Nội dung</th><th>Tổng</th><th>Người trả</th>
  <th>Phần bạn</th><th>Còn lại</th><th>Trạng thái</th><th></th></tr></thead>
  <tbody>${list.map(t=>{
    const s = split(t.amount, t.paid_by), st = statusOf(t), rem = remainOf(t);
    const dir = t.paid_by === me.username ? 'credit' : 'debit';
    return `<tr class="row" onclick="go('transactions/${t.id}')">
      <td class="meta num">${fmtDate(t.date)}</td>
      <td><div class="title">${esc(t.title)}</div>
          <div class="meta"><span class="tag">${esc(CAT_VI[t.category]||t.category)}</span> · ${esc(nameOf(t.created_by))} tạo</div></td>
      <td class="num">${vnd(t.amount)}</td>
      <td>${esc(nameOf(t.paid_by))}</td>
      <td class="num">${vnd(s[me.username])}</td>
      <td class="num" style="color:var(--${rem?dir:'dim'})">${rem?vnd(rem):'—'}</td>
      <td><span class="status"><i class="dot ${st==='SETTLED'?'done':st==='OPEN'?'open':'part'}"></i>${STATUS_VI[st]}</span></td>
      <td onclick="event.stopPropagation()">${canMarkPaid(t)
        ? `<button class="btn sm" onclick="markPaid('${t.id}')">Xác nhận trả</button>`:''}</td>
    </tr>`;}).join('')}</tbody></table>`;
}

function vTransactions(){
  let list = sortedTxns();
  if (uiFilter.status !== 'ALL') list = list.filter(t => statusOf(t) === uiFilter.status);
  if (uiFilter.q){
    const q = uiFilter.q.toLowerCase();
    list = list.filter(t => (t.title||'').toLowerCase().includes(q) || (t.note||'').toLowerCase().includes(q));
  }
  if (uiFilter.sort === 'old') list = list.reverse();
  if (uiFilter.sort === 'high') list = list.sort((a,b)=>b.amount-a.amount);
  if (uiFilter.sort === 'low')  list = list.sort((a,b)=>a.amount-b.amount);
  const chips = [['ALL','Tất cả'],['OPEN','Chưa trả'],['PARTIALLY_SETTLED','Trả một phần'],['SETTLED','Đã xong']];

  return `
  <div class="page-head">
    <div><h2>Giao dịch</h2><p>${Data.txns.length} khoản đã ghi</p></div>
    <div class="actions">
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>
    </div>
  </div>
  <div class="toolbar">
    <input class="input" placeholder="Tìm theo nội dung hoặc ghi chú…" value="${esc(uiFilter.q)}"
      oninput="uiFilter.q=this.value;render();this.focus();this.setSelectionRange(this.value.length,this.value.length)">
    <select class="input" style="width:auto" onchange="uiFilter.sort=this.value;render()">
      ${[['new','Mới nhất'],['old','Cũ nhất'],['high','Tiền nhiều nhất'],['low','Tiền ít nhất']]
        .map(([v,t])=>`<option value="${v}" ${uiFilter.sort===v?'selected':''}>${t}</option>`).join('')}
    </select>
    <div class="chips">${chips.map(([v,t])=>
      `<button class="chip ${uiFilter.status===v?'on':''}" onclick="uiFilter.status='${v}';render()">${t}</button>`).join('')}</div>
  </div>
  <div class="panel">${list.length ? `<div class="tbl-wrap">${txnTable(list)}</div>`
    : `<div class="empty"><b>Không có giao dịch phù hợp</b>Thử đổi bộ lọc hoặc ghi một khoản mới.</div>`}</div>`;
}

/* ---- detail ---- */
function vDetail(){
  const t = Data.txns.find(x => x.id === route.param);
  if (!t) return `<div class="panel"><div class="empty"><b>Không tìm thấy giao dịch</b>
    <a class="btn sm" href="#/transactions">Quay lại danh sách</a></div></div>`;
  const s = split(t.amount, t.paid_by), st = statusOf(t), rem = remainOf(t);
  const debtor = other(t.paid_by);
  const paidAmt = u => u === t.paid_by ? t.amount : (t.repaid||0);
  const card = u => `<div class="person">
      <h4><span class="avatar">${esc(nameOf(u)[0])}</span>${esc(nameOf(u))}${u===t.paid_by?' · người ứng tiền':''}</h4>
      <div class="kv"><span>Đã trả ngoài đời</span><b>${vnd(paidAmt(u))}</b></div>
      <div class="kv"><span>Phần phải chịu</span><b>${vnd(s[u])}</b></div>
      <div class="kv"><span>Chênh lệch</span><b style="color:var(--${paidAmt(u)-s[u]>=0?'credit':'debit'})">${
        (paidAmt(u)-s[u]>=0?'+':'') + vnd(paidAmt(u)-s[u])}</b></div>
    </div>`;

  return `
  <div class="page-head">
    <div><p style="margin:0 0 4px"><a href="#/transactions" style="color:var(--muted);text-decoration:none">← Giao dịch</a></p>
      <h2>${esc(t.title)}</h2>
      <p><span class="tag">${esc(CAT_VI[t.category]||t.category)}</span> · ${fmtDate(t.date)} · ${esc(nameOf(t.created_by))} tạo
      ${t.edited_at?` · sửa lần cuối ${fmtDT(t.edited_at)} bởi ${esc(nameOf(t.edited_by))}`:''}</p></div>
    <div class="actions">
      ${canMarkPaid(t)?`<button class="btn primary" onclick="markPaid('${t.id}')">Xác nhận đã trả</button>`:''}
      ${canEdit(t)?`<button class="btn" onclick="go('new','${t.id}')">Sửa</button>`:''}
      ${canDelete(t)?`<button class="btn danger" onclick="confirmDelete('${t.id}')">Xóa</button>`:''}
    </div>
  </div>

  <section class="hero" style="padding:20px 24px">
    <p class="who-line">Tổng giao dịch · ${esc(nameOf(t.paid_by))} đã ứng trước toàn bộ</p>
    <p class="amount">${vnd(t.amount)}</p>
  </section>

  <div class="split" style="margin-top:12px">${card('duy')}${card('nguyen')}</div>

  <div class="verdict">
    <div class="l">${rem ? `${esc(nameOf(debtor))} cần trả ${esc(nameOf(t.paid_by))}` : 'Khoản này đã xong'}</div>
    <div class="a" style="color:var(--${rem?(debtor===me.username?'debit':'credit'):'credit'})">${vnd(rem)}</div>
    <div class="l" style="margin-top:8px">
      Nợ gốc ${vnd(owedOf(t))} · đã hoàn ${vnd(t.repaid||0)} ·
      trạng thái <b>${st}</b> (${STATUS_VI[st]})</div>
    ${rem && canMarkPaid(t) ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn primary sm" onclick="markPaid('${t.id}')">Trả hết ${vnd(rem)}</button>
      <button class="btn sm" onclick="openPartial('${t.id}')">Trả một phần</button></div>`:''}
  </div>

  ${t.note ? `<section class="section panel"><h3>Ghi chú</h3><div class="body">${esc(t.note)}</div></section>`:''}`;
}

/* ---- create / edit ---- */
function vNew(){
  const t = route.param ? Data.txns.find(x=>x.id===route.param) : null;
  if (route.param && !t) return `<div class="panel"><div class="empty"><b>Không tìm thấy giao dịch</b></div></div>`;
  if (t && !canEdit(t)) return `<div class="panel"><div class="empty"><b>Bạn không được sửa giao dịch này</b>
    Chỉ người tạo hoặc quản trị viên mới sửa được.</div></div>`;
  return `
  <div class="page-head"><div>
    <h2>${t?'Sửa giao dịch':'Giao dịch mới'}</h2>
    <p>Nhập số tiền, chọn người đã trả — phần chia được tính ngay bên dưới.</p></div></div>
  <div class="split" style="align-items:start">
    <div class="panel"><div class="body">
      <div class="field"><label for="f_title">Nội dung</label>
        <input class="input" id="f_title" placeholder="Ăn tối, Grab, mua nước…" value="${esc(t?t.title:'')}"></div>
      <div class="two">
        <div class="field"><label for="f_amount">Số tiền (VND)</label>
          <input class="input num" id="f_amount" inputmode="numeric" placeholder="200000" value="${t?t.amount:''}"></div>
        <div class="field"><label for="f_cat">Danh mục</label>
          <select class="input" id="f_cat">${CATEGORIES.map(c=>
            `<option value="${c}" ${t&&t.category===c?'selected':''}>${CAT_VI[c]}</option>`).join('')}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="f_paid">Ai đã trả</label>
          <select class="input" id="f_paid">${['duy','nguyen'].map(u=>
            `<option value="${u}" ${(t?t.paid_by:me.username)===u?'selected':''}>${nameOf(u)}</option>`).join('')}</select></div>
        <div class="field"><label for="f_date">Ngày</label>
          <input class="input" id="f_date" type="date" value="${t?t.date:todayISO()}"></div>
      </div>
      <div class="field"><label for="f_note">Ghi chú (tùy chọn)</label>
        <textarea class="input" id="f_note" rows="2" placeholder="Mua đồ ăn sau khi học">${esc(t?t.note||'':'')}</textarea></div>
      <div id="f_err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" onclick="submitTxn(${t?`'${t.id}'`:'null'})">${t?'Lưu thay đổi':'Thêm giao dịch'}</button>
        <a class="btn" href="#/${t?'transactions/'+t.id:'transactions'}">Hủy</a>
      </div>
    </div></div>
    <div class="panel"><h3>Xem trước</h3><div class="body"><div id="preview"></div></div></div>
  </div>`;
}
function bindForm(){
  ['f_amount','f_paid'].forEach(id => el(id).addEventListener('input', drawPreview));
  el('f_paid').addEventListener('change', drawPreview);
  drawPreview();
}
function drawPreview(){
  const amt = parseAmount(el('f_amount').value), paid = el('f_paid').value;
  const box = el('preview');
  if (!amt){ box.innerHTML = `<div class="preview"><div class="row"><span>Nhập số tiền để xem phần chia</span></div></div>`; return; }
  const s = split(amt, paid), mine = s[me.username], theirs = s[other(me.username)];
  const iPaid = paid === me.username;
  const line = iPaid ? `${nameOf(other(me.username))} sẽ nợ bạn` : `Bạn sẽ nợ ${nameOf(paid)}`;
  const amtOwed = iPaid ? theirs : mine;
  box.innerHTML = `<div class="preview">
    <div class="row"><span>Tổng</span><b>${vnd(amt)}</b></div>
    <div class="row"><span>Phần của bạn</span><b>${vnd(mine)}</b></div>
    <div class="row"><span>Phần của ${esc(nameOf(other(me.username)))}</span><b>${vnd(theirs)}</b></div>
    <div class="row"><span>Người ứng tiền</span><b>${esc(nameOf(paid))}</b></div>
    <div class="out"><div class="row"><span>${esc(line)}</span>
      <b style="color:var(--${iPaid?'credit':'debit'})">${vnd(amtOwed)}</b></div></div>
  </div>`;
}
async function submitTxn(id){
  const title = el('f_title').value.trim();
  const amount = parseAmount(el('f_amount').value);
  const paid_by = el('f_paid').value, date = el('f_date').value || todayISO();
  const errs = [];
  if (!title) errs.push('Cần nhập nội dung.');
  if (!amount || amount <= 0) errs.push('Số tiền phải lớn hơn 0.');
  if (!PEOPLE[paid_by]) errs.push('Người trả không hợp lệ.');
  if (errs.length){ el('f_err').innerHTML = `<div class="err">${errs.join(' ')}</div>`; return; }

  if (id){
    const t = Data.txns.find(x=>x.id===id);
    if (!t || !canEdit(t)) return toast('Bạn không có quyền sửa giao dịch này');
    const old = {...t};
    const repaid = Math.min(t.repaid||0, split(amount, paid_by)[other(paid_by)]);
    await Store.set('txns', id, { title, category:el('f_cat').value, amount, paid_by,
      created_by:t.created_by, date, note:el('f_note').value.trim(), repaid,
      created_at:t.created_at, updated_at:now(), edited_at:now(), edited_by:me.username });
    await log('EDIT','transaction',id,{title, from:old.amount, to:amount});
    toast('Đã lưu thay đổi'); go('transactions/'+id);
  } else {
    const nid = rid();
    await Store.set('txns', nid, { title, category:el('f_cat').value, amount, paid_by,
      created_by:me.username, date, note:el('f_note').value.trim(), repaid:0,
      created_at:now(), updated_at:now() });
    await log('CREATE','transaction',nid,{title, amount});
    toast('Đã thêm giao dịch'); go('transactions/'+nid);
  }
}

/* ---- quick add ---- */
function openQuickAdd(){
  modal(`<header><h3>Ghi nhanh</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="q_title">Chi gì?</label>
      <input class="input" id="q_title" placeholder="Ăn sáng" autofocus></div>
    <div class="two">
      <div class="field"><label for="q_amount">Bao nhiêu?</label>
        <input class="input num" id="q_amount" inputmode="numeric" placeholder="50000"></div>
      <div class="field"><label for="q_paid">Ai trả?</label>
        <select class="input" id="q_paid">${['duy','nguyen'].map(u=>
          `<option value="${u}" ${me.username===u?'selected':''}>${nameOf(u)}</option>`).join('')}</select></div>
    </div>
    <div id="q_prev"></div><div id="q_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="quickSubmit()">Thêm giao dịch</button></footer>`);
  const upd = () => {
    const a = parseAmount(el('q_amount').value), p = el('q_paid').value;
    el('q_prev').innerHTML = a ? `<div class="preview"><div class="row"><span>Mỗi người</span>
      <b>${vnd(split(a,p)[me.username])}</b></div><div class="row"><span>${
      p===me.username ? esc(nameOf(other(me.username)))+' nợ bạn' : 'Bạn nợ '+esc(nameOf(p))}</span>
      <b>${vnd(split(a,p)[other(p)])}</b></div></div>` : '';
  };
  el('q_amount').addEventListener('input', upd);
  el('q_paid').addEventListener('change', upd);
  el('q_title').focus();
}
async function quickSubmit(){
  const title = el('q_title').value.trim(), amount = parseAmount(el('q_amount').value);
  const paid_by = el('q_paid').value;
  if (!title || !amount){ el('q_err').innerHTML = `<div class="err">Cần nội dung và số tiền lớn hơn 0.</div>`; return; }
  const nid = rid();
  await Store.set('txns', nid, { title, category:'Other', amount, paid_by, created_by:me.username,
    date:todayISO(), note:'', repaid:0, created_at:now(), updated_at:now() });
  await log('CREATE','transaction',nid,{title, amount});
  closeModal(); toast(`Đã thêm · ${vnd(split(amount,paid_by)[other(paid_by)])} còn nợ`);
}

/* ---- pay / settle ---- */
async function payTxn(t, amount, note){
  const rem = remainOf(t);
  const pay = Math.min(Math.trunc(amount), rem);
  if (pay <= 0) return 0;
  const body = {...t}; delete body.id;
  await Store.set('txns', t.id, { ...body, repaid:(t.repaid||0)+pay, updated_at:now() });
  await Store.set('settlements', rid(), { from_user:other(t.paid_by), to_user:t.paid_by,
    amount:pay, transaction_id:t.id, note:note||'', created_at:now(), created_by:me.username });
  return pay;
}
async function markPaid(id){
  const t = Data.txns.find(x=>x.id===id);
  if (!t || !canMarkPaid(t)) return toast('Bạn không có quyền xác nhận khoản này');
  const paid = await payTxn(t, remainOf(t), 'Trả đủ');
  await log('MARK_PAID','transaction',id,{title:t.title, amount:paid});
  toast(`Đã ghi nhận ${vnd(paid)}`);
}
function openPartial(id){
  const t = Data.txns.find(x=>x.id===id); if (!t) return;
  modal(`<header><h3>Trả một phần</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body"><p style="margin-top:0;color:var(--muted)">Còn lại ${vnd(remainOf(t))} cho “${esc(t.title)}”.</p>
  <div class="field"><label for="pp">Số tiền trả</label>
    <input class="input num" id="pp" inputmode="numeric" value="${remainOf(t)}"></div></div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doPartial('${id}')">Ghi nhận</button></footer>`);
}
async function doPartial(id){
  const t = Data.txns.find(x=>x.id===id);
  if (!t || !canMarkPaid(t)) return toast('Không có quyền');
  const amt = parseAmount(el('pp').value);
  if (!amt) return toast('Số tiền không hợp lệ');
  const paid = await payTxn(t, amt, 'Trả một phần');
  await log('MARK_PAID','transaction',id,{title:t.title, amount:paid});
  closeModal(); toast(`Đã ghi nhận ${vnd(paid)}`);
}

function vSettlements(){
  const b = balanceText();
  const open = sortedTxns().filter(t => remainOf(t) > 0);
  return `
  <div class="page-head"><div><h2>Cân nợ</h2>
    <p>Trả một lần cho toàn bộ số dư giữa hai người.</p></div></div>
  <section class="hero">
    <p class="who-line">Duy ↔ Nguyen</p>
    <p class="amount ${b.amount?(b.debtor===me.username?'debit':'credit'):''}">${vnd(b.amount)}</p>
    <p class="sub">${b.amount ? esc(b.text) : 'Không ai nợ ai. Ghi thêm giao dịch khi có khoản chi mới.'}</p>
    ${b.amount ? `<div class="hero-actions">
      <button class="btn primary" onclick="openSettle()">Thanh toán ${vnd(b.amount)}</button>
      <a class="btn" href="#/history">Lịch sử trả</a></div>`:''}
  </section>
  <section class="section panel"><h3>Các khoản còn dang dở (${open.length})</h3>
  ${open.length ? `<div class="tbl-wrap">${txnTable(open)}</div>`
    : `<div class="empty"><b>Sạch nợ</b>Tất cả giao dịch đã được hoàn tất.</div>`}</section>`;
}
function openSettle(){
  const b = balanceText();
  if (!b.amount) return;
  modal(`<header><h3>Xác nhận thanh toán</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="verdict" style="margin:0">
      <div class="l">${esc(nameOf(b.debtor))} → ${esc(nameOf(b.creditor))}</div>
      <div class="a">${vnd(b.amount)}</div>
      <div class="l" style="margin-top:8px">Số tiền sẽ được trừ dần vào các giao dịch còn nợ, cũ trước.</div>
    </div>
    <div class="field" style="margin-top:14px"><label for="s_amt">Số tiền thanh toán</label>
      <input class="input num" id="s_amt" inputmode="numeric" value="${b.amount}"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doSettle()">Xác nhận</button></footer>`);
}
async function doSettle(){
  const b = balanceText();
  let amt = parseAmount(el('s_amt').value);
  if (!amt) return toast('Số tiền không hợp lệ');
  amt = Math.min(amt, b.amount);
  if (!isAdmin() && b.debtor !== me.username) return toast('Chỉ người đang nợ mới xác nhận trả');
  // trừ dần từ giao dịch cũ nhất mà bên nợ còn thiếu
  const targets = [...Data.txns]
    .filter(t => remainOf(t) > 0 && other(t.paid_by) === b.debtor)
    .sort((x,y) => (x.date||'').localeCompare(y.date||''));
  let left = amt;
  for (const t of targets){
    if (left <= 0) break;
    left -= await payTxn(t, left, 'Cân nợ');
  }
  await log('SETTLEMENT','settlement',rid(),{from:b.debtor, to:b.creditor, amount:amt-left});
  closeModal(); toast(`Đã cân nợ ${vnd(amt-left)}`);
}

/* ---- history ---- */
function vHistory(){
  const list = [...Data.settlements].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  const months = [...new Set(list.map(s=>(s.created_at||'').slice(0,7)))];
  const m = uiFilter.month && months.includes(uiFilter.month) ? uiFilter.month : 'ALL';
  const shown = m === 'ALL' ? list : list.filter(s => (s.created_at||'').startsWith(m));
  const total = shown.reduce((a,s)=>a+s.amount,0);
  return `
  <div class="page-head"><div><h2>Lịch sử trả</h2>
    <p>${shown.length} lần thanh toán · tổng ${vnd(total)}. Lịch sử không bị xóa.</p></div></div>
  <div class="toolbar"><div class="chips">
    <button class="chip ${m==='ALL'?'on':''}" onclick="uiFilter.month='ALL';render()">Tất cả</button>
    ${months.map(x=>`<button class="chip ${m===x?'on':''}" onclick="uiFilter.month='${x}';render()">${x}</button>`).join('')}
  </div></div>
  <div class="panel">${shown.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Thời gian</th><th>Từ</th><th>Đến</th><th>Số tiền</th><th>Cho giao dịch</th></tr></thead>
    <tbody>${shown.map(s=>{
      const t = Data.txns.find(x=>x.id===s.transaction_id);
      return `<tr><td class="meta num">${fmtDT(s.created_at)}</td><td>${esc(nameOf(s.from_user))}</td>
      <td>${esc(nameOf(s.to_user))}</td><td class="num">${vnd(s.amount)}</td>
      <td class="meta">${t?esc(t.title):'—'}${s.note?` · ${esc(s.note)}`:''}</td></tr>`;}).join('')}
    </tbody></table></div>`
    : `<div class="empty"><b>Chưa có lần thanh toán nào</b>Khi ai đó trả nợ, nó sẽ được ghi lại ở đây.</div>`}</div>`;
}

/* ---- activity ---- */
const ACT_VI = {CREATE:'tạo',EDIT:'sửa',DELETE:'xóa',MARK_PAID:'xác nhận trả',SETTLEMENT:'cân nợ',LOGIN:'đăng nhập',LOGOUT:'đăng xuất'};
function vActivity(){
  let list = [...Data.activity].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  if (!isAdmin()) list = list.filter(a => a.user_id === me.username);
  return `
  <div class="page-head"><div><h2>Nhật ký hoạt động</h2>
    <p>${isAdmin()?'Toàn bộ hoạt động của cả hai người.':'Hoạt động của bạn.'}</p></div></div>
  <div class="panel"><div class="body">${list.length ? list.slice(0,200).map(a=>`
    <div class="log"><time>${fmtDT(a.created_at)}</time>
    <div><b>${esc(nameOf(a.user_id))}</b> ${ACT_VI[a.action]||esc(a.action)}
    ${a.metadata&&a.metadata.title?` “${esc(a.metadata.title)}”`:''}
    ${a.metadata&&a.metadata.amount?` · ${vnd(a.metadata.amount)}`:''}</div></div>`).join('')
    : `<div class="empty"><b>Chưa có hoạt động</b>Mọi thao tác quan trọng sẽ xuất hiện ở đây.</div>`}</div></div>`;
}

/* ---- settings ---- */
function vSettings(){
  return `
  <div class="page-head"><div><h2>Cài đặt</h2><p>Tài khoản và phiên đăng nhập.</p></div></div>
  <div class="split" style="align-items:start">
    <div class="panel"><h3>Tài khoản</h3><div class="body">
      <div class="kv"><span>Tên đăng nhập</span><b>${esc(me.username)}</b></div>
      <div class="kv"><span>Tên hiển thị</span><b>${esc(nameOf(me.username))}</b></div>
      <div class="kv"><span>Vai trò</span><b>${esc(me.role)}</b></div>
      <p class="hint">Tên đăng nhập và vai trò do hệ thống quản lý, không tự đổi được.</p>
    </div></div>
    <div class="panel"><h3>Bảo mật</h3><div class="body">
      <div class="field"><label for="pw1">Mật khẩu hiện tại</label><input class="input" id="pw1" type="password"></div>
      <div class="field"><label for="pw2">Mật khẩu mới</label><input class="input" id="pw2" type="password"></div>
      <div id="pw_err"></div>
      <button class="btn primary" onclick="changePw()">Đổi mật khẩu</button>
      <p class="hint">Bản prototype lưu mật khẩu dưới dạng hash trong cơ sở dữ liệu của ứng dụng.
      Khi triển khai thật, dùng Supabase Auth thay cho khối này.</p>
    </div></div>
  </div>
  <section class="section panel"><h3>Phiên</h3><div class="body">
    <button class="btn danger" onclick="logout()">Đăng xuất</button></div></section>`;
}
async function changePw(){
  const cur = el('pw1').value, next = el('pw2').value;
  if (next.length < 1) return el('pw_err').innerHTML = `<div class="err">Mật khẩu mới không được để trống.</div>`;
  const ok = await checkLogin(me.username, cur);
  if (!ok) return el('pw_err').innerHTML = `<div class="err">Mật khẩu hiện tại không đúng.</div>`;
  const creds = await credsDoc();
  creds[me.username] = await sha(next);
  await saveCreds(creds);
  el('pw_err').innerHTML = ''; el('pw1').value=''; el('pw2').value='';
  toast('Đã đổi mật khẩu');
}

/* ---- admin ---- */
function vAdmin(){
  if (!isAdmin()) return `<div class="panel"><div class="empty"><b>Trang chỉ dành cho quản trị viên</b>
    Tài khoản của bạn không có quyền truy cập.</div></div>`;
  const b = balanceText();
  const openN = Data.txns.filter(t=>statusOf(t)==='OPEN').length;
  const partN = Data.txns.filter(t=>statusOf(t)==='PARTIALLY_SETTLED').length;
  const doneN = Data.txns.filter(t=>statusOf(t)==='SETTLED').length;
  const vol = Data.txns.reduce((a,t)=>a+t.amount,0);
  const recent = [...Data.activity].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).slice(0,10);
  return `
  <div class="page-head"><div><h2>Quản trị</h2><p>Toàn cảnh dữ liệu hệ thống.</p></div></div>
  <div class="grid cards">
    ${stat('Tổng giao dịch', Data.txns.length)}
    ${stat('Tổng giá trị', vnd(vol))}
    ${stat('Chưa trả', openN, 'debit')}
    ${stat('Trả một phần', partN)}
    ${stat('Đã xong', doneN, 'credit')}
    ${stat('Số dư ròng', vnd(b.amount))}
  </div>
  <section class="section panel"><h3>Số dư hiện tại</h3><div class="body">
    ${b.amount ? `${esc(b.text)} <b class="num">${vnd(b.amount)}</b>` : 'Hai bên đã cân bằng.'}</div></section>
  <section class="section panel"><h3>Hoạt động gần đây</h3><div class="body">
    ${recent.map(a=>`<div class="log"><time>${fmtDT(a.created_at)}</time>
      <div><b>${esc(nameOf(a.user_id))}</b> ${ACT_VI[a.action]||esc(a.action)}
      ${a.metadata&&a.metadata.title?` “${esc(a.metadata.title)}”`:''}</div></div>`).join('')
      || `<div class="empty">Chưa có hoạt động.</div>`}</div></section>
  <section class="section panel"><h3>Tất cả giao dịch</h3>
    ${Data.txns.length?`<div class="tbl-wrap">${txnTable(sortedTxns())}</div>`:`<div class="empty">Chưa có dữ liệu.</div>`}</section>`;
}

/* ---- delete ---- */
function confirmDelete(id){
  const t = Data.txns.find(x=>x.id===id); if (!t) return;
  if (!canDelete(t)) return toast('Bạn không được xóa giao dịch của người khác');
  modal(`<header><h3>Xóa giao dịch?</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body"><p style="margin-top:0"><b>${esc(t.title)}</b><br>
  <span class="num" style="font-size:20px">${vnd(t.amount)}</span></p>
  <p style="color:var(--muted)">Không thể hoàn tác. Các khoản đã hoàn trả cho giao dịch này vẫn nằm trong lịch sử.</p></div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn danger" onclick="doDelete('${id}')">Xóa</button></footer>`);
}
async function doDelete(id){
  const t = Data.txns.find(x=>x.id===id);
  if (!t || !canDelete(t)) return toast('Không có quyền');
  await Store.del('txns', id);
  await log('DELETE','transaction',id,{title:t.title, amount:t.amount});
  closeModal(); toast('Đã xóa giao dịch'); go('transactions');
}

/* ---- modal ---- */
function modal(html){
  el('modalRoot').innerHTML = `<div class="scrim" onclick="if(event.target===this)closeModal()">
    <div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
}
function closeModal(){ el('modalRoot').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---- routing ---- */
function go(path, param){ location.hash = '#/' + path + (param?'/'+param:''); }
function parseHash(){
  const parts = (location.hash.replace(/^#\/?/,'').split('/').filter(Boolean));
  if (!parts.length) return { path:'dashboard', param:null };
  if (parts[0] === 'transactions' && parts[1]) return { path:'detail', param:parts[1] };
  if (parts[0] === 'new') return { path:'new', param:parts[1]||null };
  return { path:parts[0], param:parts[1]||null };
}
window.addEventListener('hashchange', () => {
  if (!me) return;
  route = parseHash();
  closeModal();
  window.scrollTo(0,0);
  render();
});

/* ---- boot ---- */
async function startApp(user){
  me = user; saveSession(user.username);
  el('loginView').style.display = 'none';
  el('appView').classList.add('on');
  route = parseHash();
  render();
  ['txns','settlements','activity'].forEach(col => {
    Store.watch(col, rows => { Data[col] = rows; render(); });
  });
}

el('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = el('loginBtn');
  btn.disabled = true; btn.textContent = 'Đang kiểm tra…';
  el('loginErr').innerHTML = '';
  const user = await checkLogin(el('u').value, el('p').value);
  btn.disabled = false; btn.textContent = 'Đăng nhập';
  if (!user){ el('loginErr').innerHTML = `<div class="err">Invalid username or password.</div>`; return; }
  await startApp(user);
  log('LOGIN','session',user.username,{}).catch(()=>{});
});

(async () => {
  await Store.init();
  if (!Store.db) Data.reload();
  const s = readSession();
  if (s) startApp(s);
})();
