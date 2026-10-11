// 링크몰 (의존성 없음, Node 18+)
// 실행: node server.js  →  http://localhost:3000
// 저장소: SUPABASE_URL + SUPABASE_KEY 가 있으면 Supabase, 없으면 db.json 파일
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// ---------- 저장소 ----------
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_KEY || '').trim();
const useSB = !!(SB_URL && SB_KEY);
const enc = encodeURIComponent;

const sbHeaders = (extra) => {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json', ...extra };
  if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY; // 예전 방식(JWT) 키일 때만
  return h;
};
async function sbGet(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`supabase GET ${table} ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`supabase INSERT ${table} ${r.status} ${await r.text()}`);
}

async function sbPatch(table, query, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`supabase PATCH ${table} ${r.status} ${await r.text()}`);
}
async function sbDelete(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) throw new Error(`supabase DELETE ${table} ${r.status} ${await r.text()}`);
}

const sbStore = {
  async createShop(s) { await sbInsert('shops', s); },
  // 공지: shop 이 비어 있으면 운영자 공지(모든 화면), 있으면 그 상점 공지. 맨 위 고정 → 최신 순
  async listNotices(shop) { return sbGet('notices', `${shop ? `shop=eq.${enc(shop)}` : 'shop=is.null'}&select=*&order=pinned.desc,created.desc&limit=50`); },
  async createNotice(n) { await sbInsert('notices', n); },
  async noticeById(id) { return (await sbGet('notices', `id=eq.${enc(id)}&select=*`))[0]; },
  async deleteNotice(id) { await sbDelete('notices', `id=eq.${enc(id)}`); },
  // 문의: shop 이 비어 있으면 운영자에게 보낸 문의
  async createInquiry(q) { await sbInsert('inquiries', q); },
  async inquiryById(id) { return (await sbGet('inquiries', `id=eq.${enc(id)}&select=*`))[0]; },
  async updateInquiry(id, f) { await sbPatch('inquiries', `id=eq.${enc(id)}`, f); },
  async deleteInquiry(id) { await sbDelete('inquiries', `id=eq.${enc(id)}`); },
  async listInquiries(shop) { return sbGet('inquiries', `${shop ? `shop=eq.${enc(shop)}` : 'shop=is.null'}&select=*&order=created.desc&limit=200`); },
  async inquiriesByUser(uid, shop) { return sbGet('inquiries', `user_id=eq.${enc(uid)}&${shop ? `shop=eq.${enc(shop)}` : 'shop=is.null'}&select=*&order=created.desc&limit=50`); },
  async updateShop(id, f) { await sbPatch('shops', `id=eq.${enc(id)}`, f); },
  async shopsByOwner(uid) { return sbGet('shops', `owner=eq.${enc(uid)}&select=*&order=created.desc`); },
  async shopBySms(t) { return (await sbGet('shops', `sms_token=eq.${enc(t)}&select=*`))[0]; },
  async createUser(u) { await sbInsert('users', u); },
  async userByEmail(e) {
    const hit = (await sbGet('users', `email=eq.${enc(e)}&select=*`))[0];
    if (hit) return hit;
    // 예전 버전에서 대문자 그대로 저장된 이메일도 찾기 (_ % 는 와일드카드라 이스케이프, 결과는 소문자로 다시 비교)
    const pat = e.replace(/[\\%_]/g, (c) => '\\' + c);
    return (await sbGet('users', `email=ilike.${enc(pat)}&select=*&limit=5`)).find((u) => String(u.email).toLowerCase() === e);
  },
  async userById(id) { return (await sbGet('users', `id=eq.${enc(id)}&select=*`))[0]; },
  // 표시 이름 조회 (users.name 칸이 아직 없으면 이름 없이 돌려줌)
  async usersByIds(ids) {
    if (!ids.length) return [];
    try { return await sbGet('users', `id=in.(${ids.map(enc).join(',')})&select=id,name`); }
    catch (e) { console.error('이름 조회 실패 (users.name 칸이 있나요?)', e.message); return ids.map((id) => ({ id })); }
  },
  // 구매자가 기록되지 않은 예전 주문을 처음 연 회원에게 연결 (이미 구매자가 있으면 false)
  async claimOrder(t, uid) {
    const r = await fetch(`${SB_URL}/rest/v1/orders?token=eq.${enc(t)}&buyer=is.null`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ buyer: uid }) });
    if (!r.ok) throw new Error(`supabase claimOrder ${r.status} ${await r.text()}`);
    return (await r.json()).length > 0;
  },
  async createDeposit(d) { await sbInsert('deposits', d); },
  async depositByToken(t) { return (await sbGet('deposits', `token=eq.${enc(t)}&select=*`))[0]; },
  async waitingDeposits(shopId) { return sbGet('deposits', `shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc`); },
  async setDepositDone(t) { await sbPatch('deposits', `token=eq.${enc(t)}`, { status: 'done' }); },
  async shopById(id) { return (await sbGet('shops', `id=eq.${enc(id)}&select=*`))[0]; },
  async shopByKey(key) { return (await sbGet('shops', `key=eq.${enc(key)}&select=*`))[0]; },
  async createItem(i) { await sbInsert('items', i); },
  async itemById(id) { return (await sbGet('items', `id=eq.${enc(id)}&select=*`))[0]; },
  async updateItem(id, f) { await sbPatch('items', `id=eq.${enc(id)}`, f); },
  async deleteItem(id) { await sbDelete('items', `id=eq.${enc(id)}`); },
  async updateUser(id, f) { await sbPatch('users', `id=eq.${enc(id)}`, f); },
  async deleteUser(id) { // 회원 탈퇴: 이 회원의 포인트·칭호·대기 중 충전·상점 추가 신청을 지우고 계정 삭제 (주문·후기 기록은 번호만 남김)
    const e = enc(id);
    await sbDelete('shop_points', `user_id=eq.${e}`);
    await sbDelete('user_titles', `user_id=eq.${e}`);
    await sbDelete('charges', `user_id=eq.${e}&status=eq.waiting`);
    await sbDelete('shop_requests', `user_id=eq.${e}`);
    try { await sbDelete('inquiries', `user_id=eq.${e}`); } catch (x) { console.error('문의 삭제 실패 (inquiries 표가 있나요?)', x.message); }
    await sbDelete('users', `id=eq.${e}`);
  },
  async purgeShop(id) { // 상점 영구 삭제: 상점과 딸린 기록(아이템·주문·후기·입금·충전·포인트·칭호·내역)을 전부 지움. 자식 → 부모 순서
    const e = enc(id);
    const ids = (await sbStore.itemsByShop(id)).map((i) => i.id);
    for (let n = 0; n < ids.length; n += 50) await sbDelete('orders', `item=in.(${ids.slice(n, n + 50).map(enc).join(',')})`);
    for (const t of ['reviews', 'user_titles', 'titles', 'shop_points', 'charges', 'deposits', 'ledger', 'items']) await sbDelete(t, `shop=eq.${e}`);
    try { await sbDelete('notices', `shop=eq.${e}`); } catch (x) { console.error('공지 삭제 실패 (notices 표가 있나요?)', x.message); }
    try { await sbDelete('inquiries', `shop=eq.${e}`); } catch (x) { console.error('문의 삭제 실패 (inquiries 표가 있나요?)', x.message); }
    await sbDelete('shops', `id=eq.${e}`);
  },
  async userByCode(c) { const r = await sbGet('users', `id=like.${enc(c)}*&select=*&limit=2`); return r.length === 1 ? r[0] : null; },
  async listUsers(q) { return sbGet('users', `select=id,email,banned,created,extra_shops&order=created.desc&limit=100${q ? `&email=ilike.*${enc(q)}*` : ''}`); },
  async allShops() { return sbGet('shops', 'select=*&order=created.desc&limit=200'); },
  async searchShops(q, ownerIds) {
    const a = await sbGet('shops', `name=ilike.*${enc(q)}*&select=*&order=created.desc&limit=100`);
    const b = ownerIds.length ? await sbGet('shops', `owner=in.(${ownerIds.map(enc).join(',')})&select=*&order=created.desc&limit=100`) : [];
    const seen = new Set();
    return [...a, ...b].filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((x, y) => y.created - x.created);
  },
  // 포인트 증감: points가 읽은 값 그대로일 때만 갱신(동시 결제에도 잔액이 틀어지지 않음). 잔액 부족이면 null
  async addPoints(uid, delta) {
    for (let n = 0; n < 8; n++) {
      const u = await sbStore.userById(uid);
      if (!u) return null;
      const cur = Number(u.points || 0); const np = cur + delta;
      if (np < 0) return null;
      const r = await fetch(`${SB_URL}/rest/v1/users?id=eq.${enc(uid)}&points=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ points: np }) });
      if (!r.ok) throw new Error(`supabase addPoints ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return np;
    }
    return null;
  },
  async addEarned(shopId, delta) {
    for (let n = 0; n < 8; n++) {
      const sh = await sbStore.shopById(shopId);
      if (!sh) return null;
      const cur = Number(sh.earned || 0); const np = Math.max(0, cur + delta);
      const r = await fetch(`${SB_URL}/rest/v1/shops?id=eq.${enc(shopId)}&earned=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ earned: np }) });
      if (!r.ok) throw new Error(`supabase addEarned ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return np;
    }
    return null;
  },
  async shopPoints(uid, shopId) { const r = await sbGet('shop_points', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=points`); return r[0] ? Number(r[0].points) : 0; },
  // 상점별 포인트 증감(동시 결제에도 안전). 잔액 부족이면 null
  async addShopPoints(uid, shopId, delta) {
    for (let n = 0; n < 8; n++) {
      const r = await sbGet('shop_points', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=points`);
      if (!r[0]) {
        if (delta < 0) return null;
        try { await sbInsert('shop_points', { user_id: uid, shop: shopId, points: delta }); return delta; }
        catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; continue; }
      }
      const cur = Number(r[0].points); const np = cur + delta;
      if (np < 0) return null;
      const rr = await fetch(`${SB_URL}/rest/v1/shop_points?user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&points=eq.${cur}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ points: np }) });
      if (!rr.ok) throw new Error(`supabase addShopPoints ${rr.status} ${await rr.text()}`);
      if ((await rr.json()).length) return np;
    }
    return null;
  },
  async userShopPoints(uid) { return sbGet('shop_points', `user_id=eq.${enc(uid)}&select=shop,points&order=points.desc`); },
  async shopCharges(shopId) { return sbGet('charges', `shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc&limit=100`); },
  async userShopCharges(uid, shopId) { return sbGet('charges', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&status=eq.waiting&select=*&order=created.desc`); },
  async ledgerForUserShop(uid, shopId) { return sbGet('ledger', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=*&order=created.desc&limit=30`); },
  async createCharge(c) { await sbInsert('charges', c); },
  async reviewByToken(t) { return (await sbGet('reviews', `token=eq.${enc(t)}&select=*`))[0]; },
  async reviewById(id) { return (await sbGet('reviews', `id=eq.${enc(id)}&select=*`))[0]; },
  async createReview(r) { await sbInsert('reviews', r); },
  async updateReview(id, f) { await sbPatch('reviews', `id=eq.${enc(id)}`, f); },
  async deleteReview(id) { await sbDelete('reviews', `id=eq.${enc(id)}`); },
  async reviewsForItem(itemId) { return sbGet('reviews', `item=eq.${enc(itemId)}&select=*&order=created.desc&limit=100`); },
  async reviewsByShop(shopId) { return sbGet('reviews', `shop=eq.${enc(shopId)}&select=item,rating&limit=2000`); },
  async createLicense(r) { await sbInsert('licenses', r); },
  async listLicenses() { return sbGet('licenses', 'select=*&order=created.desc&limit=40'); },
  async deleteUnusedLicense(k) { await sbDelete('licenses', `key=eq.${enc(k)}&used_by=is.null`); },
  async claimLicense(k, uid) {
    const r = await fetch(`${SB_URL}/rest/v1/licenses?key=eq.${enc(k)}&used_by=is.null`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ used_by: uid, used_at: Date.now() }) });
    if (!r.ok) throw new Error(`supabase PATCH licenses ${r.status} ${await r.text()}`);
    return (await r.json())[0] || null;
  },
  async releaseLicense(k) { await sbPatch('licenses', `key=eq.${enc(k)}`, { used_by: null, used_at: null }); },
  async createShopRequest(r) { try { await sbInsert('shop_requests', r); } catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; } },
  async shopRequestByUser(uid) { return (await sbGet('shop_requests', `user_id=eq.${enc(uid)}&select=*`))[0]; },
  async deleteShopRequest(uid) { await sbDelete('shop_requests', `user_id=eq.${enc(uid)}`); },
  async listShopRequests() { return sbGet('shop_requests', 'select=*&order=created.asc&limit=100'); },
  async chargeByToken(t) { return (await sbGet('charges', `token=eq.${enc(t)}&select=*`))[0]; },
  async waitingCharges() { return sbGet('charges', 'status=eq.waiting&select=*&order=created.desc&limit=200'); },
  async userCharges(uid) { return sbGet('charges', `user_id=eq.${enc(uid)}&status=eq.waiting&select=*&order=created.desc`); },
  async claimCharge(t, to = 'done') {
    const r = await fetch(`${SB_URL}/rest/v1/charges?token=eq.${enc(t)}&status=eq.waiting`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: to }) });
    if (!r.ok) throw new Error(`supabase claimCharge ${r.status} ${await r.text()}`);
    return (await r.json()).length > 0;
  },
  async addLedger(l) { await sbInsert('ledger', l); },
  async ledgerForUser(uid) { return sbGet('ledger', `user_id=eq.${enc(uid)}&select=*&order=created.desc&limit=30`); },
  async createTitle(t) { await sbInsert('titles', t); },
  async titlesByShop(shopId) { return sbGet('titles', `shop=eq.${enc(shopId)}&select=*&order=created.asc`); },
  async titleById(id) { return (await sbGet('titles', `id=eq.${enc(id)}&select=*`))[0]; },
  async updateTitle(id, f) { await sbPatch('titles', `id=eq.${enc(id)}`, f); },
  async deleteTitle(id) { await sbDelete('user_titles', `title=eq.${enc(id)}`); await sbDelete('titles', `id=eq.${enc(id)}`); },
  async grantTitle(uid, tid, shopId) { try { await sbInsert('user_titles', { user_id: uid, title: tid, shop: shopId, created: Date.now() }); } catch (e) { if (!/23505|409|duplicate/i.test(e.message)) throw e; } },
  async revokeTitle(uid, tid) { await sbDelete('user_titles', `user_id=eq.${enc(uid)}&title=eq.${enc(tid)}`); },
  async titleHolders(tid) { return sbGet('user_titles', `title=eq.${enc(tid)}&select=user_id&limit=50`); },
  async titleHoldersMany(tids) { return tids.length ? sbGet('user_titles', `title=in.(${tids.map(enc).join(',')})&select=user_id,title&order=created.asc&limit=1000`) : []; },
  async userTitles(uid) {
    const g = await sbGet('user_titles', `user_id=eq.${enc(uid)}&select=title`);
    if (!g.length) return [];
    return sbGet('titles', `id=in.(${g.map((x) => enc(x.title)).join(',')})&select=*`);
  },
  // 재고 한 줄 꺼내기: stock_ver가 그대로일 때만 갱신(동시에 두 명이 같은 줄을 가져가는 걸 막음)
  async popStock(itemId) {
    for (let n = 0; n < 8; n++) {
      const it = await sbStore.itemById(itemId);
      if (!it || it.stock == null) return null;
      const lines = stockLines(it.stock);
      if (!lines.length) return null;
      const ver = it.stock_ver || 0;
      const r = await fetch(`${SB_URL}/rest/v1/items?id=eq.${enc(itemId)}&stock_ver=eq.${ver}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ stock: lines.slice(1).join('\n'), stock_ver: ver + 1 }) });
      if (!r.ok) throw new Error(`supabase popStock ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return lines[0];
    }
    return null;
  },
  // 재고 n줄을 한 번에 꺼내기 (모자라면 아무것도 안 꺼내고 null)
  async popStockN(itemId, n) {
    for (let t = 0; t < 8; t++) {
      const it = await sbStore.itemById(itemId);
      if (!it || it.stock == null) return null;
      const lines = stockLines(it.stock);
      if (lines.length < n) return null;
      const ver = it.stock_ver || 0;
      const r = await fetch(`${SB_URL}/rest/v1/items?id=eq.${enc(itemId)}&stock_ver=eq.${ver}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ stock: lines.slice(n).join('\n'), stock_ver: ver + 1 }) });
      if (!r.ok) throw new Error(`supabase popStockN ${r.status} ${await r.text()}`);
      if ((await r.json()).length) return lines.slice(0, n);
    }
    return null;
  },
  async itemsByShop(shopId) { return sbGet('items', `shop=eq.${enc(shopId)}&select=*&order=created.desc`); },
  async createOrder(o) { await sbInsert('orders', { token: o.token, item: o.item, price: o.price, paid_at: o.paidAt, ...(o.delivered != null ? { delivered: o.delivered } : {}), ...(o.buyer ? { buyer: o.buyer } : {}) }); },
  async orderByToken(t) {
    const o = (await sbGet('orders', `token=eq.${enc(t)}&select=*`))[0];
    return o && { token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer };
  },
  async buyerOrders(itemId, uid) {
    return (await sbGet('orders', `item=eq.${enc(itemId)}&buyer=eq.${enc(uid)}&select=*`)).map((o) => ({ token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer }));
  },
  async ordersForItems(ids) {
    if (!ids.length) return [];
    return (await sbGet('orders', `item=in.(${ids.map(enc).join(',')})&select=*`)).map((o) => ({ token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer }));
  },
};

const DB = path.join(__dirname, 'db.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { shops: {}, items: {}, orders: {} }; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const L = () => { const d = load(); d.users = d.users || {}; d.deposits = d.deposits || {}; d.charges = d.charges || {}; d.ledger = d.ledger || []; d.titles = d.titles || {}; d.user_titles = d.user_titles || []; d.shop_points = d.shop_points || {}; d.reviews = d.reviews || {}; d.shop_requests = d.shop_requests || {}; d.licenses = d.licenses || {}; d.inquiries = d.inquiries || {}; return d; };
const fileStore = {
  async updateShop(id, f) { const d = L(); if (d.shops[id]) Object.assign(d.shops[id], f); save(d); },
  async shopsByOwner(uid) { return Object.values(L().shops).filter((s) => s.owner === uid).sort((a, b) => b.created - a.created); },
  async shopBySms(t) { return Object.values(L().shops).find((s) => s.sms_token === t); },
  async createUser(u) { const d = L(); d.users[u.id] = u; save(d); },
  async userByEmail(e) { return Object.values(L().users).find((u) => String(u.email).toLowerCase() === e); },
  async userById(id) { return L().users[id]; },
  async usersByIds(ids) { const d = L(); return ids.map((id) => d.users[id]).filter(Boolean).map((u) => ({ id: u.id, name: u.name })); },
  async claimOrder(t, uid) { const d = load(); const o = d.orders && d.orders[t]; if (!o || o.buyer) return false; o.buyer = uid; save(d); return true; },
  async createDeposit(x) { const d = L(); d.deposits[x.token] = x; save(d); },
  async depositByToken(t) { return L().deposits[t]; },
  async waitingDeposits(shopId) { return Object.values(L().deposits).filter((x) => x.shop === shopId && x.status === 'waiting').sort((a, b) => b.created - a.created); },
  async setDepositDone(t) { const d = L(); if (d.deposits[t]) d.deposits[t].status = 'done'; save(d); },
  async createShop(s) { const d = load(); d.shops[s.id] = s; save(d); },
  async listNotices(shop) { const d = L(); d.notices = d.notices || {}; return Object.values(d.notices).filter((n) => (n.shop || null) === (shop || null)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.created - a.created).slice(0, 50); },
  async createNotice(n) { const d = L(); d.notices = d.notices || {}; d.notices[n.id] = n; save(d); },
  async noticeById(id) { const d = L(); return (d.notices || {})[id]; },
  async deleteNotice(id) { const d = L(); if (d.notices) delete d.notices[id]; save(d); },
  async createInquiry(q) { const d = L(); d.inquiries[q.id] = q; save(d); },
  async inquiryById(id) { return L().inquiries[id]; },
  async updateInquiry(id, f) { const d = L(); if (d.inquiries[id]) Object.assign(d.inquiries[id], f); save(d); },
  async deleteInquiry(id) { const d = L(); delete d.inquiries[id]; save(d); },
  async listInquiries(shop) { return Object.values(L().inquiries).filter((x) => (x.shop || null) === (shop || null)).sort((a, b) => b.created - a.created).slice(0, 200); },
  async inquiriesByUser(uid, shop) { return Object.values(L().inquiries).filter((x) => x.user_id === uid && (x.shop || null) === (shop || null)).sort((a, b) => b.created - a.created).slice(0, 50); },
  async shopById(id) { return load().shops[id]; },
  async shopByKey(key) { return Object.values(load().shops).find((s) => s.key === key); },
  async createItem(i) { const d = load(); d.items[i.id] = i; save(d); },
  async itemById(id) { return load().items[id]; },
  async updateItem(id, f) { const d = load(); if (d.items[id]) Object.assign(d.items[id], f); save(d); },
  async deleteItem(id) { const d = load(); delete d.items[id]; save(d); },
  async updateUser(id, f) { const d = L(); if (d.users[id]) Object.assign(d.users[id], f); save(d); },
  async deleteUser(id) {
    const d = L();
    for (const k of Object.keys(d.shop_points)) if (k.startsWith(id + '|')) delete d.shop_points[k];
    d.user_titles = d.user_titles.filter((x) => x.user_id !== id);
    for (const [k, c] of Object.entries(d.charges)) if (c.user_id === id && c.status === 'waiting') delete d.charges[k];
    delete d.shop_requests[id];
    for (const [k, x] of Object.entries(d.inquiries)) if (x.user_id === id) delete d.inquiries[k];
    delete d.users[id];
    save(d);
  },
  async purgeShop(id) {
    const d = L(); d.orders = d.orders || {};
    const itemIds = new Set(Object.values(d.items).filter((i) => i.shop === id).map((i) => i.id));
    for (const [k, o] of Object.entries(d.orders)) if (itemIds.has(o.item)) delete d.orders[k];
    for (const k of itemIds) delete d.items[k];
    for (const [k, r] of Object.entries(d.reviews)) if (r.shop === id) delete d.reviews[k];
    for (const [k, x] of Object.entries(d.deposits)) if (x.shop === id) delete d.deposits[k];
    for (const [k, c] of Object.entries(d.charges)) if (c.shop === id) delete d.charges[k];
    const titleIds = new Set(Object.values(d.titles).filter((t) => t.shop === id).map((t) => t.id));
    for (const k of titleIds) delete d.titles[k];
    d.user_titles = d.user_titles.filter((x) => x.shop !== id && !titleIds.has(x.title));
    for (const k of Object.keys(d.shop_points)) if (k.endsWith('|' + id)) delete d.shop_points[k];
    d.ledger = d.ledger.filter((l) => l.shop !== id);
    for (const [k, n] of Object.entries(d.notices || {})) if (n.shop === id) delete d.notices[k];
    for (const [k, x] of Object.entries(d.inquiries)) if (x.shop === id) delete d.inquiries[k];
    delete d.shops[id];
    save(d);
  },
  async userByCode(c) { const r = Object.values(L().users).filter((u) => u.id.startsWith(c)); return r.length === 1 ? r[0] : null; },
  async listUsers(q) { return Object.values(L().users).filter((u) => !q || u.email.includes(q.toLowerCase())).sort((a, b) => b.created - a.created).slice(0, 100).map((u) => ({ id: u.id, email: u.email, banned: !!u.banned, created: u.created, extra_shops: u.extra_shops || 0 })); },
  async allShops() { return Object.values(L().shops).sort((a, b) => b.created - a.created); },
  async searchShops(q, ownerIds) { const k = q.toLowerCase(); return Object.values(L().shops).filter((x) => String(x.name || '').toLowerCase().includes(k) || ownerIds.includes(x.owner)).sort((a, b) => b.created - a.created); },
  async addPoints(uid, delta) { const d = L(); const u = d.users[uid]; if (!u) return null; const np = Number(u.points || 0) + delta; if (np < 0) return null; u.points = np; save(d); return np; },
  async addEarned(shopId, delta) { const d = L(); const sh = d.shops[shopId]; if (!sh) return null; sh.earned = Math.max(0, Number(sh.earned || 0) + delta); save(d); return sh.earned; },
  async shopPoints(uid, shopId) { return Number(L().shop_points[uid + '|' + shopId] || 0); },
  async addShopPoints(uid, shopId, delta) { const d = L(); const k = uid + '|' + shopId; const np = Number(d.shop_points[k] || 0) + delta; if (np < 0) return null; d.shop_points[k] = np; save(d); return np; },
  async userShopPoints(uid) { return Object.entries(L().shop_points).filter(([k]) => k.startsWith(uid + '|')).map(([k, v]) => ({ shop: k.split('|')[1], points: v })); },
  async shopCharges(shopId) { return Object.values(L().charges).filter((c) => c.shop === shopId && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async userShopCharges(uid, shopId) { return Object.values(L().charges).filter((c) => c.user_id === uid && c.shop === shopId && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async ledgerForUserShop(uid, shopId) { return L().ledger.filter((l) => l.user_id === uid && l.shop === shopId).sort((a, b) => b.created - a.created).slice(0, 30); },
  async createCharge(c) { const d = L(); d.charges[c.token] = c; save(d); },
  async reviewByToken(t) { return Object.values(L().reviews).find((r) => r.token === t); },
  async reviewById(id) { return L().reviews[id]; },
  async createReview(r) { const d = L(); d.reviews[r.id] = r; save(d); },
  async updateReview(id, f) { const d = L(); if (d.reviews[id]) Object.assign(d.reviews[id], f); save(d); },
  async deleteReview(id) { const d = L(); delete d.reviews[id]; save(d); },
  async reviewsForItem(itemId) { return Object.values(L().reviews).filter((r) => r.item === itemId).sort((a, b) => b.created - a.created).slice(0, 100); },
  async reviewsByShop(shopId) { return Object.values(L().reviews).filter((r) => r.shop === shopId).map((r) => ({ item: r.item, rating: r.rating })); },
  async createLicense(r) { const d = L(); d.licenses[r.key] = r; save(d); },
  async listLicenses() { return Object.values(L().licenses).sort((a, b) => b.created - a.created).slice(0, 40); },
  async deleteUnusedLicense(k) { const d = L(); if (d.licenses[k] && !d.licenses[k].used_by) delete d.licenses[k]; save(d); },
  async claimLicense(k, uid) { const d = L(); const x = d.licenses[k]; if (!x || x.used_by) return null; x.used_by = uid; x.used_at = Date.now(); save(d); return x; },
  async releaseLicense(k) { const d = L(); if (d.licenses[k]) { d.licenses[k].used_by = null; d.licenses[k].used_at = null; } save(d); },
  async createShopRequest(r) { const d = L(); if (!d.shop_requests[r.user_id]) d.shop_requests[r.user_id] = r; save(d); },
  async shopRequestByUser(uid) { return L().shop_requests[uid]; },
  async deleteShopRequest(uid) { const d = L(); delete d.shop_requests[uid]; save(d); },
  async listShopRequests() { return Object.values(L().shop_requests).sort((a, b) => a.created - b.created); },
  async chargeByToken(t) { return L().charges[t]; },
  async waitingCharges() { return Object.values(L().charges).filter((c) => c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async userCharges(uid) { return Object.values(L().charges).filter((c) => c.user_id === uid && c.status === 'waiting').sort((a, b) => b.created - a.created); },
  async claimCharge(t, to = 'done') { const d = L(); const c = d.charges[t]; if (!c || c.status !== 'waiting') return false; c.status = to; save(d); return true; },
  async addLedger(l) { const d = L(); d.ledger.push(l); save(d); },
  async ledgerForUser(uid) { return L().ledger.filter((l) => l.user_id === uid).sort((a, b) => b.created - a.created).slice(0, 30); },
  async createTitle(t) { const d = L(); d.titles[t.id] = t; save(d); },
  async titlesByShop(shopId) { return Object.values(L().titles).filter((t) => t.shop === shopId).sort((a, b) => a.created - b.created); },
  async titleById(id) { return L().titles[id]; },
  async updateTitle(id, f) { const d = L(); if (d.titles[id]) Object.assign(d.titles[id], f); save(d); },
  async deleteTitle(id) { const d = L(); delete d.titles[id]; d.user_titles = d.user_titles.filter((x) => x.title !== id); save(d); },
  async grantTitle(uid, tid, shopId) { const d = L(); if (!d.user_titles.some((x) => x.user_id === uid && x.title === tid)) d.user_titles.push({ user_id: uid, title: tid, shop: shopId, created: Date.now() }); save(d); },
  async revokeTitle(uid, tid) { const d = L(); d.user_titles = d.user_titles.filter((x) => !(x.user_id === uid && x.title === tid)); save(d); },
  async titleHolders(tid) { return L().user_titles.filter((x) => x.title === tid).slice(0, 50).map((x) => ({ user_id: x.user_id })); },
  async titleHoldersMany(tids) { return L().user_titles.filter((x) => tids.includes(x.title)).sort((a, b) => (a.created || 0) - (b.created || 0)).slice(0, 1000).map((x) => ({ user_id: x.user_id, title: x.title })); },
  async userTitles(uid) { const d = L(); return d.user_titles.filter((x) => x.user_id === uid).map((x) => d.titles[x.title]).filter(Boolean); },
  async popStock(itemId) {
    const d = load(); const it = d.items[itemId];
    if (!it || it.stock == null) return null;
    const lines = stockLines(it.stock);
    if (!lines.length) return null;
    it.stock = lines.slice(1).join('\n'); save(d);
    return lines[0];
  },
  async popStockN(itemId, n) {
    const d = load(); const it = d.items[itemId];
    if (!it || it.stock == null) return null;
    const lines = stockLines(it.stock);
    if (lines.length < n) return null;
    it.stock = lines.slice(n).join('\n'); save(d);
    return lines.slice(0, n);
  },
  async itemsByShop(shopId) { return Object.values(load().items).filter((i) => i.shop === shopId).sort((a, b) => b.created - a.created); },
  async createOrder(o) { const d = load(); d.orders[o.token] = o; save(d); },
  async orderByToken(t) { return load().orders[t]; },
  async ordersForItems(ids) { return Object.values(load().orders).filter((o) => ids.includes(o.item)); },
  async buyerOrders(itemId, uid) { return Object.values(load().orders).filter((o) => o.item === itemId && o.buyer === uid); },
};
// 재고: 줄바꿈으로 한 줄에 하나. 빈 줄은 무시
const stockLines = (t) => String(t == null ? '' : t).split('\n').map((x) => x.trim()).filter(Boolean);
const parseStock = (t) => stockLines(t).slice(0, 2000).map((x) => x.slice(0, 1000)).join('\n');
const store = useSB ? sbStore : fileStore;

// ---------- 공통 ----------
const rid = (n = 6) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

// ---------- 토스페이먼츠 (키가 없으면 기존 테스트 결제 유지) ----------
const TOSS_CK = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_SK = (process.env.TOSS_SECRET_KEY || '').trim();
const useToss = !!(TOSS_CK && TOSS_SK);
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const BANKS = { '02': '산업은행', '03': '기업은행', '06': '국민은행', '07': '수협은행', '11': '농협은행', '20': '우리은행', '23': 'SC제일은행', '31': '대구은행', '32': '부산은행', '34': '광주은행', '35': '제주은행', '37': '전북은행', '39': '경남은행', '45': '새마을금고', '48': '신협', '71': '우체국', '81': '하나은행', '88': '신한은행', '89': '케이뱅크', '90': '카카오뱅크', '92': '토스뱅크' };

// 글씨로 된 링크(← 돌아가기, 열어보기 같은 것)는 전부 버튼 모양으로 보이게
const LINKBTN = `
.w a:not([class]),.w a.sub,.w a.sm,.main a:not([class]),.main a.sub,.main a.sm{display:inline-block;background:#f4f4f5;color:#18181b;border-radius:10px;padding:6px 10px;margin:3px 4px 3px 0;font-size:12px;font-weight:700;text-decoration:none;word-break:break-all;line-height:1.4;text-align:left}
.w a:not([class]):active,.w a.sub:active,.w a.sm:active,.main a:not([class]):active,.main a.sub:active,.main a.sm:active{background:#e4e4e7}
`;
// ---------- 다크모드 ----------
// 화면 전체 색을 뒤집고(검은 배경·밝은 글자), 사진·동영상만 다시 뒤집어 원래 색으로 보여줘요.
// 처음엔 기기 설정을 따르고, 🌙/☀️ 버튼으로 바꾸면 그 선택을 기억해요.
const EMPTY_CSS = `
#ptest,button[style*="#6b7280"]{width:auto!important;padding:7px 12px!important;font-size:12px!important;border-radius:10px!important}
.empty{display:block;font-style:normal;text-align:center;background:#f7f7f8;border:1px solid #eee;border-radius:14px;padding:14px;color:#71717a;font-size:13px;font-weight:400;margin:6px 0}
`;
const THEME_CSS = `
button,.btn,.bb{background:#0f8f74}
.btn,.bb{box-shadow:0 6px 14px rgba(15,143,116,.22)}
button:active,.btn:active,.bb:active{background:#0b7a63}
.nv.on{background:#0f8f74;box-shadow:0 10px 22px rgba(15,143,116,.28)}
.w a:not([class]),.w a.sub,.w a.sm,.main a:not([class]),.main a.sub,.main a.sm{background:#e7f5f1;color:#0b6b57}
.w a:not([class]):active,.w a.sub:active,.w a.sm:active,.main a:not([class]):active,.main a.sub:active,.main a.sm:active{background:#d3ebe4}
#ptest,button[style*="#6b7280"]{background:#e7f5f1!important;color:#0b6b57!important;box-shadow:none}
input:focus,textarea:focus,select:focus{outline-color:#0f8f74;border-color:#0f8f74}
/* 크기·간격 정리 */
.w{padding:14px 16px 60px}.main{padding:14px 16px 60px}
h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:22px 0 8px}
.card{padding:14px 16px;margin:10px 0;border-radius:18px}
input,textarea,select{padding:11px 14px;border-radius:14px;font-size:15px;margin:4px 0 8px}
textarea{min-height:76px}
button,.btn{padding:12px 14px;font-size:15px;border-radius:14px}
.bb{padding:15px;font-size:16px;border-radius:16px}
.acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.acts form{margin:0;flex:none!important}
.acts button,form:not(#bf):not([action*="/buy"]):not([action*="pay"]):not(:has(input:not([type=hidden]),textarea,select)) button{width:auto!important;padding:7px 12px!important;font-size:12px!important;border-radius:10px!important}
.acts button[type=button]{background:#e7f5f1!important;color:#0b6b57!important;box-shadow:none}
form[action*="delete"] button{background:#dc2626}
.th form[action*="delete"] button{background:#f4f4f5!important;color:#dc2626}
`;
const DARK_CSS = `
html.dark{filter:invert(1) hue-rotate(180deg);background:#fff}
html.dark img,html.dark video,html.dark canvas,html.dark .emo{filter:invert(1) hue-rotate(180deg)}
html.dark .emo{display:inline-block}
html.dark .ov{background:rgba(255,255,255,.5)}
html.dark .dr{background:#f0f0f0}
html.dark .card,html.dark .bx,html.dark .pc{background:#ededed;border-color:#dcdcdc}
html.dark input,html.dark textarea,html.dark select{background:#f2f2f2;border-color:#d4d4d8}
.tgl{width:38px;height:38px;flex:none;border:0;border-radius:50%;background:#f4f4f5;padding:0;display:grid;place-items:center;font-size:17px;line-height:1;cursor:pointer;color:inherit}
.tgl svg{display:block}.tgl .sn{display:none}html.dark .tgl .sn{display:block}html.dark .tgl .mn{display:none}
`;
const DARK_HEAD = `<script>try{var t=localStorage.getItem('theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}
try{(function(){var re=/(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?))*\\uFE0F?/gu;
function go(){var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null),n,L=[];
while(n=w.nextNode()){var p=n.parentNode;if(!p||/^(SCRIPT|STYLE|TEXTAREA|OPTION|SELECT|TITLE|NOSCRIPT)$/.test(p.nodeName)||(p.classList&&p.classList.contains('emo')))continue;re.lastIndex=0;if(re.test(n.nodeValue))L.push(n)}
L.forEach(function(n){var t=n.nodeValue,f=document.createDocumentFragment(),i=0,m;re.lastIndex=0;
while(m=re.exec(t)){if(m.index>i)f.appendChild(document.createTextNode(t.slice(i,m.index)));var e=document.createElement('span');e.className='emo';e.textContent=m[0];f.appendChild(e);i=m.index+m[0].length}
if(i<t.length)f.appendChild(document.createTextNode(t.slice(i)));n.parentNode.replaceChild(f,n)})}
document.addEventListener('DOMContentLoaded',go)})()}catch(e){}</script>`;
const STORE_ICO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/></svg>';
const DARK_BTN = `<button class="tgl" type="button" aria-label="다크모드" onclick="var d=document.documentElement.classList.toggle('dark');try{localStorage.setItem('theme',d?'dark':'light')}catch(e){}"><span class="mn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></span><span class="sn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></span></button>`;
const css = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,"Pretendard","Noto Sans KR",sans-serif;background:#fff;color:#18181b}
.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #eee}
.top .logo{flex:1;display:flex;align-items:center;gap:9px;font-size:18px;font-weight:800;text-decoration:none;color:#18181b}.top .logo svg{width:28px;height:28px;flex:none}
.chip{font-size:13px;font-weight:700;background:#f4f4f5;color:#18181b;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}
.w{max-width:560px;margin:0 auto;padding:18px 18px 70px}
h1{font-size:24px;margin:10px 0 6px}h2{font-size:19px;margin:28px 0 10px}
.card{background:#fafafa;border:1px solid #f0f0f0;border-radius:22px;padding:18px;margin:12px 0;box-shadow:0 3px 12px rgba(0,0,0,.06)}
input,textarea,select{width:100%;padding:14px;border:1px solid #e4e4e7;border-radius:16px;font-size:15px;margin:4px 0 10px;font-family:inherit;background:#fff;color:#18181b}
input:focus,textarea:focus,select:focus{outline:2px solid #18181b;border-color:#18181b}
textarea{min-height:90px}
button,.btn{display:inline-block;background:#18181b;color:#fff;border:0;border-radius:18px;padding:15px 16px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer;width:100%;text-align:center;font-family:inherit}
.row{display:flex;gap:8px;align-items:center}.row input{margin:0;flex:1;min-width:0}.row button{width:auto;flex:none;padding:13px 18px;font-size:15px;border-radius:14px}
.ca{display:block;color:inherit;text-decoration:none;margin:0 0 14px}.ca .card{margin:0}
.tcard{padding:14px 16px;border-radius:18px}.th{display:flex;align-items:center;gap:8px;margin-bottom:10px}.th form{margin:0 0 0 auto}.th form button{width:auto;padding:7px 12px;font-size:13px;background:#f4f4f5;color:#dc2626;border-radius:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip2{display:inline-flex;align-items:center;gap:6px;background:#f4f4f5;border-radius:999px;padding:4px 4px 4px 12px;margin:0;font-size:13px;color:#52525b}.chip2 button{width:26px;height:26px;padding:0;border-radius:50%;background:#d4d4d8;color:#18181b;font-size:12px}
.ucard{padding:14px 16px;margin:8px 0;border-radius:18px}.ucard .em{font-size:15px;font-weight:700;word-break:break-all}
.ucard details{margin-top:10px}.ucard summary{cursor:pointer;font-size:14px;font-weight:700;color:#52525b;padding:8px 0;list-style:none}.ucard summary::-webkit-details-marker{display:none}
.ucard .acts{display:flex;gap:8px;margin-top:8px}.ucard .acts form{flex:1;margin:0}.ucard .acts button{padding:11px 8px;font-size:14px;border-radius:14px}
.sub{color:#71717a;font-size:13px}.price{font-weight:700;color:#18181b}.lock{background:#f4f4f5;border-radius:16px;padding:14px;color:#18181b;font-size:14px}
.secret{white-space:pre-wrap;word-break:break-all;background:#ecfdf5;border-radius:16px;padding:14px}code{background:#f4f4f5;padding:2px 6px;border-radius:8px;word-break:break-all}
a{color:#18181b}.btn,.logo,.chip{text-decoration:none}.warn{background:#fff7ed;color:#9a3412;border-radius:16px;padding:13px 16px;font-size:13px}
${LINKBTN}
${DARK_CSS}${EMPTY_CSS}${THEME_CSS}
`;
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><link rel="manifest" href="/manifest.json?v=${ICON_VER}"><meta name="theme-color" content="#111111">${DARK_HEAD}<meta name="mobile-web-app-capable" content="yes"><title>${esc(title)}</title><style>${css}</style></head><body>${SPLASH}<div class="top"><a class="logo" href="/"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect width="28" height="28" rx="9" fill="#14130f"/><path d="M8 15.5l4-4a3 3 0 014.2 0l.3.3M20 12.5l-4 4a3 3 0 01-4.2 0l-.3-.3" stroke="#e0e7d7" stroke-width="2.2" stroke-linecap="round"/></svg>링크몰</a>${DARK_BTN}<a class="chip" href="/my" aria-label="내 상점">${STORE_ICO}</a></div><div class="w">${body}</div><script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script></body></html>`;

// ---------- 상점 화면 테마 (모바일 앱 느낌: 상단바 + 왼쪽 메뉴 + 큰 카드) ----------
const shopCss = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,"Pretendard","Noto Sans KR",sans-serif;background:#fff;color:#18181b}
a{color:inherit}
.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #eee}
.ib{width:42px;height:42px;border:0;background:#f4f4f5;border-radius:13px;display:grid;place-items:center;cursor:pointer;padding:0;color:#18181b}
.top b,.top .tb{font-size:17px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.top .tb{font-weight:700;text-decoration:none;color:inherit}
.chip{font-size:13px;font-weight:700;background:#f4f4f5;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}
.main{max-width:560px;margin:0 auto;padding:18px 18px 70px}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
.dr{position:fixed;top:0;left:0;bottom:0;width:min(88vw,380px);background:#fff;z-index:50;transform:translateX(-103%);transition:transform .25s;padding:24px 18px;overflow:auto}
body.open .ov{opacity:1;pointer-events:auto}body.open .dr{transform:none}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:34px}.brand img{width:48px;height:48px;border-radius:13px}.brand b{flex:1;font-size:19px}
.nv{display:flex;align-items:center;gap:14px;padding:16px 14px;font-size:17px;text-decoration:none;border-radius:18px;margin-bottom:6px}
.nv.on{background:#18181b;color:#fff;box-shadow:0 10px 22px rgba(0,0,0,.18)}
.dr h3{font-size:22px;margin:30px 0 12px 12px}
.pc{display:block;background:#fafafa;border:1px solid #f0f0f0;border-radius:28px;box-shadow:0 3px 12px rgba(0,0,0,.08);margin:0 0 22px;overflow:hidden;text-decoration:none;color:inherit}
.pc.off{opacity:.55}
.sb input{width:100%;padding:14px 16px;border:1px solid #e4e4e7;border-radius:16px;font-size:16px;background:#f4f4f5;color:#18181b;margin:0 0 16px;font-family:inherit;-webkit-appearance:none;appearance:none}.sb input:focus{outline:2px solid #18181b;background:#fff}
.pg{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sg{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sg .bx{margin:0;display:flex;flex-direction:column;gap:4px}.sg .sv{font-size:30px;letter-spacing:-1px}
.pg .pc{margin:0;border-radius:18px;box-shadow:0 2px 8px rgba(0,0,0,.07)}
.pg .im{aspect-ratio:1/1}.pg .im svg{width:36px;height:36px}
.pg .pb{padding:12px 12px 14px}
.pg .pb h2{font-size:15px;margin:0 0 6px;line-height:1.3;min-height:2.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.pg .rt{font-size:13px;gap:4px;margin-bottom:8px}.pg .rt svg{width:15px;height:15px}
.pg .pr{flex-direction:column;align-items:flex-start;gap:2px}.pg .pr>b{font-size:17px}.pg .pr span{font-size:12px}
.im{background:#f4f4f4;aspect-ratio:16/9;display:grid;place-items:center;color:#71717a;border-bottom:1px solid #ececec;position:relative;overflow:hidden}
.im img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.pb{padding:22px 24px 24px}.pb h2{font-size:22px;margin:0 0 12px}
.rt{display:flex;align-items:center;gap:8px;font-size:17px;margin-bottom:14px;color:#3f3f46}.rt svg{fill:#facc15}
.pr{display:flex;align-items:center;justify-content:space-between}.pr>b{font-size:28px}.pr span{color:#71717a;font-size:15px}.pr span b{color:#18181b}
.bx{background:#fafafa;border:1px solid #f0f0f0;border-radius:22px;padding:16px 18px;margin:14px 0}
.sm{color:#71717a;font-size:13px}
.nt{background:#fff7ed;color:#9a3412;border-radius:16px;padding:13px 16px;font-size:14px;margin:12px 0}
.qt{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:10px 14px;margin:14px 0 8px}
.qt .st{display:flex;align-items:center;gap:6px}
.qt button{width:44px;height:44px;border-radius:13px;border:0;background:#f4f4f5;font-size:24px;line-height:1;cursor:pointer;color:#18181b}
.qt input{width:70px;text-align:center;border:0;font-size:22px;font-weight:700;background:transparent;font-family:inherit;color:#18181b;-moz-appearance:textfield}
.qt input::-webkit-outer-spin-button,.qt input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.qk{display:flex;gap:8px;margin-bottom:6px}.qk button{flex:1;padding:10px 0;border:0;border-radius:12px;background:#f4f4f5;font-size:14px;font-weight:600;cursor:pointer;color:#18181b}
.tot{display:flex;justify-content:space-between;align-items:center}.tot b{font-size:24px}
.bb{display:block;width:100%;background:#18181b;color:#fff;border:0;border-radius:20px;padding:18px;font-size:18px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
.bb[disabled]{background:#d4d4d8;cursor:not-allowed}
input,textarea,select{font-family:inherit}
.secret{white-space:pre-wrap;word-break:break-all;background:#ecfdf5;border-radius:16px;padding:14px}
${LINKBTN}
${DARK_CSS}${EMPTY_CSS}${THEME_CSS}
`;
const ICO = {
  bag: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8.5 10.5a3.5 3.5 0 0 0 7 0"/><path d="M4 7h16"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  x: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  home: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  coin: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h4a1.75 1.75 0 0 1 0 3.5h-3a1.75 1.75 0 0 0 0 3.5h4"/></svg>',
  cube: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  chart: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  chat: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  star: '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.6L12 17.4 6.1 20.7l1.3-6.6L2.5 9.5l6.6-.8z"/></svg>',
};
// 상점 메뉴(옆 서랍) 카테고리: 판매자가 만들고, 이름을 바꾸고, 각 카테고리에 뜰 상품을 고름. shops.cats 에 JSON 문자열로 저장
const MAX_CATS = 10;
const parseCats = (shop) => {
  try {
    const a = JSON.parse((shop && shop.cats) || '[]');
    return Array.isArray(a) ? a.filter((c) => c && c.id && c.name).map((c) => ({ id: String(c.id), name: String(c.name), items: Array.isArray(c.items) ? c.items.map(String) : [] })) : [];
  } catch { return []; }
};
// 서랍에 보여줄 묶음 [{name, items}]. 카테고리가 없으면 "상품" 하나에 공개 상품 전부, 있으면 고른 대로(어디에도 안 넣은 상품은 "그 외")
const navGroups = (shop, pubItems) => {
  const cats = parseCats(shop);
  if (!cats.length) return [{ name: '상품', items: pubItems }];
  const byId = new Map(pubItems.map((i) => [i.id, i]));
  const used = new Set();
  const g = cats.map((c) => ({ name: c.name, items: c.items.map((id) => byId.get(id)).filter(Boolean) }));
  for (const x of g) for (const i of x.items) used.add(i.id);
  const rest = pubItems.filter((i) => !used.has(i.id));
  if (rest.length) g.push({ name: '그 외', items: rest });
  return g;
};
const shopPage = (shop, title, body, me, bal, next, active = 'home', groups = [], curId = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><link rel="manifest" href="/manifest.json?v=${ICON_VER}"><meta name="theme-color" content="#111111">${DARK_HEAD}<meta name="mobile-web-app-capable" content="yes"><title>${esc(title)}</title><style>${shopCss}</style></head><body>${SPLASH}
<div class="top"><button class="ib" type="button" onclick="document.body.classList.add('open')" aria-label="메뉴">${ICO.menu}</button><a class="tb" href="/s/${shop.id}">${esc(shop.name)}</a>${DARK_BTN}${me ? `<a class="chip" href="/w/${shop.id}">${pts(bal)}</a>` : `<a class="chip" href="/login?next=${enc(next)}">로그인</a>`}</div>
<div class="ov" onclick="document.body.classList.remove('open')"></div>
<nav class="dr"><div class="brand"><img src="/apple-touch-icon.png?v=${ICON_VER}" alt=""><b>${esc(shop.name)}</b><button class="ib" type="button" style="background:none" onclick="document.body.classList.remove('open')" aria-label="닫기">${ICO.x}</button></div>
<a class="nv${active === 'stats' ? ' on' : ''}" href="/s/${shop.id}/stats">${ICO.chart}통계</a>
<a class="nv" href="/w/${shop.id}">${ICO.coin}포인트 충전</a>
<a class="nv" href="/s/${shop.id}/inquiry">${ICO.chat}문의하기</a>
${groups.map((g, n) => `${n === 0 ? `<div class="sm" style="margin:30px 0 -22px 12px;font-size:13px">${esc(shop.name)}</div>` : ''}<h3${n ? ' style="margin-top:20px"' : ''}>${esc(g.name)}</h3>
${g.items.length ? g.items.map((i) => `<a class="nv${i.id === curId ? ' on' : ''}" href="/i/${i.id}">${ICO.cube}${esc(i.title)}</a>`).join('') : '<p class="sm" style="margin:0 0 0 14px"><i class="empty">비어 있어요</i></p>'}`).join('')}</nav>
<div class="main">${body}</div><script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script></body></html>`;

// 상품 검색(상점 첫 화면): 입력하는 대로 바로 걸러 보여줘요
const PRODUCT_SEARCH_BOX = `<div class="sb"><input id="ps" type="search" placeholder="상품 검색" autocomplete="off" enterkeyhint="search" aria-label="상품 검색"></div>`;
const PRODUCT_SEARCH_JS = `<p class="sm" id="pn" hidden style="text-align:center;margin:28px 0"><i class="empty">비어 있어요</i></p><script>(function(){var i=document.getElementById('ps'),n=document.getElementById('pn'),c=[].slice.call(document.querySelectorAll('.pg .pc'));function f(){var q=i.value.trim().toLowerCase(),k=0;c.forEach(function(e){var h=e.querySelector('h2'),t=h?h.textContent:'',s=!q||t.toLowerCase().indexOf(q)>-1;e.style.display=s?'':'none';if(s)k++});n.hidden=k>0}i.addEventListener('input',f);i.addEventListener('search',f)})()</script>`;

// 상점 관리·운영자 화면: 상점처럼 ☰(선 세 개)를 누르면 카테고리가 나오고, 고른 카테고리만 보여줘요.
// html 안에 <!--TAB:아이디:아이콘:이름--> 표시를 넣으면 그 자리부터 다음 표시 전까지가 한 카테고리(탭)가 돼요.
// 첫 표시 앞에 있는 내용은 모든 카테고리 위에 항상 보여요. 저장 뒤 새로고침해도 보던 카테고리가 유지돼요.
const PANEL_CSS = `
.ib{width:42px;height:42px;border:0;background:#f4f4f5;border-radius:13px;display:grid;place-items:center;cursor:pointer;padding:0;color:#18181b}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
.dr{position:fixed;top:0;left:0;bottom:0;width:min(88vw,380px);background:#fff;z-index:50;transform:translateX(-103%);transition:transform .25s;padding:24px 18px;overflow:auto}
body.open .ov{opacity:1;pointer-events:auto}body.open .dr{transform:none}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}.brand img{width:44px;height:44px;border-radius:12px}.brand b{flex:1;font-size:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nv{display:flex;align-items:center;gap:12px;padding:15px 14px;font-size:17px;text-decoration:none;border-radius:18px;margin-bottom:6px;color:#18181b}
.nv.on{background:#18181b;color:#fff;box-shadow:0 10px 22px rgba(0,0,0,.18)}
.nv i{font-style:normal;width:26px;text-align:center}
.dr hr{border:0;border-top:1px solid #eee;margin:14px 0}
.tab[hidden]{display:none}
`;
const panelPage = (o, html) => {
  const re = /<!--TAB:([\w-]+):([^:]*):([^>]*?)-->/g;
  const tabs = []; let pre = html, last = 0, mm;
  const first = html.search(/<!--TAB:/);
  pre = first < 0 ? html : html.slice(0, first);
  while ((mm = re.exec(html))) {
    if (tabs.length) tabs[tabs.length - 1].html = html.slice(last, mm.index);
    tabs.push({ id: mm[1], icon: mm[2], label: mm[3], html: '' });
    last = re.lastIndex;
  }
  if (tabs.length) tabs[tabs.length - 1].html = html.slice(last);
  const nav = tabs.map((t) => `<a class="nv" href="#${t.id}" data-t="${t.id}">${t.icon ? `<i>${t.icon}</i>` : ''}${esc(t.label)}</a>`).join('');
  const links = (o.links || []).map((l) => `<a class="nv" href="${l.href}">${l.label}</a>`).join('');
  const chip = o.chip ? `<a class="chip" href="${o.chip.href}"${o.chip.aria ? ` aria-label="${o.chip.aria}"` : ''}>${o.chip.label}</a>` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><link rel="manifest" href="/manifest.json?v=${ICON_VER}"><meta name="theme-color" content="#111111">${DARK_HEAD}<meta name="mobile-web-app-capable" content="yes"><title>${esc(o.title)}</title><style>${css}${PANEL_CSS}</style></head><body>${SPLASH}
<div class="top"><button class="ib" type="button" onclick="document.body.classList.add('open')" aria-label="메뉴">${ICO.menu}</button><span class="logo">${esc(o.heading || o.title)}</span>${DARK_BTN}${chip}</div>
<div class="ov" onclick="document.body.classList.remove('open')"></div>
<nav class="dr"><div class="brand"><img src="/apple-touch-icon.png?v=${ICON_VER}" alt=""><b>${esc(o.heading || o.title)}</b><button class="ib" type="button" style="background:none" onclick="document.body.classList.remove('open')" aria-label="닫기">${ICO.x}</button></div>
${nav}${links ? '<hr>' + links : ''}</nav>
<div class="w">${pre}${tabs.map((t) => `<div class="tab" id="tab-${t.id}" hidden>${t.html}</div>`).join('')}</div>
<script>(function(){var K='tab:'+${JSON.stringify(String(o.key || 'panel'))},tabs=[].slice.call(document.querySelectorAll('.tab')),navs=[].slice.call(document.querySelectorAll('.nv[data-t]'));if(!tabs.length)return;
function show(id,keep){var ok=false;tabs.forEach(function(t){var on=t.id==='tab-'+id;t.hidden=!on;if(on)ok=true});if(!ok){id=tabs[0].id.slice(4);tabs[0].hidden=false}navs.forEach(function(a){a.classList.toggle('on',a.getAttribute('data-t')===id)});try{sessionStorage.setItem(K,id)}catch(e){}document.body.classList.remove('open');if(!keep)window.scrollTo(0,0);try{history.replaceState(null,'','#'+id)}catch(e){}}
navs.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();show(a.getAttribute('data-t'))})});
var h=location.hash.slice(1),s='';try{s=sessionStorage.getItem(K)||''}catch(e){}show(h||s,true)})()</script>
<script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script></body></html>`;
};

const pointsBlock = (item, me, bal, shop, disc = 0, remain = null) => {
  const price = Math.floor(Number(item.price) * (100 - disc) / 100);
  const canCharge = !!(shop.bank && shop.account && shop.holder);
  const nextUrl = '/i/' + item.id;
  if (!me) return `<a class="bb" href="/login?next=${enc(nextUrl)}">로그인하고 구매하기</a>`;
  const multi = item.stock != null;
  const max = multi ? Math.max(1, Math.min(MAX_QTY, stockLines(item.stock).length, remain == null ? MAX_QTY : Math.max(1, remain))) : 1;
  const chargeLink = canCharge ? `<a href="/w/${shop.id}">충전하기</a>` : '(이 상점은 아직 충전을 받지 않아요)';
  return `<form method="post" action="/i/${item.id}/buy" id="bf">
${multi ? `<div class="qt"><span style="font-weight:600">수량</span><div class="st"><button type="button" id="mi" aria-label="하나 빼기">−</button><input id="q" name="qty" type="number" inputmode="numeric" min="1" max="${max}" value="1"><button type="button" id="pl" aria-label="하나 더하기">+</button></div></div>
<div class="qk"><button type="button" data-add="5">+5</button><button type="button" data-add="10">+10</button><button type="button" data-set="${max}">최대 (${max}개)</button></div>` : '<input type="hidden" name="qty" value="1">'}
${disc ? `<p class="sm" style="margin:0 0 8px">칭호 할인 ${disc}% 적용 (원가 ${won(item.price)})</p>` : ''}<div class="bx tot"><span class="sm">총 결제 포인트</span><b id="tot">${pts(price)}</b></div>
<div class="nt" id="lack" hidden>포인트가 <b id="lk"></b> 부족해요 · ${chargeLink}</div>
<button class="bb" id="bb">구매하기</button></form>
<script>(function(){var P=${price},B=${Number(bal) || 0},M=${max},q=document.getElementById('q'),tot=document.getElementById('tot'),lack=document.getElementById('lack'),lk=document.getElementById('lk'),bb=document.getElementById('bb'),f=document.getElementById('bf');
function n(){var v=q?parseInt(q.value,10):1;if(!(v>=1))v=1;if(v>M)v=M;return v}
function fmt(x){return x.toLocaleString('ko-KR')+'P'}
function upd(){var v=n(),t=P*v;tot.textContent=fmt(t);if(t>B){lack.hidden=false;lk.textContent=fmt(t-B);bb.disabled=true;bb.textContent='포인트가 부족해요'}else{lack.hidden=true;bb.disabled=false;bb.textContent=(M>1||v>1?v+'개 ':'')+fmt(t)+' 구매하기'}}
if(q){q.addEventListener('input',function(){if(q.value!==''){q.value=n()}upd()});q.addEventListener('blur',function(){q.value=n();upd()});
document.getElementById('mi').onclick=function(){q.value=Math.max(1,n()-1);upd()};document.getElementById('pl').onclick=function(){q.value=Math.min(M,n()+1);upd()};
Array.prototype.forEach.call(document.querySelectorAll('[data-add]'),function(b){b.onclick=function(){q.value=Math.min(M,n()+parseInt(b.dataset.add,10));upd()}});
Array.prototype.forEach.call(document.querySelectorAll('[data-set]'),function(b){b.onclick=function(){q.value=Math.min(M,parseInt(b.dataset.set,10));upd()}})}
f.onsubmit=function(){var v=n();if(q)q.value=v;return confirm(fmt(P*v)+'를 사용해 '+(v>1?v+'개를 ':'')+'구매할까요?')};upd()})();</script>`;
};
const payBlock = (item, shop) => {
  const hasDep = !!(shop && shop.bank && shop.account);
  if (!useToss && !hasDep) return `<div class="lock">결제하면 바로 잠금이 풀려요</div><br>
<form method="post" action="/i/${item.id}/pay"><button>${won(item.price)} 결제하고 열기 (테스트)</button></form>
<p class="sub">테스트 모드: 실제 결제 없이 버튼만 누르면 결제 완료로 처리됩니다.</p>`;
  let out = `<div class="lock">결제하면 바로 잠금이 풀려요</div><br>`;
  if (hasDep) out += `<div class="card"><b>계좌로 입금</b>
<p class="sub">${shop.pay_mode === 'auto' ? '입금이 확인되면 자동으로 열려요' : '판매자가 입금을 확인하면 열려요'}</p>
<form method="post" action="/i/${item.id}/deposit"><input name="name" placeholder="입금자명 (은행 앱에 찍히는 내 이름)" required minlength="2" maxlength="20"><button style="background:#0f766e">${won(item.price)} 입금 신청</button></form></div>`;
  if (useToss) {
    const orderId = item.id + rid(10); // 앞 12자 = 아이템 ID, 뒤 14자 = 랜덤 (총 26자)
    out += `<div class="card"><button id="payVbank" style="background:#0f766e">${won(item.price)} 가상계좌로 입금</button><br><br>
<button id="payCard">${won(item.price)} 카드로 결제</button>
<p class="sub" id="payMsg">가상계좌는 입금이 확인되면 자동으로 열려요. 결제 후 나오는 주소를 꼭 저장해 두세요.</p></div>
<script src="https://js.tosspayments.com/v2/standard"></script>
<script>
const pay = async (method) => {
  try {
    const tp = TossPayments(${js(TOSS_CK)});
    const payment = tp.payment({ customerKey: TossPayments.ANONYMOUS });
    await payment.requestPayment({
      method: method,
      amount: { currency: 'KRW', value: ${Number(item.price)} },
      orderId: ${js(orderId)},
      orderName: ${js(String(item.title).slice(0, 100))},
      successUrl: ${js(BASE + '/pay/success')},
      failUrl: ${js(BASE + '/pay/fail')}
    });
  } catch (e) { document.getElementById('payMsg').textContent = '결제가 취소되었거나 열 수 없어요.'; }
};
document.getElementById('payCard').onclick = () => pay('CARD');
document.getElementById('payVbank').onclick = () => pay('VIRTUAL_ACCOUNT');
</script>`;
  }
  return out;
};

const zlib = require('zlib');
const send = (res, code, html, headers = {}) => {
  const h = { 'Content-Type': 'text/html; charset=utf-8', ...headers };
  const ae = String((res.req && res.req.headers['accept-encoding']) || '');
  if (typeof html === 'string' && /\bgzip\b/.test(ae) && html.length > 1024) { // 큰 페이지는 압축해서 보내 전송을 빠르게
    return zlib.gzip(html, { level: 5 }, (err, buf) => {
      if (err) { res.writeHead(code, h); return res.end(html); }
      res.writeHead(code, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': buf.length });
      res.end(buf);
    });
  }
  res.writeHead(code, h); res.end(html);
};
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };
const readForm = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
});

const cleanImage = (v) => { v = String(v || ''); return v.length <= 400000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : ''; };
const imgField = (curId) => `<div style="margin:4px 0 12px"><b style="font-size:14px">상품 사진 (선택)</b>
<img id="imp" ${curId ? `src="/img/${curId}"` : ''} alt="" style="${curId ? 'display:block;' : 'display:none;'}width:100%;max-height:260px;object-fit:cover;border-radius:16px;margin:8px 0">
<input type="file" id="imf" accept="image/*">
<input type="hidden" name="image" id="imv">
${curId ? '<label style="display:flex;gap:8px;align-items:center;margin:0 0 6px"><input type="checkbox" name="del_image" style="width:auto;margin:0"> 현재 사진 삭제</label>' : ''}
</div>
<script>(function(){var f=document.getElementById('imf'),v=document.getElementById('imv'),p=document.getElementById('imp');f.onchange=function(){var file=f.files[0];if(!file)return;var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){var s=Math.min(1,640/Math.max(im.width,im.height));var c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(im,0,0,c.width,c.height);var d=c.toDataURL('image/jpeg',0.72);v.value=d;p.src=d;p.style.display='block'};im.onerror=function(){alert('이 사진은 읽을 수 없어요');f.value='';v.value=''};im.src=r.result};r.readAsDataURL(file)}})();</script>`;

const NOTI = { sale: '판매 (새 주문)', deposit: '입금 대기 (계좌 입금 주문)', charge: '포인트 충전 신청', stock: '재고 알림 (재고가 0이 됐을 때)', review: '후기 (새 후기가 달렸을 때)', inquiry: '문의 (새 문의가 왔을 때)' };
// 저장 형태: 주소 또는 주소#n=sale,warn  (#n= 없음 = 전부 켜짐, #n=- = 전부 꺼짐)
const parseHook = (w) => {
  const [url, frag = ''] = String(w || '').split('#');
  const mm = frag.match(/^n=(.*)$/);
  const on = mm ? (mm[1] === '-' ? [] : mm[1].split(',').map((k) => (k === 'warn' ? 'stock' : k)).filter((k) => NOTI[k])) : Object.keys(NOTI);
  return { url, on };
};
const buildHook = (url, on) => (!url ? '' : on.length === Object.keys(NOTI).length ? url : url + '#n=' + (on.length ? on.join(',') : '-'));
const MAX_HOOKS = 5; // 상점당 웹훅 최대 개수
const HOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;
const HOOK_SAVE_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w\-\/.]+$/;
// 저장 형태: 줄바꿈으로 구분된 여러 개 (예전 1개짜리 값도 그대로 읽힘)
const parseHooks = (w) => String(w || '').split('\n').map((x) => x.trim()).filter(Boolean).map(parseHook).filter((h) => h.url).slice(0, MAX_HOOKS);
const buildHooks = (list) => list.map((h) => buildHook(h.url, h.on)).join('\n');

// ---------- 알림 메시지 직접 바꾸기 ----------
// 상점마다 알림 종류별 문장을 저장해요 (shops.msgs = {"sale":"...", ...}). {변수}는 실제 값으로 바뀌고, 비우면 기본 문장이 가요.
const MSG_DEF = {
  sale: { vars: { item: '상품 이름', price: '금액', qty: '수량', shop: '상점 이름', link: '상품 링크' }, example: '💰 새 주문! {item} × {qty} ({price})', sample: { item: '치킨버거', price: '6,000원', qty: 2, shop: '내 상점', link: BASE + '/i/abc123' } },
  deposit: { vars: { item: '상품 이름', price: '금액', name: '입금자명', shop: '상점 이름', link: '상품 링크' }, example: '⏳ 입금 대기: {item} ({price}) · 입금자명 {name}', sample: { item: '치킨버거', price: '3,000원', name: '홍길동', shop: '내 상점', link: BASE + '/i/abc123' } },
  charge: { vars: { name: '입금자명', price: '충전 금액', shop: '상점 이름' }, example: '⏳ 충전 신청: {name} · {price}', sample: { name: '홍길동', price: '10,000원', shop: '내 상점' } },
  stock: { vars: { item: '상품 이름', shop: '상점 이름', link: '상품 링크' }, example: '📦 재고가 0이 됐어요: {item}', sample: { item: '치킨버거', shop: '내 상점', link: BASE + '/i/abc123' } },
  review: { vars: { item: '상품 이름', stars: '별 모양 점수', rating: '점수(숫자)', body: '후기 내용', shop: '상점 이름', link: '상품 링크' }, example: '⭐ 새 후기! {item} · {stars} ({rating}점)\n{body}', sample: { item: '치킨버거', stars: '★★★★★', rating: 5, body: '맛있어요!', shop: '내 상점', link: BASE + '/i/abc123' } },
  inquiry: { vars: { title: '문의 제목', body: '문의 내용', item: '문의한 상품 이름 (없으면 비어 있음)', shop: '상점 이름', link: '문의 확인 링크' }, example: '💬 새 문의: {title}\n{body}', sample: { title: '배송 언제 되나요?', body: '주문했는데 아직 못 받았어요', item: '치킨버거', shop: '내 상점', link: BASE + '/m/abc123' } },
};
const parseMsgs = (shop) => {
  try {
    const o = JSON.parse((shop && shop.msgs) || '{}'); const out = {};
    for (const k of Object.keys(NOTI)) if (o && typeof o[k] === 'string' && o[k].trim()) out[k] = o[k].slice(0, 500);
    return out;
  } catch { return {}; }
};
const renderMsg = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (all, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : all));
const saleVars = (shop, item, price, qty = 1) => ({ item: item.title, price: won(price), qty, shop: shop ? shop.name : '', link: BASE + '/i/' + item.id });

// ---------- 웹·앱 푸시 알림 (표준 Web Push, 추가 설치 없음) ----------
// 상점 주인의 기기(브라우저·홈 화면에 추가한 앱)로 같은 알림을 보내요. 구독 정보는 users.push(JSON)에 저장.
// 서버 키(VAPID)는 SESSION_SECRET에서 만들어서 따로 설정할 게 없어요 (SESSION_SECRET을 바꾸면 기기마다 알림을 다시 켜야 해요).
const b64u = (b) => Buffer.from(b).toString('base64url');
const PUSH_HOST_RE = /^https:\/\/([\w-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//;
let _vapid;
function vapid() {
  if (_vapid) return _vapid;
  const d = crypto.createHash('sha256').update('vapid:' + SESSION_SECRET).digest();
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  return (_vapid = { pub: b64u(pub), key });
}
function vapidAuth(endpoint) {
  const v = vapid();
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const c = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: BASE.startsWith('https') ? BASE : 'mailto:admin@example.com' }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + c), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + h + '.' + c + '.' + b64u(sig) + ', k=' + v.pub;
}
function encryptPush(sub, payload) { // RFC 8291 (aes128gcm)
  const ua = Buffer.from(sub.p256dh, 'base64url'); const auth = Buffer.from(sub.auth, 'base64url');
  const as = crypto.createECDH('prime256v1'); const asPub = as.generateKeys();
  const secret = as.computeSecret(ua);
  const salt = crypto.randomBytes(16);
  const hk = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const prk = hk(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hk(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const ci = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([ci.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), ci.final(), ci.getAuthTag()]);
  const hdr = Buffer.alloc(21); salt.copy(hdr, 0); hdr.writeUInt32BE(4096, 16); hdr[20] = 65;
  return Buffer.concat([hdr, asPub, ct]);
}
async function sendPush(sub, obj) {
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' }, body: encryptPush(sub, JSON.stringify(obj)) });
  return r.status;
}
const parseSubs = (u) => { try { const a = JSON.parse((u && u.push) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
// 이 회원이 켜둔 모든 기기에 푸시. 만료된 기기(404/410)는 목록에서 지움. 보낸 기기 수를 돌려줌
async function pushToUser(uid, obj, limit = 10) {
  if (!uid) return 0;
  const u = await store.userById(uid);
  const subs = parseSubs(u);
  if (!subs.length || !sendOk('pu:' + uid, limit, 60000)) return 0;
  const dead = []; let n = 0;
  await Promise.all(subs.map(async (s) => {
    try { const st = await sendPush(s, obj); if (st === 404 || st === 410) dead.push(s.endpoint); else if (st >= 400) console.error('push 실패', st); else n++; }
    catch (e) { console.error('push 오류', e.message); }
  }));
  if (dead.length) await store.updateUser(uid, { push: JSON.stringify(subs.filter((s) => !dead.includes(s.endpoint))) }).catch(() => {});
  return n;
}

// text = 기본 문장, vars가 있고 판매자가 그 종류의 문장을 직접 정해뒀으면 그 문장(변수 채움)을 보냄
// 같은 문장을 디스코드 웹훅 + 상점 주인의 웹·앱 푸시로 보냄
async function notify(shop, text, kind = 'stock', vars = null) {
  if (!shop) return;
  let content = text; let custom = false;
  if (vars) { const tpl = parseMsgs(shop)[kind]; if (tpl) { const r = renderMsg(tpl, vars).trim(); if (r) { content = r; custom = tpl.includes('{shop}'); } } } // 직접 쓴 문장에 {shop}이 이미 있으면 이름을 또 붙이지 않음
  content = content.slice(0, 1900);
  if (shop.owner) pushToUser(shop.owner, { title: shop.name, body: content.slice(0, 200), url: '/m/' + shop.key }).catch((e) => console.error('push 실패', e.message));
  if (!shop.webhook) return;
  const targets = parseHooks(shop.webhook).filter((h) => HOOK_RE.test(h.url) && h.on.includes(kind)); // 판매자가 끈 종류는 안 보냄
  if (!targets.length) return;
  if (!sendOk('nt:' + shop.id, 3, 60000)) { console.error('알림 건너뜀(1분 3번 제한)', shop.id); return; }
  await Promise.all(targets.map((h) =>
    fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: (custom ? content : '**[' + shop.name + ']** ' + content).slice(0, 1900), allowed_mentions: { parse: [] } }) }) // 기본 문장엔 상점 이름을 앞에 붙임 (직접 쓴 문장은 {shop}으로 넣기)
      .catch((e) => console.error('webhook 실패', e.message))));
}

// 등록된 웹훅 전부에 테스트 메시지를 보내고 개수별 결과를 돌려줌
async function testWebhooks(shop) {
  const hooks = parseHooks(shop && shop.webhook);
  return Promise.all(hooks.map(async (h, i) => {
    const n = i + 1;
    if (!HOOK_RE.test(h.url)) return { n, ok: false, msg: '디스코드 웹훅 주소 형식이 아니에요' };
    try {
      const r = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `✅ 링크몰 테스트 알림이에요. (${shop.name} · 웹훅 ${n}번) 선택한 알림이 이 채널로 와요.`, allowed_mentions: { parse: [] } }) });
      if (r.ok) return { n, ok: true };
      return { n, ok: false, msg: r.status === 404 || r.status === 401 ? '웹훅이 삭제됐거나 주소가 틀려요 (' + r.status + ')' : '디스코드가 거절했어요 (' + r.status + ')' };
    } catch (e) { return { n, ok: false, msg: '디스코드에 연결하지 못했어요' }; }
  }));
}
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const DEP_TTL = 24 * 3600 * 1000; // 입금 신청 유효시간 24시간

// ---------- 로그인 (쿠키 세션, 의존성 없음) ----------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('linkmall-session:' + (SB_KEY || __dirname)).digest('hex');
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'); const b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const getCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((a) => a[0]));
const currentUser = async (req) => (req._cu !== undefined ? req._cu : (req._cu = await currentUserRaw(req)));
async function currentUserRaw(req) {
  const c = getCookies(req).sid;
  if (!c) return null;
  const [uid, exp, sig] = c.split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const user = await store.userById(uid);
  if (!user || user.banned) return null;
  const good = sign(uid + '.' + exp + '.' + pwTag(user));
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return user;
}
const DAY = 86400000;
const pwTag = (u) => crypto.createHash('sha256').update(String(u.pw)).digest('hex').slice(0, 10);
const sessionCookie = (u) => { const exp = Date.now() + 30 * DAY; return `sid=${u.id}.${exp}.${sign(u.id + '.' + exp + '.' + pwTag(u))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}` + (BASE.startsWith('https') ? '; Secure' : ''); };
const clearCookie = 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-\/.?=&%]*$/.test(n)) ? n : '/my';
const fails = new Map();
const lockLeft = (k) => { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
const locked = (k) => lockLeft(k) > 0;
const waitText = (sec) => (sec >= 60 ? `${Math.ceil(sec / 60)}분` : `${sec}초`);
const lockMsg = (k) => `시도가 너무 많아요. ${waitText(lockLeft(k))} 뒤에 다시 해주세요`;
// 5번째 실패부터 잠금: 1분 → 2분 → 4분 → 8분 … (상한 60분). 24시간 동안 실패가 없으면 처음부터
const addFail = (k) => {
  const now = Date.now();
  let f = fails.get(k);
  if (!f || now - f.t > 86400000) f = { n: 0, until: 0, t: now };
  f.n += 1; f.t = now;
  if (f.n >= 5) f.until = now + Math.min(60 * 2 ** (f.n - 5), 3600) * 1000;
  fails.set(k, f);
};

// ---------- 이메일 인증 코드 (가입 때만, Brevo HTTP API) ----------
const BREVO_KEY = (process.env.BREVO_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || '').trim();
const MAIL_SCRIPT_URL = (process.env.MAIL_SCRIPT_URL || '').trim();       // 구글 앱스 스크립트 웹앱 주소 (선택)
const MAIL_SCRIPT_SECRET = (process.env.MAIL_SCRIPT_SECRET || '').trim(); // 스크립트와 맞춘 비밀 문자열
const useScript = !!(MAIL_SCRIPT_URL && MAIL_SCRIPT_SECRET);
const useMail = useScript || !!(BREVO_KEY && MAIL_FROM);
const MAIL_DAILY = useScript ? 90 : 250; // 앱스 스크립트(일반 Gmail)는 하루 수신자 100명 한도
const EMAIL_RE = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;
const sends = new Map();
const sendOk = (k, max, ms) => { const now = Date.now(); const a = (sends.get(k) || []).filter((t) => now - t < ms); if (a.length >= max) { sends.set(k, a); return false; } a.push(now); sends.set(k, a); return true; };
setInterval(() => { const now = Date.now(); for (const [k, a] of sends) if (!a.length || now - a[a.length - 1] > 86400000) sends.delete(k); for (const [k, f] of fails) if (now - f.t > 86400000) fails.delete(k); }, 600000).unref();
const codeHash = (email, code) => crypto.createHmac('sha256', SESSION_SECRET).update('code:' + email + ':' + code).digest('base64url');
const mkToken = (email, code) => { const p = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 10 * 60000, c: codeHash(email, code) })).toString('base64url'); return p + '.' + sign(p); };
const readToken = (t) => {
  const [p, sg] = String(t || '').split('.');
  if (!p || !sg) return null;
  const good = sign(p);
  if (sg.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch { return null; }
};
async function sendMail(to, subject, html) {
  try {
    if (useScript) {
      const r = await fetch(MAIL_SCRIPT_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: MAIL_SCRIPT_SECRET, to, subject, html }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) { console.error('script 메일 실패', r.status); return false; }
      return true;
    }
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: '링크몰', email: MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (!r.ok) { console.error('mail 실패', r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('mail 오류', e.message); return false; }
}
const verifyPage = (res, t, next, email, err) => send(res, 200, page('인증 코드', `<h1>인증 코드 입력</h1>
<p class="sub">${esc(email)} 로 6자리 코드를 보냈어요. 10분 안에 입력하세요. 안 오면 스팸함도 확인해 보세요.</p>${err ? `<p class="warn">${esc(err)}</p>` : ''}
<form class="card" method="post" action="/signup/verify"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="next" value="${esc(next)}">
<input name="code" placeholder="인증 코드 6자리" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<input name="pw" type="password" placeholder="사용할 비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
<button>가입 완료</button></form>
<p class="sub"><a href="/login?next=${enc(next)}">처음부터 다시</a></p>`));

// ---------- 로봇 방지 (가입할 때만) ----------
// TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY 가 있으면 Cloudflare "로봇이 아닙니다" 체크박스,
// 없으면 내장 숫자 그림 퀴즈(설정 필요 없음)
const TS_SITE = (process.env.TURNSTILE_SITE_KEY || '').trim();
const TS_SECRET = (process.env.TURNSTILE_SECRET_KEY || '').trim();
const useTurnstile = !!(TS_SITE && TS_SECRET);
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
const capHash = (a) => crypto.createHmac('sha256', SESSION_SECRET).update('cap:' + a).digest('base64url');
const usedCaps = new Map(); // 한 번 시도한 퀴즈는 다시 못 씀 (정답 돌려쓰기·무작위 대입 방지)
const R = (a, b) => a + Math.random() * (b - a);
function captchaHtml() {
  if (useTurnstile) return `<div class="cf-turnstile" data-sitekey="${esc(TS_SITE)}" style="margin:6px 0 10px"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  const ans = Array.from({ length: 5 }, () => crypto.randomInt(0, 10)).join('');
  const p = Buffer.from(JSON.stringify({ c: capHash(ans), x: Date.now() + 5 * 60000 })).toString('base64url');
  const tok = p + '.' + sign(p);
  let g = '';
  [...ans].forEach((d, i) => {
    const cells = DIGITS[d].flatMap((row, y) => [...row].map((v, x) => (v === '1' ? `<rect x="${(x * 5 + R(-0.6, 0.6)).toFixed(1)}" y="${(y * 5 + R(-0.6, 0.6)).toFixed(1)}" width="5" height="5"/>` : '')));
    g += `<g transform="translate(${12 + i * 34} ${R(8, 18).toFixed(1)}) rotate(${R(-14, 14).toFixed(1)} 12 17)" fill="hsl(${Math.floor(R(0, 360))} 55% 35%)">${cells.join('')}</g>`;
  });
  let noise = '';
  for (let i = 0; i < 5; i++) noise += `<line x1="${R(0, 190).toFixed(0)}" y1="${R(0, 64).toFixed(0)}" x2="${R(0, 190).toFixed(0)}" y2="${R(0, 64).toFixed(0)}" stroke="hsl(${Math.floor(R(0, 360))} 40% 55%)" stroke-width="1.6"/>`;
  return `<p class="sub" style="margin:8px 0 0">그림 속 숫자 5자리</p>
<svg viewBox="0 0 190 64" style="width:190px;max-width:100%;background:#f3f4f6;border-radius:10px;margin:6px 0;display:block">${g}${noise}</svg>
<input type="hidden" name="ct" value="${tok}"><input name="cc" placeholder="숫자 5자리" inputmode="numeric" autocomplete="off" maxlength="5" required>
<p class="sub" style="margin:0 0 10px"><a href="javascript:location.reload()">새로 받기</a></p>`;
}
async function captchaOk(f, req) {
  if (useTurnstile) {
    const resp = String(f['cf-turnstile-response'] || '');
    if (!resp) return false;
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: TS_SECRET, response: resp, remoteip: ip }) });
      const d = await r.json();
      return !!d.success;
    } catch (e) { console.error('turnstile 오류', e.message); return false; }
  }
  const tok = readToken(f.ct);
  if (!tok) return false;
  const id = String(f.ct).split('.')[1];
  if (usedCaps.has(id)) return false;
  usedCaps.set(id, tok.x);
  if (usedCaps.size > 500) for (const [k, x] of usedCaps) if (x < Date.now()) usedCaps.delete(k);
  const a = Buffer.from(capHash(str(f.cc, 5)));
  const b = Buffer.from(String(tok.c || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const CAP_FAIL = '로봇 확인에 실패했어요. 새 그림으로 다시 해주세요';

// ---------- 포인트 · 관리자 설정 ----------
const ADMIN_LIST = (process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => !!u && useMail && ADMIN_LIST.includes(String(u.email).toLowerCase()); // 이메일 인증이 켜져 있어야 관리자 권한 동작(남이 먼저 가입해 가로채는 것 방지)
const CHARGE_TTL = 24 * 3600 * 1000;
const MIN_CHARGE = 1000; const MAX_CHARGE = 500000;
const pts = (n) => Number(n || 0).toLocaleString('ko-KR') + 'P';
const fmtDate = (t) => new Date(Number(t)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const FREE_SHOPS = 3; // 운영자 동의 없이 만들 수 있는 상점 수
const shopLimit = (u) => (isAdmin(u) ? Infinity : Math.max(0, FREE_SHOPS + Number(u.extra_shops || 0))); // 운영자가 사람마다 조절 (/admin)
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const SEL_STYLE = 'width:100%;padding:12px;border:1px solid #d9dce1;border-radius:10px;font-size:15px;margin:4px 0 10px';
const badgeHtml = (name) => `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#eef0ff;color:#4338ca;font-size:13px;margin:2px">${esc(name)}</span>`;
const titleSelect = (titles, cur) => (titles.length ? `<select name="title_id" style="${SEL_STYLE}"><option value="">구매 시 지급할 칭호 없음</option>${titles.map((t) => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>${esc(t.name)} 자동 지급</option>`).join('')}</select>` : '');

// 관리 권한: 링크가 아니라 로그인한 상점 주인(또는 운영자)만
const fmtDay = (t) => new Date(Number(t)).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
// ---------- 공지사항 (운영자 공지: 모든 상점·내 상점 화면 / 상점 공지: 그 상점 첫 화면) ----------
const MAX_NOTICES = 30;
const NOTICE_SQL = "create table if not exists notices (id text primary key, shop text, title text not null, body text not null, pinned boolean not null default false, created bigint not null); alter table notices disable row level security;";
async function safeNotices(shop) { try { return await store.listNotices(shop); } catch (e) { console.error('공지 불러오기 실패 (notices 표가 있나요?)', e.message); return []; } }
const noticeBlock = (list, label) => list.length ? `<div style="background:#fafafa;border:1px solid #f0f0f0;border-radius:22px;padding:14px 18px;margin:0 0 16px"><b>${esc(label)}</b>${list.slice(0, 5).map((n) => `<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:700;font-size:15px">${n.pinned ? '고정 · ' : ''}${esc(n.title)} <span style="color:#71717a;font-size:12px;font-weight:400">${fmtDay(n.created)}</span></summary><div style="white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;margin-top:8px;color:#3f3f46">${esc(n.body)}</div></details>`).join('')}</div>` : '';
const noticeForm = (action) => `<form class="card" method="post" action="${action}"><input name="title" placeholder="공지 제목" required maxlength="60"><textarea name="body" placeholder="공지 내용" required maxlength="2000"></textarea><label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pinned" value="1" style="width:auto;margin:0"> 맨 위에 고정</label><button>공지 올리기</button></form>`;
const noticeList = (list, action) => list.map((n) => `<div class="card tcard"><b>${n.pinned ? '고정 · ' : ''}${esc(n.title)}</b> <span class="sub">${fmtDate(n.created)}</span><div style="white-space:pre-wrap;word-break:break-word;font-size:14px;margin:6px 0 10px">${esc(n.body)}</div><form method="post" action="${action}/${n.id}/delete" onsubmit="return confirm('이 공지를 삭제할까요?')"><button style="background:#dc2626;padding:10px;font-size:14px;border-radius:14px">삭제</button></form></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>';
const noticeFields = (f) => ({ title: str(f.title, 60), body: String(f.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000), pinned: f.pinned === '1' || f.pinned === 'on' });
// ---------- 문의 (구매자·회원 → 판매자 / 운영자) ----------
// 상점 문의: 그 상점 주인(과 운영자)이 답변. 운영자 문의: 운영자가 답변 (상점 주인도 보낼 수 있음)
const MAX_INQ_OPEN = 10; // 답변 못 받은 문의가 이만큼 쌓이면 더 못 보냄
const INQ_SQL = "create table if not exists inquiries (id text primary key, user_id text not null, shop text, item text, item_title text, title text not null, body text not null, reply text, replied_at bigint, created bigint not null); alter table inquiries disable row level security;";
async function safeInq(fn) { try { return await fn(); } catch (e) { console.error('문의 불러오기 실패 (inquiries 표가 있나요?)', e.message); return []; } }
const inqFields = (f) => ({ title: str(f.title, 60), body: String(f.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000) });
const inqReplyText = (f) => String(f.reply ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000);
const inqDeleteForm = (q) => `<form method="post" action="/inquiries/${q.id}/delete" onsubmit="return confirm('이 문의를 삭제할까요?')" style="margin:8px 0 0"><button style="background:#f4f4f5;color:#dc2626;padding:10px;font-size:14px;border-radius:14px">삭제</button></form>`;
const INQ_TEXT = 'white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6';
// 문의한 사람이 보는 카드
const inqMineCard = (q) => `<div class="card tcard"><b>${esc(q.title)}</b> <span class="sub">${fmtDate(q.created)}</span>${q.item_title ? `<br><span class="sub">${esc(q.item_title)}</span>` : ''}<div style="${INQ_TEXT};margin:6px 0 8px">${esc(q.body)}</div>${q.reply ? `<div style="background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:12px;margin:8px 0"><b style="font-size:13px">↪ 답변</b> <span class="sub">${fmtDate(q.replied_at)}</span><div style="${INQ_TEXT};margin-top:4px">${esc(q.reply)}</div></div>` : '<p class="sub" style="margin:0">답변을 기다리고 있어요</p>'}${inqDeleteForm(q)}</div>`;
// 답변하는 사람(판매자·운영자)이 보는 카드
const inqStaffCard = (q, who, action) => `<div class="card tcard"><b>${esc(q.title)}</b> <span class="sub">${q.reply ? '답변 완료' : '답변 대기'}</span><br><span class="sub">${esc(who)} · ${fmtDate(q.created)}${q.item_title ? ' · ' + esc(q.item_title) : ''}</span><div style="${INQ_TEXT};margin:8px 0">${esc(q.body)}</div><form method="post" action="${action}/${q.id}/reply"><textarea name="reply" placeholder="답변 (최대 1000자)" required maxlength="1000">${esc(q.reply || '')}</textarea><button>${q.reply ? '답변 수정' : '답변 보내기'}</button></form>${inqDeleteForm(q)}</div>`;
const inqForm = (action, items, selItem) => `<form class="card" method="post" action="${action}">${items ? `<select name="item" style="${SEL_STYLE}"><option value="">상품 무관 (일반 문의)</option>${items.map((i) => `<option value="${esc(i.id)}"${i.id === selItem ? ' selected' : ''}>${esc(i.title)}</option>`).join('')}</select>` : ''}<input name="title" placeholder="문의 제목" required maxlength="60"><textarea name="body" placeholder="문의 내용 (최대 1000자)" required maxlength="1000"></textarea><button>문의 보내기</button><p class="sub">답변이 오면 알려드려요</p></form>`;
// 새 문의를 모든 운영자에게 푸시
async function notifyAdmins(text, url) {
  if (!useMail) return;
  for (const e of ADMIN_LIST) {
    try { const a = await store.userByEmail(e); if (a) await pushToUser(a.id, { title: '링크몰 문의', body: String(text).slice(0, 200), url }); }
    catch (x) { console.error('운영자 알림 실패', x.message); }
  }
}
// 답변이 달리면 문의한 사람에게 푸시
const notifyReplied = (q, reply, from) => pushToUser(q.user_id, { title: `${from} 답변이 도착했어요`, body: reply.slice(0, 100), url: q.shop ? `/s/${q.shop}/inquiry` : '/inquiry' }).catch((e) => console.error('답변 알림 실패', e.message));
const newLicenseKey = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let t = ''; for (const x of crypto.randomBytes(16)) t += A[x % 32]; return `LK-${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}`; };
const NO_LICENSE_MSG = '이용할 수 없어요'; // 지금은 쓰지 않음 (판매·충전은 무료)
const licenseOk = async () => true; // 판매·구매·충전 신청은 모두 무료. 라이센스 키는 '자동 충전'(autoAllowed)에서만 확인해요
// ---------- 포인트 충전 확인 방식 (수동 / 자동) ----------
// 자동 = 은행 입금 알림(문자 또는 앱 푸시)을 /sms/<토큰> 으로 전달받아 입금자명·금액이 맞으면 포인트를 바로 지급. 라이센스 키가 있는 상점만 쓸 수 있음 (나머지 기능은 모두 무료)
const PAYMODE_SQL = 'alter table shops add column if not exists pay_mode text; alter table shops add column if not exists sms_token text;';
const autoAllowed = async (shop) => { if (!shop || !shop.owner) return false; const o = await store.userById(shop.owner); return !!o && (isAdmin(o) || Number(o.license_until) > Date.now()); };
const smsSeen = new Map(); // 같은 문자가 재전송돼 두 번 처리되는 것 방지 (2분)
const licTries = new Map(); // 키 무작위 대입 방지: 회원별 10분에 10번까지
const parseBlocked = (shop) => { try { const a = JSON.parse((shop && shop.blocked) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const isBlocked = (shop, uid) => !!uid && parseBlocked(shop).includes(uid);
const BLOCKED_MSG = '이 상점에서 이용이 제한됐어요';
const discountOf = async (uid, shopId) => { if (!uid) return 0; try { const ts = await store.userTitles(uid); return Math.max(0, ...ts.filter((t) => t.shop === shopId).map((t) => Math.min(20, Number(t.discount) || 0))); } catch { return 0; } };
const paybackOf = async (uid, shopId) => { if (!uid) return 0; try { const ts = await store.userTitles(uid); return Math.max(0, ...ts.filter((t) => t.shop === shopId).map((t) => Math.min(20, Number(t.payback) || 0))); } catch { return 0; } };
const discPrice = (price, disc) => Math.floor(Number(price) * (100 - disc) / 100);
async function manageShop(req, res, key) {
  const shop = await store.shopByKey(key);
  if (!shop) { notFound(res, '상점을 찾을 수 없어요'); return null; }
  const u = await currentUser(req);
  if (!u) { redirect(res, '/login?next=' + enc('/m/' + shop.key)); return null; }
  if (isAdmin(u)) return shop;
  if (shop.deleted) { notFound(res, '삭제된 상점이에요'); return null; }
  if (!shop.owner) { redirect(res, '/claim/' + shop.key); return null; }
  if (u.id !== shop.owner) { send(res, 403, page('권한 없음', '<h1>이 상점의 주인이 아니에요</h1>')); return null; }
  return shop;
}
async function adminOnly(req, res) {
  const u = await currentUser(req);
  if (!u) { redirect(res, '/login?next=/admin'); return null; }
  if (!isAdmin(u)) { send(res, 403, page('권한 없음', '<h1>운영자만 볼 수 있어요</h1>')); return null; }
  return u;
}

// 충전 확인: 한 번만 포인트 지급(상태를 waiting→done으로 바꾼 쪽만 지급). 포인트는 그 상점 전용
async function confirmCharge(ch) {
  if (!ch.shop) return false;
  if (!(await store.claimCharge(ch.token, 'done'))) return false;
  const bal = await store.addShopPoints(ch.user_id, ch.shop, Number(ch.amount));
  if (bal == null) { console.error('충전 지급 실패', ch.token); return false; }
  await store.addLedger({ id: rid(9), user_id: ch.user_id, shop: ch.shop, delta: Number(ch.amount), kind: 'charge', ref: ch.token, note: '충전', created: Date.now() });
  return true;
}
// 꺼낸 재고 한 줄을 되돌림
async function restoreStock(itemId, line) {
  const it = await store.itemById(itemId);
  if (it) await store.updateItem(itemId, { stock: [line, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
}

// 꺼낸 재고 여러 줄을 되돌림
async function restoreLines(itemId, lines) {
  const it = await store.itemById(itemId);
  if (it) await store.updateItem(itemId, { stock: [...lines, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
}
// 한 주문에 지급된 개수 (재고형은 지급된 줄 수, 그 외 1)
const orderQty = (o) => (o && o.delivered ? Math.max(1, stockLines(o.delivered).length) : 1);
const MAX_QTY = 50;
// 인당 구매 한도: items.buy_limit (비어 있거나 0이면 제한 없음). 한 사람이 이 상품을 평생 최대 N개까지
const LIMIT_SQL = 'alter table items add column if not exists buy_limit integer;';
const parseLimit = (v) => { const n = parseInt(v, 10); return n >= 1 ? Math.min(n, 100000) : 0; };
const itemLimit = (item) => Math.max(0, parseInt(item && item.buy_limit, 10) || 0);
const boughtCount = async (item, uid) => (uid ? (await store.buyerOrders(item.id, uid)).reduce((a, o) => a + orderQty(o), 0) : 0);
const buyLocks = new Set(); // 같은 사람이 같은 상품을 동시에 두 번 누르는 것 방지

// 주문 생성 + 재고형 아이템이면 한 줄을 꺼내 구매자에게 지급
async function placeOrder(order, item) {
  let line = null;
  if (item.stock != null) {
    line = await store.popStock(item.id);
    order.delivered = line == null ? '' : line;
  }
  try { await store.createOrder(order); }
  catch (e) {
    if (line != null) { // 주문 저장 실패하면 꺼낸 줄을 되돌림
      const it = await store.itemById(item.id);
      if (it) await store.updateItem(item.id, { stock: [line, ...stockLines(it.stock)].join('\n'), ...(useSB ? { stock_ver: (it.stock_ver || 0) + 1 } : {}) });
    }
    throw e;
  }
  if (item.stock != null && line == null) await notify(await store.shopById(item.shop), `⚠️ 재고가 없는데 결제가 확인됐어요: ${item.title}. 구매자에게 직접 보내주세요 (${BASE}/o/${order.token})`, 'stock');
  return order;
}

// ---------- 계좌 입금 확인 ----------
async function confirmDeposit(dep) {
  const existing = await store.orderByToken(dep.token);
  if (existing) { if (dep.status !== 'done') await store.setDepositDone(dep.token); return existing; }
  const item = await store.itemById(dep.item);
  if (!item) return null;
  if (item.stock != null && !stockLines(item.stock).length) {
    await notify(await store.shopById(dep.shop), `⚠️ 재고가 0인데 입금이 도착했어요: ${item.title} · 입금자 ${dep.name} (${won(dep.amount)}). 입금자에게 환불해 주세요.`, 'stock');
    return null;
  }
  const order = { token: dep.token, item: dep.item, price: Number(dep.amount), paidAt: Date.now() };
  try { await placeOrder(order, item); } catch (e) {
    const again = await store.orderByToken(dep.token);
    if (again) return again;
    throw e;
  }
  await store.setDepositDone(dep.token);
  const shopD = await store.shopById(dep.shop);
  await notify(shopD, `💰 입금 확인! ${item.title} (${won(order.price)})`, 'sale', saleVars(shopD, item, order.price));
  return order;
}

const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(b));
});

// 토스에 주문번호로 결제 상태 조회 (실패하면 null)
async function tossPayment(orderId) {
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/orders/' + enc(orderId), { headers: { Authorization: 'Basic ' + Buffer.from(TOSS_SK + ':').toString('base64') } });
    return r.ok ? await r.json() : null;
  } catch (e) { console.error('toss 조회 실패', e.message); return null; }
}

// 입금/결제 완료된 결제를 주문으로 기록 (여러 번 불려도 한 번만 생성)
async function finalizePaid(p) {
  const orderId = p.orderId;
  const existing = await store.orderByToken(orderId);
  if (existing) return existing;
  const item = await store.itemById(orderId.slice(0, 12));
  if (!item) return null;
  const order = { token: orderId, item: item.id, price: Number(p.totalAmount), paidAt: Date.now() };
  try { await placeOrder(order, item); } catch (e) {
    const again = await store.orderByToken(orderId);
    if (again) return again;
    throw e;
  }
  const shopF = await store.shopById(item.shop);
  await notify(shopF, `💰 새 주문! ${item.title} (${won(order.price)})`, 'sale', saleVars(shopF, item, order.price));
  return order;
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// 웹 아이콘 (파비콘 / 홈 화면 아이콘). 이미지는 코드에 포함돼 있어 파일이 따로 필요 없어요
const ICON_VER = '6'; // 아이콘 이미지를 바꿀 때마다 숫자를 올리면 브라우저가 새 아이콘을 다시 받아가요
const ICON_SMALL = Buffer.from('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', 'base64');
const ICON_LARGE = Buffer.from('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', 'base64');
route('GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/, (req, res, m) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(m[1] === 'favicon.ico' ? ICON_SMALL : ICON_LARGE);
});

// ---------- 앱 설치(PWA): 홈 화면에 앱처럼 설치되게 하는 파일들 ----------
const ICON_192 = Buffer.from('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', 'base64');
const ICON_512 = Buffer.from('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+f5/FrheT8QAQEQdLCngG5v/iIhEPgIiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiIGAD4CIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIiIgYAIiIiYgAgIiIiBgAiIiJiACAiIiIGACIiImIAICIioi38f2PDiakps6a6AAAAAElFTkSuQmCC', 'base64');
const PUSH_CARD = `<div class="card"><b>웹·앱 알림</b><p class="sub" id="pst">확인하는 중…</p>
<button id="pbtn" type="button" style="display:none">이 기기에서 알림 받기</button><button id="ptest" type="button" style="display:none;margin-top:10px;background:#6b7280">테스트 알림</button>
<p class="sub" style="margin:8px 0 0">새 주문·충전·후기 알림을 이 기기로 받아요. 아이폰은 사파리에서 "홈 화면에 추가"한 앱으로 열어야 해요.</p></div>
<script>(function(){
var b=document.getElementById('pbtn'),t=document.getElementById('ptest'),s=document.getElementById('pst'),reg=null,on=false;
function u8(x){var p='='.repeat((4-x.length%4)%4),r=atob((x+p).replace(/-/g,'+').replace(/_/g,'/')),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d||{})}).then(function(r){return r.json()})}
function show(){b.style.display='block';t.style.display=on?'block':'none';b.textContent=on?'이 기기 알림 끄기':'이 기기에서 알림 받기';s.textContent=on?'이 기기로 알림이 와요':(Notification.permission==='denied'?'브라우저에서 알림이 막혀 있어요. 사이트 설정에서 허용해 주세요':'꺼져 있어요')}
if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){s.textContent='이 브라우저는 푸시 알림을 지원하지 않아요.'}
else navigator.serviceWorker.ready.then(function(r){reg=r;return r.pushManager.getSubscription()}).then(function(sub){on=!!sub;show()});
b.onclick=function(){
  if(!reg)return;b.disabled=true;
  var done=function(){b.disabled=false;show()};
  if(on){reg.pushManager.getSubscription().then(function(sub){if(!sub)return;return post('/push/unsubscribe',{endpoint:sub.endpoint}).then(function(){return sub.unsubscribe()})}).then(function(){on=false;done()}).catch(done);return}
  Notification.requestPermission().then(function(p){
    if(p!=='granted'){done();return}
    return fetch('/push/key').then(function(r){return r.text()}).then(function(k){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(k.trim())})})
    .then(function(sub){return post('/push/subscribe',sub.toJSON()).then(function(r){if(!r.ok){s.textContent=''+(r.msg||'저장하지 못했어요');return sub.unsubscribe()}on=true})}).then(done);
  }).catch(function(){s.textContent='알림을 켜지 못했어요';done()});
};
t.onclick=function(){t.disabled=true;post('/push/test').then(function(r){s.textContent=r.ok?'테스트 알림을 보냈어요':'보내지 못했어요 (1분에 5번까지)';t.disabled=false}).catch(function(){t.disabled=false})};
})();</script>`;
const MANIFEST = JSON.stringify({
  id: '/', name: '링크몰', short_name: '링크몰', description: '링크로 사고파는 상점',
  start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
  background_color: '#ffffff', theme_color: '#111111', lang: 'ko',
  icons: [
    { src: `/icon-192.png?v=${ICON_VER}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/icon-512.png?v=${ICON_VER}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
});
// 앱으로 열었을 때(홈 화면 아이콘)만, 그리고 앱을 켠 뒤 처음 한 번만 보이는 시작 애니메이션
const SPLASH = `<style>#sp{display:none;position:fixed;inset:0;z-index:99999;background:#fff;flex-direction:column;align-items:center;justify-content:center;gap:22px;transition:opacity .5s ease,visibility .45s}.sp-on #sp{display:flex}#sp.out{opacity:0;visibility:hidden}#sp img{width:150px;height:150px;border-radius:36px;box-shadow:0 14px 40px rgba(0,0,0,.18);animation:spIn .9s cubic-bezier(.2,1.3,.4,1) both,spBob 1.4s .9s ease-in-out infinite}#sp b{font-size:34px;letter-spacing:-1px;color:#111;animation:spUp .7s .35s ease both}#sp i{width:64px;height:5px;border-radius:3px;background:#ddd;overflow:hidden;position:relative;animation:spUp .7s .5s ease both}#sp i:after{content:"";position:absolute;inset:0;width:40%;background:#111;border-radius:2px;animation:spBar 1s ease-in-out infinite}@keyframes spIn{from{opacity:0;transform:scale(.2) rotate(-20deg)}to{opacity:1;transform:none}}@keyframes spBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-8px) scale(1.04)}}@keyframes spUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}@keyframes spBar{0%{left:-40%}100%{left:100%}}@media(prefers-reduced-motion:reduce){#sp *{animation:none!important}}</style><div id="sp"><img src="/apple-touch-icon.png?v=${ICON_VER}" alt=""><b>링크몰</b><i></i></div><script>try{if((matchMedia('(display-mode: standalone)').matches||navigator.standalone)&&!sessionStorage.getItem('sp')){sessionStorage.setItem('sp','1');document.documentElement.classList.add('sp-on');setTimeout(function(){var e=document.getElementById('sp');e&&e.classList.add('out')},1900)}}catch(e){}</script>`;
const SW_JS = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // 캐시 없이 네트워크 그대로 (로그인·재고가 항상 최신)
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || '링크몰', { body: d.body || '', icon: '/icon-192.png', badge: '/badge.png?v=${ICON_VER}', data: { url: d.url || '/my' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const u = (e.notification.data && e.notification.data.url) || '/my';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { if (c.navigate) c.navigate(u); return c.focus(); } }
    return self.clients.openWindow(u);
  }));
});
`;
const jsonOut = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
route('GET', /^\/push\/key$/, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(vapid().pub); });
route('POST', /^\/push\/subscribe$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return jsonOut(res, 401, { ok: false });
  let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
  const k = (b && b.keys) || {};
  const s = { endpoint: String((b && b.endpoint) || '').slice(0, 600), p256dh: String(k.p256dh || '').slice(0, 200), auth: String(k.auth || '').slice(0, 100) };
  if (!PUSH_HOST_RE.test(s.endpoint) || Buffer.from(s.p256dh, 'base64url').length !== 65 || Buffer.from(s.auth, 'base64url').length !== 16) return jsonOut(res, 400, { ok: false, msg: '알림 주소가 올바르지 않아요' });
  const subs = [...parseSubs(u).filter((x) => x.endpoint !== s.endpoint), s].slice(-5); // 기기 5대까지
  try { await store.updateUser(u.id, { push: JSON.stringify(subs) }); }
  catch (e) { console.error('push 저장 실패', e.message); return jsonOut(res, 500, { ok: false, msg: '저장하지 못했어요. 운영자가 데이터베이스에 push 칸을 추가해야 해요' }); }
  jsonOut(res, 200, { ok: true });
});
route('POST', /^\/push\/unsubscribe$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return jsonOut(res, 401, { ok: false });
  let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
  try { await store.updateUser(u.id, { push: JSON.stringify(parseSubs(u).filter((x) => x.endpoint !== String((b && b.endpoint) || ''))) }); } catch (e) { console.error('push 해제 실패', e.message); }
  jsonOut(res, 200, { ok: true });
});
route('POST', /^\/push\/test$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return jsonOut(res, 401, { ok: false });
  const n = await pushToUser(u.id, { title: '링크몰', body: '✅ 테스트 알림이에요. 이 기기로 알림이 와요!', url: '/my' }, 5);
  jsonOut(res, 200, { ok: n > 0, n });
});
route('GET', /^\/manifest\.json$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(MANIFEST);
});
route('GET', /^\/sw\.js$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  res.end(SW_JS);
});
// 알림 작은 아이콘(상단바): 안드로이드는 '투명 배경 + 한 가지 색' 이미지만 제대로 그려요. 불투명 아이콘을 쓰면 흰 네모로 보여요.
const ICON_BADGE = Buffer.from('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', 'base64');
route('GET', /^\/badge\.png$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(ICON_BADGE);
});
route('GET', /^\/icon-(192|512)\.png$/, (req, res, m) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(m[1] === '192' ? ICON_192 : ICON_512);
});
const DEFAULT_IMG = Buffer.from('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', 'base64');
route('GET', /^\/default-product\.jpg$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(DEFAULT_IMG);
});
const notFound = (res, msg) => send(res, 404, page('없음', `<h1>${msg}</h1>`));

// 소개 페이지: 같은 폴더의 linkmall.html 파일을 /intro 주소로 보여줘요
route('GET', /^\/intro$/, (req, res) => {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'linkmall.html'), 'utf8'); }
  catch { return notFound(res, '소개 페이지 파일(linkmall.html)이 없어요'); }
  send(res, 200, html, { 'Cache-Control': 'public, max-age=300' });
});

route('GET', /^\/$/, async (req, res) => {
  const u = await currentUser(req);
  send(res, 200, page('링크몰', `
<h1>링크몰</h1><p class="sub">링크 하나로 팔고, 결제되면 자동으로 열려요.</p>
<div class="card">${u ? '<a class="btn" href="/my">내 상점으로 가기</a>' : '<a class="btn" href="/login">로그인 · 가입하고 상점 만들기</a>'}</div>`));
});

route('GET', /^\/login$/, async (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  const next = safeNext(q.get('next'));
  const err = q.get('e');
  const signup = useMail
    ? `<form class="card" method="post" action="/signup/start"><b>처음이면 가입</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" type="email" placeholder="이메일" autocomplete="username" required maxlength="100">
${captchaHtml()}
<button>인증 코드 받기</button></form>`
    : `<form class="card" method="post" action="/signup"><b>처음이면 가입</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" placeholder="이메일" autocomplete="username" required maxlength="100">
<input name="pw" type="password" placeholder="비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
${captchaHtml()}
<button>가입하기</button></form>`;
  send(res, 200, page('로그인', `<h1>로그인</h1>${err ? `<p class="warn">${esc(err)}</p>` : ''}
<form class="card" method="post" action="/login"><b>로그인</b><input type="hidden" name="next" value="${esc(next)}">
<input name="email" placeholder="이메일" autocomplete="username" required maxlength="100">
<input name="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required maxlength="100">
<button>로그인</button></form>
${signup}`));
});

route('POST', /^\/signup\/start$/, async (req, res) => {
  const f = await readForm(req);
  const next = safeNext(f.next);
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(next)}`);
  if (!useMail) return back('이메일 인증이 설정되지 않았어요');
  if (!(await captchaOk(f, req))) return back(CAP_FAIL);
  const email = str(f.email, 100).toLowerCase();
  if (!EMAIL_RE.test(email)) return back('이메일 형식이 아니에요');
  if (await store.userByEmail(email)) return back('이미 가입된 이메일이에요');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!sendOk('e:' + email, 1, 60000)) return back('1분 뒤에 다시 요청해 주세요');
  if (!sendOk('ip:' + ip, 20, 3600000) || !sendOk('all', MAIL_DAILY, 86400000)) return back('요청이 너무 많아요. 잠시 뒤에 다시 해주세요');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ok = await sendMail(email, `[링크몰] 인증 코드 ${code}`, `<div style="font-family:sans-serif"><p>링크몰 가입 인증 코드예요.</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>10분 안에 입력해 주세요. 본인이 요청하지 않았다면 무시하세요.</p></div>`);
  if (!ok) return back('메일을 보내지 못했어요. 잠시 뒤에 다시 해주세요');
  verifyPage(res, mkToken(email, code), next, email, '');
});

route('POST', /^\/signup\/verify$/, async (req, res) => {
  const f = await readForm(req);
  const next = safeNext(f.next);
  const tok = readToken(f.t);
  if (!tok) return redirect(res, `/login?e=${enc('인증 시간이 지났어요. 다시 시도해 주세요')}&next=${enc(next)}`);
  const key = 'v:' + tok.e;
  const again = (e) => verifyPage(res, f.t, next, tok.e, e);
  if (locked(key)) return again(lockMsg(key));
  const a = Buffer.from(codeHash(tok.e, str(f.code, 6)));
  const b = Buffer.from(tok.c);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { addFail(key); return again('코드가 맞지 않아요'); }
  const pw = String(f.pw || '');
  if (pw.length < 8 || pw.length > 100) return again('비밀번호는 8자 이상이어야 해요');
  if (await store.userByEmail(tok.e)) return redirect(res, `/login?e=${enc('이미 가입된 이메일이에요')}&next=${enc(next)}`);
  const user = { id: rid(9), email: tok.e, pw: hashPw(pw), created: Date.now() };
  await store.createUser(user);
  fails.delete(key);
  redirect(res, next, { 'Set-Cookie': sessionCookie(user) });
});

route('POST', /^\/signup$/, async (req, res) => {
  const f = await readForm(req);
  if (useMail) return redirect(res, `/login?e=${enc('이메일 인증으로 가입해 주세요')}&next=${enc(safeNext(f.next))}`);
  const email = str(f.email, 100).toLowerCase();
  const pw = String(f.pw || '');
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(safeNext(f.next))}`);
  if (!(await captchaOk(f, req))) return back(CAP_FAIL);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back('이메일 형식이 아니에요');
  if (pw.length < 8 || pw.length > 100) return back('비밀번호는 8자 이상이어야 해요');
  if (await store.userByEmail(email)) return back('이미 가입된 이메일이에요');
  const user = { id: rid(9), email, pw: hashPw(pw), created: Date.now() };
  await store.createUser(user);
  redirect(res, safeNext(f.next), { 'Set-Cookie': sessionCookie(user) });
});

route('POST', /^\/login$/, async (req, res) => {
  const f = await readForm(req);
  const email = str(f.email, 100).toLowerCase();
  const back = (e) => redirect(res, `/login?e=${enc(e)}&next=${enc(safeNext(f.next))}`);
  if (locked(email)) return back(lockMsg(email));
  const user = await store.userByEmail(email);
  if (!user || !checkPw(String(f.pw || '').slice(0, 100), user.pw)) { addFail(email); return back('이메일 또는 비밀번호가 맞지 않아요'); }
  if (user.banned) return back('정지된 계정이에요');
  fails.delete(email);
  redirect(res, safeNext(f.next), { 'Set-Cookie': sessionCookie(user) });
});

route('GET', /^\/account$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/account');
  const q = new URL(req.url, BASE).searchParams;
  send(res, 200, page('계정 설정', `<a class="sub" href="/my">← 내 상점</a><h1>계정 설정</h1><p class="sub">${esc(u.email)}</p>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<form class="card" method="post" action="/account/name"><b>표시 이름</b><p class="sub">칭호 명단에 이 이름으로 보여요 (이메일은 비공개)</p>
<input name="name" value="${esc(u.name || '')}" placeholder="이름 (2~12자)" maxlength="12" autocomplete="nickname">
<button>이름 저장</button></form>
<form class="card" method="post" action="/account/password"><b>비밀번호 변경</b>
<input name="cur" type="password" placeholder="현재 비밀번호" autocomplete="current-password" required maxlength="100">
<input name="pw" type="password" placeholder="새 비밀번호 (8자 이상)" autocomplete="new-password" required minlength="8" maxlength="100">
<input name="pw2" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password" required minlength="8" maxlength="100">
<button>변경하기</button></form>`));
});

route('POST', /^\/account\/name$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/account');
  const f = await readForm(req);
  const back = (k, t) => redirect(res, `/account?${k}=${enc(t)}`);
  const name = String(f.name ?? '').replace(/\s+/g, ' ').trim();
  if (name && !/^[\p{L}\p{N} _.\-]{2,12}$/u.test(name)) return back('e', '이름은 글자·숫자·공백·_ . - 만 쓸 수 있고 2~12자여야 해요');
  try { await store.updateUser(u.id, { name }); }
  catch (e) { console.error('이름 저장 실패', e.message); return back('e', '이름을 저장하지 못했어요. 운영자가 데이터베이스에 이름 칸을 추가해야 해요'); }
  back('m', name ? '이름을 저장했어요' : '이름을 지웠어요');
});

route('POST', /^\/account\/password$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/account');
  const f = await readForm(req);
  const back = (k, t) => redirect(res, `/account?${k}=${enc(t)}`);
  const key = 'pw:' + u.id;
  if (locked(key)) return back('e', lockMsg(key));
  const cur = String(f.cur || '').slice(0, 100);
  if (!checkPw(cur, u.pw)) { addFail(key); return back('e', '현재 비밀번호가 맞지 않아요'); }
  const pw = String(f.pw || '');
  if (pw.length < 8 || pw.length > 100) return back('e', '새 비밀번호는 8자 이상이어야 해요');
  if (pw !== String(f.pw2 || '')) return back('e', '새 비밀번호 확인이 달라요');
  if (pw === cur) return back('e', '현재와 다른 비밀번호를 써주세요');
  const nu = { ...u, pw: hashPw(pw) };
  await store.updateUser(u.id, { pw: nu.pw });
  fails.delete(key);
  redirect(res, '/account?m=' + enc('비밀번호를 바꿨어요'), { 'Set-Cookie': sessionCookie(nu) });
});

route('POST', /^\/logout$/, (req, res) => redirect(res, '/', { 'Set-Cookie': clearCookie }));

route('GET', /^\/my$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const q = new URL(req.url, BASE).searchParams;
  const shops = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  const limit = shopLimit(u);
  const atLimit = shops.length >= limit;
  const pendingReq = atLimit ? await store.shopRequestByUser(u.id) : null;
  const licLeft = Number(u.license_until || 0) - Date.now();
  const siteN = await safeNotices(null);
  send(res, 200, page('내 상점', `<h1>내 상점</h1><p class="sub">${esc(u.email)} · <a href="/account">비밀번호 변경</a></p>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
${noticeBlock(siteN, '운영자 공지')}<div class="card"><a href="/wallet">내 포인트 · 칭호</a> <a href="/inquiry">운영자 문의</a>${isAdmin(u) ? ' <a href="/admin">관리자</a>' : ''}</div>
${isAdmin(u) ? '' : `<form class="card" method="post" action="/my/license"><b>자동 충전 이용권</b><p class="sub">${licLeft > 0 ? `${Math.ceil(licLeft / 86400000)}일 남음 (${fmtDay(u.license_until)}까지)` : '이용권이 없어요. 키를 등록하면 자동 충전을 쓸 수 있어요. (판매·충전 신청 등 나머지 기능은 모두 무료예요)'}</p><div class="row"><input name="key" placeholder="LK-XXXX-XXXX-XXXX-XXXX" required maxlength="40" autocapitalize="characters" autocomplete="off"><button>등록</button></div><p class="sub">모든 상점에 적용 · 키를 또 넣으면 기간이 늘어나요</p></form>`}
${shops.map((x) => `<div class="card"><b>${esc(x.name)}</b><br><a href="/m/${x.key}">관리하기</a> <a href="/s/${x.id}">상점 보기</a></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
${atLimit ? `<div class="card"><b>상점은 ${limit}개까지 만들 수 있어요 (현재 ${shops.length}개)</b>${pendingReq ? '<p class="warn">신청이 접수됐어요. 운영자가 승인하면 상점을 만들 수 있어요.</p>' : `<form method="post" action="/my/shop-request"><textarea name="note" placeholder="상점이 더 필요한 이유" required maxlength="300"></textarea><button>상점 추가 신청</button></form>`}</div>` : `<form class="card" method="post" action="/shops"><b>새 상점 만들기</b> <span class="sub">(${shops.length}/${Number.isFinite(limit) ? limit : '제한 없음'})</span><br>
<input name="name" placeholder="상점 이름" required maxlength="40">
<input name="webhook" placeholder="디스코드 웹훅 URL (선택, 판매 알림용)">
<button>상점 만들기</button></form>`}
${PUSH_CARD}
<form method="post" action="/logout"><button style="background:#6b7280">로그아웃</button></form>`));
});

