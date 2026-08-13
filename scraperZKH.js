const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const proxyManager = require('./proxyManager');

const ZKH_BASE = 'https://www.zkh.com';
const ZKH_API_BASE = 'https://www.zkh.com/servezkhApi';
const ZKH_AUTH_BASE = 'https://www.zkh.com/zkhweb/zkhAuth';

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

const SINGLE_PROXY_TIMEOUT = 10000;
const TOTAL_REQUEST_TIMEOUT = 60000;
const CONCURRENT_PROXIES = 5;
const MAX_ROUNDS = 10;

let globalCookieJar = new CookieJar();
let cookieAxios = wrapper(axios.create({ jar: globalCookieJar, withCredentials: true }));

let dynamicCookieString = '';
const COOKIE_FILE_PATH = require('path').join(__dirname, 'cookies.json');
try {
  if (fs.existsSync(COOKIE_FILE_PATH)) {
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE_PATH, 'utf8'));
    if (data.cookie_string) {
      dynamicCookieString = data.cookie_string;
      console.log(`[Cookie] 从 cookies.json 加载了 ${data.cookies?.length || 0} 个 Cookie`);
    }
  }
} catch (e) {
  console.warn('[Cookie] 读取 cookies.json 失败:', e.message);
}

const USER_COOKIE_FROM_BROWSER = process.env.ZKH_COOKIE_FROM_BROWSER || dynamicCookieString || '';
let sessionInitialized = false;

function injectBrowserCookieIntoJar() {
  if (!USER_COOKIE_FROM_BROWSER) return { ok: false, count: 0 };
  try {
    let count = 0;
    const cookies = USER_COOKIE_FROM_BROWSER.split(';').filter(Boolean);
    for (const raw of cookies) {
      const idx = raw.indexOf('=');
      if (idx === -1) continue;
      const name = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (!name) continue;
      try { globalCookieJar.setCookieSync(`${name}=${value}`, ZKH_BASE); count++; } catch {}
    }
    console.log(`[Cookie] 已注入 ${count} 个浏览器 Cookie`);
    return { ok: true, count };
  } catch (e) {
    return { ok: false, count: 0, error: e.message };
  }
}

function getCookieStatus() {
  try {
    const all = globalCookieJar.getCookiesSync(ZKH_BASE);
    return { jar_count: all.length, names: all.map(c => c.key), session_initialized: sessionInitialized, env_cookie_detected: !!USER_COOKIE_FROM_BROWSER, env_cookie_length: USER_COOKIE_FROM_BROWSER.length, cookie_source: dynamicCookieString ? 'cookies.json' : (process.env.ZKH_COOKIE_FROM_BROWSER ? 'env' : 'none') };
  } catch { return { jar_count: 0, names: [], session_initialized: false }; }
}

function randomUA() { return DESKTOP_UAS[Math.floor(Math.random() * DESKTOP_UAS.length)]; }
function generateTraceId() { return `${Date.now()}${Math.floor(Math.random()*1e12).toString().padStart(12,'0')}${Math.floor(Math.random()*10)}`; }

function isSevereProxyError(msgOrCode) {
  if (!msgOrCode) return false;
  return /CERT|TLS|SSL|403|407|405|PROXY_AUTH|ECONNREFUSED|HANDSHAKE|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED/.test(String(msgOrCode).toUpperCase());
}

