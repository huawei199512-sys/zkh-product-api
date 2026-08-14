// 震坤行(zkh.com)爬虫服务 - web.zkh360.com POST API + 强制代理IP竞态
//
// 架构（参考1688 API项目）：
//   1. web.zkh360.com POST API（无WAF）通过代理竞态请求
//   2. 代理失败回退直连（保证可用性）
//   3. HTML解析兜底（分类列表页/搜索页/详情页）
//
// 强制代理：代理池永远开启，不可关闭
// 完全不依赖 Cookie、不需要过滑块、不需要 Chromium
const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('./proxyManager');

// ============ 配置 ============
const ZKH_BASE = 'https://www.zkh.com';
const ZKH360_API = 'https://web.zkh360.com';
const ZKH360_SEARCH_API = ZKH360_API + '/api/search/listProductInfo';

// 代理强制开启（不可关闭）
const FORCE_PROXY = true;

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

// ============ 超时与并发策略（参考1688/xfs项目）============
const SINGLE_TIMEOUT = 12000;        // 单次请求 12s
const TOTAL_TIMEOUT = 60000;         // 单个用户请求绝对截止 60s
const CONCURRENT = 3;                // 每轮并发3个代理
const MAX_ROUNDS = 8;                // 最大8轮

function randomUA() { return DESKTOP_UAS[Math.floor(Math.random() * DESKTOP_UAS.length)]; }

// ============ 代理竞态请求（参考1688 requestWithProxyRace）============
async function requestWithProxyRace(requestFn, options = {}) {
  const {
    concurrent = CONCURRENT,
    maxRounds = MAX_ROUNDS,
    totalTimeout = TOTAL_TIMEOUT,
  } = options;

  // 代理未启用或无代理 → 直连
  if (!proxyManager.isEnabled() || proxyManager.getNextProxy() === null) {
    console.log('[ZKH] 直连模式（代理池为空，回退直连）');
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), totalTimeout);
    try {
      const result = await requestFn(null, controller.signal);
      clearTimeout(abortTimer);
      return { ...result, proxy_used: 'direct' };
    } catch (error) {
      clearTimeout(abortTimer);
      return { success: false, error: error.message, proxy_used: 'direct' };
    }
  }

  // 代理竞态模式
  const startTime = Date.now();
  const seenProxies = new Set();
  const attemptedProxies = [];

  function getProxyBatch(count) {
    const batch = [];
    for (let i = 0; i < count; i++) {
      const p = proxyManager.getNextProxy();
      if (p && !seenProxies.has(p)) {
        batch.push(p);
        seenProxies.add(p);
      }
    }
    return batch;
  }

  for (let round = 0; round < maxRounds; round++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeout) {
      console.warn(`[ZKH] 总超时 (${(elapsed / 1000).toFixed(1)}s)`);
      break;
    }

    let batch = getProxyBatch(concurrent);
    if (batch.length === 0) {
      seenProxies.clear();
      batch = getProxyBatch(concurrent);
      if (batch.length === 0) break;
    }

    console.log(`[ZKH] 第${round + 1}轮: 并发${batch.length}代理竞态...`);
    const roundStart = Date.now();

    const tasks = batch.map((proxy) => {
      const controller = new AbortController();
      const promise = requestFn(proxy, controller.signal)
        .then((result) => ({ proxy, result, controller }))
        .catch((error) => ({ proxy, result: { success: false, error: error.message }, controller }));
      return { proxy, promise, controller };
    });

    // Promise.race 竞态：第一个成功立即返回
    let successResult = null;
    await new Promise((resolve) => {
      let resolved = false;
      let failCount = 0;
      tasks.forEach(({ proxy, promise }) => {
        promise.then(({ result, controller }) => {
          if (resolved) return;
          const time = ((Date.now() - roundStart) / 1000).toFixed(2);
          if (result.success) {
            resolved = true;
            successResult = { proxy, result, time };
            proxyManager.markGood(proxy);
            attemptedProxies.push({ proxy, status: 'success', time });
            // 中止其他任务
            tasks.forEach((t) => {
              if (t.proxy !== proxy) {
                try { t.controller.abort(); } catch {}
              }
            });
            resolve();
          } else {
            proxyManager.markBad(proxy, isSevereError(result.error));
            attemptedProxies.push({ proxy, status: 'failed', time, error: result.error });
            failCount++;
            if (failCount >= batch.length) resolve();
          }
        });
      });
    });

    if (successResult) {
      console.log(`[ZKH] ✅ 代理成功: ${successResult.proxy} (${successResult.time}s)`);
      return {
        ...successResult.result,
        proxy_used: successResult.proxy,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
        attempted_proxies: attemptedProxies,
      };
    }

    // 每2轮刷新代理池
    if (round % 2 === 1) {
      try { await proxyManager.refreshProxies(false); } catch {}
    }
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }

  // 所有代理失败，回退直连
  console.log('[ZKH] 所有代理失败，回退直连...');
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), SINGLE_TIMEOUT);
  try {
    const result = await requestFn(null, controller.signal);
    clearTimeout(abortTimer);
    return { ...result, proxy_used: 'direct-fallback', elapsed: ((Date.now() - startTime) / 1000).toFixed(2), attempted_proxies: attemptedProxies };
  } catch (error) {
    clearTimeout(abortTimer);
    return {
      success: false,
      error: `所有代理失败 (${attemptedProxies.length}个) + 直连失败: ${error.message}`,
      proxy_used: null,
      elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
      attempted_proxies: attemptedProxies,
    };
  }
}

