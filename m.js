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
  db:null, local:{txns:{},settlements:{},activity:{},config:{},users:{},friendships:{},messages:{},
    groups:{},group_txns:{},savings:{},savings_entries:{},budgets:{}},
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
const Data = { txns:[], settlements:[], activity:[], users:[], usersById:{}, friendships:[], messages:[], config:{}, ready:false,
  groups:[], group_txns:[], savings:[], savings_entries:[], budgets:[] };
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
  // v3 mục 5: role/quota của chính mình có thể vừa bị admin đổi — cập nhật ngay.
  if (me && Data.usersById[me.username]) me = { ...me, ...Data.usersById[me.username] };
}

function reload(){ Data.reload(); }
Data.reload = () => {
  if (!Store.db){
    ['txns','settlements','activity','groups','group_txns','savings','savings_entries','budgets'].forEach(c => {
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
  return Data.friendships.filter(f => f.status==='ACCEPTED' && !f.ended_at &&
    (f.user_a===me.username||f.user_b===me.username))
    .map(f => f.user_a===me.username ? f.user_b : f.user_a);
}
// v3 mục 2: bạn bè đã huỷ — vẫn giữ bản ghi friendships (không xoá) để lịch sử
// tin nhắn/giao dịch cũ xem lại được, chỉ đánh dấu ended_at.
function isActiveFriend(u){
  if (!me || !u) return false;
  const f = Data.friendships.find(x=>x.id===makePairId(me.username,u));
  return !!f && f.status==='ACCEPTED' && !f.ended_at;
}
function endedFriends(){
  if (!me) return [];
  return Data.friendships.filter(f => f.status==='ACCEPTED' && f.ended_at &&
    (f.user_a===me.username||f.user_b===me.username))
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

/* ---- v3 mục 5: cấp bậc tài khoản ADMIN / SSS_VIP / VIP / USER ----
   Chỉ MỞ RỘNG enum users.role — 'ADMIN' và 'USER' giữ nguyên hành vi cũ.
   Giá trị role lạ/thiếu được coi như 'USER' (an toàn nhất, ít quyền nhất). */
const ROLES = ['ADMIN','SSS_VIP','VIP','USER'];
const ROLE_VI = { ADMIN:'Quản trị viên', SSS_VIP:'SSS VIP', VIP:'VIP', USER:'Thường' };
const ROLE_DESC = {
  ADMIN:   'Toàn quyền, kể cả nâng/hạ cấp và tạo tài khoản mọi cấp.',
  SSS_VIP: 'Toàn quyền dùng, tạo được tài khoản VIP/Thường, nâng/hạ cấp VIP/Thường.',
  VIP:     'Toàn quyền dùng mọi tính năng, tạo nhóm không giới hạn.',
  USER:    'Sổ chung, kết bạn, nhắn tin; tối đa 2 nhóm; chưa dùng được Thống kê, Sổ tiết kiệm, Ngân sách.',
};
const ROLE_GROUP_LIMIT = { USER: 2 };          // cấp không có trong bảng = không giới hạn
const PREMIUM_PAGES = ['stats','savings','budget'];   // trang khoá với cấp USER
const roleValid = r => ROLES.includes(r) ? r : 'USER';
const myRole = () => me ? roleValid(me.role) : 'USER';
const hasPremium = () => myRole() !== 'USER';
const lockedPage = p => PREMIUM_PAGES.includes(p) && !hasPremium();
const canManageUsers = () => myRole()==='ADMIN' || myRole()==='SSS_VIP';
// Các cấp mà người đang đăng nhập được phép gán (khi tạo / đổi cấp).
const assignableRoles = () => myRole()==='ADMIN' ? [...ROLES] : (myRole()==='SSS_VIP' ? ['VIP','USER'] : []);
// SSS_VIP chỉ đụng được tới tài khoản đang là VIP/USER; ADMIN đụng được mọi tài khoản.
function canChangeRoleOf(target){
  const r = myRole(), tr = roleValid(target.role);
  if (r==='ADMIN') return true;
  if (r==='SSS_VIP') return tr==='VIP' || tr==='USER';
  return false;
}
const groupLimit = () => ROLE_GROUP_LIMIT[myRole()];    // undefined = không giới hạn
// Số nhóm đã tạo = max(bộ đếm group_quota_used, số nhóm thực tế created_by mình):
// bộ đếm thiếu (bản ghi cũ) coi như 0 nhưng nhóm tạo từ trước mục 5 vẫn được tính.
const groupQuotaUsed = () => Math.max((me && me.group_quota_used) || 0,
  me ? Data.groups.filter(g => g.created_by === me.username).length : 0);
const groupQuotaExhausted = () => { const l = groupLimit(); return l !== undefined && groupQuotaUsed() >= l; };
const canEdit = t => isAdmin() || t.created_by === me.username;
const canDelete = t => isAdmin() || t.created_by === me.username;
// Người còn nợ (hoặc admin) mới được xác nhận trả.
const canMarkPaid = t => remainOf(t) > 0 && (isAdmin() || otherOf(t.paid_by, pairIdOf(t)) === me.username);

/* ---- v3 mục 1: xác nhận 2 chiều ----
   settlement cũ (không có field status) coi như đã CONFIRMED, vì code cũ đã
   cộng thẳng vào txns.repaid ngay khi tạo — không "confirm lại" dữ liệu cũ. */
const settlementStatus = s => s.status || 'CONFIRMED';
const canConfirmSettlement = s => settlementStatus(s)==='PENDING' && (isAdmin() || s.to_user===me.username);
const canCancelSettlement = s => settlementStatus(s)==='PENDING' && (isAdmin() || s.from_user===me.username);
function pendingOutgoingFor(t){ return Data.settlements.find(s=>s.transaction_id===t.id && settlementStatus(s)==='PENDING'); }
function myPendingIncomingSettlements(){
  if (!me) return [];
  return Data.settlements.filter(s => settlementStatus(s)==='PENDING' && s.to_user===me.username);
}

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
  {p:'groups',      t:'Nhóm',        m:'Nhóm'},
  {p:'stats',       t:'Thống kê',    m:'Thống kê'},
  {p:'new',         t:'Tạo giao dịch',m:null},
  {p:'settlements', t:'Cân nợ',      m:'Cân nợ'},
  {p:'history',     t:'Lịch sử trả', m:null},
  {p:'savings',     t:'Sổ tiết kiệm',m:null},
  {p:'budget',      t:'Ngân sách',   m:null},
  {p:'activity',    t:'Nhật ký',     m:null},
  {p:'settings',    t:'Cài đặt',     m:'Cài đặt'},
  {p:'admin',       t:'Quản trị',    m:null, admin:true},
];

const navCls = n => (route.path===n.p?'active':'') + (lockedPage(n.p)?' locked':'');
function vLocked(path){
  const n = NAV.find(x=>x.p===path);
  return `
  <div class="page-head"><div><h2>${esc(n?n.t:'Tính năng')}</h2></div></div>
  <div class="panel"><div class="empty"><b>Tính năng dành cho tài khoản VIP</b>
    Tài khoản gói Thường chưa dùng được trang này. Liên hệ quản trị viên để nâng cấp lên VIP.
    <div style="margin-top:12px"><a class="btn primary" href="#/dashboard">Về Tổng quan</a></div></div></div>`;
}
function render(){
  if (!me) return;
  const b = peer ? balanceText() : null;
  el('sideBal').textContent = !peer ? 'Chưa có sổ chung'
    : (b.amount ? b.text + ' ' + vnd(b.amount) : 'Đã cân bằng');
  el('meAv').textContent = nameOf(me.username)[0];
  el('meName').textContent = nameOf(me.username);
  el('meRole').textContent = myRole() === 'USER' ? 'Thành viên' : ROLE_VI[myRole()];

  const unpaid = myTxns().filter(t => t.paid_by !== me.username && remainOf(t) > 0).length;
  const friendReq = pendingIncoming().length;
  const confirmReq = myPendingIncomingSettlements().length;   // v3 mục 1
  const groupReq = myGroupPendingConfirms();                  // v3 mục 3
  el('nav').innerHTML = NAV.filter(n=>!n.admin||canManageUsers()).map(n =>
    `<a href="#/${n.p}" class="${navCls(n)}">${esc(n.t)}${
      n.p==='transactions'&&unpaid?`<span class="badge">${unpaid}</span>`:''}${
      n.p==='friends'&&friendReq?`<span class="badge">${friendReq}</span>`:''}${
      n.p==='settlements'&&confirmReq?`<span class="badge">${confirmReq}</span>`:''}${
      n.p==='groups'&&groupReq?`<span class="badge">${groupReq}</span>`:''}</a>`).join('');
  el('mnav').innerHTML = NAV.filter(n=>n.m && (!n.admin||canManageUsers())).map(n =>
    `<a href="#/${n.p}" class="${navCls(n)}">${esc(n.m)}${
      n.p==='friends'&&friendReq?`<span class="badge">${friendReq}</span>`:''}${
      n.p==='settlements'&&confirmReq?`<span class="badge">${confirmReq}</span>`:''}${
      n.p==='groups'&&groupReq?`<span class="badge">${groupReq}</span>`:''}</a>`).join('');

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

  if (lockedPage(route.path)){ el('main').innerHTML = vLocked(route.path); return; }   // v3 mục 5

  const fn = ({dashboard:vDashboard,stats:vStats,friends:vFriends,transactions:vTransactions,detail:vDetail,new:vNew,
               settlements:vSettlements,history:vHistory,activity:vActivity,
               groups:vGroups,savings:vSavings,budget:vBudget,
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
      ${isActiveFriend(peer) ? `
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>` : `<span class="tag">Đã huỷ kết bạn · chỉ xem lại</span>`}
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
    <div class="panel-head">
      <h3>Chi tiêu 6 tháng gần nhất</h3>
      <a class="btn sm" href="#/stats">Xem thống kê</a>
    </div>
    <div class="body">${svgBars(statsMonthly(lastMonths(6)))}</div>
  </section>

  <section class="section panel">
    <h3>Giao dịch gần đây</h3>
    ${recent.length ? `<div class="tbl-wrap">${txnTable(recent)}</div>`
      : `<div class="empty"><b>Chưa có giao dịch nào</b>Ghi khoản đầu tiên để bắt đầu theo dõi.</div>`}
  </section>`;
}
const stat = (k,v,cls) => `<div class="stat"><div class="k">${esc(k)}</div>
  <div class="v ${cls||''}">${typeof v==='number'?v:v}</div></div>`;

/* =========================================================================
   MỤC 6 — Biểu đồ thống kê.
   Dùng SVG thuần thay vì Chart.js: render() thay sạch innerHTML sau mỗi
   snapshot Firebase, nên biểu đồ canvas sẽ phải destroy/khởi tạo lại liên
   tục (rò rỉ instance). SVG là chuỗi thuần, vẽ lại bao nhiêu lần cũng được,
   ăn trực tiếp biến màu trong m.css và co giãn theo viewBox — hợp luôn với
   ràng buộc "không phần tử nào rộng hơn màn hình" ở mục 5.
   ========================================================================= */

// Rút gọn tiền cho nhãn trục: 1.250.000 -> "1,3 tr"
function shortVnd(n){
  const a = Math.abs(n);
  if (a >= 1e9) return (n/1e9).toFixed(a >= 1e10 ? 0 : 1).replace('.', ',') + ' tỷ';
  if (a >= 1e6) return (n/1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' tr';
  if (a >= 1e3) return Math.round(n/1e3) + 'k';
  return String(Math.round(n));
}
// 6 tháng gần nhất, cũ -> mới, dạng ['2026-04', ...]
function lastMonths(n){
  const out = [], d = new Date();
  for (let i = n-1; i >= 0; i--){
    const x = new Date(d.getFullYear(), d.getMonth()-i, 1);
    out.push(x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0'));
  }
  return out;
}
const mLabel = m => 'T' + parseInt(m.slice(5), 10);

/* ---- dữ liệu cho từng biểu đồ (chỉ trong sổ đang mở) ---- */
function statsMonthly(months){
  const list = myTxns();
  return months.map(m => ({
    label: mLabel(m),
    value: list.filter(t => (t.date||'').startsWith(m)).reduce((a,t)=>a+t.amount, 0)
  }));
}
function statsByCat(){
  const sum = {};
  for (const t of myTxns()){
    const c = CATEGORIES.includes(t.category) ? t.category : 'Other';
    sum[c] = (sum[c]||0) + t.amount;
  }
  return CATEGORIES
    .map((c,i) => ({ label: CAT_VI[c], value: sum[c]||0, i: i+1 }))
    .filter(s => s.value > 0);
}
// Số dư ròng tại thời điểm cuối mỗi tháng (dương = peer nợ tôi).
// Cộng dồn đúng theo cách netBalance() tính: nợ gốc từ txns, trừ dần theo settlements.
function netSeries(months){
  const ev = [];
  for (const t of myTxns())
    ev.push({ d:(t.date || t.created_at || '').slice(0,10),
              v:(t.paid_by === me.username ? 1 : -1) * owedOf(t) });
  for (const s of mySettlements())
    ev.push({ d:(s.created_at || '').slice(0,10),
              v:(s.to_user === me.username ? -1 : 1) * s.amount });
  return months.map(m => {
    const end = m + '-31';
    let sum = 0;
    for (const e of ev) if (e.d && e.d <= end) sum += e.v;
    return { label: mLabel(m), value: sum };
  });
}

/* ---- vẽ SVG ---- */
function svgBars(rows){
  if (!rows.some(r => r.value)) return `<div class="empty">Chưa có chi tiêu nào trong 6 tháng gần đây.</div>`;
  const W=640, H=230, padL=10, padR=10, padT=28, padB=30, base=H-padB;
  const max = Math.max(1, ...rows.map(r=>r.value));
  const iw = (W-padL-padR)/rows.length, bw = Math.min(56, iw*0.5);
  const grid = [0,.5,1].map(f=>{
    const y = padT + (1-f)*(base-padT);
    return `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" class="c-grid"/>`;
  }).join('');
  const bars = rows.map((r,i)=>{
    const h = r.value ? Math.max(3, (r.value/max)*(base-padT)) : 0;
    const x = padL + i*iw + (iw-bw)/2, y = base - h;
    return `<g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" class="c-bar"/>
      ${r.value ? `<text x="${(x+bw/2).toFixed(1)}" y="${(y-8).toFixed(1)}" class="c-val">${shortVnd(r.value)}</text>` : ''}
      <text x="${(x+bw/2).toFixed(1)}" y="${base+18}" class="c-lab">${r.label}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
    aria-label="Tổng chi theo tháng">${grid}${bars}</svg>`;
}

function svgDonut(slices){
  if (!slices.length) return `<div class="empty">Chưa có dữ liệu danh mục.</div>`;
  const W=260, H=260, cx=130, cy=130, r=92, sw=30;
  const total = slices.reduce((a,s)=>a+s.value, 0) || 1;
  const C = 2*Math.PI*r;
  let off = 0;
  const arcs = slices.map(s=>{
    const raw = C * (s.value/total);
    const len = Math.max(1, raw - (slices.length > 1 ? 2 : 0));   // chừa khe nhỏ giữa các lát
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${sw}"
      class="c-s${s.i}" stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}"
      stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += raw;
    return seg;
  }).join('');
  return `<svg class="chart donut" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
    aria-label="Tỉ lệ chi theo danh mục">${arcs}
    <text x="${cx}" y="${cy-2}" class="c-center">${shortVnd(total)}</text>
    <text x="${cx}" y="${cy+18}" class="c-lab">tổng chi</text></svg>`;
}

function svgLine(rows){
  if (!rows.length) return `<div class="empty">Chưa có dữ liệu.</div>`;
  const W=640, H=230, padL=10, padR=10, padT=26, padB=30;
  const vals = rows.map(r=>r.value);
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if (min === max) max = min + 1;
  const pad = (max-min) * 0.12;
  min -= pad; max += pad;
  const X = i => padL + i*(W-padL-padR)/Math.max(1, rows.length-1);
  const Y = v => padT + (1-(v-min)/(max-min))*(H-padT-padB);
  const pts = rows.map((r,i)=>`${X(i).toFixed(1)},${Y(r.value).toFixed(1)}`).join(' ');
  const zero = Y(0).toFixed(1);
  const dots = rows.map((r,i)=>`<circle cx="${X(i).toFixed(1)}" cy="${Y(r.value).toFixed(1)}" r="3.5" class="c-dot"/>
    <text x="${X(i).toFixed(1)}" y="${H-10}" class="c-lab">${r.label}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
    aria-label="Số dư ròng theo thời gian">
    <line x1="${padL}" x2="${W-padR}" y1="${zero}" y2="${zero}" class="c-zero"/>
    <polygon class="c-area" points="${padL},${zero} ${pts} ${W-padR},${zero}"/>
    <polyline class="c-line" points="${pts}"/>
    ${dots}
    <text x="${padL}" y="${(+zero)-6}" class="c-lab" style="text-anchor:start">0</text>
  </svg>`;
}

/* ---- trang Thống kê ---- */
function vStats(){
  if (!peer) return noPeerView('Thống kê');
  const months = lastMonths(6);
  const bars = statsMonthly(months);
  const cats = statsByCat();
  const net  = netSeries(months);
  const sum6 = bars.reduce((a,r)=>a+r.value, 0);
  const best = [...cats].sort((a,b)=>b.value-a.value)[0];
  const s = myStats();
  return `
  <div class="page-head"><div><h2>Thống kê</h2>
    <p>Sổ chung với ${esc(nameOf(peer))} · ${months[0]} → ${months[5]}</p></div>
    <div class="actions"><a class="btn" href="#/transactions">Xem giao dịch</a></div></div>
  ${peerBar()}

  <div class="grid cards">
    ${stat('Chi 6 tháng', vnd(sum6))}
    ${stat('Trung bình / tháng', vnd(Math.round(sum6/6)))}
    ${stat('Danh mục lớn nhất', best ? best.label : '—')}
    ${stat('Số dư hiện tại', vnd(Math.abs(netBalance())), netBalance() === 0 ? '' : (netBalance() > 0 ? 'credit' : 'debit'))}
  </div>

  <section class="section panel">
    <h3>Tổng chi theo tháng</h3>
    <div class="body">${svgBars(bars)}</div>
  </section>

  <div class="section chart-grid">
    <section class="panel">
      <h3>Tỉ lệ chi theo danh mục</h3>
      <div class="body">
        ${svgDonut(cats)}
        ${cats.length ? `<div class="legend">${cats.map(c=>
          `<span><i class="lg lg-${c.i}"></i>${esc(c.label)} · <b class="num">${vnd(c.value)}</b></span>`).join('')}</div>` : ''}
      </div>
    </section>
    <section class="panel">
      <h3>Số dư ròng theo thời gian</h3>
      <div class="body">
        ${svgLine(net)}
        <p class="hint" style="margin-top:10px">Trên vạch 0 nghĩa là ${esc(nameOf(peer))} đang nợ bạn;
        dưới vạch 0 là bạn đang nợ. Phần của bạn tới nay: <b class="num">${vnd(s.share)}</b>.</p>
      </div>
    </section>
  </div>`;
}

/* ---- transactions ---- */
function txnTable(list){
  return `<table>
  <thead><tr><th>Ngày</th><th>Nội dung</th><th>Tổng</th><th>Người trả</th>
  <th>Phần bạn</th><th>Còn lại</th><th>Trạng thái</th><th></th></tr></thead>
  <tbody>${list.map(t=>{
    const s = split(t.amount, t.paid_by, pairIdOf(t)), st = statusOf(t), rem = remainOf(t);
    const dir = t.paid_by === me.username ? 'credit' : 'debit';
    const pend = pendingOutgoingFor(t);
    return `<tr class="row" onclick="go('transactions/${t.id}')">
      <td class="meta num">${fmtDate(t.date)}</td>
      <td><div class="title">${esc(t.title)}</div>
          <div class="meta"><span class="tag">${esc(CAT_VI[t.category]||t.category)}</span> · ${esc(nameOf(t.created_by))} tạo</div></td>
      <td class="num">${vnd(t.amount)}</td>
      <td>${esc(nameOf(t.paid_by))}</td>
      <td class="num">${vnd(s[me.username])}</td>
      <td class="num" style="color:var(--${rem?dir:'dim'})">${rem?vnd(rem):'—'}</td>
      <td><span class="status"><i class="dot ${st==='SETTLED'?'done':st==='OPEN'?'open':'part'}"></i>${STATUS_VI[st]}</span>
        ${pend?`<span class="tag" style="margin-left:6px">Chờ xác nhận</span>`:''}</td>
      <td onclick="event.stopPropagation()">${pend
        ? (canConfirmSettlement(pend) ? `<button class="btn sm primary" onclick="confirmSettlement('${pend.id}')">Xác nhận nhận</button>` : '')
        : (canMarkPaid(t) ? `<button class="btn sm" onclick="markPaid('${t.id}')">Xác nhận trả</button>`:'')}</td>
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
      ${isActiveFriend(peer) ? `
      <button class="btn" onclick="openQuickAdd()">Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>` : `<span class="tag">Đã huỷ kết bạn · chỉ xem lại</span>`}
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
      ${(!pendingOutgoingFor(t) && canMarkPaid(t))?`<button class="btn primary" onclick="markPaid('${t.id}')">Xác nhận đã trả</button>`:''}
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
    ${(()=>{
      const pend = pendingOutgoingFor(t);
      if (pend) return `<div class="preview" style="margin-top:12px">
        <div class="row"><span>Yêu cầu trả ${vnd(pend.amount)} đang chờ ${esc(nameOf(pend.to_user))} xác nhận</span>
        <span style="display:flex;gap:6px">
          ${canConfirmSettlement(pend) ? `<button class="btn sm primary" onclick="confirmSettlement('${pend.id}')">Xác nhận nhận</button>
            <button class="btn sm" onclick="rejectSettlement('${pend.id}',false)">Từ chối</button>` : ''}
          ${canCancelSettlement(pend) && !canConfirmSettlement(pend) ? `<button class="btn sm" onclick="rejectSettlement('${pend.id}',true)">Huỷ yêu cầu</button>` : ''}
        </span></div></div>`;
      if (rem && canMarkPaid(t)) return `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary sm" onclick="markPaid('${t.id}')">Trả hết ${vnd(rem)}</button>
        <button class="btn sm" onclick="openPartial('${t.id}')">Trả một phần</button></div>`;
      return '';
    })()}
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
  if (!t && !isActiveFriend(peer)) return `<div class="panel"><div class="empty"><b>Đã huỷ kết bạn với ${esc(nameOf(peer))}</b>
    Không thể tạo giao dịch mới với người đã huỷ kết bạn. Vẫn xem lại được lịch sử ở trang Giao dịch.</div></div>`;
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
  if (!isActiveFriend(peer)) return toast(`Đã huỷ kết bạn với ${nameOf(peer)}, không thể ghi giao dịch mới`);
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

/* ---- pay / settle: chỉ TẠO YÊU CẦU chờ xác nhận, chưa cộng vào repaid ---- */
async function payTxn(t, amount, note){
  const rem = remainOf(t);
  const pay = Math.min(Math.trunc(amount), rem);
  if (pay <= 0) return 0;
  if (pendingOutgoingFor(t)){ toast('Khoản này đang có yêu cầu chờ xác nhận, đợi hoặc huỷ yêu cầu cũ trước đã'); return 0; }
  await Store.set('settlements', rid(), { from_user:otherOf(t.paid_by, pairIdOf(t)), to_user:t.paid_by,
    pair_id:pairIdOf(t), amount:pay, transaction_id:t.id, note:note||'', created_at:now(), created_by:me.username,
    status:'PENDING' });
  return pay;
}
async function markPaid(id){
  const t = Data.txns.find(x=>x.id===id);
  if (!t || !canMarkPaid(t)) return toast('Bạn không có quyền xác nhận khoản này');
  const paid = await payTxn(t, remainOf(t), 'Trả đủ');
  if (!paid) return;
  await log('MARK_PAID','transaction',id,{title:t.title, amount:paid});
  toast(`Đã gửi yêu cầu · chờ ${nameOf(t.paid_by)} xác nhận ${vnd(paid)}`);
}
// Người nhận tiền (hoặc admin) bấm xác nhận — lúc này mới cộng vào txns.repaid.
async function confirmSettlement(id){
  const s = Data.settlements.find(x=>x.id===id);
  if (!s || !canConfirmSettlement(s)) return toast('Bạn không có quyền xác nhận khoản này');
  const t = Data.txns.find(x=>x.id===s.transaction_id);
  if (t){
    const tb = {...t}; delete tb.id;
    await Store.set('txns', t.id, { ...tb, repaid:(t.repaid||0)+s.amount, updated_at:now() });
  }
  const sb = {...s}; delete sb.id;
  await Store.set('settlements', id, { ...sb, status:'CONFIRMED', confirmed_by:me.username, confirmed_at:now() });
  await log('SETTLEMENT','settlement',id,{title:t?t.title:'', amount:s.amount});
  toast(`Đã xác nhận nhận ${vnd(s.amount)}`);
}
// byRequester=true: người trả tự huỷ yêu cầu của mình. false: người nhận từ chối.
async function rejectSettlement(id, byRequester){
  const s = Data.settlements.find(x=>x.id===id);
  if (!s) return;
  if (byRequester ? !canCancelSettlement(s) : !canConfirmSettlement(s)) return toast('Bạn không có quyền thao tác khoản này');
  const sb = {...s}; delete sb.id;
  await Store.set('settlements', id, { ...sb, status:'REJECTED', confirmed_by:me.username, confirmed_at:now() });
  await log('EDIT','settlement',id,{title: byRequester?'Huỷ yêu cầu thanh toán':'Từ chối xác nhận', amount:s.amount});
  toast(byRequester ? 'Đã huỷ yêu cầu thanh toán' : 'Đã từ chối xác nhận');
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
  if (!paid){ closeModal(); return; }
  await log('MARK_PAID','transaction',id,{title:t.title, amount:paid});
  closeModal(); toast(`Đã gửi yêu cầu · chờ ${nameOf(t.paid_by)} xác nhận ${vnd(paid)}`);
}

function vSettlements(){
  if (!peer) return noPeerView('Cân nợ');
  const b = balanceText();
  const open = sortedMyTxns().filter(t => remainOf(t) > 0);
  const pid = currentPairId();
  const incoming = Data.settlements.filter(s => pairIdOf(s)===pid && settlementStatus(s)==='PENDING' && s.to_user===me.username);
  const outgoing = Data.settlements.filter(s => pairIdOf(s)===pid && settlementStatus(s)==='PENDING' && s.from_user===me.username);
  return `
  <div class="page-head"><div><h2>Cân nợ</h2>
    <p>Trả một lần cho toàn bộ số dư giữa bạn và ${esc(nameOf(peer))}.</p></div></div>
  ${peerBar()}
  ${incoming.length ? `<section class="section panel"><h3>Chờ bạn xác nhận (${incoming.length})</h3><div class="body">
    ${incoming.map(s=>{ const t = Data.txns.find(x=>x.id===s.transaction_id);
      return `<div class="kv"><span>${esc(nameOf(s.from_user))} báo đã trả ${vnd(s.amount)}${t?` · “${esc(t.title)}”`:''}</span>
      <span style="display:flex;gap:6px">
        <button class="btn sm primary" onclick="confirmSettlement('${s.id}')">Xác nhận nhận</button>
        <button class="btn sm" onclick="rejectSettlement('${s.id}',false)">Từ chối</button></span></div>`; }).join('')}
  </div></section>` : ''}
  ${outgoing.length ? `<section class="section panel"><h3>Đang chờ xác nhận (${outgoing.length})</h3><div class="body">
    ${outgoing.map(s=>{ const t = Data.txns.find(x=>x.id===s.transaction_id);
      return `<div class="kv"><span>Chờ ${esc(nameOf(s.to_user))} xác nhận ${vnd(s.amount)}${t?` · “${esc(t.title)}”`:''}</span>
      <button class="btn sm" onclick="rejectSettlement('${s.id}',true)">Huỷ yêu cầu</button></div>`; }).join('')}
  </div></section>` : ''}
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
  closeModal(); toast((amt-left) ? `Đã gửi yêu cầu cân nợ ${vnd(amt-left)} · chờ ${nameOf(b.creditor)} xác nhận` : 'Không có khoản nào được gửi yêu cầu');
}

/* ---- history ---- */
const SETTLE_STATUS_VI = {CONFIRMED:'Đã xác nhận', PENDING:'Chờ xác nhận', REJECTED:'Đã từ chối/huỷ'};
function vHistory(){
  if (!peer) return noPeerView('Lịch sử trả');
  const list = [...mySettlements()].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  const months = [...new Set(list.map(s=>(s.created_at||'').slice(0,7)))];
  const m = uiFilter.month && months.includes(uiFilter.month) ? uiFilter.month : 'ALL';
  const shown = m === 'ALL' ? list : list.filter(s => (s.created_at||'').startsWith(m));
  const total = shown.filter(s=>settlementStatus(s)==='CONFIRMED').reduce((a,s)=>a+s.amount,0);
  return `
  <div class="page-head"><div><h2>Lịch sử trả</h2>
    <p>${shown.length} lần thanh toán · tổng đã xác nhận ${vnd(total)}. Lịch sử không bị xóa.</p></div></div>
  ${peerBar()}
  <div class="toolbar"><div class="chips">
    <button class="chip ${m==='ALL'?'on':''}" onclick="uiFilter.month='ALL';render()">Tất cả</button>
    ${months.map(x=>`<button class="chip ${m===x?'on':''}" onclick="uiFilter.month='${x}';render()">${x}</button>`).join('')}
  </div></div>
  <div class="panel">${shown.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Thời gian</th><th>Từ</th><th>Đến</th><th>Số tiền</th><th>Cho giao dịch</th><th>Trạng thái</th></tr></thead>
    <tbody>${shown.map(s=>{
      const t = Data.txns.find(x=>x.id===s.transaction_id);
      const st = settlementStatus(s);
      return `<tr><td class="meta num">${fmtDT(s.created_at)}</td><td>${esc(nameOf(s.from_user))}</td>
      <td>${esc(nameOf(s.to_user))}</td><td class="num">${vnd(s.amount)}</td>
      <td class="meta">${t?esc(t.title):'—'}${s.note?` · ${esc(s.note)}`:''}</td>
      <td><span class="status"><i class="dot ${st==='CONFIRMED'?'done':st==='PENDING'?'open':'part'}"></i>${SETTLE_STATUS_VI[st]}</span></td></tr>`;}).join('')}
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
      <div class="kv"><span>Vai trò</span><b>${esc(ROLE_VI[myRole()])}</b></div>
      ${groupLimit()!==undefined?`<div class="kv"><span>Lượt tạo nhóm</span><b class="num">${Math.min(groupQuotaUsed(),groupLimit())}/${groupLimit()}</b></div>`:''}
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
  <section class="section panel"><h3>Công cụ khác</h3><div class="body">
    <p class="hint" style="margin-top:0">Không thuộc sổ chung 2 người, xem/quản lý riêng ở đây.</p>
    <div class="actions">
      <a class="btn" href="#/groups">Nhóm</a>
      <a class="btn" href="#/savings">Sổ tiết kiệm</a>
      <a class="btn" href="#/budget">Ngân sách</a>
    </div>
  </div></section>
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
      <span style="display:flex;gap:6px">
        ${u===peer ? `<span class="tag">Sổ đang mở</span>`
          : `<button class="btn sm" onclick="switchPeer('${u}')">Mở sổ chung</button>`}
        <button class="btn sm" onclick="confirmUnfriend('${u}')">Huỷ kết bạn</button>
      </span></div>`).join('')
      : `<div class="empty"><b>Chưa có bạn bè</b>Gửi lời mời kết bạn ở trên để bắt đầu tạo sổ chung.</div>`}
  </div></section>

  ${endedFriends().length ? `<section class="section panel"><h3>Đã huỷ kết bạn (${endedFriends().length})</h3>
  <div class="body"><p class="hint" style="margin-top:0">Chỉ xem lại được lịch sử — không tạo giao dịch/nhắn tin mới.</p>
    ${endedFriends().map(u=>`<div class="kv"><span>${esc(nameOf(u))} (${esc(u)})${u===peer?' · đang mở':''}</span>
    ${u===peer ? `<span class="tag">Đang xem</span>` : `<button class="btn sm" onclick="switchPeer('${u}')">Xem lại lịch sử</button>`}</div>`).join('')}
  </div></section>` : ''}`;
}
async function sendFriendRequest(){
  const uname = el('fr_q').value.trim().toLowerCase();
  if (!uname) return;
  if (uname === me.username) return el('fr_err').innerHTML = `<div class="err">Không thể tự kết bạn với chính mình.</div>`;
  const target = await getUserDoc(uname);
  if (!target) return el('fr_err').innerHTML = `<div class="err">Không tìm thấy tài khoản "${esc(uname)}".</div>`;
  const id = makePairId(me.username, uname);
  const existing = Data.friendships.find(f=>f.id===id) || await getFriendshipDoc(id);
  // v3 mục 2: nếu bản ghi cũ đã ended_at, coi như chưa từng — cho kết bạn lại
  if (existing && !existing.ended_at){
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
/* =========================================================================
   V3 MỤC 2 — Huỷ kết bạn có điều kiện.
   Không xoá bản ghi friendships (giữ nguyên messages.thread_id + lịch sử) —
   chỉ set ended_at/ended_by. Chỉ cho huỷ khi sổ chung của cặp đó đã sạch nợ:
   không còn giao dịch OPEN/PARTIALLY_SETTLED, không còn settlement PENDING.
   ========================================================================= */
// v3 mục 3: 2 người có chung nhóm chi tiêu và còn nợ nhau trực tiếp trong 1
// khoản (1 người là paid_by, người kia là participant chưa confirmed) thì
// cũng coi là "chưa sạch nợ" — không cho huỷ kết bạn.
function hasOpenGroupTies(u1,u2){
  for (const gt of Data.group_txns){
    const g = groupById(gt.group_id); if (!g) continue;
    if (!isGroupMember(g,u1) || !isGroupMember(g,u2)) continue;
    const payer = gt.paid_by;
    const debtor = payer===u1 ? u2 : (payer===u2 ? u1 : null);
    if (!debtor) continue;   // khoản này không phải paid_by=1 trong 2 người -> không nợ trực tiếp
    if (groupOwedTo(gt, debtor) > 0) return true;
  }
  return false;
}
function canUnfriend(pairId){
  const [u1,u2] = pairId.split('_');
  const openTxns = Data.txns.filter(t => pairIdOf(t)===pairId && remainOf(t) > 0).length;
  const pendingSettle = Data.settlements.filter(s => pairIdOf(s)===pairId && settlementStatus(s)==='PENDING').length;
  const groupTies = hasOpenGroupTies(u1,u2);
  return { ok: openTxns===0 && pendingSettle===0 && !groupTies, openTxns, pendingSettle, groupTies };
}
function confirmUnfriend(u){
  const check = canUnfriend(makePairId(me.username,u));
  if (!check.ok){
    const parts = [];
    if (check.openTxns) parts.push(`${check.openTxns} giao dịch chưa xong`);
    if (check.pendingSettle) parts.push(`${check.pendingSettle} khoản chờ xác nhận`);
    if (check.groupTies) parts.push(`khoản chia nhóm chưa xong`);
    return toast(`Chưa thể huỷ kết bạn: còn ${parts.join(', ')}. Cân nợ xong đã nhé.`);
  }
  modal(`<header><h3>Huỷ kết bạn với ${esc(nameOf(u))}?</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body"><p style="margin:0;color:var(--muted)">Sổ chung và lịch sử trò chuyện được giữ lại để xem sau,
  nhưng hai người sẽ không thể tạo giao dịch hay nhắn tin mới với nhau nữa.</p></div>
  <footer><button class="btn" onclick="closeModal()">Đóng</button>
  <button class="btn danger" onclick="closeModal();unfriend('${u}')">Huỷ kết bạn</button></footer>`);
}
async function unfriend(u){
  const id = makePairId(me.username, u);
  const check = canUnfriend(id);
  if (!check.ok) return toast('Chưa thể huỷ kết bạn: sổ chung chưa sạch nợ.');
  const f = Data.friendships.find(x=>x.id===id);
  if (!f) return;
  const body = {...f}; delete body.id;
  await Store.set('friendships', id, { ...body, ended_at:now(), ended_by:me.username });
  await log('DELETE','friendship',id,{title:`Huỷ kết bạn với ${nameOf(u)}`});
  if (peer === u){ peer = null; savePeer(''); }
  toast(`Đã huỷ kết bạn với ${esc(nameOf(u))}`);
  go('friends');
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

/* =========================================================================
   V3 MỤC 3 — Nhóm chi tiêu (hội nhóm).
   Tách hoàn toàn khỏi txns/split()/pairIdOf()/otherOf() (các hàm đó giả định
   cứng 2 người, đụng vào rất rủi ro) — dùng 2 collection mới hoàn toàn:
   `groups` (thành viên) và `group_txns` (từng khoản chi + xác nhận 2 chiều
   cho từng thành viên, cùng triết lý với mục 1 nhưng lưu ngay trên bản ghi
   group_txns thay vì tạo settlement riêng, vì mỗi khoản có N người nợ).
   ========================================================================= */
function myGroups(){
  if (!me) return [];
  return Data.groups.filter(g => g.members && g.members[me.username] && g.members[me.username].status==='ACTIVE');
}
const groupById = id => Data.groups.find(g=>g.id===id);
const isGroupMember = (g,u) => !!(g && g.members && g.members[u] && g.members[u].status==='ACTIVE');
function activeGroupMembers(g){ return Object.keys(g.members||{}).filter(u => g.members[u].status==='ACTIVE'); }
function groupTxnsOf(gid){
  return [...Data.group_txns].filter(x=>x.group_id===gid)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.created_at||'').localeCompare(a.created_at||''));
}
// Chia đều số tiền cho các thành viên participants===true; người ứng tiền
// nhận phần lẻ trước (cùng kiểu làm tròn với split() hiện có, cho nhất quán).
function computeGroupShares(amount, paidBy, participants){
  const trueUsers = Object.keys(participants).filter(u=>participants[u]).sort();
  const n = trueUsers.length || 1;
  const base = Math.floor(amount / n);
  let rem = amount - base*n;
  const shares = {};
  const order = trueUsers.includes(paidBy) ? [paidBy, ...trueUsers.filter(u=>u!==paidBy)] : trueUsers;
  for (const u of order){ shares[u] = base + (rem>0?1:0); if (rem>0) rem--; }
  for (const u of Object.keys(participants)) if (!participants[u]) shares[u] = 0;
  return shares;
}
// u nợ paid_by bao nhiêu cho khoản gt này (0 nếu không tham gia hoặc đã confirmed).
function groupOwedTo(gt, u){
  if (u === gt.paid_by) return 0;
  if (!gt.participants || !gt.participants[u]) return 0;
  const p = (gt.paid_status||{})[u];
  if (p && p.confirmed) return 0;
  return gt.shares ? (gt.shares[u]||0) : 0;
}
// Số dư của tôi trong 1 nhóm: dương = người khác đang nợ tôi, âm = tôi đang nợ người khác.
function myGroupBalance(gid){
  let net = 0;
  for (const gt of groupTxnsOf(gid)){
    if (gt.paid_by === me.username){
      for (const u of Object.keys(gt.participants||{})) net += groupOwedTo(gt, u);
    } else {
      net -= groupOwedTo(gt, me.username);
    }
  }
  return net;
}
// Chỉ cho đổi participants (tham gia/không tham gia) khi CHƯA ai báo trả hay
// được xác nhận cho khoản này — đúng yêu cầu "trước khi giao dịch được xác
// nhận lần đầu" trong spec.
function canToggleGroupParticipant(gt){
  return !Object.values(gt.paid_status||{}).some(p=>p.paid || p.confirmed);
}
// Số khoản mà TÔI là người ứng tiền và có người đã báo đã trả, đang chờ tôi xác nhận.
function myGroupPendingConfirms(){
  if (!me) return 0;
  let n = 0;
  for (const gt of Data.group_txns){
    if (gt.paid_by !== me.username) continue;
    for (const u in (gt.paid_status||{})){
      const p = gt.paid_status[u];
      if (p.paid && !p.confirmed) n++;
    }
  }
  return n;
}

function groupQuotaHint(){
  const l = groupLimit();
  return l === undefined ? '' : ` Đã dùng ${Math.min(groupQuotaUsed(), l)}/${l} lượt tạo nhóm.`;
}
function openGroupQuotaModal(){
  const l = groupLimit();
  modal(`<header><h3>Hết lượt tạo nhóm</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body"><div class="empty"><b>Bạn đã dùng hết ${Math.min(groupQuotaUsed(), l)}/${l} lượt tạo nhóm ở gói Thường</b>
    Liên hệ quản trị viên để nâng cấp lên VIP và tạo nhóm không giới hạn.</div></div>
  <footer><button class="btn primary" onclick="closeModal()">Đã hiểu</button></footer>`);
}
function openCreateGroup(){
  if (groupQuotaExhausted()) return openGroupQuotaModal();
  const friends = acceptedFriends();
  if (!friends.length) return toast('Cần có ít nhất 1 bạn bè để tạo nhóm — kết bạn ở trang Kết bạn trước đã');
  modal(`<header><h3>Tạo nhóm mới</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="g_name">Tên nhóm</label>
      <input class="input" id="g_name" placeholder="Du lịch Đà Lạt"></div>
    <div class="field"><label>Thêm thành viên (chỉ chọn được từ danh sách bạn bè)</label>
      <div class="check-list">${friends.map(u=>`
        <label class="check-item"><input type="checkbox" class="g-mem" value="${u}"> ${esc(nameOf(u))}</label>`).join('')}</div>
    </div>
    <div id="g_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doCreateGroup()">Tạo nhóm</button></footer>`);
  el('g_name').focus();
}
async function doCreateGroup(){
  if (groupQuotaExhausted()){ closeModal(); return openGroupQuotaModal(); }   // chặn lần nữa phía code
  const name = el('g_name').value.trim();
  if (!name){ el('g_err').innerHTML = `<div class="err">Cần nhập tên nhóm.</div>`; return; }
  const friends = acceptedFriends();
  const checked = [...document.querySelectorAll('.g-mem:checked')].map(c=>c.value).filter(u=>friends.includes(u));
  const members = { [me.username]: { role:'OWNER', joined_at:now(), status:'ACTIVE' } };
  for (const u of checked) members[u] = { role:'MEMBER', joined_at:now(), status:'ACTIVE' };
  const gid = rid();
  await Store.set('groups', gid, { name, created_by:me.username, created_at:now(), members });
  // v3 mục 5: tăng bộ đếm — đọc lại bản ghi mới nhất để không ghi đè role vừa bị admin đổi.
  try {
    const fresh = await getUserDoc(me.username);
    if (fresh){ const b = {...fresh}; delete b.id;
      await Store.set('users', me.username, { ...b, group_quota_used:(fresh.group_quota_used||0)+1 }); }
  } catch(e){}
  await log('CREATE','group',gid,{title:name});
  closeModal(); toast('Đã tạo nhóm'); go('groups', gid);
}

function openGroupTxn(gid){
  const g = groupById(gid); if (!g || !isGroupMember(g, me.username)) return;
  const mem = activeGroupMembers(g);
  modal(`<header><h3>Ghi chi tiêu nhóm</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="gt_title">Nội dung</label>
      <input class="input" id="gt_title" placeholder="Ăn tối cả nhóm"></div>
    <div class="two">
      <div class="field"><label for="gt_amount">Số tiền (VND)</label>
        <input class="input num" id="gt_amount" inputmode="numeric" placeholder="500000"></div>
      <div class="field"><label for="gt_cat">Danh mục</label>
        <select class="input" id="gt_cat">${CATEGORIES.map(c=>`<option value="${c}">${CAT_VI[c]}</option>`).join('')}</select></div>
    </div>
    <div class="two">
      <div class="field"><label for="gt_paid">Ai đã ứng tiền</label>
        <select class="input" id="gt_paid">${mem.map(u=>
          `<option value="${u}" ${u===me.username?'selected':''}>${esc(nameOf(u))}</option>`).join('')}</select></div>
      <div class="field"><label for="gt_date">Ngày</label>
        <input class="input" id="gt_date" type="date" value="${todayISO()}"></div>
    </div>
    <p class="hint" style="margin-top:0">Mặc định chia đều cho mọi thành viên đang hoạt động. Mỗi người có thể bấm
    "Không tham gia" cho riêng khoản này, miễn là chưa ai báo đã trả.</p>
    <div id="gt_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="submitGroupTxn('${gid}')">Thêm khoản chi</button></footer>`);
  el('gt_title').focus();
}
async function submitGroupTxn(gid){
  const g = groupById(gid); if (!g) return;
  const title = el('gt_title').value.trim();
  const amount = parseAmount(el('gt_amount').value);
  const category = el('gt_cat').value, paid_by = el('gt_paid').value, date = el('gt_date').value || todayISO();
  const errs = [];
  if (!title) errs.push('Cần nhập nội dung.');
  if (!amount || amount<=0) errs.push('Số tiền phải lớn hơn 0.');
  if (errs.length){ el('gt_err').innerHTML = `<div class="err">${errs.join(' ')}</div>`; return; }
  const activeMembers = activeGroupMembers(g);
  const participants = Object.fromEntries(activeMembers.map(u=>[u,true]));
  const shares = computeGroupShares(amount, paid_by, participants);
  const paid_status = {};
  for (const u of activeMembers) if (u !== paid_by) paid_status[u] = { paid:false, confirmed:false };
  const tid = rid();
  await Store.set('group_txns', tid, { group_id:gid, title, amount, category, paid_by, date,
    created_by:me.username, created_at:now(), participants, shares, paid_status });
  await log('CREATE','group_txn',tid,{title, amount});
  closeModal(); toast('Đã ghi chi tiêu nhóm');
}
async function toggleGroupParticipant(gtId, user){
  const gt = Data.group_txns.find(x=>x.id===gtId); if (!gt) return;
  if (!canToggleGroupParticipant(gt)) return toast('Đã có người báo/xác nhận trả, không đổi được nữa');
  if (user === gt.paid_by) return toast('Người ứng tiền luôn tham gia khoản này');
  if (!(isAdmin() || me.username===user)) return toast('Không có quyền');
  const nowIn = !gt.participants[user];
  const participants = { ...gt.participants, [user]: nowIn };
  const shares = computeGroupShares(gt.amount, gt.paid_by, participants);
  const paid_status = { ...gt.paid_status };
  if (!nowIn) delete paid_status[user];
  else paid_status[user] = paid_status[user] || { paid:false, confirmed:false };
  const b = {...gt}; delete b.id;
  await Store.set('group_txns', gtId, { ...b, participants, shares, paid_status });
  await log('EDIT','group_txn',gtId,{title:gt.title});
  toast(nowIn ? 'Đã tham gia lại khoản này' : 'Đã đánh dấu không tham gia khoản này');
}
function canMarkGroupPaid(gt,u){ return (gt.paid_status||{})[u] && !gt.paid_status[u].confirmed && (isAdmin() || me.username===u); }
async function markGroupPaid(gtId, u){
  const gt = Data.group_txns.find(x=>x.id===gtId);
  if (!gt || !canMarkGroupPaid(gt,u)) return toast('Không có quyền');
  const paid_status = { ...gt.paid_status, [u]: { ...gt.paid_status[u], paid:true } };
  const b = {...gt}; delete b.id;
  await Store.set('group_txns', gtId, { ...b, paid_status });
  await log('MARK_PAID','group_txn',gtId,{title:gt.title, amount:(gt.shares||{})[u]||0});
  toast(`Đã báo đã trả · chờ ${nameOf(gt.paid_by)} xác nhận`);
}
function canConfirmGroupPaid(gt,u){
  const p = (gt.paid_status||{})[u];
  return p && p.paid && !p.confirmed && (isAdmin() || me.username===gt.paid_by);
}
async function confirmGroupPaid(gtId, u){
  const gt = Data.group_txns.find(x=>x.id===gtId);
  if (!gt || !canConfirmGroupPaid(gt,u)) return toast('Không có quyền');
  const paid_status = { ...gt.paid_status, [u]: { ...gt.paid_status[u], confirmed:true, confirmed_by:me.username, confirmed_at:now() } };
  const b = {...gt}; delete b.id;
  await Store.set('group_txns', gtId, { ...b, paid_status });
  await log('SETTLEMENT','group_txn',gtId,{title:gt.title, amount:(gt.shares||{})[u]||0});
  toast(`Đã xác nhận nhận từ ${nameOf(u)}`);
}
async function rejectGroupPaid(gtId, u){
  const gt = Data.group_txns.find(x=>x.id===gtId); if (!gt) return;
  if (!(isAdmin() || me.username===gt.paid_by)) return toast('Không có quyền');
  const paid_status = { ...gt.paid_status, [u]: { paid:false, confirmed:false } };
  const b = {...gt}; delete b.id;
  await Store.set('group_txns', gtId, { ...b, paid_status });
  await log('EDIT','group_txn',gtId,{title:'Từ chối xác nhận trả nhóm'});
  toast('Đã từ chối, người trả sẽ thấy để báo lại');
}

function vGroups(){
  if (route.param) return vGroupDetail(route.param);
  const groups = myGroups();
  return `
  <div class="page-head"><div><h2>Nhóm</h2><p>Chi tiêu chung nhiều người, tách riêng khỏi sổ chung 2 người.${groupQuotaHint()}</p></div>
    <div class="actions"><button class="btn primary" onclick="openCreateGroup()">+ Tạo nhóm</button></div></div>
  ${groups.length ? `<div class="grid cards">${groups.map(g=>{
    const bal = myGroupBalance(g.id);
    const cls = bal===0?'':(bal>0?'credit':'debit');
    return `<div class="panel" style="cursor:pointer" onclick="go('groups','${g.id}')"><div class="body">
      <div class="kv"><span style="color:var(--text);font-weight:600">${esc(g.name)}</span>
      <span class="tag">${activeGroupMembers(g).length} thành viên</span></div>
      <div class="kv"><span>Số dư của bạn</span><b class="num ${cls}">${bal===0?'Đã cân bằng':vnd(Math.abs(bal))}</b></div>
    </div></div>`;}).join('')}</div>`
    : `<div class="panel"><div class="empty"><b>Chưa có nhóm nào</b>Tạo nhóm để chia chi tiêu với nhiều bạn bè cùng lúc.</div></div>`}`;
}
function vGroupDetail(gid){
  const g = groupById(gid);
  if (!g || !isGroupMember(g, me.username))
    return `<div class="panel"><div class="empty"><b>Không tìm thấy nhóm</b>
    <div style="margin-top:12px"><a class="btn sm" href="#/groups">Quay lại danh sách nhóm</a></div></div></div>`;
  const txns = groupTxnsOf(gid);
  const bal = myGroupBalance(gid);
  const members = activeGroupMembers(g);
  return `
  <div class="page-head">
    <div><p style="margin:0 0 4px"><a href="#/groups" style="color:var(--muted);text-decoration:none">← Nhóm</a></p>
      <h2>${esc(g.name)}</h2><p>${members.length} thành viên · tạo bởi ${esc(nameOf(g.created_by))}</p></div>
    <div class="actions"><button class="btn primary" onclick="openGroupTxn('${gid}')">+ Ghi chi tiêu nhóm</button></div>
  </div>
  <section class="hero">
    <p class="who-line">Số dư của bạn trong nhóm</p>
    <p class="amount ${bal===0?'':(bal>0?'credit':'debit')}">${vnd(Math.abs(bal))}</p>
    <p class="sub">${bal===0?'Bạn không nợ ai và không ai nợ bạn trong nhóm này.'
      :(bal>0?'Các thành viên khác đang nợ bạn tổng cộng.':'Bạn đang nợ các thành viên khác tổng cộng.')}</p>
  </section>
  <section class="section panel"><h3>Thành viên</h3><div class="body">
    ${members.map(u=>`<div class="kv"><span>${esc(nameOf(u))}${g.members[u].role==='OWNER'?' · chủ nhóm':''}${u===me.username?' · bạn':''}</span></div>`).join('')}
  </div></section>
  <section class="section panel"><h3>Chi tiêu nhóm (${txns.length})</h3><div class="body">
  ${txns.length ? txns.map(gt=>groupTxnCard(gt)).join('') : `<div class="empty"><b>Chưa có khoản chi nào</b>Ghi khoản đầu tiên cho nhóm này.</div>`}
  </div></section>`;
}
function groupTxnCard(gt){
  const g = groupById(gt.group_id);
  const others = (g ? activeGroupMembers(g) : Object.keys(gt.participants||{})).filter(u=>u!==gt.paid_by);
  return `<div class="preview" style="margin-bottom:10px">
    <div class="row"><span><b style="color:var(--text)">${esc(gt.title)}</b> · ${esc(nameOf(gt.paid_by))} ứng ${vnd(gt.amount)}</span>
    <span class="meta">${fmtDate(gt.date)} · ${esc(CAT_VI[gt.category]||gt.category)}</span></div>
    ${others.map(u=>{
      const isIn = !!(gt.participants && gt.participants[u]);
      const p = (gt.paid_status||{})[u] || {};
      const share = gt.shares ? (gt.shares[u]||0) : 0;
      const st = !isIn ? 'Không tham gia' : p.confirmed ? 'Đã xong' : p.paid ? 'Chờ xác nhận' : 'Chưa trả';
      const canTogg = canToggleGroupParticipant(gt) && (isAdmin()||me.username===u);
      return `<div class="row"><span>${esc(nameOf(u))}${isIn?` · phần ${vnd(share)}`:''}</span>
      <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="tag">${st}</span>
        ${canTogg ? `<button class="btn sm" onclick="toggleGroupParticipant('${gt.id}','${u}')">${isIn?'Không tham gia':'Tham gia lại'}</button>`:''}
        ${isIn && !p.confirmed && !p.paid && canMarkGroupPaid(gt,u) ? `<button class="btn sm primary" onclick="markGroupPaid('${gt.id}','${u}')">Đã trả</button>`:''}
        ${isIn && p.paid && !p.confirmed && canConfirmGroupPaid(gt,u) ? `<button class="btn sm primary" onclick="confirmGroupPaid('${gt.id}','${u}')">Xác nhận nhận</button>
          <button class="btn sm" onclick="rejectGroupPaid('${gt.id}','${u}')">Từ chối</button>`:''}
      </span></div>`;}).join('')}
  </div>`;
}

/* =========================================================================
   V3 MỤC 4a — Sổ tiết kiệm cá nhân (khóa theo username, không có pair_id).
   Số dư luôn tính runtime từ savings_entries — giống triết lý netBalance()
   hiện có, không lưu số dư cache để tránh lệch dữ liệu.
   ========================================================================= */
function mySavings(){ return me ? Data.savings.filter(s=>s.username===me.username) : []; }
function savingsEntriesOf(sid){
  return [...Data.savings_entries].filter(e=>e.savings_id===sid)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.created_at||'').localeCompare(a.created_at||''));
}
function savingsBalance(sid){
  return Data.savings_entries.filter(e=>e.savings_id===sid)
    .reduce((sum,e)=> sum + (e.type==='DEPOSIT' ? e.amount : -e.amount), 0);
}
function openNewSaving(){
  modal(`<header><h3>Mục tiêu tiết kiệm mới</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="sv_name">Tên mục tiêu</label>
      <input class="input" id="sv_name" placeholder="Mua xe máy"></div>
    <div class="field"><label for="sv_target">Số tiền mục tiêu (VND)</label>
      <input class="input num" id="sv_target" inputmode="numeric" placeholder="20000000"></div>
    <div class="field"><label for="sv_note">Ghi chú (tùy chọn)</label>
      <input class="input" id="sv_note" placeholder=""></div>
    <div id="sv_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doCreateSaving()">Tạo mục tiêu</button></footer>`);
  el('sv_name').focus();
}
async function doCreateSaving(){
  const name = el('sv_name').value.trim();
  const target_amount = parseAmount(el('sv_target').value);
  if (!name){ el('sv_err').innerHTML = `<div class="err">Cần nhập tên mục tiêu.</div>`; return; }
  const sid = rid();
  await Store.set('savings', sid, { username:me.username, name, target_amount,
    note:el('sv_note').value.trim(), created_at:now(), closed:false });
  await log('CREATE','saving',sid,{title:name});
  closeModal(); toast('Đã tạo mục tiêu tiết kiệm');
}
function openSavingEntry(sid, type){
  const s = Data.savings.find(x=>x.id===sid); if (!s) return;
  const label = type==='DEPOSIT' ? 'Nạp tiền' : 'Rút tiền';
  modal(`<header><h3>${label} · ${esc(s.name)}</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="se_amt">Số tiền</label>
      <input class="input num" id="se_amt" inputmode="numeric" placeholder="500000"></div>
    <div class="field"><label for="se_date">Ngày</label>
      <input class="input" id="se_date" type="date" value="${todayISO()}"></div>
    <div class="field"><label for="se_note">Ghi chú (tùy chọn)</label>
      <input class="input" id="se_note" placeholder=""></div>
    <div id="se_err"></div>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doSavingEntry('${sid}','${type}')">${label}</button></footer>`);
  el('se_amt').focus();
}
async function doSavingEntry(sid, type){
  const s = Data.savings.find(x=>x.id===sid); if (!s || s.username!==me.username) return toast('Không có quyền');
  const amount = parseAmount(el('se_amt').value);
  if (!amount || amount<=0){ el('se_err').innerHTML = `<div class="err">Số tiền phải lớn hơn 0.</div>`; return; }
  if (type==='WITHDRAW' && amount > savingsBalance(sid)){
    el('se_err').innerHTML = `<div class="err">Không đủ số dư để rút.</div>`; return;
  }
  const eid = rid();
  await Store.set('savings_entries', eid, { savings_id:sid, amount, type,
    date:el('se_date').value || todayISO(), note:el('se_note').value.trim(), created_at:now() });
  await log(type==='DEPOSIT'?'CREATE':'DELETE','saving_entry',eid,{title:s.name, amount});
  closeModal(); toast(type==='DEPOSIT'?'Đã nạp tiền':'Đã rút tiền');
}
async function closeSaving(sid){
  const s = Data.savings.find(x=>x.id===sid); if (!s || s.username!==me.username) return;
  const b = {...s}; delete b.id;
  await Store.set('savings', sid, { ...b, closed:!s.closed });
  toast(s.closed ? 'Đã mở lại mục tiêu' : 'Đã đóng mục tiêu');
}
function vSavings(){
  const list = mySavings();
  return `
  <div class="page-head"><div><h2>Sổ tiết kiệm</h2><p>Mục tiêu tiết kiệm của riêng bạn, không liên quan tới sổ chung.</p></div>
    <div class="actions"><button class="btn primary" onclick="openNewSaving()">+ Mục tiêu mới</button></div></div>
  ${list.length ? `<div class="grid cards">${list.map(s=>{
    const bal = savingsBalance(s.id);
    const pct = s.target_amount ? Math.min(100, Math.round(bal/s.target_amount*100)) : 0;
    const entries = savingsEntriesOf(s.id);
    return `<div class="panel"><div class="body">
      <div class="kv"><span style="color:var(--text);font-weight:600">${esc(s.name)}${s.closed?' <span class="tag">Đã đóng</span>':''}</span></div>
      <div class="kv"><span>Tiến độ</span><b class="num">${vnd(bal)}${s.target_amount?' / '+vnd(s.target_amount):''}</b></div>
      ${s.target_amount ? `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>` : ''}
      ${s.note?`<p class="hint" style="margin-top:10px">${esc(s.note)}</p>`:''}
      <div class="actions" style="margin-top:12px">
        <button class="btn sm" onclick="openSavingEntry('${s.id}','DEPOSIT')">Nạp</button>
        <button class="btn sm" onclick="openSavingEntry('${s.id}','WITHDRAW')">Rút</button>
        <button class="btn sm" onclick="closeSaving('${s.id}')">${s.closed?'Mở lại':'Đóng'}</button>
      </div>
      ${entries.length ? `<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Ngày</th><th>Loại</th><th>Số tiền</th></tr></thead>
        <tbody>${entries.slice(0,6).map(e=>`<tr><td class="meta num">${fmtDate(e.date)}</td>
        <td>${e.type==='DEPOSIT'?'Nạp':'Rút'}</td><td class="num">${vnd(e.amount)}</td></tr>`).join('')}</tbody></table></div>`:''}
    </div></div>`;}).join('')}</div>`
    : `<div class="panel"><div class="empty"><b>Chưa có mục tiêu nào</b>Tạo mục tiêu đầu tiên để bắt đầu tiết kiệm.</div></div>`}`;
}

/* =========================================================================
   V3 MỤC 4b — Ngân sách chi tiêu cá nhân theo tháng/danh mục.
   Read-only, tổng hợp phía trên txns/split() hiện có (mọi pair_id người dùng
   tham gia, không chỉ sổ đang mở) + 1 collection mới `budgets` cho hạn mức.
   ========================================================================= */
function myTxnsAllPairs(){
  if (!me) return [];
  return Data.txns.filter(t => { const [a,b] = pairIdOf(t).split('_'); return a===me.username || b===me.username; });
}
function budgetSpent(month, category){
  return myTxnsAllPairs()
    .filter(t => (t.date||'').startsWith(month) && (CATEGORIES.includes(t.category)?t.category:'Other')===category)
    .reduce((sum,t)=> sum + split(t.amount, t.paid_by, pairIdOf(t))[me.username], 0);
}
function budgetOf(month, category){
  return Data.budgets.find(b=>b.username===me.username && b.month===month && b.category===category);
}
async function saveBudget(category, val){
  const month = uiFilter.budgetMonth || todayISO().slice(0,7);
  const amount = parseAmount(val);
  const id = `${me.username}_${month}_${category}`;
  await Store.set('budgets', id, { username:me.username, month, category, limit_amount:amount, created_at:now() });
  toast('Đã lưu hạn mức');
}
function vBudget(){
  const month = uiFilter.budgetMonth || todayISO().slice(0,7);
  const rows = CATEGORIES.map(c=>{
    const b = budgetOf(month,c);
    const limit = b ? b.limit_amount : 0;
    const spent = budgetSpent(month,c);
    const pct = limit ? Math.min(100, Math.round(spent/limit*100)) : 0;
    return { c, limit, spent, pct, over: limit>0 && spent>limit };
  });
  return `
  <div class="page-head"><div><h2>Ngân sách</h2>
    <p>Hạn mức chi tiêu theo danh mục, tính trên mọi sổ chung bạn tham gia.</p></div>
    <div class="actions"><input class="input" type="month" style="width:auto" value="${month}"
      onchange="uiFilter.budgetMonth=this.value;render()"></div></div>
  <div class="grid cards">
  ${rows.map(r=>`
    <div class="panel"><div class="body">
      <div class="kv"><span>${esc(CAT_VI[r.c])}</span>
      <b class="num" style="color:var(--${r.over?'debit':'text'})">${vnd(r.spent)}${r.limit?' / '+vnd(r.limit):''}</b></div>
      <div class="progress"><div class="progress-bar ${r.over?'over':''}" style="width:${r.pct}%"></div></div>
      <div class="field" style="margin-top:12px;margin-bottom:0"><label>Hạn mức tháng này</label>
        <input class="input num" inputmode="numeric" placeholder="Chưa đặt" value="${r.limit||''}"
          onchange="saveBudget('${r.c}', this.value)"></div>
    </div></div>`).join('')}
  </div>`;
}

/* ---- admin ---- */
/* =========================================================================
   MIGRATION 1 LẦN + BACKUP (phần cuối của spec)
   - Mục 1 & 2 đã có ensureLegacyUsers() / ensureLegacyFriendship().
   - Còn lại: gán pair_id "duy_nguyen" cho mọi txns/settlements cũ.
   Chỉ ADMIN chạy, chỉ 1 lần, có cờ `config/migration` trên DB để các máy
   khác không chạy lại. Thuần cộng thêm field — không xóa, không đổi kiểu.
   ========================================================================= */
let _migRan = false;
async function readConfigDoc(id){
  if (Store.db){
    try { const d = await Store.db.doc('config/'+id).get(); return d.exists ? d.data : null; }
    catch(e){ return null; }
  }
  return (Store.local.config||{})[id] || null;
}
async function migratePairIds(silent){
  if (_migRan) return; _migRan = true;
  if (!isAdmin()) return;
  const flag = await readConfigDoc('migration');
  if (flag && flag.pair_id_v1) return;
  const n = await runPairIdBackfill();
  await Store.set('config', 'migration',
    { ...(flag||{}), pair_id_v1:true, at:now(), by:me.username, patched:n });
  if (!silent && n) toast(`Migration: đã gán pair_id cho ${n} bản ghi cũ`);
}
async function runPairIdBackfill(){
  let n = 0;
  for (const t of Data.txns){
    if (t.pair_id) continue;
    const b = {...t}; delete b.id;
    await Store.set('txns', t.id, { ...b, pair_id:'duy_nguyen' }); n++;
  }
  for (const s of Data.settlements){
    if (s.pair_id) continue;
    const b = {...s}; delete b.id;
    await Store.set('settlements', s.id, { ...b, pair_id:'duy_nguyen' }); n++;
  }
  return n;
}
// Nút thủ công trong trang Quản trị (chạy lại được, bỏ qua cờ).
async function forceMigrate(){
  if (!isAdmin()) return toast('Chỉ quản trị viên');
  const n = await runPairIdBackfill();
  const flag = await readConfigDoc('migration');
  await Store.set('config', 'migration', { ...(flag||{}), pair_id_v1:true, at:now(), by:me.username, patched:n });
  toast(n ? `Đã gán pair_id cho ${n} bản ghi` : 'Mọi bản ghi đã có pair_id');
  render();
}
// Backup: tải toàn bộ dữ liệu đang có về máy dưới dạng JSON, chạy TRƯỚC khi migrate.
function exportBackup(){
  const dump = {
    exported_at: now(), exported_by: me ? me.username : null,
    users: Data.users, friendships: Data.friendships,
    txns: Data.txns, settlements: Data.settlements,
    messages: Data.messages, activity: Data.activity,
    groups: Data.groups, group_txns: Data.group_txns,
    savings: Data.savings, savings_entries: Data.savings_entries, budgets: Data.budgets
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sochung-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('Đã tải file backup JSON');
}

function vAccountsSection(){
  const rows = [...Data.users].sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
  return `<section class="section panel">
    <div class="panel-head">
      <h3>Tài khoản</h3>
      <button class="btn sm" onclick="openCreateUser()">+ Tạo tài khoản</button>
    </div>
    <div class="body">${rows.length ? `<div class="tbl-wrap"><table>
      <thead><tr><th>Username</th><th>Tên hiển thị</th><th>Cấp</th><th>Người tạo</th><th>Ngày tạo</th><th>Trạng thái</th><th></th></tr></thead>
      <tbody>${rows.map(u=>`
        <tr><td>${esc(u.id)}</td><td>${esc(u.name)}</td><td><span class="tag">${esc(ROLE_VI[roleValid(u.role)])}</span></td>
        <td class="meta">${esc(u.created_by||'—')}</td>
        <td class="meta num">${u.created_at?fmtDate(u.created_at.slice(0,10)):'—'}</td>
        <td>${u.must_change_pw?'<span class="tag">Chờ đổi mật khẩu</span>':'<span class="tag">Hoạt động</span>'}</td>
        <td>${canChangeRoleOf(u)?`<button class="btn sm" onclick="openChangeRole('${esc(u.id)}')">Nâng/Hạ cấp</button>`:''}</td></tr>`).join('')}
      </tbody></table></div>`
      : `<div class="empty">Chưa tải được danh sách tài khoản.</div>`}</div>
  </section>`;
}
function vAdmin(){
  if (!canManageUsers()) return `<div class="panel"><div class="empty"><b>Trang chỉ dành cho quản trị viên</b>
    Tài khoản của bạn không có quyền truy cập.</div></div>`;
  // SSS_VIP chỉ thấy phần quản lý tài khoản — không thấy giao dịch/nhật ký toàn hệ thống.
  if (!isAdmin()) return `
  <div class="page-head"><div><h2>Quản trị</h2><p>Tạo tài khoản VIP/Thường và nâng/hạ cấp giữa hai cấp này.</p></div></div>
  ${vAccountsSection()}`;
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
  ${vAccountsSection()}

  <section class="section panel">
    <h3>Dữ liệu &amp; bảo trì</h3>
    <div class="body">
      <p class="hint" style="margin-top:0">Tải backup JSON trước khi chạy migration. Migration chỉ
      <b>thêm</b> field <span class="tag">pair_id</span> cho giao dịch/thanh toán cũ (mặc định
      <span class="tag">duy_nguyen</span>) — không xóa, không đổi bản ghi nào.</p>
      <div class="actions" style="margin-top:12px">
        <button class="btn" onclick="exportBackup()">Tải backup JSON</button>
        <button class="btn" onclick="forceMigrate()">Chạy migration pair_id</button>
      </div>
      <div class="preview" style="margin-top:14px">
        <div class="row"><span>Giao dịch thiếu pair_id</span><b class="num">${Data.txns.filter(t=>!t.pair_id).length}</b></div>
        <div class="row"><span>Thanh toán thiếu pair_id</span><b class="num">${Data.settlements.filter(s=>!s.pair_id).length}</b></div>
        <div class="row"><span>Tài khoản</span><b class="num">${Data.users.length}</b></div>
        <div class="row"><span>Quan hệ bạn bè</span><b class="num">${Data.friendships.length}</b></div>
      </div>
    </div>
  </section>`;
}
function openCreateUser(){
  if (!canManageUsers()) return toast('Không có quyền');
  const roleOpts = assignableRoles();
  modal(`<header><h3>Tạo tài khoản mới</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="field"><label for="nu_user">Tên đăng nhập</label>
      <input class="input" id="nu_user" autocapitalize="none" spellcheck="false" placeholder="vd: minh"></div>
    <div class="field"><label for="nu_name">Tên hiển thị</label>
      <input class="input" id="nu_name" placeholder="vd: Minh"></div>
    <div class="field"><label for="nu_role">Cấp tài khoản</label>
      <select class="input" id="nu_role">${roleOpts.map(r=>
        `<option value="${r}" ${r==='USER'?'selected':''}>${esc(ROLE_VI[r])}</option>`).join('')}</select></div>
    ${!isAdmin()?`<p class="hint" style="margin-top:0">Bạn chỉ tạo được tài khoản cấp VIP hoặc Thường.</p>`:''}
    <div id="nu_err"></div>
    <p class="hint">Mật khẩu mặc định là "${esc(DEFAULT_PW)}". Tài khoản mới sẽ bị bắt đổi mật khẩu ở lần đăng nhập đầu tiên.</p>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doCreateUser()">Tạo tài khoản</button></footer>`);
  el('nu_user').focus();
}
async function doCreateUser(){
  if (!canManageUsers()) return toast('Không có quyền');
  const uname = el('nu_user').value.trim().toLowerCase();
  const name = el('nu_name').value.trim();
  const role = el('nu_role').value;
  const errs = [];
  if (!assignableRoles().includes(role)) errs.push('Bạn không có quyền tạo tài khoản ở cấp này.');
  if (!/^[a-z0-9_]{2,20}$/.test(uname)) errs.push('Tên đăng nhập chỉ gồm chữ thường, số, gạch dưới (2–20 ký tự).');
  if (!name) errs.push('Cần nhập tên hiển thị.');
  if (errs.length){ el('nu_err').innerHTML = `<div class="err">${errs.join(' ')}</div>`; return; }
  const existing = await getUserDoc(uname);
  if (existing){ el('nu_err').innerHTML = `<div class="err">Tên đăng nhập "${esc(uname)}" đã tồn tại.</div>`; return; }
  await Store.set('users', uname, { username:uname, name, role,
    created_by:me.username, created_at:now(), must_change_pw:true, group_quota_used:0 });
  const creds = (await credsDoc()) || {};
  creds[uname] = await sha(DEFAULT_PW);
  await saveCreds(creds);
  await log('CREATE','user',uname,{title:`${name} (${ROLE_VI[role]})`});
  closeModal();
  toast(`Đã tạo tài khoản "${uname}" · mật khẩu mặc định: ${DEFAULT_PW}`);
}

/* ---- v3 mục 5: nâng/hạ cấp tài khoản ---- */
function openChangeRole(uname){
  const u = Data.usersById[uname]; if (!u) return;
  if (!canChangeRoleOf(u)) return toast('Không có quyền đổi cấp tài khoản này');
  const cur = roleValid(u.role), opts = assignableRoles();
  modal(`<header><h3>Nâng/Hạ cấp · ${esc(nameOf(uname))}</h3><button class="x" onclick="closeModal()">✕</button></header>
  <div class="body">
    <div class="kv"><span>Cấp hiện tại</span><b>${esc(ROLE_VI[cur])}</b></div>
    <div class="field"><label for="cr_role">Cấp mới</label>
      <select class="input" id="cr_role">${opts.map(r=>
        `<option value="${r}" ${r===cur?'selected':''}>${esc(ROLE_VI[r])}</option>`).join('')}</select></div>
    <div id="cr_err"></div>
    <p class="hint">${opts.map(r=>`<b>${esc(ROLE_VI[r])}</b>: ${esc(ROLE_DESC[r])}`).join('<br>')}</p>
  </div>
  <footer><button class="btn" onclick="closeModal()">Hủy</button>
  <button class="btn primary" onclick="doChangeRole('${esc(uname)}')">Lưu cấp mới</button></footer>`);
}
async function doChangeRole(uname){
  const newRole = el('cr_role').value;
  const fresh = await getUserDoc(uname);          // đọc lại bản mới nhất, không tin UI cũ
  if (!fresh) return toast('Không tìm thấy tài khoản');
  if (!canChangeRoleOf(fresh) || !assignableRoles().includes(newRole)) return toast('Không có quyền đổi sang cấp này');
  const oldRole = roleValid(fresh.role);
  if (newRole === oldRole){ closeModal(); return toast('Cấp không thay đổi'); }
  // Không cho hạ cấp ADMIN cuối cùng của hệ thống.
  if (oldRole==='ADMIN' && newRole!=='ADMIN' && Data.users.filter(u=>u.role==='ADMIN').length <= 1){
    el('cr_err').innerHTML = `<div class="err">Đây là quản trị viên cuối cùng — không thể hạ cấp.</div>`; return;
  }
  const body = {...fresh}; delete body.id;
  await Store.set('users', uname, { ...body, role:newRole, upgraded_by:me.username, upgraded_at:now() });
  await log('EDIT','user',uname,{title:`${uname}: ${ROLE_VI[oldRole]} → ${ROLE_VI[newRole]}`});
  closeModal(); toast(`Đã đổi ${uname} sang cấp ${ROLE_VI[newRole]}`);
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
  ['txns','settlements','activity','groups','group_txns','savings','savings_entries','budgets'].forEach(col => {
    Store.watch(col, rows => { Data[col] = rows; render(); });
  });
  Store.watch('users', rows => { applyUsers(rows); render(); });
  Store.watch('friendships', rows => { Data.friendships = rows; maybeAutoSelectPeer(); render(); });
  Store.watch('messages', rows => { Data.messages = rows; render(); });
  // đợi snapshot đầu tiên về rồi mới backfill pair_id (chỉ admin, chỉ 1 lần)
  setTimeout(() => { migratePairIds(true).catch(()=>{}); }, 4000);
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

/* =========================================================================
   MỤC 4 (bản sửa) — pressFX: trạng thái "đang nhấn" do JS điều khiển.

   Vì sao bản CSS-only trước đó không chạy:
   1) Trên iOS/Safari, :active chỉ kích hoạt khi phần tử (hoặc tổ tiên) có
      listener chạm; Chrome Android thì hoãn :active rồi hủy khi nghi ngờ
      người dùng đang cuộn -> nhấn nút hầu như không thấy phản hồi.
   2) Gần như mọi chip/tab/nút đều gọi render() ngay trong onclick, mà
      render() thay sạch innerHTML của #main -> phần tử đang nhấn bị xóa
      giữa chừng, animation "thả tay" không bao giờ có cơ hội chạy.
   Cách xử lý: bắt pointerdown/pointerup ủy quyền ở document (nên vẫn đúng
   sau mỗi lần re-render), và hoãn render() vài trăm ms trong lúc đang nhấn.
   ========================================================================= */
(function pressFX(){
  const SEL = '.btn,.chip,.chat-btn,.chat-fab,.chat-thread,.nav a,.mobile-nav a,.x,.chat-back,tr.row';
  const HOLD = 240;            // ms giữ DOM sau khi thả tay để animation chạy hết
  let cur = null, busy = false, pending = false, timer = 0;

  // Bọc render(): trong lúc đang nhấn thì dồn lại, thả tay xong mới vẽ.
  const baseRender = window.render;
  window.render = function(){
    if (busy){ pending = true; return; }
    baseRender();
  };
  function flush(){
    busy = false;
    if (pending){ pending = false; baseRender(); }
  }

  function down(node){
    if (cur) cur.classList.remove('is-press');
    cur = node; busy = true;
    clearTimeout(timer);
    node.classList.add('is-press');
  }
  function up(){
    if (!cur && !busy) return;
    if (cur) cur.classList.remove('is-press');
    cur = null;
    clearTimeout(timer);
    timer = setTimeout(flush, HOLD);
  }

  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const start = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    const node = start && start.closest ? start.closest(SEL) : null;
    if (!node) return;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') return;
    down(node);
  }, true);

  ['pointerup','pointercancel'].forEach(ev =>
    document.addEventListener(ev, up, true));
  // cuộn trang = không còn là cú nhấn
  window.addEventListener('scroll', () => { if (cur) up(); }, true);
  window.addEventListener('blur', up);
})();