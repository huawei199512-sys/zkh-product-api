// 震坤行(zkh.com)爬虫服务 - Express HTTP Server
// 代理IP + Cookie会话复用 + 多轮重试架构
const express = require('express');
const cors = require('cors');
const proxyManager = require('./proxyManager');
const scraperZKH = require('./scraperZKH');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ============ 全局错误处理 ============
app.use((err, req, res, next) => {
  console.error('[Global Error]', err);
  res.status(500).json({ success: false, error: err.message });
});

// ============ 基础路由 ============
app.get('/', (req, res) => {
  const cookieSt = scraperZKH.getCookieStatus();
  res.json({
    service: 'ZKH Product API',
    version: '2.0.0-cookie',
    description: '震坤行商品搜索与详情API（代理IP+Cookie会话复用+无登录）',
    endpoints: {
      health: '/health',
      search: '/api/search?q=关键字&page=1&pageSize=40',
      detail: '/api/detail/:skuNo',
      cookie_status: '/api/cookie/status',
      cookie_reset: '/api/cookie/reset',
      debug_env: '/api/debug/env',
      proxy_status: '/api/proxy/status',
      proxy_refresh: '/api/proxy/refresh',
    },
    proxy: {
      strategy: '免费代理池 + 并发竞态 + 多轮重试',
      sources: 13,
      concurrent: 5,
      max_rounds: 10,
      single_proxy_timeout: '10s',
      total_timeout: '60s',
    },
    cookie: cookieSt,
    env_vars: {
      ZKH_COOKIE_FROM_BROWSER: '从浏览器 zkh.com 的 document.cookie 复制过来，过了滑块后的会话Cookie（强烈推荐配置）',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ============ 代理池管理接口 ============
app.get('/api/proxy/status', (req, res) => {
  try {
    const status = proxyManager.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(true);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(true);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ Cookie 会话管理接口 ============
app.get('/api/cookie/status', (req, res) => {
  try {
    const status = scraperZKH.getCookieStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 重置 Cookie 会话（例如当前会话被封时重新建立）
app.post('/api/cookie/reset', (req, res) => {
  try {
    const resetInfo = scraperZKH.resetSession();
    res.json({ success: true, ...resetInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/api/cookie/reset', (req, res) => {
  try {
    const resetInfo = scraperZKH.resetSession();
    res.json({ success: true, ...resetInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 调试：检查环境变量 ============
app.get('/api/debug/env', (req, res) => {
  const cookieVal = process.env.ZKH_COOKIE_FROM_BROWSER || '';
  res.json({
    zkh_cookie_from_browser_exists: !!cookieVal,
    zkh_cookie_from_browser_length: cookieVal.length,
    zkh_cookie_from_browser_preview: cookieVal.substring(0, 20) + (cookieVal.length > 20 ? '...' : ''),
    has_zkh_cookie: Object.keys(process.env).some(k => k.includes('ZKH')),
    all_zkh_keys: Object.keys(process.env).filter(k => k.includes('ZKH')),
    node_env: process.env.NODE_ENV || 'not set',
    render: process.env.RENDER || 'not set',
  });
});

// ============ 兜底路由 ============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `路径不存在: ${req.method} ${req.path}`,
    available_endpoints: [
      'GET /',
      'GET /health',
      'GET /api/search?q=xxx&page=1&pageSize=40',
      'GET /api/detail/:skuNo',
      'GET /api/cookie/status',
      'GET /api/cookie/reset',
      'GET /api/debug/env',
      'GET /api/proxy/status',
      'POST /api/proxy/refresh',
    ],
  });
});

// ============ 启动 ============
async function start() {
  console.log('============================================');
  console.log('  ZKH Product API Server v2.0.0-cookie');
  console.log('  端口:', PORT);
  console.log('  代理池: 13源 + 并发5 + 10轮重试');
  console.log('  Cookie: 会话复用 + 浏览器Cookie注入');
  console.log('============================================');

  // 初始化代理池
  try {
    await proxyManager.refreshProxies(false);
    console.log('[Init] 代理池初始化完成');
  } catch (e) {
    console.warn('[Init] 代理池初始化失败，将在请求时重试:', e.message);
  }

  // 检查环境变量
  const envCookie = process.env.ZKH_COOKIE_FROM_BROWSER;
  if (envCookie) {
    console.log('[Init] 检测到浏览器Cookie环境变量，长度:', envCookie.length);
  } else {
    console.log('[Init] 未检测到浏览器Cookie环境变量（ZKH_COOKIE_FROM_BROWSER）');
    console.log('[Init] 建议配置以获得更稳定的请求成功率');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 服务已启动: http://localhost:${PORT}`);
  });
}

start().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});