async function ensureSession(proxy = null) {
  if (sessionInitialized) return { ok: true, source: 'cached' };
  try {
    const injected = injectBrowserCookieIntoJar();
    if (injected.ok && injected.count > 0) {
      sessionInitialized = true;
      return { ok: true, source: 'inject', count: injected.count };
    }
    const r = await requestWithProxyRaw({ method: 'GET', url: ZKH_BASE + '/', headers: { 'Accept': 'text/html' }, proxy, extraSessionInit: true });
    if (r.success) {
      sessionInitialized = true;
      return { ok: true, source: 'homepage' };
    }
    return { ok: false, error: r.error };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function requestWithProxyRaw({ method = 'GET', url, headers = {}, params = {}, data = null, proxy = null, extraSessionInit = false }) {
  const allHeaders = { 'User-Agent': randomUA(), 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive', 'Referer': ZKH_BASE + '/', ...headers };
  const proxyCfg = proxyManager.createAxiosProxyConfig(proxy);
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), SINGLE_PROXY_TIMEOUT);
  try {
    const axiosArgs = { method, url, params: { ...params, traceId: params?.traceId || generateTraceId() }, headers: allHeaders, signal: controller.signal, timeout: SINGLE_PROXY_TIMEOUT, responseType: 'text', withCredentials: true, jar: globalCookieJar, ...proxyCfg };
    let resp;
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') { resp = await cookieAxios(axiosArgs); }
    else { resp = await cookieAxios({ ...axiosArgs, data }); }
    clearTimeout(timeoutTimer);
    return { success: true, data: resp.data, status: resp.status, proxy };
  } catch (err) {
    clearTimeout(timeoutTimer);
    proxyManager.markBad(proxy, isSevereProxyError(err.code || err.message));
    return { success: false, error: err.code || err.message, proxy };
  }
}

async function requestWithProxy({ method = 'GET', url, headers = {}, params = {}, data = null, proxy = null }) {
  await ensureSession(proxy);
  return await requestWithProxyRaw({ method, url, headers, params, data, proxy });
}

async function raceConcurrent(taskFn, count = CONCURRENT_PROXIES) {
  const promises = [];
  for (let i = 0; i < count; i++) { const proxy = proxyManager.getNextProxy(); promises.push((async () => { try { return await taskFn(proxy); } catch (e) { return { success: false, error: e.message, proxy }; } })()); }
  const results = await Promise.allSettled(promises);
  const succ = results.find(r => r.status === 'fulfilled' && r.value?.success);
  if (succ) { proxyManager.markGood(succ.value.proxy); return succ.value; }
  const fail = results.find(r => r.status === 'fulfilled');
  return fail ? fail.value : { success: false, error: 'all failed' };
}

async function multiRoundRun(taskFn, roundCount = MAX_ROUNDS, concurrent = CONCURRENT_PROXIES) {
  const deadline = Date.now() + TOTAL_REQUEST_TIMEOUT;
  const errors = [];
  for (let round = 0; round < roundCount; round++) {
    if (Date.now() >= deadline) break;
    const res = await raceConcurrent(taskFn, concurrent);
    if (res?.success) return { ...res, rounds: round + 1, errors };
    errors.push(`R${round}:${res?.error || 'na'}`);
    if (round % 2 === 1) { try { await proxyManager.refreshProxies(false); } catch {} }
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
  }
  return { success: false, error: `多轮重试失败（共${roundCount}轮）`, rounds: roundCount, errors };
}

function isWafBlocked(html) { return html?.includes('访问验证') || html?.includes('滑动验证') || html?.includes('请按住滑块') || html?.includes('请进行验证'); }
function isLoginRedirect(html) { return html?.includes('passport.zkh.com') || html?.includes('请先登录'); }

async function searchProducts(keyword, page = 1, pageSize = 40) {
  const result = await multiRoundRun(async (proxy) => {
    await requestWithProxy({ url: ZKH_BASE + '/', headers: { 'Accept': 'text/html' }, proxy });
    const searchPageUrl = `${ZKH_BASE}/search.html?keywords=${encodeURIComponent(keyword)}&hasLinkWord=`;
    const resp = await requestWithProxy({ url: searchPageUrl, headers: { 'Accept': 'text/html', 'Referer': ZKH_BASE + '/' }, proxy });
    if (!resp.success) return resp;
    const parsed = tryParseSearchFromHtml(resp.data, keyword, page, pageSize, proxy);
    if (parsed?.success && parsed.data?.products?.length > 0) return parsed;
    const apiResp = await requestWithProxy({ method: 'POST', url: `${ZKH_API_BASE}/search/product/pc`, data: { keyword, page: Number(page), pageSize: Number(pageSize), sort: '', order: '', filter: {}, areaCode: '' }, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Referer': searchPageUrl }, proxy });
    if (!apiResp.success) return apiResp;
    try {
      const j = typeof apiResp.data === 'string' ? JSON.parse(apiResp.data) : apiResp.data;
      if ((j.success || j.code === '0000' || j.code === 200) && (j.result || j.data)) return { success: true, data: parseSearchResult(j.result || j.data, keyword, page, pageSize), proxy };
      return { success: false, error: j.msg || j.message || 'code=' + j.code, proxy };
    } catch (e) { return { success: false, error: 'api parse: ' + e.message, proxy }; }
  });
  if (!result?.success) {
    try {
      await ensureSession(null);
      const directResp = await cookieAxios.get(`${ZKH_BASE}/search.html?keywords=${encodeURIComponent(keyword)}&hasLinkWord=`, { timeout: 20000, headers: { 'User-Agent': randomUA(), 'Accept': 'text/html' }, responseType: 'text', maxRedirects: 5, withCredentials: true, jar: globalCookieJar });
      const dp = tryParseSearchFromHtml(directResp.data, keyword, page, pageSize, 'direct');
      if (dp?.success) return formatSearchResult({ ...dp, rounds: 0 }, keyword, page, pageSize);
    } catch (e) {}
  }
  return formatSearchResult(result, keyword, page, pageSize);
}

function tryParseSearchFromHtml(html, keyword, page, pageSize, proxy) {
  try {
    if (isWafBlocked(html)) return { success: false, error: 'WAF blocked', proxy };
    if (isLoginRedirect(html)) return { success: false, error: 'login redirect', proxy };
    const $ = cheerio.load(html || '');
    const stripHtml = (s) => typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? '');
    const products = [];
    const seen = new Set();
    const add = (p) => { if (p.sku_no && !seen.has(String(p.sku_no))) { seen.add(String(p.sku_no)); products.push(p); } };
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const findArr = (o, d=0) => { if (d>6||!o||typeof o!=='object') return null; if (Array.isArray(o)&&o[0]&&(o[0].skuNo||o[0].productNo||o[0].productName)) return o; for (const k of Object.keys(o)) { if (Array.isArray(o[k])&&o[k][0]&&(o[k][0].skuNo||o[k][0].productNo||o[k][0].productName)) return o[k]; if (typeof o[k]==='object') { const f=findArr(o[k],d+1); if(f) return f; } } return null; };
        const arr = findArr(JSON.parse(nextData).props?.pageProps||{});
        if (arr) arr.forEach(i => { const s=i.skuNo||i.productNo||i.spuNo; if(s) add({sku_no:String(s),title:stripHtml(i.productName||i.title||''),brand:stripHtml(i.brand||''),price:i.price||null,image:i.mainPic||'',url:`${ZKH_BASE}/item/${s}.html`}); });
      } catch {}
    }
    if (!products.length) { $('a[href*="/item/"]').each((_,a) => { const m=($(a).attr('href')||'').match(/\/item\/([A-Za-z0-9]+)\.html/); if(m) add({sku_no:m[1],title:stripHtml($(a).text()).substring(0,200),url:`${ZKH_BASE}/item/${m[1]}.html`}); }); }
    if (!products.length) { for (const m of html?.matchAll(/\/item\/([A-Z]{1,5}\d{3,})\.html/g)||[]) add({sku_no:m[1],title:'',url:`${ZKH_BASE}/item/${m[1]}.html`}); }
    if (!products.length) return { success: false, error: 'parse empty', proxy };
    return { success: true, data: { keyword, page: Number(page), page_size: Number(pageSize), total: products.length, total_pages: 1, products: products.slice(0, Number(pageSize)) }, proxy };
  } catch (e) { return { success: false, error: 'parse: ' + e.message, proxy }; }
}

