// 震坤行(zkh.com)爬虫服务 - 无登录 + 代理IP + 竞态多轮重试
// 分析自浏览器捕获的真实API：
//   搜索:  POST /servezkhApi/search/product/pc
//   详情:  GET  /servezkhApi/goods/1/coupons/{SKU}
//          POST /servezkhApi/goods/1/selectSpec
//          POST /servezkhApi/preferential/display/enc/singlePrice
//          GET  /servezkhApi/goods/tags/{SKU}
//          GET  /servezkhApi/freight/product/{SKU}
//          GET  /servezkhApi/goods/v3/getRelatedProductList
//          GET  /servezkhApi/goods/replaceSkus/{SKU}
//          GET  /servezkhApi/goods/combination/{SKU}
//          POST /servezkhApi/search/1/spuItemThumbnailInfo
//   认证:  GET /zkhweb/zkhAuth/rsaKey, signToken, u_atoken/u_asig Cookie
// 策略：多代理并发竞态 -> 成功立即返回 -> 循环重试多轮
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const proxyManager = require('./proxyManager');

// ============ 配置 ============
const ZKH_BASE = 'https://www.zkh.com';
const ZKH_API_BASE = 'https://www.zkh.com/servezkhApi';
const ZKH_AUTH_BASE = 'https://www.zkh.com/zkhweb/zkhAuth';

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

// ============ 按经验 1387200：双层超时策略 ============
const SINGLE_PROXY_TIMEOUT = 10000;  // 单代理 10s 必须切换（连接+TLS）
const TOTAL_REQUEST_TIMEOUT = 60000; // 单次用户请求 60s 绝对截止（给更多轮次机会）
const CONCURRENT_PROXIES = 5;
const MAX_ROUNDS = 10;

function randomUA() { return DESKTOP_UAS[Math.floor(Math.random() * DESKTOP_UAS.length)]; }
function generateTraceId() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 1e12).toString().padStart(12, '0');
  return `${now}${rand}${Math.floor(Math.random() * 10)}`;
}

// ============ 单次带代理的请求（按经验1387200：错误分级标记）============
function isSevereProxyError(msgOrCode) {
  if (!msgOrCode) return false;
  const s = String(msgOrCode).toUpperCase();
  // 证书类 / 鉴权类 / 协议不兼容 → 严重坏代理（5分钟不碰）
  return /CERT|TLS|SSL|403|407|405|PROXY_AUTH|ECONNREFUSED|HANDSHAKE|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED/.test(s);
}
async function requestWithProxy({ method = 'GET', url, headers = {}, params = {}, data = null, proxy = null }) {
  const traceId = generateTraceId();
  const allParams = { ...params, traceId: (params || {}).traceId || traceId };
  const allHeaders = {
    'User-Agent': randomUA(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Ch-Ua': '"Chromium";v="127", "Not)A;Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    'Referer': ZKH_BASE + '/',
    'Origin': ZKH_BASE,
    ...headers,
  };
  const proxyCfg = proxyManager.createAxiosProxyConfig(proxy);
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), SINGLE_PROXY_TIMEOUT);
  try {
    const axiosArgs = {
      method, url, params: allParams,
      headers: allHeaders,
      signal: controller.signal,
      timeout: SINGLE_PROXY_TIMEOUT,
      responseType: 'text',
      ...proxyCfg,
    };
    // 按经验1387200：GET传 (url, config) / POST传 (url, data, config) 参数分离
    let resp;
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE' || method.toUpperCase() === 'HEAD') {
      resp = await axios(axiosArgs);
    } else {
      resp = await axios({ ...axiosArgs, data });
    }
    clearTimeout(timeoutTimer);
    return { success: true, data: resp.data, status: resp.status, proxy };
  } catch (err) {
    clearTimeout(timeoutTimer);
    const msg = err.code || err.message || 'unknown';
    // 错误分级：严重错误 → 5分钟TTL，普通超时 → 1分钟TTL
    proxyManager.markBad(proxy, isSevereProxyError(msg));
    return { success: false, error: msg, code: err.code || null, status: err.response?.status || null, proxy };
  }
}

