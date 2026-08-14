// 震坤行(zkh.com)爬虫服务 - web.zkh360.com POST API + 分类列表页 + 代理池兜底
//
// 架构（按优先级）：
//   1. web.zkh360.com POST API（推荐）：旧域名无WAF，直接返回JSON商品数据
//   2. 分类列表页解析：www.zkh.com/list/c-XXX.html 无WAF，解析__NEXT_DATA__
//   3. CF Worker 反代：利用 CF 全球边缘 IP 规避 WAF
//   4. 免费代理池：多代理并发竞态 + 多轮重试
//   5. 直连兜底
//
// 完全不依赖 Cookie、不需要过滑块、不需要 Chromium、不需要手动操作
const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('./proxyManager');

// ============ 配置 ============
const ZKH_BASE = 'https://www.zkh.com';
const ZKH360_API = 'https://web.zkh360.com';
const ZKH360_SEARCH_API = ZKH360_API + '/api/search/listProductInfo';

const CF_WORKER_URL = (process.env.CF_WORKER_URL || '').replace(/\/$/, '');
const CF_WORKER_SECRET = process.env.CF_WORKER_SECRET || '';
const USE_PROXY = process.env.USE_PROXY !== 'false';

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

const SINGLE_TIMEOUT = 12000;
const TOTAL_TIMEOUT = 45000;
const CONCURRENT = 3;
const MAX_ROUNDS = 6;

function randomUA() { return DESKTOP_UAS[Math.floor(Math.random() * DESKTOP_UAS.length)]; }

function buildHeaders(referer) {
  return {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,application/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="127", "Not)A;Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': referer || (ZKH_BASE + '/'),
  };
}

async function fetchViaCFWorker(targetPath, search) {
  if (!CF_WORKER_URL) return { success: false, error: 'CF_WORKER_URL not configured' };
  const url = CF_WORKER_URL + targetPath + (search || '');
  const headers = { 'Accept': 'text/html,application/xhtml+xml,*/*' };
  if (CF_WORKER_SECRET) headers['X-Proxy-Secret'] = CF_WORKER_SECRET;
  try {
    const resp = await axios.get(url, { headers, timeout: SINGLE_TIMEOUT, responseType: 'text', maxRedirects: 3 });
    if (resp.status === 200 && resp.data && !isWafPage(resp.data)) return { success: true, data: resp.data, source: 'cf-worker' };
    return { success: false, error: `cf-worker status=${resp.status} waf=${isWafPage(resp.data)}` };
  } catch (e) { return { success: false, error: 'cf-worker: ' + (e.code || e.message) }; }
}

async function fetchViaProxy(targetPath, search, referer) {
  const targetUrl = ZKH_BASE + targetPath + (search || '');
  const headers = buildHeaders(referer);
  const promises = [];
  for (let i = 0; i < CONCURRENT; i++) {
    const proxy = proxyManager.getNextProxy();
    promises.push((async () => {
      const proxyCfg = proxyManager.createAxiosProxyConfig(proxy);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SINGLE_TIMEOUT);
      try {
        const resp = await axios.get(targetUrl, { headers, timeout: SINGLE_TIMEOUT, responseType: 'text', maxRedirects: 3, signal: controller.signal, ...proxyCfg });
        clearTimeout(timer);
        if (resp.status === 200 && resp.data && !isWafPage(resp.data)) { proxyManager.markGood(proxy); return { success: true, data: resp.data, source: 'proxy', proxy }; }
        proxyManager.markBad(proxy, isWafPage(resp.data));
        return { success: false, error: `proxy waf/bad-status`, proxy };
      } catch (e) { clearTimeout(timer); const msg = e.code || e.message || 'unknown'; proxyManager.markBad(proxy, isSevereError(msg)); return { success: false, error: msg, proxy }; }
    })());
  }
  const results = await Promise.allSettled(promises);
  const ok = results.find(r => r.status === 'fulfilled' && r.value && r.value.success);
  return ok ? ok.value : { success: false, error: 'all proxies failed' };
}

async function fetchDirect(targetPath, search, referer) {
  const targetUrl = ZKH_BASE + targetPath + (search || '');
  try {
    const resp = await axios.get(targetUrl, { headers: buildHeaders(referer), timeout: SINGLE_TIMEOUT, responseType: 'text', maxRedirects: 3 });
    if (resp.status === 200 && resp.data && !isWafPage(resp.data)) return { success: true, data: resp.data, source: 'direct' };
    return { success: false, error: `direct status=${resp.status} waf=${isWafPage(resp.data)}` };
  } catch (e) { return { success: false, error: 'direct: ' + (e.code || e.message) }; }
}

