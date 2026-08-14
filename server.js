// 震坤行(zkh.com)商品详情和关键字搜索API - web.zkh360.com POST API（无WAF，全自动）
// 完全免费方案：无需 Cookie、无需过滑块、无需 Chromium
const express = require('express');
const cors = require('cors');
const scraperZKH = require('./scraperZKH');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;
const VERSION = '7.0.0-zkh360-api';

app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => console.error('[UncaughtException]', err.message));
process.on('unhandledRejection', (err) => console.error('[UnhandledRejection]', err?.message || err));

app.get('/health', (req, res) => { res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), version: VERSION }); });

app.get('/', (req, res) => {
  res.json({
    service: '震坤行 ZKH Product API',
    version: VERSION,
    description: '震坤行(zkh.com)商品详情和关键字搜索API - web.zkh360.com POST API（无WAF，全自动）',
    mode: 'web.zkh360.com POST API + 分类列表页 + 代理池兜底',
    features: { login_required: false, cookie_required: false, slider_required: false, chromium_required: false, data_source: 'web.zkh360.com POST API (无WAF)', strategy: 'zkh360 API → CF Worker → 代理池 → 直连', free_only: true },
    endpoints: { search: 'GET /api/search?q=关键词&page=1&pageSize=40', detail: 'GET /api/detail/:skuNo', test: 'GET /api/test?q=关键词', proxy_status: 'GET /api/proxy/status', cookie_status: 'GET /api/cookie/status' },
    examples: { search: '/api/search?q=手套&page=1&pageSize=40', detail: '/api/detail/AA7029183', test: '/api/test?q=手套' },
    session: scraperZKH.getCookieStatus(),
  });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, keyword, page = 1, pageSize = 40 } = req.query;
    const kw = q || keyword;
    if (!kw) return res.status(400).json({ success: false, error: 'q或keyword参数必填' });
    const result = await scraperZKH.searchProducts(String(kw), parseInt(page), parseInt(pageSize));
    res.json(result);
  } catch (error) { console.error('[Search] error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/detail/:skuNo', async (req, res) => {
  try {
    const { skuNo } = req.params;
    if (!skuNo) return res.status(400).json({ success: false, error: 'skuNo参数必填' });
    const result = await scraperZKH.getProductDetail(String(skuNo).toUpperCase());
    res.json(result);
  } catch (error) { console.error('[Detail] error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/test', async (req, res) => {
  try {
    const axios = require('axios');
    const keyword = req.query.q || '手套';
    const t0 = Date.now();
    const resp = await axios.post('https://web.zkh360.com/api/search/listProductInfo', { from: 0, size: 5, keyword, fz: false, catalogueId: null, productFilter: { brandIds: [], properties: {} }, cityCode: 310100, extraFilter: { showIndustryFeatured: false, inStock: false }, searchType: { notNeedCorrect: false }, clp: true }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', 'Origin': 'https://web.zkh360.com', 'Referer': 'https://web.zkh360.com/' }, timeout: 15000, validateStatus: () => true });
    res.json({ success: resp.status === 200, status: resp.status, duration_ms: Date.now() - t0, keyword, response_keys: resp.data ? Object.keys(resp.data) : [], data_preview: JSON.stringify(resp.data).substring(0, 2000) });
  } catch (error) { res.status(500).json({ success: false, error: error.message, code: error.code }); }
});

app.get('/api/proxy/status', (req, res) => res.json(proxyManager.getStatus()));
app.post('/api/proxy/refresh', async (req, res) => { try { await proxyManager.refreshProxies(true); res.json({ success: true, ...proxyManager.getStatus() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.get('/api/proxy/refresh', async (req, res) => { try { await proxyManager.refreshProxies(true); res.json({ success: true, ...proxyManager.getStatus() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.get('/api/cookie/status', (req, res) => { try { res.json({ success: true, ...scraperZKH.getCookieStatus() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.post('/api/cookie/reset', (req, res) => { try { scraperZKH.resetSession(); res.json({ success: true, message: 'session reset (zkh360-api mode)' }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });

app.use((req, res) => { res.status(404).json({ success: false, error: 'Not Found', path: req.path, endpoints: ['GET /', 'GET /health', 'GET /api/search?q=xxx', 'GET /api/detail/:skuNo', 'GET /api/test?q=xxx'] }); });

app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  震坤行 ZKH Product API v' + VERSION);
  console.log('  端口:', PORT);
  console.log('  模式: web.zkh360.com POST API (无WAF)');
  console.log('========================================');
  setTimeout(async () => { try { await proxyManager.refreshProxies(false); } catch (e) { console.warn('[Init] 代理池初始化失败:', e.message); } }, 1000);
  try { proxyManager.startAutoRefresh(); } catch {}
});

setInterval(async () => { try { await proxyManager.refreshProxies(false); } catch {} }, 5 * 60 * 1000);