route('POST', /^\/my\/license$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const f = await readForm(req);
  const fail = (t) => redirect(res, `/my?e=${enc(t)}`);
  const tr = licTries.get(u.id) || { n: 0, t: Date.now() };
  if (Date.now() - tr.t > 600000) { tr.n = 0; tr.t = Date.now(); }
  if (tr.n >= 10) return fail('시도가 너무 많아요. 10분 뒤에 다시 해주세요');
  const raw = String(f.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const key = /^LK[A-Z0-9]{16}$/.test(raw) ? `LK-${raw.slice(2, 6)}-${raw.slice(6, 10)}-${raw.slice(10, 14)}-${raw.slice(14, 18)}` : '';
  const lic = key ? await store.claimLicense(key, u.id) : null;
  if (!lic) { tr.n++; licTries.set(u.id, tr); return fail('없거나 이미 사용된 키예요'); }
  try {
    const until = Math.max(Date.now(), Number(u.license_until) || 0) + Number(lic.days) * 86400000;
    await store.updateUser(u.id, { license_until: until });
    redirect(res, `/my?m=${enc(`이용권이 등록됐어요 (${fmtDay(until)}까지)`)}`);
  } catch (e) {
    try { await store.releaseLicense(key); } catch {}
    console.error('이용권 등록 실패', e.message);
    fail('등록하지 못했어요. 운영자에게 문의해 주세요');
  }
});

