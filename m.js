/* =========================================================================
   Sổ chung — ứng dụng chia đôi chi tiêu cho đúng hai người (mở rộng pairwise,
   nhóm, sổ tiết kiệm, ngân sách). Bản cập nhật v4 (APP_VERSION = 11).
   Mọi số tiền là số nguyên VND. Không dùng float cho tiền.
   Lưu trữ: capability `db` của artifact nếu có (môi trường Claude);
   nếu không thì dùng Firebase Realtime Database (window.FIREBASE_STORE,
   khởi tạo trong index.html); chỉ dùng localStorage khi URL có ?local=1.
   ========================================================================= */

const APP_VERSION = 11;
const MAX_AMOUNT = 100000000000; // 100 tỷ ₫ [D-01]
const MIN_PW_LEN = 8;            // [S-04]
const PBKDF2_ITER = 250000;      // [S-04, 8.3]
const WRITE_TIMEOUT_MS = 15000;  // [C-07, K9]

// PEOPLE: fallback cứng chỉ dùng khi chưa có dữ liệu `users` nào tải về
const PEOPLE = {
  duy:    { username:'duy',    name:'Duy',    role:'ADMIN' },
  nguyen: { username:'nguyen', name:'Nguyen', role:'USER'  },
};
const CATEGORIES = ['Food','Drinks','Transport','Entertainment','Shopping','Bills','Other'];
const CAT_VI = {Food:'Ăn uống',Drinks:'Đồ uống',Transport:'Di chuyển',Entertainment:'Giải trí',Shopping:'Mua sắm',Bills:'Hóa đơn',Other:'Khác'};

/* ===== V4 · [K8] Tiện ích định dạng tiền, thời gian địa phương, ID & chuỗi ===== */
const _vndFmt = new Intl.NumberFormat('vi-VN');
const vnd = n => {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return '—';
  const r = Math.round(num);
  return _vndFmt.format(Object.is(r, -0) ? 0 : r) + ' ₫';
};

// [K8, T-01] Ngày/tháng theo giờ địa phương (thay thế hoàn toàn todayISO UTC)
function localISODate(d = new Date()){
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return localISODate(new Date());
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function localMonthKey(d = new Date()){
  return localISODate(d).slice(0, 7);
}
// [T-02] Chuẩn hoá mọi chuỗi ngày ('YYYY-MM-DD' hoặc ISO UTC) về tháng địa phương 'YYYY-MM'
function monthKeyOf(isoOrDate){
  const s = String(isoOrDate || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 7);
  return localMonthKey(d);
}

// [K8, R-06] Lấy ký tự đầu an toàn với Unicode surrogate pairs / emoji
function initial(name){
  const s = String(name || '').trim();
  if (!s) return '?';
  const chars = Array.from(s);
  return chars[0] || '?';
}

// [K8, T-04] Thời gian ISO có cộng độ lệch đồng hồ server Firebase
const now = () => {
  const off = (typeof window !== 'undefined' && window.FIREBASE_STORE && typeof window.FIREBASE_STORE.serverOffset === 'function')
    ? (window.FIREBASE_STORE.serverOffset() || 0) : 0;
  return new Date(Date.now() + off).toISOString();
};

// [K8] Sinh ID ngẫu nhiên an toàn bằng crypto.getRandomValues, khớp ^[a-z0-9]{6,40}$
function rid(){
  const ts = Date.now().toString(36);
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues){
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let tail = '';
  for (let i = 0; i < bytes.length; i++) tail += alphabet[bytes[i] % 36];
  return ts + tail;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el = id => typeof document !== 'undefined' ? document.getElementById(id) : null;

function fmtDate(d){
  if (!d) return '—';
  const s = String(d).trim();
  const x = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s);
  if (Number.isNaN(x.getTime())) return '—';
  return x.toLocaleDateString('vi-VN', {day:'2-digit', month:'short', year:'numeric'});
}
function fmtDT(d){
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return x.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit'}) + ' ' +
         x.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit'});
}
/* ===== /V4 ===== */

/* ===== V4 · [K3] Mô-đun kiểm tra & làm sạch dữ liệu V ===== */
const RESERVED_USERNAMES = new Set([
  '__proto__','constructor','prototype','toString','valueOf','hasOwnProperty',
  'system','admin','root','null','undefined','nan','true','false','local','all'
]);

const V = {
  // [D-01, Phụ lục A.1] Phân tích số tiền nguyên VND nghiêm ngặt
  money(input){
    if (typeof input === 'number'){
      if (!Number.isSafeInteger(input)) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
      if (input <= 0) return { ok:false, value:0, error:'Số tiền phải lớn hơn 0' };
      if (input > MAX_AMOUNT) return { ok:false, value:0, error:'Số tiền vượt giới hạn (tối đa 100 tỷ ₫)' };
      return { ok:true, value:input, error:'' };
    }
    let s = String(input ?? '').trim();
    // Bỏ hậu tố tiền tệ (₫, đ, d, vnd) ở cuối chuỗi
    s = s.replace(/\s*(?:₫|đ|d|vnd)\s*$/i, '').trim();
    if (!s) return { ok:false, value:0, error:'Hãy nhập số tiền' };
    // Chỉ cho phép chữ số ASCII 0-9, khoảng trắng, dấu chấm, dấu phẩy
    if (!/^[0-9., ]+$/.test(s)) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    const hasSpace = s.includes(' ');
    const sepCount = (hasDot ? 1 : 0) + (hasComma ? 1 : 0) + (hasSpace ? 1 : 0);
    if (sepCount > 1) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
    let digits = s;
    if (sepCount === 1){
      const sep = hasDot ? '.' : (hasComma ? ',' : ' ');
      const parts = s.split(sep);
      if (parts.length < 2) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
      if (!/^\d{1,3}$/.test(parts[0])) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
      for (let i = 1; i < parts.length; i++){
        if (!/^\d{3}$/.test(parts[i])) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
      }
      digits = parts.join('');
    } else {
      if (!/^\d+$/.test(digits)) return { ok:false, value:0, error:'Chỉ nhập số nguyên VND' };
    }
    if (digits.length > 15) return { ok:false, value:0, error:'Số tiền vượt giới hạn' };
    const val = Number(digits);
    if (!Number.isSafeInteger(val)) return { ok:false, value:0, error:'Số tiền vượt giới hạn' };
    if (val <= 0) return { ok:false, value:0, error:'Số tiền phải lớn hơn 0' };
    if (val > MAX_AMOUNT) return { ok:false, value:0, error:'Số tiền vượt giới hạn (tối đa 100 tỷ ₫)' };
    return { ok:true, value:val, error:'' };
  },
  // [A-02] Cho phép rỗng hoặc "0" ở các trường hạn mức/mục tiêu tuỳ chọn
  moneyOptional(input){
    const s = String(input ?? '').trim();
    if (!s || s === '0') return { ok:true, value:0, error:'' };
    return V.money(s);
  },
  // [T-03] Kiểm tra ngày YYYY-MM-DD có thật trên lịch và nằm trong khoảng cho phép
  date(str, opts = {}){
    const s = String(str ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok:false, value:'', error:'Ngày không hợp lệ (YYYY-MM-DD)' };
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d){
      return { ok:false, value:'', error:'Ngày không tồn tại trên lịch' };
    }
    const min = opts.min || '2000-01-01';
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 366);
    const max = opts.max || localISODate(maxDate);
    if (s < min || s > max) return { ok:false, value:'', error:`Ngày phải nằm trong khoảng ${min} đến ${max}` };
    return { ok:true, value:s, error:'' };
  },
  month(str){
    const s = String(str ?? '').trim();
    if (!/^\d{4}-\d{2}$/.test(s)) return { ok:false, value:'', error:'Tháng không hợp lệ (YYYY-MM)' };
    const [y, m] = s.split('-').map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) return { ok:false, value:'', error:'Tháng không hợp lệ' };
    return { ok:true, value:s, error:'' };
  },
  // [S-07] Chuẩn hoá NFC, lọc ký tự điều khiển / đảo chiều văn bản / zero-width
  text(str, { max = 80, multiline = false } = {}){
    let s = String(str ?? '');
    if (typeof s.normalize === 'function') s = s.normalize('NFC');
    // Bỏ ký tự điều khiển (trừ \n nếu multiline), ký tự bidi U+202A-202E, U+2066-2069, zero-width U+200B-200D, U+FEFF
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '');
    if (multiline){
      s = s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } else {
      s = s.replace(/\s+/g, ' ').trim();
    }
    if (s.length > max) s = Array.from(s).slice(0, max).join('');
    return s;
  },
  // [S-07, Phụ lục A.2] Quy tắc cho tài khoản MỚI (tài khoản cũ đã tồn tại vẫn cho đăng nhập)
  username(str){
    const s = String(str ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]{2,20}$/.test(s)){
      return { ok:false, value:'', error:'Tên đăng nhập mới chỉ gồm chữ thường a-z và số 0-9 (2–20 ký tự, không có dấu gạch dưới).' };
    }
    if (RESERVED_USERNAMES.has(s)){
      return { ok:false, value:'', error:'Tên đăng nhập này thuộc danh sách hệ thống, vui lòng chọn tên khác.' };
    }
    return { ok:true, value:s, error:'' };
  },
  id(str){
    const s = String(str ?? '').trim();
    const ok = /^[a-z0-9_]{1,64}$/i.test(s) && !RESERVED_USERNAMES.has(s.toLowerCase());
    return { ok, value: ok ? s : '' };
  },
  enum(v, list){
    return list.includes(v);
  },
  // [F-09, R-02] Chuỗi không dấu phục vụ tìm kiếm tiếng Việt
  fold(str){
    let s = String(str ?? '');
    if (typeof s.normalize === 'function') s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
  }
};

// Lớp bọc tương thích ngược cho parseAmount [D-01]
function parseAmount(v){
  const r = V.money(v);
  return r.ok ? r.value : 0;
}
/* ===== /V4 ===== */
/* ===== V4 · [K4, D-09, D-10] Tiện ích cặp Pair, chia tiền & Chuẩn hoá bản ghi Norm ===== */
function makePairId(a, b){
  return [String(a || '').trim().toLowerCase(), String(b || '').trim().toLowerCase()].sort().join('_');
}

const Pair = {
  id(a, b){ return makePairId(a, b); },
  // [D-09] Một nguồn duy nhất để tách pair_id, chịu được username cũ có dấu '_'
  members(pid){
    const s = String(pid || 'duy_nguyen').trim();
    const known = u => !!(u && ((Data && Data.usersById && Object.prototype.hasOwnProperty.call(Data.usersById, u)) || Object.prototype.hasOwnProperty.call(PEOPLE, u)));
    const idxs = [];
    for (let i = 1; i < s.length - 1; i++){
      if (s[i] === '_') idxs.push(i);
    }
    if (!idxs.length) return ['duy', 'nguyen'];
    if (idxs.length === 1){
      return [s.slice(0, idxs[0]), s.slice(idxs[0] + 1)];
    }
    // Ưu tiên vị trí tách mà cả 2 vế đều là username đã biết và sắp xếp đúng thứ tự
    for (const pos of idxs){
      const left = s.slice(0, pos), right = s.slice(pos + 1);
      if (known(left) && known(right) && left <= right) return [left, right];
    }
    for (const pos of idxs){
      const left = s.slice(0, pos), right = s.slice(pos + 1);
      if (known(left) && known(right)) return [left, right];
    }
    for (const pos of idxs){
      const left = s.slice(0, pos), right = s.slice(pos + 1);
      if (known(left) || known(right)) return [left, right];
    }
    return [s.slice(0, idxs[0]), s.slice(idxs[0] + 1)];
  }
};

const other = u => {
  if (peer && (u === me?.username || u === peer)) return u === me.username ? peer : me.username;
  return u === 'duy' ? 'nguyen' : 'duy';
};
function otherOf(u, pairId){
  const [a, b] = Pair.members(pairId || 'duy_nguyen');
  return u === a ? b : a;
}
const nameOf = u => {
  if (!u) return '—';
  const rec = (Data && Data.usersById && Object.prototype.hasOwnProperty.call(Data.usersById, u)) ? Data.usersById[u] : null;
  const p = Object.prototype.hasOwnProperty.call(PEOPLE, u) ? PEOPLE[u] : null;
  return (rec && rec.name) || (p && p.name) || String(u);
};

// Quy tắc chia bất biến: người ứng tiền nhận phần lẻ (ceil), người còn lại floor.
function split(amount, paidBy, pairId){
  const raw = Number(amount);
  const a = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const payer = Math.ceil(a / 2), rest = a - payer;
  const partner = otherOf(paidBy, pairId);
  return { [paidBy]: payer, [partner]: rest };
}
const pairIdOf = t => (t && t.pair_id) ? t.pair_id : 'duy_nguyen';
const owedOf = t => {
  if (!t) return 0;
  const pid = pairIdOf(t);
  return split(t.amount, t.paid_by, pid)[otherOf(t.paid_by, pid)] || 0;
};
const remainOf = t => {
  if (!t) return 0;
  const rep = Number.isFinite(Number(t.repaid)) ? Math.max(0, Math.trunc(Number(t.repaid))) : 0;
  return Math.max(0, owedOf(t) - rep);
};
function statusOf(t){
  const r = remainOf(t);
  const rep = Number.isFinite(Number(t?.repaid)) ? Math.max(0, Math.trunc(Number(t.repaid))) : 0;
  if (r === 0) return 'SETTLED';
  if (rep > 0) return 'PARTIALLY_SETTLED';
  return 'OPEN';
}
const STATUS_VI = {OPEN:'Chưa trả',PARTIALLY_SETTLED:'Trả một phần',SETTLED:'Đã xong'};

// [K4, D-10] Chuẩn hoá bản ghi khi đọc từ DB (tuyệt đối KHÔNG ghi ngược bản ghi đã chuẩn hoá vào DB)
const ROLES = ['ADMIN','SSS_VIP','VIP','USER'];
const roleValid = r => ROLES.includes(r) ? r : 'USER';

const Norm = {
  user(row){
    if (!row || typeof row !== 'object') return null;
    const id = String(row.id || row.username || '').trim().toLowerCase();
    return {
      ...row,
      id,
      username: id,
      name: String(row.name || id),
      role: roleValid(row.role),
      must_change_pw: !!row.must_change_pw,
      group_quota_used: Number.isFinite(Number(row.group_quota_used)) ? Math.max(0, Math.trunc(Number(row.group_quota_used))) : 0
    };
  },
  txn(row){
    if (!row || typeof row !== 'object') return null;
    const reasons = [];
    const pid = String(row.pair_id || 'duy_nguyen').trim();
    const [pa, pb] = Pair.members(pid);
    const amt = Number(row.amount);
    if (!Number.isSafeInteger(amt) || amt <= 0 || amt > MAX_AMOUNT) reasons.push('amount_invalid');
    const paidBy = String(row.paid_by || '').trim();
    if (paidBy !== pa && paidBy !== pb) reasons.push('paid_by_outside_pair');
    const rawRepaid = row.repaid === undefined || row.repaid === null ? 0 : Number(row.repaid);
    const repaid = Number.isFinite(rawRepaid) ? Math.max(0, Math.trunc(rawRepaid)) : 0;
    if (!Number.isSafeInteger(rawRepaid) || rawRepaid < 0) reasons.push('repaid_invalid');
    const owed = (Number.isSafeInteger(amt) && amt > 0) ? Math.floor(amt / 2) : 0;
    if (owed > 0 && repaid > owed) reasons.push('repaid_exceeds_owed');
    const cat = CATEGORIES.includes(row.category) ? row.category : 'Other';
    return {
      ...row,
      title: String(row.title ?? '—'),
      category: cat,
      amount: Number.isSafeInteger(amt) && amt > 0 ? amt : 0,
      paid_by: paidBy,
      pair_id: pid,
      repaid,
      note: String(row.note ?? ''),
      date: String(row.date || (row.created_at ? String(row.created_at).slice(0, 10) : '')),
      applied_settlements: (row.applied_settlements && typeof row.applied_settlements === 'object') ? row.applied_settlements : {},
      pending_sid: row.pending_sid || null,
      _invalid: reasons.length ? reasons : null
    };
  },
  settlement(row){
    if (!row || typeof row !== 'object') return null;
    const reasons = [];
    const amt = Number(row.amount);
    if (!Number.isSafeInteger(amt) || amt <= 0 || amt > MAX_AMOUNT) reasons.push('amount_invalid');
    const st = row.status || 'CONFIRMED';
    if (!['PENDING','CONFIRMED','REJECTED'].includes(st)) reasons.push('status_invalid');
    return {
      ...row,
      pair_id: String(row.pair_id || 'duy_nguyen').trim(),
      amount: Number.isSafeInteger(amt) && amt > 0 ? amt : 0,
      status: ['PENDING','CONFIRMED','REJECTED'].includes(st) ? st : 'CONFIRMED',
      note: String(row.note ?? ''),
      _invalid: reasons.length ? reasons : null
    };
  },
  friendship(row){
    if (!row || typeof row !== 'object') return null;
    const ua = String(row.user_a || '').trim().toLowerCase();
    const ub = String(row.user_b || '').trim().toLowerCase();
    const expectedId = (ua && ub) ? Pair.id(ua, ub) : '';
    const reasons = [];
    if (!ua || !ub || ua === ub || (row.id && row.id !== expectedId)) reasons.push('friendship_id_mismatch');
    return {
      ...row,
      user_a: ua,
      user_b: ub,
      status: row.status === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING',
      _invalid: reasons.length ? reasons : null
    };
  },
  group(row){
    if (!row || typeof row !== 'object') return null;
    return {
      ...row,
      name: String(row.name ?? 'Nhóm'),
      members: (row.members && typeof row.members === 'object') ? row.members : {}
    };
  },
  groupTxn(row){
    if (!row || typeof row !== 'object') return null;
    const reasons = [];
    const amt = Number(row.amount);
    if (!Number.isSafeInteger(amt) || amt <= 0 || amt > MAX_AMOUNT) reasons.push('amount_invalid');
    const shares = (row.shares && typeof row.shares === 'object') ? row.shares : {};
    const sumShares = Object.values(shares).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0), 0);
    if (Number.isSafeInteger(amt) && amt > 0 && sumShares !== amt) reasons.push('shares_sum_mismatch');
    return {
      ...row,
      title: String(row.title ?? '—'),
      amount: Number.isSafeInteger(amt) && amt > 0 ? amt : 0,
      category: CATEGORIES.includes(row.category) ? row.category : 'Other',
      participants: (row.participants && typeof row.participants === 'object') ? row.participants : {},
      shares,
      paid_status: (row.paid_status && typeof row.paid_status === 'object') ? row.paid_status : {},
      _invalid: reasons.length ? reasons : null
    };
  },
  saving(row){
    if (!row || typeof row !== 'object') return null;
    const t = Number(row.target_amount || 0);
    return {
      ...row,
      name: String(row.name ?? 'Mục tiêu'),
      target_amount: Number.isFinite(t) && t > 0 ? Math.trunc(t) : 0,
      note: String(row.note ?? ''),
      closed: !!row.closed
    };
  },
  entry(row){
    if (!row || typeof row !== 'object') return null;
    const amt = Number(row.amount);
    const type = row.type === 'WITHDRAW' ? 'WITHDRAW' : (row.type === 'DEPOSIT' ? 'DEPOSIT' : 'INVALID');
    const reasons = [];
    if (!Number.isSafeInteger(amt) || amt <= 0) reasons.push('amount_invalid');
    if (type === 'INVALID') reasons.push('type_invalid');
    return {
      ...row,
      amount: Number.isSafeInteger(amt) && amt > 0 ? amt : 0,
      type: type === 'INVALID' ? 'DEPOSIT' : type,
      note: String(row.note ?? ''),
      _invalid: reasons.length ? reasons : null
    };
  },
  budget(row){
    if (!row || typeof row !== 'object') return null;
    const lim = Number(row.limit_amount || 0);
    return {
      ...row,
      limit_amount: Number.isFinite(lim) && lim > 0 ? Math.trunc(lim) : 0
    };
  }
};
/* ===== /V4 ===== */

/* ===== V4 · [K2, K7, B-01, C-07] Lớp Store mở rộng, khoá once() & biên lỗi ===== */
const LS = 'sochung.v1';
const _diagErrors = [];
function recordDiagError(ctx, err){
  const msg = err && (err.message || err.code || String(err));
  _diagErrors.unshift({ at: now(), ctx: String(ctx || 'app'), msg: String(msg || 'Lỗi không xác định') });
  if (_diagErrors.length > 20) _diagErrors.length = 20;
}

function friendlyError(e){
  const code = String((e && (e.code || e.message)) || '').toLowerCase();
  if (code.includes('timeout')) return 'Chưa xác nhận được do mạng chậm, vui lòng kiểm tra lại sau.';
  if (code.includes('permission') || code.includes('denied')) return 'Bạn không có quyền thực hiện thao tác này.';
  if (code.includes('network') || code.includes('offline') || code.includes('unavailable')) return 'Mất kết nối mạng, vui lòng thử lại.';
  if (e && e.userMsg) return e.userMsg;
  return 'Có lỗi xảy ra, vui lòng thử lại.';
}

let _toastTimer = 0;
function toast(msg){
  const r = el('toastRoot');
  if (!r) return;
  if (_toastTimer) clearTimeout(_toastTimer);
  r.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  _toastTimer = setTimeout(() => { r.innerHTML = ''; _toastTimer = 0; }, 2800);
}

const _inflight = new Set();
async function once(key, fn, btn){
  if (_inflight.has(key)) return;
  _inflight.add(key);
  if (btn && typeof btn === 'object'){
    btn.disabled = true;
    if (btn.setAttribute) btn.setAttribute('aria-busy', 'true');
  }
  try {
    return await fn();
  } catch (e){
    console.error('[once]', key, e);
    recordDiagError(key, e);
    toast(friendlyError(e));
  } finally {
    _inflight.delete(key);
    if (btn && typeof btn === 'object'){
      btn.disabled = false;
      if (btn.removeAttribute) btn.removeAttribute('aria-busy');
    }
  }
}

if (typeof window !== 'undefined'){
  window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled rejection:', e.reason);
    recordDiagError('unhandledrejection', e.reason);
  });
  window.addEventListener('error', e => {
    console.error('Global error:', e.error || e.message);
    recordDiagError('window.error', e.error || e.message);
  });
}

// Lọc bỏ undefined và từ chối NaN/Infinity trước khi ghi vào Firebase [3.5, K2]
function sanitizeForFirebase(val){
  if (val === undefined) return undefined;
  if (val === null || typeof val === 'boolean' || typeof val === 'string') return val;
  if (typeof val === 'number'){
    if (!Number.isFinite(val)) throw Object.assign(new Error('Invalid number'), { userMsg:'Dữ liệu số không hợp lệ.' });
    return Object.is(val, -0) ? 0 : val;
  }
  if (Array.isArray(val)){
    return val.map(v => sanitizeForFirebase(v)).filter(v => v !== undefined);
  }
  if (typeof val === 'object'){
    const out = {};
    for (const [k, v] of Object.entries(val)){
      if (v === undefined) continue;
      if (/[.$#[\]/]/.test(k)) throw Object.assign(new Error('Invalid key: ' + k), { userMsg:'Khoá dữ liệu chứa ký tự không hợp lệ.' });
      out[k] = sanitizeForFirebase(v);
    }
    return out;
  }
  return undefined;
}

function withWriteTimeout(promise){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error('WRITE_TIMEOUT'), { code:'timeout', userMsg:'Chưa xác nhận được do mất mạng, hãy kiểm tra lại sau.' }));
    }, WRITE_TIMEOUT_MS);
    promise.then(
      res => { clearTimeout(t); resolve(res); },
      err => { clearTimeout(t); reject(err); }
    );
  });
}

function isLocalModeAllowed(){
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('local') === '1';
  } catch (_){ return false; }
}

const Store = {
  db: null,
  online: true,
  bootError: null,
  local: {
    txns:{}, settlements:{}, activity:{}, config:{}, users:{}, friendships:{}, messages:{},
    groups:{}, group_txns:{}, savings:{}, savings_entries:{}, budgets:{}, trash:{}
  },
  async init(){
    this.bootError = null;
    try { this.db = await claude.use('db'); } catch(_){ this.db = null; }
    if (!this.db && typeof window !== 'undefined'){
      if (window.FIREBASE_READY){
        try {
          await Promise.race([
            window.FIREBASE_READY,
            new Promise(r => setTimeout(() => r(false), 8000))
          ]);
        } catch(_){}
      }
      if (window.FIREBASE_STORE && !window.FIREBASE_ERROR){
        this.db = window.FIREBASE_STORE;
      }
    }
    if (!this.db){
      if (isLocalModeAllowed()){
        try { this.local = JSON.parse(localStorage.getItem(LS)) || this.local; } catch(_){}
        return true;
      }
      this.bootError = (typeof window !== 'undefined' && window.FIREBASE_ERROR)
        ? window.FIREBASE_ERROR
        : new Error('Không thể kết nối tới cơ sở dữ liệu Firebase.');
      return false;
    }
    if (typeof this.db.onConnection === 'function'){
      this.db.onConnection(ok => {
        const changed = this.online !== ok;
        this.online = ok;
        if (changed) updateConnectionUI(ok);
      });
    }
    return true;
  },
  _flush(){
    if (!isLocalModeAllowed()) return;
    try { localStorage.setItem(LS, JSON.stringify(this.local)); } catch(_){}
  },
  _localGetPath(path){
    const parts = String(path).split('/').filter(Boolean);
    let cur = this.local;
    for (const p of parts){
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur === undefined ? null : JSON.parse(JSON.stringify(cur));
  },
  _localSetPath(path, val){
    const parts = String(path).split('/').filter(Boolean);
    let cur = this.local;
    for (let i = 0; i < parts.length - 1; i++){
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (val === null || val === undefined) delete cur[last];
    else cur[last] = JSON.parse(JSON.stringify(val));
  },
  async get(path){
    if (this.db) return this.db.doc(path).get();
    const v = this._localGetPath(path);
    return { exists: v !== null && v !== undefined, data: v };
  },
  async set(col, id, data){
    const clean = sanitizeForFirebase(data);
    const path = id !== undefined ? `${col}/${id}` : col;
    if (this.db) return withWriteTimeout(this.db.doc(path).set(clean));
    this._localSetPath(path, clean);
    this._flush();
    Data.reload();
  },
  async update(path, part){
    const clean = {};
    for (const [k, v] of Object.entries(part || {})){
      if (v === undefined) continue;
      clean[k] = v === null ? null : sanitizeForFirebase(v);
    }
    if (this.db){
      if (typeof this.db.doc(path).update === 'function'){
        return withWriteTimeout(this.db.doc(path).update(clean));
      }
      const cur = await this.db.doc(path).get();
      const merged = { ...(cur.exists ? cur.data : {}) };
      for (const [k, v] of Object.entries(clean)){
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      return withWriteTimeout(this.db.doc(path).set(merged));
    }
    const existing = this._localGetPath(path) || {};
    for (const [k, v] of Object.entries(clean)){
      if (v === null) delete existing[k];
      else existing[k] = v;
    }
    this._localSetPath(path, existing);
    this._flush();
    Data.reload();
  },
  async del(col, id){
    const path = id !== undefined ? `${col}/${id}` : col;
    if (this.db) return withWriteTimeout(this.db.doc(path).delete());
    this._localSetPath(path, null);
    this._flush();
    Data.reload();
  },
  async tx(path, fn){
    if (this.db && typeof this.db.doc(path).transaction === 'function'){
      return withWriteTimeout(this.db.doc(path).transaction(cur => {
        const next = fn(cur);
        return next === undefined ? undefined : (next === null ? null : sanitizeForFirebase(next));
      }));
    }
    // Fallback cho mock/local mode hoặc adapter cũ
    const snap = await this.get(path);
    const cur = snap.exists ? snap.data : null;
    let next = fn(cur);
    // Theo luật Firebase 3.5: lần gọi đầu với null có thể trả về null để yêu cầu đọc giá trị thật
    if (cur === null && next === null && snap.exists){
      next = fn(snap.data);
    }
    if (next === undefined){
      return { committed: false, exists: snap.exists, data: cur };
    }
    const clean = next === null ? null : sanitizeForFirebase(next);
    if (this.db){
      if (clean === null) await withWriteTimeout(this.db.doc(path).delete());
      else await withWriteTimeout(this.db.doc(path).set(clean));
    } else {
      this._localSetPath(path, clean);
      this._flush();
      Data.reload();
    }
    return { committed: true, exists: clean !== null, data: clean };
  },
  async createIfAbsent(path, value){
    const clean = sanitizeForFirebase(value);
    if (this.db && typeof this.db.doc(path).transaction === 'function'){
      let seenExisting = false;
      const res = await withWriteTimeout(this.db.doc(path).transaction(cur => {
        if (cur !== null && cur !== undefined){
          seenExisting = true;
          return undefined;
        }
        return clean;
      }));
      return { created: !!(res.committed && !seenExisting), data: res.data };
    }
    const snap = await this.get(path);
    if (snap.exists && snap.data !== null) return { created: false, data: snap.data };
    if (this.db) await withWriteTimeout(this.db.doc(path).set(clean));
    else { this._localSetPath(path, clean); this._flush(); Data.reload(); }
    return { created: true, data: clean };
  },
  async multi(map){
    const cleanMap = {};
    for (const [p, v] of Object.entries(map || {})){
      if (v === undefined) continue;
      cleanMap[p] = v === null ? null : sanitizeForFirebase(v);
    }
    if (this.db && typeof this.db.multi === 'function'){
      return withWriteTimeout(this.db.multi(cleanMap));
    }
    for (const [p, v] of Object.entries(cleanMap)){
      this._localSetPath(p, v);
    }
    this._flush();
    Data.reload();
  },
  watch(col, cb){
    if (this.db){
      return this.db.collection(col).onSnapshot(
        s => cb(s.docs.map(d => ({ id:d.id, ...(d.data && typeof d.data === 'object' ? d.data : { _primitive: d.data }) }))),
        e => { recordDiagError('watch:' + col, e); toast('Lỗi tải dữ liệu: ' + (e.code || 'mạng')); }
      );
    }
    cb(Object.entries(this.local[col] || {}).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : { _primitive: v }) })));
    return () => {};
  }
};
/* ===== /V4 ===== */
/* ===== V4 · [K10, R-08] Trạng thái Data, chỉ mục dẫn xuất Idx & quản lý vòng đời ===== */
const ESSENTIAL_COLS = ['users','friendships','txns','settlements'];
const ALL_WATCH_COLS = ['txns','settlements','activity','groups','group_txns','savings','savings_entries','budgets','users','friendships','messages','trash','config'];

const Data = {
  txns:[], settlements:[], activity:[], users:[], usersById:Object.create(null),
  friendships:[], messages:[], config:Object.create(null), ready:false,
  groups:[], group_txns:[], savings:[], savings_entries:[], budgets:[], trash:[],
  loaded:Object.create(null)
};

const Idx = {
  txnById: Object.create(null),
  settlementsByTxn: Object.create(null),
  pendingByTxn: Object.create(null),
  txnsByPair: Object.create(null),
  groupById: Object.create(null),
  usersById: Object.create(null),
  trashById: Object.create(null)
};