async function fetchZKHPage(targetPath, search, referer) {
  const errors = [];
  if (CF_WORKER_URL) {
    const r = await fetchViaCFWorker(targetPath, search);
    if (r.success) { console.log(`[Fetch] CF Worker 成功: ${targetPath}`); return r; }
    errors.push('cf-worker: ' + r.error);
  }
  if (USE_PROXY && proxyManager.isEnabled()) {
    const deadline = Date.now() + TOTAL_TIMEOUT;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() >= deadline) { errors.push('total_timeout'); break; }
      const r = await fetchViaProxy(targetPath, search, referer);
      if (r.success) { console.log(`[Fetch] 代理成功 (R${round + 1}): ${targetPath}`); return r; }
      errors.push(`R${round + 1}:${r.error}`);
      if (round % 2 === 1) { try { await proxyManager.refreshProxies(false); } catch {} }
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }
  }
  const r = await fetchDirect(targetPath, search, referer);
  if (r.success) { console.log(`[Fetch] 直连成功: ${targetPath}`); return r; }
  errors.push('direct: ' + r.error);
  return { success: false, error: errors.join(' | '), errors };
}

function isWafPage(html) {
  if (!html || typeof html !== 'string') return false;
  return html.includes('请按住滑块') || html.includes('访问验证') || html.includes('滑动验证') || html.includes('slider') && html.includes('verify');
}
function isSevereError(msg) {
  const s = String(msg || '').toUpperCase();
  return /CERT|TLS|SSL|403|407|ECONNREFUSED|HANDSHAKE/.test(s);
}

// ============ 请求方式0：web.zkh360.com POST API（最优，无WAF）============
async function searchViaZKH360API(keyword, page = 1, pageSize = 40) {
  const from = (Number(page) - 1) * Number(pageSize);
  const body = { from, size: Number(pageSize), keyword: keyword || null, fz: false, catalogueId: null, productFilter: { brandIds: [], properties: {} }, cityCode: 310100, extraFilter: { showIndustryFeatured: false, inStock: false }, searchType: { notNeedCorrect: false }, clp: true };
  try {
    const resp = await axios.post(ZKH360_SEARCH_API, body, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA(), 'Accept': 'application/json', 'Origin': ZKH360_API, 'Referer': ZKH360_API + '/' },
      timeout: 15000, maxRedirects: 3, validateStatus: () => true,
    });
    if (resp.status !== 200) return { success: false, error: `zkh360 API status=${resp.status}` };
    const data = resp.data;
    const pageData = data.page || data.data || data.result || data;
    const list = pageData.content || pageData.list || pageData.products || pageData.records || [];
    const total = pageData.total || pageData.totalCount || pageData.totalElements || list.length;
    const totalPages = pageData.totalPages || pageData.totalPage || Math.ceil(total / pageSize) || 1;
    if (!list || list.length === 0) return { success: false, error: 'zkh360 API returned empty list' };
    const products = list.map(item => normalizeAPIProduct(item));
    return { success: true, source: 'zkh360-api', data: { keyword, page: Number(page), page_size: Number(pageSize), total, total_pages: totalPages, products } };
  } catch (e) { return { success: false, error: 'zkh360-api: ' + (e.code || e.message) }; }
}

function normalizeAPIProduct(item) {
  const strip = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
  const sku = item.proSkuNo || item.skuNo || item.productNo || item.spuNo || item.id || '';
  return {
    sku_no: String(sku),
    title: strip(item.proSkuProductName || item.productName || item.title || item.name || ''),
    sub_title: strip(item.proSkuSubTitle || item.subTitle || ''),
    brand: strip(item.proBrandName || item.brandName || item.brand || ''),
    model: strip(item.proMaterialNo || item.modelNo || item.model || item.materialNo || ''),
    price: parsePrice(item.price ?? item.salePrice ?? item.displayPrice ?? item.proPrice),
    price_unit: strip(item.unitOfMeasureCode || item.unit || item.proUnit || ''),
    image: fixUrl(item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || item.proMainPic || ''),
    images: (item.pics || item.images || item.imageList || item.proPics || []).map(fixUrl).filter(Boolean),
    category: strip(item.catalogName || item.categoryName || item.category || ''),
    min_order: item.minOrderQty || item.minOrder || item.proMinOrder || 1,
    stock: item.stock ?? item.stockQty ?? item.proStock ?? null,
    lead_time: strip(item.proSkuLeadTime || item.leadTime || item.deliveryTime || ''),
    specs: extractSpecs(item.specificationList || item.specs || item.params || []),
    url: sku ? `${ZKH_BASE}/item/${sku}.html` : '',
  };
}

