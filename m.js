/* =========================================================================
   Sổ chung — ứng dụng chia đôi chi tiêu cho đúng hai người.
   Mọi số tiền là số nguyên VND. Không dùng float cho tiền.
   Lưu trữ: capability `db` của artifact nếu có (môi trường Claude);
   nếu không thì dùng Firebase Realtime Database (window.FIREBASE_STORE,
   khởi tạo trong index.html) — chia sẻ dữ liệu thật giữa Duy & Nguyen;
   nếu cả hai đều không có thì mới rơi về localStorage (chỉ máy hiện tại).
   ========================================================================= */

// PEOPLE: fallback cứng chỉ dùng khi chưa có dữ liệu `users` nào tải về
// (ví dụ ngay sau khi đăng nhập, trước khi snapshot đầu tiên tới) và cho
// logic chia tiền 2-người hiện tại (other()/split()) — phần này sẽ được
// thay bằng mô hình pairwise ở mục 2 của spec, chưa đổi trong bản này.
const PEOPLE = {
  duy:    { username:'duy',    name:'Duy',    role:'ADMIN' },
  nguyen: { username:'nguyen', name:'Nguyen', role:'USER'  },
};
const CATEGORIES = ['Food','Drinks','Transport','Entertainment','Shopping','Bills','Other'];
const CAT_VI = {Food:'Ăn uống',Drinks:'Đồ uống',Transport:'Di chuyển',Entertainment:'Giải trí',Shopping:'Mua sắm',Bills:'Hóa đơn',Other:'Khác'};

