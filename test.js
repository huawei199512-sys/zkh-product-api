// 震坤行API - 本地端到端测试脚本
// 用法: node test.js
const axios = require('axios');
const BASE = process.env.BASE_URL || 'http://localhost:8000';

async function test(label, fn) {
  console.log('\n=== ' + label + ' ===');
  const t0 = Date.now();
  try {
    const r = await fn();
    const dt = Date.now() - t0;
    console.log(`[OK] 耗时 ${dt}ms`, JSON.stringify(r).slice(0, 500));
    return true;
  } catch (e) {
    console.log(`[FAIL] 耗时 ${Date.now() - t0}ms 错误: ${e.message}`);
    return false;
  }
}

(async () => {
  let pass = 0, total = 0;
  total++;
  if (await test('健康检查', () => axios.get(BASE + '/health').then(r => r.data))) pass++;

  total++;
  if (await test('代理状态', () => axios.get(BASE + '/api/proxy/status').then(r => r.data))) pass++;

  total++;
  if (await test('手动刷新代理池', () => axios.post(BASE + '/api/proxy/refresh').then(r => r.data))) pass++;

  total++;
  if (await test('搜索:手套 page=1', () => axios.get(BASE + '/api/search', { params: { q: '手套', page: 1, pageSize: 10 }, timeout: 120000 }).then(r => r.data))) pass++;

  total++;
  if (await test('搜索:A4纸', () => axios.get(BASE + '/api/search', { params: { q: 'A4纸', pageSize: 10 }, timeout: 120000 }).then(r => r.data))) pass++;

  total++;
  if (await test('详情:KG2089 (手套)', () => axios.get(BASE + '/api/detail/KG2089', { timeout: 120000 }).then(r => r.data))) pass++;

  console.log('\n========================================');
  console.log(`测试完成: ${pass}/${total} 用例通过`);
  console.log('========================================');
  process.exit(pass === total ? 0 : 1);
})();