function extractSpecs(specList) {
  const specs = {};
  if (!Array.isArray(specList)) return specs;
  specList.forEach(s => { const k = s.name || s.label || s.key || s.propertyName; const v = s.value || s.val || s.propertyValue; if (k && v != null) specs[k] = typeof v === 'string' ? v : JSON.stringify(v); });
  return specs;
}

async function searchProducts(keyword, page = 1, pageSize = 40) {
  const apiResult = await searchViaZKH360API(keyword, page, pageSize);
  if (apiResult.success) { console.log(`[Search] zkh360 API 成功: keyword=${keyword}, count=${apiResult.data.products.length}`); return formatSearchResult(apiResult, keyword, page, pageSize); }
  console.log(`[Search] zkh360 API 失败: ${apiResult.error}，尝试HTML解析...`);
  const searchPath = '/search.html';
  const search = `?keywords=${encodeURIComponent(keyword)}&hasLinkWord=&page=${page}`;
  const result = await fetchZKHPage(searchPath, search, ZKH_BASE + '/');
  if (!result.success) return formatSearchResult(result, keyword, page, pageSize);
  const parsed = parseSearchFromHtml(result.data, keyword, page, pageSize);
  return formatSearchResult({ ...parsed, source: result.source }, keyword, page, pageSize);
}

function parseSearchFromHtml(html, keyword, page, pageSize) {
  try {
    if (isWafPage(html)) return { success: false, error: 'WAF blocked' };
    const $ = cheerio.load(html || '');
    const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
    const products = []; const seen = new Set();
    const add = (p) => { if (!p.sku_no || seen.has(String(p.sku_no))) return; seen.add(String(p.sku_no)); products.push(p); };
    const nextScript = $('#__NEXT_DATA__').html();
    if (nextScript) { try { const nd = JSON.parse(nextScript); const list = findProductArray(nd.props?.pageProps || nd); if (list && list.length) { list.forEach(item => { const sku = item.skuNo || item.productNo || item.spuNo || item.id; if (!sku) return; add({ sku_no: String(sku), title: stripHtml(item.productName || item.title || item.name || ''), brand: stripHtml(item.brand || item.brandName || ''), model: stripHtml(item.model || item.modelNo || ''), price: parsePrice(item.price ?? item.salePrice ?? item.displayPrice), image: fixUrl(item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || ''), url: `${ZKH_BASE}/item/${sku}.html` }); }); } } catch {} }
    if (products.length === 0) { $('a[href*="/item/"]').each((_, a) => { const href = $(a).attr('href') || ''; const mm = href.match(/\/item\/([A-Za-z0-9]+)\.html/); if (!mm) return; const sku = mm[1]; if (seen.has(sku)) return; const $card = $(a).closest('li, div[class*="product"], div[class*="card"], div[class*="item"]'); const title = ($(a).attr('title') || $(a).text() || '').trim(); const priceText = $card.find('[class*="price"], [class*="Price"]').first().text() || ''; const pm = priceText.match(/[\d,]+\.?\d*/); add({ sku_no: sku, title: stripHtml(title).substring(0, 200), price: pm ? parseFloat(pm[0].replace(/,/g, '')) : null, url: href.startsWith('http') ? href : ZKH_BASE + href }); }); }
    if (products.length === 0) { const matches = [...html.matchAll(/\/item\/([A-Z]{1,5}\d{3,})\.html/g)]; matches.forEach(m => add({ sku_no: m[1], title: '', price: null, url: `${ZKH_BASE}/item/${m[1]}.html` })); }
    if (products.length === 0) return { success: false, error: 'html parse empty' };
    const start = (Number(page) - 1) * Number(pageSize);
    return { success: true, data: { keyword, page: Number(page), page_size: Number(pageSize), total: products.length, total_pages: Math.ceil(products.length / Number(pageSize)) || 1, products: products.slice(start, start + Number(pageSize)) } };
  } catch (e) { return { success: false, error: 'parse error: ' + e.message }; }
}

function findProductArray(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].skuNo || obj[0].productNo || obj[0].productName || obj[0].spuNo)) return obj;
  for (const k of Object.keys(obj)) { if (Array.isArray(obj[k]) && obj[k].length > 0 && obj[k][0] && (obj[k][0].skuNo || obj[k][0].productNo || obj[k][0].productName || obj[k][0].spuNo)) return obj[k]; if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) { const found = findProductArray(obj[k], depth + 1); if (found) return found; } }
  return null;
}