/* ---------------- money ---------------- */
const vnd = n => new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫';
// other(u): trong 1 sổ chung (1 cặp bạn bè), trả về người còn lại của cặp
// đang mở (`peer`). Khi chưa có sổ nào đang mở, rơi về mặc định duy/nguyen
// để không phá logic cũ trong lúc chưa đăng nhập / chưa chọn sổ.
// other(u): ai là người còn lại của u trong SỔ ĐANG MỞ (currentPairId) —
// dùng cho các form/preview đang thao tác trên sổ hiện tại (luôn có peer).
const other = u => {
  if (peer && (u === me?.username || u === peer)) return u === me.username ? peer : me.username;
  return u === 'duy' ? 'nguyen' : 'duy';
};
// otherOf(u, pairId): giống other() nhưng suy ra cặp trực tiếp từ pair_id của
// MỘT giao dịch cụ thể — dùng cho mọi phép tính tiền để luôn đúng dù đang
// xem giao dịch của cặp khác (vd. trang Quản trị xem toàn hệ thống).
function otherOf(u, pairId){
  const [a,b] = (pairId||'duy_nguyen').split('_');
  return u === a ? b : a;
}
const nameOf = u => (Data.usersById[u]||{}).name || (PEOPLE[u]||{}).name || u;
// Quy tắc chia: người ứng tiền nhận phần lẻ (ceil), người còn lại floor.
// Tổng hai phần luôn = tổng giao dịch, không mất đồng nào.
function split(amount, paidBy, pairId){
  const a = Math.trunc(amount);
  const payer = Math.ceil(a/2), rest = a - payer;
  return { [paidBy]: payer, [otherOf(paidBy, pairId)]: rest };
}
const owedOf = t => split(t.amount, t.paid_by, pairIdOf(t))[otherOf(t.paid_by, pairIdOf(t))];       // nợ gốc
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
  db:null, local:{txns:{},settlements:{},activity:{},config:{},users:{},friendships:{},messages:{}},
  async init(){
    try { this.db = await claude.use('db'); } catch(e){ this.db = null; }
    if (!this.db && window.FIREBASE_STORE) this.db = window.FIREBASE_STORE;
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
const Data = { txns:[], settlements:[], activity:[], users:[], usersById:{}, friendships:[], messages:[], config:{}, ready:false };
let me = null;
let mustChangePw = false;
let peer = null;              // username của bạn đang mở sổ chung cùng (1 cặp = 1 sổ)
let chatOpen = false;
let chatThread = null;        // username đang mở hội thoại cùng trong khung chat
let route = { path:'dashboard', param:null };
let uiFilter = { status:'ALL', q:'', sort:'new' };

function applyUsers(rows){
  Data.users = rows;
  Data.usersById = Object.fromEntries(rows.map(r => [r.id, r]));
}

function reload(){ Data.reload(); }
Data.reload = () => {
  if (!Store.db){
    ['txns','settlements','activity'].forEach(c => {
      Data[c] = Object.entries(Store.local[c]||{}).map(([id,v])=>({id,...v}));
    });
    applyUsers(Object.entries(Store.local.users||{}).map(([id,v])=>({id,...v})));
    Data.friendships = Object.entries(Store.local.friendships||{}).map(([id,v])=>({id,...v}));
    Data.messages = Object.entries(Store.local.messages||{}).map(([id,v])=>({id,...v}));
    Data.config = Store.local.config || {};
  }
  render();
};

/* ---------------- pairwise sổ chung ---------------- */
// pair_id = 2 username sort alphabet, nối bằng '_' (vd "duy_nguyen").
// Giao dịch/settlement cũ chưa có field này mặc định coi là của cặp duy-nguyen.
function makePairId(a,b){ return [a,b].sort().join('_'); }
const pairIdOf = t => t.pair_id || 'duy_nguyen';
const currentPairId = () => peer ? makePairId(me.username, peer) : null;
const myTxns = () => { const p = currentPairId(); return p ? Data.txns.filter(t => pairIdOf(t) === p) : []; };
const mySettlements = () => { const p = currentPairId(); return p ? Data.settlements.filter(s => pairIdOf(s) === p) : []; };
function acceptedFriends(){
  if (!me) return [];
  return Data.friendships.filter(f => f.status==='ACCEPTED' && (f.user_a===me.username||f.user_b===me.username))
    .map(f => f.user_a===me.username ? f.user_b : f.user_a);
}
function pendingIncoming(){
  if (!me) return [];
  return Data.friendships.filter(f => f.status==='PENDING' && f.requested_by!==me.username &&
    (f.user_a===me.username||f.user_b===me.username));
}
function pendingOutgoing(){
  if (!me) return [];
  return Data.friendships.filter(f => f.status==='PENDING' && f.requested_by===me.username);
}
function savePeer(u){ try{ localStorage.setItem('sochung.peer.'+me.username, u||''); }catch(e){} }
function loadPeer(){ try{ return localStorage.getItem('sochung.peer.'+me.username) || null; }catch(e){ return null; } }
function switchPeer(u){ peer = u; savePeer(u); go('dashboard'); route = {path:'dashboard',param:null}; render(); }
function maybeAutoSelectPeer(){
  if (!me) return;
  const fr = acceptedFriends();
  if (peer && !fr.includes(peer)) peer = null;      // bạn cũ không còn ACCEPTED nữa
  if (!peer){
    const stored = loadPeer();
    if (stored && fr.includes(stored)) peer = stored;
    else if (fr.length === 1) peer = fr[0];
  }
}

/* ---------------- nhắn tin (chỉ giữa bạn bè ACCEPTED) ---------------- */
function threadMessages(u){
  const tid = makePairId(me.username, u);
  return Data.messages.filter(m => m.thread_id === tid)
    .sort((a,b) => (a.created_at||'').localeCompare(b.created_at||''));
}
function unreadCount(u){
  const tid = makePairId(me.username, u);
  return Data.messages.filter(m => m.thread_id===tid && m.to===me.username && !m.read).length;
}
function totalUnread(){ return acceptedFriends().reduce((a,u)=>a+unreadCount(u),0); }
async function markThreadRead(u){
  const tid = makePairId(me.username, u);
  const unread = Data.messages.filter(m => m.thread_id===tid && m.to===me.username && !m.read);
  for (const m of unread){
    const body = {...m}; delete body.id;
    await Store.set('messages', m.id, { ...body, read:true });
  }
}
function openChat(){
  chatOpen = true;
  const fr = acceptedFriends();
  if (!chatThread && fr.length === 1) chatThread = fr[0];
  if (chatThread) markThreadRead(chatThread);
  renderChat();
}
function closeChat(){ chatOpen = false; chatThread = null; renderChat(); }
function backToThreads(){ chatThread = null; renderChat(); }
function openThread(u){ chatThread = u; markThreadRead(u); renderChat(); }
async function sendMessage(){
  const box = el('chatText'); if (!box) return;
  const text = box.value.trim();
  if (!text || !chatThread) return;
  if (!acceptedFriends().includes(chatThread)) return toast('Chỉ nhắn tin được với bạn bè');
  const tid = makePairId(me.username, chatThread);
  box.value = ''; box.style.height = '';
  await Store.set('messages', rid(),
    { thread_id:tid, from:me.username, to:chatThread, text, created_at:now(), read:false });
}
function renderChat(){
  const root = el('chatRoot');
  if (!root || !me) return;
  if (!chatOpen){ if (root.innerHTML) root.innerHTML = ''; return; }
  const draft = el('chatText') ? el('chatText').value : '';
  const friends = acceptedFriends();
  if (chatThread && !friends.includes(chatThread)) chatThread = null;
  let body;
  if (chatThread){
    const msgs = threadMessages(chatThread);
    const unread = msgs.filter(m => m.to===me.username && !m.read);
    if (unread.length) markThreadRead(chatThread);
    body = `
    <div class="chat-head">
      ${friends.length>1?`<button class="chat-back" onclick="backToThreads()">←</button>`:''}
      <h3>${esc(nameOf(chatThread))}</h3>
      <button class="x" onclick="closeChat()">✕</button>
    </div>
    <div class="chat-msgs" id="chatMsgs">${msgs.length ? msgs.map(m=>`
      <div class="bubble ${m.from===me.username?'me':'them'}">${esc(m.text)}<span class="b-time">${fmtDT(m.created_at)}</span></div>
    `).join('') : `<div class="empty" style="padding:30px 10px"><b>Chưa có tin nhắn</b>Gửi lời chào đầu tiên.</div>`}</div>
    <div class="chat-input">
      <textarea class="input" id="chatText" rows="1" placeholder="Nhắn tin…"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
      <button class="btn primary sm" onclick="sendMessage()">Gửi</button>
    </div>`;
  } else if (!friends.length){
    body = `<div class="chat-head"><h3>Tin nhắn</h3><button class="x" onclick="closeChat()">✕</button></div>
    <div class="empty" style="padding:40px 16px"><b>Chưa có bạn bè</b>Kết bạn để bắt đầu nhắn tin.
      <div style="margin-top:12px"><a class="btn sm primary" href="#/friends" onclick="closeChat()">Đi tới Kết bạn</a></div></div>`;
  } else {
    body = `<div class="chat-head"><h3>Tin nhắn</h3><button class="x" onclick="closeChat()">✕</button></div>
    <div class="chat-threads">${friends.map(u=>{
      const msgs = threadMessages(u); const last = msgs[msgs.length-1]; const unread = unreadCount(u);
      return `<div class="chat-thread" onclick="openThread('${u}')">
        <span class="avatar">${esc(nameOf(u)[0])}</span>
        <div style="flex:1;min-width:0"><div class="t-name">${esc(nameOf(u))}</div>
        <div class="t-prev">${last?esc(last.text):'Chưa có tin nhắn'}</div></div>
        ${unread?`<span class="badge">${unread}</span>`:''}
      </div>`; }).join('')}</div>`;
  }
  root.innerHTML = `<div class="chat-scrim on" onclick="closeChat()"></div><div class="chat-drawer on">${body}</div>`;
  const box = el('chatMsgs'); if (box) box.scrollTop = box.scrollHeight;
  const ta = el('chatText'); if (ta && draft){ ta.value = draft; }
}

/* ---------------- derived ---------------- */
const sortedList = list => [...list].sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.created_at||'').localeCompare(a.created_at||''));
const sortedTxns = () => sortedList(Data.txns);        // dùng cho Quản trị (toàn hệ thống)
const sortedMyTxns = () => sortedList(myTxns());       // dùng cho các trang của người dùng (chỉ sổ đang mở)