// ============ 竞态并发执行（与1688一致）============
async function raceConcurrent(taskFn, count = CONCURRENT_PROXIES) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const proxy = proxyManager.getNextProxy();
    promises.push((async () => { try { return await taskFn(proxy); } catch (e) { return { success: false, error: e.message, proxy }; } })());
  }
  const results = await Promise.allSettled(promises);
  const succ = results.find(r => r.status === 'fulfilled' && r.value && r.value.success);
  if (succ) {
    proxyManager.markGood(succ.value.proxy);
    return succ.value;
  }
  const fail = results.find(r => r.status === 'fulfilled');
  return fail ? fail.value : { success: false, error: 'all concurrent failed' };
}

// ============ 多轮重试（按经验1387200：绝对截止时间）============
async function multiRoundRun(taskFn, roundCount = MAX_ROUNDS, concurrent = CONCURRENT_PROXIES) {
  const deadline = Date.now() + TOTAL_REQUEST_TIMEOUT;
  const errors = [];
  for (let round = 0; round < roundCount; round++) {
    if (Date.now() >= deadline) {
      errors.push(`TOTAL_TIMEOUT_${TOTAL_REQUEST_TIMEOUT}ms`);
      break;
    }
    const res = await raceConcurrent(taskFn, concurrent);
    if (res && res.success) return { ...res, rounds: round + 1, errors };
    errors.push(`R${round}:${res?.error || 'na'}`);
    // 每两轮后刷新一次代理
    if (round % 2 === 1) { try { await proxyManager.refreshProxies(false); } catch {} }
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
  }
  return { success: false, error: `多轮重试失败（共${roundCount}轮）`, rounds: roundCount, errors };
}

// ============ 关键字搜索 ============
// 搜索API需要签名认证（返回code:5000"非法请求"），改为直接解析搜索页HTML
async function searchProducts(keyword, page = 1, pageSize = 40) {
  const result = await multiRoundRun(async (proxy) => {
    // Step 1: 先 GET 首页获取cookie/环境（通过代理）
    const homeHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    };
    await requestWithProxy({ url: ZKH_BASE + '/', headers: homeHeaders, proxy });

    // Step 2: 直接请求搜索页HTML（搜索API需签名认证，改用HTML解析）
    const searchPageUrl = `${ZKH_BASE}/search.html?keywords=${encodeURIComponent(keyword)}&hasLinkWord=`;
    const searchHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Referer': ZKH_BASE + '/',
    };
    const resp = await requestWithProxy({ url: searchPageUrl, headers: searchHeaders, proxy });
    if (!resp.success) return resp;

    // Step 3: 从HTML中解析商品列表（优先方案）
    const parsed = tryParseSearchFromHtml(resp.data, keyword, page, pageSize, proxy);
    if (parsed && parsed.success && parsed.data?.products?.length > 0) return parsed;

    // Step 4: HTML解析失败，尝试搜索API（带Cookie后可能能工作）
    const searchApiUrl = `${ZKH_API_BASE}/search/product/pc`;
    const postData = {
      keyword, page: Number(page), pageSize: Number(pageSize),
      sort: '', order: '', filter: {}, areaCode: '',
    };
    const apiHeaders = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Referer': searchPageUrl,
    };
    const apiResp = await requestWithProxy({
      method: 'POST', url: searchApiUrl, data: postData, headers: apiHeaders, proxy
    });
    if (!apiResp.success) return apiResp;
    try {
      const parsedApi = typeof apiResp.data === 'string' ? JSON.parse(apiResp.data) : apiResp.data;
      const code = parsedApi.code || parsedApi.resultCode || parsedApi.status;
      const ok = parsedApi.success === true || code === '0000' || code === 200 || code === '0' || code === 0;
      if (ok && (parsedApi.result || parsedApi.data)) {
        const raw = parsedApi.result || parsedApi.data;
        return { success: true, data: parseSearchResult(raw, keyword, page, pageSize), proxy };
      }
      return { success: false, error: (parsedApi.msg || parsedApi.message || ('code=' + code)), proxy };
    } catch (e) {
      return { success: false, error: 'api parse error: ' + e.message, proxy };
    }
  });
  return formatSearchResult(result, keyword, page, pageSize);
}

function extractSkusFromSearch(parsed) {
  try {
    const arr = parsed.result?.list || parsed.result?.data?.list || parsed.data?.list || [];
    return arr.map(i => i.skuNo || i.sku_no || i.productNo || i.SkuNo || i.id).filter(Boolean);
  } catch { return []; }
}