let me = null;
let mustChangePw = false;
let peer = null;
let chatOpen = false;
let chatThread = null;
let route = { path:'dashboard', param:null };
let uiFilter = { status:'ALL', q:'', sort:'new', month:'ALL', budgetMonth:'' };
let _unsubs = [];
let _backupDownloadedThisSession = false;

function rebuildIdx(){
  const txnById = Object.create(null);
  const settlementsByTxn = Object.create(null);
  const pendingByTxn = Object.create(null);
  const txnsByPair = Object.create(null);
  const groupByIdMap = Object.create(null);
  const trashById = Object.create(null);

  for (const t of Data.txns){
    if (!t || !t.id) continue;
    txnById[t.id] = t;
    if (t._invalid) continue;
    const pid = pairIdOf(t);
    if (!txnsByPair[pid]) txnsByPair[pid] = [];
    txnsByPair[pid].push(t);
  }
  for (const s of Data.settlements){
    if (!s || !s.id || s._invalid) continue;
    const tid = s.transaction_id;
    if (tid){
      if (!settlementsByTxn[tid]) settlementsByTxn[tid] = [];
      settlementsByTxn[tid].push(s);
      if ((s.status || 'CONFIRMED') === 'PENDING' && !pendingByTxn[tid]){
        pendingByTxn[tid] = s;
      }
    }
  }
  for (const g of Data.groups){
    if (g && g.id) groupByIdMap[g.id] = g;
  }
  for (const tr of Data.trash){
    if (tr && tr.id) trashById[tr.id] = tr;
    if (tr && tr.original_id) trashById[tr.original_id] = tr;
  }
  Idx.txnById = txnById;
  Idx.settlementsByTxn = settlementsByTxn;
  Idx.pendingByTxn = pendingByTxn;
  Idx.txnsByPair = txnsByPair;
  Idx.groupById = groupByIdMap;
  Idx.usersById = Data.usersById;
  Idx.trashById = trashById;
}

function applyUsers(rows){
  const normRows = (rows || []).map(r => Norm.user(r)).filter(Boolean);
  Data.users = normRows;
  const map = Object.create(null);
  for (const r of normRows){
    if (r.id) map[r.id] = r;
  }
  Data.usersById = map;
  Idx.usersById = map;
  if (me && map[me.username]){
    const fresh = map[me.username];
    // [S-03] Nếu mật khẩu vừa bị đổi trên thiết bị khác (pw_changed_at mới hơn phiên hiện tại) -> đăng xuất
    const sess = readSession();
    if (fresh.pw_changed_at && sess && sess.at && Date.parse(fresh.pw_changed_at) > sess.at + 2000){
      toast('Mật khẩu đã thay đổi, vui lòng đăng nhập lại.');
      logout();
      return;
    }
    me = { ...me, ...fresh };
  }
}

function applyCollection(col, rawRows){
  const rows = Array.isArray(rawRows) ? rawRows : [];
  if (col === 'users'){
    applyUsers(rows);
  } else if (col === 'txns'){
    Data.txns = rows.map(r => Norm.txn(r)).filter(Boolean);
  } else if (col === 'settlements'){
    Data.settlements = rows.map(r => Norm.settlement(r)).filter(Boolean);
  } else if (col === 'friendships'){
    Data.friendships = rows.map(r => Norm.friendship(r)).filter(Boolean);
  } else if (col === 'groups'){
    Data.groups = rows.map(r => Norm.group(r)).filter(Boolean);
  } else if (col === 'group_txns'){
    Data.group_txns = rows.map(r => Norm.groupTxn(r)).filter(Boolean);
  } else if (col === 'savings'){
    Data.savings = rows.map(r => Norm.saving(r)).filter(Boolean);
  } else if (col === 'savings_entries'){
    Data.savings_entries = rows.map(r => Norm.entry(r)).filter(Boolean);
  } else if (col === 'budgets'){
    Data.budgets = rows.map(r => Norm.budget(r)).filter(Boolean);
  } else if (col === 'config'){
    const cfg = Object.create(null);
    for (const r of rows){
      if (!r || !r.id) continue;
      const copy = { ...r }; delete copy.id;
      cfg[r.id] = copy;
    }
    Data.config = cfg;
    checkMinClientVersion();
  } else {
    Data[col] = rows;
  }
  Data.loaded[col] = true;
  if (!Data.ready && ESSENTIAL_COLS.every(c => Data.loaded[c])){
    Data.ready = true;
  }
  rebuildIdx();
}

function reload(){ Data.reload(); }
Data.reload = () => {
  if (!Store.db){
    ['txns','settlements','activity','groups','group_txns','savings','savings_entries','budgets','friendships','messages','trash','users','config'].forEach(c => {
      const list = Object.entries(Store.local[c] || {}).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : { _primitive: v }) }));
      applyCollection(c, list);
    });
  }
  scheduleRender();
};
/* ===== /V4 ===== */

/* ===== V4 · [K5, S-02] Cơ chế uỷ quyền sự kiện thay thế hoàn toàn on*="..." nội tuyến ===== */
const ACTIONS = Object.create(null);
function registerActions(map){
  Object.assign(ACTIONS, map);
}
const A = (name, ...args) =>
  `data-act="${esc(name)}" data-args="${esc(JSON.stringify(args))}"`;

/* ---------------- pairwise sổ chung ---------------- */
const currentPairId = () => peer ? makePairId(me.username, peer) : null;
const myTxns = () => {
  const p = currentPairId();
  if (!p) return [];
  if (Idx.txnsByPair && Idx.txnsByPair[p]) return Idx.txnsByPair[p];
  return Data.txns.filter(t => !t._invalid && pairIdOf(t) === p);
};
const mySettlements = () => {
  const p = currentPairId();
  return p ? Data.settlements.filter(s => !s._invalid && pairIdOf(s) === p) : [];
};
function acceptedFriends(){
  if (!me) return [];
  return Data.friendships.filter(f => !f._invalid && f.status === 'ACCEPTED' && !f.ended_at &&
    (f.user_a === me.username || f.user_b === me.username))
    .map(f => f.user_a === me.username ? f.user_b : f.user_a);
}
function isActiveFriend(u){
  if (!me || !u) return false;
  const id = makePairId(me.username, u);
  const f = Data.friendships.find(x => !x._invalid && x.id === id);
  return !!f && f.status === 'ACCEPTED' && !f.ended_at;
}
function endedFriends(){
  if (!me) return [];
  return Data.friendships.filter(f => !f._invalid && f.status === 'ACCEPTED' && f.ended_at &&
    (f.user_a === me.username || f.user_b === me.username))
    .map(f => f.user_a === me.username ? f.user_b : f.user_a);
}
function pendingIncoming(){
  if (!me) return [];
  return Data.friendships.filter(f => !f._invalid && f.status === 'PENDING' && f.requested_by !== me.username &&
    (f.user_a === me.username || f.user_b === me.username));
}
function pendingOutgoing(){
  if (!me) return [];
  return Data.friendships.filter(f => !f._invalid && f.status === 'PENDING' && f.requested_by === me.username);
}
function savePeer(u){ try{ localStorage.setItem('sochung.peer.' + me.username, u || ''); }catch(_){} }
function loadPeer(){ try{ return localStorage.getItem('sochung.peer.' + me.username) || null; }catch(_){ return null; } }
function switchPeer(u){
  if (!u || (!isActiveFriend(u) && !endedFriends().includes(u))) return;
  peer = u;
  savePeer(u);
  go('dashboard');
  route = { path:'dashboard', param:null };
  scheduleRender({ forceMain:true });
}
function maybeAutoSelectPeer(){
  if (!me) return;
  const fr = acceptedFriends();
  const ended = endedFriends();
  if (peer && !fr.includes(peer) && !ended.includes(peer)) peer = null;
  if (!peer){
    const stored = loadPeer();
    if (stored && fr.includes(stored)) peer = stored;
    else if (fr.length === 1) peer = fr[0];
  }
}

/* ---------------- nhắn tin (chỉ giữa bạn bè ACCEPTED) [L-05, U-18, K6] ---------------- */
let _lastChatMsgAt = 0;
let _chatMsgTimestamps = [];
let _lastRenderedChatKey = '';

function threadMessages(u){
  const tid = makePairId(me.username, u);
  return Data.messages.filter(m => m && m.thread_id === tid)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}
function unreadCount(u){
  const tid = makePairId(me.username, u);
  return Data.messages.filter(m => m && m.thread_id === tid && m.to === me.username && !m.read).length;
}
function totalUnread(){ return acceptedFriends().reduce((a, u) => a + unreadCount(u), 0); }

// [C-01, L-05] Đánh dấu đã đọc 1 lần bằng Store.multi(), ngoài hàm vẽ và chỉ khi tab đang hiển thị
async function markThreadRead(u){
  if (!me || !u || !chatOpen || chatThread !== u) return;
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
  const tid = makePairId(me.username, u);
  const unread = Data.messages.filter(m => m && m.id && m.thread_id === tid && m.to === me.username && !m.read);
  if (!unread.length) return;
  const map = {};
  for (const m of unread){
    map[`messages/${m.id}/read`] = true;
    m.read = true;
  }
  try { await Store.multi(map); } catch (e){ recordDiagError('markThreadRead', e); }
}

function openChat(){
  chatOpen = true;
  const fr = acceptedFriends();
  if (!chatThread && fr.length === 1) chatThread = fr[0];
  _lastRenderedChatKey = '';
  renderChat();
  if (chatThread) markThreadRead(chatThread);
}
function closeChat(){
  chatOpen = false;
  chatThread = null;
  _lastRenderedChatKey = '';
  renderChat();
}
function backToThreads(){
  chatThread = null;
  _lastRenderedChatKey = '';
  renderChat();
}
function openThread(u){
  chatThread = u;
  _lastRenderedChatKey = '';
  renderChat();
  markThreadRead(u);
}

// [L-05] Gửi tin nhắn: giới hạn 2000 ký tự, rate-limit, chỉ xoá ô nhập sau khi ghi thành công
async function sendMessage(_arg, ctx){
  const btn = ctx && ctx.node ? ctx.node : null;
  return once('sendMessage', async () => {
    const box = el('chatText');
    if (!box || !chatThread) return;
    const text = V.text(box.value, { max:2000, multiline:true });
    if (!text) return;
    if (!acceptedFriends().includes(chatThread)) return toast('Chỉ nhắn tin được với bạn bè đang hoạt động');
    const nowMs = Date.now();
    if (nowMs - _lastChatMsgAt < 400) return toast('Bạn thao tác quá nhanh, vui lòng chờ một chút.');
    _chatMsgTimestamps = _chatMsgTimestamps.filter(t => nowMs - t < 60000);
    if (_chatMsgTimestamps.length >= 30) return toast('Bạn đã gửi tối đa 30 tin nhắn trong 1 phút.');
    const tid = makePairId(me.username, chatThread);
    await Store.set('messages', rid(), {
      thread_id: tid, from: me.username, to: chatThread, text, created_at: now(), read: false
    });
    _lastChatMsgAt = Date.now();
    _chatMsgTimestamps.push(_lastChatMsgAt);
    box.value = '';
    box.style.height = '';
  }, btn);
}

// [U-18] Dựng danh sách bong bóng tin nhắn có phân cách ngày & nhóm tin liên tiếp
function buildChatBubblesHTML(msgs){
  if (!msgs.length){
    return `<div class="empty" style="padding:30px 10px"><b>Chưa có tin nhắn</b>Gửi lời chào đầu tiên.</div>`;
  }
  let html = '';
  let lastDay = '';
  let lastSender = '';
  for (const m of msgs){
    const day = localISODate(m.created_at || new Date());
    if (day !== lastDay){
      html += `<div class="chat-day">${esc(fmtDate(day))}</div>`;
      lastDay = day;
      lastSender = '';
    }
    const isMe = m.from === me.username;
    const grouped = m.from === lastSender ? ' grouped-top' : '';
    lastSender = m.from;
    html += `<div class="bubble ${isMe ? 'me' : 'them'}${grouped}" data-mid="${esc(m.id || '')}">${esc(m.text)}<span class="b-time">${fmtDT(m.created_at)}</span></div>`;
  }
  return html;
}

// [K6, R-02, U-18] Dựng khung chat tăng dần: không thay lại textarea khi đang gõ
function renderChat(){
  const root = el('chatRoot');
  if (!root || !me) return;
  if (!chatOpen){
    if (root.innerHTML) root.innerHTML = '';
    _lastRenderedChatKey = '';
    return;
  }
  const friends = acceptedFriends();
  if (chatThread && !friends.includes(chatThread)) chatThread = null;
  const modeKey = chatThread ? `thread:${chatThread}:${friends.length > 1 ? 1 : 0}` : (friends.length ? 'list' : 'empty');

  if (chatThread){
    const msgs = threadMessages(chatThread);
    // Nếu khung hội thoại của người này đã mở sẵn, chỉ cập nhật #chatMsgs để không mất focus/IME của #chatText
    if (_lastRenderedChatKey === modeKey && el('chatMsgs') && el('chatText')){
      const box = el('chatMsgs');
      const nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 72;
      box.innerHTML = buildChatBubblesHTML(msgs);
      if (nearBottom) box.scrollTop = box.scrollHeight;
      if (msgs.some(m => m.to === me.username && !m.read)){
        setTimeout(() => markThreadRead(chatThread), 0);
      }
      return;
    }
    _lastRenderedChatKey = modeKey;
    const body = `
    <div class="chat-head">
      ${friends.length > 1 ? `<button class="chat-back" type="button" ${A('backToThreads')} aria-label="Quay lại">←</button>` : ''}
      <h3>${esc(nameOf(chatThread))}</h3>
      <button class="x" type="button" ${A('closeChat')} aria-label="Đóng">✕</button>
    </div>
    <div class="chat-msgs" id="chatMsgs">${buildChatBubblesHTML(msgs)}</div>
    <div class="chat-input">
      <textarea class="input" id="chatText" rows="1" maxlength="2000" placeholder="Nhắn tin…" data-on-enter="sendMessage"></textarea>
      <button class="btn primary sm" type="button" ${A('sendMessage')}>Gửi</button>
    </div>`;
    root.innerHTML = `<div class="chat-scrim on" ${A('closeChat')}></div><div class="chat-drawer on">${body}</div>`;
    const box = el('chatMsgs');
    if (box) box.scrollTop = box.scrollHeight;
    if (msgs.some(m => m.to === me.username && !m.read)){
      setTimeout(() => markThreadRead(chatThread), 0);
    }
    return;
  }

  _lastRenderedChatKey = modeKey;
  let body;
  if (!friends.length){
    body = `<div class="chat-head"><h3>Tin nhắn</h3><button class="x" type="button" ${A('closeChat')} aria-label="Đóng">✕</button></div>
    <div class="empty" style="padding:40px 16px"><b>Chưa có bạn bè</b>Kết bạn để bắt đầu nhắn tin.
      <div style="margin-top:12px"><a class="btn sm primary" href="#/friends" ${A('closeChat')}>Đi tới Kết bạn</a></div></div>`;
  } else {
    body = `<div class="chat-head"><h3>Tin nhắn</h3><button class="x" type="button" ${A('closeChat')} aria-label="Đóng">✕</button></div>
    <div class="chat-threads">${friends.map(u => {
      const msgs = threadMessages(u);
      const last = msgs[msgs.length - 1];
      const unread = unreadCount(u);
      return `<div class="chat-thread" tabindex="0" role="button" ${A('openThread', u)}>
        <span class="avatar">${esc(initial(nameOf(u)))}</span>
        <div style="flex:1;min-width:0"><div class="t-name">${esc(nameOf(u))}</div>
        <div class="t-prev">${last ? esc(last.text) : 'Chưa có tin nhắn'}</div></div>
        ${unread ? `<span class="badge">${unread}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  }
  root.innerHTML = `<div class="chat-scrim on" ${A('closeChat')}></div><div class="chat-drawer on">${body}</div>`;
}
/* ---------------- derived ---------------- */
const sortedList = list => [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
const sortedTxns = () => sortedList(Data.txns.filter(t => !t._invalid));
const sortedMyTxns = () => sortedList(myTxns());

// Net balance trong sổ đang mở: dương = peer nợ tôi; âm = tôi nợ peer.
function netBalance(){
  if (!me || !peer) return 0;
  let net = 0;
  for (const t of myTxns()){
    if (t._invalid) continue;
    const r = remainOf(t);
    net += (t.paid_by === me.username) ? r : -r;
  }
  return net;
}
function balanceText(){
  const n = netBalance();
  if (n === 0 || !peer) return { debtor:null, creditor:null, amount:0, text:'Đã cân bằng' };
  const debtor = n > 0 ? peer : me.username;
  return {
    debtor,
    creditor: other(debtor),
    amount: Math.abs(n),
    text: `${nameOf(debtor)} nợ ${nameOf(other(debtor))}`
  };
}
function myStats(){
  let paid = 0, share = 0, total = 0, iOwe = 0, owedMe = 0;
  const list = myTxns().filter(t => !t._invalid);
  for (const t of list){
    total += t.amount;
    const s = split(t.amount, t.paid_by, pairIdOf(t));
    share += (s[me.username] || 0);
    if (t.paid_by === me.username){ paid += t.amount; owedMe += remainOf(t); }
    else iOwe += remainOf(t);
  }
  return { count:list.length, total, paid, share, iOwe, owedMe };
}

/* ---------------- permissions ---------------- */
const isAdmin = () => !!(me && roleValid(me.role) === 'ADMIN');

const ROLE_VI = { ADMIN:'Quản trị viên', SSS_VIP:'SSS VIP', VIP:'VIP', USER:'Thường' };
const ROLE_DESC = {
  ADMIN:   'Toàn quyền, kể cả nâng/hạ cấp và tạo tài khoản mọi cấp.',
  SSS_VIP: 'Toàn quyền dùng, tạo được tài khoản VIP/Thường, nâng/hạ cấp VIP/Thường.',
  VIP:     'Toàn quyền dùng mọi tính năng, tạo nhóm không giới hạn.',
  USER:    'Sổ chung, kết bạn, nhắn tin; tối đa 2 nhóm; chưa dùng được Thống kê, Sổ tiết kiệm, Ngân sách.',
};
const ROLE_GROUP_LIMIT = { USER: 2 };
const PREMIUM_PAGES = ['stats','savings','budget'];
const myRole = () => me ? roleValid(me.role) : 'USER';
const hasPremium = () => myRole() !== 'USER';
const lockedPage = p => PREMIUM_PAGES.includes(p) && !hasPremium();
const canManageUsers = () => myRole() === 'ADMIN' || myRole() === 'SSS_VIP';
const assignableRoles = () => myRole() === 'ADMIN' ? [...ROLES] : (myRole() === 'SSS_VIP' ? ['VIP','USER'] : []);

function canChangeRoleOf(target){
  if (!target) return false;
  const r = myRole(), tr = roleValid(target.role);
  if (r === 'ADMIN') return true;
  if (r === 'SSS_VIP') return tr === 'VIP' || tr === 'USER';
  return false;
}
// [F-02] Quyền đặt lại mật khẩu: ADMIN cho mọi tài khoản, SSS_VIP cho tài khoản VIP/USER
function canResetPwOf(target){
  return canChangeRoleOf(target);
}
const groupLimit = () => ROLE_GROUP_LIMIT[myRole()];
const groupQuotaUsed = () => Math.max((me && me.group_quota_used) || 0,
  me ? Data.groups.filter(g => g.created_by === me.username).length : 0);
const groupQuotaExhausted = () => { const l = groupLimit(); return l !== undefined && groupQuotaUsed() >= l; };

const canEdit = t => !!(t && me && (isAdmin() || t.created_by === me.username));
// [D-05] Khi đã có tiền hoàn trả (repaid > 0) hoặc có settlement CONFIRMED, chỉ ADMIN được xoá
function hasConfirmedSettlementFor(t){
  if (!t) return false;
  const list = (Idx.settlementsByTxn && Idx.settlementsByTxn[t.id]) || Data.settlements.filter(s => s.transaction_id === t.id);
  return list.some(s => settlementStatus(s) === 'CONFIRMED');
}
const canDelete = t => {
  if (!t || !me) return false;
  if (pendingOutgoingFor(t)) return false;
  if ((t.repaid || 0) > 0 || hasConfirmedSettlementFor(t)) return isAdmin();
  return isAdmin() || t.created_by === me.username;
};
const canMarkPaid = t => !!(t && me && remainOf(t) > 0 && (isAdmin() || otherOf(t.paid_by, pairIdOf(t)) === me.username));

const settlementStatus = s => (s && s.status) ? s.status : 'CONFIRMED';
const canConfirmSettlement = s => !!(s && me && settlementStatus(s) === 'PENDING' && (isAdmin() || s.to_user === me.username));
const canCancelSettlement = s => !!(s && me && settlementStatus(s) === 'PENDING' && (isAdmin() || s.from_user === me.username));
function pendingOutgoingFor(t){
  if (!t) return null;
  if (t.pending_sid){
    const bySid = Data.settlements.find(s => s.id === t.pending_sid && settlementStatus(s) === 'PENDING');
    if (bySid) return bySid;
  }
  if (Idx.pendingByTxn && Idx.pendingByTxn[t.id]) return Idx.pendingByTxn[t.id];
  return Data.settlements.find(s => s.transaction_id === t.id && settlementStatus(s) === 'PENDING') || null;
}
function myPendingIncomingSettlements(){
  if (!me) return [];
  return Data.settlements.filter(s => !s._invalid && settlementStatus(s) === 'PENDING' && s.to_user === me.username);
}

/* ---------------- activity [C-06, S-09] ---------------- */
async function log(action, entity_type, entity_id, metadata){
  if (!me) return;
  try {
    const meta = { ...(metadata || {}) };
    await Store.set('activity', rid(), {
      user_id: me.username,
      action,
      entity_type,
      entity_id,
      metadata: meta,
      created_at: now()
    });
    // [C-06] Chỉ ADMIN mới dọn nhật ký vượt quá 300 bản ghi bằng một lệnh multi() duy nhất
    if (isAdmin() && Data.activity.length > 320){
      const rest = [...Data.activity]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(300);
      if (rest.length){
        const delMap = {};
        for (const old of rest) if (old && old.id) delMap[`activity/${old.id}`] = null;
        await Store.multi(delMap);
      }
    }
  } catch (e){
    recordDiagError('log:' + action, e);
  }
}

/* ===== V4 · [S-03, S-04, S-05, C-04, 8.3] Xác thực, băm mật khẩu (SHA-256 + PBKDF2) & Phiên ===== */
async function sha(s){
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sochung|' + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const DEFAULT_PW = '1';
const WEAK_PWS = new Set(['12345678','123456789','87654321','password','matkhau1','11111111','00000000','qwertyui','abcd1234']);

function bytesToB64(bytes){
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}
function b64ToBytes(b64){
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// So sánh chuỗi theo thời gian cố định [8.3]
function timingSafeEqualStr(a, b){
  const sa = String(a || ''), sb = String(b || '');
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i++){
    diff |= (sa.charCodeAt(i % (sa.length || 1)) ^ sb.charCodeAt(i % (sb.length || 1)));
  }
  return diff === 0 && sa.length > 0;
}

async function pbkdf2Hash(password, saltBytes, iterations = PBKDF2_ITER){
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(String(password ?? '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', hash:'SHA-256', salt:saltBytes, iterations },
    keyMat,
    256
  );
  const hashB64 = bytesToB64(new Uint8Array(bits));
  const saltB64 = bytesToB64(saltBytes);
  return `pbkdf2-sha256$${iterations}$${saltB64}$${hashB64}`;
}

function isPwUpgradeEnabled(){
  return !!(Data.config && Data.config.flags && Data.config.flags.pw_upgrade === true);
}

async function makePasswordHash(password){
  if (isPwUpgradeEnabled()){
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return pbkdf2Hash(password, salt, PBKDF2_ITER);
  }
  return sha(password);
}

async function verifyPasswordHash(password, storedHash){
  if (!storedHash || typeof storedHash !== 'string') return { ok:false, isLegacy:false };
  if (/^[0-9a-f]{64}$/i.test(storedHash)){
    const h = await sha(password || '');
    return { ok: timingSafeEqualStr(h.toLowerCase(), storedHash.toLowerCase()), isLegacy: true };
  }
  if (storedHash.startsWith('pbkdf2-sha256$')){
    const parts = storedHash.split('$');
    if (parts.length !== 4) return { ok:false, isLegacy:false };
    const iter = parseInt(parts[1], 10);
    if (!Number.isSafeInteger(iter) || iter < 1000 || iter > 2000000) return { ok:false, isLegacy:false };
    try {
      const salt = b64ToBytes(parts[2]);
      const computed = await pbkdf2Hash(password || '', salt, iter);
      return { ok: timingSafeEqualStr(computed, storedHash), isLegacy: false };
    } catch (_){
      return { ok:false, isLegacy:false };
    }
  }
  return { ok:false, isLegacy:false };
}

function validateNewPassword(pw, username){
  const s = String(pw ?? '');
  if (s.length < MIN_PW_LEN) return `Mật khẩu mới phải có ít nhất ${MIN_PW_LEN} ký tự.`;
  if (s.length > 128) return 'Mật khẩu mới quá dài (tối đa 128 ký tự).';
  if (username && s.trim().toLowerCase() === String(username).trim().toLowerCase()){
    return 'Mật khẩu mới không được trùng với tên đăng nhập.';
  }
  if (WEAK_PWS.has(s.toLowerCase())){
    return 'Mật khẩu này quá phổ biến, vui lòng chọn mật khẩu khó đoán hơn.';
  }
  return '';
}

function generateTempPassword(len = 10){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function getUserDoc(username){
  const u = (username || '').trim().toLowerCase();
  if (!u || RESERVED_USERNAMES.has(u)) return null;
  const d = await Store.get('users/' + u);
  return d.exists && d.data ? Norm.user({ id:u, ...d.data }) : null;
}

async function getFriendshipDoc(id){
  const d = await Store.get('friendships/' + id);
  return d.exists && d.data ? Norm.friendship({ id, ...d.data }) : null;
}

// [S-08, C-05] Chỉ tạo dữ liệu khởi tạo legacy bằng createIfAbsent khi hệ thống trống hoặc do ADMIN chạy
async function ensureLegacyUsers(){
  const legacy = [
    { username:'duy',    name:'Duy',    role:'ADMIN' },
    { username:'nguyen', name:'Nguyen', role:'USER'  },
  ];
  for (const u of legacy){
    await Store.createIfAbsent('users/' + u.username, {
      username: u.username, name: u.name, role: u.role,
      created_by: 'system', created_at: now(), must_change_pw: false
    });
  }
}
async function ensureLegacyFriendship(){
  const id = makePairId('duy', 'nguyen');
  await Store.createIfAbsent('friendships/' + id, {
    user_a: 'duy', user_b: 'nguyen', status: 'ACCEPTED', requested_by: 'system', created_at: now()
  });
}

async function credsDoc(){
  const d = await Store.get('config/auth');
  return d.exists ? d.data : null;
}
async function userCredHash(username){
  const d = await Store.get('config/auth/' + username);
  if (d.exists && typeof d.data === 'string') return d.data;
  const all = await credsDoc();
  return (all && typeof all === 'object') ? (all[username] || null) : null;
}
// [C-04] Ghi mật khẩu theo từng khoá config/auth/{username}, KHÔNG ghi đè cả object config/auth
async function saveUserCred(username, hash){
  await Store.update('config/auth', { [username]: hash });
}
// Giữ saveCreds như lớp bọc tương thích nếu có code gọi nhưng dùng update từng phần tử
async function saveCreds(obj){
  if (!obj || typeof obj !== 'object') return;
  await Store.update('config/auth', obj);
}

// [S-04] Kiểm tra đăng nhập an toàn
async function checkLogin(username, password){
  const u = (username || '').trim().toLowerCase();
  if (!u || RESERVED_USERNAMES.has(u)) return null;
  let user = await getUserDoc(u);
  let storedHash = await userCredHash(u);

  // Chỉ tự khởi tạo duy/nguyen khi CẢ users lẫn config/auth đều hoàn toàn trống (DB mới tinh)
  if (!user && !storedHash && (u === 'duy' || u === 'nguyen')){
    const allUsersSnap = await Store.get('users');
    const allCreds = await credsDoc();
    const dbIsBrandNew = (!allUsersSnap.exists || !allUsersSnap.data) && (!allCreds || !Object.keys(allCreds).length);
    if (dbIsBrandNew){
      await ensureLegacyUsers();
      await ensureLegacyFriendship();
      const dHash = await sha(DEFAULT_PW);
      await Store.update('config/auth', { duy: dHash, nguyen: dHash });
      user = await getUserDoc(u);
      storedHash = dHash;
    }
  }
  if (!user) return null;
  if (!storedHash){
    throw Object.assign(new Error('NO_PASSWORD_HASH'), {
      userMsg: 'Tài khoản chưa có mật khẩu, vui lòng liên hệ quản trị viên.'
    });
  }

  const ver = await verifyPasswordHash(password || '', storedHash);
  if (!ver.ok) return null;

  // Nếu đăng nhập bằng mật khẩu mặc định '1' -> buộc đổi mật khẩu ngay [S-04]
  if (String(password || '') === DEFAULT_PW && !user.must_change_pw){
    await Store.update('users/' + u, { must_change_pw: true });
    user.must_change_pw = true;
  }
  // Nếu cờ pw_upgrade đang bật và hash còn ở dạng SHA-256 cũ -> nâng cấp lên PBKDF2 ngay lúc đăng nhập
  if (ver.isLegacy && isPwUpgradeEnabled() && String(password || '') !== DEFAULT_PW){
    try {
      const upgraded = await makePasswordHash(password);
      await saveUserCred(u, upgraded);
    } catch (_){}
  }
  return user;
}

// [S-05] Giới hạn thử sai đăng nhập phía thiết bị (lưu trong localStorage)
const LOGIN_GUARD_KEY = 'sochung.login_guard';
function getLoginGuard(){
  try {
    return JSON.parse(localStorage.getItem(LOGIN_GUARD_KEY) || '{"fails":0,"until":0}') || { fails:0, until:0 };
  } catch (_){ return { fails:0, until:0 }; }
}
function recordLoginFailure(){
  const g = getLoginGuard();
  const fails = (g.fails || 0) + 1;
  let until = 0;
  if (fails >= 5){
    const step = Math.min(fails - 5, 5); // 30s, 60s, 120s, 240s, 480s, 900s (tối đa 15 phút)
    const sec = step === 5 ? 900 : (30 * Math.pow(2, step));
    until = Date.now() + sec * 1000;
  }
  try { localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify({ fails, until })); } catch (_){}
  return { fails, until };
}
function clearLoginFailures(){
  try { localStorage.removeItem(LOGIN_GUARD_KEY); } catch (_){}
}

/* ---------------- session [S-03, R-08] ---------------- */
const SESS = 'sochung.session';
function saveSession(u){
  try { localStorage.setItem(SESS, JSON.stringify({ v:2, u, at:Date.now() })); } catch (_){}
}
function readSession(){
  try {
    const s = JSON.parse(localStorage.getItem(SESS) || 'null');
    if (!s || s.v !== 2 || !s.u || typeof s.at !== 'number') return null;
    if (Date.now() - s.at > 1000 * 60 * 60 * 24 * 14) return null;
    return s;
  } catch (_){ return null; }
}
function isSessionValidForUser(sess, userDoc){
  if (!sess || !userDoc) return false;
  if (userDoc.pw_changed_at){
    const changedMs = Date.parse(userDoc.pw_changed_at);
    if (Number.isFinite(changedMs) && sess.at < changedMs - 1000) return false;
  }
  return true;
}

function logout(){
  if (me) log('LOGOUT', 'session', me.username, {}).catch(() => {});
  // [R-08] Huỷ toàn bộ listener đang lắng nghe
  for (const unsub of _unsubs){
    try { if (typeof unsub === 'function') unsub(); } catch (_){}
  }
  _unsubs = [];
  try { localStorage.removeItem(SESS); } catch (_){}
  me = null;
  mustChangePw = false;
  peer = null;
  chatOpen = false;
  chatThread = null;
  _lastRenderedChatKey = '';
  route = { path:'dashboard', param:null };
  uiFilter = { status:'ALL', q:'', sort:'new', month:'ALL', budgetMonth:'' };
  ALL_WATCH_COLS.forEach(c => {
    if (c === 'config') Data.config = Object.create(null);
    else Data[c] = [];
    delete Data.loaded[c];
  });
  Data.usersById = Object.create(null);
  Data.ready = false;
  rebuildIdx();
  closeModal();
  const appV = el('appView'); if (appV) appV.classList.remove('on');
  const logV = el('loginView'); if (logV) logV.style.display = '';
  const cr = el('chatRoot'); if (cr) cr.innerHTML = '';
  const mainEl = el('main'); if (mainEl) mainEl.innerHTML = '';
  const uIn = el('u'), pIn = el('p'), errEl = el('loginErr');
  if (uIn) uIn.value = '';
  if (pIn) { pIn.value = ''; pIn.type = 'password'; }
  if (errEl) errEl.innerHTML = '';
}
/* ===== /V4 ===== */
/* ===== V4 · [K6, K9, U-01, U-07..U-16, U-22, U-24] Điều hướng, Bộ lập lịch Render & Thống kê ===== */
const NAV = [
  {p:'dashboard',   t:'Tổng quan',     m:'Tổng quan', ic:'ic-home',      grp:'Sổ chung'},
  {p:'transactions',t:'Giao dịch',     m:'Giao dịch', ic:'ic-list',      grp:'Sổ chung'},
  {p:'new',         t:'Tạo giao dịch', m:null,        ic:'ic-plus',      grp:'Sổ chung'},
  {p:'settlements', t:'Cân nợ',        m:'Cân nợ',    ic:'ic-scale',     grp:'Sổ chung'},
  {p:'history',     t:'Lịch sử trả',   m:null,        ic:'ic-clock',     grp:'Sổ chung'},
  {p:'friends',     t:'Kết bạn',       m:null,        ic:'ic-user-plus', grp:'Sổ chung'},
  {p:'groups',      t:'Nhóm',          m:'Nhóm',      ic:'ic-users',     grp:'Nhóm & Cá nhân'},
  {p:'stats',       t:'Thống kê',      m:null,        ic:'ic-chart',     grp:'Nhóm & Cá nhân'},
  {p:'savings',     t:'Sổ tiết kiệm',  m:null,        ic:'ic-piggy',     grp:'Nhóm & Cá nhân'},
  {p:'budget',      t:'Ngân sách',     m:null,        ic:'ic-wallet',    grp:'Nhóm & Cá nhân'},
  {p:'activity',    t:'Nhật ký',       m:null,        ic:'ic-activity',  grp:'Hệ thống'},
  {p:'settings',    t:'Cài đặt',       m:null,        ic:'ic-settings',  grp:'Hệ thống'},
  {p:'admin',       t:'Quản trị',      m:null,        ic:'ic-shield',    grp:'Hệ thống', admin:true},
];

const navCls = n => (route.path === n.p ? 'active' : '') + (lockedPage(n.p) ? ' locked' : '');
const svgIc = (id, sz = 17) => `<svg class="ic" width="${sz}" height="${sz}" aria-hidden="true"><use href="#${esc(id)}"/></svg>`;

function vLocked(path){
  const n = NAV.find(x => x.p === path);
  return `
  <div class="page-head"><div><h2>${esc(n ? n.t : 'Tính năng')}</h2></div></div>
  <div class="panel"><div class="empty">
    <div class="empty-ic">${svgIc('ic-shield', 18)}</div>
    <b>Tính năng dành cho tài khoản VIP</b>
    Tài khoản gói Thường chưa dùng được trang này. Liên hệ quản trị viên để nâng cấp lên VIP.
    <div style="margin-top:12px"><a class="btn primary" href="#/dashboard">Về Tổng quan</a></div>
  </div></div>`;
}

function vSkeleton(title){
  return `
  <div class="page-head"><div><h2>${esc(title || 'Đang tải…')}</h2><p>Đang đồng bộ dữ liệu sổ chung…</p></div></div>
  <div class="grid cards" style="margin-bottom:16px">
    <div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div>
  </div>
  <div class="panel"><div class="body">
    <div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>
  </div></div>`;
}

function updateConnectionUI(online){
  const dot = el('connDot');
  if (dot){
    dot.className = 'conn-dot ' + (online ? 'on' : 'off');
    dot.title = online ? 'Đã kết nối máy chủ' : 'Mất kết nối — thay đổi sẽ gửi khi có mạng';
  }
  const b = el('netBanner');
  if (b) b.style.display = online ? 'none' : '';
}

function checkMinClientVersion(){
  const minV = Data.config && Data.config.client && Number(Data.config.client.min_version);
  if (Number.isFinite(minV) && minV > APP_VERSION){
    const m = el('main');
    if (m){
      m.innerHTML = `<div class="panel"><div class="empty">
        <div class="empty-ic">${svgIc('ic-alert', 18)}</div>
        <b>Đã có phiên bản mới (v${esc(minV)})</b>
        Phiên bản hiện tại trên trình duyệt (v${APP_VERSION}) đã cũ. Vui lòng tải lại trang để cập nhật và bảo vệ dữ liệu.
        <div style="margin-top:12px"><button class="btn primary" type="button" ${A('reloadPage')}>Tải lại trang ngay</button></div>
      </div></div>`;
    }
    return true;
  }
  return false;
}

function openMoreSheet(){
  const friendReq = pendingIncoming().length;
  const moreItems = NAV.filter(n => !n.m && (!n.admin || canManageUsers()));
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Menu mở rộng</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="more-grid">
      ${moreItems.map(n => {
        const badge = (n.p === 'friends' && friendReq) ? `<span class="badge">${friendReq}</span>` : '';
        return `<a href="#/${n.p}" class="more-item ${lockedPage(n.p) ? 'locked' : ''}" ${A('closeModal')}>
          <span style="display:inline-flex;align-items:center;gap:8px">${svgIc(n.ic, 17)}${esc(n.t)}</span>
          ${badge}
        </a>`;
      }).join('')}
    </div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Đóng</button></footer>`);
}

let _isComposing = false;
let _formDirty = false;
let _mainStale = false;
let _renderTimer = 0;
let _pressHoldBusy = false;
let _pressPending = false;

if (typeof document !== 'undefined'){
  document.addEventListener('compositionstart', () => { _isComposing = true; }, true);
  document.addEventListener('compositionend', () => {
    _isComposing = false;
    if (_mainStale) scheduleRender();
  }, true);
  document.addEventListener('input', e => {
    const t = e.target;
    if (t && t.closest && t.closest('#main') && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')){
      if (t.id !== 'txnSearchInput') _formDirty = true;
    }
    if (t && t.classList && t.classList.contains('num') && t.tagName === 'INPUT' && t.type !== 'month' && t.type !== 'date'){
      formatMoneyInputLive(t);
    }
  }, true);
  document.addEventListener('focusout', e => {
    const t = e.target;
    if (t && t.closest && t.closest('#main') && _mainStale && route.path !== 'new'){
      setTimeout(() => {
        const act = document.activeElement;
        if (!act || !act.closest || !act.closest('#main') || !['INPUT','TEXTAREA','SELECT'].includes(act.tagName)){
          _formDirty = false;
          if (_mainStale) scheduleRender({ forceMain:true });
        }
      }, 80);
    }
  }, true);
}

function formatMoneyInputLive(input){
  if (_isComposing) return;
  const raw = input.value;
  const selStart = typeof input.selectionStart === 'number' ? input.selectionStart : raw.length;
  const digitsBeforeCursor = raw.slice(0, selStart).replace(/[^\d]/g, '').length;
  const cleanDigits = raw.replace(/[^\d]/g, '');
  if (!cleanDigits){
    updateMoneyHint(input, 0);
    return;
  }
  if (/^[0-9. ]+$/.test(raw) && cleanDigits.length <= 15){
    const formatted = cleanDigits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    if (formatted !== raw){
      input.value = formatted;
      let newPos = 0, seen = 0;
      for (let i = 0; i < formatted.length; i++){
        if (seen >= digitsBeforeCursor) break;
        if (/\d/.test(formatted[i])) seen++;
        newPos = i + 1;
      }
      try { input.setSelectionRange(newPos, newPos); } catch (_){}
    }
  }
  const check = V.money(input.value);
  updateMoneyHint(input, check.ok ? check.value : 0, check.ok ? '' : check.error);
}

function humanMoneyHint(val){
  if (!val || val <= 0) return '';
  if (val >= 1e9) return `≈ ${(val / 1e9).toLocaleString('vi-VN', { maximumFractionDigits:2 })} tỷ ₫`;
  if (val >= 1e6) return `≈ ${(val / 1e6).toLocaleString('vi-VN', { maximumFractionDigits:2 })} triệu ₫`;
  if (val >= 1e3) return `≈ ${Math.round(val / 1e3).toLocaleString('vi-VN')} nghìn ₫`;
  return `${val} ₫`;
}

function updateMoneyHint(input, val, errMsg){
  if (!input || !input.parentElement) return;
  let hint = input.parentElement.querySelector('.amt-hint');
  if (!hint){
    hint = document.createElement('div');
    hint.className = 'amt-hint';
    input.parentElement.appendChild(hint);
  }
  if (errMsg && input.value.trim()){
    hint.textContent = errMsg;
    hint.style.color = 'var(--danger)';
  } else {
    hint.textContent = humanMoneyHint(val);
    hint.style.color = 'var(--gold-2)';
  }
}

function isUserEditingMain(){
  if (!me || typeof document === 'undefined') return false;
  if (_isComposing) return true;
  if (route.path === 'new' && _formDirty) return true;
  const act = document.activeElement;
  if (act && act.closest && act.closest('#main') && ['INPUT','TEXTAREA','SELECT'].includes(act.tagName)){
    return true;
  }
  return false;
}

function renderChrome(){
  if (!me) return;
  const b = peer ? balanceText() : null;
  const sb = el('sideBal');
  if (sb){
    sb.textContent = !peer ? 'Chưa có sổ chung'
      : (b.amount ? b.text + ' ' + vnd(b.amount) : 'Đã cân bằng');
  }
  updateConnectionUI(Store.online);
  const av = el('meAv'), nm = el('meName'), rl = el('meRole');
  if (av) av.textContent = initial(nameOf(me.username));
  if (nm) nm.textContent = nameOf(me.username);
  if (rl) rl.textContent = myRole() === 'USER' ? 'Thành viên' : ROLE_VI[myRole()];

  const unpaid = myTxns().filter(t => t.paid_by !== me.username && remainOf(t) > 0).length;
  const friendReq = pendingIncoming().length;
  const confirmReq = myPendingIncomingSettlements().length;
  const groupReq = myGroupPendingConfirms();

  const navEl = el('nav');
  if (navEl){
    const allowed = NAV.filter(n => !n.admin || canManageUsers());
    let html = '';
    let lastGrp = '';
    for (const n of allowed){
      if (n.grp !== lastGrp){
        html += `<div class="nav-group-title">${esc(n.grp)}</div>`;
        lastGrp = n.grp;
      }
      const badge = (n.p === 'transactions' && unpaid) ? `<span class="badge">${unpaid}</span>`
        : (n.p === 'friends' && friendReq) ? `<span class="badge">${friendReq}</span>`
        : (n.p === 'settlements' && confirmReq) ? `<span class="badge">${confirmReq}</span>`
        : (n.p === 'groups' && groupReq) ? `<span class="badge">${groupReq}</span>` : '';
      html += `<a href="#/${n.p}" class="${navCls(n)}"><span class="nav-lbl">${svgIc(n.ic, 16)}<span>${esc(n.t)}</span></span>${badge}</a>`;
    }
    navEl.innerHTML = html;
  }

  const mnavEl = el('mnav');
  if (mnavEl){
    const primaryMobile = NAV.filter(n => n.m);
    const isMoreActive = !primaryMobile.some(n => n.p === route.path);
    const moreBadge = friendReq;
    const itemsHTML = primaryMobile.map(n => {
      const badge = (n.p === 'transactions' && unpaid) ? `<span class="badge">${unpaid}</span>`
        : (n.p === 'settlements' && confirmReq) ? `<span class="badge">${confirmReq}</span>`
        : (n.p === 'groups' && groupReq) ? `<span class="badge">${groupReq}</span>` : '';
      return `<a href="#/${n.p}" class="${navCls(n)}">${svgIc(n.ic, 18)}<span>${esc(n.m)}</span>${badge}</a>`;
    }).join('');
    mnavEl.innerHTML = itemsHTML + `<button type="button" class="mnav-btn ${isMoreActive ? 'active' : ''}" ${A('openMoreSheet')}>
      ${svgIc('ic-more', 18)}<span>Thêm</span>${moreBadge ? `<span class="badge">${moreBadge}</span>` : ''}
    </button>`;
  }

  const chatUnread = totalUnread();
  [el('chatBadge'), el('chatBadgeFab')].forEach(bEl => {
    if (!bEl) return;
    bEl.style.display = chatUnread ? '' : 'none';
    bEl.textContent = chatUnread;
  });
  renderChat();
}

const VIEW_MAP = Object.create(null);

function renderMain(){
  if (!me) return;
  const mainEl = el('main');
  if (!mainEl) return;
  if (checkMinClientVersion()) return;

  const prevScrollY = typeof window !== 'undefined' ? window.scrollY : 0;

  if (mustChangePw){
    mainEl.innerHTML = vForceChangePw();
    return;
  }
  if (lockedPage(route.path)){
    mainEl.innerHTML = vLocked(route.path);
    return;
  }
  if (!Data.ready && Store.db){
    mainEl.innerHTML = vSkeleton('Đang tải dữ liệu…');
    return;
  }

  const netNotice = !Store.online
    ? `<div class="notice" id="netBanner"><span>Mất kết nối — các thay đổi sẽ được gửi khi có mạng trở lại.</span></div>`
    : `<div class="notice" id="netBanner" style="display:none"><span>Mất kết nối — các thay đổi sẽ được gửi khi có mạng trở lại.</span></div>`;

  const hasRoute = Object.prototype.hasOwnProperty.call(VIEW_MAP, route.path);
  const fn = hasRoute ? VIEW_MAP[route.path] : vDashboard;
  mainEl.innerHTML = netNotice + fn();
  _mainStale = false;
  if (route.path === 'new') bindForm();

  if (typeof window !== 'undefined' && prevScrollY > 0 && !mainEl.classList.contains('enter')){
    window.scrollTo(0, prevScrollY);
  }
}

function renderNow(opts = {}){
  if (!me) return;
  if (_pressHoldBusy && !opts.bypassPress){
    _pressPending = true;
    return;
  }
  renderChrome();
  if (!opts.forceMain && isUserEditingMain()){
    _mainStale = true;
    return;
  }
  renderMain();
}

function scheduleRender(opts = {}){
  if (!me) return;
  if (opts.forceMain){
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = 0; }
    renderNow(opts);
    return;
  }
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = 0;
    if (typeof requestAnimationFrame === 'function'){
      requestAnimationFrame(() => renderNow(opts));
    } else {
      renderNow(opts);
    }
  }, 45);
}

