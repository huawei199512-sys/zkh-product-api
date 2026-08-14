// 震坤行(zkh.com)爬虫服务 - web.zkh360.com POST API + 强制代理IP竞态
// 架构（参考1688 API项目）：
//   1. web.zkh360.com POST API（无WAF）通过代理竞态请求
//   2. 代理失败回退直连（保证可用性）
//   3. HTML解析兜底
// 强制代理：代理池永远开启，不可关闭
// 完全不依赖 Cookie、不需要过滑块、不需要 Chromium
const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('./proxyManager');

const ZKH_BASE = 'https://www.zkh.com';
const ZKH360_API = 'https://web.zkh360.com';
const ZKH360_SEARCH_API = ZKH360_API + '/api/search/listProductInfo';

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

const SINGLE_TIMEOUT = 12000;
const TOTAL_TIMEOUT = 60000;
const CONCURRENT = 3;
const MAX_ROUNDS = 8;

function randomUA() { return DESKTOP_UAS[Math.floor(Math.random() * DESKTOP_UAS.length)]; }

async function requestWithProxyRace(requestFn, options = {}) {
  const { concurrent = CONCURRENT, maxRounds = MAX_ROUNDS, totalTimeout = TOTAL_TIMEOUT } = options;
  if (!proxyManager.isEnabled() || proxyManager.getNextProxy() === null) {
    console.log('[ZKH] 直连模式（代理池为空，回退直连）');
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), totalTimeout);
    try { const result = await requestFn(null, controller.signal); clearTimeout(abortTimer); return { ...result, proxy_used: 'direct' }; }
    catch (error) { clearTimeout(abortTimer); return { success: false, error: error.message, proxy_used: 'direct' }; }
  }
  const startTime = Date.now();
  const seenProxies = new Set();
  const attemptedProxies = [];
  function getProxyBatch(count) {
    const batch = [];
    for (let i = 0; i < count; i++) { const p = proxyManager.getNextProxy(); if (p && !seenProxies.has(p)) { batch.push(p); seenProxies.add(p); } }
    return batch;
  }
  for (let round = 0; round < maxRounds; round++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeout) { console.warn(`[ZKH] 总超时 (${(elapsed / 1000).toFixed(1)}s)`); break; }
    let batch = getProxyBatch(concurrent);
    if (batch.length === 0) { seenProxies.clear(); batch = getProxyBatch(concurrent); if (batch.length === 0) break; }
    console.log(`[ZKH] 第${round + 1}轮: 并发${batch.length}代理竞态...`);
    const roundStart = Date.now();
    const tasks = batch.map((proxy) => {
      const controller = new AbortController();
      const promise = requestFn(proxy, controller.signal).then((result) => ({ proxy, result, controller })).catch((error) => ({ proxy, result: { success: false, error: error.message }, controller }));
      return { proxy, promise, controller };
    });
    let successResult = null;
    await new Promise((resolve) => {
      let resolved = false; let failCount = 0;
      tasks.forEach(({ proxy, promise }) => {
        promise.then(({ result, controller }) => {
          if (resolved) return;
          const time = ((Date.now() - roundStart) / 1000).toFixed(2);
          if (result.success) {
            resolved = true; successResult = { proxy, result, time };
            proxyManager.markGood(proxy); attemptedProxies.push({ proxy, status: 'success', time });
            tasks.forEach((t) => { if (t.proxy !== proxy) { try { t.controller.abort(); } catch {} } });
            resolve();
          } else {
            proxyManager.markBad(proxy, isSevereError(result.error));
            attemptedProxies.push({ proxy, status: 'failed', time, error: result.error });
            failCount++; if (failCount >= batch.length) resolve();
          }
        });
      });
    });
    if (successResult) {
      console.log(`[ZKH] ✅ 代理成功: ${successResult.proxy} (${successResult.time}s)`);
      return { ...successResult.result, proxy_used: successResult.proxy, elapsed: ((Date.now() - startTime) / 1000).toFixed(2), attempted_proxies: attemptedProxies };
    }
    if (round % 2 === 1) { try { await proxyManager.refreshProxies(false); } catch {} }
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }
  console.log('[ZKH] 所有代理失败，回退直连...');
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), SINGLE_TIMEOUT);
  try { const result = await requestFn(null, controller.signal); clearTimeout(abortTimer); return { ...result, proxy_used: 'direct-fallback', elapsed: ((Date.now() - startTime) / 1000).toFixed(2), attempted_proxies: attemptedProxies }; }
  catch (error) { clearTimeout(abortTimer); return { success: false, error: `所有代理失败 + 直连失败: ${error.message}`, proxy_used: null, elapsed: ((Date.now() - startTime) / 1000).toFixed(2), attempted_proxies: attemptedProxies }; }
}

