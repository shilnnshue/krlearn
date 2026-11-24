// 朗读兜底回归：mp3 取不到时用 speechSynthesis 顶上，且不该念的时候绝不念。
// 用法：node tools/check_tts.js（需要本地服务跑在 8765）
//
// jsdom 里既没有 <audio> 解码也没有 speechSynthesis，所以两个都 mock：
//   - HTMLMediaElement.play() 按场景返回 rejected promise
//   - speechSynthesis 只记录被念了什么（不真的发声）
// 这样验的是「我们的判断逻辑」，而不是浏览器能不能出声。
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://127.0.0.1:8765/index.html';

let bad = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label + (extra === undefined ? '' : '：' + extra));
  else { bad++; console.log('  ✗ ' + label + (extra === undefined ? '' : '：' + extra)); }
};

// 每个场景单独开一个页面：play() 的行为要在 beforeParse 里定死
async function open(playImpl) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)));
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      // 过注册闸门：写一个本机会话（token=local → 不连云端）
      try { win.localStorage.setItem('krlearn.sess', JSON.stringify({ u: 'selftest', token: 'local', created: Date.now() })); } catch (e) {}
      win.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      win.HTMLMediaElement.prototype.play = playImpl;
      win.HTMLMediaElement.prototype.pause = function () {};
      win.HTMLMediaElement.prototype.load = function () {};
      win.matchMedia = () => ({
        matches: false, media: '', addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, onchange: null,
      });
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollTo = function () {};

      // 假的 speechSynthesis：只记账
      win.__spoke = [];
      win.__cancelled = 0;
      win.SpeechSynthesisUtterance = class {
        constructor(text) { this.text = text; }
      };
      win.speechSynthesis = {
        speaking: false,
        getVoices: () => [{ lang: 'ko-KR', name: 'Mock Korean' }],
        speak(u) { win.__spoke.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice && u.voice.name }); },
        cancel() { win.__cancelled++; },
      };
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
    await wait(340);
  };
  return { dom, win, doc, wait, nav, errs };
}

(async () => {
  // ---------- 场景 A：音频 404（NotSupportedError）→ 应该兜底 ----------
  console.log('\n【A】mp3 取不到 → 浏览器朗读顶上');
  {
    const { dom, win, doc, wait, nav, errs } = await open(
      () => Promise.reject(Object.assign(new Error('no src'), { name: 'NotSupportedError' })));
    await nav('entry/w0146');
    const btn = doc.querySelector('.spk[data-play]');
    ok(!!btn, '词条页有喇叭按钮');
    ok(!!(btn && btn.dataset.saytext), '喇叭上带「该念什么」的文本', btn && btn.dataset.saytext);
    const before = win.__spoke.length;
    btn.click();
    await wait(120);
    ok(win.__spoke.length === before + 1, '缺失音频时念了 1 条',
      win.__spoke.length ? '「' + win.__spoke[0].text + '」' : '没念');
    if (win.__spoke.length) {
      const s = win.__spoke[0];
      ok(s.lang === 'ko-KR', '语言标的是 ko-KR', s.lang);
      ok(s.rate < 1, '语速与 edge-tts 的 -10% 对齐', s.rate);
      ok(s.voice === 'Mock Korean', '选到了韩语语音', String(s.voice));
    }
    ok(errs.length === 0, 'JS 错误', errs.length ? errs.slice(0, 2) : '无');
    dom.window.close();
  }

  // ---------- 场景 B：自动播放被拦（NotAllowedError）→ 不能念 ----------
  console.log('\n【B】自动播放被浏览器拦住 → 不许拿朗读代替');
  {
    const { dom, win, doc, wait, nav } = await open(
      () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
    await nav('entry/w0146');
    doc.querySelector('.spk[data-play]').click();
    await wait(120);
    ok(win.__spoke.length === 0, '没有误念', '念了 ' + win.__spoke.length + ' 条');
    dom.window.close();
  }

  // ---------- 场景 C：关掉开关 → 不念 ----------
  console.log('\n【C】设置里关掉「缺音频时朗读」→ 不念');
  {
    const { dom, win, doc, wait, nav } = await open(
      () => Promise.reject(Object.assign(new Error('no src'), { name: 'NotSupportedError' })));
    await nav('settings');
    const tg = doc.querySelector('[data-tg="ttsFallback"]');
    ok(!!tg, '设置页有「缺音频时朗读」开关');
    ok(tg.classList.contains('on'), '默认是开启的');
    tg.click();
    await wait(40);
    ok(!tg.classList.contains('on'), '点一下变成关闭');

    await nav('entry/w0146');
    doc.querySelector('.spk[data-play]').click();
    await wait(120);
    ok(win.__spoke.length === 0, '关掉后不再朗读', '念了 ' + win.__spoke.length + ' 条');
    dom.window.close();
  }

  // ---------- 场景 D：音频正常 → 一律走 mp3，不碰朗读 ----------
  console.log('\n【D】音频正常 → 只用 mp3');
  {
    const { dom, win, doc, wait, nav } = await open(() => Promise.resolve());
    await nav('entry/w0146');
    doc.querySelector('.spk[data-play]').click();
    await wait(120);
    ok(win.__spoke.length === 0, '有音频时不触发朗读', '念了 ' + win.__spoke.length + ' 条');
    dom.window.close();
  }

  console.log('\n' + (bad ? 'RESULT: FAIL（' + bad + ' 项）' : 'RESULT: PASS'));
  process.exit(bad ? 1 : 0);
})();