function render(){
  scheduleRender({ forceMain: !isUserEditingMain() });
}
if (typeof window !== 'undefined') window.render = render;

function peerBar(){
  const friends = acceptedFriends();
  if (friends.length <= 1) return '';
  return `<div class="toolbar" style="margin-bottom:14px">
    <span class="meta">Sổ đang mở</span>
    <div class="chips">${friends.map(u =>
      `<button type="button" class="chip ${u === peer ? 'on' : ''}" ${A('switchPeer', u)}>${esc(nameOf(u))}</button>`).join('')}</div>
  </div>`;
}
function noPeerView(title, desc){
  if (!Data.ready && Store.db) return vSkeleton(title);
  return `
  <div class="page-head"><div><h2>${esc(title)}</h2></div></div>
  <div class="panel"><div class="empty">
    <div class="empty-ic">${svgIc('ic-user-plus', 18)}</div>
    <b>Chưa có sổ chung nào</b>${esc(desc || 'Kết bạn với ai đó để bắt đầu ghi chi tiêu chung.')}
    <div style="margin-top:12px"><a class="btn primary" href="#/friends">Đi tới Kết bạn</a></div>
  </div></div>`;
}

function vDashboard(){
  if (!peer) return noPeerView('Tổng quan');
  const b = balanceText(), s = myStats();
  const meOwes = b.debtor === me.username;
  const cls = b.amount === 0 ? '' : (meOwes ? 'debit' : 'credit');
  const sign = b.amount === 0 ? '' : (meOwes ? '−' : '+');
  const tagDir = b.amount === 0 ? 'Cân bằng' : (meOwes ? 'Phải trả' : 'Được nhận');
  const line = b.amount === 0 ? 'Hai bên không nợ nhau'
    : meOwes ? `Bạn đang nợ ${nameOf(b.creditor)}` : `${nameOf(b.debtor)} đang nợ bạn`;
  const recent = sortedMyTxns().slice(0, 5);
  const unpaid = myTxns().filter(t => t.paid_by !== me.username && remainOf(t) > 0);
  const friendReqs = pendingIncoming();
  const confirmReqs = myPendingIncomingSettlements();
  const groupReqs = myGroupPendingConfirms();

  const todos = [];
  if (friendReqs.length){
    todos.push(`<div class="todo-item"><span>Bạn có <b>${friendReqs.length}</b> lời mời kết bạn đang chờ phản hồi.</span><a class="btn sm" href="#/friends">Xem lời mời</a></div>`);
  }
  if (confirmReqs.length){
    todos.push(`<div class="todo-item"><span>Có <b>${confirmReqs.length}</b> khoản thanh toán đang chờ bạn xác nhận đã nhận tiền.</span><a class="btn sm primary" href="#/settlements">Xác nhận ngay</a></div>`);
  }
  if (groupReqs > 0){
    todos.push(`<div class="todo-item"><span>Có <b>${groupReqs}</b> khoản chi tiêu nhóm đang chờ bạn xác nhận nhận tiền.</span><a class="btn sm" href="#/groups">Mở Nhóm</a></div>`);
  }
  if (unpaid.length){
    todos.push(`<div class="todo-item"><span>Bạn có <b>${unpaid.length}</b> khoản chưa trả (${vnd(unpaid.reduce((a, t) => a + remainOf(t), 0))}).</span><a class="btn sm" href="#/settlements">Cân nợ ngay</a></div>`);
  }

  return `
  <div class="page-head">
    <div><h2>Xin chào, ${esc(nameOf(me.username))}</h2>
    <p>Sổ chung với ${esc(nameOf(peer))}. Mọi giao dịch được chia đôi tự động.</p></div>
    <div class="actions">
      ${isActiveFriend(peer) ? `
      <button class="btn" type="button" ${A('openQuickAdd')}>Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>` : `<span class="tag">Đã hủy kết bạn · chỉ xem lại</span>`}
    </div>
  </div>
  ${peerBar()}

  ${todos.length ? `<div class="todo-strip" role="region" aria-label="Việc cần làm">${todos.join('')}</div>` : ''}

  <section class="hero">
    <p class="who-line">${esc(line)} · <span class="tag">${esc(tagDir)}</span></p>
    <p class="amount ${cls}">${sign}${vnd(b.amount)}</p>
    <p class="sub">${s.count} giao dịch · tổng chi ${vnd(s.total)} · quy tắc chia 50/50</p>
    <div class="hero-actions">
      <a class="btn" href="#/transactions">Xem giao dịch</a>
      ${b.amount ? `<a class="btn" href="#/settlements">Cân nợ</a>` : ''}
    </div>
  </section>

  <div class="grid cards">
    ${stat('Số giao dịch', s.count, false)}
    ${stat('Tổng đã chi', vnd(s.total))}
    ${stat('Bạn đã ứng trước', vnd(s.paid))}
    ${stat('Phần của bạn', vnd(s.share))}
    ${stat('Bạn còn nợ (phải trả)', (s.iOwe ? '−' : '') + vnd(s.iOwe), 'debit')}
    ${stat('Người khác nợ bạn (được nhận)', (s.owedMe ? '+' : '') + vnd(s.owedMe), 'credit')}
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
      : `<div class="empty"><div class="empty-ic">${svgIc('ic-list', 18)}</div><b>Chưa có giao dịch nào</b>Ghi khoản đầu tiên để bắt đầu theo dõi.
      ${isActiveFriend(peer) ? `<div style="margin-top:12px"><a class="btn sm primary" href="#/new">+ Giao dịch mới</a></div>` : ''}</div>`}
  </section>`;
}
const stat = (k, v, cls) => `<div class="stat"><div class="k">${esc(k)}</div>
  <div class="v ${cls || ''}">${typeof v === 'number' ? v : v}</div></div>`;

function shortVnd(n){
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  const sign = num < 0 ? '−' : '';
  const a = Math.round(Math.abs(num));
  if (a >= 999500000){
    const ty = Math.round(a / 1e8) / 10;
    return sign + (ty >= 10 || ty % 1 === 0 ? Math.round(ty) : String(ty).replace('.', ',')) + ' tỷ';
  }
  if (a >= 999500){
    const tr = Math.round(a / 1e5) / 10;
    return sign + (tr >= 10 || tr % 1 === 0 ? Math.round(tr) : String(tr).replace('.', ',')) + ' tr';
  }
  if (a >= 1000){
    return sign + Math.round(a / 1e3) + 'k';
  }
  return sign + String(a);
}