function isWafPage(html) { if (!html || typeof html !== 'string') return false; return html.includes('请按住滑块') || html.includes('访问验证') || html.includes('滑动验证') || (html.includes('slider') && html.includes('verify')); }
function isSevereError(msg) { const s = String(msg || '').toUpperCase(); return /CERT|TLS|SSL|403|407|ECONNREFUSED|HANDSHAKE/.test(s); }

async function searchViaZKH360API(keyword, page = 1, pageSize = 40) {
  const from = (Number(page) - 1) * Number(pageSize);
  const body = { from, size: Number(pageSize), keyword: keyword || null, fz: false, catalogueId: null, productFilter: { brandIds: [], properties: {} }, cityCode: 310100, extraFilter: { showIndustryFeatured: false, inStock: false }, searchType: { notNeedCorrect: false }, clp: true };
  const result = await requestWithProxyRace(async (proxy, abortSignal) => {
    const axiosConfig = { method: 'POST', url: ZKH360_SEARCH_API, data: body, headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA(), 'Accept': 'application/json', 'Origin': ZKH360_API, 'Referer': ZKH360_API + '/' }, timeout: SINGLE_TIMEOUT, signal: abortSignal, maxRedirects: 3, validateStatus: () => true };
    if (proxy) { const proxyCfg = proxyManager.createAxiosProxyConfig(proxy); Object.assign(axiosConfig, proxyCfg); }
    const resp = await axios(axiosConfig);
    if (resp.status !== 200) return { success: false, error: `zkh360 API status=${resp.status}` };
    const data = resp.data;
    const pageData = data.page || data.data || data.result || data;
    const list = pageData.content || pageData.list || pageData.products || pageData.records || [];
    const total = pageData.total || pageData.totalCount || pageData.totalElements || pageData.skuTotalHits || list.length;
    const totalPages = pageData.totalPages || pageData.totalPage || Math.ceil(total / pageSize) || 1;
    if (!list || list.length === 0) return { success: false, error: 'zkh360 API returned empty list' };
    const products = list.map(item => normalizeAPIProduct(item));
    return { success: true, source: 'zkh360-api', data: { keyword, page: Number(page), page_size: Number(pageSize), total, total_pages: totalPages, products } };
  });
  return result;
}

