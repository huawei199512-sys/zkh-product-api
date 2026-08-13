// 代理池管理模块 - 与1688/Amazon方案一致：13源免费代理自动刷新 + HTTP/HTTPS/SOCKS4/SOCKS5 多协议
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

class ProxyManager {
  constructor() {
    this.knownGoodProxies = [];
    this.proxies = [...this.knownGoodProxies];
    this.badProxies = new Map(); // proxy -> { ts, severity }
    this.enabled = true; // 强制开启代理
    this.maxUsesPerProxy = 5;
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 300; // 5分钟最小刷新间隔
    this.autoRefreshIntervalMs = 30 * 60 * 1000; // 自动刷新：30分钟
    this.badProxyTTL = 60; // 普通坏代理 1分钟后重试
    this.badProxyTTLSevere = 300; // 严重坏代理（证书/403/407）5分钟后重试
    this.proxyIndex = 0;
    this.autoRefreshTimer = null;
    this.refreshing = false;
  }

  getProxyProtocol(proxy) {
    if (proxy.startsWith('socks5://')) return 'socks5';
    if (proxy.startsWith('socks4://')) return 'socks4';
    if (proxy.startsWith('https://')) return 'https';
    return 'http';
  }

  normalizeProxy(proxy) {
    if (proxy.startsWith('socks') || proxy.startsWith('http')) return proxy;
    return `http://${proxy}`;
  }

  setEnabled(enabled) { this.enabled = enabled; }
  isEnabled() { return this.enabled; }