function parseSearchResult(raw, keyword, page, pageSize) {
  const list = raw.list || raw.data?.list || raw.items || [];
  const total = raw.total || raw.totalCount || raw.recordCount || list.length;
  const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
  const products = list.map(item => ({
    sku_no: item.skuNo || item.sku_no || item.productNo || item.product_no || item.id,
    title: stripHtml(item.productName || item.title || item.name || item.spuName || ''),
    sub_title: stripHtml(item.subTitle || item.subtitle || item.slogan || ''),
    brand: stripHtml(item.brand || item.brandName || ''),
    model: stripHtml(item.model || item.modelNo || item.productModel || ''),
    price: item.price || item.salePrice || item.displayPrice || item.marketPrice || null,
    price_unit: stripHtml(item.unit || item.priceUnit || ''),
    image: item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || item.thumbnail || '',
    images: item.pics || item.images || (item.mainPic ? [item.mainPic] : []),
    category: stripHtml(item.categoryName || item.category || item.catName || ''),
    min_order: item.minOrderQty || item.minOrder || item.moq || 1,
    stock: item.stock || item.stockQty || item.inventory || null,
    tag: item.tag || item.tags || null,
    promotions: item.promotions || item.promotionList || null,
    url: item.skuNo ? `${ZKH_BASE}/item/${item.skuNo}.html` : (item.url || item.productUrl || ''),
  }));
  return {
    keyword,
    page: Number(page),
    page_size: Number(pageSize),
    total: Number(total) || products.length,
    total_pages: Math.ceil((Number(total) || products.length) / Number(pageSize)),
    products,
  };
}

// WAF滑块验证页面检测
function isWafBlocked(html) {
  if (!html || typeof html !== 'string') return false;
  return html.includes('访问验证') || html.includes('滑动验证') || html.includes('请按住滑块') ||
    html.includes('请进行验证') || html.includes('slider') && html.includes('verify');
}
// 登录重定向检测
function isLoginRedirect(html) {
  if (!html || typeof html !== 'string') return false;
  return html.includes('passport.zkh.com') || html.includes('请先登录') || html.includes('登录后查看');
}