function normalizeAPIProduct(item) {
  const strip = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
  const sku = item.proSkuNo || item.skuNo || item.productNo || item.spuNo || item.id || '';
  const rawImages = item.proImgPath_Z1 || item.proImgPath || item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || item.proMainPic || [];
  const images = (Array.isArray(rawImages) ? rawImages : [rawImages]).map(u => fixUrl(typeof u === 'string' ? u : (u?.url || u?.src || ''))).filter(Boolean);
  const specs = {};
  if (item.proMaterialNo) specs['商品型号'] = String(item.proMaterialNo);
  if (item.proBrandName) specs['品牌名称'] = String(item.proBrandName);
  if (item.unitOfMeasureCode) specs['销售单位'] = String(item.unitOfMeasureCode);
  if (item.proSkuMinOrderNum) specs['起订量'] = String(item.proSkuMinOrderNum);
  if (item.mpq) specs['最小包装量'] = String(item.mpq);
  if (item.proSkuLeadTime != null) specs['发货日'] = String(item.proSkuLeadTime);
  if (item.taxRate != null) specs['税率'] = String(item.taxRate);
  if (item.level4CatalogueName) specs['分类'] = String(item.level4CatalogueName);
  if (item.proSkuFeature) specs['商品特性'] = strip(String(item.proSkuFeature));
  if (item.webInfoComment) specs['备注'] = strip(String(item.webInfoComment));
  return {
    sku_no: String(sku),
    title: strip(item.proSkuProductName || item.productName || item.title || item.name || ''),
    sub_title: strip(item.proSkuFeature || item.proSkuSubTitle || item.subTitle || ''),
    description: strip(item.proSkuFeature || item.proSkuSubTitle || ''),
    brand: strip(item.proBrandName || item.brandName || item.brand || ''),
    brand_id: item.proBrandId || item.brandId || null,
    model: strip(item.proMaterialNo || item.modelNo || item.model || item.materialNo || ''),
    price: parsePrice(item.sellingPrice ?? item.price ?? item.salePrice ?? item.displayPrice ?? item.proPrice),
    origin_price: parsePrice(item.originPrice > 0 ? item.originPrice : null),
    untaxed_price: parsePrice(item.untaxedSellingPrice ?? item.untaxedPrice),
    tax_rate: item.taxRate ?? null,
    price_unit: strip(item.unitOfMeasureCode || item.unit || item.proUnit || ''),
    member_price: parsePrice(item.memberPrice),
    currency: 'CNY',
    image: images[0] || '',
    images: images,
    category: strip(item.level4CatalogueName || item.catalogName || item.categoryName || item.category || ''),
    category_id: item.level4CatalogueId || item.catalogId || null,
    category_level1_id: item.level1CatalogueId || null,
    min_order: item.proSkuMinOrderNum || item.minOrderQty || item.minOrder || item.proMinOrder || 1,
    min_package: item.mpq || 1,
    stock: item.inventory ?? item.stock ?? item.stockQty ?? item.proStock ?? null,
    lead_time: item.proSkuLeadTime ?? item.leadTime ?? item.deliveryTime ?? null,
    delivery_day: item.deliveryDay ?? null,
    is_collect: item.isCollect || '0',
    mpq: item.mpq || 1,
    price_config: item.priceConfig || null,
    web_info_comment: strip(item.webInfoComment || ''),
    product_positioning: item.productPositioning || null,
    commodity_source_type: item.commoditySourceType || null,
    url: sku ? `${ZKH_BASE}/item/${sku}.html` : '',
    specs: specs,
  };
}

async function searchProducts(keyword, page = 1, pageSize = 40) {
  console.log(`[Search] keyword=${keyword}, page=${page}, pageSize=${pageSize}`);
  const apiResult = await searchViaZKH360API(keyword, page, pageSize);
  if (apiResult.success) { console.log(`[Search] ✅ 成功: count=${apiResult.data.products.length}, proxy=${apiResult.proxy_used}`); return formatSearchResult(apiResult, keyword, page, pageSize); }
  console.log(`[Search] zkh360 API 失败: ${apiResult.error}，尝试HTML搜索页...`);
  const htmlResult = await fetchZKHPageViaProxy('/search.html', `?keywords=${encodeURIComponent(keyword)}&hasLinkWord=&page=${page}`, ZKH_BASE + '/');
  if (!htmlResult.success) return formatSearchResult(htmlResult, keyword, page, pageSize);
  const parsed = parseSearchFromHtml(htmlResult.data, keyword, page, pageSize);
  return formatSearchResult({ ...parsed, source: htmlResult.source }, keyword, page, pageSize);
}

async function fetchZKHPageViaProxy(targetPath, search, referer) {
  const targetUrl = ZKH_BASE + targetPath + (search || '');
  const headers = buildHeaders(referer);
  return await requestWithProxyRace(async (proxy, abortSignal) => {
    const axiosConfig = { method: 'GET', url: targetUrl, headers, timeout: SINGLE_TIMEOUT, responseType: 'text', maxRedirects: 3, signal: abortSignal, validateStatus: () => true };
    if (proxy) { const proxyCfg = proxyManager.createAxiosProxyConfig(proxy); Object.assign(axiosConfig, proxyCfg); }
    const resp = await axios(axiosConfig);
    if (resp.status === 200 && resp.data && !isWafPage(resp.data)) return { success: true, data: resp.data, source: proxy ? 'proxy' : 'direct' };
    return { success: false, error: `status=${resp.status} waf=${isWafPage(resp.data)}` };
  });
}

