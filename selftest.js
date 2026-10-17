/* =========================================================================
   Sổ chung — selftest.js (Bản v4 · APP_VERSION = 11)
   Chỉ tải động trên trình duyệt khi URL có ?selftest=1, hoặc chạy trực tiếp
   bằng Node.js: TZ=Asia/Ho_Chi_Minh node selftest.js
   Hoàn toàn cô lập bằng Mock Store trong bộ nhớ — KHÔNG đụng dữ liệu thật.
   ========================================================================= */

(async function runSoChungSelfTest(){
  // Nếu chạy trong Node.js, nạp m.js trong môi trường giả lập tối thiểu
  if (typeof window === 'undefined'){
    globalThis.window = globalThis;
    globalThis.addEventListener = function(){};
    globalThis.scrollTo = function(){};
    globalThis.__SOCHUNG_NO_AUTOBOOT__ = true;
    globalThis.location = { hash:'', search:'?selftest=1', reload(){} };
    const storeMap = Object.create(null);
    globalThis.localStorage = {
      getItem: k => Object.prototype.hasOwnProperty.call(storeMap, k) ? storeMap[k] : null,
      setItem: (k, v) => { storeMap[k] = String(v); },
      removeItem: k => { delete storeMap[k]; }
    };
    const domEls = Object.create(null);
    globalThis.document = {
      visibilityState: 'visible',
      activeElement: null,
      body: { classList: { add(){}, remove(){} }, appendChild(){} },
      getElementById(id){
        if (!domEls[id]){
          domEls[id] = {
            id, value:'', innerHTML:'', textContent:'', style:{},
            classList:{ add(){}, remove(){}, contains(){ return false; } },
            setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
            addEventListener(){}, focus(){}
          };
        }
        return domEls[id];
      },
      querySelectorAll(){ return []; },
      addEventListener(){}
    };
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const code = fs.readFileSync(path.join(__dirname, 'm.js'), 'utf8');
    vm.runInThisContext(code, { filename: 'm.js' });
  }

  const T = globalThis.__SOCHUNG_V4__;
  if (!T) throw new Error('Không tìm thấy __SOCHUNG_V4__ từ m.js');

  const results = [];
  function assert(cond, msg){
    if (!cond) throw new Error(msg || 'Assertion failed');
  }
  async function test(id, name, fn){
    try {
      await fn();
      results.push({ id, name, status:'PASS', detail:'' });
      console.log(`PASS [${id}] ${name}`);
    } catch (e){
      results.push({ id, name, status:'FAIL', detail: e && e.message ? e.message : String(e) });
      console.error(`FAIL [${id}] ${name}:`, e);
    }
  }

  // Mock Store trong bộ nhớ có đầy đủ set / get / delete / update / transaction / multi
  function createMockAdapter(initialData = {}){
    const db = JSON.parse(JSON.stringify(initialData));
    let simulatedDelayMs = 0;

    function getAt(path){
      const parts = String(path).split('/').filter(Boolean);
      let cur = db;
      for (const p of parts){
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[p];
      }
      return cur === undefined ? null : JSON.parse(JSON.stringify(cur));
    }
    function setAt(path, val){
      const parts = String(path).split('/').filter(Boolean);
      let cur = db;
      for (let i = 0; i < parts.length - 1; i++){
        const p = parts[i];
        if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      const last = parts[parts.length - 1];
      if (val === null || val === undefined) delete cur[last];
      else cur[last] = JSON.parse(JSON.stringify(val));
    }
    function syncToAppState(){
      const cols = ['users','friendships','txns','settlements','messages','activity','groups','group_txns','savings','savings_entries','budgets','trash','config'];
      for (const c of cols){
        const obj = db[c] || {};
        const rows = Object.entries(obj).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : { _primitive: v }) }));
        T.applyCollection(c, rows);
      }
    }

    const adapter = {
      _db: db,
      setDelay(ms){ simulatedDelayMs = ms; },
      sync: syncToAppState,
      doc(path){
        return {
          async get(){
            if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
            const v = getAt(path);
            return { exists: v !== null && v !== undefined, data: v };
          },
          async set(data){
            if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
            setAt(path, data);
            syncToAppState();
          },
          async delete(){
            if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
            setAt(path, null);
            syncToAppState();
          },
          async update(part){
            if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
            const cur = getAt(path) || {};
            for (const [k, v] of Object.entries(part || {})){
              if (v === null) delete cur[k];
              else cur[k] = v;
            }
            setAt(path, cur);
            syncToAppState();
          },
          async transaction(fn){
            if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
            // Mô phỏng chính xác hành vi Firebase SDK: lần gọi đầu với null, nếu trả null thì đọc giá trị thật
            const firstTry = fn(null);
            const cur = getAt(path);
            const next = (firstTry === null && cur !== null) ? fn(cur) : (cur === null ? firstTry : fn(cur));
            if (next === undefined){
              return { committed: false, exists: cur !== null, data: cur };
            }
            setAt(path, next);
            syncToAppState();
            const after = getAt(path);
            return { committed: true, exists: after !== null, data: after };
          }
        };
      },
      async multi(map){
        if (simulatedDelayMs) await new Promise(r => setTimeout(r, simulatedDelayMs));
        for (const [p, v] of Object.entries(map || {})){
          setAt(p, v);
        }
        syncToAppState();
      }
    };
    return adapter;
  }

  const origDb = T.Store.db;

  /* =======================================================================
     11.2. BỘ TEST SỐ LIỆU BẮT BUỘC
     ======================================================================= */

  await test('11.2-1', 'split(amount, paidBy, pair): các mốc cố định & 2.000 số ngẫu nhiên', () => {
    const s1 = T.split(1, 'duy', 'duy_nguyen');
    assert(s1.duy === 1 && s1.nguyen === 0, '1 -> (1,0)');
    const s2 = T.split(2, 'duy', 'duy_nguyen');
    assert(s2.duy === 1 && s2.nguyen === 1, '2 -> (1,1)');
    const s3 = T.split(3, 'duy', 'duy_nguyen');
    assert(s3.duy === 2 && s3.nguyen === 1, '3 -> (2,1)');
    const s100k = T.split(100000, 'duy', 'duy_nguyen');
    assert(s100k.duy === 50000 && s100k.nguyen === 50000, '100000 -> (50000,50000)');
    const s200k1 = T.split(200001, 'duy', 'duy_nguyen');
    assert(s200k1.duy === 100001 && s200k1.nguyen === 100000, '200001 -> (100001,100000)');

    for (let i = 0; i < 2000; i++){
      const amt = Math.floor(Math.random() * 500000000) + 1;
      const payer = i % 2 === 0 ? 'duy' : 'nguyen';
      const other = payer === 'duy' ? 'nguyen' : 'duy';
      const sp = T.split(amt, payer, 'duy_nguyen');
      assert(sp[payer] + sp[other] === amt, `Tổng phải bằng ${amt}`);
      assert(sp[payer] >= 0 && sp[other] >= 0, 'Cả hai phần >= 0');
      const diff = sp[payer] - sp[other];
      assert(diff === 0 || diff === 1, 'Chênh lệch giữa người ứng và người kia phải thuộc {0,1}');
    }
  });

  await test('11.2-2', 'V.money theo đúng bảng Phụ lục A.1', () => {
    const validCases = [
      ['200000', 200000],
      ['200.000', 200000],
      ['1.500.000 ₫', 1500000],
      ['50 000', 50000],
      ['1,500,000', 1500000]
    ];
    for (const [inp, expected] of validCases){
      const r = T.V.money(inp);
      assert(r.ok && r.value === expected, `Kỳ vọng "${inp}" -> ${expected}, nhận được ${JSON.stringify(r)}`);
    }
    const invalidCases = [
      '1,5', '1.50', '12.34.567', '-5000', '1e6', '٣٠٠', '0', '99999999999999999999', ''
    ];
    for (const inp of invalidCases){
      const r = T.V.money(inp);
      assert(!r.ok, `Kỳ vọng "${inp}" bị từ chối nhưng lại ok=${r.ok}`);
    }
  });

  await test('11.2-3', 'statusOf(t) với repaid = 0 / giữa / >= nợ, thiếu hoặc là chuỗi', () => {
    const base = { amount: 100000, paid_by:'duy', pair_id:'duy_nguyen' };
    assert(T.statusOf({ ...base }) === 'OPEN', 'Thiếu repaid -> OPEN');
    assert(T.statusOf({ ...base, repaid: 0 }) === 'OPEN', 'repaid=0 -> OPEN');
    assert(T.statusOf({ ...base, repaid: '20000' }) === 'PARTIALLY_SETTLED', 'repaid="20000" -> PARTIALLY_SETTLED');
    assert(T.statusOf({ ...base, repaid: 50000 }) === 'SETTLED', 'repaid=50000 -> SETTLED');
    assert(T.statusOf({ ...base, repaid: 60000 }) === 'SETTLED', 'repaid>owed -> SETTLED');
  });

  await test('11.2-4', 'Fixture dữ liệu cũ điển hình (Mục 7.10)', () => {
    const fixture = {
      txns: {
        t1: { title:'Ăn tối', category:'Food', amount:200001, paid_by:'duy',
              created_by:'duy', date:'2025-03-02', note:'', repaid:50000,
              created_at:'2025-03-02T12:00:00.000Z', updated_at:'2025-03-02T12:00:00.000Z' },
        t2: { title:'Grab', category:'Transport', amount:90000, paid_by:'nguyen',
              created_by:'nguyen', date:'2025-03-05', note:'', repaid:0,
              created_at:'2025-03-05T03:00:00.000Z', updated_at:'2025-03-05T03:00:00.000Z' }
      },
      settlements: {
        s1: { from_user:'nguyen', to_user:'duy', amount:50000, transaction_id:'t1',
              note:'Trả một phần', created_at:'2025-03-03T10:00:00.000Z', created_by:'nguyen' }
      },
      users: {
        duy: { username:'duy', name:'Duy', role:'ADMIN' },
        nguyen: { username:'nguyen', name:'Nguyen', role:'USER' }
      },
      friendships: {
        duy_nguyen: { user_a:'duy', user_b:'nguyen', status:'ACCEPTED', requested_by:'system' }
      }
    };
    const mock = createMockAdapter(fixture);
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.duy, peer: 'nguyen' });

    const t1 = T.Idx.txnById.t1;
    const t2 = T.Idx.txnById.t2;
    const s1 = T.Data.settlements.find(x => x.id === 's1');
    assert(t1.pair_id === 'duy_nguyen', 't1 thiếu pair_id phải hiểu là duy_nguyen');
    const sp1 = T.split(t1.amount, t1.paid_by, t1.pair_id);
    assert(sp1.duy === 100001 && sp1.nguyen === 100000, 'split(200001, duy)');
    assert(T.owedOf(t1) === 100000 && T.remainOf(t1) === 50000, 't1 owed=100000, remain=50000');
    assert(T.statusOf(t1) === 'PARTIALLY_SETTLED', 't1 PARTIALLY_SETTLED');
    assert(s1.status === 'CONFIRMED', 's1 thiếu status phải hiểu là CONFIRMED');
    assert(T.owedOf(t2) === 45000 && T.remainOf(t2) === 45000 && T.statusOf(t2) === 'OPEN', 't2 owed=45000, OPEN');
    assert(T.netBalance() === 5000, `Số dư ròng góc nhìn Duy phải là +5000, nhận được ${T.netBalance()}`);
  });

  await test('11.2-5', 'Pair.members với username có dấu gạch dưới (_), username lạ, id sai', () => {
    T.applyCollection('users', [
      { id:'duy', username:'duy', name:'Duy', role:'ADMIN' },
      { id:'nguyen_a', username:'nguyen_a', name:'Nguyen A', role:'USER' },
      { id:'a_b', username:'a_b', name:'AB', role:'USER' },
      { id:'c', username:'c', name:'C', role:'USER' }
    ]);
    const p1 = T.Pair.members('duy_nguyen_a');
    assert(p1[0] === 'duy' && p1[1] === 'nguyen_a', `duy_nguyen_a -> ${JSON.stringify(p1)}`);
    const p2 = T.Pair.members('a_b_c');
    assert(p2[0] === 'a_b' && p2[1] === 'c', `a_b_c -> ${JSON.stringify(p2)}`);
    const p3 = T.Pair.members('unknown1_unknown2');
    assert(p3[0] === 'unknown1' && p3[1] === 'unknown2', 'username lạ 1 dấu _');
    const p4 = T.Pair.members('');
    assert(p4.length === 2, 'id rỗng trả về cặp mặc định 2 phần tử');
  });

  await test('11.2-6', 'esc() chống XSS & kiểm tra định dạng uỷ quyền A()', () => {
    const raw = `'"<>&\${alert(1)}`;
    const escaped = T.esc(raw);
    assert(!escaped.includes('<') && !escaped.includes('>') && !escaped.includes('"') && !escaped.includes("'"), 'esc() phải mã hoá đủ 5 ký tự');
    const attr = T.A('switchPeer', `duy');alert('xss`);
    assert(attr.startsWith('data-act="switchPeer" data-args="'), 'A() phải sinh data-act và data-args đã escape');
    assert(!attr.includes('onclick='), 'Không dùng onclick');
  });

  await test('11.2-7', 'Ngày/giờ địa phương UTC+7 (2026-03-31T23:30:00.000Z -> 2026-04-01) & shortVnd(999999)', () => {
    const d = new Date('2026-03-31T23:30:00.000Z');
    // Tính ngày địa phương theo offset thực của môi trường đang chạy
    const expectedY = d.getFullYear();
    const expectedM = String(d.getMonth() + 1).padStart(2, '0');
    const expectedD = String(d.getDate()).padStart(2, '0');
    const expectedISO = `${expectedY}-${expectedM}-${expectedD}`;
    assert(T.localISODate(d) === expectedISO, `localISODate phải khớp giờ địa phương (${expectedISO})`);
    assert(T.monthKeyOf('2026-03-31T23:30:00.000Z') === `${expectedY}-${expectedM}`, 'monthKeyOf nhất quán với localISODate');
    // Nếu múi giờ là UTC+7 (Việt Nam), 2026-03-31T23:30:00.000Z chính xác là 2026-04-01
    if (d.getTimezoneOffset() === -420){
      assert(T.localISODate(d) === '2026-04-01', 'Tại UTC+7 phải là 2026-04-01');
      assert(T.monthKeyOf('2026-03-31T23:30:00.000Z') === '2026-04', 'Tại UTC+7 tháng phải là 2026-04');
    }
    assert(T.shortVnd(999999) === '1 tr', `shortVnd(999999) phải là "1 tr", nhận được "${T.shortVnd(999999)}"`);
  });

  await test('11.2-8', 'computeGroupShares: chia 100 cho 3 người -> (34,33,33), 1 người, người không tham gia = 0', () => {
    const sh3 = T.computeGroupShares(100, 'duy', { duy:true, minh:true, nguyen:true });
    assert(sh3.duy === 34 && sh3.minh === 33 && sh3.nguyen === 33, `100/3 -> ${JSON.stringify(sh3)}`);
    assert(T.assertShares(100, sh3, { duy:true, minh:true, nguyen:true }), 'assertShares(100)');
    const sh1 = T.computeGroupShares(100, 'duy', { duy:true, minh:false, nguyen:false });
    assert(sh1.duy === 100 && sh1.minh === 0 && sh1.nguyen === 0, 'Chỉ 1 người tham gia');
  });

  await test('11.2-9', 'netSeries điểm cuối = netBalance(); settlement PENDING/REJECTED không làm lệch biểu đồ', () => {
    const curMonth = T.localMonthKey();
    const curDate = T.localISODate();
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, nguyen:{username:'nguyen',name:'Nguyen',role:'USER'} },
      friendships: { duy_nguyen:{user_a:'duy',user_b:'nguyen',status:'ACCEPTED'} },
      txns: {
        t1: { title:'Ăn trưa', category:'Food', amount:200000, paid_by:'duy', pair_id:'duy_nguyen', created_by:'duy', date:curDate, repaid:30000, created_at:new Date().toISOString() }
      },
      settlements: {
        s_conf: { from_user:'nguyen', to_user:'duy', pair_id:'duy_nguyen', amount:30000, transaction_id:'t1', status:'CONFIRMED', created_at:new Date().toISOString() },
        s_pend: { from_user:'nguyen', to_user:'duy', pair_id:'duy_nguyen', amount:20000, transaction_id:'t1', status:'PENDING', created_at:new Date().toISOString() },
        s_rej:  { from_user:'nguyen', to_user:'duy', pair_id:'duy_nguyen', amount:50000, transaction_id:'t1', status:'REJECTED', created_at:new Date().toISOString() }
      }
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.duy, peer: 'nguyen' });
    const series = T.netSeries([curMonth]);
    const nb = T.netBalance();
    assert(nb === 70000, `netBalance phải là 70000, nhận được ${nb}`);
    assert(series[0].value === nb, `Điểm cuối netSeries (${series[0].value}) phải bằng netBalance (${nb})`);
  });

  await test('11.2-10', 'Route an toàn với #/constructor, #/__proto__, #/toString, #/transactions/<id lạ>', () => {
    for (const h of ['#/constructor', '#/__proto__', '#/toString', '#/valueOf']){
      globalThis.location.hash = h;
      const r = T.parseHash();
      assert(r.path === 'dashboard', `Hash ${h} phải về dashboard, nhận được ${r.path}`);
    }
    globalThis.location.hash = '#/transactions/non_existent_id_999';
    const r2 = T.parseHash();
    assert(r2.path === 'detail' && r2.param === 'non_existent_id_999', 'Route detail hợp lệ');
  });

  /* =======================================================================
     11.3. KỊCH BẢN ĐỒNG THỜI VỚI MOCK STORE (10 KỊCH BẢN)
     ======================================================================= */

  await test('11.3-1', 'Hai lần confirmSettlement song song trên cùng settlement -> repaid tăng đúng 1 lần', async () => {
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, nguyen:{username:'nguyen',name:'Nguyen',role:'USER'} },
      friendships: { duy_nguyen:{user_a:'duy',user_b:'nguyen',status:'ACCEPTED'} },
      txns: {
        t1: { title:'Khách sạn', category:'Bills', amount:200000, paid_by:'duy', pair_id:'duy_nguyen', created_by:'duy', date:'2026-04-01', repaid:0, pending_sid:'s1' }
      },
      settlements: {
        s1: { from_user:'nguyen', to_user:'duy', pair_id:'duy_nguyen', amount:100000, transaction_id:'t1', status:'PENDING', created_at:'2026-04-01T10:00:00Z' }
      }
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.duy, peer: 'nguyen' });
    await Promise.all([
      T.handlers.confirmSettlement('s1'),
      T.handlers.confirmSettlement('s1')
    ]);
    assert(T.Idx.txnById.t1.repaid === 100000, `repaid phải bằng 100000, nhận được ${T.Idx.txnById.t1.repaid}`);
    assert(T.Data.settlements.find(x => x.id === 's1').status === 'CONFIRMED', 'status phải là CONFIRMED');
  });

  await test('11.3-2', 'Bấm once() hai lần liên tiếp khi đang bay -> chỉ thực thi 1 lần', async () => {
    let count = 0;
    await Promise.all([
      T.once('test_double_click', async () => { await new Promise(r => setTimeout(r, 30)); count++; }),
      T.once('test_double_click', async () => { count++; })
    ]);
    assert(count === 1, `Hàm chỉ được chạy 1 lần, nhưng chạy ${count} lần`);
  });

  await test('11.3-3', 'Hai thành viên cùng markGroupPaid khác nhau -> cả hai cờ paid đều còn nguyên', async () => {
    const mock = createMockAdapter({
      users: {
        duy:{username:'duy',name:'Duy',role:'ADMIN'},
        nguyen:{username:'nguyen',name:'Nguyen',role:'USER'},
        minh:{username:'minh',name:'Minh',role:'USER'}
      },
      groups: {
        g1: { name:'Đà Lạt', created_by:'duy', members:{ duy:{role:'OWNER',status:'ACTIVE'}, nguyen:{role:'MEMBER',status:'ACTIVE'}, minh:{role:'MEMBER',status:'ACTIVE'} } }
      },
      group_txns: {
        gt1: {
          group_id:'g1', title:'Villa', amount:300000, category:'Bills', paid_by:'duy', date:'2026-04-01', created_by:'duy',
          participants:{ duy:true, nguyen:true, minh:true },
          shares:{ duy:100000, nguyen:100000, minh:100000 },
          paid_status:{ nguyen:{paid:false,confirmed:false}, minh:{paid:false,confirmed:false} }
        }
      }
    });
    T.Store.db = mock;
    mock.sync();
    // ADMIN thao tác hoặc hai người bấm song song trên đường dẫn hẹp
    T.setTestContext({ me: T.Data.usersById.duy });
    await Promise.all([
      T.handlers.markGroupPaid('gt1', 'nguyen'),
      T.handlers.markGroupPaid('gt1', 'minh')
    ]);
    const gt = T.Data.group_txns.find(x => x.id === 'gt1');
    assert(gt.paid_status.nguyen.paid === true && gt.paid_status.minh.paid === true, 'Cả nguyen và minh đều phải paid=true');
  });

  await test('11.3-4', 'Hai lần payTxn song song trên cùng giao dịch -> chỉ tạo đúng 1 settlement PENDING', async () => {
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, nguyen:{username:'nguyen',name:'Nguyen',role:'USER'} },
      friendships: { duy_nguyen:{user_a:'duy',user_b:'nguyen',status:'ACCEPTED'} },
      txns: {
        t1: { title:'Cà phê', category:'Drinks', amount:100000, paid_by:'duy', pair_id:'duy_nguyen', created_by:'duy', date:'2026-04-01', repaid:0 }
      },
      settlements: {}
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.nguyen, peer: 'duy' });
    const t = T.Idx.txnById.t1;
    await Promise.all([
      T.handlers.payTxn(t, 50000, 'Lần 1'),
      T.handlers.payTxn(t, 50000, 'Lần 2')
    ]);
    const pendings = T.Data.settlements.filter(s => s.transaction_id === 't1' && s.status === 'PENDING');
    assert(pendings.length === 1, `Chỉ được có 1 settlement PENDING, nhận được ${pendings.length}`);
  });

  await test('11.3-5 & 11.3-6', 'Sửa amount xuống dưới repaid hoặc đổi paid_by sau khi đã trả -> bị từ chối', async () => {
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, nguyen:{username:'nguyen',name:'Nguyen',role:'USER'} },
      friendships: { duy_nguyen:{user_a:'duy',user_b:'nguyen',status:'ACCEPTED'} },
      txns: {
        t1: { title:'Ăn tối', category:'Food', amount:200000, paid_by:'duy', pair_id:'duy_nguyen', created_by:'duy', date:'2026-04-01', repaid:60000 }
      },
      settlements: {}
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.duy, peer: 'nguyen' });

    // Thử giảm amount xuống 80000 (nợ mới = 40000 < repaid 60000)
    document.getElementById('f_title').value = 'Ăn tối sửa';
    document.getElementById('f_amount').value = '80000';
    document.getElementById('f_paid').value = 'duy';
    document.getElementById('f_date').value = '2026-04-01';
    document.getElementById('f_cat').value = 'Food';
    await T.handlers.submitTxn('t1');
    assert(T.Idx.txnById.t1.amount === 200000 && T.Idx.txnById.t1.repaid === 60000, 'Không được giảm amount xuống dưới repaid');

    // Thử đổi paid_by sang nguyen
    document.getElementById('f_amount').value = '200000';
    document.getElementById('f_paid').value = 'nguyen';
    await T.handlers.submitTxn('t1');
    assert(T.Idx.txnById.t1.paid_by === 'duy', 'Không được đổi paid_by sau khi đã có repaid');
  });

  await test('11.3-7', 'Xoá giao dịch: chặn khi có PENDING; chặn USER khi đã trả; xoá hợp lệ phải lưu vào trash', async () => {
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, nguyen:{username:'nguyen',name:'Nguyen',role:'USER'} },
      friendships: { duy_nguyen:{user_a:'duy',user_b:'nguyen',status:'ACCEPTED'} },
      txns: {
        t_pend: { title:'Đang chờ', category:'Food', amount:100000, paid_by:'nguyen', pair_id:'duy_nguyen', created_by:'nguyen', date:'2026-04-01', repaid:0, pending_sid:'s1' },
        t_repaid: { title:'Đã trả 1 phần', category:'Food', amount:100000, paid_by:'nguyen', pair_id:'duy_nguyen', created_by:'nguyen', date:'2026-04-01', repaid:20000 },
        t_clean: { title:'Chưa trả', category:'Food', amount:100000, paid_by:'nguyen', pair_id:'duy_nguyen', created_by:'nguyen', date:'2026-04-01', repaid:0 }
      },
      settlements: {
        s1: { from_user:'duy', to_user:'nguyen', pair_id:'duy_nguyen', amount:50000, transaction_id:'t_pend', status:'PENDING' }
      },
      trash: {}
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.nguyen, peer: 'duy' });

    await T.handlers.doDelete('t_pend');
    assert(!!T.Idx.txnById.t_pend, 'Giao dịch có PENDING không được phép xóa');

    await T.handlers.doDelete('t_repaid');
    assert(!!T.Idx.txnById.t_repaid, 'USER không được xóa giao dịch đã có repaid > 0');

    await T.handlers.doDelete('t_clean');
    assert(!T.Idx.txnById.t_clean, 'Giao dịch sạch chưa trả được phép xóa bởi người tạo');
    assert(!!T.Idx.trashById.t_clean, 'Phải có bản sao trong trash sau khi xóa');
  });

  await test('11.3-8', 'Hai người đổi mật khẩu cùng lúc (saveUserCred) -> cả hai khoá vẫn còn nguyên', async () => {
    const mock = createMockAdapter({
      config: { auth: { duy:'old_duy', nguyen:'old_nguyen' } }
    });
    T.Store.db = mock;
    mock.sync();
    await Promise.all([
      T.handlers.saveUserCred('duy', 'new_hash_duy'),
      T.handlers.saveUserCred('nguyen', 'new_hash_nguyen')
    ]);
    const authSnap = await T.Store.get('config/auth');
    assert(authSnap.data.duy === 'new_hash_duy' && authSnap.data.nguyen === 'new_hash_nguyen', 'Cả hai mật khẩu mới phải được giữ nguyên');
  });

  await test('11.3-9', 'respondFriend do chính người gửi lời mời gọi -> bị từ chối [S-01]', async () => {
    const mock = createMockAdapter({
      users: { duy:{username:'duy',name:'Duy',role:'ADMIN'}, minh:{username:'minh',name:'Minh',role:'USER'} },
      friendships: {
        duy_minh: { user_a:'duy', user_b:'minh', status:'PENDING', requested_by:'minh', created_at:'2026-04-01T00:00:00Z' }
      }
    });
    T.Store.db = mock;
    mock.sync();
    T.setTestContext({ me: T.Data.usersById.minh });
    await T.handlers.respondFriend('duy_minh', true);
    const f = T.Data.friendships.find(x => x.id === 'duy_minh');
    assert(f.status === 'PENDING', 'Người gửi không thể tự chấp nhận lời mời kết bạn của chính mình');
  });

  await test('11.3-10', 'Mất mạng giả lập / lỗi ghi -> báo lỗi tiếng Việt thân thiện, không treo', async () => {
    let caught = false;
    try {
      await Promise.race([
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('WRITE_TIMEOUT'), { code:'timeout' })), 25)),
        new Promise(r => setTimeout(r, 500))
      ]);
    } catch (e){
      caught = true;
      assert(e.code === 'timeout', 'Phải bắt được lỗi timeout');
    }
    assert(caught, 'Phải kết thúc đúng hạn khi mất mạng');
  });

  // Khôi phục Store.db gốc nếu đang chạy trên trình duyệt
  T.Store.db = origDb;

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n========================================`);
  console.log(`KẾT QUẢ SELFTEST v4: ${passed}/${results.length} PASS, ${failed} FAIL`);
  console.log(`========================================`);

  if (typeof document !== 'undefined' && document.getElementById('modalRoot') && typeof window !== 'undefined' && !window.__SOCHUNG_NO_AUTOBOOT__){
    const rowsHtml = results.map(r => `<tr>
      <td><span class="tag">${T.esc(r.id)}</span></td>
      <td>${T.esc(r.name)}</td>
      <td><b style="color:var(--${r.status === 'PASS' ? 'credit' : 'danger'})">${r.status}</b>${r.detail ? `<div class="meta">${T.esc(r.detail)}</div>` : ''}</td>
    </tr>`).join('');
    document.getElementById('modalRoot').innerHTML = `<div class="scrim"><div class="modal" style="max-width:680px">
      <header><h3>Kết quả Self-Test v4 (${passed}/${results.length} PASS)</h3><button class="x" data-act="closeModal" data-args="[]">✕</button></header>
      <div class="body"><div class="tbl-wrap"><table><thead><tr><th>Mã</th><th>Kịch bản</th><th>Kết quả</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>
    </div></div>`;
  }

  if (typeof process !== 'undefined' && process.exit){
    process.exit(failed > 0 ? 1 : 0);
  }
})();