// ============ WAF 检测 ============
function isWafPage(html) {
  if (!html || typeof html !== 'string') return false;
  return html.includes('请按住滑块') || html.includes('访问验证') || html.includes('滑动验证')
    || (html.includes('slider') && html.includes('verify'));
}
function isSevereError(msg) {
  const s = String(msg || '').toUpperCase();
  return /CERT|TLS|SSL|403|407|ECONNREFUSED|HANDSHAKE/.test(s);
}

// ============ web.zkh360.com POST API（通过代理竞态）============
async function searchViaZKH360API(keyword, page = 1, pageSize = 40) {
  const from = (Number(page) - 1) * Number(pageSize);
  const body = {
    from: from,
    size: Number(pageSize),
    keyword: keyword || null,
    fz: false,
    catalogueId: null,
    productFilter: { brandIds: [], properties: {} },
    cityCode: 310100,
    extraFilter: { showIndustryFeatured: false, inStock: false },
    searchType: { notNeedCorrect: false },
    clp: true,
  };

  // 通过代理竞态请求 zkh360 API
  const result = await requestWithProxyRace(async (proxy, abortSignal) => {
    const axiosConfig = {
      method: 'POST',
      url: ZKH360_SEARCH_API,
      data: body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': randomUA(),
        'Accept': 'application/json',
        'Origin': ZKH360_API,
        'Referer': ZKH360_API + '/',
      },
      timeout: SINGLE_TIMEOUT,
      signal: abortSignal,
      maxRedirects: 3,
      validateStatus: () => true,
    };
    if (proxy) {
      const proxyCfg = proxyManager.createAxiosProxyConfig(proxy);
      Object.assign(axiosConfig, proxyCfg);
    }
    const resp = await axios(axiosConfig);
    if (resp.status !== 200) {
      return { success: false, error: `zkh360 API status=${resp.status}` };
    }
    const data = resp.data;
    const pageData = data.page || data.data || data.result || data;
    const list = pageData.content || pageData.list || pageData.products || pageData.records || [];
    const total = pageData.total || pageData.totalCount || pageData.totalElements || pageData.skuTotalHits || list.length;
    const totalPages = pageData.totalPages || pageData.totalPage || Math.ceil(total / pageSize) || 1;

    if (!list || list.length === 0) {
      return { success: false, error: 'zkh360 API returned empty list' };
    }

    const products = list.map(item => normalizeAPIProduct(item));
    return {
      success: true,
      source: 'zkh360-api',
      data: {
        keyword,
        page: Number(page),
        page_size: Number(pageSize),
        total: total,
        total_pages: totalPages,
        products,
      },
    };
  });

  return result;
}

// ============ 工具：从对象中按多个候选键取第一个非空值 ============
function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '' && obj[k] !== false) return obj[k];
  }
  return null;
}
function pickFirstStr(obj, keys) {
  const v = pickFirst(obj, keys);
  if (v == null) return '';
  return typeof v === 'string' ? v.replace(/<[^>]+>/g, '').trim() : String(v);
}
function pickFirstNum(obj, keys) {
  const v = pickFirst(obj, keys);
  return parsePrice(v);
}