function parseSearchResult(raw, keyword, page, pageSize) {
  const list = raw.list || raw.data?.list || raw.items || [];
  const stripHtml = (s) => typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? '');
  return { keyword, page: Number(page), page_size: Number(pageSize), total: raw.total || list.length, total_pages: Math.ceil((raw.total||list.length)/Number(pageSize)), products: list.map(i => ({ sku_no: i.skuNo||i.productNo||i.id, title: stripHtml(i.productName||i.title||''), brand: stripHtml(i.brand||''), price: i.price||null, image: i.mainPic||'', url: i.skuNo?`${ZKH_BASE}/item/${i.skuNo}.html`:'' })) };
}

function formatSearchResult(result, keyword, page, pageSize) {
  if (!result?.success) return { success: false, error: result?.error||'搜索失败', keyword, page: Number(page), page_size: Number(pageSize), products: [] };
  return { success: true, ...result.data };
}

async function getProductDetail(skuNo) {
  const result = await multiRoundRun(async (proxy) => {
    const detailPageUrl = `${ZKH_BASE}/item/${skuNo}.html`;
    await requestWithProxy({ url: detailPageUrl, headers: { 'Accept': 'text/html' }, proxy });
    const apiHeaders = { 'Content-Type': 'application/json;charset=UTF-8', 'Referer': detailPageUrl };
    const settled = await Promise.allSettled([
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/1/coupons/${skuNo}`, params: { detailType: 2 }, headers: apiHeaders, proxy }),
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/tags/${skuNo}`, headers: apiHeaders, proxy }),
      requestWithProxy({ method: 'POST', url: `${ZKH_API_BASE}/goods/1/selectSpec`, data: { skuNo }, headers: apiHeaders, proxy }),
    ]);
    const pj = (r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } };
    const couponsRaw = settled[0].status==='fulfilled'&&settled[0].value.success ? pj(settled[0].value.data) : null;
    const specRaw = settled[2].status==='fulfilled'&&settled[2].value.success ? pj(settled[2].value.data) : null;
    const pageResp = await requestWithProxy({ url: detailPageUrl, headers: { 'Accept': 'text/html' }, proxy });
    const pageParse = pageResp.success ? parseDetailFromHtml(pageResp.data, skuNo) : null;
    if (!pageParse && !couponsRaw && !specRaw) return { success: false, error: 'all invalid', proxy };
    return { success: true, data: mergeDetailData({ skuNo, pageParse, couponsRaw, specRaw }), proxy };
  });
  if (!result?.success) {
    try {
      await ensureSession(null);
      const directResp = await cookieAxios.get(`${ZKH_BASE}/item/${skuNo}.html`, { timeout: 20000, headers: { 'User-Agent': randomUA(), 'Accept': 'text/html' }, responseType: 'text', maxRedirects: 5, withCredentials: true, jar: globalCookieJar });
      const pp = parseDetailFromHtml(directResp.data, skuNo);
      if (pp) return { success: true, ...mergeDetailData({ skuNo, pageParse: pp, couponsRaw: null, specRaw: null }), rounds: 0 };
    } catch (e) {}
  }
  if (!result?.success) return { success: false, error: result?.error||'详情获取失败', sku_no: skuNo };
  return { success: true, ...result.data };
}