function tryParseSearchFromHtml(html, keyword, page, pageSize, proxy) {
  try {
    // WAF拦截检测
    if (isWafBlocked(html)) return { success: false, error: 'WAF blocked (slider)', proxy };
    // 登录重定向检测
    if (isLoginRedirect(html)) return { success: false, error: 'login redirect', proxy };

    const $ = cheerio.load(html || '');
    const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
    const products = [];
    const seenSkus = new Set();
    const addProduct = (p) => {
      if (!p.sku_no || seenSkus.has(String(p.sku_no))) return;
      seenSkus.add(String(p.sku_no));
      products.push(p);
    };

    // 方案1: 从 __NEXT_DATA__ JSON 中提取（Next.js Pages Router）
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        const pageProps = nextData.props?.pageProps || {};
        // 递归查找包含商品的数组
        const findProducts = (obj, depth = 0) => {
          if (depth > 6 || !obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].skuNo || obj[0].productNo || obj[0].productName || obj[0].spuNo)) {
            return obj;
          }
          for (const k of Object.keys(obj)) {
            if (Array.isArray(obj[k]) && obj[k].length > 0) {
              if (obj[k][0] && (obj[k][0].skuNo || obj[k][0].productNo || obj[k][0].productName || obj[k][0].spuNo)) {
                return obj[k];
              }
            }
            if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
              const found = findProducts(obj[k], depth + 1);
              if (found) return found;
            }
          }
          return null;
        };
        const productList = findProducts(pageProps);
        if (productList && productList.length) {
          productList.forEach(item => {
            const sku = item.skuNo || item.productNo || item.spuNo || item.id;
            if (!sku) return;
            addProduct({
              sku_no: String(sku),
              title: stripHtml(item.productName || item.title || item.name || ''),
              sub_title: stripHtml(item.subTitle || item.subtitle || ''),
              brand: stripHtml(item.brand || item.brandName || ''),
              model: stripHtml(item.model || item.modelNo || ''),
              price: item.price || item.salePrice || item.displayPrice || null,
              price_unit: stripHtml(item.unit || item.priceUnit || ''),
              image: item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || '',
              images: item.pics || item.images || (item.mainPic ? [item.mainPic] : []),
              category: stripHtml(item.categoryName || item.category || ''),
              min_order: item.minOrderQty || item.minOrder || 1,
              stock: item.stock || item.stockQty || null,
              url: `${ZKH_BASE}/item/${sku}.html`,
            });
          });
        }
      } catch {}
    }

    // 方案1.5: 从 window.__INITIAL_DATA__ 中提取（震坤行SSR初始数据）
    if (products.length === 0) {
      const initMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
      if (initMatch) {
        try {
          const initData = JSON.parse(initMatch[1]);
          const findProducts = (obj, depth = 0) => {
            if (depth > 6 || !obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].skuNo || obj[0].productNo || obj[0].productName || obj[0].spuNo)) {
              return obj;
            }
            for (const k of Object.keys(obj)) {
              if (Array.isArray(obj[k]) && obj[k].length > 0) {
                if (obj[k][0] && (obj[k][0].skuNo || obj[k][0].productNo || obj[k][0].productName || obj[k][0].spuNo)) {
                  return obj[k];
                }
              }
              if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
                const found = findProducts(obj[k], depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          const productList = findProducts(initData);
          if (productList && productList.length) {
            productList.forEach(item => {
              const sku = item.skuNo || item.productNo || item.spuNo || item.id;
              if (!sku) return;
              addProduct({
                sku_no: String(sku),
                title: stripHtml(item.productName || item.title || item.name || ''),
                sub_title: stripHtml(item.subTitle || item.subtitle || ''),
                brand: stripHtml(item.brand || item.brandName || ''),
                model: stripHtml(item.model || item.modelNo || ''),
                price: item.price || item.salePrice || item.displayPrice || null,
                price_unit: stripHtml(item.unit || item.priceUnit || ''),
                image: item.mainPic || item.imageUrl || item.imgUrl || item.picUrl || '',
                images: item.pics || item.images || (item.mainPic ? [item.mainPic] : []),
                category: stripHtml(item.categoryName || item.category || ''),
                min_order: item.minOrderQty || item.minOrder || 1,
                stock: item.stock || item.stockQty || null,
                url: `${ZKH_BASE}/item/${sku}.html`,
              });
            });
          }
        } catch {}
      }
    }

    // 方案2: 从 __next_f.push 数据中提取（Next.js App Router RSC格式）
    if (products.length === 0) {
      const allScriptText = $('script').map((_, s) => $(s).text() || '').get().join('\n');
      // 匹配包含 skuNo 的 JSON 片段
      const skuJsonPattern = /\{[^{}]*"skuNo"\s*:\s*"([^"]+)"[^{}]*\}/g;
      let match;
      while ((match = skuJsonPattern.exec(allScriptText)) !== null) {
        try {
          const obj = JSON.parse(match[0]);
          const sku = obj.skuNo || obj.productNo;
          if (sku) addProduct({
            sku_no: String(sku),
            title: stripHtml(obj.productName || obj.title || ''),
            brand: stripHtml(obj.brand || obj.brandName || ''),
            price: obj.price || obj.salePrice || null,
            image: obj.mainPic || obj.imageUrl || '',
            url: `${ZKH_BASE}/item/${sku}.html`,
          });
        } catch {}
      }
      // 也尝试匹配 productNo
      const pnoJsonPattern = /\{[^{}]*"productNo"\s*:\s*"([^"]+)"[^{}]*\}/g;
      while ((match = pnoJsonPattern.exec(allScriptText)) !== null) {
        try {
          const obj = JSON.parse(match[0]);
          const sku = obj.productNo || obj.skuNo;
          if (sku) addProduct({
            sku_no: String(sku),
            title: stripHtml(obj.productName || obj.title || ''),
            price: obj.price || obj.salePrice || null,
            url: `${ZKH_BASE}/item/${sku}.html`,
          });
        } catch {}
      }
    }

    // 方案3: 从 DOM 中解析商品卡片
    if (products.length === 0) {
      $('a[href*="/item/"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/\/item\/([A-Za-z0-9]+)\.html/);
        if (!m) return;
        const sku = m[1];
        if (seenSkus.has(sku)) return;
        // 从链接的祖先元素中提取信息
        const $card = $(a).closest('li, div[class*="product"], div[class*="card"], div[class*="item"], div[class*="sku"], article');
        const title = ($(a).attr('title') || $(a).text() || $card.find('[class*="title"], h3, h4, h5').first().text() || '').trim();
        const priceText = $card.find('[class*="price"], [class*="Price"]').first().text() || '';
        const priceMatch = priceText.match(/[\d,]+\.?\d*/);
        const img = $card.find('img').first();
        addProduct({
          sku_no: sku,
          title: stripHtml(title).substring(0, 200),
          price: priceMatch ? parseFloat(priceMatch[0].replace(/,/g, '')) : null,
          price_unit: '',
          image: img.attr('src') || img.attr('data-src') || '',
          images: [],
          url: href.startsWith('http') ? href : ZKH_BASE + href,
        });
      });
    }

    // 方案4: 从页面文本/HTML中正则提取所有SKU编号
    if (products.length === 0) {
      const skuMatches = [...html.matchAll(/\/item\/([A-Z]{1,5}\d{3,})\.html/g)];
      for (const m of skuMatches) {
        addProduct({
          sku_no: m[1],
          title: '',
          price: null,
          image: '',
          url: `${ZKH_BASE}/item/${m[1]}.html`,
        });
      }
    }

    if (products.length === 0) return { success: false, error: 'html parse empty', proxy };

    return {
      success: true,
      data: {
        keyword,
        page: Number(page),
        page_size: Number(pageSize),
        total: products.length,
        total_pages: Math.ceil(products.length / Number(pageSize)) || 1,
        products: products.slice(0, Number(pageSize)),
      },
      proxy,
    };
  } catch (e) {
    return { success: false, error: 'parse error: ' + e.message, proxy };
  }
}