// Net balance trong sổ đang mở: dương = peer nợ tôi; âm = tôi nợ peer.
function netBalance(){
  let net = 0;
  for (const t of myTxns()){
    const r = remainOf(t);
    net += (t.paid_by === me.username) ? r : -r;
  }
  return net;
}
function balanceText(){
  const n = netBalance();
  if (n === 0) return { debtor:null, creditor:null, amount:0, text:'Đã cân bằng' };
  const debtor = n > 0 ? peer : me.username;
  return { debtor, creditor:other(debtor), amount:Math.abs(n),
           text:`${nameOf(debtor)} nợ ${nameOf(other(debtor))}` };
}
function myStats(){
  let paid=0, share=0, total=0, iOwe=0, owedMe=0;
  const list = myTxns();
  for (const t of list){
    total += t.amount;
    const s = split(t.amount, t.paid_by, pairIdOf(t));
    share += s[me.username];
    if (t.paid_by === me.username){ paid += t.amount; owedMe += remainOf(t); }
    else iOwe += remainOf(t);
  }
  return { count:list.length, total, paid, share, iOwe, owedMe };
}

/* ---------------- permissions (mirror của RLS ở backend) ---------------- */
const isAdmin = () => me && me.role === 'ADMIN';
const canEdit = t => isAdmin() || t.created_by === me.username;
const canDelete = t => isAdmin() || t.created_by === me.username;
// Người còn nợ (hoặc admin) mới được xác nhận trả.
const canMarkPaid = t => remainOf(t) > 0 && (isAdmin() || otherOf(t.paid_by, pairIdOf(t)) === me.username);

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

/* ---- users (collection `users/{username}`, thay cho object PEOPLE cứng) ---- */
async function getUserDoc(username){
  const u = (username||'').trim().toLowerCase();
  if (!u) return null;
  if (Store.db){
    const d = await Store.db.doc('users/'+u).get();
    return d.exists ? { id:u, ...d.data } : null;
  }
  const rec = (Store.local.users||{})[u];
  return rec ? { id:u, ...rec } : null;
}
// Đảm bảo 2 tài khoản cũ (Duy/Nguyen) luôn tồn tại trong `users`, để dữ liệu
// hiện có không bị vỡ khi hệ thống chuyển từ PEOPLE cứng sang collection động.
async function ensureLegacyUsers(){
  const legacy = [
    { username:'duy',    name:'Duy',    role:'ADMIN' },
    { username:'nguyen', name:'Nguyen', role:'USER'  },
  ];
  for (const u of legacy){
    const existing = await getUserDoc(u.username);
    if (!existing){
      await Store.set('users', u.username,
        { username:u.username, name:u.name, role:u.role,
          created_by:'system', created_at:now(), must_change_pw:false });
    }
  }
}

/* ---- friendships (collection `friendships/{a_b}`) ---- */
async function getFriendshipDoc(id){
  if (Store.db){
    const d = await Store.db.doc('friendships/'+id).get();
    return d.exists ? { id, ...d.data } : null;
  }
  const rec = (Store.local.friendships||{})[id];
  return rec ? { id, ...rec } : null;
}
// Duy & Nguyen coi như đã là bạn bè từ đầu — không bắt họ kết bạn lại.
async function ensureLegacyFriendship(){
  const id = makePairId('duy','nguyen');
  const existing = await getFriendshipDoc(id);
  if (!existing){
    await Store.set('friendships', id,
      { user_a:'duy', user_b:'nguyen', status:'ACCEPTED', requested_by:'system', created_at:now() });
  }
}
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
  const user = await getUserDoc(u);
  if (!user) return null;
  let creds = await credsDoc();
  if (!creds){ const d = await sha(DEFAULT_PW); creds = { duy:d, nguyen:d }; await saveCreds(creds); }
  const h = await sha(password||'');
  return creds[u] === h ? user : null;
}