function lastMonths(n, refDate = new Date()){
  const out = [], d = refDate instanceof Date ? refDate : new Date(refDate);
  for (let i = n - 1; i >= 0; i--){
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}
const mLabel = m => 'T' + parseInt(String(m).slice(5), 10);

function statsMonthly(months){
  const list = myTxns();
  return months.map(m => ({
    month: m,
    label: mLabel(m),
    value: list.filter(t => monthKeyOf(t.date || t.created_at) === m).reduce((a, t) => a + t.amount, 0)
  }));
}
function statsByCat(){
  const sum = Object.create(null);
  for (const t of myTxns()){
    const c = CATEGORIES.includes(t.category) ? t.category : 'Other';
    sum[c] = (sum[c] || 0) + t.amount;
  }
  return CATEGORIES
    .map((c, i) => ({ label: CAT_VI[c], value: sum[c] || 0, i: i + 1 }))
    .filter(s => s.value > 0);
}

function netSeries(months){
  const ev = [];
  for (const t of myTxns()){
    const m = monthKeyOf(t.date || t.created_at);
    if (!m) continue;
    ev.push({ m, v: (t.paid_by === me.username ? 1 : -1) * owedOf(t) });
  }
  for (const s of mySettlements()){
    if (settlementStatus(s) !== 'CONFIRMED') continue;
    const m = monthKeyOf(s.confirmed_at || s.created_at);
    if (!m) continue;
    ev.push({ m, v: (s.to_user === me.username ? -1 : 1) * s.amount });
  }
  return months.map(m => {
    let sum = 0;
    for (const e of ev) if (e.m && e.m <= m) sum += e.v;
    return { month: m, label: mLabel(m), value: sum };
  });
}

function chartLogicalWidth(){
  if (typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 640) return 360;
  return 640;
}

function chartDataDetails(title, rows, fmtVal = vnd){
  return `<details class="chart-details"><summary>Bảng số liệu: ${esc(title)}</summary>
    <div class="tbl-wrap" style="margin-top:6px"><table><thead><tr><th>Mục</th><th class="num">Giá trị</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${fmtVal(r.value)}</td></tr>`).join('')}</tbody></table></div>
  </details>`;
}

function svgBars(rows){
  if (!rows.some(r => r.value)) return `<div class="empty">Chưa có chi tiêu nào trong 6 tháng gần đây.</div>`;
  const W = chartLogicalWidth(), H = 220, padL = 12, padR = 12, padT = 28, padB = 30, base = H - padB;
  const max = Math.max(1, ...rows.map(r => r.value));
  const iw = (W - padL - padR) / rows.length, bw = Math.min(W < 400 ? 34 : 56, iw * 0.54);
  const grid = [0, 0.5, 1].map(f => {
    const y = (padT + (1 - f) * (base - padT)).toFixed(1);
    return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="c-grid"/>`;
  }).join('');
  const bars = rows.map((r, i) => {
    const h = r.value ? Math.max(3, (r.value / max) * (base - padT)) : 0;
    const x = padL + i * iw + (iw - bw) / 2, y = base - h;
    const cx = (x + bw / 2).toFixed(1);
    return `<g>
      <title>${esc(r.label)}: ${esc(vnd(r.value))}</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" class="c-bar"/>
      ${r.value ? `<text x="${cx}" y="${(y - 8).toFixed(1)}" class="c-val">${esc(shortVnd(r.value))}</text>` : ''}
      <text x="${cx}" y="${base + 18}" class="c-lab">${esc(r.label)}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Tổng chi theo tháng">
    <title>Tổng chi theo tháng</title><desc>Biểu đồ cột chi tiêu 6 tháng gần nhất</desc>
    ${grid}${bars}</svg>${chartDataDetails('Chi theo tháng', rows)}`;
}

function svgDonut(slices){
  if (!slices.length) return `<div class="empty">Chưa có dữ liệu danh mục.</div>`;
  const W = 260, H = 260, cx = 130, cy = 130, r = 92, sw = 30;
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const C = 2 * Math.PI * r;
  let off = 0;
  const arcs = slices.map(s => {
    const raw = C * (s.value / total);
    const len = Math.max(1, raw - (slices.length > 1 ? 2 : 0));
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${sw}"
      class="c-s${s.i}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
      stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})">
      <title>${esc(s.label)}: ${esc(vnd(s.value))}</title></circle>`;
    off += raw;
    return seg;
  }).join('');
  return `<svg class="chart donut" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Tỉ lệ chi theo danh mục">
    <title>Tỉ lệ chi theo danh mục</title><desc>Tổng chi ${esc(vnd(total))}</desc>
    ${arcs}
    <text x="${cx}" y="${cy - 2}" class="c-center">${esc(shortVnd(total))}</text>
    <text x="${cx}" y="${cy + 18}" class="c-lab">tổng chi</text></svg>`;
}

function svgLine(rows){
  if (!rows.length) return `<div class="empty">Chưa có dữ liệu.</div>`;
  const W = chartLogicalWidth(), H = 230, padL = 14, padR = 14, padT = 28, padB = 30;
  const vals = rows.map(r => r.value);
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if (min === max) max = min + 1;
  const pad = (max - min) * 0.14;
  min -= pad; max += pad;
  const X = i => padL + i * (W - padL - padR) / Math.max(1, rows.length - 1);
  const Y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const pts = rows.map((r, i) => `${X(i).toFixed(1)},${Y(r.value).toFixed(1)}`).join(' ');
  const zero = Y(0).toFixed(1);
  const lastVal = rows[rows.length - 1].value;
  const areaCls = lastVal >= 0 ? 'c-area-pos' : 'c-area-neg';
  const lineCls = lastVal >= 0 ? 'c-line-pos' : 'c-line-neg';
  const dots = rows.map((r, i) => {
    const cx = X(i).toFixed(1), cy = Y(r.value).toFixed(1);
    const showVal = (i === 0 || i === rows.length - 1) && r.value !== 0;
    return `<g><title>${esc(r.label)}: ${esc((r.value >= 0 ? '+' : '−') + vnd(Math.abs(r.value)))}</title>
      <circle cx="${cx}" cy="${cy}" r="3.5" class="c-dot"/>
      ${showVal ? `<text x="${cx}" y="${(Number(cy) - 8).toFixed(1)}" class="c-val">${esc(shortVnd(r.value))}</text>` : ''}
      <text x="${cx}" y="${H - 10}" class="c-lab">${esc(r.label)}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Số dư ròng theo thời gian">
    <title>Số dư ròng theo thời gian</title><desc>Trên vạch 0 là được nhận, dưới vạch 0 là phải trả</desc>
    <line x1="${padL}" x2="${W - padR}" y1="${zero}" y2="${zero}" class="c-zero"/>
    <polygon class="${areaCls}" points="${padL},${zero} ${pts} ${W - padR},${zero}"/>
    <polyline class="${lineCls}" points="${pts}"/>
    ${dots}
    <text x="${padL}" y="${(Number(zero) - 6).toFixed(1)}" class="c-lab" style="text-anchor:start">0 ₫</text>
  </svg>${chartDataDetails('Số dư ròng theo tháng', rows, v => (v >= 0 ? '+' : '−') + vnd(Math.abs(v)))}`;
}

function vStats(){
  if (!peer) return noPeerView('Thống kê');
  const months = lastMonths(6);
  const bars = statsMonthly(months);
  const cats = statsByCat();
  const net  = netSeries(months);
  const sum6 = bars.reduce((a, r) => a + r.value, 0);
  const best = [...cats].sort((a, b) => b.value - a.value)[0];
  const s = myStats();
  const nb = netBalance();
  return `
  <div class="page-head"><div><h2>Thống kê</h2>
    <p>Sổ chung với ${esc(nameOf(peer))} · ${months[0]} → ${months[5]}</p></div>
    <div class="actions"><a class="btn" href="#/transactions">Xem giao dịch</a></div></div>
  ${peerBar()}

  <div class="grid cards">
    ${stat('Chi 6 tháng', vnd(sum6))}
    ${stat('Trung bình / tháng', vnd(Math.round(sum6 / 6)))}
    ${stat('Danh mục lớn nhất', best ? best.label : '—')}
    ${stat('Số dư hiện tại', (nb === 0 ? '' : (nb > 0 ? '+' : '−')) + vnd(Math.abs(nb)), nb === 0 ? '' : (nb > 0 ? 'credit' : 'debit'))}
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
        ${cats.length ? `<div class="legend">${cats.map(c =>
          `<span><i class="lg lg-${c.i}"></i>${esc(c.label)} · <b class="num">${vnd(c.value)}</b></span>`).join('')}</div>` : ''}
      </div>
    </section>
    <section class="panel">
      <h3>Số dư ròng theo thời gian</h3>
      <div class="body">
        ${svgLine(net)}
        <p class="hint" style="margin-top:10px">Trên vạch 0 nghĩa là ${esc(nameOf(peer))} đang nợ bạn (được nhận);
        dưới vạch 0 là bạn đang nợ (phải trả). Phần của bạn tới nay: <b class="num">${vnd(s.share)}</b>.</p>
      </div>
    </section>
  </div>`;
}
/* ===== /V4 ===== */

/* ===== V4 · [D-01..D-11, C-03, T-01..T-03, R-02, U-06, F-09, F-10] Giao dịch, Cân nợ, Lịch sử & Cài đặt ===== */

// [D-07, U-06, U-15] Bảng giao dịch chuẩn responsive (thẻ trên mobile <= 640px, căn phải cột số, không NaN ₫)
function txnTable(list){
  return `<table class="resp-tbl">
  <thead><tr><th>Ngày</th><th>Nội dung</th><th class="num">Tổng</th><th>Người trả</th>
  <th class="num">Phần chia</th><th class="num">Còn lại</th><th>Trạng thái</th><th></th></tr></thead>
  <tbody>${list.map(t => {
    const pid = pairIdOf(t);
    const [pa, pb] = Pair.members(pid);
    const s = split(t.amount, t.paid_by, pid), st = statusOf(t), rem = remainOf(t);
    const isMemberOfPair = me && (me.username === pa || me.username === pb);
    const myShareVal = isMemberOfPair ? s[me.username] : owedOf(t);
    const shareLabel = isMemberOfPair ? vnd(myShareVal) : `${vnd(myShareVal)} (${nameOf(otherOf(t.paid_by, pid))})`;
    const dir = t.paid_by === me.username ? 'credit' : 'debit';
    const sign = rem ? (isMemberOfPair ? (t.paid_by === me.username ? '+' : '−') : '') : '';
    const pend = pendingOutgoingFor(t);
    return `<tr class="row" tabindex="0" role="link" ${A('go', 'transactions/' + t.id)}>
      <td class="meta num" data-label="Ngày">${fmtDate(t.date)}</td>
      <td class="cell-main" data-label="Nội dung"><div class="title">${esc(t.title)}</div>
          <div class="meta"><span class="tag">${esc(CAT_VI[t.category] || t.category)}</span> · ${esc(nameOf(t.created_by))} tạo
          ${t.disputed_by ? ` · <span class="tag dispute">Đang tranh chấp</span>` : ''}</div></td>
      <td class="num" data-label="Tổng">${vnd(t.amount)}</td>
      <td data-label="Người trả">${esc(nameOf(t.paid_by))}</td>
      <td class="num" data-label="${isMemberOfPair ? 'Phần bạn' : 'Phần nợ'}">${esc(shareLabel)}</td>
      <td class="num" data-label="Còn lại" style="color:var(--${rem ? dir : 'dim'})">${rem ? sign + vnd(rem) : '—'}</td>
      <td data-label="Trạng thái"><span class="status"><i class="dot ${st === 'SETTLED' ? 'done' : st === 'OPEN' ? 'open' : 'part'}"></i>${STATUS_VI[st]}</span>
        ${pend ? `<span class="tag" style="margin-left:6px">Chờ xác nhận</span>` : ''}</td>
      <td data-act="noop">${pend
        ? (canConfirmSettlement(pend) ? `<button class="btn sm primary" type="button" ${A('confirmSettlement', pend.id)}>Xác nhận nhận</button>` : '')
        : (canMarkPaid(t) ? `<button class="btn sm" type="button" ${A('markPaid', t.id)}>Xác nhận trả</button>` : '')}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function getFilteredMyTxns(){
  let list = sortedMyTxns();
  if (uiFilter.status !== 'ALL') list = list.filter(t => statusOf(t) === uiFilter.status);
  if (uiFilter.q){
    const q = V.fold(uiFilter.q);
    if (q){
      list = list.filter(t => V.fold(t.title || '').includes(q) || V.fold(t.note || '').includes(q));
    }
  }
  if (uiFilter.sort === 'old') list = [...list].reverse();
  if (uiFilter.sort === 'high') list = [...list].sort((a, b) => b.amount - a.amount);
  if (uiFilter.sort === 'low')  list = [...list].sort((a, b) => a.amount - b.amount);
  return list;
}

function renderTxnListBody(){
  const list = getFilteredMyTxns();
  return list.length
    ? `<div class="tbl-wrap">${txnTable(list)}</div>`
    : `<div class="empty"><div class="empty-ic">${svgIc('ic-list', 18)}</div><b>Không có giao dịch phù hợp</b>Thử đổi bộ lọc hoặc ghi một khoản mới.</div>`;
}

let _searchDebounceTimer = 0;
function onTxnSearchInput(val){
  uiFilter.q = String(val ?? '');
  if (_isComposing) return;
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    _searchDebounceTimer = 0;
    const box = el('txnListWrap');
    if (box) box.innerHTML = renderTxnListBody();
    else scheduleRender({ forceMain:true });
  }, 150);
}
function onTxnSortChange(val){
  if (['new','old','high','low'].includes(val)) uiFilter.sort = val;
  const box = el('txnListWrap');
  if (box) box.innerHTML = renderTxnListBody();
  else scheduleRender({ forceMain:true });
}
function setTxnStatusFilter(st){
  if (['ALL','OPEN','PARTIALLY_SETTLED','SETTLED'].includes(st)) uiFilter.status = st;
  scheduleRender({ forceMain:true });
}

function vTransactions(){
  if (!peer) return noPeerView('Giao dịch');
  const chips = [['ALL','Tất cả'],['OPEN','Chưa trả'],['PARTIALLY_SETTLED','Trả một phần'],['SETTLED','Đã xong']];

  return `
  <div class="page-head">
    <div><h2>Giao dịch</h2><p>Sổ với ${esc(nameOf(peer))} · ${myTxns().length} khoản đã ghi</p></div>
    <div class="actions">
      ${isActiveFriend(peer) ? `
      <button class="btn" type="button" ${A('openQuickAdd')}>Ghi nhanh</button>
      <a class="btn primary" href="#/new">+ Giao dịch mới</a>` : `<span class="tag">Đã hủy kết bạn · chỉ xem lại</span>`}
    </div>
  </div>
  ${peerBar()}
  <div class="toolbar">
    <input class="input" id="txnSearchInput" placeholder="Tìm theo nội dung hoặc ghi chú (có hoặc không dấu)…" value="${esc(uiFilter.q)}"
      data-on-input="onTxnSearchInput">
    <select class="input" style="width:auto" data-on-change="onTxnSortChange" aria-label="Sắp xếp giao dịch">
      ${[['new','Mới nhất'],['old','Cũ nhất'],['high','Tiền nhiều nhất'],['low','Tiền ít nhất']]
        .map(([v, t]) => `<option value="${v}" ${uiFilter.sort === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <div class="chips">${chips.map(([v, t]) =>
      `<button type="button" class="chip ${uiFilter.status === v ? 'on' : ''}" ${A('setTxnStatusFilter', v)}>${t}</button>`).join('')}</div>
  </div>
  <div class="panel" id="txnListWrap">${renderTxnListBody()}</div>`;
}

/* ---- detail [D-09, U-11, F-10] ---- */
function vDetail(){
  const t = (Idx.txnById && Idx.txnById[route.param]) || Data.txns.find(x => x.id === route.param);
  if (!t || (!isAdmin() && pairIdOf(t) !== currentPairId()))
    return `<div class="panel"><div class="empty"><div class="empty-ic">${svgIc('ic-alert', 18)}</div><b>Không tìm thấy giao dịch</b>
    <div style="margin-top:12px"><a class="btn sm" href="#/transactions">Quay lại danh sách</a></div></div></div>`;
  const pid = pairIdOf(t);
  const [pa, pb] = Pair.members(pid);
  const s = split(t.amount, t.paid_by, pid), st = statusOf(t), rem = remainOf(t);
  const debtor = otherOf(t.paid_by, pid);
  const paidAmt = u => u === t.paid_by ? t.amount : (t.repaid || 0);
  const card = u => {
    const diff = paidAmt(u) - (s[u] || 0);
    return `<div class="person">
      <h4><span class="avatar">${esc(initial(nameOf(u)))}</span>${esc(nameOf(u))}${u === t.paid_by ? ' · người ứng tiền' : ''}</h4>
      <div class="kv"><span>Đã trả ngoài đời</span><b>${vnd(paidAmt(u))}</b></div>
      <div class="kv"><span>Phần phải chịu</span><b>${vnd(s[u] || 0)}</b></div>
      <div class="kv"><span>Chênh lệch</span><b style="color:var(--${diff >= 0 ? 'credit' : 'debit'})">${
        (diff > 0 ? '+' : diff < 0 ? '−' : '') + vnd(Math.abs(diff))}</b></div>
    </div>`;
  };

  const canDispute = me && (me.username === pa || me.username === pb) && t.created_by !== me.username && !t.disputed_by;
  const canClearDispute = me && t.disputed_by && (isAdmin() || me.username === t.disputed_by || me.username === t.created_by);

  return `
  <div class="page-head">
    <div><p style="margin:0 0 4px"><a href="#/transactions" style="color:var(--muted);text-decoration:none">← Giao dịch</a></p>
      <h2>${esc(t.title)}</h2>
      <p><span class="tag">${esc(CAT_VI[t.category] || t.category)}</span> · ${fmtDate(t.date)} · ${esc(nameOf(t.created_by))} tạo
      ${t.edited_at ? ` · sửa lần cuối ${fmtDT(t.edited_at)} bởi ${esc(nameOf(t.edited_by))}` : ''}
      ${t.disputed_by ? ` · <span class="tag dispute">Đang tranh chấp (${esc(nameOf(t.disputed_by))})</span>` : ''}</p></div>
    <div class="actions">
      ${(!pendingOutgoingFor(t) && canMarkPaid(t)) ? `<button class="btn primary" type="button" ${A('markPaid', t.id)}>Xác nhận đã trả</button>` : ''}
      ${canDispute ? `<button class="btn" type="button" ${A('openDisputeModal', t.id)}>Báo sai</button>` : ''}
      ${canClearDispute ? `<button class="btn" type="button" ${A('clearDispute', t.id)}>Gỡ báo sai</button>` : ''}
      ${canEdit(t) ? `<button class="btn" type="button" ${A('go', 'new', t.id)}>Sửa</button>` : ''}
      ${canDelete(t) ? `<button class="btn danger" type="button" ${A('confirmDelete', t.id)}>Xóa</button>` : ''}
    </div>
  </div>

  ${t.disputed_by ? `<div class="notice"><span><b>Đang tranh chấp:</b> ${esc(nameOf(t.disputed_by))} báo sai lúc ${fmtDT(t.disputed_at)}${t.dispute_note ? ` — “${esc(t.dispute_note)}”` : ''}.</span></div>` : ''}

  <section class="hero" style="padding:20px 24px">
    <p class="who-line">Tổng giao dịch · ${esc(nameOf(t.paid_by))} đã ứng trước toàn bộ</p>
    <p class="amount">${vnd(t.amount)}</p>
  </section>

  <div class="split" style="margin-top:12px">${card(pa)}${card(pb)}</div>

  <div class="verdict">
    <div class="l">${rem ? `${esc(nameOf(debtor))} cần trả ${esc(nameOf(t.paid_by))}` : 'Khoản này đã xong'}</div>
    <div class="a" style="color:var(--${rem ? (debtor === me.username ? 'debit' : 'credit') : 'credit'})">${
      rem ? (debtor === me.username ? '−' : '+') + vnd(rem) : vnd(0)}</div>
    <div class="l" style="margin-top:8px">
      Nợ gốc ${vnd(owedOf(t))} · đã hoàn ${vnd(t.repaid || 0)} ·
      trạng thái <b>${st}</b> (${STATUS_VI[st]})</div>
    ${(() => {
      const pend = pendingOutgoingFor(t);
      if (pend) return `<div class="preview" style="margin-top:12px">
        <div class="row"><span>Yêu cầu trả ${vnd(pend.amount)} đang chờ ${esc(nameOf(pend.to_user))} xác nhận</span>
        <span style="display:flex;gap:6px">
          ${canConfirmSettlement(pend) ? `<button class="btn sm primary" type="button" ${A('confirmSettlement', pend.id)}>Xác nhận nhận</button>
            <button class="btn sm" type="button" ${A('rejectSettlement', pend.id, false)}>Từ chối</button>` : ''}
          ${canCancelSettlement(pend) && !canConfirmSettlement(pend) ? `<button class="btn sm" type="button" ${A('rejectSettlement', pend.id, true)}>Hủy yêu cầu</button>` : ''}
        </span></div></div>`;
      if (rem && canMarkPaid(t)) return `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary sm" type="button" ${A('markPaid', t.id)}>Trả hết ${vnd(rem)}</button>
        <button class="btn sm" type="button" ${A('openPartial', t.id)}>Trả một phần</button></div>`;
      return '';
    })()}
  </div>

  ${t.note ? `<section class="section panel"><h3>Ghi chú</h3><div class="body">${esc(t.note)}</div></section>` : ''}`;
}

// [F-10] Báo sai / gỡ báo sai giao dịch (không làm đổi số dư)
function openDisputeModal(id){
  const t = Data.txns.find(x => x.id === id); if (!t) return;
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Báo sai giao dịch</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <p style="margin-top:0;color:var(--muted)">Gắn nhãn “Đang tranh chấp” cho khoản <b>${esc(t.title)}</b> (${vnd(t.amount)}) để người tạo kiểm tra lại.</p>
    <div class="field"><label for="dp_note">Lý do cần xem lại</label>
      <input class="input" id="dp_note" maxlength="200" placeholder="Ví dụ: Số tiền thực tế là 150.000 ₫"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('submitDispute', id)}>Gửi báo sai</button></footer>`);
}
async function submitDispute(id, _ctx){
  return once('dispute:' + id, async () => {
    const t = Data.txns.find(x => x.id === id); if (!t) return;
    const note = V.text(el('dp_note') ? el('dp_note').value : '', { max:200 });
    await Store.update('txns/' + id, {
      disputed_by: me.username,
      disputed_at: now(),
      dispute_note: note
    });
    await log('EDIT', 'transaction', id, { title: 'Báo sai: ' + t.title });
    closeModal();
    toast('Đã gắn nhãn tranh chấp cho giao dịch');
  }, _ctx && _ctx.node);
}
async function clearDispute(id, _ctx){
  return once('clearDispute:' + id, async () => {
    const t = Data.txns.find(x => x.id === id); if (!t) return;
    await Store.update('txns/' + id, {
      disputed_by: null,
      disputed_at: null,
      dispute_note: null
    });
    await log('EDIT', 'transaction', id, { title: 'Gỡ báo sai: ' + t.title });
    toast('Đã gỡ nhãn tranh chấp');
  }, _ctx && _ctx.node);
}

/* ---- create / edit [D-01, D-02, D-03, T-01, T-03, S-02] ---- */
function vNew(){
  const t = route.param ? Data.txns.find(x => x.id === route.param) : null;
  if (route.param && !t) return `<div class="panel"><div class="empty"><b>Không tìm thấy giao dịch</b></div></div>`;
  if (t && !canEdit(t)) return `<div class="panel"><div class="empty"><b>Bạn không được sửa giao dịch này</b>
    Chỉ người tạo hoặc quản trị viên mới sửa được.</div></div>`;
  if (t && !isAdmin() && pairIdOf(t) !== currentPairId())
    return `<div class="panel"><div class="empty"><b>Giao dịch này không thuộc sổ đang mở</b></div></div>`;
  if (!t && !peer) return noPeerView('Giao dịch mới');
  if (!t && !isActiveFriend(peer)) return `<div class="panel"><div class="empty"><b>Đã hủy kết bạn với ${esc(nameOf(peer))}</b>
    Không thể tạo giao dịch mới với người đã hủy kết bạn. Vẫn xem lại được lịch sử ở trang Giao dịch.</div></div>`;
  const pid = t ? pairIdOf(t) : currentPairId();
  const [pa, pb] = Pair.members(pid);
  const lockPayer = !!(t && ((t.repaid || 0) > 0 || hasConfirmedSettlementFor(t) || pendingOutgoingFor(t)));
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 366);
  return `
  <div class="page-head"><div>
    <h2>${t ? 'Sửa giao dịch' : 'Giao dịch mới'}</h2>
    <p>Nhập số tiền, chọn người đã trả — phần chia được tính ngay bên dưới.</p></div></div>
  <div class="split" style="align-items:start">
    <div class="panel"><div class="body">
      <input type="hidden" id="f_pair" value="${esc(pid)}">
      <div class="field"><label for="f_title">Nội dung</label>
        <input class="input" id="f_title" maxlength="80" placeholder="Ăn tối, Grab, mua nước…" value="${esc(t ? t.title : '')}"></div>
      <div class="two">
        <div class="field"><label for="f_amount">Số tiền (VND)</label>
          <input class="input num" id="f_amount" inputmode="numeric" placeholder="200.000" value="${t ? t.amount : ''}"></div>
        <div class="field"><label for="f_cat">Danh mục</label>
          <select class="input" id="f_cat">${CATEGORIES.map(c =>
            `<option value="${c}" ${t && t.category === c ? 'selected' : ''}>${esc(CAT_VI[c])}</option>`).join('')}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="f_paid">Ai đã trả</label>
          <select class="input" id="f_paid" ${lockPayer ? 'disabled' : ''}>${[pa, pb].map(u =>
            `<option value="${esc(u)}" ${(t ? t.paid_by : me.username) === u ? 'selected' : ''}>${esc(nameOf(u))}</option>`).join('')}</select>
          ${lockPayer ? `<div class="meta" style="margin-top:4px">Đã có lịch sử thanh toán nên không thể đổi người ứng tiền.</div>` : ''}</div>
        <div class="field"><label for="f_date">Ngày</label>
          <input class="input" id="f_date" type="date" min="2000-01-01" max="${localISODate(maxDate)}" value="${esc(t ? t.date : localISODate())}"></div>
      </div>
      <div class="field"><label for="f_note">Ghi chú (tùy chọn)</label>
        <textarea class="input" id="f_note" rows="2" maxlength="500" placeholder="Mua đồ ăn sau khi học">${esc(t ? t.note || '' : '')}</textarea></div>
      <div id="f_err"></div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" type="button" ${A('submitTxn', t ? t.id : null)}>${t ? 'Lưu thay đổi' : 'Thêm giao dịch'}</button>
        <a class="btn" href="#/${t ? 'transactions/' + encodeURIComponent(t.id) : 'transactions'}">Hủy</a>
      </div>
    </div></div>
    <div class="panel"><h3>Xem trước</h3><div class="body"><div id="preview"></div></div></div>
  </div>`;
}
function bindForm(){
  ['f_amount','f_paid'].forEach(id => {
    const n = el(id);
    if (n) n.addEventListener('input', drawPreview);
  });
  const p = el('f_paid');
  if (p) p.addEventListener('change', drawPreview);
  drawPreview();
}
function drawPreview(){
  const amtEl = el('f_amount'), paidEl = el('f_paid'), pairEl = el('f_pair'), box = el('preview');
  if (!amtEl || !paidEl || !pairEl || !box) return;
  const check = V.money(amtEl.value);
  const amt = check.ok ? check.value : 0;
  const paid = paidEl.value;
  const pid = pairEl.value;
  if (!amt){
    box.innerHTML = `<div class="preview"><div class="row"><span>${check.error && amtEl.value.trim() ? esc(check.error) : 'Nhập số tiền để xem phần chia'}</span></div></div>`;
    return;
  }
  const s = split(amt, paid, pid);
  const [pa, pb] = Pair.members(pid);
  const viewer = (me && (me.username === pa || me.username === pb)) ? me.username : pa;
  const partner = otherOf(viewer, pid);
  const mine = s[viewer] || 0, theirs = s[partner] || 0;
  const iPaid = paid === viewer;
  const line = iPaid ? `${nameOf(partner)} sẽ nợ ${nameOf(viewer)}` : `${nameOf(viewer)} sẽ nợ ${nameOf(paid)}`;
  const amtOwed = iPaid ? theirs : mine;
  box.innerHTML = `<div class="preview">
    <div class="row"><span>Tổng</span><b>${vnd(amt)}</b></div>
    <div class="row"><span>Phần của ${esc(nameOf(viewer))}</span><b>${vnd(mine)}</b></div>
    <div class="row"><span>Phần của ${esc(nameOf(partner))}</span><b>${vnd(theirs)}</b></div>
    <div class="row"><span>Người ứng tiền</span><b>${esc(nameOf(paid))}</b></div>
    <div class="out"><div class="row"><span>${esc(line)}</span>
      <b style="color:var(--${iPaid ? 'credit' : 'debit'})">${(iPaid ? '+' : '−') + vnd(amtOwed)}</b></div></div>
  </div>`;
}

// [D-01, D-02, D-03, C-01, C-02, S-09] Lưu giao dịch mới hoặc sửa giao dịch bằng transaction an toàn
async function submitTxn(id, _ctx){
  return once('submitTxn:' + (id || 'new'), async () => {
    const title = V.text(el('f_title') ? el('f_title').value : '', { max:80 });
    const moneyRes = V.money(el('f_amount') ? el('f_amount').value : '');
    const rawDate = (el('f_date') && el('f_date').value) ? el('f_date').value : localISODate();
    const dateRes = V.date(rawDate);
    const cat = (el('f_cat') && V.enum(el('f_cat').value, CATEGORIES)) ? el('f_cat').value : 'Other';
    const note = V.text(el('f_note') ? el('f_note').value : '', { max:500, multiline:true });

    const existing = id ? Data.txns.find(x => x.id === id) : null;
    if (id && (!existing || !canEdit(existing))) return toast('Bạn không có quyền sửa giao dịch này');

    // [D-03] Khi tạo mới luôn lấy currentPairId() và bắt buộc bạn bè đang hoạt động; khi sửa lấy từ bản ghi gốc
    const pid = existing ? pairIdOf(existing) : currentPairId();
    if (!existing && (!peer || !isActiveFriend(peer) || !pid)){
      return toast('Chỉ tạo được giao dịch trong sổ chung với bạn bè đang hoạt động');
    }
    const [pa, pb] = Pair.members(pid);
    const paid_by = el('f_paid') ? el('f_paid').value : me.username;

    const errs = [];
    if (!title) errs.push('Cần nhập nội dung giao dịch.');
    if (!moneyRes.ok) errs.push(moneyRes.error + '.');
    if (!dateRes.ok) errs.push(dateRes.error + '.');
    if (paid_by !== pa && paid_by !== pb) errs.push('Người trả không thuộc sổ chung này.');
    if (errs.length){
      if (el('f_err')) el('f_err').innerHTML = `<div class="err">${esc(errs.join(' '))}</div>`;
      return;
    }
    const amount = moneyRes.value;
    const date = dateRes.value;

    if (id){
      if (pendingOutgoingFor(existing)){
        if (el('f_err')) el('f_err').innerHTML = `<div class="err">Giao dịch đang có yêu cầu thanh toán chờ xác nhận. Hãy xác nhận hoặc hủy yêu cầu trước khi sửa.</div>`;
        return;
      }
      let abortReason = '';
      const txRes = await Store.tx('txns/' + id, cur => {
        if (cur === null) return null;
        const curRepaid = Number(cur.repaid || 0);
        const hasHistory = curRepaid > 0 || hasConfirmedSettlementFor(existing) || (cur.applied_settlements && Object.keys(cur.applied_settlements).length > 0);
        if (cur.pending_sid){
          abortReason = 'Giao dịch đang có yêu cầu chờ xác nhận, không thể sửa lúc này.';
          return undefined;
        }
        if (hasHistory && paid_by !== cur.paid_by){
          abortReason = 'Không thể đổi người ứng tiền sau khi đã có lịch sử thanh toán.';
          return undefined;
        }
        const finalPaidBy = hasHistory ? cur.paid_by : paid_by;
        const newOwed = split(amount, finalPaidBy, cur.pair_id || pid)[otherOf(finalPaidBy, cur.pair_id || pid)];
        if (newOwed < curRepaid){
          abortReason = `Phần nợ mới (${vnd(newOwed)}) nhỏ hơn số tiền đã trả (${vnd(curRepaid)}). Vui lòng nhập số tiền lớn hơn.`;
          return undefined;
        }
        const ts = now();
        return {
          ...cur,
          title,
          category: cat,
          amount,
          paid_by: finalPaidBy,
          date,
          note,
          updated_at: ts,
          edited_at: ts,
          edited_by: me.username
        };
      });
      if (!txRes.committed){
        const msg = abortReason || 'Không thể lưu thay đổi do dữ liệu vừa thay đổi.';
        if (el('f_err')) el('f_err').innerHTML = `<div class="err">${esc(msg)}</div>`;
        else toast(msg);
        return;
      }
      const meta = { title, from: existing.amount, to: amount };
      if (isAdmin() && existing.created_by !== me.username){
        meta.acted_as_admin = true;
        meta.on_behalf_of = existing.created_by;
      }
      await log('EDIT', 'transaction', id, meta);
      _formDirty = false;
      toast('Đã lưu thay đổi');
      go('transactions/' + id);
    } else {
      const nid = rid();
      const ts = now();
      await Store.set('txns', nid, {
        title,
        category: cat,
        amount,
        paid_by,
        pair_id: pid,
        created_by: me.username,
        date,
        note,
        repaid: 0,
        created_at: ts,
        updated_at: ts
      });
      await log('CREATE', 'transaction', nid, { title, amount });
      _formDirty = false;
      toast('Đã thêm giao dịch');
      go('transactions/' + nid);
    }
  }, _ctx && _ctx.node);
}

/* ---- quick add [D-01, D-03, A-03, S-02] ---- */
function openQuickAdd(){
  if (!peer) return toast('Kết bạn để bắt đầu ghi chi tiêu chung');
  if (!isActiveFriend(peer)) return toast(`Đã hủy kết bạn với ${nameOf(peer)}, không thể ghi giao dịch mới`);
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Ghi nhanh</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="q_title">Chi gì?</label>
      <input class="input" id="q_title" maxlength="80" placeholder="Ăn sáng"></div>
    <div class="two">
      <div class="field"><label for="q_amount">Bao nhiêu?</label>
        <input class="input num" id="q_amount" inputmode="numeric" placeholder="50.000"></div>
      <div class="field"><label for="q_paid">Ai trả?</label>
        <select class="input" id="q_paid">${[me.username, peer].map(u =>
          `<option value="${esc(u)}" ${me.username === u ? 'selected' : ''}>${esc(nameOf(u))}</option>`).join('')}</select></div>
    </div>
    <div id="q_prev"></div><div id="q_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('quickSubmit')}>Thêm giao dịch</button></footer>`);
  const upd = () => {
    const mRes = V.money(el('q_amount') ? el('q_amount').value : '');
    const a = mRes.ok ? mRes.value : 0;
    const p = el('q_paid') ? el('q_paid').value : me.username;
    const pid = currentPairId();
    if (el('q_prev')){
      el('q_prev').innerHTML = a && pid ? `<div class="preview"><div class="row"><span>Mỗi người</span>
        <b>${vnd(split(a, p, pid)[me.username])}</b></div><div class="row"><span>${
        p === me.username ? esc(nameOf(other(me.username))) + ' nợ bạn' : 'Bạn nợ ' + esc(nameOf(p))}</span>
        <b>${vnd(split(a, p, pid)[other(p)])}</b></div></div>` : '';
    }
  };
  if (el('q_amount')) el('q_amount').addEventListener('input', upd);
  if (el('q_paid')) el('q_paid').addEventListener('change', upd);
  if (el('q_title')) el('q_title').focus();
}

async function quickSubmit(_arg, _ctx){
  return once('quickSubmit', async () => {
    if (!peer || !isActiveFriend(peer)) return toast('Bạn bè không còn hoạt động, không thể ghi giao dịch mới');
    const title = V.text(el('q_title') ? el('q_title').value : '', { max:80 });
    const moneyRes = V.money(el('q_amount') ? el('q_amount').value : '');
    const paid_by = el('q_paid') ? el('q_paid').value : '';
    if (!title || !moneyRes.ok || (paid_by !== me.username && paid_by !== peer)){
      const msg = !title ? 'Cần nhập nội dung.' : (!moneyRes.ok ? moneyRes.error : 'Người trả không hợp lệ.');
      if (el('q_err')) el('q_err').innerHTML = `<div class="err">${esc(msg)}</div>`;
      return;
    }
    const amount = moneyRes.value;
    const pid = currentPairId();
    const nid = rid();
    const ts = now();
    await Store.set('txns', nid, {
      title, category:'Other', amount, paid_by, pair_id:pid,
      created_by:me.username, date:localISODate(), note:'', repaid:0, created_at:ts, updated_at:ts
    });
    await log('CREATE', 'transaction', nid, { title, amount });
    closeModal();
    toast(`Đã thêm · ${vnd(split(amount, paid_by, pid)[other(paid_by)])} còn nợ`);
  }, _ctx && _ctx.node);
}

/* ---- pay / settle [D-04, D-11, C-03, S-09] ---- */
// [C-03] Cấp phát khoá mềm pending_sid bằng transaction trên txns/{id} trước khi tạo settlement
async function payTxn(t, amount, note){
  if (!t || !t.id) return 0;
  if (pendingOutgoingFor(t)){
    toast('Khoản này đang có yêu cầu chờ xác nhận, đợi hoặc hủy yêu cầu cũ trước đã');
    return 0;
  }
  const sid = rid();
  let pay = 0;
  let conflict = false;
  const lockRes = await Store.tx('txns/' + t.id, cur => {
    if (cur === null) return null;
    if (cur.pending_sid){
      conflict = true;
      return undefined;
    }
    const curPid = cur.pair_id || 'duy_nguyen';
    const curOwed = split(cur.amount, cur.paid_by, curPid)[otherOf(cur.paid_by, curPid)];
    const curRem = Math.max(0, curOwed - (Number(cur.repaid) || 0));
    pay = Math.min(Math.trunc(amount), curRem);
    if (pay <= 0) return undefined;
    return { ...cur, pending_sid: sid };
  });
  if (!lockRes.committed || pay <= 0){
    if (conflict) toast('Khoản này đang có yêu cầu chờ xác nhận, đợi hoặc hủy yêu cầu cũ trước đã');
    return 0;
  }
  const pid = pairIdOf(t);
  try {
    await Store.set('settlements', sid, {
      from_user: otherOf(t.paid_by, pid),
      to_user: t.paid_by,
      pair_id: pid,
      amount: pay,
      transaction_id: t.id,
      note: V.text(note || '', { max:200 }),
      created_at: now(),
      created_by: me.username,
      status: 'PENDING'
    });
  } catch (e){
    // Hoàn lại khoá mềm nếu ghi settlement lỗi
    await Store.update('txns/' + t.id, { pending_sid: null }).catch(() => {});
    throw e;
  }
  return pay;
}

async function markPaid(id, _ctx){
  return once('markPaid:' + id, async () => {
    const t = Data.txns.find(x => x.id === id);
    if (!t || !canMarkPaid(t)) return toast('Bạn không có quyền xác nhận khoản này');
    const paid = await payTxn(t, remainOf(t), 'Trả đủ');
    if (!paid) return;
    const debtor = otherOf(t.paid_by, pairIdOf(t));
    const meta = { title: t.title, amount: paid };
    if (isAdmin() && me.username !== debtor){
      meta.acted_as_admin = true;
      meta.on_behalf_of = debtor;
    }
    await log('MARK_PAID', 'transaction', id, meta);
    toast(`Đã gửi yêu cầu · chờ ${nameOf(t.paid_by)} xác nhận ${vnd(paid)}`);
  }, _ctx && _ctx.node);
}

// [D-04, C-01, S-09] Xác nhận thanh toán 2 bước idempotent với applied_settlements
async function confirmSettlement(id, _ctx){
  return once('confirmSettlement:' + id, async () => {
    const s = Data.settlements.find(x => x.id === id);
    if (!s || !canConfirmSettlement(s)) return toast('Bạn không có quyền xác nhận khoản này');
    const tid = s.transaction_id;
    if (!tid) return toast('Yêu cầu thanh toán không hợp lệ');

    let errReason = '';
    let txnTitle = '';
    // Bước 1: Transaction trên txns/{tid} với dấu idempotent applied_settlements[id]
    const tx1 = await Store.tx('txns/' + tid, cur => {
      if (cur === null) return null;
      txnTitle = cur.title || '';
      const applied = (cur.applied_settlements && typeof cur.applied_settlements === 'object')
        ? { ...cur.applied_settlements } : {};
      if (applied[id]){
        // Đã cộng vào repaid ở lần chạy trước -> chỉ dọn pending_sid nếu còn sót
        if (cur.pending_sid === id){
          const next = { ...cur };
          delete next.pending_sid;
          return next;
        }
        return cur;
      }
      const curPid = cur.pair_id || 'duy_nguyen';
      const owed = split(cur.amount, cur.paid_by, curPid)[otherOf(cur.paid_by, curPid)];
      const curRepaid = Number(cur.repaid || 0);
      if (curRepaid + s.amount > owed){
        errReason = 'Số tiền vượt phần còn nợ của giao dịch, hãy từ chối yêu cầu này và tạo lại.';
        return undefined;
      }
      applied[id] = true;
      const next = {
        ...cur,
        repaid: curRepaid + s.amount,
        applied_settlements: applied,
        updated_at: now()
      };
      if (next.pending_sid === id) delete next.pending_sid;
      return next;
    });

    if (!tx1.exists){
      return toast('Giao dịch gốc đã bị xóa, không thể xác nhận. Bạn có thể từ chối/hủy yêu cầu này.');
    }
    if (!tx1.committed){
      return toast(errReason || 'Không thể xác nhận khoản thanh toán lúc này.');
    }

    // Bước 2: Transaction trên settlements/{id} chuyển PENDING -> CONFIRMED
    const ts = now();
    await Store.tx('settlements/' + id, cur => {
      if (cur === null) return null;
      const st = cur.status || 'CONFIRMED';
      if (st !== 'PENDING') return cur;
      return {
        ...cur,
        status: 'CONFIRMED',
        confirmed_by: me.username,
        confirmed_at: ts
      };
    });

    const meta = { title: txnTitle, amount: s.amount };
    if (isAdmin() && s.to_user !== me.username){
      meta.acted_as_admin = true;
      meta.on_behalf_of = s.to_user;
    }
    await log('SETTLEMENT', 'settlement', id, meta);
    toast(`Đã xác nhận nhận ${vnd(s.amount)}`);
  }, _ctx && _ctx.node);
}

// [D-04, C-03, S-09] Từ chối hoặc hủy yêu cầu thanh toán (chặn nếu đã có dấu applied)
async function rejectSettlement(id, byRequester, _ctx){
  return once('rejectSettlement:' + id, async () => {
    const s = Data.settlements.find(x => x.id === id);
    if (!s) return;
    if (byRequester ? !canCancelSettlement(s) : !canConfirmSettlement(s)){
      return toast('Bạn không có quyền thao tác khoản này');
    }
    const t = Data.txns.find(x => x.id === s.transaction_id);
    if (t && t.applied_settlements && t.applied_settlements[id]){
      // Nếu bước 1 đã cộng tiền vào giao dịch rồi thì chỉ cho phép hoàn tất xác nhận
      return confirmSettlement(id, _ctx);
    }

    const ts = now();
    const res = await Store.tx('settlements/' + id, cur => {
      if (cur === null) return null;
      if ((cur.status || 'CONFIRMED') !== 'PENDING') return undefined;
      return {
        ...cur,
        status: 'REJECTED',
        confirmed_by: me.username,
        confirmed_at: ts
      };
    });
    if (!res.committed) return toast('Yêu cầu này đã được xử lý trước đó');

    // Giải phóng khoá mềm pending_sid trên giao dịch gốc nếu đang giữ
    if (s.transaction_id){
      await Store.tx('txns/' + s.transaction_id, cur => {
        if (cur === null) return null;
        if (cur.pending_sid !== id) return cur;
        const next = { ...cur };
        delete next.pending_sid;
        return next;
      }).catch(() => {});
    }

    const meta = {
      title: byRequester ? 'Hủy yêu cầu thanh toán' : 'Từ chối xác nhận',
      amount: s.amount
    };
    const expectedActor = byRequester ? s.from_user : s.to_user;
    if (isAdmin() && me.username !== expectedActor){
      meta.acted_as_admin = true;
      meta.on_behalf_of = expectedActor;
    }
    await log('EDIT', 'settlement', id, meta);
    toast(byRequester ? 'Đã hủy yêu cầu thanh toán' : 'Đã từ chối xác nhận');
  }, _ctx && _ctx.node);
}

function openPartial(id){
  const t = Data.txns.find(x => x.id === id);
  if (!t || !canMarkPaid(t)) return toast('Bạn không có quyền thao tác khoản này');
  if (pendingOutgoingFor(t)) return toast('Khoản này đang có yêu cầu chờ xác nhận');
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Trả một phần</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body"><p style="margin-top:0;color:var(--muted)">Còn lại ${vnd(remainOf(t))} cho “${esc(t.title)}”.</p>
  <div class="field"><label for="pp">Số tiền trả</label>
    <input class="input num" id="pp" inputmode="numeric" value="${remainOf(t)}"></div>
  <div id="pp_err"></div></div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doPartial', id)}>Ghi nhận</button></footer>`);
}
async function doPartial(id, _ctx){
  return once('doPartial:' + id, async () => {
    const t = Data.txns.find(x => x.id === id);
    if (!t || !canMarkPaid(t)) return toast('Không có quyền');
    const mRes = V.money(el('pp') ? el('pp').value : '');
    if (!mRes.ok){
      if (el('pp_err')) el('pp_err').innerHTML = `<div class="err">${esc(mRes.error)}</div>`;
      else toast(mRes.error);
      return;
    }
    const paid = await payTxn(t, mRes.value, 'Trả một phần');
    if (!paid){ closeModal(); return; }
    const debtor = otherOf(t.paid_by, pairIdOf(t));
    const meta = { title: t.title, amount: paid };
    if (isAdmin() && me.username !== debtor){
      meta.acted_as_admin = true;
      meta.on_behalf_of = debtor;
    }
    await log('MARK_PAID', 'transaction', id, meta);
    closeModal();
    toast(`Đã gửi yêu cầu · chờ ${nameOf(t.paid_by)} xác nhận ${vnd(paid)}`);
  }, _ctx && _ctx.node);
}

function vSettlements(){
  if (!peer) return noPeerView('Cân nợ');
  const b = balanceText();
  const open = sortedMyTxns().filter(t => remainOf(t) > 0);
  const pid = currentPairId();
  const incoming = Data.settlements.filter(s => !s._invalid && pairIdOf(s) === pid && settlementStatus(s) === 'PENDING' && s.to_user === me.username);
  const outgoing = Data.settlements.filter(s => !s._invalid && pairIdOf(s) === pid && settlementStatus(s) === 'PENDING' && s.from_user === me.username);
  const canSettleNow = b.amount > 0 && (isAdmin() || b.debtor === me.username);
  return `
  <div class="page-head"><div><h2>Cân nợ</h2>
    <p>Trả một lần cho toàn bộ số dư giữa bạn và ${esc(nameOf(peer))}.</p></div></div>
  ${peerBar()}
  ${incoming.length ? `<section class="section panel"><h3>Chờ bạn xác nhận (${incoming.length})</h3><div class="body">
    ${incoming.map(s => {
      const t = (Idx.txnById && Idx.txnById[s.transaction_id]) || Data.txns.find(x => x.id === s.transaction_id);
      return `<div class="kv"><span>${esc(nameOf(s.from_user))} báo đã trả ${vnd(s.amount)}${t ? ` · “${esc(t.title)}”` : ' · (Giao dịch đã xóa)'}</span>
      <span style="display:flex;gap:6px">
        ${t ? `<button class="btn sm primary" type="button" ${A('confirmSettlement', s.id)}>Xác nhận nhận</button>` : ''}
        <button class="btn sm" type="button" ${A('rejectSettlement', s.id, false)}>Từ chối</button></span></div>`;
    }).join('')}
  </div></section>` : ''}
  ${outgoing.length ? `<section class="section panel"><h3>Đang chờ xác nhận (${outgoing.length})</h3><div class="body">
    ${outgoing.map(s => {
      const t = (Idx.txnById && Idx.txnById[s.transaction_id]) || Data.txns.find(x => x.id === s.transaction_id);
      return `<div class="kv"><span>Chờ ${esc(nameOf(s.to_user))} xác nhận ${vnd(s.amount)}${t ? ` · “${esc(t.title)}”` : ' · (Giao dịch đã xóa)'}</span>
      <button class="btn sm" type="button" ${A('rejectSettlement', s.id, true)}>Hủy yêu cầu</button></div>`;
    }).join('')}
  </div></section>` : ''}
  <section class="hero">
    <p class="who-line">${esc(nameOf(me.username))} ↔ ${esc(nameOf(peer))}</p>
    <p class="amount ${b.amount ? (b.debtor === me.username ? 'debit' : 'credit') : ''}">${
      b.amount ? (b.debtor === me.username ? '−' : '+') + vnd(b.amount) : vnd(0)}</p>
    <p class="sub">${b.amount ? esc(b.text) : (open.length ? 'Số dư ròng đã cân bằng (còn các khoản ngược chiều nhau bên dưới).' : 'Không ai nợ ai. Ghi thêm giao dịch khi có khoản chi mới.')}</p>
    <div class="hero-actions">
      ${canSettleNow ? `<button class="btn primary" type="button" ${A('openSettle')}>Thanh toán ${vnd(b.amount)}</button>` : ''}
      <a class="btn" href="#/history">Lịch sử trả</a>
    </div>
  </section>
  <section class="section panel"><h3>Các khoản còn dang dở (${open.length})</h3>
  ${open.length ? `<div class="tbl-wrap">${txnTable(open)}</div>`
    : `<div class="empty"><div class="empty-ic">${svgIc('ic-scale', 18)}</div><b>Sạch nợ</b>Tất cả giao dịch đã được hoàn tất.</div>`}</section>`;
}

function openSettle(){
  const b = balanceText();
  if (!b.amount) return;
  if (!isAdmin() && b.debtor !== me.username) return toast('Chỉ người đang nợ mới tạo được yêu cầu thanh toán');
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Xác nhận thanh toán</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="verdict" style="margin:0">
      <div class="l">${esc(nameOf(b.debtor))} → ${esc(nameOf(b.creditor))}</div>
      <div class="a">${vnd(b.amount)}</div>
      <div class="l" style="margin-top:8px">Số tiền sẽ được phân bổ vào các giao dịch còn nợ (khoản cũ trước) trong một thao tác nguyên tử.</div>
    </div>
    <div class="field" style="margin-top:14px"><label for="s_amt">Số tiền thanh toán</label>
      <input class="input num" id="s_amt" inputmode="numeric" value="${b.amount}"></div>
    <div id="s_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doSettle')}>Xác nhận</button></footer>`);
}

// [D-11, A-05] Hàm thuần tính kế hoạch phân bổ tiền cân nợ (dễ kiểm thử độc lập)
function planSettle(txnsList, debtor, maxAmount){
  const targets = (txnsList || [])
    .filter(t => !t._invalid && remainOf(t) > 0 && otherOf(t.paid_by, pairIdOf(t)) === debtor)
    .sort((x, y) => (x.date || '').localeCompare(y.date || '')
      || (x.created_at || '').localeCompare(y.created_at || '')
      || String(x.id || '').localeCompare(String(y.id || '')));
  let left = Math.max(0, Math.trunc(maxAmount));
  const allocations = [];
  const blocked = [];
  for (const t of targets){
    if (left <= 0) break;
    if (pendingOutgoingFor(t)){
      blocked.push(t);
      continue;
    }
    const pay = Math.min(left, remainOf(t));
    if (pay > 0){
      allocations.push({ txn: t, amount: pay });
      left -= pay;
    }
  }
  return { allocations, totalAllocated: maxAmount - left, blocked };
}

// [D-11] Ghi tất cả settlement cân nợ + khoá mềm pending_sid bằng MỘT lệnh Store.multi() nguyên tử
async function doSettle(_arg, _ctx){
  return once('doSettle', async () => {
    const b = balanceText();
    if (!b.amount) return;
    if (!isAdmin() && b.debtor !== me.username) return toast('Chỉ người đang nợ mới xác nhận trả');
    const mRes = V.money(el('s_amt') ? el('s_amt').value : '');
    if (!mRes.ok){
      if (el('s_err')) el('s_err').innerHTML = `<div class="err">${esc(mRes.error)}</div>`;
      return;
    }
    const amt = Math.min(mRes.value, b.amount);
    const plan = planSettle(myTxns(), b.debtor, amt);
    if (plan.blocked.length){
      const msg = `Có ${plan.blocked.length} giao dịch đang chờ xác nhận trước đó. Hãy hoàn tất hoặc hủy yêu cầu cũ trước khi cân nợ.`;
      if (el('s_err')) el('s_err').innerHTML = `<div class="err">${esc(msg)}</div>`;
      else toast(msg);
      return;
    }
    if (!plan.allocations.length){
      closeModal();
      return toast('Không có khoản nào phù hợp để gửi yêu cầu');
    }
    const ts = now();
    const map = {};
    for (const item of plan.allocations){
      const t = item.txn;
      const pid = pairIdOf(t);
      const sid = rid();
      map[`txns/${t.id}/pending_sid`] = sid;
      map[`settlements/${sid}`] = {
        from_user: otherOf(t.paid_by, pid),
        to_user: t.paid_by,
        pair_id: pid,
        amount: item.amount,
        transaction_id: t.id,
        note: 'Cân nợ',
        created_at: ts,
        created_by: me.username,
        status: 'PENDING'
      };
    }
    await Store.multi(map);
    const meta = { from: b.debtor, to: b.creditor, amount: plan.totalAllocated };
    if (isAdmin() && me.username !== b.debtor){
      meta.acted_as_admin = true;
      meta.on_behalf_of = b.debtor;
    }
    await log('SETTLEMENT', 'settlement', rid(), meta);
    closeModal();
    toast(`Đã gửi yêu cầu cân nợ ${vnd(plan.totalAllocated)} · chờ ${nameOf(b.creditor)} xác nhận`);
  }, _ctx && _ctx.node);
}

/* ---- history [T-02, D-05, U-06] ---- */
const SETTLE_STATUS_VI = {CONFIRMED:'Đã xác nhận', PENDING:'Chờ xác nhận', REJECTED:'Đã từ chối/hủy'};
function setHistoryMonth(m){
  uiFilter.month = m || 'ALL';
  scheduleRender({ forceMain:true });
}
function vHistory(){
  if (!peer) return noPeerView('Lịch sử trả');
  const list = [...mySettlements()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const months = [...new Set(list.map(s => monthKeyOf(s.confirmed_at || s.created_at)).filter(Boolean))];
  const m = uiFilter.month && months.includes(uiFilter.month) ? uiFilter.month : 'ALL';
  const shown = m === 'ALL' ? list : list.filter(s => monthKeyOf(s.confirmed_at || s.created_at) === m);
  const total = shown.filter(s => settlementStatus(s) === 'CONFIRMED').reduce((a, s) => a + s.amount, 0);
  return `
  <div class="page-head"><div><h2>Lịch sử trả</h2>
    <p>${shown.length} lần thanh toán · tổng đã xác nhận ${vnd(total)}. Lịch sử không bị xóa.</p></div></div>
  ${peerBar()}
  <div class="toolbar"><div class="chips">
    <button type="button" class="chip ${m === 'ALL' ? 'on' : ''}" ${A('setHistoryMonth', 'ALL')}>Tất cả</button>
    ${months.map(x => `<button type="button" class="chip ${m === x ? 'on' : ''}" ${A('setHistoryMonth', x)}>${esc(x)}</button>`).join('')}
  </div></div>
  <div class="panel">${shown.length ? `<div class="tbl-wrap"><table class="resp-tbl">
    <thead><tr><th>Thời gian</th><th>Từ</th><th>Đến</th><th class="num">Số tiền</th><th>Cho giao dịch</th><th>Trạng thái</th></tr></thead>
    <tbody>${shown.map(s => {
      const t = (Idx.txnById && Idx.txnById[s.transaction_id]) || Data.txns.find(x => x.id === s.transaction_id);
      const tr = !t && Idx.trashById ? Idx.trashById[s.transaction_id] : null;
      const txnTitle = t ? t.title : (tr && tr.data && tr.data.title ? `${tr.data.title} (đã xóa)` : '—');
      const st = settlementStatus(s);
      return `<tr><td class="meta num" data-label="Thời gian">${fmtDT(s.created_at)}</td>
      <td data-label="Từ">${esc(nameOf(s.from_user))}</td>
      <td data-label="Đến">${esc(nameOf(s.to_user))}</td>
      <td class="num" data-label="Số tiền">${vnd(s.amount)}</td>
      <td class="meta" data-label="Cho giao dịch">${esc(txnTitle)}${s.note ? ` · ${esc(s.note)}` : ''}</td>
      <td data-label="Trạng thái"><span class="status"><i class="dot ${st === 'CONFIRMED' ? 'done' : st === 'PENDING' ? 'open' : 'part'}"></i>${SETTLE_STATUS_VI[st]}</span></td></tr>`;
    }).join('')}
    </tbody></table></div>`
    : `<div class="empty"><div class="empty-ic">${svgIc('ic-clock', 18)}</div><b>Chưa có lần thanh toán nào</b>Khi ai đó trả nợ, nó sẽ được ghi lại ở đây.</div>`}</div>`;
}

/* ---- activity [D-12, S-09] ---- */
const ACT_VI = {
  CREATE:'tạo', EDIT:'sửa', DELETE:'xóa', MARK_PAID:'xác nhận trả',
  SETTLEMENT:'cân nợ', LOGIN:'đăng nhập', LOGOUT:'đăng xuất',
  DEPOSIT:'nạp tiết kiệm', WITHDRAW:'rút tiết kiệm', RESTORE:'khôi phục'
};
function vActivity(){
  let list = [...Data.activity].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (!isAdmin()) list = list.filter(a => a && a.user_id === me.username);
  return `
  <div class="page-head"><div><h2>Nhật ký hoạt động</h2>
    <p>${isAdmin() ? 'Toàn bộ hoạt động trên hệ thống.' : 'Hoạt động của bạn.'}</p></div></div>
  <div class="panel"><div class="body">${list.length ? list.slice(0, 200).map(a => `
    <div class="log"><time>${fmtDT(a.created_at)}</time>
    <div><b>${esc(nameOf(a.user_id))}</b> ${ACT_VI[a.action] || esc(a.action)}
    ${a.metadata && a.metadata.title ? ` “${esc(a.metadata.title)}”` : ''}
    ${a.metadata && a.metadata.amount ? ` · ${vnd(a.metadata.amount)}` : ''}
    ${a.metadata && a.metadata.acted_as_admin && a.metadata.on_behalf_of
      ? ` <span class="tag">Thay mặt ${esc(nameOf(a.metadata.on_behalf_of))}</span>` : ''}</div></div>`).join('')
    : `<div class="empty"><div class="empty-ic">${svgIc('ic-activity', 18)}</div><b>Chưa có hoạt động</b>Mọi thao tác quan trọng sẽ xuất hiện ở đây.</div>`}</div></div>`;
}

/* ---- settings [K9, S-03, S-04, C-04, U-17] ---- */
function vSettings(){
  return `
  <div class="page-head"><div><h2>Cài đặt</h2><p>Tài khoản, bảo mật và phiên đăng nhập.</p></div></div>
  <div class="split" style="align-items:start">
    <div class="panel"><h3>Tài khoản</h3><div class="body">
      <div class="kv"><span>Tên đăng nhập</span><b>${esc(me.username)}</b></div>
      <div class="kv"><span>Tên hiển thị</span><b>${esc(nameOf(me.username))}</b></div>
      <div class="kv"><span>Vai trò</span><b>${esc(ROLE_VI[myRole()])}</b></div>
      ${groupLimit() !== undefined ? `<div class="kv"><span>Lượt tạo nhóm</span><b class="num">${Math.min(groupQuotaUsed(), groupLimit())}/${groupLimit()}</b></div>` : ''}
      <p class="hint">Tên đăng nhập và vai trò do quản trị viên cấp phát.</p>
    </div></div>
    <div class="panel"><h3>Bảo mật</h3><div class="body">
      <div class="field"><label for="pw1">Mật khẩu hiện tại</label><input class="input" id="pw1" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pw2">Mật khẩu mới (tối thiểu ${MIN_PW_LEN} ký tự)</label><input class="input" id="pw2" type="password" autocomplete="new-password"></div>
      <div id="pw_err"></div>
      <button class="btn primary" type="button" ${A('changePw')}>Đổi mật khẩu</button>
      <p class="hint">Mật khẩu được lưu dưới dạng mã băm một chiều trên cơ sở dữ liệu Firebase Realtime Database. Khi bạn đổi mật khẩu, các phiên đăng nhập cũ trên thiết bị khác sẽ tự động hết hiệu lực.</p>
    </div></div>
  </div>
  <section class="section panel"><h3>Đi nhanh tới các trang</h3><div class="body">
    <p class="hint" style="margin-top:0">Truy cập nhanh các công cụ cá nhân, nhóm và nhật ký hệ thống.</p>
    <div class="actions">
      <a class="btn" href="#/groups">Nhóm</a>
      <a class="btn" href="#/savings">Sổ tiết kiệm</a>
      <a class="btn" href="#/budget">Ngân sách</a>
      <a class="btn" href="#/history">Lịch sử trả</a>
      <a class="btn" href="#/activity">Nhật ký</a>
      ${canManageUsers() ? `<a class="btn" href="#/admin">Quản trị</a>` : ''}
    </div>
  </div></section>
  <section class="section panel"><h3>Phiên &amp; Phiên bản</h3><div class="body">
    <div class="kv"><span>Phiên bản ứng dụng</span><b class="num">v${APP_VERSION} (Sổ chung v4)</b></div>
    <div class="kv"><span>Trạng thái kết nối</span><b>${Store.online ? 'Đang trực tuyến' : 'Mất kết nối mạng'}</b></div>
    <div style="margin-top:12px"><button class="btn danger" type="button" ${A('logout')}>Đăng xuất</button></div>
  </div></section>`;
}

function vForceChangePw(){
  return `
  <div class="page-head"><div><h2>Đổi mật khẩu bắt buộc</h2>
    <p>Tài khoản của bạn đang dùng mật khẩu tạm hoặc mật khẩu mặc định — vui lòng đặt mật khẩu mới (ít nhất ${MIN_PW_LEN} ký tự) để tiếp tục.</p></div></div>
  <div class="panel"><div class="body">
    <div class="field"><label for="pw1">Mật khẩu hiện tại</label><input class="input" id="pw1" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="pw2">Mật khẩu mới (tối thiểu ${MIN_PW_LEN} ký tự)</label><input class="input" id="pw2" type="password" autocomplete="new-password"></div>
    <div id="pw_err"></div>
    <button class="btn primary" type="button" ${A('changePw')}>Lưu mật khẩu mới</button>
  </div></div>`;
}

async function changePw(_arg, _ctx){
  return once('changePw', async () => {
    const cur = el('pw1') ? el('pw1').value : '';
    const next = el('pw2') ? el('pw2').value : '';
    const pwErr = validateNewPassword(next, me.username);
    if (pwErr){
      if (el('pw_err')) el('pw_err').innerHTML = `<div class="err">${esc(pwErr)}</div>`;
      return;
    }
    const storedHash = await userCredHash(me.username);
    const ver = await verifyPasswordHash(cur, storedHash);
    if (!ver.ok){
      if (el('pw_err')) el('pw_err').innerHTML = `<div class="err">Mật khẩu hiện tại không đúng.</div>`;
      return;
    }
    const newHash = await makePasswordHash(next);
    const ts = now();
    // [C-04, S-03] Chỉ cập nhật khoá của chính mình trong config/auth và đánh dấu pw_changed_at
    await saveUserCred(me.username, newHash);
    await Store.update('users/' + me.username, { must_change_pw: false, pw_changed_at: ts });
    saveSession(me.username);
    me.must_change_pw = false;
    me.pw_changed_at = ts;
    Data.usersById[me.username] = me;
    if (mustChangePw){
      mustChangePw = false;
      toast('Đã đổi mật khẩu. Chào mừng bạn!');
      route = { path:'dashboard', param:null };
      location.hash = '#/dashboard';
      scheduleRender({ forceMain:true });
    } else {
      if (el('pw_err')) el('pw_err').innerHTML = '';
      if (el('pw1')) el('pw1').value = '';
      if (el('pw2')) el('pw2').value = '';
      toast('Đã đổi mật khẩu thành công');
    }
  }, _ctx && _ctx.node);
}
/* ===== /V4 ===== */
/* ===== V4 · [S-01, L-01..L-03, D-12, D-13, C-01, F-01, F-05] Bạn bè, Nhóm, Sổ tiết kiệm & Ngân sách ===== */

/* ---- friends [S-01, L-01, C-05, F-01] ---- */
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
        <input class="input" id="fr_q" maxlength="20" placeholder="username" autocapitalize="none" spellcheck="false"
          data-on-enter="sendFriendRequest">
        <button class="btn primary" type="button" ${A('sendFriendRequest')}>Gửi lời mời</button>
      </div></div>
    <div id="fr_err"></div>
  </div></div>

  ${incoming.length ? `<section class="section panel"><h3>Lời mời đang chờ bạn (${incoming.length})</h3><div class="body">
    ${incoming.map(f => `<div class="kv"><span>${esc(nameOf(f.requested_by))} (${esc(f.requested_by)}) muốn kết bạn</span>
      <span style="display:flex;gap:6px">
        <button class="btn sm primary" type="button" ${A('respondFriend', f.id, true)}>Chấp nhận</button>
        <button class="btn sm" type="button" ${A('respondFriend', f.id, false)}>Từ chối</button></span></div>`).join('')}
  </div></section>` : ''}

  ${outgoing.length ? `<section class="section panel"><h3>Lời mời đã gửi (${outgoing.length})</h3><div class="body">
    ${outgoing.map(f => {
      const to = f.user_a === me.username ? f.user_b : f.user_a;
      return `<div class="kv"><span>Đang chờ ${esc(nameOf(to))} (${esc(to)}) phản hồi</span>
        <button class="btn sm" type="button" ${A('cancelFriendRequest', f.id)}>Hủy lời mời</button></div>`;
    }).join('')}
  </div></section>` : ''}

  <section class="section panel"><h3>Bạn bè (${friends.length})</h3><div class="body">
    ${friends.length ? friends.map(u => `
      <div class="kv"><span>${esc(nameOf(u))} (${esc(u)})${u === peer ? ' · đang mở' : ''}</span>
      <span style="display:flex;gap:6px">
        ${u === peer ? `<span class="tag">Sổ đang mở</span>`
          : `<button class="btn sm" type="button" ${A('switchPeer', u)}>Mở sổ chung</button>`}
        <button class="btn sm" type="button" ${A('confirmUnfriend', u)}>Hủy kết bạn</button>
      </span></div>`).join('')
      : `<div class="empty"><div class="empty-ic">${svgIc('ic-user-plus', 18)}</div><b>Chưa có bạn bè</b>Gửi lời mời kết bạn ở trên để bắt đầu tạo sổ chung.</div>`}
  </div></section>

  ${endedFriends().length ? `<section class="section panel"><h3>Đã hủy kết bạn (${endedFriends().length})</h3>
  <div class="body"><p class="hint" style="margin-top:0">Chỉ xem lại được lịch sử — không tạo giao dịch hay nhắn tin mới.</p>
    ${endedFriends().map(u => `<div class="kv"><span>${esc(nameOf(u))} (${esc(u)})${u === peer ? ' · đang mở' : ''}</span>
    ${u === peer ? `<span class="tag">Đang xem</span>` : `<button class="btn sm" type="button" ${A('switchPeer', u)}>Xem lại lịch sử</button>`}</div>`).join('')}
  </div></section>` : ''}`;
}

async function sendFriendRequest(_arg, _ctx){
  return once('sendFriendRequest', async () => {
    const uname = (el('fr_q') ? el('fr_q').value : '').trim().toLowerCase();
    if (!uname) return;
    if (uname === me.username){
      if (el('fr_err')) el('fr_err').innerHTML = `<div class="err">Không thể tự kết bạn với chính mình.</div>`;
      return;
    }
    if (pendingOutgoing().length >= 20){
      if (el('fr_err')) el('fr_err').innerHTML = `<div class="err">Bạn đang có tối đa 20 lời mời chờ phản hồi. Hãy hủy bớt trước khi gửi thêm.</div>`;
      return;
    }
    const target = await getUserDoc(uname);
    if (!target){
      if (el('fr_err')) el('fr_err').innerHTML = `<div class="err">Không tìm thấy tài khoản "${esc(uname)}".</div>`;
      return;
    }
    const id = makePairId(me.username, uname);
    const [ua, ub] = [me.username, uname].sort();
    let conflictMsg = '';
    const txRes = await Store.tx('friendships/' + id, cur => {
      if (cur !== null && cur !== undefined && !cur.ended_at){
        conflictMsg = cur.status === 'ACCEPTED'
          ? 'Hai người đã là bạn bè.'
          : 'Đã có lời mời đang chờ giữa hai người.';
        return undefined;
      }
      // [L-01] Nếu kết bạn lại sau khi đã hủy (cur.ended_at có giá trị), ghi bản ghi mới không còn ended_at/ended_by
      return {
        user_a: ua,
        user_b: ub,
        status: 'PENDING',
        requested_by: me.username,
        created_at: now()
      };
    });
    if (!txRes.committed){
      if (el('fr_err')) el('fr_err').innerHTML = `<div class="err">${esc(conflictMsg || 'Không thể gửi lời mời lúc này.')}</div>`;
      return;
    }
    await log('CREATE', 'friendship', id, { title: nameOf(uname) });
    if (el('fr_q')) el('fr_q').value = '';
    if (el('fr_err')) el('fr_err').innerHTML = '';
    toast('Đã gửi lời mời kết bạn');
  }, _ctx && _ctx.node);
}

// [F-01, S-01] Người gửi tự thu hồi lời mời kết bạn đang chờ
async function cancelFriendRequest(id, _ctx){
  return once('cancelFriendRequest:' + id, async () => {
    const f = Data.friendships.find(x => x.id === id);
    if (!f || f.status !== 'PENDING' || f.requested_by !== me.username){
      return toast('Không thể hủy lời mời này');
    }
    await Store.del('friendships', id);
    await log('DELETE', 'friendship', id, { title: 'Thu hồi lời mời kết bạn' });
    toast('Đã hủy lời mời kết bạn');
  }, _ctx && _ctx.node);
}

function hasOpenGroupTies(u1, u2){
  for (const gt of Data.group_txns){
    if (gt._invalid) continue;
    const g = groupById(gt.group_id); if (!g) continue;
    if (!isGroupMember(g, u1) || !isGroupMember(g, u2)) continue;
    const payer = gt.paid_by;
    const debtor = payer === u1 ? u2 : (payer === u2 ? u1 : null);
    if (!debtor) continue;
    if (groupOwedTo(gt, debtor) > 0) return true;
  }
  return false;
}
function canUnfriend(pairId){
  const [u1, u2] = Pair.members(pairId);
  const openTxns = Data.txns.filter(t => !t._invalid && pairIdOf(t) === pairId && remainOf(t) > 0).length;
  const pendingSettle = Data.settlements.filter(s => !s._invalid && pairIdOf(s) === pairId && settlementStatus(s) === 'PENDING').length;
  const groupTies = hasOpenGroupTies(u1, u2);
  return { ok: openTxns === 0 && pendingSettle === 0 && !groupTies, openTxns, pendingSettle, groupTies };
}
function confirmUnfriend(u){
  const check = canUnfriend(makePairId(me.username, u));
  if (!check.ok){
    const parts = [];
    if (check.openTxns) parts.push(`${check.openTxns} giao dịch chưa xong`);
    if (check.pendingSettle) parts.push(`${check.pendingSettle} khoản chờ xác nhận`);
    if (check.groupTies) parts.push(`khoản chia nhóm chưa xong`);
    return toast(`Chưa thể hủy kết bạn: còn ${parts.join(', ')}. Cân nợ xong đã nhé.`);
  }
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Hủy kết bạn với ${esc(nameOf(u))}?</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body"><p style="margin:0;color:var(--muted)">Sổ chung và lịch sử trò chuyện được giữ lại để xem sau,
  nhưng hai người sẽ không thể tạo giao dịch hay nhắn tin mới với nhau nữa.</p></div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Đóng</button>
  <button class="btn danger" type="button" ${A('unfriend', u)}>Hủy kết bạn</button></footer>`);
}
async function unfriend(u, _ctx){
  return once('unfriend:' + u, async () => {
    const id = makePairId(me.username, u);
    const check = canUnfriend(id);
    if (!check.ok) return toast('Chưa thể hủy kết bạn: sổ chung chưa sạch nợ.');
    const f = Data.friendships.find(x => x.id === id);
    if (!f) return;
    await Store.update('friendships/' + id, { ended_at: now(), ended_by: me.username });
    await log('DELETE', 'friendship', id, { title: `Hủy kết bạn với ${nameOf(u)}` });
    if (peer === u){ peer = null; savePeer(''); }
    closeModal();
    // [A-06] Không gọi esc() bên trong tham số của toast() vì toast() đã tự esc()
    toast(`Đã hủy kết bạn với ${nameOf(u)}`);
    go('friends');
  }, _ctx && _ctx.node);
}

// [S-01, C-01] Chấp nhận/từ chối lời mời kết bạn: bắt buộc status === 'PENDING' và requested_by !== me.username
async function respondFriend(id, accept, _ctx){
  return once('respondFriend:' + id, async () => {
    const f = Data.friendships.find(x => x.id === id);
    if (!f || f._invalid) return toast('Lời mời không hợp lệ');
    if (f.user_a !== me.username && f.user_b !== me.username) return toast('Không có quyền');
    if (f.requested_by === me.username) return toast('Người gửi lời mời không thể tự chấp nhận');

    if (accept){
      const res = await Store.tx('friendships/' + id, cur => {
        if (cur === null) return null;
        if (cur.status !== 'PENDING' || cur.requested_by === me.username) return undefined;
        if (cur.user_a !== me.username && cur.user_b !== me.username) return undefined;
        const next = { ...cur, status: 'ACCEPTED' };
        delete next.ended_at;
        delete next.ended_by;
        return next;
      });
      if (!res.committed) return toast('Lời mời không còn hợp lệ');
      await log('EDIT', 'friendship', id, { title: 'Chấp nhận kết bạn' });
      toast('Đã chấp nhận kết bạn');
    } else {
      const res = await Store.tx('friendships/' + id, cur => {
        if (cur === null) return null;
        if (cur.status !== 'PENDING' || cur.requested_by === me.username) return undefined;
        return null;
      });
      if (!res.committed) return toast('Lời mời không còn hợp lệ');
      await log('DELETE', 'friendship', id, {});
      toast('Đã từ chối lời mời');
    }
  }, _ctx && _ctx.node);
}

/* =========================================================================
   V3 MỤC 3 & V4 [D-13, C-01, L-02, A-01, F-05] — Nhóm chi tiêu
   ========================================================================= */
function myGroups(){
  if (!me) return [];
  return Data.groups.filter(g => g.members && g.members[me.username] && g.members[me.username].status === 'ACTIVE');
}
const groupById = id => (Idx.groupById && Idx.groupById[id]) || Data.groups.find(g => g.id === id);
const isGroupMember = (g, u) => !!(g && u && g.members && g.members[u] && g.members[u].status === 'ACTIVE');
function activeGroupMembers(g){ return Object.keys((g && g.members) || {}).filter(u => g.members[u].status === 'ACTIVE'); }
function groupTxnsOf(gid){
  return [...Data.group_txns].filter(x => !x._invalid && x.group_id === gid)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}

// [D-13, A-01] Chia đều số tiền cho các thành viên tham gia; người ứng nhận phần dư
function computeGroupShares(amount, paidBy, participants){
  const a = Number.isSafeInteger(Number(amount)) && Number(amount) > 0 ? Math.trunc(Number(amount)) : 0;
  const part = { ...(participants || {}) };
  if (paidBy) part[paidBy] = true; // Người ứng tiền luôn tham gia
  const trueUsers = Object.keys(part).filter(u => part[u]).sort();
  const n = trueUsers.length || 1;
  const base = Math.floor(a / n);
  let rem = a - base * n;
  const shares = {};
  const order = trueUsers.includes(paidBy) ? [paidBy, ...trueUsers.filter(u => u !== paidBy)] : trueUsers;
  for (const u of order){
    shares[u] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  }
  for (const u of Object.keys(part)) if (!part[u]) shares[u] = 0;
  return shares;
}

// [D-13] Kiểm tra bất biến chia tiền nhóm trước mọi thao tác ghi
function assertShares(amount, shares, participants){
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return false;
  if (!shares || typeof shares !== 'object') return false;
  let sum = 0;
  for (const [u, val] of Object.entries(shares)){
    if (!Number.isSafeInteger(val) || val < 0) return false;
    if (participants && !participants[u] && val !== 0) return false;
    sum += val;
  }
  return sum === amount;
}

function groupOwedTo(gt, u){
  if (!gt || u === gt.paid_by) return 0;
  if (!gt.participants || !gt.participants[u]) return 0;
  const p = (gt.paid_status || {})[u];
  if (p && p.confirmed) return 0;
  return gt.shares ? (gt.shares[u] || 0) : 0;
}
function myGroupBalance(gid){
  let net = 0;
  for (const gt of groupTxnsOf(gid)){
    if (gt.paid_by === me.username){
      for (const u of Object.keys(gt.participants || {})) net += groupOwedTo(gt, u);
    } else {
      net -= groupOwedTo(gt, me.username);
    }
  }
  return net;
}
function canToggleGroupParticipant(gt){
  return !Object.values((gt && gt.paid_status) || {}).some(p => p && (p.paid || p.confirmed));
}
function myGroupPendingConfirms(){
  if (!me) return 0;
  let n = 0;
  for (const gt of Data.group_txns){
    if (gt._invalid || gt.paid_by !== me.username) continue;
    for (const u in (gt.paid_status || {})){
      const p = gt.paid_status[u];
      if (p && p.paid && !p.confirmed) n++;
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
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Hết lượt tạo nhóm</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body"><div class="empty"><b>Bạn đã dùng hết ${Math.min(groupQuotaUsed(), l)}/${l} lượt tạo nhóm ở gói Thường</b>
    Liên hệ quản trị viên để nâng cấp lên VIP và tạo nhóm không giới hạn.</div></div>
  <footer><button class="btn primary" type="button" ${A('closeModal')}>Đã hiểu</button></footer>`);
}
function openCreateGroup(){
  if (groupQuotaExhausted()) return openGroupQuotaModal();
  const friends = acceptedFriends();
  if (!friends.length) return toast('Cần có ít nhất 1 bạn bè để tạo nhóm — kết bạn ở trang Kết bạn trước đã');
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Tạo nhóm mới</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="g_name">Tên nhóm</label>
      <input class="input" id="g_name" maxlength="50" placeholder="Du lịch Đà Lạt"></div>
    <div class="field"><label>Thêm thành viên (chỉ chọn được từ danh sách bạn bè)</label>
      <div class="check-list">${friends.map(u => `
        <label class="check-item"><input type="checkbox" class="g-mem" value="${esc(u)}"> ${esc(nameOf(u))}</label>`).join('')}</div>
    </div>
    <div id="g_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doCreateGroup')}>Tạo nhóm</button></footer>`);
  if (el('g_name')) el('g_name').focus();
}

// [L-02, C-01] Tăng group_quota_used bằng transaction TRƯỚC khi tạo nhóm (lỗi thì hoàn lại)
async function doCreateGroup(_arg, _ctx){
  return once('doCreateGroup', async () => {
    const name = V.text(el('g_name') ? el('g_name').value : '', { max:50 });
    if (!name){
      if (el('g_err')) el('g_err').innerHTML = `<div class="err">Cần nhập tên nhóm.</div>`;
      return;
    }
    const existingGroupCount = Data.groups.filter(g => g.created_by === me.username).length;
    let quotaExceeded = false;
    const quotaTx = await Store.tx('users/' + me.username, cur => {
      if (cur === null) return null;
      const role = roleValid(cur.role);
      const lim = ROLE_GROUP_LIMIT[role];
      const used = Math.max(Number(cur.group_quota_used || 0), existingGroupCount);
      if (lim !== undefined && used >= lim){
        quotaExceeded = true;
        return undefined;
      }
      return { ...cur, group_quota_used: used + 1 };
    });
    if (!quotaTx.committed){
      if (quotaExceeded){ closeModal(); return openGroupQuotaModal(); }
      return toast('Không thể kiểm tra hạn mức nhóm lúc này');
    }

    const friends = acceptedFriends();
    const checked = typeof document !== 'undefined'
      ? [...document.querySelectorAll('.g-mem:checked')].map(c => c.value).filter(u => friends.includes(u))
      : [];
    const ts = now();
    const members = { [me.username]: { role:'OWNER', joined_at:ts, status:'ACTIVE' } };
    for (const u of checked) members[u] = { role:'MEMBER', joined_at:ts, status:'ACTIVE' };
    const gid = rid();
    try {
      await Store.set('groups', gid, { name, created_by:me.username, created_at:ts, members });
    } catch (e){
      // Hoàn lại bộ đếm nếu tạo nhóm thất bại
      await Store.tx('users/' + me.username, cur => {
        if (!cur) return cur;
        return { ...cur, group_quota_used: Math.max(0, Number(cur.group_quota_used || 1) - 1) };
      }).catch(() => {});
      throw e;
    }
    await log('CREATE', 'group', gid, { title: name });
    closeModal();
    toast('Đã tạo nhóm');
    go('groups', gid);
  }, _ctx && _ctx.node);
}

function openGroupTxn(gid){
  const g = groupById(gid);
  if (!g || !isGroupMember(g, me.username)) return toast('Bạn không phải thành viên nhóm này');
  const mem = activeGroupMembers(g);
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 366);
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Ghi chi tiêu nhóm</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="gt_title">Nội dung</label>
      <input class="input" id="gt_title" maxlength="80" placeholder="Ăn tối cả nhóm"></div>
    <div class="two">
      <div class="field"><label for="gt_amount">Số tiền (VND)</label>
        <input class="input num" id="gt_amount" inputmode="numeric" placeholder="500.000"></div>
      <div class="field"><label for="gt_cat">Danh mục</label>
        <select class="input" id="gt_cat">${CATEGORIES.map(c => `<option value="${c}">${esc(CAT_VI[c])}</option>`).join('')}</select></div>
    </div>
    <div class="two">
      <div class="field"><label for="gt_paid">Ai đã ứng tiền</label>
        <select class="input" id="gt_paid">${mem.map(u =>
          `<option value="${esc(u)}" ${u === me.username ? 'selected' : ''}>${esc(nameOf(u))}</option>`).join('')}</select></div>
      <div class="field"><label for="gt_date">Ngày</label>
        <input class="input" id="gt_date" type="date" min="2000-01-01" max="${localISODate(maxDate)}" value="${localISODate()}"></div>
    </div>
    <p class="hint" style="margin-top:0">Mặc định chia đều cho mọi thành viên đang hoạt động. Mỗi người có thể bấm
    "Không tham gia" cho riêng khoản này, miễn là chưa ai báo đã trả.</p>
    <div id="gt_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('submitGroupTxn', gid)}>Thêm khoản chi</button></footer>`);
  if (el('gt_title')) el('gt_title').focus();
}

async function submitGroupTxn(gid, _ctx){
  return once('submitGroupTxn:' + gid, async () => {
    const g = groupById(gid);
    if (!g || !isGroupMember(g, me.username)) return toast('Chỉ thành viên đang hoạt động mới ghi được chi tiêu nhóm');
    const title = V.text(el('gt_title') ? el('gt_title').value : '', { max:80 });
    const moneyRes = V.money(el('gt_amount') ? el('gt_amount').value : '');
    const cat = (el('gt_cat') && V.enum(el('gt_cat').value, CATEGORIES)) ? el('gt_cat').value : 'Other';
    const paid_by = el('gt_paid') ? el('gt_paid').value : '';
    const rawDate = (el('gt_date') && el('gt_date').value) ? el('gt_date').value : localISODate();
    const dateRes = V.date(rawDate);

    const errs = [];
    if (!title) errs.push('Cần nhập nội dung.');
    if (!moneyRes.ok) errs.push(moneyRes.error + '.');
    if (!dateRes.ok) errs.push(dateRes.error + '.');
    if (!isGroupMember(g, paid_by)) errs.push('Người ứng tiền phải là thành viên đang hoạt động trong nhóm.');
    if (errs.length){
      if (el('gt_err')) el('gt_err').innerHTML = `<div class="err">${esc(errs.join(' '))}</div>`;
      return;
    }

    const amount = moneyRes.value;
    const activeMembers = activeGroupMembers(g);
    const participants = Object.fromEntries(activeMembers.map(u => [u, true]));
    const shares = computeGroupShares(amount, paid_by, participants);
    if (!assertShares(amount, shares, participants)){
      if (el('gt_err')) el('gt_err').innerHTML = `<div class="err">Lỗi chia phần tiền không khớp tổng số tiền.</div>`;
      return;
    }
    const paid_status = {};
    for (const u of activeMembers) if (u !== paid_by) paid_status[u] = { paid:false, confirmed:false };
    const tid = rid();
    await Store.set('group_txns', tid, {
      group_id: gid, title, amount, category: cat, paid_by, date: dateRes.value,
      created_by: me.username, created_at: now(), participants, shares, paid_status
    });
    await log('CREATE', 'group_txn', tid, { title, amount });
    closeModal();
    toast('Đã ghi chi tiêu nhóm');
  }, _ctx && _ctx.node);
}

// [C-01, L-02, D-13, A-01] Đổi trạng thái tham gia khoản chi nhóm qua transaction
async function toggleGroupParticipant(gtId, user, _ctx){
  return once('toggleGroupParticipant:' + gtId + ':' + user, async () => {
    const gt = Data.group_txns.find(x => x.id === gtId); if (!gt) return;
    const g = groupById(gt.group_id);
    if (!g || !isGroupMember(g, user)) return toast('Người này không phải thành viên nhóm');
    if (!(isAdmin() || me.username === user)) return toast('Không có quyền');
    if (user === gt.paid_by) return toast('Người ứng tiền luôn tham gia khoản này');

    let errReason = '';
    let finalIn = false;
    const res = await Store.tx('group_txns/' + gtId, cur => {
      if (cur === null) return null;
      if (!canToggleGroupParticipant(cur)){
        errReason = 'Đã có người báo hoặc xác nhận trả, không đổi được nữa';
        return undefined;
      }
      if (user === cur.paid_by) return undefined;
      const curPart = { ...(cur.participants || {}) };
      curPart[cur.paid_by] = true;
      finalIn = !curPart[user];
      curPart[user] = finalIn;
      const activeCount = Object.values(curPart).filter(Boolean).length;
      if (activeCount < 1){
        errReason = 'Phải có ít nhất 1 người tham gia khoản chi';
        return undefined;
      }
      const shares = computeGroupShares(cur.amount, cur.paid_by, curPart);
      if (!assertShares(cur.amount, shares, curPart)){
        errReason = 'Tổng phần chia không khớp';
        return undefined;
      }
      const paid_status = { ...(cur.paid_status || {}) };
      if (!finalIn) delete paid_status[user];
      else paid_status[user] = paid_status[user] || { paid:false, confirmed:false };
      return { ...cur, participants: curPart, shares, paid_status };
    });
    if (!res.committed) return toast(errReason || 'Không thể đổi trạng thái tham gia');

    const meta = { title: gt.title };
    if (isAdmin() && me.username !== user){
      meta.acted_as_admin = true;
      meta.on_behalf_of = user;
    }
    await log('EDIT', 'group_txn', gtId, meta);
    toast(finalIn ? 'Đã tham gia lại khoản này' : 'Đã đánh dấu không tham gia khoản này');
  }, _ctx && _ctx.node);
}

// [C-01, Phụ lục A.4] Máy trạng thái giao dịch nhóm trên đường dẫn hẹp group_txns/{id}/paid_status/{u}
function canMarkGroupPaid(gt, u){
  const p = (gt && gt.paid_status || {})[u];
  return !!(p && !p.paid && !p.confirmed && (isAdmin() || me.username === u));
}
async function markGroupPaid(gtId, u, _ctx){
  return once('markGroupPaid:' + gtId + ':' + u, async () => {
    const gt = Data.group_txns.find(x => x.id === gtId);
    if (!gt || !canMarkGroupPaid(gt, u)) return toast('Không có quyền');
    const res = await Store.tx(`group_txns/${gtId}/paid_status/${u}`, cur => {
      if (cur === null) return null;
      if (cur.confirmed || cur.paid) return undefined;
      return { ...cur, paid: true, confirmed: false };
    });
    if (!res.committed) return toast('Khoản này đã được cập nhật trước đó');
    const meta = { title: gt.title, amount: (gt.shares || {})[u] || 0 };
    if (isAdmin() && me.username !== u){
      meta.acted_as_admin = true;
      meta.on_behalf_of = u;
    }
    await log('MARK_PAID', 'group_txn', gtId, meta);
    toast(`Đã báo đã trả · chờ ${nameOf(gt.paid_by)} xác nhận`);
  }, _ctx && _ctx.node);
}

function canConfirmGroupPaid(gt, u){
  const p = (gt && gt.paid_status || {})[u];
  return !!(p && p.paid && !p.confirmed && (isAdmin() || me.username === gt.paid_by));
}
async function confirmGroupPaid(gtId, u, _ctx){
  return once('confirmGroupPaid:' + gtId + ':' + u, async () => {
    const gt = Data.group_txns.find(x => x.id === gtId);
    if (!gt || !canConfirmGroupPaid(gt, u)) return toast('Không có quyền');
    const ts = now();
    const res = await Store.tx(`group_txns/${gtId}/paid_status/${u}`, cur => {
      if (cur === null) return null;
      if (!cur.paid || cur.confirmed) return undefined;
      return { ...cur, paid: true, confirmed: true, confirmed_by: me.username, confirmed_at: ts };
    });
    if (!res.committed) return toast('Trạng thái đã thay đổi trước đó');
    const meta = { title: gt.title, amount: (gt.shares || {})[u] || 0 };
    if (isAdmin() && me.username !== gt.paid_by){
      meta.acted_as_admin = true;
      meta.on_behalf_of = gt.paid_by;
    }
    await log('SETTLEMENT', 'group_txn', gtId, meta);
    toast(`Đã xác nhận nhận từ ${nameOf(u)}`);
  }, _ctx && _ctx.node);
}

async function rejectGroupPaid(gtId, u, _ctx){
  return once('rejectGroupPaid:' + gtId + ':' + u, async () => {
    const gt = Data.group_txns.find(x => x.id === gtId); if (!gt) return;
    if (!(isAdmin() || me.username === gt.paid_by)) return toast('Không có quyền');
    // [C-01, Phụ lục A.4] Tuyệt đối KHÔNG cho từ chối khi đã confirmed === true
    const res = await Store.tx(`group_txns/${gtId}/paid_status/${u}`, cur => {
      if (cur === null) return null;
      if (cur.confirmed || !cur.paid) return undefined;
      return { paid: false, confirmed: false };
    });
    if (!res.committed) return toast('Khoản này đã được xác nhận hoặc chưa báo trả, không thể từ chối');
    const meta = { title: 'Từ chối xác nhận trả nhóm: ' + gt.title };
    if (isAdmin() && me.username !== gt.paid_by){
      meta.acted_as_admin = true;
      meta.on_behalf_of = gt.paid_by;
    }
    await log('EDIT', 'group_txn', gtId, meta);
    toast('Đã từ chối, người trả sẽ thấy để báo lại');
  }, _ctx && _ctx.node);
}

// [L-02, F-05] Xoá khoản chi nhóm khi chưa ai báo trả (lưu vào trash trước)
function canDeleteGroupTxn(gt){
  if (!gt || !me) return false;
  if (!canToggleGroupParticipant(gt)) return false;
  return isAdmin() || gt.created_by === me.username;
}
function confirmDeleteGroupTxn(gtId){
  const gt = Data.group_txns.find(x => x.id === gtId);
  if (!gt || !canDeleteGroupTxn(gt)) return toast('Không thể xóa khoản chi nhóm này');
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Xóa khoản chi nhóm?</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body"><p style="margin-top:0"><b>${esc(gt.title)}</b> · <span class="num">${vnd(gt.amount)}</span></p>
  <p style="color:var(--muted)">Khoản này chưa có ai báo trả và sẽ được lưu dự phòng vào thùng rác quản trị trước khi xóa.</p></div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn danger" type="button" ${A('doDeleteGroupTxn', gtId)}>Xóa khoản chi</button></footer>`);
}
async function doDeleteGroupTxn(gtId, _ctx){
  return once('doDeleteGroupTxn:' + gtId, async () => {
    const gt = Data.group_txns.find(x => x.id === gtId);
    if (!gt || !canDeleteGroupTxn(gt)) return toast('Không thể xóa khoản chi này');
    const snap = await Store.get('group_txns/' + gtId);
    if (!snap.exists || !canToggleGroupParticipant(snap.data)){
      closeModal();
      return toast('Đã có thành viên báo trả, không thể xóa khoản chi này nữa');
    }
    await Store.set('trash', gtId, {
      kind: 'group_txn',
      original_id: gtId,
      data: snap.data,
      deleted_by: me.username,
      deleted_at: now()
    });
    await Store.del('group_txns', gtId);
    const meta = { title: gt.title, amount: gt.amount };
    if (isAdmin() && gt.created_by !== me.username){
      meta.acted_as_admin = true;
      meta.on_behalf_of = gt.created_by;
    }
    await log('DELETE', 'group_txn', gtId, meta);
    closeModal();
    toast('Đã xóa khoản chi nhóm');
  }, _ctx && _ctx.node);
}

function vGroups(){
  if (route.param) return vGroupDetail(route.param);
  const groups = myGroups();
  return `
  <div class="page-head"><div><h2>Nhóm</h2><p>Chi tiêu chung nhiều người, tách riêng khỏi sổ chung 2 người.${esc(groupQuotaHint())}</p></div>
    <div class="actions"><button class="btn primary" type="button" ${A('openCreateGroup')}>+ Tạo nhóm</button></div></div>
  ${groups.length ? `<div class="grid cards">${groups.map(g => {
    const bal = myGroupBalance(g.id);
    const cls = bal === 0 ? '' : (bal > 0 ? 'credit' : 'debit');
    const sign = bal === 0 ? '' : (bal > 0 ? '+' : '−');
    return `<div class="panel card-link" tabindex="0" role="link" ${A('go', 'groups', g.id)}><div class="body">
      <div class="kv"><span style="color:var(--text);font-weight:600">${esc(g.name)}</span>
      <span class="tag">${activeGroupMembers(g).length} thành viên</span></div>
      <div class="kv"><span>Số dư của bạn</span><b class="num ${cls}">${bal === 0 ? 'Đã cân bằng' : sign + vnd(Math.abs(bal))}</b></div>
    </div></div>`;
  }).join('')}</div>`
    : `<div class="panel"><div class="empty"><div class="empty-ic">${svgIc('ic-users', 18)}</div><b>Chưa có nhóm nào</b>Tạo nhóm để chia chi tiêu với nhiều bạn bè cùng lúc.</div></div>`}`;
}

function vGroupDetail(gid){
  const g = groupById(gid);
  if (!g || (!isAdmin() && !isGroupMember(g, me.username)))
    return `<div class="panel"><div class="empty"><div class="empty-ic">${svgIc('ic-alert', 18)}</div><b>Không tìm thấy nhóm</b>
    <div style="margin-top:12px"><a class="btn sm" href="#/groups">Quay lại danh sách nhóm</a></div></div></div>`;
  const txns = groupTxnsOf(gid);
  const bal = myGroupBalance(gid);
  const members = activeGroupMembers(g);
  return `
  <div class="page-head">
    <div><p style="margin:0 0 4px"><a href="#/groups" style="color:var(--muted);text-decoration:none">← Nhóm</a></p>
      <h2>${esc(g.name)}</h2><p>${members.length} thành viên · tạo bởi ${esc(nameOf(g.created_by))}</p></div>
    <div class="actions">${isGroupMember(g, me.username) ? `<button class="btn primary" type="button" ${A('openGroupTxn', gid)}>+ Ghi chi tiêu nhóm</button>` : ''}</div>
  </div>
  <section class="hero">
    <p class="who-line">Số dư của bạn trong nhóm</p>
    <p class="amount ${bal === 0 ? '' : (bal > 0 ? 'credit' : 'debit')}">${bal === 0 ? vnd(0) : (bal > 0 ? '+' : '−') + vnd(Math.abs(bal))}</p>
    <p class="sub">${bal === 0 ? 'Bạn không nợ ai và không ai nợ bạn trong nhóm này.'
      : (bal > 0 ? 'Các thành viên khác đang nợ bạn tổng cộng (được nhận).' : 'Bạn đang nợ các thành viên khác tổng cộng (phải trả).')}</p>
  </section>
  <section class="section panel"><h3>Thành viên</h3><div class="body">
    ${members.map(u => `<div class="kv"><span>${esc(nameOf(u))}${g.members[u].role === 'OWNER' ? ' · chủ nhóm' : ''}${u === me.username ? ' · bạn' : ''}</span></div>`).join('')}
  </div></section>
  <section class="section panel"><h3>Chi tiêu nhóm (${txns.length})</h3><div class="body">
  ${txns.length ? txns.map(gt => groupTxnCard(gt)).join('') : `<div class="empty"><div class="empty-ic">${svgIc('ic-list', 18)}</div><b>Chưa có khoản chi nào</b>Ghi khoản đầu tiên cho nhóm này.</div>`}
  </div></section>`;
}

function groupTxnCard(gt){
  const g = groupById(gt.group_id);
  const others = (g ? activeGroupMembers(g) : Object.keys(gt.participants || {})).filter(u => u !== gt.paid_by);
  return `<div class="preview" style="margin-bottom:10px">
    <div class="row"><span><b style="color:var(--text)">${esc(gt.title)}</b> · ${esc(nameOf(gt.paid_by))} ứng ${vnd(gt.amount)}</span>
    <span class="meta">${fmtDate(gt.date)} · ${esc(CAT_VI[gt.category] || gt.category)} · Ghi bởi ${esc(nameOf(gt.created_by))}
      ${canDeleteGroupTxn(gt) ? ` · <button class="btn sm danger" type="button" style="padding:2px 8px;font-size:11.5px" ${A('confirmDeleteGroupTxn', gt.id)}>Xóa</button>` : ''}
    </span></div>
    ${others.map(u => {
      const isIn = !!(gt.participants && gt.participants[u]);
      const p = (gt.paid_status || {})[u] || {};
      const share = gt.shares ? (gt.shares[u] || 0) : 0;
      const st = !isIn ? 'Không tham gia' : p.confirmed ? 'Đã xong' : p.paid ? 'Chờ xác nhận' : 'Chưa trả';
      const canTogg = canToggleGroupParticipant(gt) && (isAdmin() || me.username === u);
      return `<div class="row"><span>${esc(nameOf(u))}${isIn ? ` · phần ${vnd(share)}` : ''}</span>
      <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="tag">${st}</span>
        ${canTogg ? `<button class="btn sm" type="button" ${A('toggleGroupParticipant', gt.id, u)}>${isIn ? 'Không tham gia' : 'Tham gia lại'}</button>` : ''}
        ${isIn && !p.confirmed && !p.paid && canMarkGroupPaid(gt, u) ? `<button class="btn sm primary" type="button" ${A('markGroupPaid', gt.id, u)}>Đã trả</button>` : ''}
        ${isIn && p.paid && !p.confirmed && canConfirmGroupPaid(gt, u) ? `<button class="btn sm primary" type="button" ${A('confirmGroupPaid', gt.id, u)}>Xác nhận nhận</button>
          <button class="btn sm" type="button" ${A('rejectGroupPaid', gt.id, u)}>Từ chối</button>` : ''}
      </span></div>`;
    }).join('')}
  </div>`;
}

/* =========================================================================
   V3 MỤC 4a & V4 [D-12, C-01, A-02, U-15] — Sổ tiết kiệm cá nhân
   ========================================================================= */
function mySavings(){ return me ? Data.savings.filter(s => s.username === me.username) : []; }
function savingsEntriesOf(sid){
  return [...Data.savings_entries].filter(e => !e._invalid && e.savings_id === sid)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}
function savingsBalance(sid){
  return Data.savings_entries.filter(e => !e._invalid && e.savings_id === sid)
    .reduce((sum, e) => sum + (e.type === 'DEPOSIT' ? e.amount : (e.type === 'WITHDRAW' ? -e.amount : 0)), 0);
}
function openNewSaving(){
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Mục tiêu tiết kiệm mới</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="sv_name">Tên mục tiêu</label>
      <input class="input" id="sv_name" maxlength="60" placeholder="Mua xe máy"></div>
    <div class="field"><label for="sv_target">Số tiền mục tiêu (VND, tùy chọn)</label>
      <input class="input num" id="sv_target" inputmode="numeric" placeholder="20.000.000"></div>
    <div class="field"><label for="sv_note">Ghi chú (tùy chọn)</label>
      <input class="input" id="sv_note" maxlength="500" placeholder=""></div>
    <div id="sv_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doCreateSaving')}>Tạo mục tiêu</button></footer>`);
  if (el('sv_name')) el('sv_name').focus();
}
async function doCreateSaving(_arg, _ctx){
  return once('doCreateSaving', async () => {
    const name = V.text(el('sv_name') ? el('sv_name').value : '', { max:60 });
    const tRes = V.moneyOptional(el('sv_target') ? el('sv_target').value : '');
    const note = V.text(el('sv_note') ? el('sv_note').value : '', { max:500 });
    if (!name){
      if (el('sv_err')) el('sv_err').innerHTML = `<div class="err">Cần nhập tên mục tiêu.</div>`;
      return;
    }
    if (!tRes.ok){
      if (el('sv_err')) el('sv_err').innerHTML = `<div class="err">${esc(tRes.error)}</div>`;
      return;
    }
    const sid = rid();
    await Store.set('savings', sid, {
      username: me.username, name, target_amount: tRes.value,
      note, created_at: now(), closed: false
    });
    await log('CREATE', 'saving', sid, { title: name });
    closeModal();
    toast('Đã tạo mục tiêu tiết kiệm');
  }, _ctx && _ctx.node);
}
function openSavingEntry(sid, type){
  const s = Data.savings.find(x => x.id === sid);
  if (!s || s.username !== me.username) return;
  if (s.closed) return toast('Mục tiêu này đã đóng. Hãy mở lại trước khi nạp hoặc rút.');
  if (!V.enum(type, ['DEPOSIT','WITHDRAW'])) return toast('Loại giao dịch không hợp lệ');
  const label = type === 'DEPOSIT' ? 'Nạp tiền' : 'Rút tiền';
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 366);
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">${label} · ${esc(s.name)}</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="se_amt">Số tiền</label>
      <input class="input num" id="se_amt" inputmode="numeric" placeholder="500.000"></div>
    <div class="field"><label for="se_date">Ngày</label>
      <input class="input" id="se_date" type="date" min="2000-01-01" max="${localISODate(maxDate)}" value="${localISODate()}"></div>
    <div class="field"><label for="se_note">Ghi chú (tùy chọn)</label>
      <input class="input" id="se_note" maxlength="500" placeholder=""></div>
    <div id="se_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doSavingEntry', sid, type)}>${label}</button></footer>`);
  if (el('se_amt')) el('se_amt').focus();
}
// [D-12] Kiểm tra chặt loại DEPOSIT/WITHDRAW, chặn khi mục tiêu đã đóng, ghi nhật ký DEPOSIT/WITHDRAW
async function doSavingEntry(sid, type, _ctx){
  return once('doSavingEntry:' + sid, async () => {
    if (!V.enum(type, ['DEPOSIT','WITHDRAW'])) return toast('Loại giao dịch không hợp lệ');
    const s = Data.savings.find(x => x.id === sid);
    if (!s || s.username !== me.username) return toast('Không có quyền');
    const freshGoal = await Store.get('savings/' + sid);
    if (!freshGoal.exists || freshGoal.data.closed){
      if (el('se_err')) el('se_err').innerHTML = `<div class="err">Mục tiêu này đã đóng, không thể nạp hoặc rút.</div>`;
      return;
    }
    const mRes = V.money(el('se_amt') ? el('se_amt').value : '');
    const rawDate = (el('se_date') && el('se_date').value) ? el('se_date').value : localISODate();
    const dateRes = V.date(rawDate);
    if (!mRes.ok || !dateRes.ok){
      const msg = !mRes.ok ? mRes.error : dateRes.error;
      if (el('se_err')) el('se_err').innerHTML = `<div class="err">${esc(msg)}</div>`;
      return;
    }
    const amount = mRes.value;
    if (type === 'WITHDRAW' && amount > savingsBalance(sid)){
      if (el('se_err')) el('se_err').innerHTML = `<div class="err">Không đủ số dư để rút (hiện có ${vnd(savingsBalance(sid))}).</div>`;
      return;
    }
    const eid = rid();
    await Store.set('savings_entries', eid, {
      savings_id: sid, amount, type,
      date: dateRes.value, note: V.text(el('se_note') ? el('se_note').value : '', { max:500 }), created_at: now()
    });
    await log(type, 'saving_entry', eid, { title: s.name, amount });
    closeModal();
    toast(type === 'DEPOSIT' ? 'Đã nạp tiền' : 'Đã rút tiền');
  }, _ctx && _ctx.node);
}
async function closeSaving(sid, targetClosed, _ctx){
  return once('closeSaving:' + sid, async () => {
    const s = Data.savings.find(x => x.id === sid);
    if (!s || s.username !== me.username) return;
    const nextState = typeof targetClosed === 'boolean' ? targetClosed : !s.closed;
    await Store.update('savings/' + sid, { closed: nextState });
    toast(nextState ? 'Đã đóng mục tiêu' : 'Đã mở lại mục tiêu');
  }, _ctx && _ctx.node);
}
function vSavings(){
  const list = mySavings();
  return `
  <div class="page-head"><div><h2>Sổ tiết kiệm</h2><p>Mục tiêu tiết kiệm của riêng bạn, không liên quan tới sổ chung.</p></div>
    <div class="actions"><button class="btn primary" type="button" ${A('openNewSaving')}>+ Mục tiêu mới</button></div></div>
  ${list.length ? `<div class="grid cards">${list.map(s => {
    const bal = savingsBalance(s.id);
    const pct = s.target_amount ? Math.min(100, Math.max(0, Math.round(bal / s.target_amount * 100))) : 0;
    const entries = savingsEntriesOf(s.id);
    return `<div class="panel"><div class="body">
      <div class="kv"><span style="color:var(--text);font-weight:600">${esc(s.name)}${s.closed ? ' <span class="tag">Đã đóng</span>' : ''}</span></div>
      <div class="kv"><span>Tiến độ</span><b class="num">${vnd(bal)}${s.target_amount ? ' / ' + vnd(s.target_amount) : ''}</b></div>
      ${s.target_amount ? `<div class="progress" role="progressbar" aria-label="Tiến độ ${esc(s.name)}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${pct}%"></div></div>` : ''}
      ${s.note ? `<p class="hint" style="margin-top:10px">${esc(s.note)}</p>` : ''}
      <div class="actions" style="margin-top:12px">
        ${!s.closed ? `<button class="btn sm" type="button" ${A('openSavingEntry', s.id, 'DEPOSIT')}>Nạp</button>
        <button class="btn sm" type="button" ${A('openSavingEntry', s.id, 'WITHDRAW')}>Rút</button>` : ''}
        <button class="btn sm" type="button" ${A('closeSaving', s.id, !s.closed)}>${s.closed ? 'Mở lại' : 'Đóng'}</button>
      </div>
      ${entries.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="resp-tbl"><thead><tr><th>Ngày</th><th>Loại</th><th class="num">Số tiền</th></tr></thead>
        <tbody>${entries.slice(0, 6).map(e => `<tr><td class="meta num" data-label="Ngày">${fmtDate(e.date)}</td>
        <td data-label="Loại">${e.type === 'DEPOSIT' ? 'Nạp' : 'Rút'}</td><td class="num" data-label="Số tiền">${vnd(e.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div></div>`;
  }).join('')}</div>`
    : `<div class="panel"><div class="empty"><div class="empty-ic">${svgIc('ic-piggy', 18)}</div><b>Chưa có mục tiêu nào</b>Tạo mục tiêu đầu tiên để bắt đầu tiết kiệm.</div></div>`}`;
}

/* =========================================================================
   V3 MỤC 4b & V4 [D-09, L-03, A-02, T-01, U-15] — Ngân sách chi tiêu cá nhân
   ========================================================================= */
function myTxnsAllPairs(){
  if (!me) return [];
  return Data.txns.filter(t => {
    if (t._invalid) return false;
    const [a, b] = Pair.members(pairIdOf(t));
    return a === me.username || b === me.username;
  });
}
function budgetSpent(month, category){
  return myTxnsAllPairs()
    .filter(t => monthKeyOf(t.date || t.created_at) === month && (CATEGORIES.includes(t.category) ? t.category : 'Other') === category)
    .reduce((sum, t) => sum + (split(t.amount, t.paid_by, pairIdOf(t))[me.username] || 0), 0);
}
function budgetOf(month, category){
  return Data.budgets.find(b => b.username === me.username && b.month === month && b.category === category);
}
function onBudgetMonthChange(val){
  const mRes = V.month(val);
  if (!mRes.ok) return toast(mRes.error);
  uiFilter.budgetMonth = mRes.value;
  scheduleRender({ forceMain:true });
}
async function saveBudget(category, val){
  return once('saveBudget:' + category, async () => {
    if (!V.enum(category, CATEGORIES)) return toast('Danh mục không hợp lệ');
    const rawMonth = uiFilter.budgetMonth || localMonthKey();
    const mRes = V.month(rawMonth);
    if (!mRes.ok) return toast(mRes.error);
    const aRes = V.moneyOptional(val);
    if (!aRes.ok) return toast(aRes.error);
    const month = mRes.value;
    const id = `${me.username}_${month}_${category}`;
    await Store.set('budgets', id, {
      username: me.username, month, category, limit_amount: aRes.value, created_at: now()
    });
    toast(aRes.value > 0 ? 'Đã lưu hạn mức' : 'Đã xóa hạn mức');
  });
}
function vBudget(){
  const rawMonth = uiFilter.budgetMonth || localMonthKey();
  const month = V.month(rawMonth).ok ? rawMonth : localMonthKey();
  const rows = CATEGORIES.map(c => {
    const b = budgetOf(month, c);
    const limit = b ? b.limit_amount : 0;
    const spent = budgetSpent(month, c);
    const pct = limit ? Math.min(100, Math.max(0, Math.round(spent / limit * 100))) : 0;
    return { c, limit, spent, pct, over: limit > 0 && spent > limit };
  });
  return `
  <div class="page-head"><div><h2>Ngân sách</h2>
    <p>Hạn mức chi tiêu theo danh mục. Ngân sách tính trên các sổ chung 2 người, chưa gồm chi tiêu nhóm.</p></div>
    <div class="actions"><input class="input" type="month" style="width:auto" value="${esc(month)}"
      data-on-change="onBudgetMonthChange" aria-label="Chọn tháng ngân sách"></div></div>
  <div class="grid cards">
  ${rows.map(r => `
    <div class="panel"><div class="body">
      <div class="kv"><span>${esc(CAT_VI[r.c])}</span>
      <b class="num" style="color:var(--${r.over ? 'debit' : 'text'})">${vnd(r.spent)}${r.limit ? ' / ' + vnd(r.limit) : ''}</b></div>
      <div class="progress" role="progressbar" aria-label="Ngân sách ${esc(CAT_VI[r.c])}" aria-valuenow="${r.pct}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ${r.over ? 'over' : ''}" style="width:${r.pct}%"></div></div>
      <div class="field" style="margin-top:12px;margin-bottom:0"><label>Hạn mức tháng này</label>
        <input class="input num" inputmode="numeric" placeholder="Chưa đặt" value="${r.limit || ''}"
          data-on-change="saveBudget" data-cat="${esc(r.c)}"></div>
    </div></div>`).join('')}
  </div>`;
}
/* ===== /V4 ===== */
/* ===== V4 · [L-04, L-06, L-07, D-05, F-02, F-03, F-07, F-08, F-11] Quản trị, Toàn vẹn, Backup v2 & Khởi động ===== */

async function readConfigDoc(id){
  try {
    const d = await Store.get('config/' + id);
    return d.exists ? d.data : null;
  } catch (_){ return null; }
}

// [L-07, C-01] Migration pair_id: chỉ cập nhật đúng trường {pair_id:'duy_nguyen'}, chỉ chạy thủ công bởi ADMIN
async function runPairIdBackfill(){
  let n = 0;
  const map = {};
  for (const t of Data.txns){
    if (!t || !t.id || t.pair_id) continue;
    map[`txns/${t.id}/pair_id`] = 'duy_nguyen';
    n++;
  }
  for (const s of Data.settlements){
    if (!s || !s.id || s.pair_id) continue;
    map[`settlements/${s.id}/pair_id`] = 'duy_nguyen';
    n++;
  }
  if (n > 0) await Store.multi(map);
  return n;
}

async function forceMigrate(_arg, _ctx){
  return once('forceMigrate', async () => {
    if (!isAdmin()) return toast('Chỉ quản trị viên mới thực hiện được');
    if (!Data.ready) return toast('Dữ liệu đang tải, vui lòng thử lại sau vài giây');
    if (!_backupDownloadedThisSession){
      return toast('Vui lòng bấm “Tải backup JSON” trong phiên này trước khi chạy migration');
    }
    const n = await runPairIdBackfill();
    await Store.update('config/migration', { pair_id_v1:true, at:now(), by:me.username, patched:n });
    toast(n ? `Đã gán pair_id cho ${n} bản ghi` : 'Mọi bản ghi đã có pair_id');
    scheduleRender({ forceMain:true });
  }, _ctx && _ctx.node);
}

// [F-08, 8.2] Backup v2: có schema_version, app_version, counts, checksum SHA-256, tuyệt đối KHÔNG chứa config/auth
async function exportBackup(_arg, _ctx){
  return once('exportBackup', async () => {
    if (!isAdmin()) return toast('Chỉ quản trị viên mới tải được backup toàn hệ thống');
    const cleanRows = rows => (rows || []).map(r => {
      const c = { ...r };
      delete c._invalid;
      return c;
    });
    const payload = {
      users: cleanRows(Data.users),
      friendships: cleanRows(Data.friendships),
      txns: cleanRows(Data.txns),
      settlements: cleanRows(Data.settlements),
      messages: cleanRows(Data.messages),
      activity: cleanRows(Data.activity),
      groups: cleanRows(Data.groups),
      group_txns: cleanRows(Data.group_txns),
      savings: cleanRows(Data.savings),
      savings_entries: cleanRows(Data.savings_entries),
      budgets: cleanRows(Data.budgets),
      trash: cleanRows(Data.trash)
    };
    const counts = {};
    for (const [k, arr] of Object.entries(payload)) counts[k] = arr.length;
    const rawPayloadStr = JSON.stringify(payload);
    const checksum = await sha(rawPayloadStr);
    const dump = {
      schema_version: 2,
      app_version: APP_VERSION,
      exported_at: now(),
      exported_by: me ? me.username : null,
      counts,
      checksum,
      ...payload
    };
    if (typeof document !== 'undefined'){
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type:'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sochung-backup-${localISODate()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    _backupDownloadedThisSession = true;
    toast('Đã tải file backup JSON (v2)');
  }, _ctx && _ctx.node);
}

// [F-08] Nhập backup ở chế độ CHỈ THÊM BẢN GHI CHƯA CÓ (additive-only), xem trước & xác nhận 2 lần
let _pendingImportMap = null;
let _pendingImportSummary = null;

function openImportBackupModal(){
  if (!isAdmin()) return toast('Chỉ quản trị viên');
  _pendingImportMap = null;
  _pendingImportSummary = null;
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Nhập backup JSON (Chỉ thêm mới)</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <p class="hint" style="margin-top:0">Chế độ an toàn: chỉ thêm các bản ghi có ID <b>chưa tồn tại</b> trên hệ thống, tuyệt đối không ghi đè hay xóa bản ghi đang có.</p>
    <div class="field"><label for="imp_file">Chọn file backup (.json)</label>
      <input class="input" id="imp_file" type="file" accept="application/json,.json" data-on-change="onImportFileSelected"></div>
    <div id="imp_preview"></div>
    <div id="imp_err"></div>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Đóng</button></footer>`);
}

async function onImportFileSelected(_val, ctx){
  const input = (ctx && ctx.node) || el('imp_file');
  if (!input || !input.files || !input.files[0]) return;
  try {
    const text = await input.files[0].text();
    const json = JSON.parse(text);
    const cols = ['users','friendships','txns','settlements','messages','activity','groups','group_txns','savings','savings_entries','budgets','trash'];
    const map = {};
    const summary = [];
    let totalNew = 0;
    for (const c of cols){
      const arr = Array.isArray(json[c]) ? json[c] : [];
      const existingIds = new Set((Data[c] || []).map(x => x.id || x.username));
      let added = 0;
      for (const item of arr){
        if (!item || typeof item !== 'object') continue;
        const id = item.id || item.username;
        if (!id || existingIds.has(id)) continue;
        const copy = { ...item };
        delete copy.id;
        delete copy._invalid;
        map[`${c}/${id}`] = copy;
        existingIds.add(id);
        added++;
        totalNew++;
      }
      if (added > 0) summary.push(`${c}: +${added}`);
    }
    _pendingImportMap = map;
    _pendingImportSummary = { totalNew, details: summary };
    const box = el('imp_preview');
    if (box){
      if (!totalNew){
        box.innerHTML = `<div class="preview"><div class="row"><span>Không có bản ghi mới nào cần thêm (tất cả ID đã tồn tại).</span></div></div>`;
      } else {
        box.innerHTML = `<div class="preview">
          <div class="row"><span>Tổng bản ghi mới sẽ thêm</span><b class="num">${totalNew}</b></div>
          <div class="row"><span>Chi tiết</span><span>${esc(summary.join(', '))}</span></div>
          <div style="margin-top:10px">
            <label class="check-item"><input type="checkbox" id="imp_confirm1"> Tôi đã kiểm tra số lượng bản ghi mới ở trên</label>
            <label class="check-item" style="margin-top:6px"><input type="checkbox" id="imp_confirm2"> Tôi xác nhận lần 2 muốn thêm các bản ghi này</label>
          </div>
          <div style="margin-top:12px"><button class="btn primary wide" type="button" ${A('executeImportBackup')}>Thực hiện nhập ${totalNew} bản ghi</button></div>
        </div>`;
      }
    }
  } catch (e){
    if (el('imp_err')) el('imp_err').innerHTML = `<div class="err">File JSON không hợp lệ: ${esc(e.message || '')}</div>`;
  }
}

async function executeImportBackup(_arg, _ctx){
  return once('executeImportBackup', async () => {
    if (!isAdmin() || !_pendingImportMap || !_pendingImportSummary) return;
    const c1 = el('imp_confirm1') && el('imp_confirm1').checked;
    const c2 = el('imp_confirm2') && el('imp_confirm2').checked;
    if (!c1 || !c2){
      if (el('imp_err')) el('imp_err').innerHTML = `<div class="err">Vui lòng tích đủ cả 2 ô xác nhận trước khi nhập.</div>`;
      return;
    }
    await Store.multi(_pendingImportMap);
    await log('CREATE', 'backup_import', rid(), { title: `Nhập +${_pendingImportSummary.totalNew} bản ghi từ backup` });
    const count = _pendingImportSummary.totalNew;
    _pendingImportMap = null;
    _pendingImportSummary = null;
    closeModal();
    toast(`Đã thêm ${count} bản ghi mới từ backup`);
  }, _ctx && _ctx.node);
}

// [F-07] Khôi phục bản ghi từ trash (chỉ tạo lại nếu ID gốc chưa tồn tại)
async function restoreTrashItem(trashId, _ctx){
  return once('restoreTrash:' + trashId, async () => {
    if (!isAdmin()) return toast('Chỉ quản trị viên mới khôi phục được');
    const tr = Data.trash.find(x => x.id === trashId);
    if (!tr || !tr.data) return toast('Không tìm thấy dữ liệu trong thùng rác');
    const col = tr.kind === 'group_txn' ? 'group_txns' : 'txns';
    const origId = tr.original_id || tr.id;
    const res = await Store.createIfAbsent(`${col}/${origId}`, tr.data);
    if (!res.created) return toast('ID gốc đã tồn tại, không ghi đè');
    await Store.del('trash', trashId);
    await log('RESTORE', tr.kind || 'transaction', origId, { title: tr.data.title || origId });
    toast('Đã khôi phục bản ghi thành công');
  }, _ctx && _ctx.node);
}

// [F-03] Kiểm tra toàn vẹn dữ liệu toàn hệ thống (CHỈ ĐỌC, không có nút tự sửa)
function runDataIntegrityAudit(){
  const issues = [];
  const infoNotes = [];

  for (const t of Data.txns){
    if (t._invalid && t._invalid.length){
      issues.push(`Giao dịch [${t.id}] “${t.title}”: lỗi định dạng (${t._invalid.join(', ')})`);
    }
    const confirmedSum = Data.settlements
      .filter(s => !s._invalid && s.transaction_id === t.id && settlementStatus(s) === 'CONFIRMED')
      .reduce((a, s) => a + s.amount, 0);
    if ((t.repaid || 0) !== confirmedSum){
      infoNotes.push(`Giao dịch [${t.id}] “${t.title}”: repaid (${vnd(t.repaid || 0)}) khác tổng settlement CONFIRMED (${vnd(confirmedSum)}) — thông tin tham khảo.`);
    }
  }
  for (const s of Data.settlements){
    if (s._invalid && s._invalid.length){
      issues.push(`Settlement [${s.id}]: lỗi định dạng (${s._invalid.join(', ')})`);
    }
    const t = (Idx.txnById && Idx.txnById[s.transaction_id]) || Data.txns.find(x => x.id === s.transaction_id);
    const st = settlementStatus(s);
    if (st === 'PENDING' && !t){
      issues.push(`Settlement PENDING [${s.id}] (${vnd(s.amount)}) trỏ tới giao dịch không còn tồn tại [${s.transaction_id}].`);
    }
    if (st === 'PENDING' && t && s.amount > remainOf(t)){
      issues.push(`Settlement PENDING [${s.id}] (${vnd(s.amount)}) vượt phần còn nợ (${vnd(remainOf(t))}) của giao dịch “${t.title}”.`);
    }
    if (st === 'PENDING' && t && t.applied_settlements && t.applied_settlements[s.id]){
      issues.push(`Settlement PENDING [${s.id}] đã có dấu applied trên giao dịch [${t.id}] (cần bấm xác nhận lại để đồng bộ).`);
    }
  }
  for (const f of Data.friendships){
    if (f._invalid && f._invalid.length){
      issues.push(`Friendship [${f.id}]: sai định dạng ID cặp (${f.user_a}, ${f.user_b}).`);
    }
  }
  for (const gt of Data.group_txns){
    if (gt._invalid && gt._invalid.length){
      issues.push(`Khoản chi nhóm [${gt.id}] “${gt.title}”: ${gt._invalid.join(', ')}.`);
    }
  }
  const savingIds = new Set(Data.savings.map(s => s.id));
  for (const e of Data.savings_entries){
    if (!savingIds.has(e.savings_id)){
      issues.push(`Bản ghi tiết kiệm [${e.id}] (${vnd(e.amount)}) mồ côi (không tìm thấy mục tiêu [${e.savings_id}]).`);
    }
  }
  // Kiểm tra điểm cuối của netSeries so với netBalance() trên sổ đang mở [D-06]
  if (peer){
    const ns = netSeries(lastMonths(6));
    const endVal = ns.length ? ns[ns.length - 1].value : 0;
    const nb = netBalance();
    if (endVal !== nb){
      infoNotes.push(`Sổ đang mở (${me.username} ↔ ${peer}): điểm cuối biểu đồ 6 tháng (${vnd(endVal)}) khác số dư hiện tại (${vnd(nb)}) — có thể do giao dịch có ngày trong tương lai hoặc settlement cũ.`);
    }
  }
  return { issues, infoNotes };
}

// Hiển thị mật khẩu tạm 1 lần trong hộp thoại có nút Sao chép [S-04, F-02]
let _lastTempPw = '';
function showTempPasswordModal(title, username, tempPw){
  _lastTempPw = tempPw;
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">${esc(title)}</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <p style="margin-top:0;color:var(--muted)">Mật khẩu tạm cho tài khoản <b>${esc(username)}</b> chỉ hiển thị <b>đúng một lần này</b>. Hãy sao chép và gửi cho người dùng (họ sẽ được yêu cầu đổi mật khẩu ngay khi đăng nhập):</p>
    <div class="preview" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <b class="num" style="font-size:20px;color:var(--gold-2);letter-spacing:.06em">${esc(tempPw)}</b>
      <button class="btn sm primary" type="button" ${A('copyTempPw')}>Sao chép</button>
    </div>
  </div>
  <footer><button class="btn primary" type="button" ${A('closeModal')}>Đã lưu lại</button></footer>`);
}
async function copyTempPw(){
  if (!_lastTempPw) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(_lastTempPw);
      toast('Đã sao chép mật khẩu tạm');
    } else {
      toast('Hãy bôi đen và sao chép mật khẩu trên màn hình');
    }
  } catch (_){
    toast('Hãy bôi đen và sao chép mật khẩu trên màn hình');
  }
}

// [F-02, S-04] Đặt lại mật khẩu cho tài khoản quên mật khẩu
function openResetPw(uname){
  const u = Data.usersById[uname];
  if (!u || !canResetPwOf(u)) return toast('Bạn không có quyền đặt lại mật khẩu cho tài khoản này');
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Đặt lại mật khẩu · ${esc(nameOf(uname))}</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <p style="margin-top:0;color:var(--muted)">Hệ thống sẽ sinh một mật khẩu tạm ngẫu nhiên 10 ký tự cho tài khoản <b>${esc(uname)}</b>, đăng xuất các phiên cũ và yêu cầu người dùng đổi mật khẩu ở lần đăng nhập kế tiếp.</p>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doResetPw', uname)}>Sinh mật khẩu tạm mới</button></footer>`);
}

async function doResetPw(uname, _ctx){
  return once('doResetPw:' + uname, async () => {
    const fresh = await getUserDoc(uname);
    if (!fresh || !canResetPwOf(fresh)) return toast('Không có quyền đặt lại mật khẩu tài khoản này');
    const tempPw = generateTempPassword(10);
    const hash = await makePasswordHash(tempPw);
    const ts = now();
    await saveUserCred(uname, hash);
    await Store.update('users/' + uname, { must_change_pw: true, pw_changed_at: ts });
    await log('EDIT', 'user', uname, { title: `Đặt lại mật khẩu tạm cho ${uname}`, acted_as_admin: true, on_behalf_of: uname });
    showTempPasswordModal('Mật khẩu tạm mới', uname, tempPw);
  }, _ctx && _ctx.node);
}

// [S-04, 8.3] Bật/tắt cờ nâng cấp băm mật khẩu PBKDF2-SHA256
async function togglePwUpgradeFlag(_arg, _ctx){
  return once('togglePwUpgradeFlag', async () => {
    if (!isAdmin()) return toast('Chỉ quản trị viên');
    const cur = isPwUpgradeEnabled();
    const next = !cur;
    await Store.update('config/flags', { pw_upgrade: next, updated_at: now(), updated_by: me.username });
    if (!Data.config.flags) Data.config.flags = {};
    Data.config.flags.pw_upgrade = next;
    toast(next ? 'Đã bật nâng cấp băm PBKDF2-SHA256' : 'Đã tắt cờ nâng cấp PBKDF2 (giữ SHA-256 tương thích ngược)');
    scheduleRender({ forceMain:true });
  }, _ctx && _ctx.node);
}

function vAccountsSection(){
  const rows = [...Data.users].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  return `<section class="section panel">
    <div class="panel-head">
      <h3>Tài khoản (${rows.length})</h3>
      <button class="btn sm primary" type="button" ${A('openCreateUser')}>+ Tạo tài khoản</button>
    </div>
    <div class="body">${rows.length ? `<div class="tbl-wrap"><table class="resp-tbl">
      <thead><tr><th>Username</th><th>Tên hiển thị</th><th>Cấp</th><th>Người tạo</th><th>Ngày tạo</th><th>Trạng thái</th><th></th></tr></thead>
      <tbody>${rows.map(u => `
        <tr><td data-label="Username">${esc(u.id)}</td>
        <td data-label="Tên hiển thị">${esc(u.name)}</td>
        <td data-label="Cấp"><span class="tag">${esc(ROLE_VI[roleValid(u.role)])}</span></td>
        <td class="meta" data-label="Người tạo">${esc(u.created_by || '—')}</td>
        <td class="meta num" data-label="Ngày tạo">${u.created_at ? fmtDate(String(u.created_at).slice(0, 10)) : '—'}</td>
        <td data-label="Trạng thái">${u.must_change_pw ? '<span class="tag">Chờ đổi mật khẩu</span>' : '<span class="tag">Hoạt động</span>'}</td>
        <td data-act="noop">
          <span style="display:inline-flex;gap:6px;flex-wrap:wrap">
            ${canChangeRoleOf(u) ? `<button class="btn sm" type="button" ${A('openChangeRole', u.id)}>Nâng/Hạ cấp</button>` : ''}
            ${canResetPwOf(u) ? `<button class="btn sm" type="button" ${A('openResetPw', u.id)}>Đặt lại MK</button>` : ''}
          </span>
        </td></tr>`).join('')}
      </tbody></table></div>`
      : `<div class="empty">Chưa tải được danh sách tài khoản.</div>`}</div>
  </section>`;
}

function vAdmin(){
  if (!canManageUsers()) return `<div class="panel"><div class="empty"><b>Trang chỉ dành cho quản trị viên</b>
    Tài khoản của bạn không có quyền truy cập.</div></div>`;
  if (!isAdmin()) return `
  <div class="page-head"><div><h2>Quản trị</h2><p>Tạo tài khoản VIP/Thường, đặt lại mật khẩu và nâng/hạ cấp giữa hai cấp này.</p></div></div>
  ${vAccountsSection()}`;

  const b = balanceText();
  const validTxns = Data.txns.filter(t => !t._invalid);
  const openN = validTxns.filter(t => statusOf(t) === 'OPEN').length;
  const partN = validTxns.filter(t => statusOf(t) === 'PARTIALLY_SETTLED').length;
  const doneN = validTxns.filter(t => statusOf(t) === 'SETTLED').length;
  const vol = validTxns.reduce((a, t) => a + t.amount, 0);
  const recent = [...Data.activity].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 10);
  const audit = runDataIntegrityAudit();
  const pwUp = isPwUpgradeEnabled();

  return `
  <div class="page-head"><div><h2>Quản trị</h2><p>Toàn cảnh dữ liệu hệ thống · Phiên bản v${APP_VERSION}.</p></div></div>
  <div class="grid cards">
    ${stat('Tổng giao dịch', validTxns.length)}
    ${stat('Tổng giá trị', vnd(vol))}
    ${stat('Chưa trả', openN, 'debit')}
    ${stat('Trả một phần', partN)}
    ${stat('Đã xong', doneN, 'credit')}
    ${stat('Số dư ròng (sổ đang mở)', vnd(b.amount))}
  </div>
  <section class="section panel"><h3>Số dư hiện tại (sổ đang mở)</h3><div class="body">
    ${!peer ? 'Chưa chọn sổ chung đang mở.' : (b.amount ? `${esc(b.text)} <b class="num">${vnd(b.amount)}</b>` : 'Hai bên đã cân bằng.')}</div></section>
  <section class="section panel"><h3>Hoạt động gần đây</h3><div class="body">
    ${recent.map(a => `<div class="log"><time>${fmtDT(a.created_at)}</time>
      <div><b>${esc(nameOf(a.user_id))}</b> ${ACT_VI[a.action] || esc(a.action)}
      ${a.metadata && a.metadata.title ? ` “${esc(a.metadata.title)}”` : ''}
      ${a.metadata && a.metadata.acted_as_admin && a.metadata.on_behalf_of ? ` <span class="tag">Thay mặt ${esc(nameOf(a.metadata.on_behalf_of))}</span>` : ''}</div></div>`).join('')
      || `<div class="empty">Chưa có hoạt động.</div>`}</div></section>
  <section class="section panel"><h3>Tất cả giao dịch</h3>
    ${validTxns.length ? `<div class="tbl-wrap">${txnTable(sortedTxns())}</div>` : `<div class="empty">Chưa có dữ liệu.</div>`}</section>
  ${vAccountsSection()}

  <!-- [F-03] Kiểm tra toàn vẹn dữ liệu (chỉ đọc) -->
  <section class="section panel">
    <h3>Kiểm tra toàn vẹn dữ liệu (Chỉ đọc)</h3>
    <div class="body">
      ${audit.issues.length ? `<div class="err" style="margin-bottom:10px"><b>Phát hiện ${audit.issues.length} bản ghi cần xem lại:</b>
        <ul style="margin:6px 0 0;padding-left:18px">${audit.issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`
        : `<p style="margin:0 0 8px;color:var(--credit)">✓ Không phát hiện bản ghi hỏng hay lệch bất biến tiền tệ.</p>`}
      ${audit.infoNotes.length ? `<div class="preview"><div style="color:var(--muted);font-size:12.5px;margin-bottom:4px">Ghi chú đối chiếu (mức thông tin):</div>
        <ul style="margin:0;padding-left:18px;font-size:13px">${audit.infoNotes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    </div>
  </section>

  <!-- [F-07] Thùng rác (Trash) -->
  ${Data.trash.length ? `<section class="section panel"><h3>Thùng rác (${Data.trash.length})</h3><div class="body">
    ${Data.trash.slice(0, 20).map(tr => `<div class="kv">
      <span>[${esc(tr.kind || 'txn')}] <b>${esc((tr.data && tr.data.title) || tr.original_id || tr.id)}</b> · ${tr.data && tr.data.amount ? vnd(tr.data.amount) : ''} · xóa bởi ${esc(nameOf(tr.deleted_by))} (${fmtDT(tr.deleted_at)})</span>
      <button class="btn sm" type="button" ${A('restoreTrashItem', tr.id)}>Khôi phục</button>
    </div>`).join('')}
  </div></section>` : ''}

  <!-- [S-04, 8.3] Cờ bảo mật nâng cấp băm mật khẩu -->
  <section class="section panel">
    <h3>Bảo mật mật khẩu (PBKDF2-SHA256)</h3>
    <div class="body">
      <div class="kv"><span>Trạng thái nâng cấp PBKDF2 (` + '`config/flags.pw_upgrade`' + `)</span>
        <b>${pwUp ? 'Đang BẬT (PBKDF2-SHA256 · 250.000 vòng)' : 'Đang TẮT (SHA-256 tương thích bản cũ)'}</b></div>
      <p class="hint">Cảnh báo: Sau khi bật cờ này, các tài khoản đăng nhập hoặc đổi mật khẩu sẽ được nâng cấp sang định dạng băm PBKDF2-SHA256. Nếu sau đó bạn quay lui về code bản cũ (v3), những tài khoản đã nâng cấp sẽ cần quản trị viên đặt lại mật khẩu. Chỉ nên bật sau khi bản v4 đã chạy ổn định vài ngày.</p>
      <button class="btn sm" type="button" ${A('togglePwUpgradeFlag')}>${pwUp ? 'Tắt cờ nâng cấp PBKDF2' : 'Bật nâng cấp PBKDF2-SHA256'}</button>
    </div>
  </section>

  <section class="section panel">
    <h3>Dữ liệu, Backup v2 &amp; Bảo trì</h3>
    <div class="body">
      <p class="hint" style="margin-top:0">Bắt buộc tải backup JSON trước khi chạy migration. Migration chỉ
      <b>cập nhật thêm</b> trường <span class="tag">pair_id</span> cho giao dịch/thanh toán cũ chưa có (mặc định
      <span class="tag">duy_nguyen</span>) — không xóa, không ghi đè các trường khác.</p>
      <div class="actions" style="margin-top:12px">
        <button class="btn primary" type="button" ${A('exportBackup')}>Tải backup JSON (v2)</button>
        <button class="btn" type="button" ${A('openImportBackupModal')}>Nhập backup (Chỉ thêm mới)</button>
        <button class="btn" type="button" ${A('forceMigrate')}>Chạy migration pair_id</button>
      </div>
      <div class="preview" style="margin-top:14px">
        <div class="row"><span>Giao dịch thiếu pair_id</span><b class="num">${Data.txns.filter(t => !t.pair_id).length}</b></div>
        <div class="row"><span>Thanh toán thiếu pair_id</span><b class="num">${Data.settlements.filter(s => !s.pair_id).length}</b></div>
        <div class="row"><span>Tài khoản</span><b class="num">${Data.users.length}</b></div>
        <div class="row"><span>Quan hệ bạn bè</span><b class="num">${Data.friendships.length}</b></div>
      </div>
    </div>
  </section>

  <!-- [F-11] Khung chẩn đoán hệ thống -->
  <section class="section panel">
    <h3>Chẩn đoán hệ thống</h3>
    <div class="body">
      <div class="kv"><span>Phiên bản client</span><b class="num">v${APP_VERSION}</b></div>
      <div class="kv"><span>Trạng thái mạng</span><b>${Store.online ? 'Trực tuyến (Online)' : 'Mất kết nối (Offline)'}</b></div>
      <div class="kv"><span>Độ lệch đồng hồ server</span><b class="num">${(typeof window !== 'undefined' && window.FIREBASE_STORE && window.FIREBASE_STORE.serverOffset) ? window.FIREBASE_STORE.serverOffset() + ' ms' : '0 ms'}</b></div>
      ${_diagErrors.length ? `<div style="margin-top:10px"><div class="meta" style="margin-bottom:4px">Lỗi ghi nhận gần đây trong phiên (${_diagErrors.length}):</div>
        ${_diagErrors.slice(0, 5).map(e => `<div class="meta num">${esc(fmtDT(e.at))} · [${esc(e.ctx)}] ${esc(e.msg)}</div>`).join('')}</div>`
        : `<p class="hint" style="margin-bottom:0">Không có lỗi nào được ghi nhận trong phiên làm việc hiện tại.</p>`}
    </div>
  </section>`;
}

function openCreateUser(){
  if (!canManageUsers()) return toast('Không có quyền');
  const roleOpts = assignableRoles();
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Tạo tài khoản mới</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="field"><label for="nu_user">Tên đăng nhập (chữ thường a-z, số 0-9, 2–20 ký tự)</label>
      <input class="input" id="nu_user" maxlength="20" autocapitalize="none" spellcheck="false" placeholder="vd: minh"></div>
    <div class="field"><label for="nu_name">Tên hiển thị</label>
      <input class="input" id="nu_name" maxlength="40" placeholder="vd: Minh"></div>
    <div class="field"><label for="nu_role">Cấp tài khoản</label>
      <select class="input" id="nu_role">${roleOpts.map(r =>
        `<option value="${r}" ${r === 'USER' ? 'selected' : ''}>${esc(ROLE_VI[r])}</option>`).join('')}</select></div>
    ${!isAdmin() ? `<p class="hint" style="margin-top:0">Bạn chỉ tạo được tài khoản cấp VIP hoặc Thường.</p>` : ''}
    <div id="nu_err"></div>
    <p class="hint">Hệ thống sẽ sinh một mật khẩu tạm ngẫu nhiên 10 ký tự và hiển thị một lần sau khi tạo. Người dùng sẽ phải đổi mật khẩu ở lần đăng nhập đầu tiên.</p>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doCreateUser')}>Tạo tài khoản</button></footer>`);
  if (el('nu_user')) el('nu_user').focus();
}

// [S-04, S-07, C-04, C-05] Tạo tài khoản bằng createIfAbsent + mật khẩu tạm ngẫu nhiên 10 ký tự
async function doCreateUser(_arg, _ctx){
  return once('doCreateUser', async () => {
    if (!canManageUsers()) return toast('Không có quyền');
    const uRes = V.username(el('nu_user') ? el('nu_user').value : '');
    const name = V.text(el('nu_name') ? el('nu_name').value : '', { max:40 });
    const role = el('nu_role') ? el('nu_role').value : 'USER';
    const errs = [];
    if (!assignableRoles().includes(role)) errs.push('Bạn không có quyền tạo tài khoản ở cấp này.');
    if (!uRes.ok) errs.push(uRes.error);
    if (!name) errs.push('Cần nhập tên hiển thị.');
    if (errs.length){
      if (el('nu_err')) el('nu_err').innerHTML = `<div class="err">${esc(errs.join(' '))}</div>`;
      return;
    }
    const uname = uRes.value;
    const ts = now();
    const createRes = await Store.createIfAbsent('users/' + uname, {
      username: uname, name, role,
      created_by: me.username, created_at: ts, must_change_pw: true, group_quota_used: 0, pw_changed_at: ts
    });
    if (!createRes.created){
      if (el('nu_err')) el('nu_err').innerHTML = `<div class="err">Tên đăng nhập "${esc(uname)}" đã tồn tại.</div>`;
      return;
    }
    const tempPw = generateTempPassword(10);
    const hash = await makePasswordHash(tempPw);
    await saveUserCred(uname, hash);
    await log('CREATE', 'user', uname, { title: `${name} (${ROLE_VI[role]})` });
    showTempPasswordModal('Đã tạo tài khoản mới', uname, tempPw);
  }, _ctx && _ctx.node);
}

/* ---- v3 mục 5 & V4 [L-06, C-01]: nâng/hạ cấp tài khoản bằng transaction ---- */
function openChangeRole(uname){
  const u = Data.usersById[uname]; if (!u) return;
  if (!canChangeRoleOf(u)) return toast('Không có quyền đổi cấp tài khoản này');
  const cur = roleValid(u.role), opts = assignableRoles();
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Nâng/Hạ cấp · ${esc(nameOf(uname))}</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body">
    <div class="kv"><span>Cấp hiện tại</span><b>${esc(ROLE_VI[cur])}</b></div>
    <div class="field"><label for="cr_role">Cấp mới</label>
      <select class="input" id="cr_role">${opts.map(r =>
        `<option value="${r}" ${r === cur ? 'selected' : ''}>${esc(ROLE_VI[r])}</option>`).join('')}</select></div>
    <div id="cr_err"></div>
    <p class="hint">${opts.map(r => `<b>${esc(ROLE_VI[r])}</b>: ${esc(ROLE_DESC[r])}`).join('<br>')}</p>
  </div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn primary" type="button" ${A('doChangeRole', uname)}>Lưu cấp mới</button></footer>`);
}

async function doChangeRole(uname, _ctx){
  return once('doChangeRole:' + uname, async () => {
    const newRole = el('cr_role') ? el('cr_role').value : '';
    if (!assignableRoles().includes(newRole)) return toast('Không có quyền đổi sang cấp này');
    // Đọc danh sách users mới nhất từ DB để đếm số lượng ADMIN chính xác [L-06]
    const allUsersSnap = await Store.get('users');
    const allUsersObj = (allUsersSnap.exists && allUsersSnap.data) ? allUsersSnap.data : Data.usersById;
    const adminCount = Object.values(allUsersObj).filter(u => u && roleValid(u.role) === 'ADMIN').length;

    let abortMsg = '';
    let oldRole = 'USER';
    const txRes = await Store.tx('users/' + uname, cur => {
      if (cur === null) return null;
      if (!canChangeRoleOf(cur)){
        abortMsg = 'Không có quyền đổi cấp tài khoản này.';
        return undefined;
      }
      oldRole = roleValid(cur.role);
      if (oldRole === newRole){
        abortMsg = 'SAME_ROLE';
        return undefined;
      }
      if (oldRole === 'ADMIN' && newRole !== 'ADMIN' && adminCount <= 1){
        abortMsg = 'Đây là quản trị viên cuối cùng — không thể hạ cấp.';
        return undefined;
      }
      return {
        ...cur,
        role: newRole,
        upgraded_by: me.username,
        upgraded_at: now()
      };
    });

    if (!txRes.committed){
      if (abortMsg === 'SAME_ROLE'){ closeModal(); return toast('Cấp không thay đổi'); }
      if (el('cr_err')) el('cr_err').innerHTML = `<div class="err">${esc(abortMsg || 'Không thể đổi cấp lúc này.')}</div>`;
      else toast(abortMsg || 'Không thể đổi cấp');
      return;
    }
    await log('EDIT', 'user', uname, { title: `${uname}: ${ROLE_VI[oldRole]} → ${ROLE_VI[newRole]}`, acted_as_admin: true, on_behalf_of: uname });
    closeModal();
    toast(`Đã đổi ${uname} sang cấp ${ROLE_VI[newRole]}`);
  }, _ctx && _ctx.node);
}

/* ---- delete [D-05, F-07, S-09] ---- */
function confirmDelete(id){
  const t = Data.txns.find(x => x.id === id); if (!t) return;
  if (pendingOutgoingFor(t)){
    return toast('Giao dịch đang có yêu cầu thanh toán chờ xác nhận. Hãy xử lý yêu cầu trước khi xóa.');
  }
  if (!canDelete(t)){
    return toast((t.repaid || 0) > 0 || hasConfirmedSettlementFor(t)
      ? 'Giao dịch đã có lịch sử trả tiền — chỉ quản trị viên mới được xóa'
      : 'Bạn không được xóa giao dịch của người khác');
  }
  modal(`<div class="sheet-grab" aria-hidden="true"></div>
  <header><h3 id="modalTitle">Xóa giao dịch?</h3><button class="x" type="button" ${A('closeModal')} aria-label="Đóng">✕</button></header>
  <div class="body"><p style="margin-top:0"><b>${esc(t.title)}</b><br>
  <span class="num" style="font-size:20px">${vnd(t.amount)}</span></p>
  <p style="color:var(--muted)">Bản sao của giao dịch sẽ được lưu vào thùng rác quản trị trước khi xóa. Các khoản đã hoàn trả vẫn được giữ trong lịch sử.</p></div>
  <footer><button class="btn" type="button" ${A('closeModal')}>Hủy</button>
  <button class="btn danger" type="button" ${A('doDelete', id)}>Xóa</button></footer>`);
}

async function doDelete(id, _ctx){
  return once('doDelete:' + id, async () => {
    const t = Data.txns.find(x => x.id === id);
    if (!t) return;
    if (pendingOutgoingFor(t)) return toast('Không thể xóa khi đang có yêu cầu thanh toán chờ xác nhận');
    if (!canDelete(t)) return toast('Bạn không có quyền xóa giao dịch này');

    const freshSnap = await Store.get('txns/' + id);
    if (!freshSnap.exists) { closeModal(); return toast('Giao dịch không còn tồn tại'); }
    const freshData = freshSnap.data;
    if (freshData.pending_sid){
      closeModal();
      return toast('Giao dịch vừa có yêu cầu chờ xác nhận, không thể xóa');
    }
    if (((freshData.repaid || 0) > 0 || hasConfirmedSettlementFor(t)) && !isAdmin()){
      closeModal();
      return toast('Chỉ quản trị viên mới được xóa giao dịch đã trả tiền');
    }

    // [D-05, F-07] Lưu vào trash/{id} trước khi xoá
    await Store.set('trash', id, {
      kind: 'transaction',
      original_id: id,
      data: freshData,
      deleted_by: me.username,
      deleted_at: now()
    });
    await Store.del('txns', id);
    const meta = { title: t.title, amount: t.amount };
    if (isAdmin() && t.created_by !== me.username){
      meta.acted_as_admin = true;
      meta.on_behalf_of = t.created_by;
    }
    await log('DELETE', 'transaction', id, meta);
    closeModal();
    toast('Đã xóa giao dịch');
    go('transactions');
  }, _ctx && _ctx.node);
}

/* ---- modal [R-05, U-12, U-15] ---- */
let _lastFocusEl = null;
function modal(html){
  if (typeof document !== 'undefined') _lastFocusEl = document.activeElement;
  const root = el('modalRoot');
  if (!root) return;
  root.innerHTML = `<div class="scrim" data-act="scrimClose">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">${html}</div></div>`;
  if (typeof document !== 'undefined'){
    document.body.classList.add('modal-open');
    const firstInput = root.querySelector('input:not([type="hidden"]),select,textarea,button:not(.x)');
    if (firstInput && typeof firstInput.focus === 'function'){
      setTimeout(() => firstInput.focus(), 10);
    }
  }
}
function closeModal(){
  const root = el('modalRoot');
  if (root) root.innerHTML = '';
  if (typeof document !== 'undefined'){
    document.body.classList.remove('modal-open');
    if (_lastFocusEl && typeof _lastFocusEl.focus === 'function'){
      try { _lastFocusEl.focus(); } catch (_){}
    }
    _lastFocusEl = null;
  }
}
function scrimClose(_arg, ctx){
  if (ctx && ctx.event && ctx.node && ctx.event.target === ctx.node) closeModal();
}

if (typeof document !== 'undefined'){
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){
      if (el('modalRoot') && el('modalRoot').innerHTML){ closeModal(); return; }
      if (chatOpen){ closeChat(); return; }
    }
    // [R-05, U-15] Bẫy phím Tab bên trong modal khi đang mở
    if (e.key === 'Tab' && el('modalRoot') && el('modalRoot').innerHTML){
      const m = el('modalRoot').querySelector('.modal');
      if (!m) return;
      const focusables = [...m.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first){
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last){
        e.preventDefault(); first.focus();
      }
    }
  });
}

/* ---- routing [S-06, U-01] ---- */
Object.assign(VIEW_MAP, {
  dashboard: vDashboard,
  stats: vStats,
  friends: vFriends,
  transactions: vTransactions,
  detail: vDetail,
  new: vNew,
  settlements: vSettlements,
  history: vHistory,
  activity: vActivity,
  groups: vGroups,
  savings: vSavings,
  budget: vBudget,
  settings: vSettings,
  admin: vAdmin
});

function go(path, param){
  if (!path) return;
  location.hash = '#/' + path + (param ? '/' + encodeURIComponent(param) : '');
}
function parseHash(){
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p); } catch (_){ return p; }
  });
  if (!parts.length) return { path:'dashboard', param:null };
  const p0 = parts[0];
  const rawParam = parts[1] || null;
  const validParam = rawParam && V.id(rawParam).ok ? V.id(rawParam).value : null;
  if (p0 === 'transactions' && rawParam) return { path:'detail', param:validParam || '__invalid__' };
  if (p0 === 'new') return { path:'new', param:rawParam ? (validParam || '__invalid__') : null };
  if (!Object.prototype.hasOwnProperty.call(VIEW_MAP, p0)) return { path:'dashboard', param:null };
  return { path:p0, param:validParam };
}