  getStatus() {
    const httpCount = this.proxies.filter(p => !p.startsWith('socks')).length;
    const socksCount = this.proxies.filter(p => p.startsWith('socks')).length;
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      http_count: httpCount,
      socks_count: socksCount,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      last_refresh: this.lastRefreshTime ? new Date(this.lastRefreshTime).toISOString() : 'never',
      auto_refresh_minutes: this.autoRefreshIntervalMs / 60000,
    };
  }

  // 创建axios代理配置
  createAxiosProxyConfig(proxy) {
    if (!proxy) return {};
    const normalized = this.normalizeProxy(proxy);
    const protocol = this.getProxyProtocol(normalized);
    const config = {};
    if (protocol === 'socks4' || protocol === 'socks5') {
      if (SocksProxyAgent) {
        const agent = new SocksProxyAgent(normalized);
        config.httpAgent = agent;
        config.httpsAgent = agent;
      }
    } else if (protocol === 'https') {
      const agent = new HttpsProxyAgent(normalized);
      config.httpAgent = agent;
      config.httpsAgent = agent;
    } else {
      config.httpAgent = new HttpProxyAgent(normalized);
      config.httpsAgent = new HttpsProxyAgent(normalized);
    }
    return config;
  }

  // 轮询获取下一个代理
  getNextProxy() {
    if (!this.enabled || this.proxies.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
      const candidate = this.proxies[this.proxyIndex];
      const bad = this.badProxies.get(candidate);
      if (bad) {
        const ttlSec = bad.severity === 'severe' ? this.badProxyTTLSevere : this.badProxyTTL;
        if (now - bad.ts < ttlSec * 1000) continue;
      }
      const uses = this.usedCount.get(candidate) || 0;
      if (uses >= this.maxUsesPerProxy) {
        this.usedCount.set(candidate, 0);
        continue;
      }
      this.usedCount.set(candidate, uses + 1);
      return candidate;
    }
    // 全坏了，清除坏代理
    this.badProxies.clear();
    return this.proxies[0] || null;
  }

  markBad(proxy, severe = false) {
    if (proxy) this.badProxies.set(proxy, { ts: Date.now(), severity: severe ? 'severe' : 'normal' });
  }

  markGood(proxy) {
    if (proxy && this.badProxies.has(proxy)) this.badProxies.delete(proxy);
  }

  // ============ 13源免费代理池（与1688方案一致）============
  async refreshProxies(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRefreshTime < this.refreshInterval * 1000) return;
    if (this.refreshing) return;
    this.refreshing = true;

    const sources = [
      // 1. 快代理 - 免费高匿
      async () => { try {
        const r = await axios.get('https://www.kuaidaili.com/free/inha/1/', { timeout: 8000 });
        const ips = [];
        const reg = /<td[^>]*data-title="IP">([^<]+)<\/td>[\s\S]*?<td[^>]*data-title="PORT">([^<]+)<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return ips.slice(0, 10);
      } catch (e) { return []; } },
      // 2. 快代理 - 普通
      async () => { try {
        const r = await axios.get('https://www.kuaidaili.com/free/intr/1/', { timeout: 8000 });
        const ips = [];
        const reg = /<td[^>]*data-title="IP">([^<]+)<\/td>[\s\S]*?<td[^>]*data-title="PORT">([^<]+)<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return ips.slice(0, 10);
      } catch (e) { return []; } },
      // 3. 66代理
      async () => { try {
        const r = await axios.get('http://www.66ip.cn/mo.php?tqsl=50', { timeout: 8000 });
        const ips = r.data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/g) || [];
        return ips.slice(0, 15).map(p => `http://${p}`);
      } catch (e) { return []; } },
      // 4. 89代理
      async () => { try {
        const r = await axios.get('https://www.89ip.cn/index.html', { timeout: 8000 });
        const ips = [];
        const reg = /<td[^>]*>\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*<\/td>[\s\S]*?<td[^>]*>\s*(\d{1,5})\s*<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return ips.slice(0, 15);
      } catch (e) { return []; } },
      // 5. ProxyList - 免费高匿
      async () => { try {
        const r = await axios.get('https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc', { timeout: 10000 });
        return (r.data.data || []).map(p => `${p.protocols[0]}://${p.ip}:${p.port}`);
      } catch (e) { return []; } },
      // 6. FreeProxyList
      async () => { try {
        const r = await axios.get('https://free-proxy-list.net/', { timeout: 10000 });
        const ips = [];
        const reg = /<tr><td>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<\/td><td>(\d{1,5})<\/td>.*?<td[^>]*>(yes|no)<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) {
          ips.push(m[3] === 'yes' ? `https://${m[1]}:${m[2]}` : `http://${m[1]}:${m[2]}`);
        }
        return ips.slice(0, 30);
      } catch (e) { return []; } },
      // 7. 站大爷
      async () => { try {
        const r = await axios.get('https://proxy.seofangfa.com/', { timeout: 8000 });
        const ips = r.data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/g) || [];
        return ips.slice(0, 20).map(p => `http://${p}`);
      } catch (e) { return []; } },
      // 8. ProxyScrape
      async () => { try {
        const r = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all', { timeout: 10000 });
        const ips = r.data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/g) || [];
        return ips.slice(0, 50).map(p => `http://${p}`);
      } catch (e) { return []; } },
      // 9. OpenProxyList
      async () => { try {
        const r = await axios.get('https://openproxylist.xyz/http.txt', { timeout: 10000 });
        const ips = r.data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/g) || [];
        return ips.slice(0, 30).map(p => `http://${p}`);
      } catch (e) { return []; } },
      // 10. SocksProxy SOCKS列表
      async () => { try {
        const r = await axios.get('https://www.socks-proxy.net/', { timeout: 10000 });
        const ips = [];
        const reg = /<tr><td>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<\/td><td>(\d{1,5})<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`socks4://${m[1]}:${m[2]}`);
        return ips.slice(0, 20);
      } catch (e) { return []; } },
      // 11. HideMy.name
      async () => { try {
        const r = await axios.get('https://hidemy.name/en/proxy-list/', { timeout: 10000 });
        const ips = [];
        const reg = /<td>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<\/td><td>(\d{1,5})<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return ips.slice(0, 15);
      } catch (e) { return []; } },
      // 12. ProxyDB
      async () => { try {
        const r = await axios.get('https://proxydb.net/?protocol=http&protocol=https&anonlvl=2&anonlvl=3&anonlvl=4&country=', { timeout: 10000 });
        const ips = [];
        const reg = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return [...new Set(ips)].slice(0, 20);
      } catch (e) { return []; } },
      // 13. IPRoyal
      async () => { try {
        const r = await axios.get('https://iproyal.com/free-proxy-list/', { timeout: 10000 });
        const ips = [];
        const reg = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<[^>]*>\s*<[^>]*>(\d{1,5})<\/td>/g;
        let m; while ((m = reg.exec(r.data)) !== null) ips.push(`http://${m[1]}:${m[2]}`);
        return ips.slice(0, 20);
      } catch (e) { return []; } },
    ];

    try {
      console.log('[Proxy] 开始刷新代理池，源数:', sources.length);
      const results = await Promise.allSettled(sources.map(s => s()));
      let all = [];
      results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
      all = [...new Set(all)]; // 去重
      // 策略：跳过预验证，直接使用获取到的代理列表
      // 验证交给实际请求中的 markBad() 来处理，大幅缩短初始化时间
      const validProxies = [...this.knownGoodProxies];
      if (all.length > 0) {
        // 最多保留100个代理
        validProxies.push(...all.slice(0, 100));
      }
      const final = [...new Set(validProxies)].filter(Boolean);
      if (final.length > 0) {
        this.proxies = final;
        this.usedCount.clear();
        this.proxyIndex = 0;
        console.log('[Proxy] 代理池刷新完成，可用代理数:', final.length, '(含预验证0，实际请求中验证)');
      } else {
        console.warn('[Proxy] 本次无有效代理，使用现有代理继续尝试');
      }
      this.lastRefreshTime = now;
    } catch (e) {
      console.warn('[Proxy] 代理池刷新异常:', e.message);
    } finally {
      this.refreshing = false;
    }
  }

  // 启动自动刷新
  startAutoRefresh() {
    if (this.autoRefreshTimer) return;
    this.autoRefreshTimer = setInterval(async () => {
      try { await this.refreshProxies(false); } catch (e) { /* ignore */ }
    }, this.autoRefreshIntervalMs);
  }
}

const instance = new ProxyManager();
module.exports = instance;