/* ---------------- session ---------------- */
const SESS = 'sochung.session';
function saveSession(u){ try{ localStorage.setItem(SESS, JSON.stringify({u, at:Date.now()})); }catch(e){} }
function readSession(){
  try{
    const s = JSON.parse(localStorage.getItem(SESS)||'null');
    if (!s) return null;
    if (Date.now() - s.at > 1000*60*60*24*14) return null;   // hết hạn sau 14 ngày
    return s;   // {u, at} — caller tự tải lại user doc mới nhất từ `users/{u}`
  }catch(e){ return null; }
}
function logout(){
  log('LOGOUT','session',me.username,{}).catch(()=>{});
  localStorage.removeItem(SESS); me = null; mustChangePw = false; peer = null;
  chatOpen = false; chatThread = null;
  document.getElementById('appView').classList.remove('on');
  document.getElementById('loginView').style.display = '';
  const cr = document.getElementById('chatRoot'); if (cr) cr.innerHTML = '';
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
  {p:'friends',     t:'Kết bạn',     m:'Kết bạn'},
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
  const b = peer ? balanceText() : null;
  el('sideBal').textContent = !peer ? 'Chưa có sổ chung'
    : (b.amount ? b.text + ' ' + vnd(b.amount) : 'Đã cân bằng');
  el('meAv').textContent = nameOf(me.username)[0];
  el('meName').textContent = nameOf(me.username);
  el('meRole').textContent = me.role === 'ADMIN' ? 'Quản trị viên' : 'Thành viên';

  const unpaid = myTxns().filter(t => t.paid_by !== me.username && remainOf(t) > 0).length;
  const friendReq = pendingIncoming().length;
  el('nav').innerHTML = NAV.filter(n=>!n.admin||isAdmin()).map(n =>
    `<a href="#/${n.p}" class="${route.path===n.p?'active':''}">${esc(n.t)}${
      n.p==='transactions'&&unpaid?`<span class="badge">${unpaid}</span>`:''}${
      n.p==='friends'&&friendReq?`<span class="badge">${friendReq}</span>`:''}</a>`).join('');
  el('mnav').innerHTML = NAV.filter(n=>n.m && (!n.admin||isAdmin())).map(n =>
    `<a href="#/${n.p}" class="${route.path===n.p?'active':''}">${esc(n.m)}${
      n.p==='friends'&&friendReq?`<span class="badge">${friendReq}</span>`:''}</a>`).join('');

  const chatUnread = totalUnread();
  [el('chatBadge'), el('chatBadgeFab')].forEach(b => {
    if (!b) return;
    b.style.display = chatUnread ? '' : 'none';
    b.textContent = chatUnread;
  });
  renderChat();

  if (mustChangePw){
    el('main').innerHTML = vForceChangePw();
    return;
  }

  const fn = ({dashboard:vDashboard,friends:vFriends,transactions:vTransactions,detail:vDetail,new:vNew,
               settlements:vSettlements,history:vHistory,activity:vActivity,
               settings:vSettings,admin:vAdmin})[route.path] || vDashboard;
  el('main').innerHTML = fn();
  if (route.path === 'new') bindForm();
}

// Khi có nhiều hơn 1 người bạn, hiện thanh chọn sổ chung đang mở.
function peerBar(){
  const friends = acceptedFriends();
  if (friends.length <= 1) return '';
  return `<div class="toolbar" style="margin-bottom:14px">
    <span class="meta">Sổ đang mở</span>
    <div class="chips">${friends.map(u=>
      `<button class="chip ${u===peer?'on':''}" onclick="switchPeer('${u}')">${esc(nameOf(u))}</button>`).join('')}</div>
  </div>`;
}
function noPeerView(title, desc){
  return `
  <div class="page-head"><div><h2>${esc(title)}</h2></div></div>
  <div class="panel"><div class="empty"><b>Chưa có sổ chung nào</b>${esc(desc||'Kết bạn với ai đó để bắt đầu ghi chi tiêu chung.')}
    <div style="margin-top:12px"><a class="btn primary" href="#/friends">Đi tới Kết bạn</a></div></div></div>`;
}

