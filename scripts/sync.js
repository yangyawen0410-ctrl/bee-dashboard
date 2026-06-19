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
function latestUpdate(rows) {
  const ts = rows.map((r) => fmtTime(r['数据更新时间'])).filter(Boolean);
  if (!ts.length) { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  return ts.sort()[ts.length - 1];
}

(async function main() {
  const token = await getTenantToken();
  const raw = {};
  for (const k of Object.keys(TABLES)) raw[k] = await listRecords(token, TABLES[k]);
  console.error(`拉取：detail=${raw.detail.length} summary=${raw.summary.length} highsales=${raw.highsales.length}`);
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  for (const city of Object.keys(SLUG)) {
    const slug = SLUG[city];
    const detail = raw.detail.filter((r) => txt(r['城市']) === city).map(mapDetail);
    const summary = raw.summary.filter((r) => txt(r['城市']) === city).map(mapSummary);
    const highsales = raw.highsales.filter((r) => txt(r['城市']) === city).map(mapHigh);
    const updated = latestUpdate(raw.detail.filter((r) => txt(r['城市']) === city));
    fs.writeFileSync(path.join(dir, slug + '.json'), JSON.stringify({ city, updated, detail, summary, highsales }), 'utf-8');
    console.error(`写入 data/${slug}.json: detail=${detail.length} summary=${summary.length} high=${highsales.length}`);
  }
})().catch((e) => fail('同步失败: ' + (e && e.message)));