if (typeof window !== 'undefined'){
  window.addEventListener('hashchange', () => {
    if (!me) return;
    _formDirty = false;
    route = parseHash();
    closeModal();
    window.scrollTo(0, 0);
    const mainEl = el('main');
    if (mainEl){
      mainEl.classList.add('enter');
      setTimeout(() => mainEl.classList.remove('enter'), 720);
    }
    scheduleRender({ forceMain:true });
  });
  // [U-22] Vẽ lại biểu đồ khi xoay màn hình / đổi kích thước
  let _resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!me || (route.path !== 'dashboard' && route.path !== 'stats')) return;
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => scheduleRender({ forceMain:true }), 180);
  });
}

/* ---- [U-14, S-05] Hiện/ẩn mật khẩu & cảnh báo Caps Lock ---- */
function toggleLoginPw(){
  const p = el('p');
  const btn = el('pwToggleBtn');
  if (!p || !btn) return;
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  btn.innerHTML = `<svg class="ic" width="18" height="18"><use href="#${show ? 'ic-eye-off' : 'ic-eye'}"/></svg>`;
}
function reloadPage(){
  if (typeof location !== 'undefined') location.reload();
}

/* ---- Đăng ký toàn bộ hàm vào bảng uỷ quyền sự kiện ACTIONS [K5] ---- */
registerActions({
  noop: () => {},
  go,
  switchPeer,
  openChat,
  closeChat,
  backToThreads,
  openThread,
  sendMessage,
  openMoreSheet,
  openQuickAdd,
  quickSubmit,
  submitTxn,
  markPaid,
  confirmSettlement,
  rejectSettlement,
  openPartial,
  doPartial,
  openSettle,
  doSettle,
  setTxnStatusFilter,
  setHistoryMonth,
  changePw,
  logout,
  sendFriendRequest,
  cancelFriendRequest,
  confirmUnfriend,
  unfriend,
  respondFriend,
  openCreateGroup,
  doCreateGroup,
  openGroupTxn,
  submitGroupTxn,
  toggleGroupParticipant,
  markGroupPaid,
  confirmGroupPaid,
  rejectGroupPaid,
  confirmDeleteGroupTxn,
  doDeleteGroupTxn,
  openNewSaving,
  doCreateSaving,
  openSavingEntry,
  doSavingEntry,
  closeSaving,
  saveBudget,
  exportBackup,
  openImportBackupModal,
  onImportFileSelected,
  executeImportBackup,
  forceMigrate,
  restoreTrashItem,
  openCreateUser,
  doCreateUser,
  openResetPw,
  doResetPw,
  copyTempPw,
  togglePwUpgradeFlag,
  openChangeRole,
  doChangeRole,
  confirmDelete,
  doDelete,
  openDisputeModal,
  submitDispute,
  clearDispute,
  closeModal,
  scrimClose,
  toggleLoginPw,
  reloadPage
});

