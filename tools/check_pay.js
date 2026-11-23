// 赞赏页回归：路由能进、两个收款码位置正确、图缺失时整块降级。
// 用法：node tools/check_pay.js（需要本地服务跑在 8765）
//
// 说明：jsdom 不解码图片，load/error 不一定自己触发，所以这里手动派发事件，
// 直接验证 bindView 里的降级逻辑本身，结果才是确定的。
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8765/index.html';

let bad = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label + (extra === undefined ? '' : '：' + extra));
  else { bad++; console.log('  ✗ ' + label + (extra === undefined ? '' : '：' + extra)); }
};

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)));
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
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

  await nav('support');
  console.log('标题：', (doc.querySelector('#tb-title') || {}).textContent);
  ok((doc.querySelector('#tb-title') || {}).textContent === '赞赏', '路由与标题');

  const boxes = [...doc.querySelectorAll('[data-pay]')];
  ok(boxes.length === 2, '收款码位数量', boxes.length + ' 个');
  const srcs = boxes.map(b => b.querySelector('img').getAttribute('src'));
  console.log('  图片地址：', srcs.join(' | '));
  ok(srcs[0] === 'assets/pay/wechat.png' && srcs[1] === 'assets/pay/alipay.png', '图片路径约定');

  const onDisk = srcs.map(s => fs.existsSync(path.join(ROOT, s)));
  console.log('  磁盘上是否存在：', onDisk.map((v, i) => srcs[i].split('/').pop() + '=' + (v ? '有' : '无')).join(' '));
  ok(onDisk.every(Boolean), '两张收款码图片都已就位');
  const sizes = srcs.map(s => { try { return fs.statSync(path.join(ROOT, s)).size; } catch (e) { return 0; } });
  console.log('  文件大小：', sizes.map((n, i) => srcs[i].split('/').pop() + '=' + Math.round(n / 1024) + 'KB').join(' '));
  ok(sizes.every(n => n > 8000), '图片不是占位空文件（>8KB）');

  // 两张二维码图必须是同尺寸的等边正方形。
  // 否则 img 的 CSS 宽度一样，二维码本体在视觉上却一个大一个小（踩过一次：
  // 微信白卡留白比支付宝多，按白卡裁出来的图并排摆着明显不齐）。
  const pngSize = f => {
    const b = fs.readFileSync(path.join(ROOT, f));
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  const dims = srcs.map(pngSize);
  console.log('  像素尺寸：', dims.map((d, i) => srcs[i].split('/').pop() + '=' + d.w + '×' + d.h).join(' '));
  ok(dims.every(d => d.w === d.h), '两张码都是正方形');
  ok(dims.every(d => d.w === dims[0].w), '两张码像素尺寸相同');

  // 结构：hero 有徽标和标题，两张卡各有一个品牌胶囊 + 桌面/手机两条提示
  ok(!!doc.querySelector('.pay-hero .pay-kicker'), 'hero 有「赞赏支持」徽标');
  ok((doc.querySelectorAll('.pay-box .pay-brand').length) === 2, '两张卡都有品牌色胶囊');
  ok(doc.querySelectorAll('.pay-box .pay-hint.pc').length === 2
    && doc.querySelectorAll('.pay-box .pay-hint.mob').length === 2, '桌面/手机两套提示都在');

  // 首页与设置页都要有醒目的入口
  await nav('home');
  ok(!!doc.querySelector('#view .pay-cta[data-go="support"]'), '首页有赞赏入口');
  await nav('settings');
  ok(!!doc.querySelector('#view .pay-cta[data-go="support"]'), '设置页有赞赏入口');
  await nav('support');
  const b1 = [...doc.querySelectorAll('[data-pay]')];

  // 手动派发 error，验证降级：第一张挂掉时提示仍隐藏，两张都挂掉才提示
  const devNote = () => {
    const n = doc.querySelector('#pay-dev');
    return n ? !n.hidden : null;
  };
  ok(devNote() === false, '初始不显示「缺图」提示');

  b1[0].querySelector('img').dispatchEvent(new win.Event('error'));
  await wait(30);
  ok(b1[0].style.display === 'none', '缺图的那个盒子被隐藏');
  ok(b1[1].style.display !== 'none', '另一张不受牵连');
  ok(doc.querySelector('.pay-grid').classList.contains('single'), '只剩一张时网格转单列居中');
  ok(devNote() === false, '只缺一张时仍不提示');

  b1[1].querySelector('img').dispatchEvent(new win.Event('error'));
  await wait(30);
  ok(b1[1].style.display === 'none', '第二张也被隐藏');
  ok(devNote() === true, '两张都缺时，本机显示「该放哪儿」提示');

  // 重新进页面，这次派发 load，验证正常路径不会被误藏
  await nav('home');
  await nav('support');
  const b2 = [...doc.querySelectorAll('[data-pay]')];
  b2.forEach(b => b.querySelector('img').dispatchEvent(new win.Event('load')));
  await wait(30);
  ok(b2.every(b => b.style.display !== 'none' && b.classList.contains('ok')),
    '图片正常时两块都显示且淡入');
  ok(devNote() === false, '图片正常时不出现缺图提示');

  console.log('\nJS 错误：', errs.length ? errs.slice(0, 3) : '无');
  const pass = !errs.length && !bad;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  dom.window.close();
  process.exit(pass ? 0 : 1);
})();