// ============ 标准化API返回的商品对象（完整字段，参考1688结构）============
// 全字段映射 + raw_data 兜底，确保所有可用数据都返回
function normalizeAPIProduct(item) {
  const strip = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
  const sku = pickFirstStr(item, ['proSkuNo', 'skuNo', 'productNo', 'spuNo', 'sku', 'productSku', 'materialNo', 'id']);

  // ====== 图片：尝试所有可能的字段名 ======
  const imageKeys = [
    'proImgPath_Z1', 'proImgPath', 'proImgPath_Z2', 'proImgPath_Z3', 'proImgPath_Z4',
    'mainPic', 'imageUrl', 'imgUrl', 'picUrl', 'proMainPic', 'proMainPicUrl',
    'imageList', 'images', 'imgs', 'pics', 'photos', 'imgList', 'mainImage',
    'thumb', 'thumbnail', 'proImageUrl', 'proPicUrl', 'proMainImg',
    'imgPath', 'imagePath', 'picPath', 'mainPicUrl', 'proImg', 'proImage',
    'proSkuImgPath', 'proSkuImg', 'skuImg', 'skuImage', 'productImg', 'productImage',
    'proImgUrl', 'proPic', 'pic', 'img', 'image', 'photo',
  ];
  let images = [];
  for (const k of imageKeys) {
    if (item[k] == null) continue;
    const raw = item[k];
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const u of arr) {
      let url = '';
      if (typeof u === 'string') url = u;
      else if (typeof u === 'object') url = u.url || u.src || u.path || u.imgUrl || u.imageUrl || u.pic || u.image || '';
      const fixed = fixUrl(url);
      if (fixed && !images.includes(fixed)) images.push(fixed);
    }
    if (images.length > 0) break; // 找到第一个有效图片字段就停止
  }

  // ====== 分类：尝试所有可能的字段名 ======
  const category = pickFirstStr(item, [
    'level4CatalogueName', 'level3CatalogueName', 'level2CatalogueName', 'level1CatalogueName',
    'catalogName', 'catalogueName', 'categoryName', 'category', 'catName',
    'proCatalogName', 'proCategoryName', 'categoryInfo', 'typeName', 'proTypeName',
    'catalogueFullName', 'fullCatalogName', 'categoryFullName', 'proCatalogFullName',
    'level4CatalogueFullName', 'level3CatalogueFullName',
  ]);
  const category_id = pickFirst(item, [
    'level4CatalogueId', 'level3CatalogueId', 'level2CatalogueId', 'level1CatalogueId',
    'catalogId', 'catalogueId', 'categoryId', 'catId', 'proCatalogId', 'proCategoryId',
  ]);

  // ====== 描述/副标题：尝试所有可能的字段名 ======
  const description = pickFirstStr(item, [
    'proSkuFeature', 'proSkuSubTitle', 'description', 'desc', 'proDescription',
    'proDesc', 'proRemark', 'remark', 'detail', 'proDetail', 'introduction',
    'proIntroduction', 'webInfoComment', 'comment', 'proComment',
    'proSkuDescription', 'skuDescription', 'productDescription', 'proFeature',
    'feature', 'proSkuRemark', 'subTitle', 'subtitle', 'proSubTitle',
  ]);
  const sub_title = pickFirstStr(item, [
    'proSkuFeature', 'proSkuSubTitle', 'subTitle', 'subtitle', 'proSubTitle',
    'proSkuSubTitleName', 'skuSubTitle', 'productSubTitle',
  ]);

  // ====== 库存：尝试所有可能的字段名 ======
  const stock = pickFirst(item, [
    'inventory', 'stock', 'stockQty', 'proStock', 'stockNum', 'proStockNum',
    'availableStock', 'availableQty', 'proInventory', 'proStockQty',
    'stockQuantity', 'qty', 'quantity', 'proQty', 'proQuantity', 'usableQty',
    'usableStock', 'realStock', 'realQty', 'proRealStock', 'proUsableStock',
  ]);

  // ====== 价格：尝试所有可能的字段名 ======
  const price = pickFirstNum(item, [
    'sellingPrice', 'price', 'salePrice', 'displayPrice', 'proPrice',
    'proSkuPrice', 'skuPrice', 'productPrice', 'currentPrice', 'finalPrice',
    'proSellingPrice', 'proSalePrice', 'webPrice', 'proWebPrice',
  ]);
  const origin_price = pickFirstNum(item, [
    'originPrice', 'originalPrice', 'marketPrice', 'proMarketPrice', 'proOriginPrice',
    'listPrice', 'proListPrice', 'retailPrice', 'proRetailPrice', 'tagPrice',
  ]);
  const untaxed_price = pickFirstNum(item, [
    'untaxedSellingPrice', 'untaxedPrice', 'noTaxPrice', 'proNoTaxPrice',
    'excludingTaxPrice', 'proExcludingTaxPrice', 'taxExclusivePrice',
  ]);
  const member_price = pickFirstNum(item, [
    'memberPrice', 'proMemberPrice', 'vipPrice', 'proVipPrice',
    'discountPrice', 'proDiscountPrice', 'specialPrice', 'proSpecialPrice',
  ]);
  const tax_rate = pickFirst(item, [
    'taxRate', 'proTaxRate', 'vatRate', 'proVatRate', 'taxRateCode',
  ]);

  // ====== 品牌 ======
  const brand = pickFirstStr(item, [
    'proBrandName', 'brandName', 'brand', 'proBrand', 'manufacturer', 'proManufacturer',
  ]);
  const brand_id = pickFirst(item, ['proBrandId', 'brandId', 'brandCode', 'proBrandCode']);

  // ====== 型号 ======
  const model = pickFirstStr(item, [
    'proMaterialNo', 'modelNo', 'model', 'materialNo', 'proModel',
    'proModelNo', 'productModel', 'skuModel', 'specModel', 'partNumber', 'proPartNumber',
  ]);

  // ====== 单位 ======
  const price_unit = pickFirstStr(item, [
    'unitOfMeasureCode', 'unit', 'proUnit', 'saleUnit', 'proSaleUnit',
    'measureUnit', 'proMeasureUnit', 'uom', 'proUom',
  ]);

  // ====== 起订量 / 最小包装量 ======
  const min_order = pickFirst(item, [
    'proSkuMinOrderNum', 'minOrderQty', 'minOrder', 'proMinOrder',
    'moq', 'proMoq', 'minOrderQuantity', 'proMinOrderQuantity',
  ]) || 1;
  const mpq = pickFirst(item, [
    'mpq', 'minPackageQty', 'minPackage', 'proMinPackage', 'proMpq',
    'packageQty', 'proPackageQty', 'minPkgQty', 'proMinPkgQty',
  ]) || 1;

  // ====== 发货日 / 交期 ======
  const lead_time = pickFirst(item, [
    'proSkuLeadTime', 'leadTime', 'deliveryTime', 'proDeliveryTime',
    'deliveryDay', 'proDeliveryDay', 'shippingDay', 'proShippingDay',
    'deliveryCycle', 'proDeliveryCycle', 'leadTimeDay', 'proLeadTimeDay',
  ]);

  // ====== 规格参数（从所有可能的字段提取）======
  const specs = {};
  const specMappings = [
    { keys: ['proMaterialNo', 'modelNo', 'model', 'materialNo'], label: '商品型号' },
    { keys: ['proBrandName', 'brandName', 'brand'], label: '品牌名称' },
    { keys: ['unitOfMeasureCode', 'unit', 'proUnit', 'saleUnit'], label: '销售单位' },
    { keys: ['proSkuMinOrderNum', 'minOrderQty', 'minOrder', 'moq'], label: '起订量' },
    { keys: ['mpq', 'minPackageQty', 'minPackage'], label: '最小包装量' },
    { keys: ['proSkuLeadTime', 'leadTime', 'deliveryTime'], label: '发货日' },
    { keys: ['taxRate', 'proTaxRate', 'vatRate'], label: '税率' },
    { keys: ['level4CatalogueName', 'level3CatalogueName', 'catalogName', 'categoryName'], label: '分类' },
    { keys: ['proSkuFeature', 'proSkuSubTitle', 'feature'], label: '商品特性' },
    { keys: ['webInfoComment', 'comment', 'remark'], label: '备注' },
    { keys: ['origin', 'proOrigin', 'originPlace', 'proOriginPlace'], label: '产地' },
    { keys: ['weight', 'proWeight', 'productWeight'], label: '重量' },
    { keys: ['warranty', 'proWarranty', 'warrantyPeriod'], label: '质保期' },
    { keys: ['proSkuModel', 'skuModel', 'specModel'], label: '规格型号' },
  ];
  for (const { keys, label } of specMappings) {
    const v = pickFirst(item, keys);
    if (v != null && v !== '') specs[label] = strip(String(v));
  }

  // ====== 额外字段 ======
  const priceConfig = pickFirst(item, ['priceConfig', 'proPriceConfig', 'priceList', 'proPriceList']);
  const web_info_comment = pickFirstStr(item, ['webInfoComment', 'comment', 'remark', 'proComment']);
  const product_positioning = pickFirst(item, ['productPositioning', 'proProductPositioning']);
  const commodity_source_type = pickFirst(item, ['commoditySourceType', 'proCommoditySourceType', 'productSourceType']);
  const is_collect = pickFirst(item, ['isCollect', 'proIsCollect', 'collected']) || '0';
  const delivery_day = pickFirst(item, ['deliveryDay', 'proDeliveryDay', 'shippingDay']);

  return {
    sku_no: String(sku),
    title: pickFirstStr(item, ['proSkuProductName', 'productName', 'title', 'name', 'proName', 'proSkuName', 'skuName', 'productTitle']),
    sub_title: sub_title,
    description: description,
    brand: brand,
    brand_id: brand_id,
    model: model,
    price: price,
    origin_price: origin_price,
    untaxed_price: untaxed_price,
    tax_rate: tax_rate,
    price_unit: price_unit,
    member_price: member_price,
    currency: 'CNY',
    image: images[0] || '',
    images: images,
    category: category,
    category_id: category_id,
    category_level1_id: pickFirst(item, ['level1CatalogueId', 'level1CatalogId']) || null,
    min_order: min_order,
    min_package: mpq,
    stock: stock,
    lead_time: lead_time,
    delivery_day: delivery_day,
    is_collect: is_collect,
    mpq: mpq,
    price_config: priceConfig,
    web_info_comment: web_info_comment,
    product_positioning: product_positioning,
    commodity_source_type: commodity_source_type,
    url: sku ? `${ZKH_BASE}/item/${sku}.html` : '',
    specs: specs,
    // 关键：包含完整原始数据，确保所有字段都可用（参考1688 raw_data设计）
    raw_data: item,
  };
}