route('POST', /^\/shops$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const f = await readForm(req);
  const mine = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  if (mine.length >= shopLimit(u)) return redirect(res, `/my?e=${enc('상점을 더 만들려면 운영자의 동의가 필요해요')}`);
  const shop = { id: rid(4), key: rid(12), name: str(f.name, 40), webhook: str(f.webhook, 300).split('#')[0], owner: u.id, created: Date.now() };
  await store.createShop(shop);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/my\/shop-request$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/my');
  const f = await readForm(req);
  const mine = (await store.shopsByOwner(u.id)).filter((x) => !x.deleted);
  if (mine.length < shopLimit(u)) return redirect(res, '/my');
  await store.createShopRequest({ user_id: u.id, note: str(f.note, 300), created: Date.now() });
  redirect(res, `/my?m=${enc('신청이 접수됐어요. 운영자가 확인할 때까지 기다려 주세요')}`);
});

route('POST', /^\/m\/([\w-]+)\/webhook$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const url = str(f.webhook, 300).split('#')[0];
  const on = Object.keys(NOTI).filter((k) => f['n_' + k] === '1');
  const list = parseHooks(shop.webhook);
  const idx = f.idx === undefined || f.idx === '' ? -1 : parseInt(f.idx, 10);
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  const fail = (msg) => send(res, 400, page('웹훅 저장', `<h1>저장하지 못했어요</h1><p class="warn">${esc(msg)}</p>${back}`));
  let title = '저장했어요';
  if (idx >= 0) {
    if (!list[idx]) return fail('목록이 바뀌었어요. 상점 관리로 돌아가서 다시 해주세요.');
    if (f.del === '1' || !url) { list.splice(idx, 1); title = '웹훅을 삭제했어요'; }
    else if (!HOOK_SAVE_RE.test(url)) return fail('디스코드 웹훅 주소 형식이 아니에요. https://discord.com/api/webhooks/ 로 시작해야 해요.');
    else list[idx] = { url, on };
  } else {
    if (!url) return fail('웹훅 주소를 입력해 주세요.');
    if (!HOOK_SAVE_RE.test(url)) return fail('디스코드 웹훅 주소 형식이 아니에요. https://discord.com/api/webhooks/ 로 시작해야 해요.');
    if (list.length >= MAX_HOOKS) return fail(`웹훅은 상점당 ${MAX_HOOKS}개까지 등록할 수 있어요.`);
    list.push({ url, on });
  }
  if (new Set(list.map((h) => h.url)).size !== list.length) return fail('같은 웹훅 주소가 이미 등록돼 있어요.');
  await store.updateShop(shop.id, { webhook: buildHooks(list) });
  send(res, 200, page('웹훅 저장', `<h1>${title}</h1><p class="sub">상점 관리에서 "테스트 알림 보내기"를 눌러 잘 오는지 확인해 보세요. (등록 ${list.length}/${MAX_HOOKS}개)</p>${back}`));
});

