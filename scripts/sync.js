#!/usr/bin/env node
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const LARK_HOST = 'open.feishu.cn';
const APP_TOKEN = 'NEeMbt9PTat8tMsjTpGcVH4Dnlf';
const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';

const TABLES = {
  detail: 'tblL0uQm5ROMBlIJ',
  summary: 'tbl0djvImOOjIOkt',
  highsales: 'tbl3HqbHwicGpPby',
};

const SLUG = {
  '烟台': 'yantai', '济宁': 'jining', '临沂': 'linyi',
  '济南': 'jinan', '潍坊': 'weifang', '青岛': 'qingdao',
};

function fail(msg) { console.error(msg); process.exit(1); }

function request(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      host: LARK_HOST, method, path: p,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}),
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('解析响应失败: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getTenantToken() {
  if (!APP_ID || !APP_SECRET) fail('缺少 LARK_APP_ID 或 LARK_APP_SECRET');
  const d = await request('POST', '/open-apis/auth/v3/tenant_access_token/internal', null,
    { app_id: APP_ID, app_secret: APP_SECRET });
  if (d.code !== 0) fail('获取 token 失败: ' + JSON.stringify(d));
  return d.tenant_access_token;
}

async function listRecords(token, tableId) {
  const out = [];
  let pageToken = '';
  const headers = { Authorization: 'Bearer ' + token };
  for (;;) {
    let p = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500`;
    if (pageToken) p += '&page_token=' + encodeURIComponent(pageToken);
    let d;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { d = await request('GET', p, headers); break; }
      catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (d.code !== 0) fail('读取表失败: ' + JSON.stringify(d));
    const data = d.data || {};
    (data.items || []).forEach((it) => out.push(it.fields || {}));
    if (data.has_more && data.page_token) { pageToken = data.page_token; }
    else break;
  }
  return out;
}

// 获取一张表的全部 record_id（删除时使用）
async function listRecordIds(token, tableId) {
  const ids = [];
  let pageToken = '';
  const headers = { Authorization: 'Bearer ' + token };
  for (;;) {
    let p = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500`;
    if (pageToken) p += '&page_token=' + encodeURIComponent(pageToken);
    let d;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { d = await request('GET', p, headers); break; }
      catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (d.code !== 0) fail('读取 record_id 失败: ' + JSON.stringify(d));
    const data = d.data || {};
    (data.items || []).forEach((it) => { if (it.record_id) ids.push(it.record_id); });
    if (data.has_more && data.page_token) { pageToken = data.page_token; }
    else break;
  }
  return ids;
}

// 删除一张表的全部现有记录（每次同步前清空，避免历史记录堆积导致数据叠加）。
// 飞书「删除多条记录」接口为 POST .../records/batch_delete，单次最多 500 条。
async function deleteAllRecords(token, tableId) {
  const ids = await listRecordIds(token, tableId);
  if (!ids.length) { console.error(`表 ${tableId} 无历史记录，无需清空`); return 0; }
  const headers = { Authorization: 'Bearer ' + token };
  const p = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_delete`;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    let d;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { d = await request('POST', p, headers, { records: batch }); break; }
      catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (d.code !== 0) fail(`清空表 ${tableId} 失败: ` + JSON.stringify(d));
    deleted += batch.length;
  }
  console.error(`已清空表 ${tableId} 的 ${deleted} 条历史记录`);
  return deleted;
}

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((s) => (s && typeof s === 'object') ? (s.text || s.name || '') : String(s)).join('');
  if (typeof v === 'object') return v.text || v.name || '';
  return String(v);
}
function num(v) {
  if (Array.isArray(v) && v.length) v = v[0];
  if (v && typeof v === 'object') v = (v.text !== undefined ? v.text : 0);
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(v) {
  const ms = num(v);
  if (ms > 0) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return txt(v);
}
function mapDetail(r) {
  return {
    poiName: txt(r['核销poi名称']), poiId: txt(r['核销poi_id']),
    bdm: txt(r['BDM']), bd: txt(r['销售名称(BD)']),
    category: txt(r['总户商家二级类目']), countType: txt(r['单双计']),
    standard: txt(r['扫码核销是否达标']),
    today: num(r['今日扫码']), yesterday: num(r['昨日同期']), delta: num(r['增减量']),
  };
}
function mapSummary(r) {
  return {
    group: txt(r['小组']), storeCount: Math.round(num(r['总门店数'])),
    activeStores: Math.round(num(r['今日扫码动销门店'])), activeRate: num(r['扫码动销率']),
    today: num(r['今日扫码']), yesterday: num(r['昨日时点扫码']), delta: num(r['扫码环比增量']),
    standardStores: Math.round(num(r['达标门店数'])), standardRate: num(r['达标占比']),
  };
}
function mapHigh(r) {
  return {
    poiName: txt(r['核销poi名称']), poiId: txt(r['核销poi_id']),
    bdm: txt(r['BDM']), bd: txt(r['销售名称(BD)']),
    countType: txt(r['单双计']), tier: txt(r['高销分层']), today: num(r['今日扫码']),
  };
}
// updated 字段使用 sync.js 实际运行时间（即数据写入多维表格/GitHub Actions 的执行时间），
// 而非从记录里读取「数据更新时间」字段。
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

(async function main() {
  const token = await getTenantToken();
  // 1) 先读取当前快照，用于生成 6 个城市 JSON（必须在清空之前读取，否则数据会丢失）
  const raw = {};
  for (const k of Object.keys(TABLES)) raw[k] = await listRecords(token, TABLES[k]);
  console.error(`拉取：detail=${raw.detail.length} summary=${raw.summary.length} highsales=${raw.highsales.length}`);
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const updated = nowStr(); // 统一使用本次 sync 运行时间作为「数据更新时间」
  for (const city of Object.keys(SLUG)) {
    const slug = SLUG[city];
    const detail = raw.detail.filter((r) => txt(r['城市']) === city).map(mapDetail);
    const summary = raw.summary.filter((r) => txt(r['城市']) === city).map(mapSummary);
    const highsales = raw.highsales.filter((r) => txt(r['城市']) === city).map(mapHigh);
    fs.writeFileSync(path.join(dir, slug + '.json'), JSON.stringify({ city, updated, detail, summary, highsales }), 'utf-8');
    console.error(`写入 data/${slug}.json: detail=${detail.length} summary=${summary.length} high=${highsales.length}`);
  }
  // 2) 清空三张表的全部历史记录，避免历史数据堆积导致下次同步时数据叠加。
  //    （快照已在上一步读取并落地为 JSON，因此此处清空不影响本轮数据展示）
  for (const k of Object.keys(TABLES)) await deleteAllRecords(token, TABLES[k]);
})().catch((e) => fail('同步失败: ' + (e && e.message)));
