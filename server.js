// 震坤行(zkh.com)商品详情和关键字搜索API - 无登录 + 强制免费代理IP池
// 参考1688 API架构（huawei199512-sys/api_1688）重新实现
const express = require('express');
const cors = require('cors');
const scraperZKH = require('./scraperZKH');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ============ 全局错误防护 ============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});

// ============ 健康检查端点（Render必需）============
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============ 首页 - API说明 ============
app.get('/', (req, res) => {
  res.json({
    service: '震坤行 ZKH Product API',
    version: '1.0.0',
    description: '震坤行(zkh.com)商品详情和关键字搜索API - 无登录 + 免费代理IP池方案',
    mode: '无登录 + 强制免费代理IP + H5页面解析兜底 + Cookie会话复用',
    features: {
      login_required: false,
      proxy_mode: '强制代理模式 - 13源自动刷新代理池（与1688/Amazon方案一致）',
      protocols_supported: ['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'],
      detail_source: '/servezkhApi/goods/* 系列接口聚合 + /item H5页面解析兜底',
      search_source: '/servezkhApi/search/product/pc API + 搜索页H5兜底',
      strategy: 'Cookie会话建立 -> 5代理并发竞态 × 最多10轮 -> 成功立即返回，每2轮自动刷新代理池',
      proxy_pool: '13源自动刷新代理池（每30分钟后台刷新，每次最小5分钟间隔）',
      cookie_session: {
        jar: '全局 tough-cookie CookieJar 多请求共享会话 Cookie',
        init_priority_1: '环境变量 ZKH_COOKIE_FROM_BROWSER 注入（过了滑块的浏览器Cookie，最可靠）',
        init_priority_2: '访问 https://www.zkh.com/ 首页获取 Set-Cookie 建立会话',
      },
      free_proxy_only: true,
    },
    endpoints: {
      search: 'GET /api/search?q=关键词&page=1&pageSize=40',
      detail: 'GET /api/detail/:skuNo',
      proxy_status: 'GET /api/proxy/status',
      proxy_refresh: 'POST /api/proxy/refresh',
      cookie_status: 'GET /api/cookie/status',
      cookie_reset: 'POST /api/cookie/reset',
    },
    env_vars: {
      ZKH_COOKIE_FROM_BROWSER: '从浏览器 zkh.com 的 document.cookie 复制过来，过了滑块后的会话Cookie（强烈推荐配置）',
    },
    examples: {
      search: 'GET /api/search?q=手套&page=1&pageSize=40',
      detail: 'GET /api/detail/KG2089',
    },
    cookie_status: scraperZKH.getCookieStatus(),
    proxy_status: proxyManager.getStatus(),
  });
});

// ============ 搜索商品 ============
app.get('/api/search', async (req, res) => {
  try {
    const { q, keyword, page = 1, pageSize = 40 } = req.query;
    const kw = q || keyword;
    if (!kw) {
      return res.status(400).json({ success: false, error: 'q或keyword参数必填' });
    }
    proxyManager.setEnabled(true);
    const result = await scraperZKH.searchProducts(String(kw), parseInt(page), parseInt(pageSize));
    res.json(result);
  } catch (error) {
    console.error('[Search] error:', error);
    res.status(500).json({ success: false, error: error.message || '搜索异常' });
  }
});

// ============ 商品详情 ============
app.get('/api/detail/:skuNo', async (req, res) => {
  try {
    const { skuNo } = req.params;
    if (!skuNo) {
      return res.status(400).json({ success: false, error: 'skuNo参数必填' });
    }
    proxyManager.setEnabled(true);
    const result = await scraperZKH.getProductDetail(String(skuNo).toUpperCase());
    res.json(result);
  } catch (error) {
    console.error('[Detail] error:', error);
    res.status(500).json({ success: false, error: error.message || '详情异常' });
  }
});

// ============ 代理状态 ============
app.get('/api/proxy/status', (req, res) => {
  res.json(proxyManager.getStatus());
});

// ============ 手动刷新代理池 ============
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
      'GET /api/proxy/status',
      'POST /api/proxy/refresh',
      'GET /api/cookie/status',
      'POST /api/cookie/reset',
    ],
  });
});

// ============ 先启动服务，再后台初始化代理池（Render健康检查优先）============
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  震坤行 ZKH Product API 已启动');
  console.log('  监听端口: ' + PORT);
  console.log('  模式: 无登录 + 强制免费代理IP + Cookie会话复用');
  console.log('========================================');
  // 服务启动后，后台静默初始化代理池
  setTimeout(async () => {
    try {
      console.log('[Init] 后台初始化代理池...');
      await proxyManager.refreshProxies(true);
      console.log('[Init] 代理池初始化完成:', proxyManager.getStatus());
    } catch (e) {
      console.warn('[Init] 代理池初始化失败（请求时会重试）:', e.message);
    }
  }, 1000);
  // 启动自动刷新
  proxyManager.startAutoRefresh();
});

// ============ Render免费版5分钟定时刷新代理池 ============
setInterval(async () => {
  try {
    await proxyManager.refreshProxies(false);
  } catch (e) {
    console.warn('[AutoRefresh] 代理刷新异常:', e.message);
  }
}, 5 * 60 * 1000);
