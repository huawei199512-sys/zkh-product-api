// ============================================================
// 震坤行 ZKH API 综合测试报告脚本
// 强制代理模式 · 关键字搜索 + 随机5个详情 · 输出 JSON + TXT
// ============================================================
// 用法: node test-report.js [关键词]
// 默认关键词：手套
// ============================================================
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const KEYWORD = process.argv[2] || '手套';
const DETAIL_TIMEOUT = 120000;
const SEARCH_TIMEOUT = 120000;
const REPORT_DIR = __dirname;

const report = {
  meta: {
    title: '震坤行 ZKH Product API 测试报告',
    generated_at: new Date().toISOString(),
    base_url: BASE,
    keyword: KEYWORD,
    force_proxy_mode: true,
    strategy: '3代理并发竞态 × 最多8轮，单代理10s切换 / 单请求30s截止',
  },
  proxy: { status_before: null, status_after: null },
  search: { success: false, data: null, duration_ms: 0, error: null, rounds: null, sampled_skus: [] },
  details: [],
  summary: {
    total: 6, // 1搜索 + 5详情
    passed: 0,
    failed: 0,
    detail_pass_count: 0,
    detail_fail_count: 0,
    avg_search_ms: 0,
    avg_detail_ms: 0,
    proxies_used: new Set(),
    error_codes: {},
  },
};

function bumpError(code) {
  if (!code) return;
  const key = String(code).slice(0, 40);
  report.summary.error_codes[key] = (report.summary.error_codes[key] || 0) + 1;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest(label, fn, timeoutMs) {
  const t0 = Date.now();
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) {
      console.error(`[TIMEOUT] ${label} 超出 ${timeoutMs}ms`);
    }
  }, timeoutMs + 1000);
  try {
    const r = await fn();
    finished = true;
    clearTimeout(timer);
    return { ok: true, result: r, duration_ms: Date.now() - t0 };
  } catch (e) {
    finished = true;
    clearTimeout(timer);
    const msg = e.response?.data?.error || e.code || e.message || 'unknown';
    return { ok: false, result: null, duration_ms: Date.now() - t0, error: msg, code: e.code || null, httpStatus: e.response?.status || null };
  }
}