function parsePrice(v) { if (v == null) return null; if (typeof v === 'number') return v; const m = String(v).match(/[\d,]+\.?\d*/); if (!m) return null; const n = parseFloat(m[0].replace(/,/g, '')); return (!isNaN(n) && n > 0 && n < 9999999) ? n : null; }
function fixUrl(u) { if (!u || typeof u !== 'string') return ''; if (u.startsWith('http')) return u; if (u.startsWith('//')) return 'https:' + u; if (u.startsWith('/')) return ZKH_BASE + u; return u; }
function formatSearchResult(result, keyword, page, pageSize) { if (!result || !result.success) return { success: false, error: (result && result.error) || '搜索失败', keyword, page: Number(page), page_size: Number(pageSize), products: [] }; return { success: true, source: result.source, ...result.data }; }

async function getProductDetail(skuNo) {
  const apiResult = await searchViaZKH360API(skuNo, 1, 10);
  if (apiResult.success && apiResult.data && apiResult.data.products) {
    const match = apiResult.data.products.find(p => p.sku_no && p.sku_no.toUpperCase() === skuNo.toUpperCase());
    if (match) { console.log(`[Detail] zkh360 API 成功: sku=${skuNo}`); return { success: true, source: 'zkh360-api', sku_no: match.sku_no, title: match.title, description: match.sub_title || '', brand: match.brand, model: match.model, order_code: match.sku_no, min_order: match.min_order, unit: match.price_unit, price: match.price, price_unit: match.price_unit, currency: 'CNY', main_image: match.image, images: match.images && match.images.length ? match.images : (match.image ? [match.image] : []), specs: match.specs, stock: match.stock, lead_time: match.lead_time || '', category: match.category, url: match.url }; }
  }
  console.log(`[Detail] zkh360 API 未找到SKU=${skuNo}，尝试HTML详情页...`);
  const result = await fetchZKHPage(`/item/${skuNo}.html`, '', ZKH_BASE + '/');
  if (!result.success) return { success: false, error: result.error || '详情获取失败', sku_no: skuNo };
  const parsed = parseDetailFromHtml(result.data, skuNo);
  if (!parsed) return { success: false, error: '详情页解析失败', sku_no: skuNo };
  return { success: true, source: result.source, ...parsed };
}

function parseDetailFromHtml(html, skuNo) {
  try {
    if (isWafPage(html)) return null;
    const $ = cheerio.load(html || '');
    const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
    const text = $('body').text();
    let detail = null;
    const nextScript = $('#__NEXT_DATA__').html();
    if (nextScript) { try { const nd = JSON.parse(nextScript); detail = findDetailObject(nd.props?.pageProps || nd, skuNo); } catch {} }
    let title = detail?.productName || detail?.skuName || '';
    if (!title) title = $('title').text().split('【')[0].split(/[|_-]/)[0].trim();
    const images = [];
    if (detail?.pics?.length) detail.pics.forEach(p => { const u = fixUrl(typeof p === 'string' ? p : p.url); if (u) images.push(u); });
    if (images.length === 0) $('img[src*="private.zkh.com/PRODUCT"]').each((_, img) => { const src = fixUrl($(img).attr('src') || ''); if (src && !images.includes(src)) images.push(src); });
    let price = parsePrice(detail?.price ?? detail?.salePrice);
    if (!price) { const m = text.match(/官网价[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/); if (m) price = parsePrice(m[1]); }
    const specs = {};
    if (detail?.params?.length) detail.params.forEach(p => { const k = p.name || p.label; const v = p.value || p.val; if (k && v != null) specs[k] = String(v); });
    if (!title && images.length === 0 && Object.keys(specs).length === 0) return null;
    return { sku_no: skuNo, title: stripHtml(title).substring(0, 200), brand: detail?.brand || '', model: detail?.model || '', price, main_image: images[0] || '', images, specs, url: `${ZKH_BASE}/item/${skuNo}.html` };
  } catch { return null; }
}

function findDetailObject(obj, skuNo, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (obj.skuNo === skuNo || obj.productNo === skuNo) { if (obj.productName || obj.price != null || obj.pics) return obj; }
  for (const k of Object.keys(obj)) { if (typeof obj[k] === 'object' && obj[k] !== null) { const found = findDetailObject(obj[k], skuNo, depth + 1); if (found) return found; } }
  return null;
}

function getCookieStatus() {
  return { cookie_required: false, primary_source: 'web.zkh360.com POST API (无WAF)', fallback_sources: ['分类列表页', 'CF Worker', '代理池', '直连'], cf_worker_configured: !!CF_WORKER_URL, proxy_enabled: USE_PROXY && proxyManager.isEnabled() };
}
function resetSession() { return { ok: true, message: 'no cookie session to reset (zkh360-api mode)' }; }

module.exports = { searchProducts, getProductDetail, getCookieStatus, resetSession };
