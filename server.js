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
  async ledgerForUserShop(uid, shopId, n = 30) { return sbGet('ledger', `user_id=eq.${enc(uid)}&shop=eq.${enc(shopId)}&select=*&order=created.desc&limit=${Number(n) || 30}`); },
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
  // 예약 선결제 내역 줄을 '구매' 줄로 바꿔요 (찾으면 true)
  async resvLedgerToBuy(resvId, token, note) {
    const r = await fetch(`${SB_URL}/rest/v1/ledger?kind=eq.reserve&ref=eq.${enc(resvId)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ kind: 'buy', ref: token, note }) });
    if (!r.ok) throw new Error(`supabase resvLedgerToBuy ${r.status} ${await r.text()}`);
    return (await r.json()).length > 0;
  },
  // 예약 (reservations 표)
  async createResv(r) { await sbInsert('reservations', r); },
  async resvById(id) { return (await sbGet('reservations', `id=eq.${enc(id)}&select=*`))[0]; },
  async resvUserItem(uid, itemId) { return sbGet('reservations', `user_id=eq.${enc(uid)}&item=eq.${enc(itemId)}&status=eq.waiting&select=*&order=created.asc`); },
  async resvByUser(uid) { return sbGet('reservations', `user_id=eq.${enc(uid)}&select=*&order=created.desc&limit=60`); },
  async resvWaitingForItem(itemId) { return sbGet('reservations', `item=eq.${enc(itemId)}&status=eq.waiting&select=*&order=created.asc&limit=200`); },
  async resvWaitingByShop(shopId) { return sbGet('reservations', `shop=eq.${enc(shopId)}&status=eq.waiting&select=*&limit=1000`); },
  async resvWaitingAll() { return sbGet('reservations', 'status=eq.waiting&select=id,item&limit=1000'); },
  async updateResv(id, f) { await sbPatch('reservations', `id=eq.${enc(id)}`, f); },
  async claimResv(id, from, to) {
    const r = await fetch(`${SB_URL}/rest/v1/reservations?id=eq.${enc(id)}&status=eq.${enc(from)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: to }) });
    if (!r.ok) throw new Error(`supabase claimResv ${r.status} ${await r.text()}`);
    return (await r.json()).length > 0;
  },
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
    // Supabase는 한 번에 최대 1000줄만 줘서, 주문이 많으면 옛날 주문이 잘려요 → 1000줄씩 이어서 전부 가져와요
    const out = [];
    for (let off = 0; off < 200000; off += 1000) {
      const rows = await sbGet('orders', `item=in.(${ids.map(enc).join(',')})&select=*&order=paid_at.desc,token.asc&limit=1000&offset=${off}`);
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out.map((o) => ({ token: o.token, item: o.item, price: o.price, paidAt: o.paid_at, delivered: o.delivered, buyer: o.buyer }));
  },
};