const INPUT_HANDLERS = {
  onTxnSearchInput
};
const CHANGE_HANDLERS = {
  onTxnSortChange,
  onBudgetMonthChange,
  saveBudget: (val, node) => saveBudget(node.getAttribute('data-cat'), val),
  onImportFileSelected: (val, node, ev) => onImportFileSelected(val, { node, event:ev })
};

if (typeof document !== 'undefined'){
  document.addEventListener('click', e => {
    const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!n) return;
    const act = n.getAttribute('data-act');
    if (act === 'noop'){
      e.stopPropagation();
      return;
    }
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, act) ? ACTIONS[act] : null;
    if (typeof fn !== 'function') return;
    let args = [];
    try { args = JSON.parse(n.getAttribute('data-args') || '[]'); } catch (_){ args = []; }
    if (!Array.isArray(args)) args = [];
    fn(...args, { node:n, event:e });
  });

  document.addEventListener('keydown', e => {
    const t = e.target;
    if (!t) return;
    if (e.key === 'Enter' && !e.shiftKey && t.getAttribute && t.getAttribute('data-on-enter')){
      if (_isComposing) return;
      const act = t.getAttribute('data-on-enter');
      const fn = Object.prototype.hasOwnProperty.call(ACTIONS, act) ? ACTIONS[act] : null;
      if (typeof fn === 'function'){
        e.preventDefault();
        fn(undefined, { node:t, event:e });
        return;
      }
    }
    if (e.key === 'Enter' && t.getAttribute && t.getAttribute('data-act') && t.tagName !== 'BUTTON' && t.tagName !== 'A'){
      const act = t.getAttribute('data-act');
      const fn = Object.prototype.hasOwnProperty.call(ACTIONS, act) ? ACTIONS[act] : null;
      if (typeof fn === 'function'){
        e.preventDefault();
        let args = [];
        try { args = JSON.parse(t.getAttribute('data-args') || '[]'); } catch (_){}
        fn(...(Array.isArray(args) ? args : []), { node:t, event:e });
      }
    }
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const h = t.getAttribute('data-on-input');
    if (h && Object.prototype.hasOwnProperty.call(INPUT_HANDLERS, h)){
      INPUT_HANDLERS[h](t.value, t, e);
    }
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const h = t.getAttribute('data-on-change');
    if (h && Object.prototype.hasOwnProperty.call(CHANGE_HANDLERS, h)){
      CHANGE_HANDLERS[h](t.value, t, e);
    }
  });
}