/* ---- dashboard ---- */
function vDashboard(){
  if (!peer) return noPeerView('Tổng quan');
  const b = balanceText(), s = myStats();
  const meOwes = b.debtor === me.username;
  const cls = b.amount === 0 ? '' : (meOwes ? 'debit' : 'credit');
  const line = b.amount === 0 ? 'Hai bên không nợ nhau'
    : meOwes ? `Bạn đang nợ ${nameOf(b.creditor)}` : `${nameOf(b.debtor)} đang nợ bạn`;
  const recent = sortedMyTxns().slice(0,5);
  const unpaid = myTxns().filter(t => t.paid_by !== me.username && remainOf(t) > 0);

  return `
  <div class="page-head">
    <div><h2>Xin chào, ${esc(nameOf(me.username))}</h2>
    <p>Sổ chung với ${esc(nameOf(peer))}. Mọi giao dịch được chia đôi tự động.</p></div>
    <div class="actions">
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>
    </div>
  </div>
  ${peerBar()}

  ${unpaid.length ? `<div class="notice">
      <span>Bạn có ${unpaid.length} khoản chưa trả, tổng ${vnd(unpaid.reduce((a,t)=>a+remainOf(t),0))}.</span>
      <a class="btn sm" href="#/settlements">Cân nợ ngay</a></div>` : ''}

  <section class="hero">
    <p class="who-line">${esc(line)}</p>
    <p class="amount ${cls}">${vnd(b.amount)}</p>
    <p class="sub">${s.count} giao dịch · tổng chi ${vnd(s.total)} · quy tắc chia 50/50</p>
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
    const s = split(t.amount, t.paid_by, pairIdOf(t)), st = statusOf(t), rem = remainOf(t);
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
  if (!peer) return noPeerView('Giao dịch');
  let list = sortedMyTxns();
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
    <div><h2>Giao dịch</h2><p>Sổ với ${esc(nameOf(peer))} · ${myTxns().length} khoản đã ghi</p></div>
    <div class="actions">
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>
    </div>
  </div>
  ${peerBar()}
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
  if (!t || (!isAdmin() && pairIdOf(t) !== currentPairId()))
    return `<div class="panel"><div class="empty"><b>Không tìm thấy giao dịch</b>
    <a class="btn sm" href="#/transactions">Quay lại danh sách</a></div></div>`;
  const s = split(t.amount, t.paid_by, pairIdOf(t)), st = statusOf(t), rem = remainOf(t);
  const debtor = otherOf(t.paid_by, pairIdOf(t));
  const paidAmt = u => u === t.paid_by ? t.amount : (t.repaid||0);
  const card = u => `<div class="person">
      <h4><span class="avatar">${esc(nameOf(u)[0])}</span>${esc(nameOf(u))}${u===t.paid_by?' · người ứng tiền':''}</h4>
      <div class="kv"><span>Đã trả ngoài đời</span><b>${vnd(paidAmt(u))}</b></div>
      <div class="kv"><span>Phần phải chịu</span><b>${vnd(s[u])}</b></div>
      <div class="kv"><span>Chênh lệch</span><b style="color:var(--${paidAmt(u)-s[u]>=0?'credit':'debit'})">${
        (paidAmt(u)-s[u]>=0?'+':'') + vnd(paidAmt(u)-s[u])}</b></div>
    </div>`;

  const [pa, pb] = pairIdOf(t).split('_');
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

  <div class="split" style="margin-top:12px">${card(pa)}${card(pb)}</div>

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
  if (t && !isAdmin() && pairIdOf(t) !== currentPairId())
    return `<div class="panel"><div class="empty"><b>Giao dịch này không thuộc sổ đang mở</b></div></div>`;
  if (!t && !peer) return noPeerView('Giao dịch mới');
  const pid = t ? pairIdOf(t) : currentPairId();
  const [pa, pb] = pid.split('_');
  return `
  <div class="page-head"><div>
    <h2>${t?'Sửa giao dịch':'Giao dịch mới'}</h2>
    <p>Nhập số tiền, chọn người đã trả — phần chia được tính ngay bên dưới.</p></div></div>
  <div class="split" style="align-items:start">
    <div class="panel"><div class="body">
      <input type="hidden" id="f_pair" value="${pid}">
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
          <select class="input" id="f_paid">${[pa, pb].map(u=>
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
  const pid = el('f_pair').value;
  const box = el('preview');
  if (!amt){ box.innerHTML = `<div class="preview"><div class="row"><span>Nhập số tiền để xem phần chia</span></div></div>`; return; }
  const s = split(amt, paid, pid);
  const mine = s[me.username], theirs = s[otherOf(me.username, pid)];
  const iPaid = paid === me.username;
  const line = iPaid ? `${nameOf(otherOf(me.username, pid))} sẽ nợ bạn` : `Bạn sẽ nợ ${nameOf(paid)}`;
  const amtOwed = iPaid ? theirs : mine;
  box.innerHTML = `<div class="preview">
    <div class="row"><span>Tổng</span><b>${vnd(amt)}</b></div>
    <div class="row"><span>Phần của bạn</span><b>${vnd(mine)}</b></div>
    <div class="row"><span>Phần của ${esc(nameOf(otherOf(me.username, pid)))}</span><b>${vnd(theirs)}</b></div>
    <div class="row"><span>Người ứng tiền</span><b>${esc(nameOf(paid))}</b></div>
    <div class="out"><div class="row"><span>${esc(line)}</span>
      <b style="color:var(--${iPaid?'credit':'debit'})">${vnd(amtOwed)}</b></div></div>
  </div>`;
}
async function submitTxn(id){
  const title = el('f_title').value.trim();
  const amount = parseAmount(el('f_amount').value);
  const paid_by = el('f_paid').value, date = el('f_date').value || todayISO();
  const pid = el('f_pair').value;
  const [pa, pb] = pid.split('_');
  const errs = [];
  if (!title) errs.push('Cần nhập nội dung.');
  if (!amount || amount <= 0) errs.push('Số tiền phải lớn hơn 0.');
  if (paid_by !== pa && paid_by !== pb) errs.push('Người trả không hợp lệ.');
  if (errs.length){ el('f_err').innerHTML = `<div class="err">${errs.join(' ')}</div>`; return; }

  if (id){
    const t = Data.txns.find(x=>x.id===id);
    if (!t || !canEdit(t)) return toast('Bạn không có quyền sửa giao dịch này');
    const old = {...t};
    const repaid = Math.min(t.repaid||0, split(amount, paid_by, pid)[otherOf(paid_by, pid)]);
    await Store.set('txns', id, { title, category:el('f_cat').value, amount, paid_by,
      pair_id:pid, created_by:t.created_by, date, note:el('f_note').value.trim(), repaid,
      created_at:t.created_at, updated_at:now(), edited_at:now(), edited_by:me.username });
    await log('EDIT','transaction',id,{title, from:old.amount, to:amount});
    toast('Đã lưu thay đổi'); go('transactions/'+id);
  } else {
    const nid = rid();
    await Store.set('txns', nid, { title, category:el('f_cat').value, amount, paid_by,
      pair_id:pid, created_by:me.username, date, note:el('f_note').value.trim(), repaid:0,
      created_at:now(), updated_at:now() });
    await log('CREATE','transaction',nid,{title, amount});
    toast('Đã thêm giao dịch'); go('transactions/'+nid);
  }
}

/* ---- quick add ---- */
function openQuickAdd(){
  if (!peer) return toast('Kết bạn để bắt đầu ghi chi tiêu chung');
  modal(`<header><h3>Ghi nhanh</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="q_title">Chi gì?</label>
      <input class="input" id="q_title" placeholder="Ăn sáng" autofocus></div>
    <div class="two">
      <div class="field"><label for="q_amount">Bao nhiêu?</label>
        <input class="input num" id="q_amount" inputmode="numeric" placeholder="50000"></div>
      <div class="field"><label for="q_paid">Ai trả?</label>
        <select class="input" id="q_paid">${[me.username, peer].map(u=>
          `<option value="${u}" ${me.username===u?'selected':''}>${nameOf(u)}</option>`).join('')}</select></div>
    </div>
    <div id="q_prev"></div><div id="q_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="quickSubmit()">Thêm giao dịch</button></footer>`);
  const upd = () => {
    const a = parseAmount(el('q_amount').value), p = el('q_paid').value;
    el('q_prev').innerHTML = a ? `<div class="preview"><div class="row"><span>Mỗi người</span>
      <b>${vnd(split(a,p,currentPairId())[me.username])}</b></div><div class="row"><span>${
      p===me.username ? esc(nameOf(other(me.username)))+' nợ bạn' : 'Bạn nợ '+esc(nameOf(p))}</span>
      <b>${vnd(split(a,p,currentPairId())[other(p)])}</b></div></div>` : '';
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
  await Store.set('txns', nid, { title, category:'Other', amount, paid_by, pair_id:currentPairId(),
    created_by:me.username, date:todayISO(), note:'', repaid:0, created_at:now(), updated_at:now() });
  await log('CREATE','transaction',nid,{title, amount});
  closeModal(); toast(`Đã thêm · ${vnd(split(amount,paid_by,currentPairId())[other(paid_by)])} còn nợ`);
}

/* ---- pay / settle ---- */
async function payTxn(t, amount, note){
  const rem = remainOf(t);
  const pay = Math.min(Math.trunc(amount), rem);
  if (pay <= 0) return 0;
  const body = {...t}; delete body.id;
  await Store.set('txns', t.id, { ...body, repaid:(t.repaid||0)+pay, updated_at:now() });
  await Store.set('settlements', rid(), { from_user:otherOf(t.paid_by, pairIdOf(t)), to_user:t.paid_by,
    pair_id:pairIdOf(t), amount:pay, transaction_id:t.id, note:note||'', created_at:now(), created_by:me.username });
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
  if (!peer) return noPeerView('Cân nợ');
  const b = balanceText();
  const open = sortedMyTxns().filter(t => remainOf(t) > 0);
  return `
  <div class="page-head"><div><h2>Cân nợ</h2>
    <p>Trả một lần cho toàn bộ số dư giữa bạn và ${esc(nameOf(peer))}.</p></div></div>
  ${peerBar()}
  <section class="hero">
    <p class="who-line">${esc(nameOf(me.username))} ↔ ${esc(nameOf(peer))}</p>
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
  // trừ dần từ giao dịch cũ nhất mà bên nợ còn thiếu, trong sổ đang mở
  const targets = myTxns()
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
  if (!peer) return noPeerView('Lịch sử trả');
  const list = [...mySettlements()].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  const months = [...new Set(list.map(s=>(s.created_at||'').slice(0,7)))];
  const m = uiFilter.month && months.includes(uiFilter.month) ? uiFilter.month : 'ALL';
  const shown = m === 'ALL' ? list : list.filter(s => (s.created_at||'').startsWith(m));
  const total = shown.reduce((a,s)=>a+s.amount,0);
  return `
  <div class="page-head"><div><h2>Lịch sử trả</h2>
    <p>${shown.length} lần thanh toán · tổng ${vnd(total)}. Lịch sử không bị xóa.</p></div></div>
  ${peerBar()}
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
function vForceChangePw(){
  return `
  <div class="page-head"><div><h2>Đổi mật khẩu</h2>
    <p>Tài khoản của bạn đang dùng mật khẩu mặc định — hãy đặt mật khẩu mới trước khi tiếp tục.</p></div></div>
  <div class="panel"><div class="body">
    <div class="field"><label for="pw1">Mật khẩu hiện tại</label><input class="input" id="pw1" type="password"></div>
    <div class="field"><label for="pw2">Mật khẩu mới</label><input class="input" id="pw2" type="password"></div>
    <div id="pw_err"></div>
    <button class="btn primary" onclick="changePw()">Đổi mật khẩu</button>
  </div></div>`;
}
async function changePw(){
  const cur = el('pw1').value, next = el('pw2').value;
  if (next.length < 1) return el('pw_err').innerHTML = `<div class="err">Mật khẩu mới không được để trống.</div>`;
  const ok = await checkLogin(me.username, cur);
  if (!ok) return el('pw_err').innerHTML = `<div class="err">Mật khẩu hiện tại không đúng.</div>`;
  const creds = await credsDoc();
  creds[me.username] = await sha(next);
  await saveCreds(creds);
  if (mustChangePw){
    mustChangePw = false;
    const body = {...me}; delete body.id;
    await Store.set('users', me.username, { ...body, must_change_pw:false });
    me.must_change_pw = false;
    Data.usersById[me.username] = me;
    toast('Đã đổi mật khẩu. Chào mừng!');
    route = { path:'dashboard', param:null };
    location.hash = '#/dashboard';
    render();
  } else {
    el('pw_err').innerHTML = ''; el('pw1').value=''; el('pw2').value='';
    toast('Đã đổi mật khẩu');
  }
}

/* ---- friends ---- */
function vFriends(){
  const friends = acceptedFriends();
  const incoming = pendingIncoming();
  const outgoing = pendingOutgoing();
  return `
  <div class="page-head"><div><h2>Kết bạn</h2>
    <p>Kết bạn với ai đó để tạo một sổ chung riêng, chỉ hai người thấy được.</p></div></div>

  <div class="panel"><div class="body">
    <div class="field"><label for="fr_q">Tìm theo tên đăng nhập</label>
      <div style="display:flex;gap:8px">
        <input class="input" id="fr_q" placeholder="username" autocapitalize="none" spellcheck="false"
          onkeydown="if(event.key==='Enter')sendFriendRequest()">
        <button class="btn primary" onclick="sendFriendRequest()">Gửi lời mời</button>
      </div></div>
    <div id="fr_err"></div>
  </div></div>

  ${incoming.length ? `<section class="section panel"><h3>Lời mời đang chờ bạn (${incoming.length})</h3><div class="body">
    ${incoming.map(f=>`<div class="kv"><span>${esc(nameOf(f.requested_by))} (${esc(f.requested_by)}) muốn kết bạn</span>
      <span style="display:flex;gap:6px">
        <button class="btn sm primary" onclick="respondFriend('${f.id}',true)">Chấp nhận</button>
        <button class="btn sm" onclick="respondFriend('${f.id}',false)">Từ chối</button></span></div>`).join('')}
  </div></section>` : ''}

  ${outgoing.length ? `<section class="section panel"><h3>Lời mời đã gửi (${outgoing.length})</h3><div class="body">
    ${outgoing.map(f=>{ const to = f.user_a===me.username?f.user_b:f.user_a;
      return `<div class="kv"><span>Đang chờ ${esc(nameOf(to))} (${esc(to)}) phản hồi</span></div>`; }).join('')}
  </div></section>` : ''}

  <section class="section panel"><h3>Bạn bè (${friends.length})</h3><div class="body">
    ${friends.length ? friends.map(u=>`
      <div class="kv"><span>${esc(nameOf(u))} (${esc(u)})${u===peer?' · đang mở':''}</span>
      ${u===peer ? `<span class="tag">Sổ đang mở</span>`
        : `<button class="btn sm" onclick="switchPeer('${u}')">Mở sổ chung</button>`}</div>`).join('')
      : `<div class="empty"><b>Chưa có bạn bè</b>Gửi lời mời kết bạn ở trên để bắt đầu tạo sổ chung.</div>`}
  </div></section>`;
}
async function sendFriendRequest(){
  const uname = el('fr_q').value.trim().toLowerCase();
  if (!uname) return;
  if (uname === me.username) return el('fr_err').innerHTML = `<div class="err">Không thể tự kết bạn với chính mình.</div>`;
  const target = await getUserDoc(uname);
  if (!target) return el('fr_err').innerHTML = `<div class="err">Không tìm thấy tài khoản "${esc(uname)}".</div>`;
  const id = makePairId(me.username, uname);
  const existing = Data.friendships.find(f=>f.id===id) || await getFriendshipDoc(id);
  if (existing){
    el('fr_err').innerHTML = existing.status === 'ACCEPTED'
      ? `<div class="err">Hai người đã là bạn bè.</div>`
      : `<div class="err">Đã có lời mời đang chờ giữa hai người.</div>`;
    return;
  }
  const [ua, ub] = [me.username, uname].sort();
  await Store.set('friendships', id, { user_a:ua, user_b:ub, status:'PENDING', requested_by:me.username, created_at:now() });
  await log('CREATE','friendship',id,{title:nameOf(uname)});
  el('fr_q').value = ''; el('fr_err').innerHTML = ''; toast('Đã gửi lời mời kết bạn');
}
async function respondFriend(id, accept){
  const f = Data.friendships.find(x=>x.id===id); if (!f) return;
  if (f.user_a!==me.username && f.user_b!==me.username) return toast('Không có quyền');
  if (accept){
    const body = {...f}; delete body.id;
    await Store.set('friendships', id, { ...body, status:'ACCEPTED' });
    await log('EDIT','friendship',id,{title:'Chấp nhận kết bạn'});
    toast('Đã chấp nhận kết bạn');
  } else {
    await Store.del('friendships', id);
    await log('DELETE','friendship',id,{});
    toast('Đã từ chối lời mời');
  }
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
    ${Data.txns.length?`<div class="tbl-wrap">${txnTable(sortedTxns())}</div>`:`<div class="empty">Chưa có dữ liệu.</div>`}</section>
  <section class="section panel">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <h3 style="margin:0">Tài khoản</h3>
      <button class="btn sm" onclick="openCreateUser()">+ Tạo tài khoản</button>
    </div>
    <div class="body">${Data.users.length ? `<div class="tbl-wrap"><table>
      <thead><tr><th>Username</th><th>Tên hiển thị</th><th>Vai trò</th><th>Người tạo</th><th>Ngày tạo</th><th>Trạng thái</th></tr></thead>
      <tbody>${[...Data.users].sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||'')).map(u=>`
        <tr><td>${esc(u.id)}</td><td>${esc(u.name)}</td><td>${esc(u.role)}</td>
        <td class="meta">${esc(u.created_by||'—')}</td>
        <td class="meta num">${u.created_at?fmtDate(u.created_at.slice(0,10)):'—'}</td>
        <td>${u.must_change_pw?'<span class="tag">Chờ đổi mật khẩu</span>':'<span class="tag">Hoạt động</span>'}</td></tr>`).join('')}
      </tbody></table></div>`
      : `<div class="empty">Chưa tải được danh sách tài khoản.</div>`}</div>
  </section>`;
}
function openCreateUser(){
  modal(`<header><h3>Tạo tài khoản mới</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="nu_user">Tên đăng nhập</label>
      <input class="input" id="nu_user" autocapitalize="none" spellcheck="false" placeholder="vd: minh"></div>
    <div class="field"><label for="nu_name">Tên hiển thị</label>
      <input class="input" id="nu_name" placeholder="vd: Minh"></div>
    <div id="nu_err"></div>
    <p class="hint">Mật khẩu mặc định là "${esc(DEFAULT_PW)}". Tài khoản mới sẽ bị bắt đổi mật khẩu ở lần đăng nhập đầu tiên.</p>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doCreateUser()">Tạo tài khoản</button></footer>`);
  el('nu_user').focus();
}
async function doCreateUser(){
  if (!isAdmin()) return toast('Không có quyền');
  const uname = el('nu_user').value.trim().toLowerCase();
  const name = el('nu_name').value.trim();
  const errs = [];
  if (!/^[a-z0-9_]{2,20}$/.test(uname)) errs.push('Tên đăng nhập chỉ gồm chữ thường, số, gạch dưới (2–20 ký tự).');
  if (!name) errs.push('Cần nhập tên hiển thị.');
  if (errs.length){ el('nu_err').innerHTML = `<div class="err">${errs.join(' ')}</div>`; return; }
  const existing = await getUserDoc(uname);
  if (existing){ el('nu_err').innerHTML = `<div class="err">Tên đăng nhập "${esc(uname)}" đã tồn tại.</div>`; return; }
  await Store.set('users', uname, { username:uname, name, role:'USER',
    created_by:me.username, created_at:now(), must_change_pw:true });
  const creds = (await credsDoc()) || {};
  creds[uname] = await sha(DEFAULT_PW);
  await saveCreds(creds);
  await log('CREATE','user',uname,{title:name});
  closeModal();
  toast(`Đã tạo tài khoản "${uname}" · mật khẩu mặc định: ${DEFAULT_PW}`);
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
  me = user; mustChangePw = !!user.must_change_pw;
  Data.usersById[user.username] = user;   // hiển thị đúng tên ngay cả trước khi có snapshot đầu tiên
  saveSession(user.username);
  el('loginView').style.display = 'none';
  el('appView').classList.add('on');
  route = parseHash();
  render();
  ['txns','settlements','activity'].forEach(col => {
    Store.watch(col, rows => { Data[col] = rows; render(); });
  });
  Store.watch('users', rows => { applyUsers(rows); render(); });
  Store.watch('friendships', rows => { Data.friendships = rows; maybeAutoSelectPeer(); render(); });
  Store.watch('messages', rows => { Data.messages = rows; render(); });
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
  await ensureLegacyUsers();
  await ensureLegacyFriendship();
  const s = readSession();
  if (s){
    const user = await getUserDoc(s.u);
    if (user) startApp(user);
  }
})();