route('POST', /^\/m\/([\w-]+)\/webhook-test$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  if (!sendOk('wh:' + shop.id, 20, 86400000)) return send(res, 429, page('오늘은 여기까지', `<h1>테스트는 하루 20번까지예요</h1><p class="sub">내일 다시 해주세요.</p>${back}`));
  const rs = await testWebhooks(shop);
  if (!rs.length) return send(res, 200, page('알림 테스트', `<h1>등록된 웹훅이 없어요</h1>${back}`));
  const bad = rs.filter((x) => !x.ok);
  const lines = rs.map((x) => `<p class="${x.ok ? 'sub' : 'warn'}">웹훅 ${x.n}번: ${x.ok ? '보냈어요' : esc(x.msg)}</p>`).join('');
  send(res, 200, page('알림 테스트', `<h1>${bad.length ? '일부는 보내지 못했어요' : '보냈어요'}</h1>${lines}<p class="sub">${bad.length ? '웹훅 주소는 디스코드 채널 설정 → 연동 → 웹훅에서 다시 복사할 수 있어요.' : '각 디스코드 채널에 테스트 메시지가 왔는지 확인해 보세요.'}</p>${back}`));
});

route('POST', /^\/m\/([\w-]+)\/msgs$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  const out = {};
  for (const k of Object.keys(NOTI)) { const v = String(f['m_' + k] ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 500); if (v) out[k] = v; }
  try { await store.updateShop(shop.id, { msgs: JSON.stringify(out) }); }
  catch (e) {
    console.error('알림 메시지 저장 실패', e.message);
    return send(res, 500, page('저장 실패', `<h1>저장하지 못했어요</h1><p class="warn">데이터베이스에 알림 메시지 칸이 아직 없는 것 같아요. Supabase SQL Editor에서 <code>alter table shops add column if not exists msgs text;</code> 를 한 번 실행한 뒤 다시 저장해 주세요.</p>${back}`));
  }
  const kinds = Object.keys(out);
  const previews = kinds.map((k) => {
    const unknown = [...new Set([...out[k].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).filter((v) => !(v in MSG_DEF[k].vars)))];
    return `<div class="card"><b>${esc(NOTI[k])}</b><div style="white-space:pre-wrap;margin-top:6px">${esc(renderMsg(out[k], MSG_DEF[k].sample))}</div>${unknown.length ? `<p class="warn" style="margin:8px 0 0">모르는 변수가 있어요: ${unknown.map((v) => esc('{' + v + '}')).join(' ')} (글자 그대로 나가요)</p>` : ''}</div>`;
  }).join('');
  send(res, 200, page('알림 메시지 저장', `<h1>저장했어요</h1>${kinds.length ? `<p class="sub">이렇게 보내져요 (예시 값으로 채운 미리보기예요). 안 바꾼 종류는 기본 문장이 가요.</p>${previews}` : '<p class="sub">모든 알림이 기본 문장으로 가요.</p>'}${back}`));
});