/* ---- boot [B-01, B-02, S-05, S-08, R-08] ---- */
function showBootErrorScreen(msg){
  const lv = el('loginView');
  if (!lv) return;
  lv.style.display = '';
  lv.innerHTML = `<div class="login">
    <div class="brand">
      <div class="mark"><span></span></div>
      <h1>Sổ chung<small>Duy &amp; Nguyen</small></h1>
    </div>
    <div class="err"><b>Không thể kết nối cơ sở dữ liệu</b><br>${esc(msg || 'Vui lòng kiểm tra kết nối mạng hoặc trình chặn quảng cáo và thử lại.')}</div>
    <button class="btn primary wide" type="button" ${A('reloadPage')}>Thử lại</button>
    <p class="hint">Để bảo vệ dữ liệu thật, ứng dụng không tự động chuyển sang lưu tạm trên máy khi mất kết nối tới Firebase.</p>
  </div>`;
}

async function startApp(user){
  // Huỷ các listener cũ nếu có [R-08]
  for (const unsub of _unsubs){
    try { if (typeof unsub === 'function') unsub(); } catch (_){}
  }
  _unsubs = [];

  me = Norm.user(user);
  mustChangePw = !!me.must_change_pw;
  Data.usersById[me.username] = me;
  Idx.usersById = Data.usersById;
  saveSession(me.username);

  const lv = el('loginView'), av = el('appView');
  if (lv) lv.style.display = 'none';
  if (av) av.classList.add('on');
  route = parseHash();
  const mainEl = el('main');
  if (mainEl){
    mainEl.classList.add('enter');
    setTimeout(() => mainEl.classList.remove('enter'), 720);
  }
  scheduleRender({ forceMain:true });

  ALL_WATCH_COLS.forEach(col => {
    const unsub = Store.watch(col, rows => {
      applyCollection(col, rows);
      if (col === 'friendships') maybeAutoSelectPeer();
      scheduleRender();
    });
    if (typeof unsub === 'function') _unsubs.push(unsub);
  });

  // [S-08] Chỉ ADMIN mới tự động kiểm tra bổ sung tài khoản gốc duy/nguyen bằng createIfAbsent sau khi đăng nhập
  if (isAdmin()){
    ensureLegacyUsers().catch(() => {});
    ensureLegacyFriendship().catch(() => {});
  }
}