function buildHeaders(referer) {
  return { 'User-Agent': randomUA(), 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Sec-Ch-Ua': '"Chromium";v="127", "Not)A;Brand";v="99"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1', 'Referer': referer || (ZKH_BASE + '/') };
}

function parseSearchFromHtml(html, keyword, page, pageSize) {
  try {
    if (isWafPage(html)) return { success: false, error: 'WAF blocked' };
    const $ = cheerio.load(html || '');
    const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
    const products = []; const seen = new Set();
    const add = (p) => { if (!p.sku_no || seen.has(String(p.sku_no))) return; seen.add(String(p.sku_no)); products.push(p); };
    const nextScript = $('#__NEXT_DATA__').html();
    if (nextScript) { try { const nd = JSON.parse(nextScript); const list = findProductArray(nd.props?.pageProps || nd); if (list && list.length) list.forEach(item => { const sku = item.skuNo || item.productNo || item.spuNo || item.id; if (!sku) return; add(normalizeAPIProduct(item)); }); } catch {} }
    if (products.length === 0) {
      $('a[href*="/item/"]').each((_, a) => {
        const href = $(a).attr('href') || ''; const mm = href.match(/\/item\/([A-Za-z0-9]+)\.html/); if (!mm) return;
        const sku = mm[1]; if (seen.has(sku)) return;
        const $card = $(a).closest('li, div[class*="product"], div[class*="card"], div[class*="item"]');
        const title = ($(a).attr('title') || $(a).text() || '').trim();
        const priceText = $card.find('[class*="price"], [class*="Price"]').first().text() || '';
        const pm = priceText.match(/[\d,]+\.?\d*/);
        const img = $card.find('img').first();
        add({ sku_no: sku, title: stripHtml(title).substring(0, 200), price: pm ? parseFloat(pm[0].replace(/,/g, '')) : null, image: fixUrl(img.attr('src') || img.attr('data-src') || ''), images: [], url: href.startsWith('http') ? href : ZKH_BASE + href, specs: {} });
      });
    }
    if (products.length === 0) return { success: false, error: 'html parse empty' };
    const start = (Number(page) - 1) * Number(pageSize);
    const paged = products.slice(start, start + Number(pageSize));
    return { success: true, data: { keyword, page: Number(page), page_size: Number(pageSize), total: products.length, total_pages: Math.ceil(products.length / Number(pageSize)) || 1, products: paged } };
  } catch (e) { return { success: false, error: 'parse error: ' + e.message }; }
}

function findProductArray(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].proSkuNo || obj[0].skuNo || obj[0].productNo || obj[0].proSkuProductName || obj[0].productName)) return obj;
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) { if (obj[k][0] && (obj[k][0].proSkuNo || obj[k][0].skuNo || obj[k][0].productNo || obj[k][0].proSkuProductName || obj[k][0].productName)) return obj[k]; }
    if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) { const found = findProductArray(obj[k], depth + 1); if (found) return found; }
  }
  return null;
}

function parsePrice(v) { if (v == null) return null; if (typeof v === 'number') return v > 0 ? v : null; const m = String(v).match(/[\d,]+\.?\d*/); if (!m) return null; const n = parseFloat(m[0].replace(/,/g, '')); return (!isNaN(n) && n > 0 && n < 9999999) ? n : null; }
function fixUrl(u) { if (!u || typeof u !== 'string') return ''; u = u.trim(); if (!u) return ''; if (u.startsWith('http')) return u; if (u.startsWith('//')) return 'https:' + u; if (u.startsWith('/')) return ZKH_BASE + u; return u; }

function formatSearchResult(result, keyword, page, pageSize) {
  if (!result || !result.success) return { success: false, error: (result && result.error) || '搜索失败', keyword, page: Number(page), page_size: Number(pageSize), total: 0, total_pages: 0, products: [], proxy_used: result?.proxy_used || null };
  return { success: true, source: result.source, proxy_used: result.proxy_used || null, elapsed: result.elapsed || null, ...result.data };
}

