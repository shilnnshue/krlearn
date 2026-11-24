// 语法栏目交互回归：筛选、搜索、无匹配提示、详情导航、返回后状态保持、例句音频。
// 用法：node tools/check_grammar.js（需要本地服务跑在 8765）
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8765/index.html';

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)));
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      // 过注册闸门：写一个本机会话（token=local → 不连云端）
      try { win.localStorage.setItem('krlearn.sess', JSON.stringify({ u: 'selftest', token: 'local', created: Date.now() })); } catch (e) {}
      win.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function () {};
      win.HTMLMediaElement.prototype.load = function () {};
      win.matchMedia = () => ({
        matches: false, media: '', addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, onchange: null,
      });
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollTo = function () {};
    },
  });
  const win = dom.window, doc = win.document;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (/全库\s*\d+\s*词/.test((doc.querySelector('#view') || {}).textContent || '')) break;
    await wait(120);
  }

  const nav = async h => {
    win.location.hash = '#' + h;
    win.dispatchEvent(new win.Event('hashchange'));
    await wait(320);
  };
  const vis = () => [...doc.querySelectorAll('#g-list .g-item')]
    .filter(e => e.style.display !== 'none');
  const forms = arr => arr.map(e => e.querySelector('.g-form').textContent);
  const none = () => { const n = doc.querySelector('#g-none'); return n ? !n.hidden : null; };

  await nav('grammar');
  console.log('列表初始：', vis().length, '条 / 无匹配提示：', none());

  const s = doc.querySelector('#g-search');
  s.value = '想要';
  s.dispatchEvent(new win.Event('input'));
  console.log('搜「想要」：', vis().length, '条 ->', forms(vis()).join(' | '));

  s.value = '고 싶다';
  s.dispatchEvent(new win.Event('input'));
  console.log('搜「고 싶다」：', vis().length, '条 ->', forms(vis()).join(' | '));

  s.value = 'zzzz';
  s.dispatchEvent(new win.Event('input'));
  console.log('搜「zzzz」：', vis().length, '条 / 无匹配提示：', none());

  s.value = '';
  s.dispatchEvent(new win.Event('input'));
  doc.querySelector('[data-gf="中级"]').click();
  await wait(120);
  console.log('筛「中级」：', vis().length, '条 / 胶囊高亮：',
    doc.querySelector('.chip.on').textContent.trim());

  s.value = '即使';
  s.dispatchEvent(new win.Event('input'));
  console.log('中级 + 搜「即使」：', vis().length, '条 ->', forms(vis()).join(' | '));

  // 点第一条进详情
  vis()[0].click();
  await wait(360);
  console.log('详情页标题：', (doc.querySelector('#tb-title') || {}).textContent);
  console.log('  形态：', (doc.querySelector('.g-form-xl') || {}).textContent,
    '/ 接续：', (doc.querySelector('.kv-v') || {}).textContent);
  const boxes = [...doc.querySelectorAll('.g-card .ex-item')];
  console.log('  例句数：', boxes.length, '/ 带音频地址：',
    boxes.filter(b => b.dataset.play).length);
  console.log('  上一条按钮：', doc.querySelector('.g-nav .btn') ?
    doc.querySelector('.g-nav .btn').textContent.trim() : '(无)');

  // ---- 例句音频断言 ----
  let bad = 0;
  const urlsG = boxes.map(b => b.dataset.play || '');
  urlsG.forEach((u, i) => {
    if (!/^audio\/grammar\/ex\/g\d{3}_\d\.mp3$/.test(u)) { bad++; console.log('    ✗ 地址异常：' + JSON.stringify(u)); }
    else if (!fs.existsSync(path.join(ROOT, u))) { bad++; console.log('    ✗ 文件不存在：' + u); }
  });
  if (urlsG.length !== 3) { bad++; console.log('    ✗ 例句音频条数应为 3，实际 ' + urlsG.length); }
  console.log('  地址与文件：', bad ? bad + ' 处异常' : '全部正常');

  // 点整条框（不点喇叭），验证真的走到播放器并高亮
  boxes[0].click();
  await wait(80);
  const au = win.__krAudio ? win.__krAudio() : null;
  console.log('  点框后：src =', au && au.src, '/ 高亮块 =', au && au.playing);
  if (!au || !/_1\.mp3$/.test(au.src || '')) { bad++; console.log('    ✗ 点框没有触发第一条音频'); }
  if (!au || au.playing !== 1) { bad++; console.log('    ✗ 高亮块数量应为 1'); }

  console.log('  → 音频断言：', bad ? ('FAIL（' + bad + ' 项）') : 'PASS');

  // 返回列表，筛选是否保持
  doc.querySelector('#btn-back').click();
  await wait(320);
  console.log('返回后：可见', vis().length, '条 / 胶囊', doc.querySelector('.chip.on').textContent.trim(),
    '/ 搜索框值「' + (doc.querySelector('#g-search') || {}).value + '」');

  console.log('\nJS 错误：', errs.length ? errs.slice(0, 3) : '无');
  const ok = !errs.length && !bad;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL');
  dom.window.close();
  process.exit(ok ? 0 : 1);
})();