route('GET', /^\/m\/([\w-]+)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const items = await store.itemsByShop(shop.id);
  const orders = await store.ordersForItems(items.map((i) => i.id));
  const total = orders.reduce((s, o) => s + o.price, 0);
  const waiting = await store.waitingDeposits(shop.id);
  const notices = await safeNotices(shop.id);
  const inqs = await safeInq(() => store.listInquiries(shop.id));
  const inqNames = new Map((await store.usersByIds([...new Set(inqs.map((x) => x.user_id))])).map((x) => [x.id, x.name]));
  const inqWho = (id) => '회원 ' + id.slice(0, 8) + (inqNames.get(id) ? ' (' + inqNames.get(id) + ')' : '');
  const me = await currentUser(req);
  const titles = await store.titlesByShop(shop.id);
  const holders = {};
  for (const t of titles) holders[t.id] = await store.titleHolders(t.id);
  const charges = await store.shopCharges(shop.id);
  const blockedIds = parseBlocked(shop);
  const ownerU = shop.owner ? await store.userById(shop.owner) : null;
  const licLeftM = ownerU ? Number(ownerU.license_until || 0) - Date.now() : 0;
  const licBanner = ''; // 판매·충전은 무료라 이용권 경고는 없음
  const autoOk = !!(ownerU && (isAdmin(ownerU) || licLeftM > 0)); // 자동 충전은 이용권이 있는 상점만
  const autoOn = shop.pay_mode === 'auto' && autoOk;
  const smsUrl = shop.sms_token ? BASE + '/sms/' + shop.sms_token : '';
  const payModeBlock = `<h2>충전 확인 방식</h2>
<form class="card" method="post" action="/m/${shop.key}/paymode">
<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 12px"><input type="radio" name="mode" value="manual"${autoOn ? '' : ' checked'} style="width:auto;margin:4px 0 0"><span><b>수동</b><br><span class="sub">입금을 직접 확인하고 아래 [입금 확인] 버튼을 눌러 포인트를 줘요</span></span></label>
<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 12px${autoOk ? '' : ';opacity:.5'}"><input type="radio" name="mode" value="auto"${autoOn ? ' checked' : ''}${autoOk ? '' : ' disabled'} style="width:auto;margin:4px 0 0"><span><b>자동</b><br><span class="sub">입금 문자가 오면 입금자명·금액을 맞춰 보고 포인트를 바로 줘요</span></span></label>
${autoOk ? '' : '<p class="warn">자동 충전은 라이센스 키를 등록한 상점만 쓸 수 있어요. (나머지 기능은 모두 무료예요) <a href="/my">내 상점에서 키 등록하기</a></p>'}
${shop.pay_mode === 'auto' && !autoOk ? '<p class="warn">이용권이 끝나서 자동 확인이 멈춰 있어요. 키를 다시 등록하기 전까지는 직접 승인해 주세요.</p>' : ''}
<button>저장</button></form>
${autoOn ? `<div class="card"><b>자동 충전 설정 방법</b>
<p class="sub" style="margin:6px 0 10px">입금 알림이 오는 <b>안드로이드 폰</b>에서 <b>Automate</b> 앱으로 설정해요. 아이폰은 어려워요 (수동을 쓰세요).</p>
<p style="margin:12px 0 4px"><b>0. 먼저 확인</b></p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li>위 <b>충전 받을 계좌</b>(은행·계좌번호·예금주)가 저장돼 있어야 해요.</li>
<li>충전 방식이 <b>자동</b>으로 저장돼 있어야 해요.</li>
<li>은행 앱의 <b>입금 푸시 알림</b>이 켜져 있어야 해요. (알림에 "입금 1,000원 / 홍길동 → 내 계좌"처럼 보여야 해요)</li>
</ol>
<p style="margin:14px 0 4px"><b>1. Automate 설치</b></p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li>Play 스토어에서 <b>Automate</b> (LlamaLab)를 설치하고 열어요.</li>
<li>오른쪽 아래 <b>+</b> → 새 플로우를 만들고 이름을 정해요 (예: 자동충전).</li>
</ol>
<p style="margin:14px 0 4px"><b>2. 블록 3개 만들기</b> (<b>+</b> 버튼으로 검색해서 추가)</p>
<p class="sub" style="margin:0 0 4px"><b>① Notification posted?</b> (검색: notification posted)</p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li><b>Proceed</b>를 반드시 <b>When transition</b>으로 골라요. (Immediately면 알림이 없을 때 바로 끝나 버려요)</li>
<li><b>Package name</b>에 은행 앱을 지정해요. 카카오뱅크는 <code>com.kakaobank.channel</code>, 다른 은행은 오른쪽 목록 버튼에서 앱을 골라요.</li>
<li>맨 아래 <b>Output variables</b>에서 <b>Title</b> 칸에 <code>title</code>, <b>Message</b> 칸에 <code>msg</code>를 적어요. 나머지 칸은 비워 둬요.</li>
</ol>
<p class="sub" style="margin:10px 0 4px"><b>② HTTP request</b> (검색: http request)</p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li><b>Request URL</b>: 아래 <b>내 문자 수신 주소</b>를 그대로 붙여 넣어요.</li>
<li><b>Request method</b>: POST / <b>Request content type</b>: Text</li>
<li><b>Request content body</b>: <code>title ++ " " ++ msg</code> (칸 오른쪽 <b>fx</b>를 눌러 수식 모드로 두고 입력해요). 제목과 내용을 합쳐 보내야 "입금", 입금자명, 금액이 모두 들어가요.</li>
<li>아래쪽 출력 변수 <b>Response content</b>(응답 내용) 칸에 <code>resp</code>를 적어요.</li>
</ol>
<p class="sub" style="margin:10px 0 4px"><b>③ Toast show</b> (검색: toast show, 테스트할 때 응답을 보려는 용도)</p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li><b>Message</b>: <code>resp</code> (수식 모드) / <b>Duration</b>: Long</li>
</ol>
<p style="margin:14px 0 4px"><b>3. 블록 연결</b></p>
<p style="font-size:14px;line-height:1.7;margin:0">Flow beginning → ① → (<b>YES</b>) ② → (<b>OK</b>) ③ → (<b>OK</b>) 다시 ①<br>① 의 <b>NO</b>는 연결하지 않아요. 블록의 동그란 버튼(GO·YES·OK)을 끌어다 다음 블록의 <b>IN</b>에 놓으면 돼요. 마지막 ③ OK를 ① IN에 연결해야 계속 반복돼요.</p>
<p style="margin:14px 0 4px"><b>4. 권한 켜기</b></p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li>플로우 화면의 <b>Privileges</b>에서 <b>access notifications and Do Not Disturb settings</b>를 눌러 Automate의 <b>알림 접근</b>을 허용해요. (이게 꺼져 있으면 알림을 못 읽어요)</li>
<li><b>ignore battery optimizations</b>, <b>ignore app hibernation</b>도 체크해요.</li>
<li>삼성 폰은 설정 → 배터리 → 백그라운드 사용 제한에서 Automate를 <b>절전 제외</b>로 해 주세요.</li>
</ol>
<p style="margin:14px 0 4px"><b>5. 시작하고 테스트</b></p>
<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">
<li>플로우 화면에서 <b>START</b>를 눌러요. 켜 두면 평소에는 아무 반응이 없고, 입금 알림이 올 때만 움직여요.</li>
<li>상점에서 최소 금액으로 충전을 신청해요. 입금자명은 <b>은행 앱 알림에 찍히는 이름</b> 그대로 써요.</li>
<li>그 금액을 그대로 입금하면 몇 초 안에 Toast가 뜨고 포인트가 들어가요.</li>
</ol>
<p style="margin:14px 0 4px"><b>Toast에 뜨는 글자 뜻</b></p>
<p style="font-size:14px;line-height:1.7;margin:0"><code>ok</code> 성공 · <code>ignored</code> 글에 "입금"이 없음 (제목이 빠졌는지 확인) · <code>nomatch</code> 입금자명이나 금액이 신청과 다름 · <code>ambiguous</code> 같은 이름·금액 신청이 2건 이상 (하나만 남기고 취소하거나 직접 승인) · <code>duplicate</code> 같은 문자가 2분 안에 이미 처리됨 · <code>no</code> 자동 모드가 꺼져 있거나 이용권이 없거나 주소가 틀림 · 아무 글자도 안 뜸 → 패키지명, 알림 접근 권한, START 여부 확인</p>
<p class="sub" style="margin:10px 0 4px">내 문자 수신 주소 (남에게 알려주지 마세요)</p>
<code style="font-size:13px;word-break:break-all;user-select:all;display:block;background:#f4f4f5;border-radius:12px;padding:10px 12px">${esc(smsUrl)}</code>
<button type="button" data-u="${esc(smsUrl)}" onclick="navigator.clipboard.writeText(this.dataset.u);this.textContent='복사됨'" style="margin-top:8px">주소 복사</button>
<p class="sub" style="margin:10px 0 0">· 입금자명과 금액이 신청한 것과 모두 같아야 자동으로 처리돼요.<br>· 같은 이름·같은 금액 신청이 여러 건이면 자동 처리를 건너뛰어요. 아래 충전 대기에서 직접 승인해 주세요.<br>· 자동 처리가 안 된 건은 언제든 [입금 확인] 버튼으로 줄 수 있어요.<br>· 무료 서버는 한동안 안 쓰면 잠들어서 첫 요청이 느릴 수 있어요. 응답이 늦으면 한 번 더 입금 알림을 보내 보세요.<br>· 은행이 알림 대신 <b>문자(SMS)</b>로 알려준다면 ① 대신 <b>SMS received</b> 블록을 쓰고, 문자 본문 변수를 ②의 Request content body에 넣으면 돼요.<br>· 주소가 새어 나갔다면 아래에서 다시 만들고 Automate의 주소도 바꿔 주세요.</p>
<form method="post" action="/m/${shop.key}/paymode" onsubmit="return confirm('주소를 다시 만들면 지금 쓰는 주소는 못 써요. 계속할까요?')"><input type="hidden" name="act" value="regen"><button style="background:#6b7280">주소 다시 만들기</button></form></div>` : ''}`;
  const titleOfItem = new Map(items.map((i) => [i.id, i.title]));
  const recent = [...orders].sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0)).slice(0, 20);
  const hooks = parseHooks(shop.webhook);
  const notiBoxes = (on) => Object.entries(NOTI).map(([k, label]) => `<label style="display:block;padding:5px 0;font-size:14px"><input type="checkbox" name="n_${k}" value="1" style="width:auto;padding:0;margin:0 8px 0 0;vertical-align:middle" ${on.includes(k) ? 'checked' : ''}>${label}</label>`).join('');
  const msgsNow = parseMsgs(shop);
  const msgCard = `<form class="card" method="post" action="/m/${shop.key}/msgs"><b>알림 메시지 바꾸기</b><p class="sub">{변수}는 실제 값으로 바뀌고, 비우면 기본 문장이 가요. 상점 이름은 맨 앞에 자동으로 붙어요 (<code>{shop}</code>을 넣으면 안 붙어요). 최대 500자</p>
${Object.keys(NOTI).map((k) => `<label style="display:block;margin-top:12px"><b>${esc(NOTI[k])}</b></label><textarea name="m_${k}" maxlength="500" placeholder="${esc(MSG_DEF[k].example)}">${esc(msgsNow[k] || '')}</textarea><p class="sub" style="margin:2px 0">쓸 수 있는 변수: ${Object.entries(MSG_DEF[k].vars).map(([v, d]) => `<code>{${v}}</code> ${esc(d)}`).join(' · ')}</p>`).join('')}
<button style="margin-top:10px">저장하고 미리보기</button></form>`;
  const hookCards = hooks.map((h, i) => `<form class="card" method="post" action="/m/${shop.key}/webhook"><b>웹훅 ${i + 1}</b><input type="hidden" name="idx" value="${i}"><input name="webhook" value="${esc(h.url)}" maxlength="300" autocomplete="off">
<p class="sub" style="margin:4px 0">이 웹훅으로 받을 알림</p>${notiBoxes(h.on)}
<button style="margin-top:8px">저장</button> <button name="del" value="1" style="margin-top:6px;background:#dc2626" onclick="return confirm('이 웹훅을 삭제할까요?')">삭제</button></form>`).join('');
  const hookAdd = hooks.length < MAX_HOOKS
    ? `<form class="card" method="post" action="/m/${shop.key}/webhook"><b>웹훅 추가</b><input name="webhook" placeholder="https://discord.com/api/webhooks/..." maxlength="300" autocomplete="off" required>
<p class="sub" style="margin:4px 0">이 웹훅으로 받을 알림</p>${notiBoxes(Object.keys(NOTI))}<button style="margin-top:8px">추가</button></form>`
    : `<p class="sub">웹훅을 ${MAX_HOOKS}개 다 등록했어요. 새로 추가하려면 하나를 삭제하세요.</p>`;
  send(res, 200, panelPage({ title: shop.name, heading: shop.name + ' 관리', key: 'm-' + shop.key, chip: { href: '/s/' + shop.id, label: '상점 보기' }, links: [{ href: '/s/' + shop.id, label: '상점 보기' }, { href: '/my', label: '내 상점 목록' }] }, `<!--TAB:home::개요-->
<h1>${esc(shop.name)} 관리</h1>
${licBanner}<form class="card" method="post" action="/m/${shop.key}/rename"><b>상점 이름</b><div class="row" style="margin-top:8px"><input name="name" value="${esc(shop.name)}" required maxlength="40"><button>변경</button></div></form>
<div class="card"><b>내 상점 링크 (공유하세요)</b><br><code>${BASE}/s/${shop.id}</code><br><a href="/s/${shop.id}">열어보기</a></div>
${shop.owner ? '' : (me ? `<form class="card" method="post" action="/m/${shop.key}/claim"><b>이 상점을 내 계정에 연결</b><p class="sub">연결하면 로그인한 나만 관리할 수 있어요.</p><button>내 계정에 연결</button></form>` : `<div class="warn">아직 계정에 연결되지 않은 상점이에요. <a href="/login?next=${enc('/m/' + shop.key)}">로그인</a>해서 연결하세요.</div>`)}
<!--TAB:inq::문의 ${inqs.filter((x) => !x.reply).length}건-->
<h2>받은 문의 (답변 대기 ${inqs.filter((x) => !x.reply).length}건)</h2>
<p class="sub">답변을 쓰면 문의한 사람에게 알림이 가요</p>
${inqs.map((x) => inqStaffCard(x, inqWho(x.user_id), '/m/' + shop.key + '/inquiries')).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:notice::공지-->
<h2>상점 공지</h2>
<p class="sub">고정하면 맨 위에 떠요 (최대 ${MAX_NOTICES}개)</p>
${noticeForm('/m/' + shop.key + '/notices')}
${noticeList(notices, '/m/' + shop.key + '/notices')}
<!--TAB:noti::디스코드 알림-->
<div class="card"><b>디스코드 알림</b> <span class="sub">(${hooks.length}/${MAX_HOOKS}개)</span><p class="sub">새 주문·입금·후기를 디스코드로 받아요. 웹훅마다 알림 종류를 고를 수 있어요.</p>
${hookCards}${hookAdd}
<form method="post" action="/m/${shop.key}/webhook-test" style="margin-top:8px"><button${hooks.length ? '' : ' disabled style="background:#9ca3af"'}>테스트 알림 보내기 (하루 20번까지)</button></form></div>
${msgCard}
<!--TAB:cats::메뉴 카테고리-->
<h2 id="cats">메뉴 카테고리</h2>
<p class="sub">옆 메뉴에 보이는 목록이에요. 안 넣은 공개 상품은 "그 외"에 모여요. (${parseCats(shop).length}/${MAX_CATS}개)</p>
${(parseCats(shop).length ? parseCats(shop) : [{ id: 'default', name: '상품', items: items.filter((i) => i.pub).map((i) => i.id), basic: true }]).map((c) => `<div class="card"><form method="post" action="/m/${shop.key}/cats/${c.id}/save"><input name="name" value="${esc(c.name)}" maxlength="20" required>
${items.filter((i) => i.pub).map((i) => `<label style="display:block;padding:5px 0;font-size:14px"><input type="checkbox" name="i_${i.id}" value="1"${c.items.includes(i.id) ? ' checked' : ''} style="width:auto;padding:0;margin:0 8px 0 0;vertical-align:middle">${esc(i.title)}</label>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<button style="margin-top:8px">저장</button></form>
${c.basic ? '<p class="sub" style="margin:8px 0 0">기본 카테고리예요. 수정하고 저장하면 내 카테고리가 돼요.</p>' : `<form method="post" action="/m/${shop.key}/cats/${c.id}/delete" onsubmit="return confirm('이 카테고리를 삭제할까요? (상품은 지워지지 않아요)')"><button style="margin-top:6px;background:#dc2626">카테고리 삭제</button></form>`}</div>`).join('')}
<form class="card" method="post" action="/m/${shop.key}/cats"><input name="name" placeholder="새 카테고리 이름 (예: 음식)" required maxlength="20"><button>카테고리 만들기</button></form>
<!--TAB:titles::칭호-->
<h2>칭호</h2>
<form class="card" method="post" action="/m/${shop.key}/titles"><input name="name" placeholder="새 칭호 이름 (예: VIP)" required maxlength="20"><div class="row" style="margin-bottom:8px"><input name="discount" type="number" inputmode="numeric" min="0" max="20" placeholder="할인 % (0~20)"><input name="payback" type="number" inputmode="numeric" min="0" max="20" placeholder="페이백 % (0~20)"></div><div class="row"><input name="auto_min" type="number" inputmode="numeric" min="0" step="1000" placeholder="누적 구매 N원 이상 자동 지급 (선택)"><button>만들기</button></div></form>
${titles.map((t) => `<div class="card tcard"><div class="th">${badgeHtml(t.name)} <span class="sub">${(holders[t.id] || []).length}명 보유</span>${Number(t.discount) > 0 ? `<span class="sub" style="color:#0f766e;font-weight:700">· 할인 ${Number(t.discount)}%</span>` : ''}${Number(t.payback) > 0 ? `<span class="sub" style="color:#b45309;font-weight:700">· 페이백 ${Number(t.payback)}%</span>` : ''}${Number(t.auto_min) > 0 ? `<span class="sub" style="font-weight:700">· ${Number(t.auto_min).toLocaleString('ko-KR')}원↑ 자동</span>` : ''}<form method="post" action="/m/${shop.key}/titles/${t.id}/delete" onsubmit="return confirm('칭호를 삭제하면 받은 사람에게서도 사라져요. 삭제할까요?')"><button>삭제</button></form></div>
<form method="post" action="/m/${shop.key}/titles/${t.id}/auto" style="margin-bottom:8px"><span class="sub">누적 구매 금액이 이 이상이면 자동 지급 (0=끔)</span><div class="row" style="margin-top:4px"><input name="auto_min" type="number" inputmode="numeric" min="0" step="1000" value="${Number(t.auto_min) || 0}"><span class="sub">원</span><button>저장</button></div></form>
<form method="post" action="/m/${shop.key}/titles/${t.id}/payback" class="row" style="margin-bottom:8px"><input name="payback" type="number" inputmode="numeric" min="0" max="20" value="${Number(t.payback) || 0}" style="max-width:80px;text-align:center"><span class="sub" style="white-space:nowrap">% 페이백 (0~20)</span><button>저장</button></form>
<form method="post" action="/m/${shop.key}/titles/${t.id}/discount" class="row" style="margin-bottom:8px"><input name="discount" type="number" inputmode="numeric" min="0" max="20" value="${Number(t.discount) || 0}" style="max-width:80px;text-align:center"><span class="sub" style="white-space:nowrap">% 할인 (0~20)</span><button>저장</button></form>
<form method="post" action="/m/${shop.key}/titles/${t.id}/grant" class="row"><input name="code" placeholder="회원번호 8자리" required minlength="8" maxlength="12"><button>주기</button></form>
${(holders[t.id] || []).length ? `<div class="chips">${(holders[t.id] || []).map((h) => `<form method="post" action="/m/${shop.key}/titles/${t.id}/revoke" class="chip2" onsubmit="return confirm('이 회원의 칭호를 회수할까요?')"><input type="hidden" name="uid" value="${esc(h.user_id)}"><span>${esc(h.user_id.slice(0, 8))}</span><button title="회수">✕</button></form>`).join('')}</div>` : ''}</div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:blocks::차단-->
<h2>차단 목록 (${blockedIds.length})</h2>
<form class="card row" method="post" action="/m/${shop.key}/blocks"><input name="code" placeholder="차단할 회원번호 8자리" required minlength="8" maxlength="12"><button style="background:#dc2626">차단</button></form>
${blockedIds.length ? `<div class="chips" style="margin-bottom:12px">${blockedIds.map((id) => `<form method="post" action="/m/${shop.key}/blocks/remove" class="chip2" onsubmit="return confirm('차단을 해제할까요?')"><input type="hidden" name="uid" value="${esc(id)}"><span>${esc(id.slice(0, 8))}</span><button title="해제">✕</button></form>`).join('')}</div>` : '<p class="sub">차단한 회원이 없어요 (차단하면 구매·충전이 막혀요)</p>'}
<!--TAB:money::충전·포인트-->
<h2>충전 받을 계좌</h2>
<form class="card" method="post" action="/m/${shop.key}/pay">
<div class="row"><input name="bank" placeholder="은행" value="${esc(shop.bank)}" maxlength="20"><input name="holder" placeholder="예금주" value="${esc(shop.holder)}" maxlength="20"></div>
<input name="account" placeholder="계좌번호" value="${esc(shop.account)}" maxlength="40" inputmode="numeric" style="margin-top:8px">
<button>저장</button><p class="sub">충전할 때 보이는 계좌예요. 은행·계좌번호·예금주를 모두 적어야 열리고, 비우면 꺼져요.</p></form>
${payModeBlock}
<h2>충전 대기 ${charges.length}건</h2>
${charges.map((c) => `<div class="card"><b>${esc(c.name)}</b> <span class="price">${won(c.amount)}</span><br><span class="sub">회원 ${esc(c.user_id.slice(0, 8))} · ${fmtDate(c.created)}${Date.now() > c.created + CHARGE_TTL ? ' · 기한 지남' : ''}</span>
${c.image ? `<p style="margin:8px 0"><a href="/m/${shop.key}/charges/${c.token}/img" target="_blank">입금 사진 보기</a></p>` : ''}
<form method="post" action="/m/${shop.key}/charges/${c.token}/confirm"><button>입금 확인 (포인트 지급)</button></form>
<form method="post" action="/m/${shop.key}/charges/${c.token}/reject"><button style="background:#6b7280">거절</button></form></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<h2>포인트 직접 조정</h2>
<form class="card" method="post" action="/m/${shop.key}/points"><input name="code" placeholder="회원번호 8자리" required minlength="8" maxlength="12"><input name="delta" type="number" placeholder="증감 (예: 1000 또는 -500)" required><input name="note" placeholder="메모 (선택)" maxlength="40"><button>조정</button></form>
<!--TAB:orders::매출·주문-->
<h2>매출 ${won(total)} · 판매 ${orders.reduce((a, o) => a + orderQty(o), 0)}건</h2>
<h2>최근 주문</h2>
${recent.map((o) => { const bc = o.buyer ? String(o.buyer).slice(0, 8) : ''; return `<div class="card tcard"><div class="row"><div style="flex:1;min-width:0"><b>${esc(titleOfItem.get(o.item) || '삭제된 상품')}</b><br><span class="sub">${won(o.price)} · ${fmtDate(o.paidAt)}<br>구매자 ${bc ? esc(bc) : '미연결'}</span></div>${bc ? (blockedIds.includes(o.buyer) ? '<span class="sub">차단됨</span>' : `<form method="post" action="/m/${shop.key}/blocks" onsubmit="return confirm('이 회원을 차단할까요?')" style="margin:0"><input type="hidden" name="code" value="${esc(bc)}"><button style="width:auto;padding:8px 14px;font-size:13px;background:#dc2626;border-radius:12px">차단</button></form>`) : ''}</div></div>`; }).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:items::상품-->
<h2>아이템 추가</h2>
<form class="card" method="post" action="/m/${shop.key}/items">
<input name="title" placeholder="제목" required maxlength="80">
<input name="price" type="number" min="100" step="100" placeholder="가격 (원)" required>
<textarea name="preview" placeholder="미리보기 (결제 전 공개되는 설명)" required></textarea>
<textarea name="secret" placeholder="잠금 정보 (결제 후에만 공개: 내용, 링크 등). 재고를 쓰면 비워도 돼요"></textarea>
<textarea name="stock" placeholder="재고 (선택). 한 줄에 하나씩 적으면 구매할 때마다 한 줄씩 순서대로 지급돼요. 예) 치킨버거 ⏎ 불고기버거. 비우면 재고 제한 없이 같은 잠금 정보를 보여줘요"></textarea>
<input name="buy_limit" type="number" inputmode="numeric" min="1" max="100000" placeholder="인당 구매 한도 (선택, 한 사람이 살 수 있는 최대 개수)">
${imgField('')}
${titleSelect(titles, '')}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" checked style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>등록</button></form>
<h2>내 아이템</h2>
${items.map((i) => `<div class="card">${i.image ? `<img src="/img/${i.id}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:12px;float:right;margin-left:10px">` : ''}<b>${esc(i.title)}</b> <span class="price">${won(i.price)}</span> <span class="sub">· ${i.pub ? '공개' : '비공개(링크로만)'}${i.stock != null ? ` · 재고 ${stockLines(i.stock).length}개` : ''}${itemLimit(i) ? ` · 인당 ${itemLimit(i)}개` : ''}</span><br><a href="/i/${i.id}">${BASE}/i/${i.id}</a><br><a href="/m/${shop.key}/items/${i.id}/edit">수정·삭제</a></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}`));
});

route('POST', /^\/m\/([\w-]+)\/items$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  const secret = String(f.secret || '').slice(0, 10000);
  const stock = parseStock(f.stock);
  if (!secret.trim() && !stock) return send(res, 400, page('오류', '<h1>잠금 정보나 재고 중 하나는 적어주세요</h1>'));
  const item = { id: rid(9), shop: shop.id, pub: f.pub === 'on', title: String(f.title).slice(0, 80), price, preview: String(f.preview).slice(0, 2000), secret, created: Date.now() };
  if (stock) item.stock = stock;
  const img = cleanImage(f.image); if (img) item.image = img;
  if (f.title_id) { const t = await store.titleById(String(f.title_id)); if (t && t.shop === shop.id) item.title_id = t.id; }
  const bl = parseLimit(f.buy_limit); if (bl) item.buy_limit = bl;
  try { await store.createItem(item); }
  catch (e) {
    if (!bl) throw e;
    console.error('구매 한도 저장 실패 (items.buy_limit 칸이 있나요?)', e.message);
    return send(res, 500, page('저장 실패', `<h1>저장하지 못했어요</h1><p class="warn">데이터베이스에 구매 한도 칸이 아직 없는 것 같아요. Supabase SQL Editor에서 <code>${LIMIT_SQL}</code> 를 한 번 실행한 뒤 다시 등록해 주세요.</p><p><a href="/m/${shop.key}">← 상점 관리로</a></p>`));
  }
  redirect(res, `/m/${shop.key}`);
});

route('GET', /^\/m\/([\w-]+)\/items\/([\w-]+)\/edit$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  const sold = (await store.ordersForItems([item.id])).length;
  const titles = await store.titlesByShop(shop.id);
  send(res, 200, page('아이템 수정', `<a class="sub" href="/m/${shop.key}">← 관리로 돌아가기</a>
<h1>아이템 수정</h1>
${sold ? `<p class="warn">이미 ${sold}건 팔렸어요. 가격을 바꿔도 이전 주문 금액은 그대로이고, 잠금 정보를 바꾸면 이전 구매자에게도 바뀐 내용이 보여요.</p>` : ''}
<form class="card" method="post" action="/m/${shop.key}/items/${item.id}">
<input name="title" value="${esc(item.title)}" required maxlength="80">
<input name="price" type="number" min="100" step="100" value="${esc(item.price)}" required>
<textarea name="preview" required>${esc(item.preview)}</textarea>
<textarea name="secret" placeholder="잠금 정보 (재고를 쓰면 비워도 돼요)">${esc(item.secret)}</textarea>
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="use_stock" ${item.stock != null ? 'checked' : ''} style="width:auto;margin:0"> 재고 사용 (한 줄에 하나, 구매할 때마다 순서대로 지급)</label>
<textarea name="stock" placeholder="남은 재고 (한 줄에 하나)">${esc(item.stock || '')}</textarea>
<input name="buy_limit" type="number" inputmode="numeric" min="1" max="100000" value="${itemLimit(item) || ''}" placeholder="인당 구매 한도 (비우면 제한 없음)">
<p class="sub" style="margin:-6px 0 10px">한 사람이 이 상품을 살 수 있는 최대 개수예요 (지금까지 산 개수 포함). 한도가 있는 상품은 포인트로만 살 수 있어요.</p>
${imgField(item.image ? item.id : '')}
${titleSelect(titles, item.title_id)}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" ${item.pub ? 'checked' : ''} style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>저장</button></form>
<h2>삭제</h2>
${sold ? '<p class="sub">판매 기록이 있는 아이템은 삭제할 수 없어요. 구매자가 계속 열람해야 하니까요. 대신 위에서 공개를 꺼서 목록에서 숨기세요.</p>'
 : `<form method="post" action="/m/${shop.key}/items/${item.id}/delete" onsubmit="return confirm('정말 삭제할까요? 되돌릴 수 없어요.')"><button style="background:#dc2626">이 아이템 삭제</button></form>`}`));
});

route('POST', /^\/m\/([\w-]+)\/items\/([\w-]+)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  const useStock = f.use_stock === 'on';
  const secret = String(f.secret || '').slice(0, 10000);
  const stock = useStock ? parseStock(f.stock) : null;
  if (!secret.trim() && !useStock) return send(res, 400, page('오류', '<h1>잠금 정보나 재고 중 하나는 적어주세요</h1>'));
  const upd = { pub: f.pub === 'on', title: String(f.title).slice(0, 80), price, preview: String(f.preview).slice(0, 2000), secret };
  const img = cleanImage(f.image);
  if (img) upd.image = img; else if (f.del_image === 'on' && item.image) upd.image = null;
  if (useStock || item.stock != null) { upd.stock = stock; upd.stock_ver = (item.stock_ver || 0) + 1; }
  let tid = null;
  if (f.title_id) { const t = await store.titleById(String(f.title_id)); if (t && t.shop === shop.id) tid = t.id; }
  if (tid || item.title_id) upd.title_id = tid;
  const bl = parseLimit(f.buy_limit);
  if (bl) upd.buy_limit = bl; else if (item.buy_limit != null) upd.buy_limit = null;
  try { await store.updateItem(item.id, upd); }
  catch (e) {
    if (!bl) throw e;
    console.error('구매 한도 저장 실패 (items.buy_limit 칸이 있나요?)', e.message);
    return send(res, 500, page('저장 실패', `<h1>저장하지 못했어요</h1><p class="warn">데이터베이스에 구매 한도 칸이 아직 없는 것 같아요. Supabase SQL Editor에서 <code>${LIMIT_SQL}</code> 를 한 번 실행한 뒤 다시 저장해 주세요.</p><p><a href="/m/${shop.key}">← 상점 관리로</a></p>`));
  }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/items\/([\w-]+)\/delete$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const item = await store.itemById(m[2]);
  if (!item || item.shop !== shop.id) return notFound(res, '아이템을 찾을 수 없어요');
  if ((await store.ordersForItems([item.id])).length) return send(res, 400, page('삭제 불가', `<h1>판매 기록이 있어 삭제할 수 없어요</h1><p><a href="/m/${shop.key}/items/${item.id}/edit">돌아가기</a></p>`));
  await store.deleteItem(item.id);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/claim$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/m/' + shop.key));
  if (!shop.owner) await store.updateShop(shop.id, { owner: u.id });
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/rename$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const name = str(f.name, 40);
  if (!name) return send(res, 400, page('오류', `<h1>상점 이름을 적어주세요</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  await store.updateShop(shop.id, { name });
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/blocks$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  const code = str(f.code, 12);
  if (!/^[\w-]{8,12}$/.test(code)) return back('회원번호는 8자리예요');
  const target = await store.userByCode(code);
  if (!target) return back('그 회원번호의 사용자를 찾을 수 없어요');
  if (target.id === shop.owner || isAdmin(target)) return back('상점 주인과 운영자는 차단할 수 없어요');
  const list = parseBlocked(shop);
  if (!list.includes(target.id)) {
    if (list.length >= 200) return back('차단은 200명까지 할 수 있어요');
    list.push(target.id);
    await store.updateShop(shop.id, { blocked: JSON.stringify(list) });
  }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/blocks\/remove$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const uid = str(f.uid, 60);
  await store.updateShop(shop.id, { blocked: JSON.stringify(parseBlocked(shop).filter((x) => x !== uid)) });
  redirect(res, `/m/${shop.key}`);
});

// 충전 확인 방식 저장 (수동/자동) · 문자 수신 주소 재발급. 자동은 이용권이 있는 상점만
route('POST', /^\/m\/([\w-]+)\/paymode$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const back = `<p><a href="/m/${shop.key}">← 상점 관리로</a></p>`;
  const deny = (t) => send(res, 403, page('설정할 수 없어요', `<h1>${t}</h1>${back}`));
  const act = str(f.act, 10);
  if (act === 'regen') {
    if (!(await autoAllowed(shop))) return deny('자동 충전은 라이센스 키가 있어야 써요');
    try { await store.updateShop(shop.id, { sms_token: rid(20) }); }
    catch (e) { console.error('문자 주소 저장 실패', e.message); return send(res, 500, page('저장 실패', `<h1>저장하지 못했어요</h1><p class="warn">데이터베이스에 칸이 아직 없는 것 같아요. Supabase SQL Editor에서 <code>${PAYMODE_SQL}</code> 를 한 번 실행한 뒤 다시 해 주세요.</p>${back}`)); }
    return redirect(res, `/m/${shop.key}`);
  }
  const mode = f.mode === 'auto' ? 'auto' : 'manual';
  const upd = { pay_mode: mode };
  if (mode === 'auto') {
    if (!(await autoAllowed(shop))) return deny('자동 충전은 라이센스 키를 등록해야 쓸 수 있어요. 내 상점에서 키를 먼저 등록해 주세요.');
    if (!(shop.bank && shop.account && shop.holder)) return deny('먼저 충전 받을 계좌(은행·계좌번호·예금주)를 저장해 주세요');
    if (!shop.sms_token) upd.sms_token = rid(20);
  }
  try { await store.updateShop(shop.id, upd); }
  catch (e) {
    console.error('충전 방식 저장 실패', e.message);
    return send(res, 500, page('저장 실패', `<h1>저장하지 못했어요</h1><p class="warn">데이터베이스에 칸이 아직 없는 것 같아요. Supabase SQL Editor에서 <code>${PAYMODE_SQL}</code> 를 한 번 실행한 뒤 다시 저장해 주세요.</p>${back}`));
  }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/pay$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const upd = { bank: str(f.bank, 20), account: str(f.account, 40), holder: str(f.holder, 20) };
  await store.updateShop(shop.id, upd);
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/deposits\/([\w-]+)\/confirm$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const dep = await store.depositByToken(m[2]);
  if (dep && dep.shop === shop.id) {
    const order = await confirmDeposit(dep);
    if (!order) return send(res, 400, page('확인 불가', `<h1>재고가 없어서 확인할 수 없어요</h1><p class="sub">입금자에게 환불해 주세요. 재고를 채운 뒤 다시 확인하면 열려요.</p><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/i\/([\w-]+)\/deposit$/, async (req, res, m) => {
  const dUser = await currentUser(req);
  if (!dUser) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || !shop.bank || !shop.account) return send(res, 400, page('오류', '<h1>이 상점은 계좌 입금을 받지 않아요</h1>'));
  if (isBlocked(shop, dUser.id)) return send(res, 403, page('이용 제한', `<h1>${BLOCKED_MSG}</h1>`));
  if (!(await licenseOk(shop))) return send(res, 403, page('이용 불가', `<h1>${NO_LICENSE_MSG}</h1>`));
  if (itemLimit(item)) return send(res, 400, page('포인트 전용', `<h1>인당 구매 한도가 있는 상품이에요</h1><p class="sub">한도가 있는 상품은 상점 포인트로만 살 수 있어요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const f = await readForm(req);
  const name = str(f.name, 20);
  if (name.length < 2) return send(res, 400, page('오류', `<h1>입금자명을 2자 이상 적어주세요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const dep = { token: rid(16), item: item.id, shop: shop.id, name, amount: Number(item.price), status: 'waiting', created: Date.now() };
  await store.createDeposit(dep);
  await notify(shop, `⏳ 입금 대기: ${item.title} (${won(dep.amount)}) · 입금자명 ${name}`, 'deposit', { item: item.title, price: won(dep.amount), name, shop: shop.name, link: BASE + '/i/' + item.id });
  redirect(res, `/o/${dep.token}`);
});

// 입금 문자 수신 (자동 확인). 문자 내용에 '입금', 대기 중인 주문/충전의 입금자명, 금액이 모두 있으면 확인
route('POST', /^\/sms\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopBySms(m[1]);
  if (!shop || shop.pay_mode !== 'auto' || !(await autoAllowed(shop))) { res.writeHead(404); return res.end('no'); } // 이용권이 끝나면 자동 확인도 멈춤
  let text = await readBody(req);
  try { const j = JSON.parse(text); if (j && typeof j === 'object') text = Object.values(j).join(' '); } catch {}
  let result = 'ignored';
  if (/입금/.test(text)) {
    const now = Date.now();
    for (const [k, t] of smsSeen) if (now - t > 120000) smsSeen.delete(k);
    const dk = shop.id + ':' + crypto.createHash('sha1').update(text).digest('hex');
    if (smsSeen.has(dk)) { res.writeHead(200); return res.end('duplicate'); }
    const flat = text.replace(/\s/g, '');
    const plain = text.replace(/,/g, '');
    const same = (x) => flat.includes(String(x.name).replace(/\s/g, '')) && new RegExp('(^|\\D)' + Number(x.amount) + '(\\D|$)').test(plain);
    const hitD = (await store.waitingDeposits(shop.id)).filter((d) => now <= d.created + DEP_TTL && same(d));
    const hitC = (await store.shopCharges(shop.id)).filter((c) => now <= c.created + CHARGE_TTL && same(c));
    if (hitD.length + hitC.length === 1) {
      if (hitD.length) { await confirmDeposit(hitD[0]); result = 'ok'; }
      else if (await confirmCharge(hitC[0])) {
        result = 'ok';
        await notify(shop, `💰 충전 자동 확인: ${hitC[0].name} · ${won(hitC[0].amount)} 포인트를 지급했어요`, 'charge');
      } else result = 'failed';
      if (result === 'ok') smsSeen.set(dk, now);
    }
    else if (hitD.length + hitC.length > 1) { result = 'ambiguous'; } // 같은 이름·금액이 여러 건이면 자동 처리 안 함 → 관리 페이지에서 직접 승인
    else result = 'nomatch';
  }
  res.writeHead(200); res.end(result);
});

route('GET', /^\/claim\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopByKey(m[1]);
  if (!shop) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/claim/' + shop.key));
  if (shop.owner) return send(res, 403, page('이미 주인이 있어요', '<h1>이미 주인이 있는 상점이에요</h1>'));
  send(res, 200, page('상점 연결', `<h1>${esc(shop.name)}</h1><p class="sub">이 상점을 내 계정(${esc(u.email)})에 연결할까요? 연결하면 로그인한 나만 관리할 수 있어요.</p><form method="post" action="/m/${shop.key}/claim"><button>내 계정에 연결</button></form>`));
});

// 이 상점 포인트로 구매 (재고형 아이템은 qty개를 한 번에)
const buyHandler = async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shopB = await store.shopById(item.shop);
  if (!shopB || shopB.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  if (isBlocked(shopB, u.id)) return send(res, 403, page('이용 제한', `<h1>${BLOCKED_MSG}</h1>`));
  if (!(await licenseOk(shopB))) return send(res, 403, page('이용 불가', `<h1>${NO_LICENSE_MSG}</h1>`));
  const f = await readForm(req);
  const multi = item.stock != null;
  let qty = multi ? parseInt(f.qty, 10) : 1;
  if (!(qty >= 1)) qty = 1;
  if (qty > MAX_QTY) return send(res, 400, page('수량 초과', `<h1>한 번에 최대 ${MAX_QTY}개까지 살 수 있어요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const limB = itemLimit(item);
  if (limB) {
    const have = await boughtCount(item, u.id);
    if (have + qty > limB) return send(res, 400, page('구매 한도', `<h1>인당 구매 한도를 넘어요</h1><p class="sub">이 상품은 한 사람이 ${limB}개까지 살 수 있어요. 지금까지 ${have}개 샀고, ${Math.max(0, limB - have)}개 더 살 수 있어요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
  }
  const discB = await discountOf(u.id, item.shop);
  const unit = discPrice(item.price, discB);
  const total = unit * qty;
  const soldOut = () => send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  let lines = null;
  let soldLast = false; // 이번 구매로 재고가 0이 됐는지
  if (multi) {
    lines = await store.popStockN(item.id, qty);
    if (lines == null) {
      const now = await store.itemById(item.id);
      const left = now && now.stock != null ? stockLines(now.stock).length : 0;
      if (!left) return soldOut();
      return send(res, 400, page('재고 부족', `<h1>재고가 ${left}개만 남았어요</h1><p class="sub">${qty}개는 살 수 없어요. 수량을 줄여서 다시 시도해 주세요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
    }
    const after = await store.itemById(item.id);
    soldLast = !!after && !stockLines(after.stock).length;
  }
  const bal = await store.addShopPoints(u.id, item.shop, -total);
  if (bal == null) {
    if (lines) await restoreLines(item.id, lines);
    return send(res, 400, page('포인트 부족', `<h1>이 상점 포인트가 부족해요</h1><p class="sub">${qty > 1 ? `${qty}개 ` : ''}${pts(total)}가 필요해요.</p><p><a href="/w/${item.shop}">충전하러 가기</a></p>`));
  }
  const order = { token: rid(16), item: item.id, price: total, paidAt: Date.now(), buyer: u.id, ...(lines ? { delivered: lines.join('\n') } : {}) };
  try { await store.createOrder(order); }
  catch (e) { await store.addShopPoints(u.id, item.shop, total); if (lines) await restoreLines(item.id, lines); throw e; }
  try { await store.addLedger({ id: rid(9), user_id: u.id, shop: item.shop, delta: -total, kind: 'buy', ref: order.token, note: qty > 1 ? `${item.title} × ${qty}` : item.title, created: Date.now() }); } catch (e) { console.error('ledger', e.message); }
  try { // 칭호 페이백: 결제한 금액의 N%를 이 상점 포인트로 돌려줘요
    const pb = await paybackOf(u.id, item.shop);
    const back = Math.floor(total * pb / 100);
    if (pb > 0 && back > 0) {
      await store.addShopPoints(u.id, item.shop, back);
      await store.addLedger({ id: rid(9), user_id: u.id, shop: item.shop, delta: back, kind: 'payback', ref: order.token, note: `칭호 페이백 ${pb}%`, created: Date.now() });
    }
  } catch (e) { console.error('페이백 실패', e.message); }
  if (item.title_id) { const t = await store.titleById(item.title_id); if (t) await store.grantTitle(u.id, t.id, item.shop); }
  try { // 이 상점에서 누적 구매 금액이 기준 이상이면 칭호 자동 지급
    const autoTitles = (await store.titlesByShop(item.shop)).filter((t) => Number(t.auto_min) > 0);
    if (autoTitles.length) {
      const spent = (await store.ordersForItems((await store.itemsByShop(item.shop)).map((i) => i.id))).filter((o) => o.buyer === u.id).reduce((a, o) => a + Number(o.price || 0), 0);
      for (const t of autoTitles) if (spent >= Number(t.auto_min)) await store.grantTitle(u.id, t.id, item.shop);
    }
  } catch (e) { console.error('자동 칭호 실패', e.message); }
  const shopN = await store.shopById(item.shop);
  await notify(shopN, `💰 새 주문! ${item.title}${qty > 1 ? ` × ${qty}` : ''} (${won(total)})`, 'sale', saleVars(shopN, item, total, qty));
  if (soldLast) await notify(shopN, `📦 재고가 0이 됐어요: ${item.title}. 재고를 채워주세요.`, 'stock', { item: item.title, shop: shopN ? shopN.name : '', link: BASE + '/i/' + item.id });
  redirect(res, `/o/${order.token}`);
};
route('POST', /^\/i\/([\w-]+)\/buy$/, async (req, res, m) => {
  const u = await currentUser(req);
  const k = (u ? u.id : '') + '|' + m[1];
  if (u && buyLocks.has(k)) return send(res, 429, page('처리 중', `<h1>처리 중이에요</h1><p class="sub">이미 구매를 처리하고 있어요. 잠시 뒤에 내 구매 내역을 확인해 주세요.</p><p><a href="/i/${esc(m[1])}">돌아가기</a></p>`));
  if (u) buyLocks.add(k);
  try { return await buyHandler(req, res, m); } finally { buyLocks.delete(k); }
});

// 내 포인트 · 칭호 (상점별 목록)
route('GET', /^\/wallet$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/wallet');
  const rows = await store.userShopPoints(u.id);
  const titles = await store.userTitles(u.id);
  const byShop = new Map();
  for (const t of titles) { if (!byShop.has(t.shop)) byShop.set(t.shop, []); byShop.get(t.shop).push(t); }
  const titleRows = [];
  for (const [sid, list] of byShop) {
    const sh = await store.shopById(sid);
    if (!sh || sh.deleted) continue;
    const dMax = Math.max(0, ...list.map((t) => Math.min(20, Number(t.discount) || 0)));
    const pMax = Math.max(0, ...list.map((t) => Math.min(20, Number(t.payback) || 0)));
    titleRows.push(`<a class="ca" href="/s/${sh.id}"><div class="card"><b>${esc(sh.name)}</b>${dMax ? ` <span class="sub" style="color:#0f766e;font-weight:700">· ${dMax}% 할인</span>` : ''}${pMax ? ` <span class="sub" style="color:#b45309;font-weight:700">· ${pMax}% 페이백</span>` : ''}<br>${list.map((t) => badgeHtml(t.name)).join('')}</div></a>`);
  }
  const cards = [];
  for (const r of rows) { const sh = await store.shopById(r.shop); if (sh) cards.push(`<a class="ca" href="/w/${sh.id}"><div class="card"><b>${esc(sh.name)}</b><br><span class="price">${pts(r.points)}</span></div></a>`); }
  send(res, 200, page('내 포인트', `<a class="sub" href="/my">← 내 상점</a><h1>내 포인트</h1><p class="sub">포인트는 충전한 상점에서만 쓸 수 있어요 (1P = 1원). 회원번호 <b>${esc(u.id.slice(0, 8))}</b> · 칭호를 받을 때 판매자에게 알려주세요.</p>
<p class="sub">표시 이름: <b>${u.name ? esc(u.name) : '아직 없어요'}</b> · <a href="/account">${u.name ? '바꾸기' : '정하기'}</a><br>이름을 정해두면 칭호를 받은 상점 맨 아래 명단에 이 이름으로 보여요.</p>
${titleRows.length ? `<h2>내 칭호</h2>${titleRows.join('')}` : ''}
<h2>상점별 포인트</h2>
${cards.join('') || '<p class="sub">아직 충전한 상점이 없어요. 상점 페이지에서 포인트를 충전해 보세요.</p>'}`));
});

// 상점 전용 지갑: 충전 신청 / 입금 안내 / 내역
route('GET', /^\/w\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + shop.id));
  const q = new URL(req.url, BASE).searchParams;
  const blockedMe = isBlocked(shop, u.id);
  const licOkW = await licenseOk(shop);
  const autoW = shop.pay_mode === 'auto' && await autoAllowed(shop);
  const canCharge = !blockedMe && licOkW && !!(shop.bank && shop.account && shop.holder);
  const bal = await store.shopPoints(u.id, shop.id);
  const pending = (await store.userShopCharges(u.id, shop.id)).filter((c) => Date.now() <= c.created + CHARGE_TTL);
  const log = await store.ledgerForUserShop(u.id, shop.id);
  const label = { charge: '충전', buy: '구매', admin: '상점 조정', payback: '페이백' };
  send(res, 200, page(shop.name + ' 포인트', `<a class="sub" href="/s/${shop.id}">← ${esc(shop.name)}</a><h1>${esc(shop.name)} 포인트</h1>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<div class="card"><span class="sub">보유 포인트 (1P = 1원 · 이 상점에서만 사용)</span><br><span class="price" style="font-size:28px">${pts(bal)}</span></div>
<h2>포인트 충전</h2>
${canCharge ? `<form class="card" method="post" action="/w/${shop.id}/charge">
<input name="amount" type="number" min="${MIN_CHARGE}" max="${MAX_CHARGE}" step="100" placeholder="충전 금액 (${MIN_CHARGE.toLocaleString('ko-KR')}원 이상)" required>
<input name="name" placeholder="입금자명 (은행 앱에 찍히는 내 이름)" required minlength="2" maxlength="20">
<input type="hidden" name="image" id="cim"><div class="row" style="margin:0 0 10px"><label for="cif" style="display:inline-block;background:#f4f4f5;border-radius:12px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer">입금 사진 (선택)</label><span id="cin" class="sub"></span></div><input type="file" id="cif" accept="image/*" style="display:none"><img id="cip" alt="" style="display:none;width:100%;max-height:200px;object-fit:contain;border-radius:12px;margin:0 0 10px">
<script>(function(){var f=document.getElementById('cif'),v=document.getElementById('cim'),p=document.getElementById('cip'),n=document.getElementById('cin');f.onchange=function(){var file=f.files[0];if(!file)return;var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){var s=Math.min(1,900/Math.max(im.width,im.height));var c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(im,0,0,c.width,c.height);var d=c.toDataURL('image/jpeg',0.7);v.value=d;p.src=d;p.style.display='block';n.textContent='사진 첨부됨'};im.onerror=function(){alert('이 사진은 읽을 수 없어요');f.value='';v.value=''};im.src=r.result};r.readAsDataURL(file)}})();</script>
<button>충전 신청</button><p class="sub">${autoW ? '신청 후 아래 계좌로 입금하면 입금 문자가 확인되는 대로 포인트가 자동으로 들어와요. 입금자명과 금액이 신청한 것과 똑같아야 해요.' : '신청 후 아래 계좌로 입금하면, 상점 운영자가 입금을 확인한 뒤 포인트가 들어와요.'} 충전한 포인트는 환불되지 않아요.</p></form>` : (blockedMe ? `<p class="warn">${BLOCKED_MSG}</p>` : !licOkW ? '<p class="warn">지금은 판매가 중단된 상점이라 충전할 수 없어요</p>' : '<p class="warn">이 상점은 아직 충전을 받지 않아요</p>')}
${pending.map((c) => `<div class="card"><b>입금해 주세요</b><br>${esc(shop.bank)} <b>${esc(shop.account)}</b> (예금주 ${esc(shop.holder)})<br><span class="price">${won(c.amount)}</span><br><span class="sub">입금자명 <b>${esc(c.name)}</b> 그대로 · 기한 ${fmtDate(c.created + CHARGE_TTL)}<br>${autoW ? '입금 문자가 확인되면 포인트가 들어와요' : '운영자가 확인하면 포인트가 들어와요'} (20초마다 자동 확인)</span>
<form method="post" action="/w/${shop.id}/charge/${c.token}/cancel"><button style="background:#6b7280">신청 취소</button></form></div>`).join('')}
${pending.length ? '<script>setTimeout(function(){location.reload()},20000)</script>' : ''}
<h2>내역</h2>
${log.map((l) => `<div class="card"><span class="sub">${fmtDate(l.created)}</span><br>${l.kind === 'buy' ? `<a href="/o/${esc(l.ref)}">${esc(label.buy)} · ${esc(l.note)}</a>` : `${esc(label[l.kind] || l.kind)}${l.note && (l.kind === 'admin' || l.kind === 'payback') ? ' · ' + esc(l.note) : ''}`} <b>${l.delta > 0 ? '+' : ''}${Number(l.delta).toLocaleString('ko-KR')}P</b></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}`));
});

route('POST', /^\/w\/([\w-]+)\/charge$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + shop.id));
  const f = await readForm(req);
  const back = (k, t) => redirect(res, `/w/${shop.id}?${k}=${enc(t)}`);
  if (isBlocked(shop, u.id)) return back('e', BLOCKED_MSG);
  if (!(await licenseOk(shop))) return back('e', NO_LICENSE_MSG);
  if (!(shop.bank && shop.account && shop.holder)) return back('e', '이 상점은 아직 충전을 받지 않아요');
  const amount = parseInt(f.amount, 10);
  const name = str(f.name, 20);
  if (!(amount >= MIN_CHARGE && amount <= MAX_CHARGE)) return back('e', `충전 금액은 ${MIN_CHARGE.toLocaleString('ko-KR')}원~${MAX_CHARGE.toLocaleString('ko-KR')}원이에요`);
  if (name.length < 2) return back('e', '입금자명을 2자 이상 적어주세요');
  const active = (await store.userShopCharges(u.id, shop.id)).filter((c) => Date.now() <= c.created + CHARGE_TTL);
  if (active.length >= 3) return back('e', '입금 대기 중인 신청이 3건이에요. 하나를 취소하거나 입금한 뒤에 신청해 주세요');
  const chg = { token: rid(12), user_id: u.id, shop: shop.id, amount, name, status: 'waiting', created: Date.now() };
  const chImg = cleanImage(f.image); if (chImg) chg.image = chImg;
  await store.createCharge(chg);
  await notify(shop, `⏳ 충전 신청: ${name} · ${won(amount)} — ${shop.pay_mode === 'auto' && (await autoAllowed(shop)) ? '입금 문자가 오면 자동으로 지급돼요' : '입금을 확인하고 관리 페이지에서 승인해 주세요'}`, 'charge', { name, price: won(amount), shop: shop.name });
  back('m', '충전 신청이 접수됐어요. 아래 계좌로 입금해 주세요');
});

route('POST', /^\/w\/([\w-]+)\/charge\/([\w-]+)\/cancel$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/w/' + m[1]));
  const c = await store.chargeByToken(m[2]);
  if (c && c.user_id === u.id && c.shop === m[1]) await store.claimCharge(c.token, 'cancelled');
  redirect(res, `/w/${m[1]}`);
});

// 상점 운영자: 충전 승인/거절, 포인트 직접 조정
route('POST', /^\/m\/([\w-]+)\/charges\/([\w-]+)\/(confirm|reject)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const c = await store.chargeByToken(m[2]);
  if (c && c.shop === shop.id) { if (m[3] === 'confirm') await confirmCharge(c); else await store.claimCharge(c.token, 'rejected'); }
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/points$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  const code = str(f.code, 12);
  const delta = parseInt(f.delta, 10);
  if (!/^[\w-]{8,12}$/.test(code)) return back('회원번호는 8자리예요');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000000) return back('증감 금액이 올바르지 않아요');
  const target = await store.userByCode(code);
  if (!target) return back('그 회원번호의 사용자를 찾을 수 없어요');
  const bal = await store.addShopPoints(target.id, shop.id, delta);
  if (bal == null) return back('보유 포인트보다 많이 차감할 수 없어요');
  await store.addLedger({ id: rid(9), user_id: target.id, shop: shop.id, delta, kind: 'admin', ref: shop.id, note: str(f.note, 40), created: Date.now() });
  redirect(res, `/m/${shop.key}`);
});