function formatSearchResult(result, keyword, page, pageSize) {
  if (!result || !result.success) {
    return {
      success: false,
      error: (result && result.error) || '搜索失败',
      keyword, page: Number(page), page_size: Number(pageSize),
      products: [],
    };
  }
  return {
    success: true,
    ...result.data,
  };
}

// ============ 商品详情 ============
async function getProductDetail(skuNo) {
  const result = await multiRoundRun(async (proxy) => {
    // Step 1: 访问商品页，获取页面+Cookie
    const detailPageUrl = `${ZKH_BASE}/item/${skuNo}.html`;
    const pageHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    };
    await requestWithProxy({ url: detailPageUrl, headers: pageHeaders, proxy });

    // Step 2: 并行调用多个详情API
    const apiHeaders = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Referer': detailPageUrl,
    };
    const baseParams = {};
    const requests = [
      // 优惠券/价格信息
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/1/coupons/${skuNo}`, params: { detailType: 2, ...baseParams }, headers: apiHeaders, proxy }),
      // 标签
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/tags/${skuNo}`, params: baseParams, headers: apiHeaders, proxy }),
      // 运费
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/freight/product/${skuNo}`, params: baseParams, headers: apiHeaders, proxy }),
      // 推荐/关联
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/v3/getRelatedProductList`, params: { proSkuNo: skuNo, ...baseParams }, headers: apiHeaders, proxy }),
      // 替换商品
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/replaceSkus/${skuNo}`, params: baseParams, headers: apiHeaders, proxy }),
      // 组合商品
      requestWithProxy({ method: 'GET', url: `${ZKH_API_BASE}/goods/combination/${skuNo}`, params: baseParams, headers: apiHeaders, proxy }),
      // 规格选择
      requestWithProxy({ method: 'POST', url: `${ZKH_API_BASE}/goods/1/selectSpec`, data: { skuNo }, params: baseParams, headers: apiHeaders, proxy }),
      // 加密价格
      requestWithProxy({ method: 'POST', url: `${ZKH_API_BASE}/preferential/display/enc/singlePrice`, data: { scene: 1, skuNos: [skuNo] }, params: baseParams, headers: apiHeaders, proxy }),
    ];
    const settled = await Promise.allSettled(requests);
    const parseJson = (r) => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
    };
    const couponsRaw = settled[0].status === 'fulfilled' && settled[0].value.success ? parseJson(settled[0].value.data) : null;
    const tagsRaw = settled[1].status === 'fulfilled' && settled[1].value.success ? parseJson(settled[1].value.data) : null;
    const freightRaw = settled[2].status === 'fulfilled' && settled[2].value.success ? parseJson(settled[2].value.data) : null;
    const relatedRaw = settled[3].status === 'fulfilled' && settled[3].value.success ? parseJson(settled[3].value.data) : null;
    const replaceRaw = settled[4].status === 'fulfilled' && settled[4].value.success ? parseJson(settled[4].value.data) : null;
    const combineRaw = settled[5].status === 'fulfilled' && settled[5].value.success ? parseJson(settled[5].value.data) : null;
    const specRaw = settled[6].status === 'fulfilled' && settled[6].value.success ? parseJson(settled[6].value.data) : null;
    const priceRaw = settled[7].status === 'fulfilled' && settled[7].value.success ? parseJson(settled[7].value.data) : null;

    // Step 3: 再拿一次H5页面，解析页面中的标题/图片/参数（作为最终兜底的最可靠来源）
    const pageResp = await requestWithProxy({ url: detailPageUrl, headers: pageHeaders, proxy });
    const pageParse = pageResp.success ? parseDetailFromHtml(pageResp.data, skuNo) : null;

    // 如果任何一个API有有效数据，或页面解析成功 => 视为成功
    const anyOk = pageParse || couponsRaw || specRaw || priceRaw;
    if (!anyOk) return { success: false, error: 'all apis returned invalid data', proxy };

    const merged = mergeDetailData({ skuNo, pageParse, couponsRaw, tagsRaw, freightRaw, relatedRaw, replaceRaw, combineRaw, specRaw, priceRaw });
    return { success: true, data: merged, proxy };
  });

  if (!result || !result.success) {
    return { success: false, error: (result && result.error) || '商品详情获取失败', sku_no: skuNo };
  }
  return { success: true, ...result.data };
}

function parseDetailFromHtml(html, skuNo) {
  try {
    // WAF拦截检测
    if (isWafBlocked(html)) return null;
    // 登录重定向检测
    if (isLoginRedirect(html)) return null;
    const $ = cheerio.load(html || '');
    const title = $('title').text().split('【')[0].split(/[|_-]/)[0].trim();
    const desc = $('meta[name="description"]').attr('content') || '';
    const keywords = $('meta[name="keywords"]').attr('content') || '';

    // 图片（从元数据和DOM提取）
    const images = [];
    $('img[src*="private.zkh.com/PRODUCT/BIG"], img[src*="PRODUCT/BIG"]').each((_, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src');
      if (src) images.push(src);
    });
    $('img').each((_, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src');
      if (src && src.includes('PRODUCT') && !images.includes(src)) images.push(src);
    });

    // 标题、价格、参数行
    let mainTitle = '';
    $('h1, [class*="ProductTitle"], [class*="title"]').each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 5 && t.length < 200 && !mainTitle) mainTitle = t;
    });

    let price = null;
    let untaxed = null;
    let member = null;
    let priceUnit = '';
    $('[class*="Price"], [class*="price"]').each((_, el) => {
      const t = $(el).text().replace(/[^\d.]/g, '');
      if (t && price === null) {
        const n = parseFloat(t);
        if (!isNaN(n) && n > 0 && n < 999999) price = n;
      }
    });

    // 型号、品牌、包装规格、订货编码 等行（按震坤行详情页UA0279实测DOM标签：品牌名称/商品型号/订货编码/包装规格/起订量/最小包装量/发货日）
    const specs = {};
    $('[class*="spec"] li, [class*="parameter"] li, [class*="Spec"] div, dl dt').each((_, el) => {
      const label = $(el).text().trim().replace(/[:：]$/, '');
      const value = $(el).next('dd, div, span').text().trim();
      if (label && value && label.length < 30 && value.length < 200) specs[label] = value;
    });
    // 页面文字中直接抓特征行（含一行多字段情况：例如 "品牌名称 QIFAN/起帆 商品型号 RVV-300/500V-3×2.5"）
    const text = $('body').text();
    const fieldLabels = ['商品型号', '包装规格', '订货编码', '起订量', '最小包装量', '品牌名称', '发货日', '销售单位', '电压等级', '导体材质', '系列'];
    fieldLabels.forEach(f => {
      if (specs[f]) return;
      const rx = new RegExp(`${f}[\\s:：]*([^\\n\\r]{1,80}?)\\s*(?=(${fieldLabels.join('|')})|$)`, 'm');
      const m = text.match(rx);
      if (m && m[1]) specs[f] = m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
    });

    // 价格锚点提取（按UA0279实测："官网价 ￥ 1309.00 / 卷" / "未税价格 ￥ 1158.41 （税率： 13 %）" / "会员价"）
    const extractAnchoredPrice = (label) => {
      const rx = new RegExp(`${label}[^0-9￥¥]{0,40}[￥¥]?\\s*([\\d,]+\\.?\\d*)`, 'm');
      const m = text.match(rx);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/,/g, ''));
      return (!isNaN(n) && n > 0 && n < 999999) ? n : null;
    };
    const officialPrice = extractAnchoredPrice('官网价');
    if (!price && officialPrice) price = officialPrice;
    untaxed = extractAnchoredPrice('未税价格');
    member = extractAnchoredPrice('会员价');
    // 提取单位（"/ 卷" "/ 米" 之类）
    const unitMatch = text.match(/官网价[^\n\/]{0,60}\/\s*([\u4e00-\u9fa5A-Za-z]{1,8})/m);
    if (unitMatch) priceUnit = unitMatch[1].trim();

    const mainImage = images[0] || '';

    return {
      title: mainTitle || title,
      description: desc,
      keywords: keywords ? keywords.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [],
      images,
      main_image: mainImage,
      price,
      untaxed_price: untaxed,
      member_price: member,
      price_unit: priceUnit,
      specs,
    };
  } catch (e) {
    return null;
  }
}

function safeGet(obj, paths, def = null) {
  try {
    let cur = obj;
    for (const p of paths) {
      if (cur == null) return def;
      cur = (typeof p === 'function') ? p(cur) : cur[p];
    }
    return (cur == null || cur === '') ? def : cur;
  } catch { return def; }
}

function mergeDetailData({ skuNo, pageParse, couponsRaw, tagsRaw, freightRaw, relatedRaw, replaceRaw, combineRaw, specRaw, priceRaw }) {
  const result = safeGet(specRaw, ['result']) || safeGet(specRaw, ['data']) || {};
  const coupons = safeGet(couponsRaw, ['result']) || safeGet(couponsRaw, ['data']) || {};
  const tags = safeGet(tagsRaw, ['result']) || safeGet(tagsRaw, ['data']) || [];
  const freight = safeGet(freightRaw, ['result']) || safeGet(freightRaw, ['data']) || {};
  const priceInfo = safeGet(priceRaw, ['result']) || safeGet(priceRaw, ['data']) || {};
  const relatedList = safeGet(relatedRaw, ['result', 'list']) || safeGet(relatedRaw, ['data']) || [];
  const replaceList = safeGet(replaceRaw, ['result']) || safeGet(replaceRaw, ['data']) || [];
  const combineList = safeGet(combineRaw, ['result']) || safeGet(combineRaw, ['data']) || [];

  const pageTitle = pageParse?.title || '';
  const pageImages = pageParse?.images || [];
  const pageSpecs = pageParse?.specs || {};
  const pageDesc = pageParse?.description || '';
  const pagePrice = pageParse?.price;
  const pageUntaxed = pageParse?.untaxed_price;
  const pageMember = pageParse?.member_price;
  const pageUnit = pageParse?.price_unit || '';

  const title = result.productName || result.skuName || pageTitle || '';
  const brand = result.brand || result.brandName || pageSpecs['品牌名称'] || '';
  const model = result.model || result.modelNo || pageSpecs['商品型号'] || '';
  const packSpec = result.packageSpec || result.packSpec || pageSpecs['包装规格'] || '';
  const orderCode = skuNo || result.skuNo || pageSpecs['订货编码'] || '';
  const minOrderRaw = result.minOrder || result.minOrderQty || pageSpecs['起订量'] || '1';
  const minPackageRaw = result.minPackage || result.minPackageQty || pageSpecs['最小包装量'] || '1';
  const coerceQty = (v) => {
    if (typeof v === 'number') return v;
    if (!v) return 1;
    const m = String(v).match(/([\d.]+)/);
    const n = m ? parseFloat(m[1]) : NaN;
    return (!isNaN(n) && n > 0) ? n : 1;
  };
  const minOrder = coerceQty(minOrderRaw);
  const minPackage = coerceQty(minPackageRaw);
  const unit = result.unit || result.saleUnit || pageUnit || '';
  const stock = result.stock || result.stockQty || null;

  // 价格优先级：price API加密价格返回解密 -> coupons 接口 -> 规格selectSpec -> 页面解析（HTML锚点最可靠兜底）
  let price = null;
  const priceFromEnc =
    priceInfo.price || priceInfo.displayPrice ||
    (Array.isArray(priceInfo) && priceInfo[0] && (priceInfo[0].price || priceInfo[0].displayPrice)) ||
    null;
  const priceFromCoupon = coupons.price || coupons.displayPrice || coupons.salePrice || null;
  const priceFromSpec = result.price || result.salePrice || result.marketPrice || null;
  const untaxedPrice = coupons.untaxedPrice || coupons.nakedPrice || pageUntaxed || null;
  const taxRate = coupons.taxRate || null;
  const memberPrice = coupons.memberPrice || coupons.vipPrice || pageMember || null;

  if (typeof priceFromEnc === 'number' && priceFromEnc > 0) price = priceFromEnc;
  else if (typeof priceFromCoupon === 'number' && priceFromCoupon > 0) price = priceFromCoupon;
  else if (typeof priceFromSpec === 'number' && priceFromSpec > 0) price = priceFromSpec;
  else if (typeof pagePrice === 'number' && pagePrice > 0) price = pagePrice;

  // 图片
  const rawImages = result.pics || result.images || (result.picList && result.picList.map(p => p.url)) || [];
  const bigImages = rawImages.filter(u => u && typeof u === 'string').map(u => (u.startsWith('http') ? u : (u.startsWith('//') ? 'https:' + u : u)));
  const images = [...new Set([...bigImages, ...pageImages])].filter(Boolean);

  // 规格参数
  const params = result.params || result.parameters || result.specList || [];
  const specMap = {};
  params.forEach(p => {
    const k = p.name || p.label || p.key;
    const v = p.value || p.val;
    if (k && v != null) specMap[k] = typeof v === 'string' ? v : JSON.stringify(v);
  });
  Object.assign(specMap, pageSpecs);

  // 促销
  const promotions = coupons.promotions || coupons.promotionList || coupons.couponList || [];
  const tagsArr = Array.isArray(tags) ? tags : (tags.list || tags.tags || []);

  // 关联商品
  const related = relatedList.map(r => ({
    sku_no: r.skuNo || r.proSkuNo || r.sku_no || r.id,
    title: r.productName || r.title || r.name,
    price: r.price || r.salePrice,
    image: r.mainPic || r.imageUrl || r.img,
    url: r.skuNo ? `${ZKH_BASE}/item/${r.skuNo}.html` : (r.url || ''),
  })).filter(x => x.sku_no || x.title);
  const replace = replaceList.map(r => ({
    sku_no: r.skuNo || r.id,
    title: r.productName || r.title,
    price: r.price,
    image: r.mainPic || r.image,
  })).filter(x => x.sku_no || x.title);
  const combination = combineList.map(r => ({
    sku_no: r.skuNo || r.id,
    title: r.productName || r.title,
    price: r.price || r.combinePrice,
  })).filter(x => x.sku_no || x.title);

  // 运费
  const freightInfo = {
    free: freight.free || freight.isFree || false,
    free_condition: freight.freeCondition || null,
    estimate: freight.estimate || freight.freightFee || null,
    region: freight.region || null,
    detail: freight.detail || null,
  };

  return {
    sku_no: orderCode,
    title,
    sub_title: result.subTitle || result.subtitle || '',
    description: result.description || result.introduction || pageDesc,
    keywords: pageParse?.keywords || [],
    brand,
    model,
    package_spec: packSpec,
    order_code: orderCode,
    min_order: minOrder,
    min_package: minPackage,
    unit,
    price,
    price_unit: unit || '',
    member_price: memberPrice,
    untaxed_price: untaxedPrice,
    tax_rate: taxRate,
    currency: 'CNY',
    main_image: images[0] || '',
    images,
    specs: specMap,
    tags: tagsArr.map(t => typeof t === 'string' ? t : (t.name || t.label || t.title || '')).filter(Boolean),
    promotions,
    freight: freightInfo,
    stock,
    delivery: {
      available: result.available === undefined ? true : !!result.available,
      ship_from: result.shipFrom || freight.shipFrom || null,
      ship_text: result.shipText || null,
    },
    related_products: related,
    replace_products: replace,
    combination_products: combination,
    url: `${ZKH_BASE}/item/${skuNo}.html`,
    raw: {
      coupons_code: couponsRaw?.code,
      tags_code: tagsRaw?.code,
      freight_code: freightRaw?.code,
      spec_code: specRaw?.code,
      price_code: priceRaw?.code,
    },
  };
}

module.exports = { searchProducts, getProductDetail };