function parseDetailFromHtml(html, skuNo) {
  try {
    if (isWafBlocked(html)||isLoginRedirect(html)) return null;
    const $ = cheerio.load(html||'');
    const title = $('title').text().split('【')[0].split(/[|_-]/)[0].trim();
    const desc = $('meta[name="description"]').attr('content')||'';
    const images = [];
    $('img[src*="PRODUCT"]').each((_,img) => { const s=$(img).attr('src')||$(img).attr('data-src'); if(s) images.push(s); });
    let mainTitle=''; $('h1,[class*="title"]').each((_,el) => { const t=$(el).text().trim(); if(t.length>5&&t.length<200&&!mainTitle) mainTitle=t; });
    let price=null; $('[class*="[Pp]rice"]').each((_,el) => { const t=$(el).text().replace(/[^\d.]/g,''); if(t&&price===null) { const n=parseFloat(t); if(n>0&&n<999999) price=n; } });
    const specs={}; const text=$('body').text();
    ['品牌名称','商品型号','订货编码','包装规格','起订量','最小包装量','发货日','销售单位'].forEach(f => { const m=text.match(new RegExp(`${f}[\\s:：]*([^\\n\\r]{1,80}?)\\s*(?=(品牌名称|商品型号|订货编码|包装规格|起订量|最小包装量|发货日|销售单位|$)`,'m')); if(m?.[1]) specs[f]=m[1].trim().replace(/\s+/g,' ').slice(0,80); });
    return { title: mainTitle||title, description: desc, images, main_image: images[0]||'', price, specs };
  } catch { return null; }
}

function mergeDetailData({ skuNo, pageParse, couponsRaw, specRaw }) {
  const spec = specRaw?.result || specRaw?.data || {};
  const coupons = couponsRaw?.result || couponsRaw?.data || {};
  return {
    sku_no: skuNo,
    title: spec.productName || pageParse?.title || '',
    brand: spec.brand || pageParse?.specs?.['品牌名称'] || '',
    model: spec.model || pageParse?.specs?.['商品型号'] || '',
    price: coupons.price || spec.price || pageParse?.price || null,
    main_image: pageParse?.main_image || '',
    images: pageParse?.images || [],
    specs: { ...pageParse?.specs },
    description: pageParse?.description || '',
    url: `${ZKH_BASE}/item/${skuNo}.html`,
  };
}

function resetSession() {
  try {
    globalCookieJar = new CookieJar();
    cookieAxios = wrapper(axios.create({ jar: globalCookieJar, withCredentials: true }));
    sessionInitialized = false;
    return { ok: true, new_status: getCookieStatus() };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { searchProducts, getProductDetail, getCookieStatus, resetSession };