// ============ 关键字搜索 ============
async function searchProducts(keyword, page = 1, pageSize = 40) {
  console.log(`[Search] keyword=${keyword}, page=${page}, pageSize=${pageSize}`);
  // 通过代理竞态请求 zkh360 API
  const apiResult = await searchViaZKH360API(keyword, page, pageSize);
  if (apiResult.success) {
    console.log(`[Search] ✅ 成功: keyword=${keyword}, count=${apiResult.data.products.length}, proxy=${apiResult.proxy_used}`);
    return formatSearchResult(apiResult, keyword, page, pageSize);
  }
  console.log(`[Search] zkh360 API 失败: ${apiResult.error}，尝试HTML搜索页...`);

  // 备选：HTML搜索页解析（通过代理竞态）
  const htmlResult = await fetchZKHPageViaProxy('/search.html', `?keywords=${encodeURIComponent(keyword)}&hasLinkWord=&page=${page}`, ZKH_BASE + '/');
  if (!htmlResult.success) {
    return formatSearchResult(htmlResult, keyword, page, pageSize);
  }

  const parsed = parseSearchFromHtml(htmlResult.data, keyword, page, pageSize);
  return formatSearchResult({ ...parsed, source: htmlResult.source }, keyword, page, pageSize);
}

// ============ 通过代理竞态获取 ZKH HTML 页面 ============
async function fetchZKHPageViaProxy(targetPath, search, referer) {
  const targetUrl = ZKH_BASE + targetPath + (search || '');
  const headers = buildHeaders(referer);

  return await requestWithProxyRace(async (proxy, abortSignal) => {
    const axiosConfig = {
      method: 'GET',
      url: targetUrl,
      headers,
      timeout: SINGLE_TIMEOUT,
      responseType: 'text',
      maxRedirects: 3,
      signal: abortSignal,
      validateStatus: () => true,
    };
    if (proxy) {
      const proxyCfg = proxyManager.createAxiosProxyConfig(proxy);
      Object.assign(axiosConfig, proxyCfg);
    }
    const resp = await axios(axiosConfig);
    if (resp.status === 200 && resp.data && !isWafPage(resp.data)) {
      return { success: true, data: resp.data, source: proxy ? 'proxy' : 'direct' };
    }
    return { success: false, error: `status=${resp.status} waf=${isWafPage(resp.data)}` };
  });
}

