// jsdom 回归：在没有可用浏览器的机器上，直接跑页面脚本验证各视图不报错、内容正确。
// 用法：node tools/jsdom_check.js [http://127.0.0.1:8765/index.html]
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const ROUTES = [
  'home', 'alpha', 'dict', 'stats', 'settings',
  'list/wrong', 'list/due', 'list/learning', 'list/mastered',
  'note', 'sent', 'deck', 'entry/w0001', 'entry/w0316', 'entry/w5926',
];

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')));

  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      // jsdom 不自带 fetch，把 Node 的塞进去（页面用 fetch 读 data/*.json）
      win.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      win.HTMLMediaElement.prototype.pause = function () {};
      win.HTMLMediaElement.prototype.load = function () {};
      const mq = () => ({
        matches: false, media: '',
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, onchange: null,
      });
      win.matchMedia = mq;
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollTo = function () {};
      win.addEventListener('error', e => errs.push('window.onerror: ' + e.message));
    },
  });

  const win = dom.window;
  const doc = win.document;

  // 等数据加载完（app.js 是 async boot）
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (win.DATA && win.DATA.words && win.DATA.words.length) break;
    await new Promise(r => setTimeout(r, 120));
  }

  // 数据是否加载成功，只能从渲染结果反推（app.js 在 IIFE 里，外部读不到 DATA）
  const homeTxt = (doc.querySelector('#view') || {}).textContent || '';
  const m = homeTxt.match(/全库\s*(\d+)\s*词/);
  const loaded = !!m;
  console.log('数据加载:', loaded ? { words: +m[1] } : '失败');

  const pad = s => (s + '                    ').slice(0, 20);
  let problems = 0;

  for (const r of ROUTES) {
    const before = errs.length;
    win.location.hash = '#' + r;
    win.dispatchEvent(new win.Event('hashchange'));
    await new Promise(res => setTimeout(res, 260));

    const view = doc.querySelector('#view');
    const html = view ? view.innerHTML : '';
    const txt = view ? (view.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const empty = html.length < 40;
    const newErr = errs.slice(before);
    if (empty || newErr.length) problems++;
    console.log(pad(r) + ' 渲染 ' + String(html.length).padStart(6) + 'B  '
      + (empty ? '✗ 空视图' : '✓')
      + (newErr.length ? '  ✗ ' + newErr[0].slice(0, 80) : '')
      + '  | ' + txt.slice(0, 40));
  }

  // 抽查：国语院 A 级基础词本的第一个词，确认界面文本与数据一致
  win.location.hash = '#deck';
  win.dispatchEvent(new win.Event('hashchange'));
  await new Promise(r => setTimeout(r, 300));
  const deckRows = [...doc.querySelectorAll('[data-deck]')];
  console.log('词本入口:', deckRows.length, '个');
  const nikl = deckRows.find(el => (el.textContent || '').includes('国语院 A 级'));
  console.log('找到「国语院 A 级基础」:', !!nikl);

  const leaked = doc.querySelectorAll('button button').length;
  console.log('嵌套按钮（非法 HTML）:', leaked);

  console.log('---');
  console.log('错误总数:', errs.length, '| 有问题的视图:', problems);
  if (errs.length) errs.slice(0, 5).forEach(e => console.log('  ✗', e.slice(0, 160)));
  dom.window.close();
  process.exit(problems || errs.length || !loaded ? 1 : 0);
})();