function pickRandom(arr, n) {
  if (!arr || !arr.length) return [];
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function waitServerReady(maxRetries = 30, intervalMs = 2000) {
  console.log(`[BOOT] 等待服务就绪: ${BASE}/health (最多 ${Math.ceil(maxRetries * intervalMs / 1000)} 秒)`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await axios.get(BASE + '/health', { timeout: 3000 });
      if (r.data && r.data.status === 'ok') {
        console.log(`[BOOT] 服务就绪 ✓ (尝试${i + 1}次)`);
        return true;
      }
    } catch {}
    await sleep(intervalMs);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return false;
}

function saveReports() {
  // 规范化 Set → Array
  report.summary.proxies_used = Array.from(report.summary.proxies_used);
  const stamp = report.meta.generated_at.replace(/[:.]/g, '-');
  const jsonPath = path.join(REPORT_DIR, `test-report-${stamp}.json`);
  const txtPath = path.join(REPORT_DIR, `test-report-${stamp}.txt`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(txtPath, renderTextReport(), 'utf8');
  report.meta.report_json_path = jsonPath;
  report.meta.report_txt_path = txtPath;
  console.log(`[REPORT] JSON报告已保存: ${jsonPath}`);
  console.log(`[REPORT] TXT报告已保存:  ${txtPath}`);
  return { jsonPath, txtPath };
}

function renderTextReport() {
  const s = report.summary;
  const m = report.meta;
  const p = report.proxy;
  const lines = [];
  lines.push('='.repeat(78));
  lines.push(`  ${m.title}`);
  lines.push('='.repeat(78));
  lines.push(`  生成时间   : ${m.generated_at}`);
  lines.push(`  目标服务   : ${m.base_url}`);
  lines.push(`  测试关键词 : ${m.keyword}`);
  lines.push(`  代理模式   : 强制免费代理（${m.strategy}）`);
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  一、代理池状态');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (p.status_before) {
    lines.push(`  测试前：代理总数=${p.status_before.proxy_count}（HTTP=${p.status_before.http_count} / SOCKS=${p.status_before.socks_count}），坏代理=${p.status_before.bad_proxy_count}，上次刷新=${p.status_before.last_refresh}`);
  }
  if (p.status_after) {
    lines.push(`  测试后：代理总数=${p.status_after.proxy_count}（HTTP=${p.status_after.http_count} / SOCKS=${p.status_after.socks_count}），坏代理=${p.status_after.bad_proxy_count}，上次刷新=${p.status_after.last_refresh}`);
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  二、关键字搜索测试');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const sr = report.search;
  lines.push(`  关键词        : ${m.keyword}`);
  lines.push(`  结果          : ${sr.success ? '✓ 通过' : '✗ 失败'}`);
  lines.push(`  耗时          : ${sr.duration_ms} ms`);
  if (sr.rounds != null) lines.push(`  实际轮次      : ${sr.rounds}`);
  if (sr.error) lines.push(`  错误信息      : ${sr.error}`);
  if (sr.data) {
    lines.push(`  返回商品总数  : ${sr.data.total || 0}`);
    lines.push(`  当前页商品数  : ${sr.data.products?.length || 0}`);
    lines.push(`  总页数        : ${sr.data.total_pages || 0}`);
    if (sr.data.products && sr.data.products.length) {
      lines.push('');
      lines.push('  前3条样例:');
      sr.data.products.slice(0, 3).forEach((p, i) => {
        lines.push(`    [${i + 1}] SKU=${p.sku_no || '-'}  价格=${p.price || '-'}  标题=${(p.title || '').slice(0, 60)}`);
      });
    }
    if (sr.sampled_skus && sr.sampled_skus.length) {
      lines.push('');
      lines.push(`  抽取用于详情测试的${sr.sampled_skus.length}个SKU: ${sr.sampled_skus.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  三、随机商品详情测试（5个）');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.details.forEach((d, idx) => {
    lines.push(`  ┌─ [${idx + 1}] SKU: ${d.sku_no}${d.title ? `  → ${(d.title || '').slice(0, 50)}` : ''}`);
    lines.push(`  │ 结果       : ${d.success ? '✓ 通过' : '✗ 失败'}`);
    lines.push(`  │ 耗时       : ${d.duration_ms} ms`);
    if (d.rounds != null) lines.push(`  │ 实际轮次   : ${d.rounds}`);
    if (d.proxy_used) lines.push(`  │ 所用代理   : ${d.proxy_used}`);
    if (d.error) lines.push(`  │ 错误信息   : ${d.error}`);
    if (d.success && d.detail) {
      const dt = d.detail;
      lines.push(`  │ 品牌/型号  : ${dt.brand || '-'} / ${dt.model || '-'}`);
      lines.push(`  │ 包装规格   : ${dt.package_spec || '-'}`);
      lines.push(`  │ 价格/含税  : ${dt.price || '-'} 元  不含税: ${dt.untaxed_price || '-'}  税率: ${dt.tax_rate || '-'}`);
      lines.push(`  │ 起订量/包装: ${dt.min_order || '-'} / ${dt.min_package || '-'}`);
      lines.push(`  │ 图片数     : ${(dt.images || []).length}   主图: ${(dt.main_image || '').slice(0, 80)}${dt.main_image && dt.main_image.length > 80 ? '…' : ''}`);
      lines.push(`  │ 规格参数项 : ${Object.keys(dt.specs || {}).length} 项`);
      lines.push(`  │ 标签/促销  : tags=${(dt.tags || []).length}  promotions=${(dt.promotions || []).length}`);
      lines.push(`  │ 关联商品   : related=${(dt.related_products || []).length}  replace=${(dt.replace_products || []).length}  combo=${(dt.combination_products || []).length}`);
    }
    lines.push('  └' + '─'.repeat(74));
  });
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  四、总体汇总');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`  总用例数      : ${s.total}（1搜索 + 5详情）`);
  lines.push(`  ✓ 通过数       : ${s.passed}`);
  lines.push(`  ✗ 失败数       : ${s.failed}`);
  lines.push(`  详情通过率     : 搜索${report.search.success ? '✓' : '✗'}  +  详情 ${s.detail_pass_count}/5 = ${(s.detail_pass_count / 5 * 100).toFixed(0)}%`);
  lines.push(`  搜索耗时       : ${report.search.duration_ms} ms   平均详情耗时: ${s.avg_detail_ms ? s.avg_detail_ms + ' ms' : '-'}`);
  lines.push(`  使用过的代理   : ${s.proxies_used.length} 个  →  ${(s.proxies_used || []).slice(0, 10).join(' | ')}${(s.proxies_used || []).length > 10 ? ' ...' : ''}`);
  const codes = Object.entries(s.error_codes);
  if (codes.length) {
    lines.push('  错误分布       : ');
    codes.forEach(([k, v]) => lines.push(`      ${k.padEnd(40)} × ${v}`));
  }
  lines.push('');
  lines.push('='.repeat(78));
  const verdict = (s.passed === s.total)
    ? '  全部通过 ✓ 可部署 Render 分享给朋友测试'
    : `  通过率 ${Math.round(s.passed / s.total * 100)}%（${s.passed}/${s.total}）`;
  lines.push(verdict);
  lines.push('='.repeat(78));
  return lines.join('\n');
}

(async () => {
  console.log('='.repeat(70));
  console.log(`  ZKH 强制代理模式测试 - 关键词: ${KEYWORD}`);
  console.log('='.repeat(70));

  // 1. 等待服务就绪
  const ready = await waitServerReady();
  if (!ready) {
    console.error('[FATAL] 服务未启动，无法开始测试。请先运行: npm start');
    console.error('        或运行 start-server.cmd （项目根目录下）');
    process.exit(2);
  }

  // 2. 记录代理池状态（测试前）
  try {
    report.proxy.status_before = (await axios.get(BASE + '/api/proxy/status', { timeout: 5000 })).data;
  } catch (e) {
    report.proxy.status_before = { error: e.code || e.message };
  }
  console.log(`[PROXY] 测试前: 代理池大小=${report.proxy.status_before?.proxy_count ?? 'N/A'}`);

  // 3. 如代理池为空，先手动刷新一次（强制代理模式下必须有代理）
  if (!report.proxy.status_before || report.proxy.status_before.proxy_count === 0) {
    console.log('[PROXY] 代理池为空，后台已在初始化，先触发一次强制刷新…');
    try {
      await axios.post(BASE + '/api/proxy/refresh', null, { timeout: 120000 });
      const aft = (await axios.get(BASE + '/api/proxy/status', { timeout: 5000 })).data;
      report.proxy.status_before = aft;
      console.log(`[PROXY] 刷新后: 可用代理=${aft.proxy_count}  已知优质=${aft.known_good_count}`);
    } catch (e) {
      console.warn('[PROXY] 刷新失败（可能代理源本身不可达），继续用当前池测试：', e.code || e.message);
    }
  }

  // 4. 关键字搜索
  console.log(`\n[SEARCH] 开始: 关键词="${KEYWORD}" pageSize=20 (超时${SEARCH_TIMEOUT / 1000}s, 强制代理)`);
  const searchRes = await runTest('搜索', () => axios.get(BASE + '/api/search', {
    params: { q: KEYWORD, page: 1, pageSize: 20 }, timeout: SEARCH_TIMEOUT,
  }), SEARCH_TIMEOUT);
  if (searchRes.ok && searchRes.result.data) {
    const body = searchRes.result.data;
    report.search = {
      success: !!body.success,
      data: body.success ? { total: body.total, products: body.products, total_pages: body.total_pages } : null,
      duration_ms: searchRes.duration_ms,
      error: body.error || null,
      rounds: body.rounds || null,
      sampled_skus: [],
    };
  } else {
    report.search = {
      success: false, data: null, duration_ms: searchRes.duration_ms,
      error: searchRes.error, rounds: null, sampled_skus: [],
    };
    bumpError(searchRes.code || searchRes.error);
  }
  report.summary.avg_search_ms = report.search.duration_ms;
  if (report.search.success) report.summary.passed++; else report.summary.failed++;
  console.log(`[SEARCH] ${report.search.success ? '✓' : '✗'}  耗时 ${report.search.duration_ms}ms  返回=${report.search.data?.products?.length ?? 0}条  ${report.search.error ? '错误=' + report.search.error : ''}`);

  // 5. 抽取5个SKU（搜索失败时，使用震坤行真实SKU作为兜底）
  let skus = [];
  if (report.search.data && report.search.data.products && report.search.data.products.length) {
    const valid = report.search.data.products.filter(p => p.sku_no && String(p.sku_no).trim());
    skus = pickRandom(valid.map(p => String(p.sku_no).trim()), 5);
    report.search.sampled_skus = skus;
  }
  // 兜底SKU（震坤行常见商品真实编号）
  const fallbackSkus = ['KG2089', 'KG2088', 'AF00100001', 'AF00100002', 'AF00301673', '201524', '20000059', 'E97837', 'MCH160G', 'MCH060G'];
  while (skus.length < 5) {
    const add = pickRandom(fallbackSkus.filter(f => !skus.includes(f)), 1)[0];
    if (!add) break;
    skus.push(add);
  }
  if (skus.length < 5) {
    // 最后兜底：用重复填充
    while (skus.length < 5) skus.push(fallbackSkus[skus.length % fallbackSkus.length]);
  }
  console.log(`[DETAIL] 抽取的5个SKU: ${skus.join(', ')}`);

  // 6. 逐个运行详情测试（强制代理）
  let detailTotalMs = 0;
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    console.log(`\n[DETAIL ${i + 1}/5] SKU=${sku}  (超时${DETAIL_TIMEOUT / 1000}s, 强制代理)`);
    const r = await runTest(`详情-${sku}`, () => axios.get(BASE + '/api/detail/' + encodeURIComponent(sku), { timeout: DETAIL_TIMEOUT }), DETAIL_TIMEOUT);
    const entry = { sku_no: sku, duration_ms: r.duration_ms, rounds: null, proxy_used: null };
    if (r.ok && r.result.data) {
      const body = r.result.data;
      entry.success = !!body.success;
      entry.detail = body.success ? {
        title: body.title, brand: body.brand, model: body.model,
        package_spec: body.package_spec, price: body.price, untaxed_price: body.untaxed_price,
        tax_rate: body.tax_rate, min_order: body.min_order, min_package: body.min_package,
        main_image: body.main_image, images: body.images, specs: body.specs, tags: body.tags,
        promotions: body.promotions, related_products: body.related_products,
        replace_products: body.replace_products, combination_products: body.combination_products,
      } : null;
      entry.title = body.title || null;
      entry.rounds = body.rounds || null;
      entry.error = body.error || null;
    } else {
      entry.success = false;
      entry.error = r.error;
      bumpError(r.code || r.error);
    }
    if (entry.success) {
      report.summary.detail_pass_count++;
      report.summary.passed++;
    } else {
      report.summary.detail_fail_count++;
      report.summary.failed++;
    }
    detailTotalMs += entry.duration_ms;
    report.details.push(entry);
    console.log(`[DETAIL ${i + 1}/5] ${entry.success ? '✓' : '✗'}  耗时 ${entry.duration_ms}ms  ${entry.title ? '标题=' + entry.title.slice(0, 50) : ''}  ${entry.error ? '错误=' + entry.error : ''}`);
  }
  report.summary.avg_detail_ms = report.details.length ? Math.round(detailTotalMs / report.details.length) : 0;

  // 7. 代理池状态（测试后）
  try {
    report.proxy.status_after = (await axios.get(BASE + '/api/proxy/status', { timeout: 5000 })).data;
  } catch (e) {
    report.proxy.status_after = { error: e.code || e.message };
  }

  // 8. 保存报告
  const paths = saveReports();

  // 9. 输出文本报告摘要到控制台
  console.log('\n');
  console.log(renderTextReport());
  process.exit(report.summary.passed === report.summary.total ? 0 : 1);
})().catch(e => {
  console.error('[RUNTIME FATAL]', e);
  try { saveReports(); } catch {}
  process.exit(99);
});