async function getProductDetail(skuNo) {
  console.log(`[Detail] sku=${skuNo}`);
  const apiResult = await searchViaZKH360API(skuNo, 1, 10);
  if (apiResult.success && apiResult.data && apiResult.data.products) {
    const match = apiResult.data.products.find(p => p.sku_no && p.sku_no.toUpperCase() === String(skuNo).toUpperCase());
    if (match) { console.log(`[Detail] ✅ zkh360 API 成功: sku=${skuNo}, proxy=${apiResult.proxy_used}`); return buildDetailResult(match, apiResult.proxy_used); }
    if (apiResult.data.products.length > 0) { console.log(`[Detail] 未精确匹配SKU=${skuNo}，返回候选: ${apiResult.data.products[0].sku_no}`); return buildDetailResult(apiResult.data.products[0], apiResult.proxy_used); }
  }
  console.log(`[Detail] zkh360 API 未找到SKU=${skuNo}: ${apiResult.error}，尝试HTML详情页...`);
  const htmlResult = await fetchZKHPageViaProxy(`/item/${skuNo}.html`, '', ZKH_BASE + '/');
  if (!htmlResult.success) return { success: false, error: htmlResult.error || '详情获取失败', sku_no: skuNo };
  const parsed = parseDetailFromHtml(htmlResult.data, skuNo);
  if (!parsed) return { success: false, error: '详情页解析失败（可能WAF或页面结构变更）', sku_no: skuNo };
  return { success: true, source: htmlResult.source, proxy_used: htmlResult.proxy_used, ...parsed };
}