// 칭호 만들기 / 주기 / 회수 / 삭제 (상점 주인)
// 메뉴 카테고리 만들기 / 이름·상품 고르기 저장 / 삭제
route('POST', /^\/m\/([\w-]+)\/cats$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const name = str(f.name, 20);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  if (!name) return back('카테고리 이름을 적어주세요');
  const cats = parseCats(shop);
  if (cats.length >= MAX_CATS) return back(`카테고리는 ${MAX_CATS}개까지 만들 수 있어요`);
  cats.push({ id: rid(6), name, items: [] });
  await store.updateShop(shop.id, { cats: JSON.stringify(cats) });
  redirect(res, `/m/${shop.key}#cats`);
});
route('POST', /^\/m\/([\w-]+)\/cats\/([\w-]+)\/(save|delete)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  let cats = parseCats(shop);
  let c = cats.find((x) => x.id === m[2]);
  if (!c && m[2] === 'default' && !cats.length) { c = { id: rid(6), name: '상품', items: [] }; cats.push(c); } // 기본 "상품"을 처음 저장하면 진짜 카테고리가 됨
  if (!c) return notFound(res, '카테고리를 찾을 수 없어요');
  if (m[3] === 'delete') cats = cats.filter((x) => x !== c);
  else {
    c.name = str(f.name, 20) || c.name;
    const mine = new Set((await store.itemsByShop(shop.id)).map((i) => i.id));
    c.items = [...mine].filter((id) => f['i_' + id]);
  }
  await store.updateShop(shop.id, { cats: JSON.stringify(cats) });
  redirect(res, `/m/${shop.key}#cats`);
});