if (typeof document !== 'undefined'){
  const pInput = el('p');
  if (pInput){
    ['keydown','keyup'].forEach(ev => pInput.addEventListener(ev, e => {
      const warn = el('capsWarn');
      if (warn && typeof e.getModifierState === 'function'){
        warn.style.display = e.getModifierState('CapsLock') ? '' : 'none';
      }
    }));
  }

  const lf = el('loginForm');
  if (lf){
    lf.addEventListener('submit', async e => {
      e.preventDefault();
      const guard = getLoginGuard();
      if (guard.until && Date.now() < guard.until){
        const waitSec = Math.ceil((guard.until - Date.now()) / 1000);
        if (el('loginErr')) el('loginErr').innerHTML = `<div class="err">Bạn đã nhập sai nhiều lần. Vui lòng thử lại sau ${waitSec} giây.</div>`;
        return;
      }
      const btn = el('loginBtn');
      if (btn){ btn.disabled = true; btn.textContent = 'Đang kiểm tra…'; }
      if (el('loginErr')) el('loginErr').innerHTML = '';
      try {
        const user = await checkLogin(el('u') ? el('u').value : '', el('p') ? el('p').value : '');
        if (!user){
          const g = recordLoginFailure();
          const lockNote = g.until > Date.now() ? ` Tạm khóa ${Math.ceil((g.until - Date.now()) / 1000)} giây.` : '';
          if (el('loginErr')) el('loginErr').innerHTML = `<div class="err">Tên đăng nhập hoặc mật khẩu không đúng.${esc(lockNote)}</div>`;
          return;
        }
        clearLoginFailures();
        await startApp(user);
        log('LOGIN', 'session', user.username, {}).catch(() => {});
      } catch (err){
        recordDiagError('login', err);
        if (el('loginErr')) el('loginErr').innerHTML = `<div class="err">${esc(friendlyError(err))}</div>`;
      } finally {
        if (btn){ btn.disabled = false; btn.textContent = 'Đăng nhập'; }
      }
    });
  }
}

// Khởi động ứng dụng (chỉ tự chạy khi có môi trường DOM thật, không chạy khi nạp trong Node test)
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__SOCHUNG_NO_AUTOBOOT__){
  (async () => {
    const ok = await Store.init();
    if (!ok){
      showBootErrorScreen(Store.bootError && Store.bootError.message);
      return;
    }
    if (!Store.db) Data.reload();
    const s = readSession();
    if (s){
      try {
        const user = await getUserDoc(s.u);
        if (user && isSessionValidForUser(s, user)){
          await startApp(user);
        } else {
          localStorage.removeItem(SESS);
        }
      } catch (e){
        recordDiagError('bootSession', e);
      }
    }
  })();
}

/* =========================================================================
   MỤC 4 & V4 [K6] — pressFX hợp nhất với bộ lập lịch scheduleRender
   ========================================================================= */
if (typeof document !== 'undefined'){
  (function pressFX(){
    const SEL = '.btn,.chip,.chat-btn,.chat-fab,.chat-thread,.nav a,.mobile-nav a,.mnav-btn,.x,.chat-back,tr.row';
    const HOLD = 220;
    let cur = null, timer = 0;

    function flush(){
      _pressHoldBusy = false;
      if (_pressPending){
        _pressPending = false;
        renderNow({ bypassPress:true });
      }
    }
    function down(node){
      if (cur) cur.classList.remove('is-press');
      cur = node;
      _pressHoldBusy = true;
      clearTimeout(timer);
      node.classList.add('is-press');
    }
    function up(){
      if (!cur && !_pressHoldBusy) return;
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

    ['pointerup','pointercancel'].forEach(ev => document.addEventListener(ev, up, true));
    window.addEventListener('scroll', () => { if (cur) up(); }, true);
    window.addEventListener('blur', up);
  })();
}

// Xuất móc kiểm thử cho selftest.js (chỉ dùng khi kiểm thử)
if (typeof globalThis !== 'undefined'){
  globalThis.__SOCHUNG_V4__ = {
    APP_VERSION, MAX_AMOUNT, MIN_PW_LEN, CATEGORIES, ROLES,
    V, Norm, Pair, Store, Data, Idx, ACTIONS, A,
    vnd, shortVnd, localISODate, localMonthKey, monthKeyOf, initial, esc,
    split, owedOf, remainOf, statusOf, parseAmount,
    computeGroupShares, assertShares, planSettle, netBalance, balanceText, myStats, netSeries,
    applyCollection, rebuildIdx, parseHash, once,
    setTestContext(ctx){
      if ('me' in ctx) me = ctx.me;
      if ('peer' in ctx) peer = ctx.peer;
      if ('route' in ctx) route = ctx.route;
    },
    getTestContext(){ return { me, peer, route }; },
    handlers: {
      payTxn, markPaid, confirmSettlement, rejectSettlement, submitTxn, doDelete,
      markGroupPaid, confirmGroupPaid, rejectGroupPaid, toggleGroupParticipant,
      respondFriend, sendFriendRequest, cancelFriendRequest, saveUserCred, changePw
    }
  };
}
/* ===== /V4 ===== */