// ============ 通用请求头 ============
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

// ============ 从搜索页 HTML 解析商品列表 ============
function parseSearchFromHtml(html, keyword, page, pageSize) {
  try {
    if (isWafPage(html)) return { success: false, error: 'WAF blocked' };
    const $ = cheerio.load(html || '');
    const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s ?? ''));
    const products = [];
    const seen = new Set();
    const add = (p) => {
      if (!p.sku_no || seen.has(String(p.sku_no))) return;
      seen.add(String(p.sku_no));
      products.push(p);
    };

    // 方案1：__NEXT_DATA__
    const nextScript = $('#__NEXT_DATA__').html();
    if (nextScript) {
      try {
        const nd = JSON.parse(nextScript);
        const list = findProductArray(nd.props?.pageProps || nd);
        if (list && list.length) {
          list.forEach(item => {
            const sku = item.skuNo || item.productNo || item.spuNo || item.id;
            if (!sku) return;
            add(normalizeAPIProduct(item));
          });
        }
      } catch {}
    }

    // 方案2：DOM 商品卡片
    if (products.length === 0) {
      $('a[href*="/item/"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const mm = href.match(/\/item\/([A-Za-z0-9]+)\.html/);
        if (!mm) return;
        const sku = mm[1];
        if (seen.has(sku)) return;
        const $card = $(a).closest('li, div[class*="product"], div[class*="card"], div[class*="item"]');
        const title = ($(a).attr('title') || $(a).text() || '').trim();
        const priceText = $card.find('[class*="price"], [class*="Price"]').first().text() || '';
        const pm = priceText.match(/[\d,]+\.?\d*/);
        const img = $card.find('img').first();
        add({
          sku_no: sku,
          title: stripHtml(title).substring(0, 200),
          price: pm ? parseFloat(pm[0].replace(/,/g, '')) : null,
          image: fixUrl(img.attr('src') || img.attr('data-src') || ''),
          images: [],
          url: href.startsWith('http') ? href : ZKH_BASE + href,
          specs: {},
        });
      });
    }

    if (products.length === 0) return { success: false, error: 'html parse empty' };

    const start = (Number(page) - 1) * Number(pageSize);
    const paged = products.slice(start, start + Number(pageSize));

    return {
      success: true,
      data: {
        keyword,
        page: Number(page),
        page_size: Number(pageSize),
        total: products.length,
        total_pages: Math.ceil(products.length / Number(pageSize)) || 1,
        products: paged,
      },
    };
  } catch (e) {
    return { success: false, error: 'parse error: ' + e.message };
  }
}