route('POST', /^\/m\/([\w-]+)\/titles$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const name = str(f.name, 20);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  if (!name) return back('칭호 이름을 적어주세요');
  if ((await store.titlesByShop(shop.id)).length >= 10) return back('칭호는 상점당 10개까지 만들 수 있어요');
  const dsc = Math.max(0, Math.min(20, parseInt(f.discount, 10) || 0));
  const autoMin = Math.max(0, Math.min(100000000, parseInt(f.auto_min, 10) || 0));
  const pbk = Math.max(0, Math.min(20, parseInt(f.payback, 10) || 0));
  await store.createTitle({ id: rid(6), shop: shop.id, name, created: Date.now(), ...(dsc ? { discount: dsc } : {}), ...(autoMin ? { auto_min: autoMin } : {}), ...(pbk ? { payback: pbk } : {}) });
  redirect(res, `/m/${shop.key}`);
});

route('POST', /^\/m\/([\w-]+)\/titles\/([\w-]+)\/(grant|revoke|delete|discount|auto|payback)$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const t = await store.titleById(m[2]);
  if (!t || t.shop !== shop.id) return notFound(res, '칭호를 찾을 수 없어요');
  const f = await readForm(req);
  const back = (msg) => send(res, 400, page('오류', `<h1>${esc(msg)}</h1><p><a href="/m/${shop.key}">돌아가기</a></p>`));
  if (m[3] === 'delete') await store.deleteTitle(t.id);
  else if (m[3] === 'payback') await store.updateTitle(t.id, { payback: Math.max(0, Math.min(20, parseInt(f.payback, 10) || 0)) });
  else if (m[3] === 'auto') await store.updateTitle(t.id, { auto_min: Math.max(0, Math.min(100000000, parseInt(f.auto_min, 10) || 0)) });
  else if (m[3] === 'discount') await store.updateTitle(t.id, { discount: Math.max(0, Math.min(20, parseInt(f.discount, 10) || 0)) });
  else if (m[3] === 'revoke') { const uid = str(f.uid, 12); if (/^[\w-]{8,12}$/.test(uid)) await store.revokeTitle(uid, t.id); }
  else {
    const code = str(f.code, 12);
    if (!/^[\w-]{8,12}$/.test(code)) return back('회원번호는 8자리예요');
    const target = await store.userByCode(code);
    if (!target) return back('그 회원번호의 사용자를 찾을 수 없어요');
    await store.grantTitle(target.id, t.id, shop.id);
  }
  redirect(res, `/m/${shop.key}`);
});

// 운영자 페이지: 모든 사용자 정지/해제, 모든 상점 관리 진입
route('GET', /^\/admin$/, async (req, res) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const q = new URL(req.url, BASE).searchParams;
  const search = str(q.get('q'), 50);
  const users = await store.listUsers(search);
  const sq = str(q.get('sq'), 50); // 상점 검색: 상점 이름 또는 주인 이메일
  const owners = sq ? await store.listUsers(sq) : [];
  const shops = sq ? await store.searchShops(sq, owners.map((o) => o.id)) : await store.allShops();
  const reqs = await store.listShopRequests();
  const licenses = await store.listLicenses();
  const adminNotices = await safeNotices(null);
  const emailMap = new Map(users.map((x) => [x.id, x.email]));
  for (const o of owners) emailMap.set(o.id, o.email);
  if (sq) for (const sh of shops) if (sh.owner && !emailMap.has(sh.owner)) { const x = await store.userById(sh.owner); if (x) emailMap.set(x.id, x.email); }
  for (const r of reqs) if (!emailMap.has(r.user_id)) { const x = await store.userById(r.user_id); if (x) emailMap.set(x.id, x.email); }
  const siteInq = await safeInq(() => store.listInquiries(null));
  for (const r of siteInq) if (!emailMap.has(r.user_id)) { const x = await store.userById(r.user_id); if (x) emailMap.set(x.id, x.email); }
  const emailOf = (id) => emailMap.get(id) || (id ? id.slice(0, 8) : '없음');
  send(res, 200, panelPage({ title: '운영자', heading: '운영자', key: 'admin', chip: { href: '/my', label: STORE_ICO, aria: '내 상점' }, links: [{ href: '/my', label: '내 상점' }] }, `${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
<!--TAB:reqs::상점 신청 ${reqs.length}건-->
<h2>상점 추가 신청 ${reqs.length}건</h2>
${reqs.map((r) => `<div class="card"><b>${esc(emailOf(r.user_id))}</b><br><span class="sub" style="white-space:pre-wrap">${esc(r.note)}</span>
<form method="post" action="/admin/requests/${r.user_id}/approve"><button>승인 (상점 1개 더 허용)</button></form>
<form method="post" action="/admin/requests/${r.user_id}/reject"><button style="background:#6b7280">거절</button></form></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:inq::문의 ${siteInq.filter((x) => !x.reply).length}건-->
<h2>받은 문의 (답변 대기 ${siteInq.filter((x) => !x.reply).length}건)</h2>
<p class="sub">답변하면 문의한 사람에게 알림이 가요</p>
${siteInq.map((x) => inqStaffCard(x, emailOf(x.user_id), '/admin/inquiries')).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:shops::상점-->
<h2>상점 (${shops.length})</h2>
<form method="get" action="/admin"><input name="sq" placeholder="상점 이름 또는 주인 이메일 검색" value="${esc(sq)}"><input type="hidden" name="q" value="${esc(search)}"><button>검색</button>${sq ? '<p class="sub"><a href="/admin' + (search ? '?q=' + enc(search) : '') + '">검색 지우기</a></p>' : ''}</form>
${shops.map((sh) => `<div class="card"><b>${esc(sh.name)}</b>${sh.deleted ? ' 삭제됨' : ''}<br><span class="sub">주인 ${esc(emailOf(sh.owner))}</span><br><a href="/m/${sh.key}">관리하기</a>${sh.deleted ? '' : ` <a href="/s/${sh.id}">보기</a>`}
${sh.deleted ? `<form method="post" action="/admin/shops/${sh.id}/restore"><button style="background:#0f766e">복구</button></form><form method="post" action="/admin/shops/${sh.id}/purge" onsubmit="return confirm('${esc(sh.name).replace(/&#39;/g, '')} 상점을 영구 삭제할까요?\\n아이템·주문·후기·충전·포인트 기록이 모두 지워지고, 구매자도 구매한 내용을 다시 볼 수 없어요. 절대 되돌릴 수 없어요.')"><button style="background:#7f1d1d;margin-top:6px">영구 삭제</button></form>` : `<form method="post" action="/admin/shops/${sh.id}/delete" onsubmit="return confirm('이 상점을 삭제할까요? 사이트에서 사라지고 새 구매·충전이 막혀요. (복구할 수 있어요)')"><button style="background:#dc2626">상점 삭제</button></form>`}</div>`).join('') || `<p class="sub">${sq ? '검색 결과가 없어요' : '상점이 없어요'}</p>`}
<!--TAB:keys::라이센스 키-->
<h2>라이센스 키 (자동 충전 전용)</h2>
<form class="card" method="post" action="/admin/licenses"><div class="row"><input name="days" type="number" inputmode="numeric" min="1" max="36500" placeholder="기간 (일)" required><input name="count" type="number" inputmode="numeric" min="1" max="20" value="1" style="max-width:80px;text-align:center"></div><input name="note" placeholder="메모 (선택, 예: 홍길동)" maxlength="40" style="margin-top:8px"><button style="margin-top:8px">키 발급</button><p class="sub">기간은 일 단위, 오른쪽 칸은 발급 개수(최대 20). 영구는 36500일.</p></form>
${licenses.map((k) => `<div class="card tcard"><code style="font-size:14px;font-weight:700;user-select:all">${esc(k.key)}</code><br><span class="sub">${Number(k.days)}일${k.note ? ' · ' + esc(k.note) : ''} · ${k.used_by ? `사용됨 (회원번호 ${esc(String(k.used_by).slice(0, 8))} · ${fmtDay(k.used_at)})` : '미사용'}</span>${k.used_by ? '' : `<div class="acts"><button type="button" style="padding:10px;font-size:14px;border-radius:14px;background:#f4f4f5;color:#18181b" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(k.key)}');this.textContent='복사됨'">복사</button><form method="post" action="/admin/licenses/delete" onsubmit="return confirm('이 키를 삭제할까요?')"><input type="hidden" name="key" value="${esc(k.key)}"><button>삭제</button></form></div>`}</div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:users::사용자-->
<h2>사용자</h2>
<form method="get" action="/admin" class="row"><input type="hidden" name="sq" value="${esc(sq)}"><input name="q" placeholder="이메일 검색" value="${esc(search)}"><button>검색</button></form>
${users.map((x) => { const made = shops.filter((sh) => sh.owner === x.id && !sh.deleted).length; return `<div class="card ucard"><div class="em">${esc(x.email)}${x.banned ? ' · 정지' : ''}${isAdmin(x) ? ' · 운영자' : ''}</div><div class="sub">회원번호 ${esc(x.id.slice(0, 8))}${x.banned ? ' · 정지됨' : ''}${Number(x.license_until) > Date.now() ? ' · ' + fmtDay(x.license_until) + '까지' : ''}</div>
${isAdmin(x) ? '' : `<form method="post" action="/admin/users/${x.id}/limit" class="row" style="margin-top:10px"><span class="sub" style="white-space:nowrap">한도 (${made}개 만듦)</span><input name="n" type="number" min="0" max="100" value="${shopLimit(x)}" required style="max-width:80px;padding:11px;text-align:center"><button>저장</button></form>
<div class="acts"><form method="post" action="/admin/users/${x.id}/ban"><input type="hidden" name="v" value="${x.banned ? 0 : 1}"><button style="background:${x.banned ? '#0f766e' : '#dc2626'}">${x.banned ? '정지 해제' : '계정 정지'}</button></form></div>
<details><summary>더 보기 (탈퇴)</summary><form method="post" action="/admin/users/${x.id}/delete" onsubmit="return confirm('${esc(x.email)} 회원을 탈퇴시킬까요?\\n포인트·칭호가 지워지고, 이 회원의 상점은 삭제 처리돼요. 되돌릴 수 없어요.')"><button style="background:#7f1d1d">회원 탈퇴시키기</button></form></details>`}</div>`; }).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:notice::공지-->
<h2>운영자 공지</h2>
<p class="sub">고정하면 맨 위에 떠요 (최대 ${MAX_NOTICES}개)</p>
${noticeForm('/admin/notices')}
${noticeList(adminNotices, '/admin/notices')}`));
});

route('POST', /^\/admin\/notices$/, async (req, res) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const n = noticeFields(await readForm(req));
  if (!n.title || !n.body) return redirect(res, `/admin?e=${enc('제목과 내용을 모두 적어주세요')}`);
  try {
    if ((await store.listNotices(null)).length >= MAX_NOTICES) return redirect(res, `/admin?e=${enc(`공지는 ${MAX_NOTICES}개까지 올릴 수 있어요. 오래된 공지를 삭제해 주세요`)}`);
    await store.createNotice({ id: rid(6), shop: null, ...n, created: Date.now() });
  } catch (e) {
    console.error('공지 저장 실패', e.message);
    return redirect(res, `/admin?e=${enc('공지를 저장하지 못했어요. 데이터베이스에 공지 표가 아직 없는 것 같아요. Supabase SQL Editor에서 다음을 한 번 실행해 주세요: ' + NOTICE_SQL)}`);
  }
  redirect(res, `/admin?m=${enc('공지를 올렸어요')}`);
});
route('POST', /^\/admin\/notices\/([\w-]+)\/delete$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  try { const n = await store.noticeById(m[1]); if (n && !n.shop) await store.deleteNotice(n.id); } catch (e) { console.error('공지 삭제 실패', e.message); }
  redirect(res, `/admin?m=${enc('공지를 삭제했어요')}`);
});
route('POST', /^\/m\/([\w-]+)\/notices$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const back = `<p><a href="/m/${shop.key}#notice">← 상점 관리로</a></p>`;
  const n = noticeFields(await readForm(req));
  if (!n.title || !n.body) return send(res, 400, page('공지', `<h1>제목과 내용을 모두 적어주세요</h1>${back}`));
  try {
    if ((await store.listNotices(shop.id)).length >= MAX_NOTICES) return send(res, 400, page('공지', `<h1>공지는 ${MAX_NOTICES}개까지 올릴 수 있어요</h1><p class="sub">오래된 공지를 삭제한 뒤 다시 올려 주세요.</p>${back}`));
    await store.createNotice({ id: rid(6), shop: shop.id, ...n, created: Date.now() });
  } catch (e) {
    console.error('공지 저장 실패', e.message);
    return send(res, 500, page('저장 실패', `<h1>공지를 저장하지 못했어요</h1><p class="warn">공지 기능이 아직 준비되지 않았어요. 운영자에게 알려주세요.</p>${back}`));
  }
  redirect(res, `/m/${shop.key}#notice`);
});
route('POST', /^\/m\/([\w-]+)\/notices\/([\w-]+)\/delete$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  try { const n = await store.noticeById(m[2]); if (n && n.shop === shop.id) await store.deleteNotice(n.id); } catch (e) { console.error('공지 삭제 실패', e.message); }
  redirect(res, `/m/${shop.key}#notice`);
});

route('POST', /^\/admin\/licenses$/, async (req, res) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  const days = parseInt(f.days, 10);
  const count = Math.max(1, Math.min(20, parseInt(f.count, 10) || 1));
  if (!(days >= 1 && days <= 36500)) return redirect(res, `/admin?e=${enc('기간은 1~36500일 사이로 넣어주세요')}`);
  const note = str(f.note, 40);
  const made = [];
  for (let i = 0; i < count; i++) { const key = newLicenseKey(); await store.createLicense({ key, days, created: Date.now(), note }); made.push(key); }
  redirect(res, `/admin?m=${enc(`${days}일 키 ${count}개 발급: ${made.join(' / ')}`)}`);
});

route('POST', /^\/admin\/licenses\/delete$/, async (req, res) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  await store.deleteUnusedLicense(str(f.key, 40));
  redirect(res, `/admin?m=${enc('키를 삭제했어요')}`);
});

route('POST', /^\/admin\/shops\/([\w-]+)\/(delete|restore)$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const sh = await store.shopById(m[1]);
  if (!sh) return redirect(res, `/admin?e=${enc('상점을 찾을 수 없어요')}`);
  await store.updateShop(sh.id, { deleted: m[2] === 'delete' });
  redirect(res, `/admin?m=${enc(m[2] === 'delete' ? '상점을 삭제했어요' : '상점을 복구했어요')}`);
});

// 상점 영구 삭제: 먼저 '상점 삭제'(휴지통)한 상점만 가능 — 실수 방지용 2단계
route('POST', /^\/admin\/shops\/([\w-]+)\/purge$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const sh = await store.shopById(m[1]);
  if (!sh) return done('e', '상점을 찾을 수 없어요');
  if (!sh.deleted) return done('e', '먼저 "상점 삭제"를 한 뒤에 영구 삭제할 수 있어요');
  try {
    await store.purgeShop(sh.id);
    done('m', `${sh.name} 상점을 영구 삭제했어요`);
  } catch (e) { console.error('상점 영구 삭제 실패', e); done('e', '영구 삭제 중 문제가 생겼어요. 잠시 뒤 다시 해주세요'); }
});

route('POST', /^\/admin\/requests\/([\w-]+)\/(approve|reject)$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const target = await store.userById(m[1]);
  if (target && m[2] === 'approve') await store.updateUser(target.id, { extra_shops: Number(target.extra_shops || 0) + 1 });
  await store.deleteShopRequest(m[1]);
  redirect(res, `/admin?m=${enc(m[2] === 'approve' ? '승인했어요. 상점을 1개 더 만들 수 있어요' : '신청을 거절했어요')}`);
});

// 사람마다 상점 한도 정하기 (0~100개, 기본값으로 되돌리기 가능)
route('POST', /^\/admin\/users\/([\w-]+)\/limit$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 한도가 없어요');
  if (f.reset === '1') { await store.updateUser(target.id, { extra_shops: 0 }); return done('m', `${target.email} 한도를 기본값(${FREE_SHOPS}개)으로 되돌렸어요`); }
  const n = parseInt(f.n, 10);
  if (!(n >= 0 && n <= 100)) return done('e', '한도는 0~100 사이 숫자로 넣어주세요');
  await store.updateUser(target.id, { extra_shops: n - FREE_SHOPS });
  done('m', `${target.email} 상점 한도를 ${n}개로 정했어요`);
});

route('POST', /^\/admin\/users\/([\w-]+)\/delete$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 탈퇴시킬 수 없어요');
  try {
    // 이 회원의 상점은 삭제 처리하고 주인 연결을 끊어요 (관리자 화면에서 복구는 가능)
    const mine = await store.shopsByOwner(target.id);
    for (const sh of mine) await store.updateShop(sh.id, { deleted: true, owner: null });
    await store.deleteUser(target.id);
    done('m', `${target.email} 회원을 탈퇴시켰어요${mine.length ? ` (상점 ${mine.length}개는 삭제 처리했어요)` : ''}`);
  } catch (e) { console.error('회원 탈퇴 실패', e); done('e', '탈퇴 처리 중 문제가 생겼어요. 잠시 뒤 다시 해주세요'); }
});

route('POST', /^\/admin\/users\/([\w-]+)\/ban$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const f = await readForm(req);
  const done = (k, t) => redirect(res, `/admin?${k}=${enc(t)}`);
  const target = await store.userById(m[1]);
  if (!target) return done('e', '사용자를 찾을 수 없어요');
  if (isAdmin(target)) return done('e', '운영자 계정은 정지할 수 없어요');
  await store.updateUser(target.id, { banned: f.v === '1' });
  done('m', f.v === '1' ? '계정을 정지했어요' : '정지를 풀었어요');
});

route('GET', /^\/m\/([\w-]+)\/charges\/([\w-]+)\/img$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const c = await store.chargeByToken(m[2]);
  const mm = c && c.shop === shop.id && typeof c.image === 'string' && c.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!mm) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.from(mm[2], 'base64'));
});

route('GET', /^\/img\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  const mm = item && typeof item.image === 'string' && item.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!mm) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.from(mm[2], 'base64'));
});

// 상점 맨 아래에 작게: 칭호별로 가진 사람 이름을 쭉 나열 (이름을 안 정한 회원은 "익명 + 번호 앞 4자리")
async function titleRoster(shop) {
  try {
    const titles = await store.titlesByShop(shop.id);
    if (!titles.length) return '';
    const rows = await store.titleHoldersMany(titles.map((t) => t.id));
    if (!rows.length) return '';
    const users = await store.usersByIds([...new Set(rows.map((r) => r.user_id))]);
    const nm = new Map(users.map((u) => [u.id, u.name]));
    const nameOf = (id) => esc(nm.get(id) || '익명 ' + id.slice(0, 4));
    const lines = titles.map((t) => {
      const hs = rows.filter((r) => r.title === t.id);
      if (!hs.length) return '';
      return `<div style="margin:3px 0"><b>${esc(t.name)}</b> · ${hs.slice(0, 30).map((h) => nameOf(h.user_id)).join(', ')}${hs.length > 30 ? ` 외 ${hs.length - 30}명` : ''}</div>`;
    }).join('');
    return lines ? `<div class="sm" style="margin:40px 0 8px;padding-top:14px;border-top:1px solid rgba(128,128,128,.25);font-size:12px;line-height:1.6"><div style="margin-bottom:4px">칭호 명단</div>${lines}</div>` : '';
  } catch (e) { console.error('칭호 명단 실패', e.message); return ''; }
}

route('GET', /^\/s\/([\w-]+)$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const siteN = await safeNotices(null);
  const shopN = await safeNotices(shop.id);
  const rmap = new Map();
  for (const r of await store.reviewsByShop(shop.id)) { const a = rmap.get(r.item) || { n: 0, sum: 0 }; a.n += 1; a.sum += r.rating; rmap.set(r.item, a); }
  const card = (i) => {
    const rv = rmap.get(i.id);
    const left = i.stock != null ? stockLines(i.stock).length : null;
    const stockTxt = left == null ? '무제한' : left ? `${left}개` : '품절';
    return `<a class="pc${left === 0 ? ' off' : ''}" href="/i/${i.id}"><div class="im"><img src="${i.image ? `/img/${i.id}` : `/default-product.jpg?v=${ICON_VER}`}" alt="" loading="lazy"></div><div class="pb"><h2>${esc(i.title)}</h2>
<div class="rt">${ICO.star}<span>${rv ? (rv.sum / rv.n).toFixed(1) : '-'}</span>${rv ? `<span class="sm">(${rv.n})</span>` : ''}</div>
<div class="pr"><b>${won(i.price)}</b><span>재고: <b>${stockTxt}</b></span></div></div></a>`;
  };
  send(res, 200, shopPage(shop, shop.name, noticeBlock(siteN, '운영자 공지') + noticeBlock(shopN, '상점 공지') + (items.length ? PRODUCT_SEARCH_BOX + `<div class="pg">${items.map(card).join('')}</div>` + PRODUCT_SEARCH_JS : '<p class="sm"><i class="empty">비어 있어요</i></p>') + await titleRoster(shop), me, bal, '/s/' + shop.id, 'items', navGroups(shop, items)));
});