function buildDetailResult(match, proxyUsed) {
  const specs = match.specs || {};
  return {
    success: true, source: 'zkh360-api', proxy_used: proxyUsed || null,
    sku_no: match.sku_no, title: match.title,
    description: match.description || match.sub_title || '',
    sub_title: match.sub_title || '',
    keywords: [],
    brand: match.brand, brand_id: match.brand_id || null,
    model: match.model, order_code: match.sku_no,
    package_spec: specs['包装规格'] || specs['包装'] || '',
    min_order: match.min_order, min_package: match.min_package,
    unit: match.price_unit,
    price: match.price, origin_price: match.origin_price || null,
    untaxed_price: match.untaxed_price || null,
    tax_rate: match.tax_rate ?? null,
    member_price: match.member_price || null,
    currency: match.currency || 'CNY',
    main_image: match.image || (match.images && match.images[0]) || '',
    images: match.images && match.images.length ? match.images : (match.image ? [match.image] : []),
    specs: specs,
    stock: match.stock ?? null,
    lead_time: match.lead_time ?? null,
    delivery_day: match.delivery_day ?? null,
    category: match.category || '',
    category_id: match.category_id || null,
    mpq: match.mpq || 1,
    is_collect: match.is_collect || '0',
    price_config: match.price_config || null,
    web_info_comment: match.web_info_comment || '',
    url: match.url || (match.sku_no ? `${ZKH_BASE}/item/${match.sku_no}.html` : ''),
  };
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
    let title = detail?.proSkuProductName || detail?.productName || detail?.skuName || '';
    if (!title) { const pageTitle = $('title').text().split('【')[0].split(/[|_-]/)[0].trim(); title = pageTitle; }
    if (!title) { $('h1, [class*="ProductTitle"], [class*="title"]').each((_, el) => { const t = $(el).text().trim(); if (t.length > 5 && t.length < 200 && !title) title = t; }); }
    const images = [];
    if (detail?.proImgPath_Z1?.length) detail.proImgPath_Z1.forEach(p => { const u = fixUrl(typeof p === 'string' ? p : p?.url); if (u) images.push(u); });
    else if (detail?.pics?.length) detail.pics.forEach(p => { const u = fixUrl(typeof p === 'string' ? p : p?.url); if (u) images.push(u); });
    if (images.length === 0) { $('img[src*="private.zkh.com/PRODUCT"], img[src*="PRODUCT/BIG"], img[src*="PRODUCT/MKT"]').each((_, img) => { const src = fixUrl($(img).attr('src') || $(img).attr('data-src') || ''); if (src && !images.includes(src)) images.push(src); }); }
    let price = parsePrice(detail?.sellingPrice ?? detail?.price ?? detail?.salePrice ?? detail?.displayPrice);
    if (!price) { const m = text.match(/官网价[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/); if (m) price = parsePrice(m[1]); }
    const untaxed = parsePrice(detail?.untaxedSellingPrice) || (() => { const m = text.match(/未税价格[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/); return m ? parsePrice(m[1]) : null; })();
    const member = (() => { const m = text.match(/会员价[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/); return m ? parsePrice(m[1]) : null; })();
    const specs = {};
    if (detail?.proMaterialNo) specs['商品型号'] = String(detail.proMaterialNo);
    if (detail?.proBrandName) specs['品牌名称'] = String(detail.proBrandName);
    if (detail?.unitOfMeasureCode) specs['销售单位'] = String(detail.unitOfMeasureCode);
    if (detail?.proSkuMinOrderNum) specs['起订量'] = String(detail.proSkuMinOrderNum);
    if (detail?.mpq) specs['最小包装量'] = String(detail.mpq);
    if (detail?.proSkuLeadTime != null) specs['发货日'] = String(detail.proSkuLeadTime);
    if (detail?.level4CatalogueName) specs['分类'] = String(detail.level4CatalogueName);
    if (detail?.proSkuFeature) specs['商品特性'] = stripHtml(String(detail.proSkuFeature));
    const fieldLabels = ['商品型号', '包装规格', '订货编码', '起订量', '最小包装量', '品牌名称', '发货日', '销售单位', '电压等级', '导体材质', '系列'];
    fieldLabels.forEach(f => { if (specs[f]) return; const rx = new RegExp(`${f}[\\s:：]*([^\\n\\r]{1,80}?)\\s*(?=(${fieldLabels.join('|')})|$)`, 'm'); const m = text.match(rx); if (m && m[1]) specs[f] = m[1].trim().replace(/\s+/g, ' ').slice(0, 80); });
    let unit = detail?.unitOfMeasureCode || detail?.unit || specs['销售单位'] || '';
    let category = detail?.level4CatalogueName || detail?.catalogName || specs['分类'] || '';
    if (!title && images.length === 0 && Object.keys(specs).length === 0) return null;
    return {
      sku_no: skuNo, title: stripHtml(title).substring(0, 200),
      description: stripHtml(detail?.proSkuFeature || detail?.description || detail?.introduction || $('meta[name="description"]').attr('content') || ''),
      sub_title: '',
      keywords: ($('meta[name="keywords"]').attr('content') || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      brand: detail?.proBrandName || detail?.brand || detail?.brandName || specs['品牌名称'] || '',
      brand_id: detail?.proBrandId || null,
      model: detail?.proMaterialNo || detail?.model || detail?.modelNo || specs['商品型号'] || '',
      order_code: skuNo,
      package_spec: detail?.packageSpec || detail?.packSpec || specs['包装规格'] || '',
      min_order: parseQty(detail?.proSkuMinOrderNum || detail?.minOrderQty || detail?.minOrder || specs['起订量'] || 1),
      min_package: parseQty(detail?.mpq || detail?.minPackageQty || detail?.minPackage || specs['最小包装量'] || 1),
      unit, price, origin_price: parsePrice(detail?.originPrice > 0 ? detail.originPrice : null),
      untaxed_price: untaxed, tax_rate: detail?.taxRate ?? null, member_price: member,
      currency: 'CNY', main_image: images[0] || '', images, specs,
      stock: detail?.inventory ?? detail?.stock ?? detail?.stockQty ?? null,
      lead_time: detail?.proSkuLeadTime ?? detail?.leadTime ?? null,
      category, category_id: detail?.level4CatalogueId || null,
      mpq: detail?.mpq || 1,
      url: `${ZKH_BASE}/item/${skuNo}.html`,
    };
  } catch (e) { return null; }
}

function findDetailObject(obj, skuNo, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (obj.proSkuNo === skuNo || obj.skuNo === skuNo || obj.productNo === skuNo) { if (obj.proSkuProductName || obj.productName || obj.skuName || obj.price != null || obj.proImgPath_Z1) return obj; }
  for (const k of Object.keys(obj)) { if (typeof obj[k] === 'object' && obj[k] !== null) { const found = findDetailObject(obj[k], skuNo, depth + 1); if (found) return found; } }
  return null;
}

function parseQty(v) { if (typeof v === 'number') return v; if (!v) return 1; const m = String(v).match(/([\d.]+)/); const n = m ? parseFloat(m[1]) : NaN; return (!isNaN(n) && n > 0) ? n : 1; }

function getCookieStatus() { return { cookie_required: false, slider_required: false, chromium_required: false, primary_source: 'web.zkh360.com POST API (无WAF) + 强制代理竞态', proxy_enabled: proxyManager.isEnabled(), proxy_force: true }; }
function resetSession() { return { ok: true, message: 'no cookie session (proxy + zkh360-api mode)' }; }

module.exports = { searchProducts, getProductDetail, getCookieStatus, resetSession };