// 递归查找包含商品对象的数组
function findProductArray(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].proSkuNo || obj[0].skuNo || obj[0].productNo || obj[0].proSkuProductName || obj[0].productName)) {
    return obj;
  }
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) {
      if (obj[k][0] && (obj[k][0].proSkuNo || obj[k][0].skuNo || obj[k][0].productNo || obj[k][0].proSkuProductName || obj[k][0].productName)) {
        return obj[k];
      }
    }
    if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      const found = findProductArray(obj[k], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  const m = String(v).match(/[\d,]+\.?\d*/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return (!isNaN(n) && n > 0 && n < 9999999) ? n : null;
}

function fixUrl(u) {
  if (!u || typeof u !== 'string') return '';
  u = u.trim();
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return ZKH_BASE + u;
  return u;
}

function formatSearchResult(result, keyword, page, pageSize) {
  if (!result || !result.success) {
    return {
      success: false,
      error: (result && result.error) || '搜索失败',
      keyword,
      page: Number(page),
      page_size: Number(pageSize),
      total: 0,
      total_pages: 0,
      products: [],
      proxy_used: result?.proxy_used || null,
    };
  }
  return {
    success: true,
    source: result.source,
    proxy_used: result.proxy_used || null,
    elapsed: result.elapsed || null,
    ...result.data,
  };
}

// ============ 商品详情（完整字段，参考1688结构）============
async function getProductDetail(skuNo) {
  console.log(`[Detail] sku=${skuNo}`);
  // 用 web.zkh360.com API 按SKU搜索
  const apiResult = await searchViaZKH360API(skuNo, 1, 10);
  if (apiResult.success && apiResult.data && apiResult.data.products) {
    const match = apiResult.data.products.find(
      p => p.sku_no && p.sku_no.toUpperCase() === String(skuNo).toUpperCase()
    );
    if (match) {
      console.log(`[Detail] ✅ zkh360 API 成功: sku=${skuNo}, proxy=${apiResult.proxy_used}`);
      return buildDetailResult(match, apiResult.proxy_used);
    }
    // 未精确匹配，返回第一个候选
    if (apiResult.data.products.length > 0) {
      console.log(`[Detail] 未精确匹配SKU=${skuNo}，返回候选: ${apiResult.data.products[0].sku_no}`);
      return buildDetailResult(apiResult.data.products[0], apiResult.proxy_used);
    }
  }
  console.log(`[Detail] zkh360 API 未找到SKU=${skuNo}: ${apiResult.error}，尝试HTML详情页...`);

  // 备选：HTML详情页解析（通过代理竞态）
  const htmlResult = await fetchZKHPageViaProxy(`/item/${skuNo}.html`, '', ZKH_BASE + '/');
  if (!htmlResult.success) {
    return { success: false, error: htmlResult.error || '详情获取失败', sku_no: skuNo };
  }

  const parsed = parseDetailFromHtml(htmlResult.data, skuNo);
  if (!parsed) {
    return { success: false, error: '详情页解析失败（可能WAF或页面结构变更）', sku_no: skuNo };
  }
  return { success: true, source: htmlResult.source, proxy_used: htmlResult.proxy_used, ...parsed };
}

// 构建完整详情结果（参考1688字段结构）
function buildDetailResult(match, proxyUsed) {
  const specs = match.specs || {};
  return {
    success: true,
    source: 'zkh360-api',
    proxy_used: proxyUsed || null,
    sku_no: match.sku_no,
    title: match.title,
    description: match.description || match.sub_title || '',
    sub_title: match.sub_title || '',
    keywords: [],
    brand: match.brand,
    brand_id: match.brand_id || null,
    model: match.model,
    order_code: match.sku_no,
    package_spec: specs['包装规格'] || specs['包装'] || '',
    min_order: match.min_order,
    min_package: match.min_package,
    unit: match.price_unit,
    price: match.price,
    origin_price: match.origin_price || null,
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
    raw_data: match.raw_data || null,
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
    if (nextScript) {
      try {
        const nd = JSON.parse(nextScript);
        detail = findDetailObject(nd.props?.pageProps || nd, skuNo);
      } catch {}
    }

    let title = detail?.productName || detail?.proSkuProductName || detail?.skuName || '';
    if (!title) {
      const pageTitle = $('title').text().split('【')[0].split(/[|_-]/)[0].trim();
      title = pageTitle;
    }
    if (!title) {
      $('h1, [class*="ProductTitle"], [class*="title"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 5 && t.length < 200 && !title) title = t;
      });
    }

    const images = [];
    if (detail?.proImgPath_Z1?.length) {
      detail.proImgPath_Z1.forEach(p => { const u = fixUrl(typeof p === 'string' ? p : p?.url); if (u) images.push(u); });
    } else if (detail?.pics?.length) {
      detail.pics.forEach(p => { const u = fixUrl(typeof p === 'string' ? p : p?.url); if (u) images.push(u); });
    }
    if (images.length === 0) {
      $('img[src*="private.zkh.com/PRODUCT"], img[src*="PRODUCT/BIG"], img[src*="PRODUCT/MKT"]').each((_, img) => {
        const src = fixUrl($(img).attr('src') || $(img).attr('data-src') || '');
        if (src && !images.includes(src)) images.push(src);
      });
    }

    let price = parsePrice(detail?.sellingPrice ?? detail?.price ?? detail?.salePrice ?? detail?.displayPrice);
    if (!price) {
      const m = text.match(/官网价[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/);
      if (m) price = parsePrice(m[1]);
    }
    const untaxed = parsePrice(detail?.untaxedSellingPrice) || (() => {
      const m = text.match(/未税价格[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/);
      return m ? parsePrice(m[1]) : null;
    })();
    const member = (() => {
      const m = text.match(/会员价[^\d]{0,40}([￥¥]?\s*[\d,]+\.?\d*)/);
      return m ? parsePrice(m[1]) : null;
    })();

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
    fieldLabels.forEach(f => {
      if (specs[f]) return;
      const rx = new RegExp(`${f}[\\s:：]*([^\\n\\r]{1,80}?)\\s*(?=(${fieldLabels.join('|')})|$)`, 'm');
      const m = text.match(rx);
      if (m && m[1]) specs[f] = m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
    });

    let unit = detail?.unitOfMeasureCode || detail?.unit || specs['销售单位'] || '';
    let category = detail?.level4CatalogueName || detail?.catalogName || specs['分类'] || '';

    if (!title && images.length === 0 && Object.keys(specs).length === 0) return null;

    return {
      sku_no: skuNo,
      title: stripHtml(title).substring(0, 200),
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
      unit,
      price,
      origin_price: parsePrice(detail?.originPrice > 0 ? detail.originPrice : null),
      untaxed_price: untaxed,
      tax_rate: detail?.taxRate ?? null,
      member_price: member,
      currency: 'CNY',
      main_image: images[0] || '',
      images,
      specs,
      stock: detail?.inventory ?? detail?.stock ?? detail?.stockQty ?? null,
      lead_time: detail?.proSkuLeadTime ?? detail?.leadTime ?? null,
      category,
      category_id: detail?.level4CatalogueId || null,
      mpq: detail?.mpq || 1,
      url: `${ZKH_BASE}/item/${skuNo}.html`,
    };
  } catch (e) {
    return null;
  }
}

function findDetailObject(obj, skuNo, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (obj.proSkuNo === skuNo || obj.skuNo === skuNo || obj.productNo === skuNo) {
    if (obj.proSkuProductName || obj.productName || obj.skuName || obj.price != null || obj.proImgPath_Z1) return obj;
  }
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findDetailObject(obj[k], skuNo, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseQty(v) {
  if (typeof v === 'number') return v;
  if (!v) return 1;
  const m = String(v).match(/([\d.]+)/);
  const n = m ? parseFloat(m[1]) : NaN;
  return (!isNaN(n) && n > 0) ? n : 1;
}

// ============ 调试接口：获取原始API响应（用于分析字段名）============
async function debugRawAPI(keyword, size = 2) {
  const from = 0;
  const body = {
    from,
    size: Number(size),
    keyword: keyword || null,
    fz: false,
    catalogueId: null,
    productFilter: { brandIds: [], properties: {} },
    cityCode: 310100,
    extraFilter: { showIndustryFeatured: false, inStock: false },
    searchType: { notNeedCorrect: false },
    clp: true,
  };

  // 直连请求（不走代理，确保拿到原始响应）
  const t0 = Date.now();
  try {
    const resp = await axios({
      method: 'POST',
      url: ZKH360_SEARCH_API,
      data: body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': randomUA(),
        'Accept': 'application/json',
        'Origin': ZKH360_API,
        'Referer': ZKH360_API + '/',
      },
      timeout: 15000,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    const duration = Date.now() - t0;
    const root = resp.data || {};
    const page = root.page || root.data || root.result || root;
    const list = page.content || page.list || page.products || page.records || [];
    const first = list[0] || null;

    return {
      success: resp.status === 200,
      status: resp.status,
      duration_ms: duration,
      keyword,
      top_keys: Object.keys(root),
      page_keys: Object.keys(page),
      list_len: list.length,
      first_item_keys: first ? Object.keys(first).sort() : [],
      first_item: first,
      raw_response: root,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      duration_ms: Date.now() - t0,
    };
  }
}

// ============ 兼容接口（server.js 调用）============
function getCookieStatus() {
  return {
    cookie_required: false,
    slider_required: false,
    chromium_required: false,
    primary_source: 'web.zkh360.com POST API (无WAF) + 强制代理竞态',
    proxy_enabled: proxyManager.isEnabled(),
    proxy_force: true,
  };
}

function resetSession() {
  return { ok: true, message: 'no cookie session (proxy + zkh360-api mode)' };
}

module.exports = { searchProducts, getProductDetail, getCookieStatus, resetSession, debugRawAPI };