// 통계: 평점, 총 팔린 횟수, 이번 주(월~일) 날짜별 팔린 횟수 그래프, 상품별 판매
route('GET', /^\/s\/([\w-]+)\/stats$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const orders = await store.ordersForItems(items.map((i) => i.id));
  const reviews = await store.reviewsByShop(shop.id);
  const KST = 9 * 3600e3;
  const dayKey = (t) => new Date(Number(t) + KST).toISOString().slice(0, 10);
  const nowK = new Date(Date.now() + KST);
  const dow = (nowK.getUTCDay() + 6) % 7; // 월=0 … 일=6
  const days = [...Array(7)].map((_, n) => { const d = new Date(Date.UTC(nowK.getUTCFullYear(), nowK.getUTCMonth(), nowK.getUTCDate() - dow + n)); return { key: d.toISOString().slice(0, 10), label: '월화수목금토일'[n], md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, n: 0, today: n === dow, future: n > dow }; });
  const byDay = new Map(days.map((d) => [d.key, d]));
  const sold = new Map();
  let total = 0;
  for (const o of orders) {
    const q = orderQty(o); total += q;
    sold.set(o.item, (sold.get(o.item) || 0) + q);
    const d = byDay.get(dayKey(o.paidAt)); if (d) d.n += q;
  }
  const weekTotal = days.reduce((a, d) => a + d.n, 0);
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  const W = 320, H = 170, bw = 28, gap = (W - bw * 7) / 8, base = 138, top = 26;
  const chart = (vals, fmt) => { const mx = Math.max(1, ...vals); return days.map((d, n) => { const v = vals[n];
    const x = gap + n * (bw + gap), h = v ? Math.max(6, Math.round((base - top) * v / mx)) : 0;
    return `<g><rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="8" fill="${d.today ? '#18181b' : '#a1a1aa'}"${d.future ? ' opacity=".35"' : ''}/>${!d.future ? `<text x="${x + bw / 2}" y="${base - h - 7}" text-anchor="middle" font-size="12" font-weight="700" fill="#18181b">${fmt(v)}</text>` : ''}<text x="${x + bw / 2}" y="${base + 17}" text-anchor="middle" font-size="12" font-weight="${d.today ? 800 : 500}" fill="${d.today ? '#18181b' : '#71717a'}">${d.label}</text><text x="${x + bw / 2}" y="${base + 31}" text-anchor="middle" font-size="9.5" fill="#a1a1aa">${d.md}</text></g>`;
  }).join(''); };
  const bars = chart(days.map((d) => d.n), String);
  // 매출은 이 상점 주인과 운영자에게만 (비공개 상품 매출도 포함)
  const canRev = !!me && (me.id === shop.owner || isAdmin(me));
  let revBlock = '';
  if (canRev) {
    const allItems = await store.itemsByShop(shop.id);
    const titleOf = new Map(allItems.map((i) => [i.id, i.title]));
    const rOrders = await store.ordersForItems(allItems.map((i) => i.id));
    const dayRev = days.map(() => 0); const itemRev = new Map(); let revTotal = 0;
    for (const o of rOrders) {
      const p = Number(o.price) || 0; revTotal += p; itemRev.set(o.item, (itemRev.get(o.item) || 0) + p);
      const k = days.findIndex((d) => d.key === dayKey(o.paidAt)); if (k >= 0) dayRev[k] += p;
    }
    const short = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '만' : n.toLocaleString('ko-KR'));
    const rrank = [...itemRev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rmx = Math.max(1, ...rrank.map((r) => r[1]));
    revBlock = `<div class="bx" style="border-color:#18181b"><b style="font-size:17px">매출</b> <span class="sm">판매자·운영자에게만 보여요</span>
<div class="sg" style="margin-top:12px"><div class="bx" style="margin:0;background:#fff"><span class="sm">총 매출</span><b class="sv" style="font-size:22px">${won(revTotal)}</b></div><div class="bx" style="margin:0;background:#fff"><span class="sm">이번 주 매출</span><b class="sv" style="font-size:22px">${won(dayRev.reduce((a, b) => a + b, 0))}</b></div></div>
<svg viewBox="0 0 ${W} ${H + 10}" width="100%" role="img" aria-label="이번 주 날짜별 매출 그래프" style="margin-top:10px;display:block"><line x1="8" y1="${base}" x2="${W - 8}" y2="${base}" stroke="#e4e4e7"/>${chart(dayRev, short)}</svg>
<b style="font-size:15px;display:block;margin-top:6px">상품별 매출</b>
${rrank.length ? rrank.map(([id, v]) => `<div style="margin-top:12px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:14px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleOf.get(id) || '')}</span><b>${won(v)}</b></div><div style="height:8px;border-radius:4px;background:#e4e4e7;margin-top:5px;overflow:hidden"><div style="height:100%;width:${Math.round(100 * v / rmx)}%;background:#18181b;border-radius:4px"></div></div></div>`).join('') : '<p class="sm"><i class="empty">비어 있어요</i></p>'}</div>`;
  }
  const rank = items.map((i) => ({ i, n: sold.get(i.id) || 0 })).sort((a, b) => b.n - a.n).slice(0, 10);
  const rmax = Math.max(1, ...rank.map((r) => r.n));
  const body = `<h1 style="font-size:24px;margin:6px 0 14px">${ICO.chart} 통계</h1>
${revBlock}
<div class="sg"><div class="bx"><span class="sm">평점</span><b class="sv">${reviews.length ? '★ ' + avg.toFixed(1) : '-'}</b><span class="sm">후기 ${reviews.length}개</span></div>
<div class="bx"><span class="sm">총 팔린 횟수</span><b class="sv">${total.toLocaleString('ko-KR')}</b><span class="sm">지금까지</span></div></div>
<div class="bx"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:17px">이번 주 판매</b><span class="sm">${weekTotal}번 팔렸어요</span></div>
<svg viewBox="0 0 ${W} ${H + 10}" width="100%" role="img" aria-label="이번 주 날짜별 판매 횟수 그래프" style="margin-top:8px;display:block"><line x1="8" y1="${base}" x2="${W - 8}" y2="${base}" stroke="#e4e4e7"/>${bars}</svg></div>
<div class="bx"><b style="font-size:17px">상품별 팔린 횟수</b>
${rank.length ? rank.map((r) => `<div style="margin-top:12px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:14px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.i.title)}</span><b>${r.n}</b></div><div style="height:8px;border-radius:4px;background:#e4e4e7;margin-top:5px;overflow:hidden"><div style="height:100%;width:${Math.round(100 * r.n / rmax)}%;background:#18181b;border-radius:4px"></div></div></div>`).join('') : '<p class="sm"><i class="empty">비어 있어요</i></p>'}</div>`;
  send(res, 200, shopPage(shop, '통계', body, me, bal, '/s/' + shop.id + '/stats', 'stats', navGroups(shop, items)));
});

route('GET', /^\/i\/([\w-]+)$/, async (req, res, m) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || shop.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  const sold = (await store.ordersForItems([item.id])).reduce((a, o) => a + orderQty(o), 0);
  const me = await currentUser(req);
  const bal = me ? await store.shopPoints(me.id, shop.id) : 0;
  const reviews = await store.reviewsForItem(item.id);
  const canMod = !!me && (me.id === shop.owner || isAdmin(me));
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  const blockedMe = isBlocked(shop, me && me.id);
  const licOk = await licenseOk(shop);
  const disc = blockedMe ? 0 : await discountOf(me && me.id, shop.id);
  const left = item.stock != null ? stockLines(item.stock).length : null;
  const stockTxt = left == null ? '무제한' : left ? `${left}개` : '품절';
  const lim = itemLimit(item);
  const haveN = lim && me ? await boughtCount(item, me.id) : 0;
  const remain = lim ? Math.max(0, lim - haveN) : null;
  const body = `<a class="sm" style="text-decoration:none" href="/s/${shop.id}">← ${esc(shop.name)}</a>
<div class="pc" style="margin-top:12px"><div class="im" style="aspect-ratio:4/3"><img src="${item.image ? `/img/${item.id}` : `/default-product.jpg?v=${ICON_VER}`}" alt=""></div><div class="pb"><h2>${esc(item.title)}</h2>
<div class="rt">${ICO.star}<span>${reviews.length ? avg.toFixed(1) : '-'}</span>${reviews.length ? `<span class="sm">(${reviews.length})</span>` : ''}<span class="sm" style="margin-left:auto">판매 ${sold}건</span></div>
<div class="pr">${disc ? `<span><s class="sm">${won(item.price)}</s> <b>${won(discPrice(item.price, disc))}</b> <span class="sm">(${disc}% 할인)</span></span>` : `<b>${won(item.price)}</b>`}<span>재고: <b>${stockTxt}</b></span></div></div></div>
${item.preview ? `<div class="bx" style="white-space:pre-wrap">${esc(item.preview)}</div>` : ''}
${lim ? `<div class="nt">인당 ${lim}개까지 살 수 있어요${me ? ` (내가 산 개수 ${haveN}개 · 남은 ${remain}개)` : ''}</div>` : ''}
${left === 0 ? '<div class="nt">품절이에요</div>' : !licOk ? '<div class="nt">지금은 판매가 중단된 상점이에요</div>' : blockedMe ? `<div class="nt">${BLOCKED_MSG}</div>` : remain === 0 ? '<div class="nt">인당 구매 한도에 도달해서 더 살 수 없어요</div>' : pointsBlock(item, me, bal, shop, disc, remain)}
<p style="margin:14px 0 0"><a class="sm" href="/s/${shop.id}/inquiry?item=${item.id}">이 상품 문의하기</a></p>
<h3 style="font-size:20px;margin:30px 0 10px">후기 ${reviews.length ? `${avg.toFixed(1)} (${reviews.length})` : ''}</h3>
${reviews.map((r) => `<div class="bx">${stars(r.rating)} <span class="sm">구매자 ${esc(r.user_id.slice(0, 4))} · ${new Date(Number(r.created)).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><br><span style="white-space:pre-wrap">${esc(r.body)}</span>${canMod ? `<form method="post" action="/i/${item.id}/reviews/${r.id}/delete" onsubmit="return confirm('이 후기를 삭제할까요?')"><button class="bb" style="background:#dc2626;margin-top:10px;padding:12px;font-size:15px">후기 삭제</button></form>` : ''}</div>`).join('') || '<p class="sm">아직 후기가 없어요. 구매한 사람이 남길 수 있어요.</p>'}`;
  const navItems = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  send(res, 200, shopPage(shop, item.title, body, me, bal, '/i/' + item.id, 'items', navGroups(shop, navItems), item.id));
});

// ⚠️ 테스트 결제: 실제 서비스에서는 PG(토스페이먼츠/포트원) 결제 승인 확인 후에만 주문을 생성해야 합니다.
route('POST', /^\/i\/([\w-]+)\/pay$/, async (req, res, m) => {
  return send(res, 403, page('막힘', '<h1>이제 포인트로만 구매할 수 있어요</h1>'));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이에요</h1><p><a href="/i/${item.id}">돌아가기</a></p>`));
  const order = { token: rid(16), item: item.id, price: item.price, paidAt: Date.now() };
  await placeOrder(order, item);
  await notify(await store.shopById(item.shop), `💰 새 주문! ${item.title} (${won(item.price)})`, 'sale');
  redirect(res, `/o/${order.token}`);
});

route('GET', /^\/pay\/success$/, async (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  const paymentKey = q.get('paymentKey');
  const orderId = q.get('orderId');
  if (!useToss || !paymentKey || !orderId || orderId.length !== 26) return send(res, 400, page('오류', '<h1>잘못된 결제 요청이에요</h1>'));
  if (await store.orderByToken(orderId)) return redirect(res, `/o/${orderId}`); // 새로고침 대비
  const item = await store.itemById(orderId.slice(0, 12));
  if (!item) return send(res, 404, page('오류', '<h1>아이템을 찾을 수 없어요</h1>'));
  if (item.stock != null && !stockLines(item.stock).length) return send(res, 400, page('품절', `<h1>품절이라 결제를 승인하지 않았어요</h1><p class="sub">카드 결제는 청구되지 않아요.</p><p><a href="/i/${item.id}">돌아가기</a></p>`));
  // 금액은 URL이 아니라 DB의 가격으로 승인 요청 (토스가 실제 결제액과 대조)
  const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(TOSS_SK + ':').toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey, orderId, amount: Number(item.price) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (await store.orderByToken(orderId)) return redirect(res, `/o/${orderId}`);
    return send(res, 400, page('결제 실패', `<h1>결제 승인에 실패했어요</h1><p>${esc(d.message || '')}</p><p><a href="/i/${item.id}">다시 시도</a></p>`));
  }
  if (d.status === 'DONE') await finalizePaid(d); // 카드: 바로 완료 / 가상계좌: 입금 후 완료
  redirect(res, `/o/${orderId}`);
});

// 토스 웹훅 (가상계좌 입금 통보). 본문은 믿지 않고 토스에 다시 조회해서 확인
route('POST', /^\/pay\/webhook$/, async (req, res) => {
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const orderId = body.orderId || (body.data && body.data.orderId);
  if (useToss && typeof orderId === 'string' && orderId.length === 26) {
    const p = await tossPayment(orderId);
    if (p && p.status === 'DONE') await finalizePaid(p);
  }
  res.writeHead(200); res.end('ok');
});

route('GET', /^\/pay\/fail$/, (req, res) => {
  const q = new URL(req.url, BASE).searchParams;
  send(res, 200, page('결제 실패', `<h1>결제가 완료되지 않았어요</h1><p class="sub">${esc(q.get('message') || '')}</p><p><a href="javascript:history.go(-2)">돌아가기</a></p>`));
});

route('GET', /^\/o\/([\w-]+)$/, async (req, res, m) => {
  let order = await store.orderByToken(m[1]);
  if (!order && !(await currentUser(req))) return redirect(res, '/login?next=' + enc('/o/' + m[1])); // 입금 대기 화면도 로그인한 사람만
  if (!order) {
    const dep = await store.depositByToken(m[1]);
    if (dep) {
      if (dep.status === 'done') order = await confirmDeposit(dep);
      else {
        const shop = await store.shopById(dep.shop);
        const depItem = await store.itemById(dep.item);
        if (depItem && depItem.stock != null && !stockLines(depItem.stock).length) return send(res, 200, page('품절', `<h1>품절이에요</h1><p class="sub">이미 입금했다면 판매자에게 환불을 요청해 주세요. 입금자명 ${esc(dep.name)}, ${won(dep.amount)}</p>`));
        if (Date.now() > dep.created + DEP_TTL) return send(res, 200, page('만료', `<h1>입금 기한이 지났어요</h1><p class="sub">이미 입금했다면 판매자에게 확인을 요청하세요.</p><p><a href="/i/${esc(dep.item)}">다시 주문하기</a></p>`));
        return send(res, 200, page('입금 대기', `<h1>입금해 주세요</h1>
<div class="card"><b>${esc(shop && shop.bank)}</b><br><span style="font-size:20px;font-weight:700">${esc(shop && shop.account)}</span><br>예금주 ${esc(shop && shop.holder)}<br><span class="price">${won(dep.amount)}</span></div>
<div class="warn">입금자명은 <b>${esc(dep.name)}</b> 그대로, 금액도 정확히 맞춰서 보내주세요.</div>
<p class="sub">${shop && shop.pay_mode === 'auto' ? '입금이 확인되면 이 페이지가 자동으로 열려요.' : '판매자가 입금을 확인하면 이 페이지가 열려요.'} (15초마다 확인)</p>
<p class="sub">입금 기한 ${esc(new Date(dep.created + DEP_TTL).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}<br>이 주소를 북마크하세요: <code>${BASE}/o/${esc(m[1])}</code></p>
<script>setTimeout(function(){location.reload()},15000)</script>`));
      }
    }
  }
  if (!order && useToss && m[1].length === 26) {
    const p = await tossPayment(m[1]);
    if (p && p.status === 'DONE') order = await finalizePaid(p);
    else if (p && p.status === 'WAITING_FOR_DEPOSIT') {
      const v = p.virtualAccount || {};
      const bank = BANKS[v.bankCode] || (v.bankCode ? '은행코드 ' + v.bankCode : '');
      const due = v.dueDate ? new Date(v.dueDate).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      return send(res, 200, page('입금 대기', `<h1>입금을 기다리고 있어요</h1>
<div class="card"><b>${esc(bank)}</b><br><span style="font-size:20px;font-weight:700">${esc(v.accountNumber)}</span><br><span class="price">${won(p.totalAmount)}</span><br><span class="sub">입금기한 ${esc(due)}</span></div>
<p class="sub">입금이 확인되면 이 페이지가 자동으로 열려요 (30초마다 확인). 이 주소를 북마크하세요: <code>${BASE}/o/${esc(m[1])}</code></p>
<script>setTimeout(function(){location.reload()},30000)</script>`));
    } else if (p && (p.status === 'EXPIRED' || p.status === 'CANCELED' || p.status === 'ABORTED')) {
      return send(res, 200, page('만료', `<h1>입금 기한이 지났거나 취소됐어요</h1><p><a href="/i/${esc(m[1].slice(0, 12))}">다시 주문하기</a></p>`));
    }
  }
  if (!order) return notFound(res, '주문을 찾을 수 없어요');
  const item = await store.itemById(order.item);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const me = await currentUser(req);
  const shopO = await store.shopById(item.shop);
  const staff = !!me && (isAdmin(me) || (!!shopO && shopO.owner === me.id));
  // 예전 방식(계좌 입금·간편결제)으로 만든 주문은 구매자가 기록돼 있지 않아서, 처음 연 로그인 회원(판매자·운영자 제외)을 구매자로 연결해요
  if (me && !order.buyer && !staff) {
    try { if (await store.claimOrder(order.token, me.id)) order.buyer = me.id; else order = (await store.orderByToken(order.token)) || order; }
    catch (e) { console.error('주문 연결 실패', e.message); }
  }
  if (!me) return redirect(res, '/login?next=' + enc('/o/' + m[1]));
  if (!me || !(staff || (order.buyer && order.buyer === me.id))) {
    const note = '구매한 계정으로 로그인해야 열려요.' + (me ? ' 지금 로그인한 계정은 이 주문의 구매자가 아니에요.' : '');
    return send(res, 403, page('구매자 전용', `<h1>구매한 사람만 볼 수 있어요</h1><p class="sub">${esc(note)}</p><p><a href="/i/${esc(item.id)}">${esc(item.title)} 보러가기</a></p>`), { 'Cache-Control': 'no-store' });
  }
  let reviewBox = '';
  if (me && order.buyer && order.buyer === me.id) {
    const rv = await store.reviewByToken(order.token);
    const qq = new URL(req.url, BASE).searchParams;
    reviewBox = `<h2>후기 ${rv ? '수정' : '남기기'}</h2>${qq.get('e') ? `<p class="warn">${esc(qq.get('e'))}</p>` : ''}
<form class="card" method="post" action="/o/${order.token}/review">
<select name="rating" style="${SEL_STYLE}">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${rv && rv.rating === n ? 'selected' : ''}>${stars(n)} (${n}점)</option>`).join('')}</select>
<textarea name="body" placeholder="후기를 남겨주세요 (최대 300자)" maxlength="300">${esc(rv ? rv.body : '')}</textarea>
<button>${rv ? '후기 수정' : '후기 등록'}</button><p class="sub">후기는 모든 사람에게 보여요.</p></form>`;
  }
  send(res, 200, page('내 보관함', `${staff && order.buyer !== (me && me.id) ? '<p class="sub">판매자·운영자로 보는 중이에요 (구매자 화면과 같아요)</p>' : ''}<h1>잠금 해제됨</h1><h2>${esc(item.title)}</h2>
${order.delivered ? `<p class="sub">지급된 상품${orderQty(order) > 1 ? ` (${orderQty(order)}개)` : ''}</p><div class="secret">${esc(order.delivered)}</div>` : (item.stock != null && order.delivered === '' ? '<div class="warn">재고가 부족해서 아직 지급되지 않았어요. 판매자가 직접 보내드려요. 판매자에게 문의해 주세요.</div>' : '')}
${item.secret ? `<div class="secret">${esc(item.secret)}</div>` : ''}
<p class="sub">이 주소를 북마크하면 언제든 다시 볼 수 있어요: <code>${BASE}/o/${order.token}</code></p>
${me && order.buyer === me.id && shopO && !shopO.deleted ? `<p><a href="/s/${shopO.id}/inquiry?item=${item.id}">판매자에게 문의하기</a></p>` : ''}
${reviewBox}`), { 'Cache-Control': 'no-store' });
});

// 후기 등록/수정 (구매자 본인만, 주문당 1개)
route('POST', /^\/o\/([\w-]+)\/review$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/o/' + m[1]));
  const order = await store.orderByToken(m[1]);
  if (!order || !order.buyer || order.buyer !== u.id) return send(res, 403, page('권한 없음', '<h1>구매한 사람만 후기를 남길 수 있어요</h1>'));
  const item = await store.itemById(order.item);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const f = await readForm(req);
  const rating = parseInt(f.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return redirect(res, `/o/${order.token}?e=${enc('별점은 1~5점이에요')}`);
  const body = str(f.body, 300);
  const old = await store.reviewByToken(order.token);
  if (old) await store.updateReview(old.id, { rating, body });
  else await store.createReview({ id: rid(9), token: order.token, item: item.id, shop: item.shop, user_id: u.id, rating, body, created: Date.now() });
  // 상점 주인에게 후기 알림 (기다리지 않고 보냄 — 디스코드가 느려도 후기 저장은 바로 끝남)
  store.shopById(item.shop).then((sh) => notify(sh, `⭐ ${old ? '후기 수정' : '새 후기'}! ${item.title} · ${stars(rating)} (${rating}점)${body ? '\n' + body.slice(0, 200).split('\n').map((x) => '> ' + x).join('\n') : ''}\n${BASE}/i/${item.id}`, 'review', { item: item.title, stars: stars(rating), rating, body: body.slice(0, 200), shop: sh ? sh.name : '', link: BASE + '/i/' + item.id })).catch((e) => console.error('후기 알림 실패', e.message));
  redirect(res, `/o/${order.token}`);
});

// 후기 삭제 (그 상점 주인 또는 운영자)
route('POST', /^\/i\/([\w-]+)\/reviews\/([\w-]+)\/delete$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || !(u.id === shop.owner || isAdmin(u))) return send(res, 403, page('권한 없음', '<h1>상점 주인이나 운영자만 후기를 삭제할 수 있어요</h1>'));
  const rv = await store.reviewById(m[2]);
  if (rv && rv.item === item.id) await store.deleteReview(rv.id);
  redirect(res, `/i/${item.id}`);
});

// ---------- 문의 ----------
// 구매자·회원 → 상점 판매자
route('GET', /^\/s\/([\w-]+)\/inquiry$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const me = await currentUser(req);
  if (!me) return redirect(res, '/login?next=' + enc('/s/' + shop.id + '/inquiry'));
  const q = new URL(req.url, BASE).searchParams;
  const items = (await store.itemsByShop(shop.id)).filter((i) => i.pub);
  const selId = str(q.get('item'), 40);
  if (selId && !items.some((i) => i.id === selId)) { const it = await store.itemById(selId); if (it && it.shop === shop.id) items.push(it); } // 링크로만 열리는 상품도 고를 수 있게
  const mine = await safeInq(() => store.inquiriesByUser(me.id, shop.id));
  const form = me.id === shop.owner ? `<p class="warn">내 상점이에요. 받은 문의는 <a href="/m/${shop.key}#inq">상점 관리 → 문의</a>에서 확인하세요.</p>`
    : isBlocked(shop, me.id) ? `<p class="warn">${BLOCKED_MSG}</p>` : inqForm('/s/' + shop.id + '/inquiry', items, selId);
  send(res, 200, page(shop.name + ' 문의', `<a class="sub" href="/s/${shop.id}">← ${esc(shop.name)}</a><h1>판매자에게 문의</h1>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
${form}
<h2>내 문의 내역</h2>
${mine.map(inqMineCard).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}`), { 'Cache-Control': 'no-store' });
});
route('POST', /^\/s\/([\w-]+)\/inquiry$/, async (req, res, m) => {
  const shop = await store.shopById(m[1]);
  if (!shop || shop.deleted) return notFound(res, '상점을 찾을 수 없어요');
  const me = await currentUser(req);
  if (!me) return redirect(res, '/login?next=' + enc('/s/' + shop.id + '/inquiry'));
  const back = (k, t) => redirect(res, `/s/${shop.id}/inquiry?${k}=${enc(t)}`);
  if (me.id === shop.owner) return back('e', '내 상점에는 문의를 보낼 수 없어요');
  if (isBlocked(shop, me.id)) return back('e', BLOCKED_MSG);
  const f = await readForm(req);
  const n = inqFields(f);
  if (!n.title || !n.body) return back('e', '제목과 내용을 모두 적어주세요');
  if (!sendOk('inq:' + me.id, 5, 10 * 60000)) return back('e', '문의를 너무 자주 보냈어요. 잠시 뒤에 다시 보내주세요');
  let item = null;
  if (f.item) { const it = await store.itemById(str(f.item, 40)); if (it && it.shop === shop.id) item = it; }
  try {
    if ((await store.inquiriesByUser(me.id, shop.id)).filter((x) => !x.reply).length >= MAX_INQ_OPEN) return back('e', '답변을 기다리는 문의가 너무 많아요. 답변이 온 뒤에 보내주세요');
    await store.createInquiry({ id: rid(6), user_id: me.id, shop: shop.id, item: item ? item.id : null, item_title: item ? item.title : null, ...n, reply: null, replied_at: null, created: Date.now() });
  } catch (e) {
    console.error('문의 저장 실패', e.message);
    return back('e', '문의를 저장하지 못했어요. 문의 기능이 아직 준비되지 않았을 수 있어요. 운영자에게 알려주세요');
  }
  notify(shop, `💬 새 문의: ${n.title}${item ? ' (' + item.title + ')' : ''}\n${n.body.slice(0, 200)}`, 'inquiry', { title: n.title, body: n.body.slice(0, 200), item: item ? item.title : '', shop: shop.name, link: BASE + '/m/' + shop.key }).catch((e) => console.error('문의 알림 실패', e.message));
  back('m', '문의를 보냈어요. 답변이 오면 여기서 확인할 수 있어요');
});

// 회원(구매자·판매자) → 운영자
route('GET', /^\/inquiry$/, async (req, res) => {
  const me = await currentUser(req);
  if (!me) return redirect(res, '/login?next=/inquiry');
  const q = new URL(req.url, BASE).searchParams;
  const mine = await safeInq(() => store.inquiriesByUser(me.id, null));
  send(res, 200, page('운영자 문의', `<a class="sub" href="/my">← 내 상점</a><h1>운영자에게 문의</h1>
<p class="sub">운영자에게 하고 싶은 말을 남겨주세요 (상품·배송 문의는 상점의 문의하기로)</p>
${q.get('m') ? `<p class="card">${esc(q.get('m'))}</p>` : ''}${q.get('e') ? `<p class="warn">${esc(q.get('e'))}</p>` : ''}
${isAdmin(me) ? '<p class="warn">운영자 계정이에요. 받은 문의는 <a href="/admin#inq">관리자 → 문의</a>에서 확인하세요.</p>' : inqForm('/inquiry', null, '')}
<h2>내 문의 내역</h2>
${mine.map(inqMineCard).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}`), { 'Cache-Control': 'no-store' });
});
route('POST', /^\/inquiry$/, async (req, res) => {
  const me = await currentUser(req);
  if (!me) return redirect(res, '/login?next=/inquiry');
  const back = (k, t) => redirect(res, `/inquiry?${k}=${enc(t)}`);
  if (isAdmin(me)) return back('e', '운영자는 운영자에게 문의할 수 없어요');
  const n = inqFields(await readForm(req));
  if (!n.title || !n.body) return back('e', '제목과 내용을 모두 적어주세요');
  if (!sendOk('inq:' + me.id, 5, 10 * 60000)) return back('e', '문의를 너무 자주 보냈어요. 잠시 뒤에 다시 보내주세요');
  try {
    if ((await store.inquiriesByUser(me.id, null)).filter((x) => !x.reply).length >= MAX_INQ_OPEN) return back('e', '답변을 기다리는 문의가 너무 많아요. 답변이 온 뒤에 보내주세요');
    await store.createInquiry({ id: rid(6), user_id: me.id, shop: null, item: null, item_title: null, ...n, reply: null, replied_at: null, created: Date.now() });
  } catch (e) {
    console.error('문의 저장 실패', e.message);
    return back('e', '문의를 저장하지 못했어요. 문의 기능이 아직 준비되지 않았을 수 있어요. 운영자에게 알려주세요');
  }
  notifyAdmins(`💬 새 문의: ${n.title}\n${n.body.slice(0, 150)}`, '/admin#inq');
  back('m', '문의를 보냈어요. 답변이 오면 여기서 확인할 수 있어요');
});

// 답변 (상점 주인 / 운영자)
route('POST', /^\/m\/([\w-]+)\/inquiries\/([\w-]+)\/reply$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const reply = inqReplyText(await readForm(req));
  try {
    const q = await store.inquiryById(m[2]);
    if (reply && q && q.shop === shop.id) { await store.updateInquiry(q.id, { reply, replied_at: Date.now() }); notifyReplied(q, reply, shop.name); }
  } catch (e) { console.error('답변 저장 실패', e.message); }
  redirect(res, `/m/${shop.key}#inq`);
});
route('POST', /^\/admin\/inquiries\/([\w-]+)\/reply$/, async (req, res, m) => {
  const me = await adminOnly(req, res);
  if (!me) return;
  const reply = inqReplyText(await readForm(req));
  try {
    const q = await store.inquiryById(m[1]);
    if (reply && q && !q.shop) { await store.updateInquiry(q.id, { reply, replied_at: Date.now() }); notifyReplied(q, reply, '운영자'); }
  } catch (e) { console.error('답변 저장 실패', e.message); }
  redirect(res, '/admin#inq');
});

// 삭제: 문의한 본인, 그 상점 주인, 운영자
route('POST', /^\/inquiries\/([\w-]+)\/delete$/, async (req, res, m) => {
  const me = await currentUser(req);
  if (!me) return redirect(res, '/login?next=/my');
  let q = null;
  try { q = await store.inquiryById(m[1]); } catch (e) { console.error('문의 조회 실패', e.message); }
  if (!q) return redirect(res, '/my');
  const shop = q.shop ? await store.shopById(q.shop) : null;
  const staff = isAdmin(me) || (!!shop && shop.owner === me.id);
  const mineQ = q.user_id === me.id;
  if (!staff && !mineQ) return send(res, 403, page('권한 없음', '<h1>삭제할 수 없어요</h1>'));
  try { await store.deleteInquiry(q.id); } catch (e) { console.error('문의 삭제 실패', e.message); }
  redirect(res, mineQ ? (shop ? `/s/${shop.id}/inquiry` : '/inquiry') : (shop ? `/m/${shop.key}#inq` : '/admin#inq'));
});

// 로그인 없이 열어둘 곳: 첫 화면, 로그인·가입, 외부 서버가 부르는 웹훅(결제·문자)
const PUBLIC = [
  ['GET', /^\/$/], ['GET', /^\/intro$/], ['GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/], ['GET', /^\/(manifest\.json|sw\.js|badge\.png|icon-(192|512)\.png)$/], ['GET', /^\/login$/], ['POST', /^\/login$/],
  ['POST', /^\/signup(\/start|\/verify)?$/], ['POST', /^\/logout$/],
  ['POST', /^\/pay\/webhook$/], ['POST', /^\/sms\/[\w-]+$/],
];
http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (!PUBLIC.some(([m, re]) => m === req.method && re.test(url.pathname))) {
    let me = null;
    try { me = await currentUser(req); } catch (e) { console.error(e); return send(res, 500, page('오류', '<h1>문제가 생겼어요</h1>')); }
    if (!me) return redirect(res, `/login?e=${enc('가입하고 로그인해야 쓸 수 있어요')}&next=${enc(req.method === 'GET' ? url.pathname + url.search : '/my')}`);
  }
  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (r.method === req.method && m) {
      try { return await r.fn(req, res, m); } catch (e) { console.error(e); return send(res, 500, page('오류', '<h1>문제가 생겼어요</h1>')); }
    }
  }
  notFound(res, '페이지를 찾을 수 없어요');
}).listen(PORT, () => console.log(`링크몰 실행 중 → ${BASE} (저장소: ${useSB ? 'Supabase' : 'db.json 파일'})`));
