// 震坤行(zkh.com)商品详情和关键字搜索API - 无登录 + 代理IP + Cookie自动化
const express = require('express');
const cors = require('cors');
const scraperZKH = require('./scraperZKH');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

process.on('uncaughtException', (err) => console.error('[Uncaught]', err.message));
process.on('unhandledRejection', (err) => console.error('[Unhandled]', err?.message || err));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  const cookieSt = scraperZKH.getCookieStatus();
  res.json({
    service: 'ZKH Product API',
    version: '2.0.0-cookie-auto',
    description: '震坤行商品搜索与详情API（代理IP+Cookie自动化获取+无登录）',
    endpoints: {
      health: '/health',
      search: '/api/search?q=关键字&page=1&pageSize=40',
      detail: '/api/detail/:skuNo',
      cookie_status: '/api/cookie/status',
      cookie_reset: '/api/cookie/reset',
      cookie_inject: 'POST /api/cookie/inject  {cookie: "..."}',
      debug_env: '/api/debug/env',
      proxy_status: '/api/proxy/status',
      proxy_refresh: '/api/proxy/refresh',
    },
    cookie: cookieSt,
  });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, keyword, page = 1, pageSize = 40 } = req.query;
    const kw = q || keyword;
    if (!kw) return res.status(400).json({ success: false, error: 'q或keyword参数必填' });
    proxyManager.setEnabled(true);
    const result = await scraperZKH.searchProducts(String(kw), parseInt(page), parseInt(pageSize));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/detail/:skuNo', async (req, res) => {
  try {
    const { skuNo } = req.params;
    if (!skuNo) return res.status(400).json({ success: false, error: 'skuNo参数必填' });
    proxyManager.setEnabled(true);
    const result = await scraperZKH.getProductDetail(String(skuNo).toUpperCase());
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/proxy/status', (req, res) => res.json(proxyManager.getStatus()));

app.post('/api/proxy/refresh', async (req, res) => {
  try { await proxyManager.refreshProxies(true); res.json({ success: true, ...proxyManager.getStatus() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/proxy/refresh', async (req, res) => {
  try { await proxyManager.refreshProxies(true); res.json({ success: true, ...proxyManager.getStatus() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/cookie/status', (req, res) => {
  try { res.json({ success: true, ...scraperZKH.getCookieStatus() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/cookie/reset', (req, res) => {
  try { res.json({ success: true, ...scraperZKH.resetSession() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/cookie/reset', (req, res) => {
  try { res.json({ success: true, ...scraperZKH.resetSession() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/debug/env', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  let cookieFileExists = false, cookieFileData = null;
  try {
    const cp = path.join(__dirname, 'cookies.json');
    cookieFileExists = fs.existsSync(cp);
    if (cookieFileExists) { const r = JSON.parse(fs.readFileSync(cp,'utf8')); cookieFileData = { count: r.cookies?.length||0, len: r.cookie_string?.length||0, fetched_at: r.fetched_at }; }
  } catch {}
  res.json({
    zkh_cookie_env_exists: !!process.env.ZKH_COOKIE_FROM_BROWSER,
    zkh_cookie_env_length: (process.env.ZKH_COOKIE_FROM_BROWSER||'').length,
    cookies_json_exists: cookieFileExists,
    cookies_json_data: cookieFileData,
    all_zkh_keys: Object.keys(process.env).filter(k => k.includes('ZKH')),
    render: process.env.RENDER || 'not set',
  });
});

app.post('/api/cookie/inject', (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie || typeof cookie !== 'string') return res.status(400).json({ success: false, error: '缺少cookie字段' });
    const fs = require('fs');
    const path = require('path');
    const cookiePath = path.join(__dirname, 'cookies.json');
    const cookieData = {
      cookie_string: cookie,
      cookies: cookie.split(';').filter(Boolean).map(c => { const i = c.indexOf('='); return { name: c.slice(0,i).trim(), value: c.slice(i+1).trim() }; }),
      fetched_at: new Date().toISOString(),
      source: 'api_inject',
    };
    fs.writeFileSync(cookiePath, JSON.stringify(cookieData, null, 2), 'utf8');
    console.log('[Cookie] API注入 ' + cookieData.cookies.length + ' 个Cookie');
    scraperZKH.resetSession();
    res.json({ success: true, cookie_count: cookieData.cookies.length, message: 'Cookie已注入，会话已重置' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: '路径不存在: ' + req.method + ' ' + req.path, endpoints: ['GET /', 'GET /health', 'GET /api/search', 'GET /api/detail/:skuNo', 'GET /api/cookie/status', 'POST /api/cookie/inject', 'GET /api/debug/env'] });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  ZKH Product API v2.0.0-cookie-auto');
  console.log('  端口:', PORT);
  console.log('========================================');
  setTimeout(async () => {
    try { await proxyManager.refreshProxies(false); console.log('[Init] 代理池初始化完成'); } catch (e) { console.warn('[Init] 代理池初始化失败:', e.message); }
  }, 1000);
  proxyManager.startAutoRefresh();
});

setInterval(async () => { try { await proxyManager.refreshProxies(false); } catch {} }, 5 * 60 * 1000);