const DB = path.join(__dirname, 'db.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { shops: {}, items: {}, orders: {} }; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const L = () => { const d = load(); d.users = d.users || {}; d.deposits = d.deposits || {}; d.charges = d.charges || {}; d.ledger = d.ledger || []; d.titles = d.titles || {}; d.user_titles = d.user_titles || []; d.shop_points = d.shop_points || {}; d.reviews = d.reviews || {}; d.shop_requests = d.shop_requests || {}; d.licenses = d.licenses || {}; d.inquiries = d.inquiries || {}; d.reservations = d.reservations || {}; return d; };
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
  async ledgerForUserShop(uid, shopId, n = 30) { return L().ledger.filter((l) => l.user_id === uid && l.shop === shopId).sort((a, b) => b.created - a.created).slice(0, Number(n) || 30); },
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
  async resvLedgerToBuy(resvId, token, note) { const d = L(); const l = d.ledger.find((x) => x.kind === 'reserve' && x.ref === resvId); if (!l) return false; l.kind = 'buy'; l.ref = token; l.note = note; save(d); return true; },
  // 예약
  async createResv(r) { const d = L(); d.reservations[r.id] = r; save(d); },
  async resvById(id) { return L().reservations[id]; },
  async resvUserItem(uid, itemId) { return Object.values(L().reservations).filter((r) => r.user_id === uid && r.item === itemId && r.status === 'waiting').sort((a, b) => a.created - b.created); },
  async resvByUser(uid) { return Object.values(L().reservations).filter((r) => r.user_id === uid).sort((a, b) => b.created - a.created).slice(0, 60); },
  async resvWaitingForItem(itemId) { return Object.values(L().reservations).filter((r) => r.item === itemId && r.status === 'waiting').sort((a, b) => a.created - b.created); },
  async resvWaitingByShop(shopId) { return Object.values(L().reservations).filter((r) => r.shop === shopId && r.status === 'waiting'); },
  async resvWaitingAll() { return Object.values(L().reservations).filter((r) => r.status === 'waiting').map((r) => ({ id: r.id, item: r.item })); },
  async updateResv(id, f) { const d = L(); if (d.reservations[id]) Object.assign(d.reservations[id], f); save(d); },
  async claimResv(id, from, to) { const d = L(); const r = d.reservations[id]; if (!r || r.status !== from) return false; r.status = to; save(d); return true; },
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
button,.btn,.bb{background:#111111}
.btn,.bb{box-shadow:0 6px 14px rgba(0,0,0,.18)}
button:active,.btn:active,.bb:active{background:#3a3a3a}
.nv.on{background:#111111;box-shadow:0 10px 22px rgba(0,0,0,.22)}
.w a:not([class]),.w a.sub,.w a.sm,.main a:not([class]),.main a.sub,.main a.sm{background:#fff;color:#111;box-shadow:inset 0 0 0 1px #d4d4d8}
.w a:not([class]):active,.w a.sub:active,.w a.sm:active,.main a:not([class]):active,.main a.sub:active,.main a.sm:active{background:#f4f4f5}
#ptest,button[style*="#6b7280"]{background:#fff!important;color:#111!important;box-shadow:inset 0 0 0 1px #d4d4d8}
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
.acts button[type=button]{background:#fff!important;color:#111!important;box-shadow:inset 0 0 0 1px #d4d4d8}
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
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}"><link rel="manifest" href="/manifest.json?v=${ICON_VER}"><meta name="theme-color" content="#111111">${DARK_HEAD}<meta name="mobile-web-app-capable" content="yes"><title>${esc(title)}</title><style>${css}</style></head><body>${SPLASH}<div class="top"><a class="logo" href="/"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect width="28" height="28" rx="9" fill="#14130f"/><path d="M8 15.5l4-4a3 3 0 014.2 0l.3.3M20 12.5l-4 4a3 3 0 01-4.2 0l-.3-.3" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/></svg>링크몰</a>${DARK_BTN}<a class="chip" href="/my" aria-label="내 상점">${STORE_ICO}</a></div><div class="w">${body}</div><script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script></body></html>`;

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
  const licD = itemLicDays(item);
  const multi = item.stock != null || licD > 0;
  const max = multi ? Math.max(1, Math.min(MAX_QTY, licD ? MAX_QTY : stockLines(item.stock).length, remain == null ? MAX_QTY : Math.max(1, remain))) : 1;
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
<form method="post" action="/i/${item.id}/deposit"><input name="name" placeholder="입금자명 (은행 앱에 찍히는 내 이름)" required minlength="2" maxlength="20"><button style="background:#111111">${won(item.price)} 입금 신청</button></form></div>`;
  if (useToss) {
    const orderId = item.id + rid(10); // 앞 12자 = 아이템 ID, 뒤 14자 = 랜덤 (총 26자)
    out += `<div class="card"><button id="payVbank" style="background:#111111">${won(item.price)} 가상계좌로 입금</button><br><br>
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

const NOTI = { sale: '판매 (새 주문)', deposit: '입금 대기 (계좌 입금 주문)', charge: '포인트 충전 신청', stock: '재고 알림 (재고가 0이 됐을 때)', review: '후기 (새 후기가 달렸을 때)', inquiry: '문의 (새 문의가 왔을 때)', resv: '예약 (품절 상품 예약·자동 구매)' };
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
  resv: { vars: { item: '상품 이름', qty: '수량', shop: '상점 이름', link: '상품 링크' }, example: '🔖 새 예약! {item} × {qty}', sample: { item: '치킨버거', qty: 2, shop: '내 상점', link: BASE + '/i/abc123' } },
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
// ---------- 자동 발급 라이센스 상품: 사면 그 자리에서 자동 충전 키를 만들어 지급 ----------
// 상품 '잠금 정보' 칸에 [[LICENSE:일수]] 가 들어 있으면 그 상품은 구매할 때마다 새 키를 만들어줘요 (재고 필요 없음)
const itemLicDays = (item) => { const m = /^\[\[LICENSE:(\d{1,5})\]\]$/.exec(String((item && item.secret) || '').trim()); const d = m ? parseInt(m[1], 10) : 0; return d >= 1 && d <= 36500 ? d : 0; };
// 키를 공짜로 찍어내는 건 운영자만: 운영자 계정이 주인인 상점의 상품일 때만 발급해요
const licShopOk = async (shop) => { if (!shop || !shop.owner) return false; const o = await store.userById(shop.owner); return !!o && isAdmin(o); };
async function mintKeys(item, n) {
  const keys = [];
  try { for (let i = 0; i < n; i++) { const key = newLicenseKey(); await store.createLicense({ key, days: itemLicDays(item), created: Date.now(), note: ('자동발급: ' + item.title).slice(0, 40) }); keys.push(key); } }
  catch (e) { await dropKeys(keys); throw e; }
  return keys;
}
async function dropKeys(keys) { for (const k of keys || []) { try { await store.deleteUnusedLicense(k); } catch (e) { console.error('키 회수 실패', k, e.message); } } }
async function placeOrder(order, item) {
  let line = null;
  const licDays = itemLicDays(item);
  if (licDays) { // 자동 발급 상품: 결제가 확인되면 키를 새로 만들어 지급
    if (!(await licShopOk(await store.shopById(item.shop)))) { order.delivered = ''; }
    else { const ks = await mintKeys(item, 1); order.delivered = ks.join('\n'); }
    try { await store.createOrder(order); } catch (e) { if (order.delivered) await dropKeys(order.delivered.split('\n')); throw e; }
    return order;
  }
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
const ICON_VER = '7'; // 아이콘 이미지를 바꿀 때마다 숫자를 올리면 브라우저가 새 아이콘을 다시 받아가요
const ICON_SMALL = Buffer.from('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', 'base64');
const ICON_LARGE = Buffer.from('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', 'base64');
route('GET', /^\/(favicon\.ico|apple-touch-icon\.png)$/, (req, res, m) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(m[1] === 'favicon.ico' ? ICON_SMALL : ICON_LARGE);
});

// ---------- 앱 설치(PWA): 홈 화면에 앱처럼 설치되게 하는 파일들 ----------
const ICON_192 = Buffer.from('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', 'base64');
const ICON_512 = Buffer.from('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', 'base64');
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
const DEFAULT_IMG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAHgAeADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACikJpC1ADqTIphakL0ASbhRuqIvSb6AJd1G6ovMpN9AE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUPmD1FHmD1FAE26jdUO+l8ygCXdS7qh8ylD0AS5FLUW+l3UASUU0NS7qAFooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooppNACk4ppNITimM9ADi2KaXqJpMVC82KAJzJTDNXMeMviF4a+H2mx6j4p8Q6V4a0+WYW8d3q97FaRPKVZggeRgCxCscZzhSexr5A+Kn/BWP4UeEYJIvB9nqvj7UDCkkTxQtp9luMmGjklmUSqyoC3ywupyoyMsVVwPuMzU0z+9fkh4l/wCCwPxKu9auJdA8G+FdM0ltvkWupC5vJ0+Ubt0ySwq2W3EYjXAIHOMnyH/h5B+0V/0UT/yiad/8j0uZDsfuWZ8UfaBX4Z/8PH/2iv8Aoof/AJRNO/8Akej/AIePftFf9FD/APKJp3/yPRzILH7mfaBR5/vX4Z/8PHv2iv8Aoof/AJRNO/8Akej/AIePftFf9FD/APKJp3/yPRzILH7mef70ef71+Gf/AA8e/aK/6KH/AOUTTv8A5Ho/4ePftFf9FD/8omnf/I9HMgsfuZ5/vR5/vX4Z/wDDx79or/oof/lE07/5Ho/4ePftFf8ARQ//ACiad/8AI9HMgsfuZ5/vR5/vX4Z/8PHv2iv+ih/+UTTv/kej/h49+0V/0UP/AMomnf8AyPRzILH7mef70ef71+Gf/Dx79or/AKKH/wCU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HxlemJ45FklaytdxfKukcTeYrBQF5lYHLHAyNv1F4T8CaF4KsHsfD2iadoNlJKZnttMtI7aNpCAC5VAAWIVRnrgD0rqYrHpxV2Gx9qdhFG3s+nFatrZ9OKs29l04rSt7TGOKYEdra4xxWtbW+MUtvbY7VoQwYoAdBDirsSYpsceKsIuKAHIuKkUUgFPoAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigApCM0tFADCKjZc1MRmmkUAU5I81VlgzWkyZqJ480AYs1t7VRmtPaugkhzVaS3z2oA5uay9qpyWPtXTyWue1Vns/agDmHsPaoWsPaumey9qjay9qAOaNh7U02HtXSGx9qb9h9qAOc+we1H2D2ro/sPtSfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79h9qPsPtXRfYR6UfYR6UAc79g9qPsHtXRfYR6Uv2H2oA50WHtSiw9q6H7D7UosfagDBWw9qlSw9q3FsfapUsvagDHjsfarcNl7VppZ+1WY7XHagChDae1Xobb2q1HbY7VZjgxQBFFBirUcWKekVTKlACImKkAxQBingYoAAMUtFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABSEZpaKAGEU0rUtIVoArtHmo2iq0RTStAFFoM1E1vntWiUphjoAzWtvamG19q0zFSGKgDLNrz0pPso9K0/J9qPJ9qAMz7KPSk+yVqeT7UeT7UAZf2Sj7JWp5PtR5PtQBl/ZKPslank+1Hk+1AGX9ko+yVqeT7UeT7UAZf2Sj7JWp5PtR5PtQBl/ZKPslank+1Hk+1AGX9ko+yVqeT7UeT7UAZf2Sl+yD0rT8n2o8n2oAzPso9KBa89K0/J9qPJ9qAM/wCy47U9bbpxV4RU4RUAU1t8dqlWDHarIjpwSgCFYqlWPFSBKcBQA0LTgKULTqAEAxS0UUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFJgUtFADdtIV9qfRQBHtpNtS0UARbKNlSYoxQBHso2VJijAoAj2UbKkwKMCgCPZRsqTAowKAI9lGypMCjAoAj2UbKkwKMCgCPZRsqTAowKAI9lGypMCjAoAj2UbKkwKMCgCPZRsqTFGKAI9tLtp9LQAzb7Uu2nUUAJtpaKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z', 'base64');
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
  // 소개 페이지에도 새 로고 아이콘을 연결해요 (ICON_VER가 바뀌면 브라우저가 새 아이콘을 다시 받아요)
  if (!/rel=["']icon["']/.test(html)) {
    const tags = `<link rel="icon" type="image/png" href="/favicon.ico?v=${ICON_VER}">` +
      `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VER}">` +
      `<link rel="manifest" href="/manifest.json?v=${ICON_VER}"><meta name="theme-color" content="#111111">`;
    html = html.replace('</head>', tags + '</head>');
  }
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
  const items = await store.itemsByShop(shop.id); const resvN = new Map(); try { for (const r of await store.resvWaitingByShop(shop.id)) resvN.set(r.item, (resvN.get(r.item) || 0) + (Number(r.qty) || 1)); } catch {}
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
<a class="btn" href="/m/${shop.key}/sales" style="margin-bottom:10px">🔍 전체 판매내역 검색 (옛날 주문 포함)</a>
${recent.map((o) => { const bc = o.buyer ? String(o.buyer).slice(0, 8) : ''; return `<div class="card tcard"><div class="row"><div style="flex:1;min-width:0"><b>${esc(titleOfItem.get(o.item) || '삭제된 상품')}</b><br><span class="sub">${won(o.price)} · ${fmtDate(o.paidAt)}<br>구매자 ${bc ? esc(bc) : '미연결'}</span></div>${bc ? (blockedIds.includes(o.buyer) ? '<span class="sub">차단됨</span>' : `<form method="post" action="/m/${shop.key}/blocks" onsubmit="return confirm('이 회원을 차단할까요?')" style="margin:0"><input type="hidden" name="code" value="${esc(bc)}"><button style="width:auto;padding:8px 14px;font-size:13px;background:#dc2626;border-radius:12px">차단</button></form>`) : ''}</div></div>`; }).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}
<!--TAB:items::상품-->
<h2>아이템 추가</h2>
<form class="card" method="post" action="/m/${shop.key}/items">
<input name="title" placeholder="제목" required maxlength="80">
<input name="price" type="number" min="100" step="100" placeholder="가격 (원)" required>
<textarea name="preview" placeholder="미리보기 (결제 전 공개되는 설명)" required></textarea>
${ownerU && isAdmin(ownerU) ? '<input name="license_days" type="number" inputmode="numeric" min="1" max="36500" placeholder="자동 충전 키 자동 발급 (선택): 이용 일수. 적으면 살 때마다 새 키를 만들어줘요">' : ''}
<textarea name="secret" placeholder="잠금 정보 (결제 후에만 공개: 내용, 링크 등). 재고를 쓰거나 키 자동 발급이면 비워도 돼요"></textarea>
<textarea name="stock" placeholder="재고 (선택). 한 줄에 하나씩 적으면 구매할 때마다 한 줄씩 순서대로 지급돼요. 예) 치킨버거 ⏎ 불고기버거. 비우면 재고 제한 없이 같은 잠금 정보를 보여줘요"></textarea>
<input name="buy_limit" type="number" inputmode="numeric" min="1" max="100000" placeholder="인당 구매 한도 (선택, 한 사람이 살 수 있는 최대 개수)">
${imgField('')}
${titleSelect(titles, '')}
<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" name="pub" checked style="width:auto;margin:0"> 상점 목록에 공개 (끄면 링크로만 열려요)</label>
<button>등록</button></form>
<h2>내 아이템</h2>
${items.map((i) => `<div class="card">${i.image ? `<img src="/img/${i.id}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:12px;float:right;margin-left:10px">` : ''}<b>${esc(i.title)}</b> <span class="price">${won(i.price)}</span> <span class="sub">· ${i.pub ? '공개' : '비공개(링크로만)'}${i.stock != null ? ` · 재고 ${stockLines(i.stock).length}개` : ''}${itemLimit(i) ? ` · 인당 ${itemLimit(i)}개` : ''}${resvN.get(i.id) ? ` · 예약 대기 ${resvN.get(i.id)}개` : ''}</span><br><a href="/i/${i.id}">${BASE}/i/${i.id}</a><br><a href="/m/${shop.key}/items/${i.id}/edit">수정·삭제</a></div>`).join('') || '<p class="sub"><i class="empty">비어 있어요</i></p>'}`));
});

// 판매내역 검색 (옛날 주문까지 전부): 상품명·구매자 회원번호·주문번호·기간으로 찾기
route('GET', /^\/m\/([\w-]+)\/sales$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const q = new URL(req.url, BASE).searchParams;
  const kw = String(q.get('q') || '').trim().toLowerCase().slice(0, 60);
  const itemF = String(q.get('item') || '').slice(0, 40);
  const dayMs = (d, end) => { // 'YYYY-MM-DD' (한국 시간) → 밀리초
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return null;
    const t = Date.parse(d + 'T00:00:00+09:00');
    return Number.isFinite(t) ? t + (end ? 86400000 - 1 : 0) : null;
  };
  const fromS = String(q.get('from') || ''); const toS = String(q.get('to') || '');
  const from = dayMs(fromS, false); const to = dayMs(toS, true);
  const PER = 50;
  const pg = Math.max(1, parseInt(q.get('p'), 10) || 1);
  const items = await store.itemsByShop(shop.id);
  const titleOf = new Map(items.map((i) => [i.id, i.title]));
  const all = await store.ordersForItems(items.map((i) => i.id));
  const rows = all.filter((o) => {
    const t = Number(o.paidAt || 0);
    if (from != null && t < from) return false;
    if (to != null && t > to) return false;
    if (itemF && o.item !== itemF) return false;
    if (kw) {
      const hay = [titleOf.get(o.item) || '', o.buyer || '', o.token || '', o.item || ''].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  }).sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0));
  const sum = rows.reduce((a, o) => a + Number(o.price || 0), 0);
  const cnt = rows.reduce((a, o) => a + orderQty(o), 0);
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const cur = Math.min(pg, pages);
  const slice = rows.slice((cur - 1) * PER, cur * PER);
  const blockedIds = parseBlocked(shop);
  const base = `/m/${shop.key}/sales`;
  const qs = (p) => { const u = new URLSearchParams(); if (kw) u.set('q', kw); if (itemF) u.set('item', itemF); if (fromS) u.set('from', fromS); if (toS) u.set('to', toS); if (p > 1) u.set('p', String(p)); const s2 = u.toString(); return base + (s2 ? '?' + s2 : ''); };
  const cards = slice.map((o) => { const bc = o.buyer ? String(o.buyer).slice(0, 8) : '';
    return `<div class="card tcard"><b>${esc(titleOf.get(o.item) || '삭제된 상품')}</b>${orderQty(o) > 1 ? ` <span class="sub">× ${orderQty(o)}</span>` : ''}<br><span class="sub">${won(o.price)} · ${fmtDate(o.paidAt)}<br>구매자 ${bc ? esc(bc) + (blockedIds.includes(o.buyer) ? ' (차단됨)' : '') : '미연결'}<br>주문번호 <code>${esc(String(o.token || '').slice(0, 12))}</code></span></div>`; }).join('');
  const pager = pages > 1 ? `<div class="row" style="justify-content:center;margin:14px 0">${cur > 1 ? `<a class="chip" href="${qs(cur - 1)}">← 이전</a>` : ''}<span class="sub">${cur} / ${pages}</span>${cur < pages ? `<a class="chip" href="${qs(cur + 1)}">다음 →</a>` : ''}</div>` : '';
  send(res, 200, page('판매내역 검색', `<a class="sub" href="/m/${shop.key}">← ${esc(shop.name)} 관리</a><h1>판매내역 검색</h1>
<form class="card" method="get" action="${base}">
<input name="q" value="${esc(kw)}" placeholder="상품명 · 구매자 회원번호 · 주문번호" maxlength="60" autocomplete="off">
<select name="item"><option value="">모든 상품</option>${items.map((i) => `<option value="${esc(i.id)}"${i.id === itemF ? ' selected' : ''}>${esc(i.title)}</option>`).join('')}</select>
<div class="row"><input type="date" name="from" value="${esc(fromS)}" aria-label="시작일"><span class="sub">~</span><input type="date" name="to" value="${esc(toS)}" aria-label="종료일"></div>
<button style="margin-top:8px">검색</button>${kw || itemF || fromS || toS ? ` <a class="sub" href="${base}">조건 지우기</a>` : ''}</form>
<h2>${rows.length}건 · 판매 ${cnt}개 · ${won(sum)}</h2>
<p class="sub">전체 ${all.length}건 중 (옛날 주문 포함) · 한 번에 ${PER}건씩 보여요</p>
${cards || '<p class="sub"><i class="empty">검색 결과가 없어요</i></p>'}${pager}`));
});

route('POST', /^\/m\/([\w-]+)\/items$/, async (req, res, m) => {
  const shop = await manageShop(req, res, m[1]);
  if (!shop) return;
  const f = await readForm(req);
  const price = parseInt(f.price, 10);
  if (!(price >= 100)) return send(res, 400, page('오류', '<h1>가격은 100원 이상이어야 해요</h1>'));
  let secret = String(f.secret || '').slice(0, 10000);
  const stock = parseStock(f.stock);
  const licD = parseInt(f.license_days, 10);
  if (licD >= 1) {
    if (!(await licShopOk(shop))) return send(res, 403, page('오류', '<h1>키 자동 발급은 운영자 상점에서만 쓸 수 있어요</h1>'));
    if (licD > 36500 || stock) return send(res, 400, page('오류', '<h1>일수는 1~36500이고, 키 자동 발급 상품은 재고를 같이 쓸 수 없어요</h1>'));
    secret = `[[LICENSE:${licD}]]`;
  }
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
  if (upd.stock != null) fulfillReservations(item.id).catch((e) => console.error('예약 처리 실패', e.message)); // 재고가 들어왔으면 예약자에게 자동 구매
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
  const licDays = itemLicDays(item);
  if (licDays && !(await licShopOk(shopB))) return send(res, 403, page('이용 불가', '<h1>이 상품은 지금 살 수 없어요</h1>'));
  const multi = item.stock != null || licDays > 0;
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
  const undoLines = async () => { if (!lines) return; if (licDays) await dropKeys(lines); else await restoreLines(item.id, lines); };
  if (licDays) lines = await mintKeys(item, qty); // 자동 발급: 산 개수만큼 새 키를 만들어요
  else if (multi) {
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
    await undoLines();
    return send(res, 400, page('포인트 부족', `<h1>이 상점 포인트가 부족해요</h1><p class="sub">${qty > 1 ? `${qty}개 ` : ''}${pts(total)}가 필요해요.</p><p><a href="/w/${item.shop}">충전하러 가기</a></p>`));
  }
  const order = { token: rid(16), item: item.id, price: total, paidAt: Date.now(), buyer: u.id, ...(lines ? { delivered: lines.join('\n') } : {}) };
  try { await store.createOrder(order); }
  catch (e) { await store.addShopPoints(u.id, item.shop, total); await undoLines(); throw e; }
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

// ---------- 예약 (품절 상품을 예약해 두면 재고가 들어올 때 자동으로 구매돼요) ----------
// 예약하면 포인트가 먼저 빠지고(선결제), 취소하면 돌려받아요. 재고가 들어오면 예약한 순서대로 자동 구매·지급돼요.
const MAX_RESV_QTY = 10;
const RESV_SQL = "create table if not exists reservations (id text primary key, user_id text not null, shop text not null, item text not null, item_title text, qty integer not null default 1, total bigint not null, status text not null default 'waiting', order_token text, created bigint not null, done_at bigint); alter table reservations disable row level security;";
const resvBusy = new Set();
const safeResv = async (fn, fallback = []) => { try { return await fn(); } catch (e) { console.error('예약 불러오기 실패 (reservations 표가 있나요?)', e.message); return fallback; } };

function reserveBlock(item, me, bal, disc, myResv) {
  if (!me) return `<div class="nt">품절이에요. 예약해 두면 재고가 들어올 때 자동으로 구매돼요.</div><p><a class="btn" style="color:#fff" href="/login?next=${enc('/i/' + item.id)}">로그인하고 예약하기</a></p>`;
  const mine = (myResv || []).find((r) => r.status === 'waiting');
  if (mine) return `<div class="bx"><b>예약 중이에요</b><p class="sm" style="margin:6px 0 10px">${esc(mine.qty)}개 · ${pts(mine.total)} 선결제됨<br>재고가 들어오면 예약한 순서대로 자동 구매돼요.</p><form method="post" action="/reservations/${esc(mine.id)}/cancel" onsubmit="return confirm('예약을 취소할까요? 낸 포인트는 돌려받아요.')"><button style="background:#f4f4f5;color:#dc2626">예약 취소</button></form><p class="sm" style="margin:10px 0 0"><a href="/reservations">내 예약 보기</a></p></div>`;
  const unit = discPrice(item.price, disc);
  return `<form class="bx" method="post" action="/i/${item.id}/reserve"><b>품절 · 예약하기</b><p class="sm" style="margin:6px 0 10px">예약하면 포인트가 먼저 빠지고, 재고가 들어올 때 예약한 순서대로 자동 구매돼요. 취소하면 포인트를 돌려받아요.</p><input name="qty" type="number" inputmode="numeric" min="1" max="${MAX_RESV_QTY}" value="1" required aria-label="예약 수량"><p class="sm" style="margin:0 0 10px">1개 ${won(unit)} · 내 포인트 ${pts(bal)}</p><button style="color:#fff">예약하기</button></form>`;
}

// 예약을 취소 상태로 바꾸고 선결제한 포인트를 돌려줘요
async function refundResv(r, status, note) {
  const total = Number(r.total) || 0;
  await store.updateResv(r.id, { status });
  if (total > 0) {
    await store.addShopPoints(r.user_id, r.shop, total);
    try { await store.addLedger({ id: rid(9), user_id: r.user_id, shop: r.shop, delta: total, kind: 'reserve_cancel', ref: r.id, note, created: Date.now() }); } catch (e) { console.error('ledger', e.message); }
  }
}

// 예약 한 건을 실제 구매로 바꿔요 (재고가 모자라면 false)
async function fulfillOne(r) {
  const item = await store.itemById(r.item);
  if (!item || item.stock == null) return false;
  const qty = Math.max(1, Number(r.qty) || 1);
  if (stockLines(item.stock).length < qty) return false;
  const shop = await store.shopById(item.shop);
  if (!shop || shop.deleted) return false;
  if (!(await store.claimResv(r.id, 'waiting', 'processing'))) return false; // 그 사이 취소됐거나 이미 처리됨
  if (isBlocked(shop, r.user_id)) { await refundResv(r, 'cancelled', '이용 제한으로 예약 취소'); return false; }
  const total = Number(r.total) || 0;
  let lines = null; let ordered = false;
  try {
    lines = await store.popStockN(item.id, qty);
    if (!lines) { await store.updateResv(r.id, { status: 'waiting' }); return false; }
    const order = { token: rid(16), item: item.id, price: total, paidAt: Date.now(), buyer: r.user_id, delivered: lines.join('\n') };
    await store.createOrder(order);
    ordered = true;
    try { await store.updateResv(r.id, { status: 'done', order_token: order.token, done_at: Date.now() }); } catch (e) { console.error('예약 완료 표시 실패', r.id, e.message); }
    try { // 예약 (선결제) 줄을 '구매 · 예약 구매: 상품명' 줄로 바꿔요 (구매 내역 링크가 걸려요)
      const note = `예약 구매: ${item.title}${qty > 1 ? ` × ${qty}` : ''}`;
      if (!(await store.resvLedgerToBuy(r.id, order.token, note))) await store.addLedger({ id: rid(9), user_id: r.user_id, shop: item.shop, delta: -total, kind: 'buy', ref: order.token, note, created: Date.now() }); // 예약 줄이 없을 때만 새 줄
    } catch (e) { console.error('ledger', e.message); }
    try { // 칭호 페이백
      const pb = await paybackOf(r.user_id, item.shop);
      const back = Math.floor(total * pb / 100);
      if (pb > 0 && back > 0) {
        await store.addShopPoints(r.user_id, item.shop, back);
        await store.addLedger({ id: rid(9), user_id: r.user_id, shop: item.shop, delta: back, kind: 'payback', ref: order.token, note: `칭호 페이백 ${pb}%`, created: Date.now() });
      }
    } catch (e) { console.error('페이백 실패', e.message); }
    try {
      if (item.title_id) { const t = await store.titleById(item.title_id); if (t) await store.grantTitle(r.user_id, t.id, item.shop); }
      const autoTitles = (await store.titlesByShop(item.shop)).filter((t) => Number(t.auto_min) > 0);
      if (autoTitles.length) {
        const spent = (await store.ordersForItems((await store.itemsByShop(item.shop)).map((i) => i.id))).filter((o) => o.buyer === r.user_id).reduce((a, o) => a + Number(o.price || 0), 0);
        for (const t of autoTitles) if (spent >= Number(t.auto_min)) await store.grantTitle(r.user_id, t.id, item.shop);
      }
    } catch (e) { console.error('칭호 지급 실패', e.message); }
    try {
      await notify(shop, `💰 새 주문! ${item.title}${qty > 1 ? ` × ${qty}` : ''} (${won(total)}) · 예약 구매`, 'sale', saleVars(shop, item, total, qty));
      const after = await store.itemById(item.id);
      if (after && after.stock != null && !stockLines(after.stock).length) await notify(shop, `📦 재고가 0이 됐어요: ${item.title}. 재고를 채워주세요.`, 'stock', { item: item.title, shop: shop.name, link: BASE + '/i/' + item.id });
    } catch (e) { console.error('알림 실패', e.message); }
    pushToUser(r.user_id, { title: '예약한 상품이 구매됐어요', body: `${item.title}${qty > 1 ? ` × ${qty}` : ''} · 구매 내역에서 확인하세요`, url: '/o/' + order.token }).catch((e) => console.error('push 실패', e.message));
    return true;
  } catch (e) {
    console.error('예약 구매 처리 실패', r.id, e.message);
    if (!ordered) { try { if (lines) await restoreLines(item.id, lines); await store.updateResv(r.id, { status: 'waiting' }); } catch (x) { console.error('예약 복구 실패', x.message); } }
    return false;
  }
}

// 재고가 들어온 상품의 예약을 먼저 예약한 순서대로 처리해요 (재고가 모자라 못 사는 예약은 건너뛰고, 다음 재고 때 다시 앞순서로 처리)
async function fulfillReservations(itemId) {
  if (resvBusy.has(itemId)) return;
  resvBusy.add(itemId);
  try {
    const list = await store.resvWaitingForItem(itemId);
    for (const r of list) { await fulfillOne(r); }
  } finally { resvBusy.delete(itemId); }
}

const reserveHandler = async (req, res, m, u) => {
  const item = await store.itemById(m[1]);
  if (!item) return notFound(res, '아이템을 찾을 수 없어요');
  const shop = await store.shopById(item.shop);
  if (!shop || shop.deleted) return notFound(res, '아이템을 찾을 수 없어요');
  if (isBlocked(shop, u.id)) return send(res, 403, page('이용 제한', `<h1>${BLOCKED_MSG}</h1>`));
  if (!(await licenseOk(shop))) return send(res, 403, page('이용 불가', `<h1>${NO_LICENSE_MSG}</h1>`));
  const back = `<p><a href="/i/${item.id}">돌아가기</a></p>`;
  if (item.stock == null) return send(res, 400, page('예약 불가', `<h1>재고형 상품만 예약할 수 있어요</h1>${back}`));
  if (stockLines(item.stock).length) return send(res, 400, page('재고 있음', `<h1>지금 재고가 있어요</h1><p class="sub">예약하지 않고 바로 구매할 수 있어요.</p>${back}`));
  const f = await readForm(req);
  const qty = parseInt(f.qty, 10);
  if (!(qty >= 1 && qty <= MAX_RESV_QTY)) return send(res, 400, page('수량 오류', `<h1>예약은 1~${MAX_RESV_QTY}개까지 할 수 있어요</h1>${back}`));
  const limB = itemLimit(item);
  if (limB) {
    const have = await boughtCount(item, u.id);
    if (have + qty > limB) return send(res, 400, page('구매 한도', `<h1>인당 구매 한도를 넘어요</h1><p class="sub">이 상품은 한 사람이 ${limB}개까지 살 수 있어요. 지금까지 ${have}개 샀어요.</p>${back}`));
  }
  let mine;
  try { mine = await store.resvUserItem(u.id, item.id); }
  catch (e) {
    console.error('예약 표 확인 실패', e.message);
    const canMod = u.id === shop.owner || isAdmin(u);
    return send(res, 500, page('예약 준비 중', canMod ? `<h1>예약 기능을 쓰려면 한 번 설정이 필요해요</h1><p class="warn">Supabase SQL Editor에서 아래를 한 번 실행해 주세요.</p><p><code>${esc(RESV_SQL)}</code></p>${back}` : `<h1>예약을 잠시 쓸 수 없어요</h1><p class="sub">판매자에게 문의해 주세요.</p>${back}`));
  }
  if (mine.length) return send(res, 400, page('이미 예약함', `<h1>이미 예약한 상품이에요</h1><p class="sub">수량을 바꾸려면 예약을 취소하고 다시 예약해 주세요.</p>${back}`));
  const disc = await discountOf(u.id, item.shop);
  const total = discPrice(item.price, disc) * qty;
  const bal = await store.addShopPoints(u.id, item.shop, -total); // 포인트를 먼저 빼 둬요
  if (bal == null) return send(res, 400, page('포인트 부족', `<h1>이 상점 포인트가 부족해요</h1><p class="sub">${qty > 1 ? `${qty}개 ` : ''}${pts(total)}가 필요해요. 예약하면 포인트가 먼저 빠지고, 취소하면 돌려받아요.</p><p><a href="/w/${item.shop}">충전하러 가기</a></p>`));
  const r = { id: rid(9), user_id: u.id, shop: item.shop, item: item.id, item_title: String(item.title).slice(0, 80), qty, total, status: 'waiting', created: Date.now() };
  try { await store.createResv(r); }
  catch (e) {
    await store.addShopPoints(u.id, item.shop, total); // 실패하면 포인트를 바로 돌려줘요
    console.error('예약 저장 실패 (reservations 표가 있나요?)', e.message);
    const canMod = u.id === shop.owner || isAdmin(u);
    return send(res, 500, page('예약 실패', canMod ? `<h1>예약을 저장하지 못했어요</h1><p class="warn">Supabase SQL Editor에서 아래를 한 번 실행한 뒤 다시 시도해 주세요. (포인트는 돌려놨어요)</p><p><code>${esc(RESV_SQL)}</code></p>${back}` : `<h1>예약을 저장하지 못했어요</h1><p class="sub">포인트는 그대로예요. 잠시 뒤 다시 시도해 주세요.</p>${back}`));
  }
  try { await store.addLedger({ id: rid(9), user_id: u.id, shop: item.shop, delta: -total, kind: 'reserve', ref: r.id, note: `예약: ${item.title}${qty > 1 ? ` × ${qty}` : ''}`, created: Date.now() }); } catch (e) { console.error('ledger', e.message); }
  notify(shop, `🔖 새 예약! ${item.title} × ${qty}`, 'resv', { item: item.title, qty, shop: shop.name, link: BASE + '/i/' + item.id }).catch((e) => console.error('알림 실패', e.message));
  fulfillReservations(item.id).catch((e) => console.error('예약 처리 실패', e.message)); // 예약하는 사이 재고가 들어왔을 수도 있어서 한 번 더 확인
  redirect(res, `/i/${item.id}`);
};
route('POST', /^\/i\/([\w-]+)\/reserve$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=' + enc('/i/' + m[1]));
  const k = u.id + '|resv|' + m[1];
  if (buyLocks.has(k)) return send(res, 429, page('처리 중', `<h1>처리 중이에요</h1><p class="sub">이미 예약을 처리하고 있어요. 잠시 뒤에 확인해 주세요.</p><p><a href="/i/${esc(m[1])}">돌아가기</a></p>`));
  buyLocks.add(k);
  try { return await reserveHandler(req, res, m, u); } finally { buyLocks.delete(k); }
});

route('POST', /^\/reservations\/([\w-]+)\/cancel$/, async (req, res, m) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/reservations');
  const r = await store.resvById(m[1]);
  if (!r || r.user_id !== u.id) return notFound(res, '예약을 찾을 수 없어요');
  if (await store.claimResv(r.id, 'waiting', 'cancelling')) await refundResv(r, 'cancelled', `예약 취소: ${r.item_title || ''}`);
  redirect(res, '/reservations');
});

route('GET', /^\/reservations$/, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return redirect(res, '/login?next=/reservations');
  const list = await safeResv(() => store.resvByUser(u.id));
  const stat = { waiting: '예약 중', processing: '처리 중', done: '구매 완료', cancelled: '취소됨', cancelling: '취소 중' };
  const card = (r) => `<div class="card"><b>${esc(r.item_title || '상품')}</b> <span class="sub">× ${esc(r.qty)} · ${pts(r.total)}</span><br><span class="sub">${esc(stat[r.status] || r.status)} · ${fmtDate(r.created)}</span><br>${r.status === 'done' && r.order_token ? `<a href="/o/${esc(r.order_token)}">구매 내역 보기</a>` : `<a href="/i/${esc(r.item)}">상품 보기</a>`}${r.status === 'waiting' ? `<form method="post" action="/reservations/${esc(r.id)}/cancel" onsubmit="return confirm('예약을 취소할까요? 낸 포인트는 돌려받아요.')" style="margin-top:8px"><button style="background:#f4f4f5;color:#dc2626">예약 취소</button></form>` : ''}</div>`;
  send(res, 200, page('내 예약', `<a class="sub" href="/wallet">← 내 포인트</a><h1>내 예약</h1><p class="sub">품절 상품을 예약하면 재고가 들어올 때 예약한 순서대로 자동 구매돼요. 예약 금액은 먼저 빠지고, 취소하면 돌려받아요.</p>${list.map(card).join('') || '<div class="card"><span class="sub">아직 예약이 없어요.</span></div>'}`));
});

// 재고가 다른 경로로 들어왔거나 서버가 다시 켜진 경우를 위해 1분마다 대기 중인 예약을 한 번씩 확인해요
let resvSweepWarned = false;
setInterval(async () => {
  try {
    const ids = [...new Set((await store.resvWaitingAll()).map((r) => r.item))];
    for (const id of ids) await fulfillReservations(id);
  } catch (e) { if (!resvSweepWarned) { resvSweepWarned = true; console.error('예약 확인 실패 (reservations 표가 있나요?)', e.message); } }
}, 60000).unref();

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
  send(res, 200, page('내 포인트', `<a class="sub" href="/my">← 내 상점</a><h1>내 포인트</h1><p class="sub"><a href="/reservations">내 예약 보기</a></p><p class="sub">포인트는 충전한 상점에서만 쓸 수 있어요 (1P = 1원). 회원번호 <b>${esc(u.id.slice(0, 8))}</b> · 칭호를 받을 때 판매자에게 알려주세요.</p>
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
  const lq = (q.get('lq') || '').trim().slice(0, 30); // 내역 검색어
  const label = { charge: '충전', buy: '구매', admin: '상점 조정', payback: '페이백', reserve: '예약 (선결제)', reserve_cancel: '예약 취소 (환불)' };
  let log = await store.ledgerForUserShop(u.id, shop.id, lq ? 1000 : 30); // 검색할 땐 더 옛날 것까지 찾아봐요
  if (lq) { const w = lq.toLowerCase(); log = log.filter((l) => `${label[l.kind] || l.kind} ${l.note || ''} ${fmtDate(l.created)} ${Math.abs(Number(l.delta) || 0)} ${Number(l.delta) || 0}`.toLowerCase().includes(w)); }
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
<form class="row" method="get" action="/w/${shop.id}" style="margin:0 0 12px"><input name="lq" value="${esc(lq)}" placeholder="상품 이름·구매·충전·날짜로 검색" maxlength="30" aria-label="내역 검색"><button style="color:#fff">검색</button></form>${lq ? `<p class="sub">'${esc(lq)}' 검색 결과 ${log.length}건 · <a href="/w/${shop.id}">전체 보기</a></p>` : ''}
${log.map((l) => `<div class="card"><span class="sub">${fmtDate(l.created)}</span><br>${l.kind === 'buy' ? `<a href="/o/${esc(l.ref)}">${esc(label.buy)} · ${esc(l.note)}</a>` : `${esc(label[l.kind] || l.kind)}${l.note && (l.kind === 'admin' || l.kind === 'payback') ? ' · ' + esc(l.note) : ''}`} <b>${l.delta > 0 ? '+' : ''}${Number(l.delta).toLocaleString('ko-KR')}P</b></div>`).join('') || `<p class="sub"><i class="empty">${lq ? '검색 결과가 없어요' : '비어 있어요'}</i></p>`}`));
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
${sh.deleted ? `<form method="post" action="/admin/shops/${sh.id}/restore"><button style="background:#111111">복구</button></form><form method="post" action="/admin/shops/${sh.id}/purge" onsubmit="return confirm('${esc(sh.name).replace(/&#39;/g, '')} 상점을 영구 삭제할까요?\\n아이템·주문·후기·충전·포인트 기록이 모두 지워지고, 구매자도 구매한 내용을 다시 볼 수 없어요. 절대 되돌릴 수 없어요.')"><button style="background:#7f1d1d;margin-top:6px">영구 삭제</button></form>` : `<form method="post" action="/admin/shops/${sh.id}/delete" onsubmit="return confirm('이 상점을 삭제할까요? 사이트에서 사라지고 새 구매·충전이 막혀요. (복구할 수 있어요)')"><button style="background:#dc2626">상점 삭제</button></form>`}</div>`).join('') || `<p class="sub">${sq ? '검색 결과가 없어요' : '상점이 없어요'}</p>`}
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
  const myResv = left === 0 && me ? await safeResv(() => store.resvUserItem(me.id, item.id)) : [];
  const body = `<a class="sm" style="text-decoration:none" href="/s/${shop.id}">← ${esc(shop.name)}</a>
<div class="pc" style="margin-top:12px"><div class="im" style="aspect-ratio:4/3"><img src="${item.image ? `/img/${item.id}` : `/default-product.jpg?v=${ICON_VER}`}" alt=""></div><div class="pb"><h2>${esc(item.title)}</h2>
<div class="rt">${ICO.star}<span>${reviews.length ? avg.toFixed(1) : '-'}</span>${reviews.length ? `<span class="sm">(${reviews.length})</span>` : ''}<span class="sm" style="margin-left:auto">판매 ${sold}건</span></div>
<div class="pr">${disc ? `<span><s class="sm">${won(item.price)}</s> <b>${won(discPrice(item.price, disc))}</b> <span class="sm">(${disc}% 할인)</span></span>` : `<b>${won(item.price)}</b>`}<span>재고: <b>${stockTxt}</b></span></div></div></div>
${item.preview ? `<div class="bx" style="white-space:pre-wrap">${esc(item.preview)}</div>` : ''}
${lim ? `<div class="nt">인당 ${lim}개까지 살 수 있어요${me ? ` (내가 산 개수 ${haveN}개 · 남은 ${remain}개)` : ''}</div>` : ''}
${left === 0 ? (licOk && !blockedMe ? reserveBlock(item, me, bal, disc, myResv) : '<div class="nt">품절이에요</div>') : !licOk ? '<div class="nt">지금은 판매가 중단된 상점이에요</div>' : blockedMe ? `<div class="nt">${BLOCKED_MSG}</div>` : remain === 0 ? '<div class="nt">인당 구매 한도에 도달해서 더 살 수 없어요</div>' : pointsBlock(item, me, bal, shop, disc, remain)}
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
${item.secret && !itemLicDays(item) ? `<div class="secret">${esc(item.secret)}</div>` : ''}
${itemLicDays(item) && order.delivered ? '<p class="sub">내 상점 → 자동 충전 이용권 칸에 키를 붙여넣으면 등록돼요</p>' : ''}
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
