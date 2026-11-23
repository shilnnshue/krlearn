/* 한글·学 —— 识别型韩语学习应用
 * 零构建：原生 JS + ts-fsrs(UMD) + 预生成 TTS 音频
 */
(function () {
'use strict';

/* ==================== 常量 ==================== */
const SKEY = 'krlearn.v1';
const R = FSRS.Rating, ST = FSRS.State;
const F = FSRS.fsrs(FSRS.generatorParameters({
  enable_fuzz: false, enable_short_term: false, request_retention: 0.9, maximum_interval: 365
}));

const ICON = {
  spk: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/></svg>',
  chev: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  search: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
};

/* ==================== 工具 ==================== */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; } return x; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const pad2 = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const dayStr = (dt) => { const d = new Date(dt); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };

let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ==================== 存储 ==================== */
const DEFAULTS = {
  settings: { deck: 'yonsei1', theme: 'auto', accent: 'jade', newPerDay: 20, mode: 'classic', roman: true, showZh: true, autoWord: false, autoSent: false },
  progress: {}, log: {}, notes: {}, sentStar: {}, customDecks: []
};
let DB = JSON.parse(JSON.stringify(DEFAULTS));

function load() {
  try {
    const raw = localStorage.getItem(SKEY);
    if (raw) {
      const o = JSON.parse(raw);
      DB = Object.assign({}, DEFAULTS, o);
      DB.settings = Object.assign({}, DEFAULTS.settings, o.settings || {});
      ['progress', 'log', 'notes', 'sentStar'].forEach(k => { DB[k] = o[k] || {}; });
      DB.customDecks = o.customDecks || [];
    }
  } catch (e) { console.warn('load failed', e); }
}
function save() { try { localStorage.setItem(SKEY, JSON.stringify(DB)); } catch (e) { toast('存储空间不足'); } }

/* 进度迁移
   词库从 774 扩到 5926 时 word id 整体重排过。progress 是按 id 存的，
   不搬就会把「背过 5 遍的词」记到另一个词头上。策略：
   1) 每条进度都存 ko（韩文原词），以后无论 id 怎么变都能按词回查；
   2) 老存档没有 ko，就用 legacy.json（旧 id → 韩文）补。 */
function migrateIds() {
  const lm = DATA.legacy || {};
  const byKo = {};
  DATA.words.forEach(w => { if (!byKo[w.korean]) byKo[w.korean] = w.id; });
  const out = {};
  let moved = 0;
  Object.keys(DB.progress).forEach(id => {
    const p = DB.progress[id];
    const ko = p.ko || lm[id];
    if (!ko) { out[id] = p; return; }        // 自建词或查不到，原样留着
    const nid = byKo[ko] || id;
    if (nid !== id) moved++;
    out[nid] = Object.assign({}, p, { ko });
  });
  DB.progress = out;
  if (moved) { save(); console.info('[迁移] 校正 ' + moved + ' 条进度到新词条'); }
}

/* 词库总览：首页用。只看当前词本容易误判成「就这一百来个词」 */
function libStats() {
  return {
    all: DATA.words.length,
    ex: DATA.words.reduce((a, w) => a + (w.examples || []).length, 0),
    decks: allDecks().length,
  };
}

/* ==================== 数据 ==================== */
const DATA = { letters: null, words: [], decks: [], conj: {}, wordMap: {} };

function allDecks() { return [...DATA.decks, ...DB.customDecks]; }
function curDeck() { return allDecks().find(d => d.id === DB.settings.deck) || allDecks()[0]; }
function deckWords() {
  const d = curDeck(); if (!d) return [];
  return (d.words || []).map(id => DATA.wordMap[id]).filter(Boolean);
}
function word(id) { return DATA.wordMap[id]; }

/* ==================== SRS ==================== */
function emptyProg() {
  const c = FSRS.createEmptyCard(new Date());
  return {
    due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty,
    elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: c.state,
    last_review: null, mastered: false, starred: false, wrong: 0
  };
}
function progOf(id) { return DB.progress[id] || null; }

function grade(id, rating) {
  const p = DB.progress[id] || emptyProg();
  const card = {
    due: new Date(p.due), stability: p.stability, difficulty: p.difficulty,
    elapsed_days: p.elapsed_days, scheduled_days: p.scheduled_days,
    reps: p.reps, lapses: p.lapses, state: p.state,
    last_review: p.last_review ? new Date(p.last_review) : undefined
  };
  let rec;
  try { rec = F.repeat(card, new Date())[rating]; }
  catch (e) { console.warn('srs err', e); rec = null; }
  const c = rec ? rec.card : card;
  const np = Object.assign({}, p, {
    due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty,
    elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days,
    reps: c.reps, lapses: c.lapses, state: c.state,
    last_review: Date.now()
  });
  if (rating === R.Again) np.wrong = (np.wrong || 0) + 1;
  else np.wrong = Math.max(0, (np.wrong || 0) - 1);
  const wRec = DATA.wordMap[id];
  if (wRec) np.ko = wRec.korean;      // 存韩文原词，词库以后再扩也不怕 id 变
  DB.progress[id] = np;
  return np;
}

function dueWords() {
  const now = Date.now();
  return deckWords().filter(w => {
    const p = DB.progress[w.id];
    return p && !p.mastered && p.state !== ST.New && p.due <= now;
  }).sort((a, b) => DB.progress[a.id].due - DB.progress[b.id].due);
}
function freshWords() {
  return deckWords().filter(w => { const p = DB.progress[w.id]; return !p || p.state === ST.New; });
}
function todayLog() { return DB.log[todayStr()] || { new: 0, review: 0 }; }
function newRemain() {
  return Math.max(0, Math.min(DB.settings.newPerDay - (todayLog().new || 0), freshWords().length));
}
function learnedCount() {
  return deckWords().filter(w => { const p = DB.progress[w.id]; return p && p.state !== ST.New; }).length;
}
function masteredCount() {
  return deckWords().filter(w => { const p = DB.progress[w.id]; return p && p.mastered; }).length;
}
function bumpLog(kind) {
  const t = todayStr();
  DB.log[t] = DB.log[t] || { new: 0, review: 0 };
  DB.log[t][kind] = (DB.log[t][kind] || 0) + 1;
  save();
}
function intervalText(id) {
  const p = DB.progress[id];
  if (!p) return '';
  if (p.mastered) return '已掌握';
  const d = p.due - Date.now();
  if (d <= 0) return '现在到期';
  const day = Math.round(d / 86400000 * 10) / 10;
  if (day < 1) return Math.max(1, Math.round(d / 3600000)) + ' 小时后';
  return Math.round(day) + ' 天后';
}

/* ==================== 音频 ==================== */
const AU = new Audio();
AU.preload = 'auto';
let curSpkBtn = null;
let AQ = [], aqTimer = null;
function aqNext() {
  if (!AQ.length) return;
  const it = AQ.shift();
  playSrc(it.src, it.el || null);
}
function playSeq(items) { audioStop(); AQ = items.slice(); aqNext(); }
function aqStop() { AQ = []; if (aqTimer) { clearTimeout(aqTimer); aqTimer = null; } }
// 硬停：清队列 + 掐断正在响的那一条。翻页、切页、退出都必须走这个，
// 只清队列的话当前那条会一直念到结尾。
function audioStop() {
  aqStop();
  try { AU.pause(); AU.currentTime = 0; } catch (e) {}
  if (curSpkBtn) { curSpkBtn.classList.remove('playing'); curSpkBtn = null; }
  document.querySelectorAll('.sent-box.playing').forEach(el => el.classList.remove('playing'));
}
AU.addEventListener('ended', () => {
  if (curSpkBtn) { curSpkBtn.classList.remove('playing'); curSpkBtn = null; }
  if (AQ.length) { aqTimer = setTimeout(() => { aqTimer = null; aqNext(); }, 300); }
});

// 音频根路径。
//   同域部署（音频跟页面在同一域名下）→ 空字符串，走相对路径，和以前完全一样。
//   音频放 Cloudflare R2 / 别的 CDN → 在 index.html 里设 window.KR_AUDIO_BASE。
// 拆 R2 只需要改那一行配置，这里以下全是零改动。
const AUDIO_BASE = (() => {
  let b = String((typeof window !== 'undefined' && window.KR_AUDIO_BASE) || '').trim();
  if (b && !b.endsWith('/')) b += '/';
  return b;
})();
// 用户可能填到站点根 https://x.r2.dev/，也可能填到 audio 目录 https://x.r2.dev/audio/。
// 后者不要再补 audio/，否则会拼成 audio/audio/...。两种填法都给对。
const _aPre = /(^|\/)audio\/$/.test(AUDIO_BASE) ? '' : 'audio/';
const _ap = p => AUDIO_BASE + _aPre + p;

const URLS = {
  word: id => _ap('words/' + id + '.mp3'),
  sent: (id, i) => _ap('sent/' + id + (i ? '_' + i : '') + '.mp3'),
  letter: (t, i) => _ap('letters/' + t + pad2(i) + '.mp3'),
  syl: (l, v) => _ap('syl/s' + pad2(l) + pad2(v) + '.mp3'),
  conj: (id, i) => _ap('conj/' + id + '/' + pad2(i) + '.mp3'),
};
function playSrc(src, btn) {
  try {
    AU.pause(); AU.currentTime = 0; AU.src = src;
    const p = AU.play();
    if (p && p.catch) p.catch(() => { if (AU.error) toast('音频未生成或缺失'); });
    if (curSpkBtn) curSpkBtn.classList.remove('playing');
    if (btn) { btn.classList.add('playing'); curSpkBtn = btn; }
  } catch (e) { toast('无法播放'); }
}
function spk(src, size, tag) {
  const s = size || 30;
  const t = tag || 'button';
  // 放在 <button> 选项里时必须用 span —— button 不能嵌套 button，
  // 浏览器会把内层提出来，变成每个选项下面挂个孤零零的喇叭。
  const role = t === 'span' ? ' role="button"' : '';
  return '<' + t + ' class="spk" data-play="' + esc(src) + '"' + role +
    ' style="width:' + s + 'px;height:' + s + 'px">' + ICON.spk + '</' + t + '>';
}
// 调试钩子：给验收脚本读播放状态用（只读，不影响任何功能）
window.__krAudio = () => ({ paused: AU.paused, pos: +AU.currentTime.toFixed(2), queue: AQ.length,
                            src: (AU.src || '').split('/').pop(), playing: document.querySelectorAll('.playing').length });

document.addEventListener('click', e => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  e.stopPropagation();
  aqStop();                       // 手动点 = 打断自动朗读
  playSrc(b.dataset.play, b);
});

/* ==================== 状态标签 ==================== */
function statePill(w) {
  const p = DB.progress[w.id];
  if (!p || p.state === ST.New) return '<span class="pill">未学</span>';
  if (p.mastered) return '<span class="pill ok">已掌握</span>';
  if (p.due <= Date.now()) return '<span class="pill acc">待复习</span>';
  return '<span class="pill">学习中</span>';
}

/* ==================== 路由 ==================== */
let route = { name: 'home', arg: null };
const TITLES = {
  home: '한글·学', alpha: '字母与发音', dict: '词典', stats: '学习统计',
  settings: '设置', list: '列表', entry: '词条', note: '我的笔记', sent: '收藏句子', deck: '切换词本'
};
function go(name, arg, push) {
  route = { name, arg: arg || null };
  if (push !== false) { try { history.pushState(route, '', '#' + name + (arg ? '/' + encodeURIComponent(arg) : '')); } catch (e) {} }
  render();
  $('#view').parentElement.scrollTop = 0;
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
}
window.addEventListener('popstate', e => {
  if (e.state && e.state.name) { route = e.state; render(); }
  else { route = { name: 'home' }; render(); }
});
window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return;
  const [n, a] = h.split('/');
  route = { name: n || 'home', arg: a ? decodeURIComponent(a) : null };
  render();
  window.scrollTo(0, 0);
});
$('#btn-back').addEventListener('click', () => {
  if (route.name === 'home') return;
  if (route.name === 'entry') return go('dict');
  if (route.name === 'note' || route.name === 'sent' || route.name === 'deck') return go('settings');
  go('home');
});
$('#btn-theme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const i = order.indexOf(DB.settings.theme);
  DB.settings.theme = order[(i + 1) % 3];
  save(); applyTheme();
  toast({ auto: '跟随系统', light: '浅色模式', dark: '深色模式' }[DB.settings.theme]);
});

/* ==================== 主题 ==================== */
function applyTheme() {
  const s = DB.settings;
  const dark = s.theme === 'dark' || (s.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = s.accent || 'jade';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (DB.settings.theme === 'auto') applyTheme();
});

/* ==================== 渲染入口 ==================== */
function render() {
  audioStop();                       // 换页即静音，别把上一页的朗读带过来
  const v = $('#view');
  const tb = $('#topbar');
  $('#btn-back').classList.toggle('hidden', route.name === 'home');
  tb.classList.toggle('scrolled', window.scrollY > 4);

  switch (route.name) {
    case 'home': v.innerHTML = viewHome(); break;
    case 'alpha': v.innerHTML = viewAlpha(); break;
    case 'dict': v.innerHTML = route.arg ? viewEntry(route.arg) : viewDict(); break;
    case 'entry': v.innerHTML = viewEntry(route.arg); break;
    case 'stats': v.innerHTML = viewStats(); break;
    case 'settings': v.innerHTML = viewSettings(); break;
    case 'list': v.innerHTML = viewList(route.arg); break;
    case 'note': v.innerHTML = viewNotes(); break;
    case 'sent': v.innerHTML = viewSent(); break;
    case 'deck': v.innerHTML = viewDecks(); break;
    default: v.innerHTML = viewHome();
  }
  $('#tb-title').textContent = TITLES[route.name] || '한글·学';
  bindView();
}

/* ==================== 首页 ==================== */
function viewHome() {
  const d = curDeck();
  const ls = libStats();
  const total = d ? (d.words || []).length : 0;
  const learned = learnedCount();
  const due = dueWords().length;
  const nr = newRemain();
  const freshTotal = freshWords().length;

  return `
  <div class="hero">
    <div class="deck-name">${esc(d ? d.name : '未选择词本')}　·　${esc(d ? d.type : '')}</div>
    <div class="deck-prog"><b>${learned}</b><span>/ ${total} 词已学</span></div>
    <div class="lib-line">全库 <b>${ls.all}</b> 词 · ${ls.ex} 条例句 · ${ls.decks} 个词本
      <span class="lib-go" data-go="deck">换词本 ›</span></div>
  </div>

  <div class="stat2">
    <div class="s due click ${due === 0 ? 'zero' : ''}" data-act="review" data-longpress="due">
      <div class="n">${due}</div><div class="l">等待复习${due > 0 ? '（长按顺延）' : ''}</div>
    </div>
    <div class="s new click ${nr === 0 ? 'zero' : ''}" data-act="new">
      <div class="n">${nr}</div><div class="l">今日学习</div>
    </div>
  </div>

  ${freshTotal === 0 && total > 0 ? `
  <div class="deck-done">「${esc(d.name)}」${total} 词都学过了
    <span class="lib-go" data-go="deck">换下一个词本 ›</span></div>` : ''}

  <button class="btn btn-primary btn-block mainbtn" data-act="start">开始背词</button>

  <div class="quick">
    <button class="btn btn-ghost" data-act="pure">纯背模式</button>
    <button class="btn btn-ghost" data-act="quick">快速自评</button>
    <button class="btn btn-ghost" data-act="test">词汇测试</button>
  </div>

  <div class="sec-title">常用</div>
  <div class="card">
    <div class="row click" data-go="alpha"><div class="r-main"><div class="r-title">字母与发音</div><div class="r-sub">谚文 40 字母 · 音节构建器</div></div>${ICON.chev}</div>
    <div class="row click" data-go="list/starred"><div class="r-main"><div class="r-title">生词本</div><div class="r-sub">收藏的重点词</div></div><div class="r-val">${Object.keys(DB.progress).filter(k => DB.progress[k].starred).length || ''}</div>${ICON.chev}</div>
    <div class="row click" data-go="stats"><div class="r-main"><div class="r-title">数据统计</div><div class="r-sub">学习量 · 连续天数</div></div>${ICON.chev}</div>
  </div>

  <div class="sec-title">其他</div>
  <div class="card">
    <div class="row click" data-go="list/learned"><div class="r-main"><div class="r-title">已背单词</div></div><div class="r-val">${learned}</div>${ICON.chev}</div>
    <div class="row click" data-go="list/learning"><div class="r-main"><div class="r-title">在学词本</div></div><div class="r-val">${deckWords().filter(w => { const p = DB.progress[w.id]; return p && p.state !== ST.New && !p.mastered; }).length}</div>${ICON.chev}</div>
    <div class="row click" data-go="list/due"><div class="r-main"><div class="r-title">等待复习</div></div><div class="r-val">${due}</div>${ICON.chev}</div>
    <div class="row click" data-go="list/wrong"><div class="r-main"><div class="r-title">错题集</div></div><div class="r-val">${deckWords().filter(w => { const p = DB.progress[w.id]; return p && p.wrong > 0; }).length}</div>${ICON.chev}</div>
    <div class="row click" data-go="list/mastered"><div class="r-main"><div class="r-title">已掌握</div></div><div class="r-val">${masteredCount()}</div>${ICON.chev}</div>
    <div class="row click" data-go="sent"><div class="r-main"><div class="r-title">收藏句子</div></div><div class="r-val">${Object.keys(DB.sentStar).length || ''}</div>${ICON.chev}</div>
    <div class="row click" data-go="note"><div class="r-main"><div class="r-title">我的笔记</div></div><div class="r-val">${Object.keys(DB.notes).length || ''}</div>${ICON.chev}</div>
    <div class="row click" data-go="deck"><div class="r-main"><div class="r-title">切换词本</div></div><div class="r-val">${allDecks().length} 本</div>${ICON.chev}</div>
    <div class="row click" data-go="settings"><div class="r-main"><div class="r-title">用户设置</div></div>${ICON.chev}</div>
  </div>

  <div class="sec-title">词典</div>
  <div class="card">
    <div class="row click" data-go="dict"><div class="r-main"><div class="r-title">查词</div><div class="r-sub">韩文 / 中文 · 变位表 · 例句</div></div>${ICON.chev}</div>
  </div>
  `;
}

/* ==================== 学习会话 ==================== */
const Ses = { on: false, queue: [], i: 0, kind: 'new', phase: '', cur: null, quiz: null, res: null, stats: null, deck: null };

function startSession(kind) {
  const mode = DB.settings.mode;
  let q = [];
  if (kind === 'new') q = freshWords().slice(0, newRemain());
  else if (kind === 'review') q = dueWords();
  else if (kind === 'quick') q = (dueWords().length ? dueWords() : freshWords().slice(0, newRemain()));
  else if (kind === 'test') q = shuffle(deckWords()).slice(0, Math.min(10, deckWords().length));
  else if (kind === 'wrong') q = deckWords().filter(w => { const p = DB.progress[w.id]; return p && p.wrong > 0; });
  else if (kind === 'pure') {
    const f = freshWords();
    q = f.length ? f.slice(0, Math.max(newRemain(), Math.min(20, f.length)))
                 : (dueWords().length ? dueWords() : shuffle(deckWords()));
  }

  if (!q.length) {
    toast(kind === 'review' ? '当前没有到期单词' : '没有可学习的单词');
    return;
  }
  Object.assign(Ses, {
    on: true, queue: q.map(w => w.id), i: 0, kind,
    stats: { right: 0, wrong: 0, mk: mode === 'quick' && kind !== 'test' ? 'quick' : 'quiz' },
    phase: '', cur: null, quiz: null, marked: false
  });
  $('#study-wrap').style.display = 'flex';
  nextCard();
}

function endSession() {
  audioStop();
  Ses.on = false;
  $('#study-wrap').style.display = 'none';
  $('#study-wrap').innerHTML = '';
  const s = Ses.stats;
  toast(s ? ('本次 ' + (s.right + s.wrong) + ' 题　正确 ' + s.right) : '已结束');
  render();
}

function nextCard() {
  if (Ses.i >= Ses.queue.length) return showSummary();
  Ses.cur = word(Ses.queue[Ses.i]);
  Ses.quiz = null;
  const p = progOf(Ses.cur.id);
  const isNew = !p || p.state === ST.New;

  if (Ses.kind === 'test') {
    Ses.phase = 'quiz';
    Ses.quiz = makeQuiz(Ses.cur, true);
    renderStudy();
    return;
  }
  if (Ses.kind === 'pure') {
    Ses.phase = 'front';
    Ses.marked = false;
    renderStudy();
    return;
  }
  if (Ses.kind === 'quick') {
    Ses.phase = 'quick';
    renderStudy();
    return;
  }
  if (isNew && Ses.kind === 'new') {
    Ses.phase = DB.settings.mode === 'quick' ? 'quick' : 'front';
  } else {
    Ses.phase = 'quiz';
    Ses.quiz = makeQuiz(Ses.cur, false);
  }
  renderStudy();
}

function makeQuiz(w, isTest) {
  const types = ['q4k', 'q4z', 'listen'];
  if (!isTest) types.push('match');          // 连连看是复习题，模拟测试不掺
  if (DATA.conj[w.id]) types.push('conj');
  const type = pick(types);
  if (type === 'match') {
    const q = buildMatch(w);
    if (q) return q;
  }
  if (type === 'conj') {
    const q = buildConj(w);
    if (q) return q;
  }
  if (type === 'listen') {
    const q = buildQ4(w, 'listen');
    if (q) return q;
  }
  if (type === 'q4z') return buildQ4(w, 'z2k');
  return buildQ4(w, 'k2z');
}

function buildQ4(w, dir) {
  const pool = deckWords().filter(x => x.id !== w.id);
  let distract = shuffle(pool.filter(x => x.pos === w.pos)).slice(0, 3);
  if (distract.length < 3) {
    distract = distract.concat(shuffle(pool.filter(x => x.pos !== w.pos && !distract.find(d => d.id === x.id))).slice(0, 3 - distract.length));
  }
  if (distract.length < 3) return fallbackQ4(w);
  const opts = shuffle([w].concat(distract));
  return { type: 'q4', dir, word: w, opts, answerId: w.id };
}
function fallbackQ4(w) {
  // 词本太小：跨全库取干扰项
  const pool = DATA.words.filter(x => x.id !== w.id);
  const distract = shuffle(pool).slice(0, 3);
  return { type: 'q4', dir: 'k2z', word: w, opts: shuffle([w].concat(distract)), answerId: w.id };
}

function buildConj(w) {
  const cj = DATA.conj[w.id];
  if (!cj || cj.rows.length < 5) return null;
  const row = pick(cj.rows);
  const others = shuffle(cj.rows.filter(r => r.form !== row.form)).slice(0, 3);
  if (others.length < 3) return null;
  return {
    type: 'conj', word: w, row,
    opts: shuffle([row].concat(others)).map(r => ({ form: r.form, tag: r.tag })),
    answerForm: row.form
  };
}

/* 连连看：当前词 + 3 个同词性干扰词，左右两列各 4 块，全部配对完才结算 */
function buildMatch(w) {
  const pool = deckWords().filter(x => x.id !== w.id);
  let others = shuffle(pool.filter(x => x.pos === w.pos)).slice(0, 3);
  if (others.length < 3) {
    const rest = shuffle(pool.filter(x => !others.find(o => o.id === x.id)));
    others = others.concat(rest.slice(0, 3 - others.length));
  }
  if (others.length < 3) return null;
  const set = [w].concat(others);
  return {
    type: 'match', word: w, answerId: w.id,
    left: shuffle(set.map(x => ({ id: x.id, text: x.korean }))),
    right: shuffle(set.map(x => ({ id: x.id, text: x.chinese }))),
    pick: null, done: 0, miss: false
  };
}

function autoReadBack(w) {
  const st = DB.settings || {};
  if (!st.autoWord && !st.autoSent) return;
  const seq = [];
  if (st.autoWord) seq.push({ src: URLS.word(w.id), el: null });
  if (st.autoSent) {
    (w.examples || []).forEach((e, i) => {
      seq.push({ src: URLS.sent(w.id, i + 1), el: document.getElementById('sb' + i) });
    });
  }
  if (seq.length) playSeq(seq);
}

function renderStudy() {
  audioStop();
  const box = $('#study-wrap');
  const total = Ses.queue.length;
  const pct = total ? Math.round(Ses.i / total * 100) : 0;

  const canTgl = Ses.kind !== 'test' && Ses.kind !== 'pure';
  const top = `
  <div class="study-top">
    <button class="tb-btn" data-ses="close">${ICON.close}</button>
    <div class="prog"><div class="bar"><i style="width:${pct}%"></i></div></div>
    ${canTgl ? `<button class="mode-chip" data-mode-tgl="1" title="点一下切换">${DB.settings.mode === 'quick' ? '快速' : '经典'}</button>` : ''}
    <div style="font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;flex-shrink:0">${Ses.i + 1} / ${total}</div>
  </div>`;

  let body = '';
  const w = Ses.cur;
  const pure = Ses.kind === 'pure';
  const exsC = w.examples || [];

  if (Ses.phase === 'front') {
    body = `
      <div class="study-body center">
        <div class="flashcard" data-flip="1" data-say="${esc(URLS.word(w.id))}" data-copy="${esc(w.korean)}">
          <div class="word kr">${esc(w.korean)}</div>
          <div class="tap-hint">轻点翻面　·　双击听发音　·　长按复制</div>
        </div>
        ${pure ? `<div class="study-actions">
          <button class="btn btn-primary btn-block" data-act="flip">翻面看释义</button>
        </div>` : `<div class="study-actions g2">
          <button class="btn btn-ghost" data-act="unknown">不认识</button>
          <button class="btn btn-primary" data-act="flip">显示释义</button>
        </div>`}
      </div>`;
  } else if (Ses.phase === 'back') {
    body = `
      <div class="study-body center">
        <div class="flashcard" data-say="${esc(URLS.word(w.id))}" data-copy="${esc(w.korean)}" style="min-height:0;flex:0 0 auto;justify-content:flex-start">
          <div class="word kr" style="font-size:clamp(38px,10vw,58px)">${esc(w.korean)}</div>
          <div style="margin-top:12px">${spk(URLS.word(w.id), 34)}</div>
          <div class="meaning">${esc(w.chinese)}</div>
          <div class="pos"><span class="pill acc">${esc(w.pos)}</span> ${w.topik ? '<span class="pill">TOPIK ' + w.topik + '</span>' : ''}</div>
          ${exsC.map((e, ei) => `
          <div class="sent-box" id="sb${ei}" data-play="${esc(URLS.sent(w.id, ei + 1))}">
            <div style="display:flex;gap:10px;align-items:flex-start">
              <div style="flex:1">
                <div class="ko kr">${esc(e.ko)}</div>
                <div class="zh">${esc(e.zh)}</div>
              </div>
              ${spk(URLS.sent(w.id, ei + 1), 30)}
            </div>
          </div>`).join('')}
        </div>
        ${pure ? `<div class="study-actions">
          <button class="btn btn-primary btn-block" data-act="next-pure">下一个 →</button>
        </div>` : `<div class="study-actions g2">
          <button class="btn btn-ghost" data-act="unknown">不认识</button>
          <button class="btn btn-primary" data-act="known">认识，测一下</button>
        </div>`}
        <div style="text-align:center;margin-top:10px">
          <button class="btn" style="height:32px;font-size:13px;color:var(--muted)" data-act="note">＋ 记笔记</button>
          <button class="btn" style="height:32px;font-size:13px;color:var(--muted)" data-act="star">${DB.progress[w.id] && DB.progress[w.id].starred ? '★ 已收藏' : '☆ 收藏'}</button>
        </div>
      </div>`;
  } else if (Ses.phase === 'quick') {
    body = `
      <div class="study-body center">
        <div class="flashcard" data-say="${esc(URLS.word(w.id))}" data-copy="${esc(w.korean)}">
          <div class="word kr">${esc(w.korean)}</div>
          <div style="margin-top:14px">${spk(URLS.word(w.id), 36)}</div>
          <div class="meaning" style="margin-top:22px">${esc(w.chinese)}</div>
          <div class="pos"><span class="pill">${esc(w.pos)}</span></div>
        </div>
        <div class="study-actions g2">
          <button class="btn btn-ghost" data-act="unknown">不认识</button>
          <button class="btn btn-primary" data-act="known-fast">认识</button>
        </div>
      </div>`;
  } else if (Ses.phase === 'quiz') {
    body = renderQuizBody();
  } else if (Ses.phase === 'result') {
    body = renderResult();
  }

  box.innerHTML = top + body;
  bindStudy();
}

function renderQuizBody() {
  const q = Ses.quiz; if (!q) return '<div class="study-body"><div class="empty">题目生成失败</div></div>';
  const w = q.word;

  if (q.type === 'conj') {
    return `
    <div class="study-body center">
      <div class="q-stem">
        <div class="q-tag">变位 · ${esc(q.row.label)}</div>
        <div class="big kr">${esc(w.korean)}</div>
        <div style="font-size:13.5px;color:var(--muted);margin-top:8px">选出「${esc(q.row.label)}」的正确形式</div>
      </div>
      <div class="opts" data-qt="conj">
        ${q.opts.map((o, i) => `<button class="opt" data-opt="${esc(o.form)}"><span class="idx">${'ABCD'[i]}</span><span class="txt kr" style="font-size:20px">${esc(o.form)}</span></button>`).join('')}
      </div>
      <div id="fb-slot"></div>
    </div>`;
  }

  if (q.type === 'match') {
    const left = q.left.map(t =>
      `<button class="m kr-side" data-side="L" data-oid="${esc(t.id)}">${esc(t.text)}</button>`).join('');
    const right = q.right.map(t =>
      `<button class="m" data-side="R" data-oid="${esc(t.id)}">${esc(t.text)}</button>`).join('');
    return `
    <div class="study-body center">
      <div class="q-stem" style="padding:10px 0 18px">
        <div class="q-tag">连连看 · 配对韩文与释义</div>
        <div id="mk-hint" style="font-size:13px;color:var(--muted)">还剩 <b id="mk-left">${4 - q.done}</b> 组　·　左右各点一个</div>
      </div>
      <div class="match-grid" data-qt="match">
        <div class="mg-col">${left}</div>
        <div class="mg-col">${right}</div>
      </div>
      <div id="fb-slot"></div>
    </div>`;
  }

  const dir = q.dir;
  let stemHtml = '';
  if (dir === 'k2z') {
    stemHtml = `<div class="q-tag">看韩文选释义</div>
      <div class="big kr">${esc(w.korean)}</div>
      <div style="margin-top:14px">${spk(URLS.word(w.id), 36)}</div>`;
  } else if (dir === 'z2k') {
    stemHtml = `<div class="q-tag">看释义选韩文</div>
      <div class="big" style="font-size:26px">${esc(w.chinese)}</div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">${esc(w.pos)}</div>`;
  } else {
    stemHtml = `<div class="q-tag">听音选义</div>
      <div style="margin:6px 0">${spk(URLS.word(w.id), 64)}</div>
      <div style="font-size:12.5px;color:var(--muted)">可反复重听</div>`;
  }

  const opts = q.opts.map((o, i) => {
    const label = dir === 'z2k' ? o.korean : o.chinese;
    const krCls = dir === 'z2k' ? ' kr' : '';
    const spkBtn = dir === 'z2k' ? spk(URLS.word(o.id), 28, 'span') : '';
    return `<button class="opt" data-opt="${esc(o.id)}">
      <span class="idx">${'ABCD'[i]}</span>
      <span class="txt${krCls}" ${dir === 'z2k' ? 'style="font-size:19px"' : ''}>${esc(label)}</span>
      ${spkBtn}</button>`;
  }).join('');

  return `
  <div class="study-body center">
    <div class="q-stem">${stemHtml}</div>
    <div class="opts" data-qt="q4">${opts}</div>
    <div id="fb-slot"></div>
  </div>`;
}

function renderResult() {
  const s = Ses.stats;
  const total = s.right + s.wrong;
  const pct = total ? Math.round(s.right / total * 100) : 0;
  return `
  <div class="study-body" style="justify-content:center;justify-content:safe center;text-align:center">
    <div style="font-size:54px;font-weight:650;letter-spacing:-.03em;color:var(--accent)">${pct}%</div>
    <div style="color:var(--muted);font-size:13.5px;letter-spacing:.08em;margin-top:6px">正确率</div>
    <div class="stat-grid" style="margin-top:30px">
      <div class="sg card"><div class="n">${total}</div><div class="l">本次题数</div></div>
      <div class="sg card"><div class="n" style="color:var(--ok)">${s.right}</div><div class="l">答对</div></div>
      <div class="sg card"><div class="n" style="color:var(--warn)">${s.wrong}</div><div class="l">答错</div></div>
    </div>
    <button class="btn btn-primary btn-block mainbtn" style="margin-top:34px" data-ses="close">完成</button>
  </div>`;
}

function bindStudy() {
  const box = $('#study-wrap');
  box.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'flip') {
        if (Ses.kind === 'pure') markPure();
        Ses.phase = 'back'; renderStudy(); autoReadBack(Ses.cur);
      }
      if (a === 'next-pure') { Ses.i++; nextCard(); }
      if (a === 'unknown') { answer(0); }
      if (a === 'known') { Ses.phase = 'quiz'; Ses.quiz = buildQ4(Ses.cur, 'k2z'); renderStudy(); }
      if (a === 'known-fast') { answer(3); }
      if (a === 'note') { openNote(Ses.cur.id); }
      if (a === 'star') { openStar(Ses.cur.id); }
    };
  });
  box.querySelectorAll('[data-ses]').forEach(b => { b.onclick = () => { if (b.dataset.ses === 'close') endSession(); }; });
  box.querySelectorAll('.opt').forEach(b => { b.onclick = () => pickOption(b); });
  box.querySelectorAll('.match-grid .m').forEach(b => { b.onclick = () => tapMatch(b); });

  const mt = box.querySelector('[data-mode-tgl]');
  if (mt) mt.onclick = () => {
    const nx = DB.settings.mode === 'quick' ? 'classic' : 'quick';
    DB.settings.mode = nx; save();
    Ses.quiz = null;
    Ses.phase = nx === 'quick' ? 'quick' : (Ses.kind === 'pure' ? 'front' : 'front');
    renderStudy();
  };

  // 卡片手势：双击任意位置发音 / 长按复制 / 正面单击翻面
  const card = box.querySelector('.flashcard');
  if (card && card.dataset.say) {
    let tapT = null, lp = null;
    const fire = () => playSrc(card.dataset.say);
    card.addEventListener('click', e => {
      if (e.target.closest('[data-play]')) return;
      if (card.dataset.lp === '1') { card.dataset.lp = ''; return; }
      if (card.dataset.flip !== '1') return;
      if (tapT) { clearTimeout(tapT); tapT = null; fire(); return; }
      tapT = setTimeout(() => { tapT = null; Ses.phase = 'back'; renderStudy(); autoReadBack(Ses.cur); }, 230);
    });
    card.addEventListener('dblclick', e => {
      if (e.target.closest('[data-play]')) return;
      if (tapT) { clearTimeout(tapT); tapT = null; }
      fire();
    });
    card.addEventListener('pointerdown', () => {
      lp = setTimeout(() => {
        lp = null; card.dataset.lp = '1';
        const t = card.dataset.copy || '';
        if (navigator.clipboard && t) navigator.clipboard.writeText(t).catch(() => {});
        toast('已复制 ' + t);
      }, 560);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      card.addEventListener(ev, () => { if (lp) { clearTimeout(lp); lp = null; } }));
  }
}

function pickOption(btn) {
  if (btn.classList.contains('locked')) return;
  const q = Ses.quiz;
  const qt = btn.parentElement.dataset.qt;
  const opts = Array.prototype.slice.call(btn.parentElement.querySelectorAll('.opt'));
  opts.forEach(o => o.classList.add('locked'));

  let correct = false;
  if (qt === 'conj') {
    correct = btn.dataset.opt === q.answerForm;
    opts.forEach(o => {
      if (o.dataset.opt === q.answerForm) o.classList.add('right');
    });
    if (!correct) btn.classList.add('wrong');
    opts.forEach(o => { if (!o.classList.contains('right') && !o.classList.contains('wrong')) o.classList.add('dim'); });
  } else {
    correct = btn.dataset.opt === q.answerId;
    opts.forEach(o => {
      if (o.dataset.opt === q.answerId) o.classList.add('right');
    });
    if (!correct) btn.classList.add('wrong');
    opts.forEach(o => { if (!o.classList.contains('right') && !o.classList.contains('wrong')) o.classList.add('dim'); });
  }

  if (correct) Ses.stats.right++; else Ses.stats.wrong++;
  if (Ses.kind !== 'test') {
    const before = progOf(Ses.cur.id);
    const isFirstTouch = !before || before.state === ST.New;
    grade(Ses.cur.id, correct ? R.Good : R.Again);
    bumpLog(isFirstTouch ? 'new' : 'review');
  }

  // 反馈
  const slot = $('#fb-slot');
  if (slot) {
    const w = Ses.cur;
    const detail = correct
      ? '<div class="fb-detail kr">' + esc(w.korean) + '　' + esc(w.chinese) + '　·　下次复习：' + esc(intervalText(w.id)) + '</div>'
      : '<div class="fb-detail kr">正确答案：' + esc(w.korean) + '　' + esc(w.chinese) + '</div>';
    slot.innerHTML = '<div class="feedback ' + (correct ? 'good' : 'bad') + '">' +
      '<div class="fb-line">' + (correct ? '✓ 正确' : '✕ 答错了') + '</div>' + detail + '</div>' +
      '<button class="btn btn-primary btn-block" style="margin-top:12px" data-next="1">继续</button>';
    slot.querySelector('[data-next]').onclick = () => { Ses.i++; nextCard(); };
  }
  if (correct) {
    setTimeout(() => {
      if (Ses.on && Ses.quiz === q) { Ses.i++; nextCard(); }
    }, 1100);
  }
}

function tapMatch(btn) {
  const q = Ses.quiz;
  if (!q || q.type !== 'match' || q.done >= 4) return;
  if (btn.classList.contains('done')) return;
  const side = btn.dataset.side;

  if (q.pick && q.pick.el === btn) {                 // 再点自己 = 取消
    btn.classList.remove('sel'); q.pick = null; return;
  }
  if (q.pick && q.pick.side === side) {              // 同侧改选
    q.pick.el.classList.remove('sel');
    q.pick = null;
  }
  if (!q.pick) {
    q.pick = { side, id: btn.dataset.oid, el: btn };
    btn.classList.add('sel');
    return;
  }

  const a = q.pick, oid = btn.dataset.oid;
  a.el.classList.remove('sel');
  q.pick = null;

  if (a.id === oid) {
    a.el.classList.add('done'); btn.classList.add('done');
    q.done++;
    const el = $('#mk-left'); if (el) el.textContent = 4 - q.done;
    if (q.done >= 4) {
      const h = $('#mk-hint');
      if (h) h.innerHTML = q.miss ? '全部配对完成（过程中有错）' : '全部配对完成';
      finishMatch();
    }
  } else {
    q.miss = true;                                  // 任一组配错，本次判为没记住
    a.el.classList.add('err'); btn.classList.add('err');
    setTimeout(() => { a.el.classList.remove('err'); btn.classList.remove('err'); }, 380);
  }
}

function finishMatch() {
  const q = Ses.quiz, w = Ses.cur;
  const ok = !q.miss;
  if (ok) Ses.stats.right++; else Ses.stats.wrong++;
  if (Ses.kind !== 'test') {
    const before = progOf(w.id);
    grade(w.id, ok ? R.Good : R.Again);
    bumpLog(!before || before.state === ST.New ? 'new' : 'review');
    playSrc(URLS.word(w.id));
  }
  const slot = $('#fb-slot');
  if (!slot) return;
  slot.innerHTML = '<div class="feedback ' + (ok ? 'good' : 'bad') + '">' +
    '<div class="fb-line">' + (ok ? '✓ 四组全对' : '✕ 配对时出过错') + '</div>' +
    '<div class="fb-detail kr">' + esc(w.korean) + '　' + esc(w.chinese) +
    (ok ? '　·　下次复习：' + esc(intervalText(w.id)) : '') + '</div></div>' +
    '<button class="btn btn-primary btn-block" style="margin-top:12px" data-next="1">继续</button>';
  slot.querySelector('[data-next]').onclick = () => { Ses.i++; nextCard(); };
  if (ok) setTimeout(() => { if (Ses.on && Ses.quiz === q) { Ses.i++; nextCard(); } }, 1500);
}

function markPure() {
  if (Ses.marked) return;
  const w = Ses.cur;
  const before = progOf(w.id);
  const isNew = !before || before.state === ST.New;
  grade(w.id, R.Good);
  bumpLog(isNew ? 'new' : 'review');
  Ses.stats.right++;
  Ses.marked = true;
}

function answer(rating) {
  const w = Ses.cur;
  if (Ses.kind !== 'test') {
    const before = progOf(w.id);
    grade(w.id, rating);
    bumpLog(!before || before.state === ST.New ? 'new' : 'review');
  }
  Ses.stats.right += (rating >= 3 ? 1 : 0);
  Ses.stats.wrong += (rating < 3 ? 1 : 0);
  Ses.i++;
  nextCard();
}

function showSummary() {
  Ses.phase = 'result';
  renderStudy();
}

/* 笔记 / 收藏 */
function openNote(id) {
  const w = word(id);
  const cur = (DB.notes[id] || []).map(n => n.text).join('\n');
  const txt = prompt('为「' + w.korean + '　' + w.chinese + '」写笔记：', cur);
  if (txt === null) return;
  if (!txt.trim()) { delete DB.notes[id]; save(); toast('已清除笔记'); return; }
  DB.notes[id] = [{ text: txt.trim(), ts: Date.now() }];
  save(); toast('笔记已保存');
  if (Ses.on) renderStudy();
}
function toggleMaster(id) {
  let p = DB.progress[id];
  if (!p) { p = emptyProg(); DB.progress[id] = p; }
  p.mastered = !p.mastered;
  save();
  toast(p.mastered ? '已标记掌握，不再进复习' : '已移回学习队列');
  if (Ses.on) renderStudy(); else render();
}

function openStar(id) {
  const p = DB.progress[id] || emptyProg();
  p.starred = !p.starred;
  DB.progress[id] = p;
  save();
  toast(p.starred ? '已加入生词本' : '已移出生词本');
  if (Ses.on) renderStudy();
}

/* ==================== 字母 ==================== */
let alphaTab = 'cons';
let alphaSel = null;
let buildL = 0, buildV = 0, buildT = 0;

function viewAlpha() {
  const L = DATA.letters;
  let inner = '';

  if (alphaTab === 'cons' || alphaTab === 'vowels' || alphaTab === 'batchim') {
    const list = alphaTab === 'cons' ? L.consonants : alphaTab === 'vowels' ? L.vowels : L.batchim;
    const typeKey = alphaTab === 'cons' ? 'L' : alphaTab === 'vowels' ? 'V' : 'T';
    inner = `<div class="letter-grid">
      ${list.map(x => `<button class="letter-cell ${alphaSel === typeKey + x.index ? 'on' : ''}" data-lt="${typeKey}" data-li="${x.index}">
        <div class="ch kr">${esc(x.char || '∅')}</div>
        <div class="rm">${esc(alphaTab === 'batchim' ? (x.char ? '받침' : '开音节') : x.roman)}</div>
      </button>`).join('')}
    </div>
    <div id="letter-detail"></div>`;
  } else if (alphaTab === 'build') {
    const outChar = String.fromCharCode(0xAC00 + (buildL * 21 + buildV) * 28 + buildT);
    inner = `
    <div class="builder card">
      <div class="out kr">${outChar}</div>
      <div class="out-roman" id="build-roman"></div>
      <div style="margin-top:6px">${spk(URLS.syl(buildL, buildV), 34)}</div>
      <div class="ctrl">
        <div>
          <div class="lab">初声 · 辅音 (19)</div>
          <div class="chips">${L.lOrder.map((c, i) => `<button class="chip kr ${buildL === i ? 'on' : ''}" data-b="L" data-i="${i}">${c}</button>`).join('')}</div>
        </div>
        <div>
          <div class="lab">中声 · 元音 (21)</div>
          <div class="chips">${L.vOrder.map((c, i) => `<button class="chip kr ${buildV === i ? 'on' : ''}" data-b="V" data-i="${i}">${c}</button>`).join('')}</div>
        </div>
        <div>
          <div class="lab">终声 · 收音 (28)</div>
          <div class="chips">${L.tOrder.map((c, i) => `<button class="chip kr ${buildT === i ? 'on' : ''} ${i === 0 ? 'none' : ''}" data-b="T" data-i="${i}">${c || '无'}</button>`).join('')}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:16px;line-height:1.6;text-align:left">
        提示：带收音的音节，其发音会因音变规则变化。此处播放的是<b>无收音</b>版本，收音发音请到「收音」页单独听。
      </div>
    </div>`;
  } else {
    // 音节表
    inner = `<div class="syl-table"><table>
      <tr><th></th>${L.vOrder.map(v => `<th class="kr" style="font-size:14px">${v}</th>`).join('')}</tr>
      ${L.lOrder.map((c, li) => `<tr><td class="head kr">${c}</td>${L.vOrder.map((v, vi) => {
        const s = String.fromCharCode(0xAC00 + (li * 21 + vi) * 28);
        return `<td class="kr" data-syl="${li},${vi}">${s}</td>`;
      }).join('')}</tr>`).join('')}
    </table></div>
    <div style="font-size:12px;color:var(--muted);margin-top:10px;line-height:1.7">
    共 399 个无收音音节（19 辅音 × 21 元音）<br>
    左右滑动表格查看全部 · 点击任意格听标准发音
  </div>`;
  }

  return `
  <div class="tabs">
    ${[['cons', '辅音 19'], ['vowels', '元音 21'], ['batchim', '收音 28'], ['build', '构字器'], ['table', '音节表']]
      .map(([k, n]) => `<button class="${alphaTab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}
  </div>
  ${inner}`;
}

function bindAlpha() {
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => { alphaTab = b.dataset.tab; alphaSel = null; render(); };
  });
  document.querySelectorAll('[data-lt]').forEach(b => {
    b.onclick = () => {
      const t = b.dataset.lt, i = +b.dataset.li;
      alphaSel = t + i;
      playSrc(URLS.letter(t, i), b);
      renderDetail(t, i);
      document.querySelectorAll('.letter-cell').forEach(c => c.classList.toggle('on', c === b));
    };
  });
  document.querySelectorAll('[data-b]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.b, i = +b.dataset.i;
      if (k === 'L') buildL = i; else if (k === 'V') buildV = i; else buildT = i;
      render();
    };
  });
  document.querySelectorAll('[data-syl]').forEach(td => {
    td.onclick = () => {
      const [l, v] = td.dataset.syl.split(',').map(Number);
      playSrc(URLS.syl(l, v), td);
    };
  });
  updateBuildRoman();
}

function renderDetail(typeKey, idx) {
  const L = DATA.letters;
  let item, title;
  if (typeKey === 'L') { item = L.consonants.find(x => x.index === idx); title = '辅音'; }
  else if (typeKey === 'V') { item = L.vowels.find(x => x.index === idx); title = '元音'; }
  else { item = L.batchim.find(x => x.index === idx); title = '收音'; }
  const box = document.getElementById('letter-detail');
  if (!box || !item) return;
  const isB = typeKey === 'T';
  box.innerHTML = `
  <div class="card letter-detail">
    <div class="hd">
      <div class="ch kr">${esc(item.char || '∅')}</div>
      <div class="meta">
        <div class="nm kr">${esc(isB ? (item.char ? '代表收音 ' + item.char : '开音节') : item.name)}</div>
        <div class="rb">${esc(isB ? '' : (title + ' · 罗马音 ' + item.roman))}</div>
      </div>
      ${spk(URLS.letter(typeKey, idx), 40)}
    </div>
    <div class="hint">${esc(item.hint)}</div>
  </div>`;
}
function updateBuildRoman() {
  const el = document.getElementById('build-roman');
  if (el) {
    const L = DATA.letters;
    const c = L.consonants.find(x => x.index === buildL);
    const v = L.vowels.find(x => x.index === buildV);
    el.textContent = (c ? c.roman : '') + ' + ' + (v ? v.roman : '') + (buildT ? ' + 받침' : '');
  }
}

/* ==================== 词典 ==================== */
let dictQ = '';
const SEARCH_MAX = 100;
function searchWords() {
  const q = dictQ.trim();
  if (!q) return { list: [], total: 0 };
  const low = q.toLowerCase();
  const all = DATA.words.filter(w =>
    w.korean.includes(q) || w.chinese.includes(q) ||
    (w.romanization || '').toLowerCase().includes(low));
  return { list: all.slice(0, SEARCH_MAX), total: all.length };
}
function searchHeading(total) {
  return '搜索结果 ' + total + ' 条' + (total > SEARCH_MAX ? '（显示前 ' + SEARCH_MAX + '，再输一个字缩小范围）' : '');
}

function viewDict() {
  const q = dictQ.trim().toLowerCase();
  let list, heading;
  if (q) {
    const r = searchWords();
    list = r.list;
    heading = searchHeading(r.total);
  } else {
    const touched = DATA.words.filter(w => DB.progress[w.id]);
    const rest = DATA.words.filter(w => !DB.progress[w.id]);
    list = shuffle(touched).slice(0, 12).concat(shuffle(rest).slice(0, 18));
    heading = touched.length ? '最近在学 · 推荐' : '随便看看';
  }
  return `
  <div class="search-bar">${ICON.search}
    <input id="dict-input" placeholder="输入韩文或中文查词" value="${esc(dictQ)}" autocomplete="off">
  </div>
  <div class="sec-title">${heading}</div>
  <div class="card">
    ${list.length ? list.map(w => `
      <div class="row click" data-entry="${w.id}">
        <div class="r-main">
          <div class="r-title kr" style="font-size:17px">${esc(w.korean)}</div>
          <div class="r-sub">${esc(w.chinese)}　·　${esc(w.pos)}${w.topik ? '　·　TOPIK ' + w.topik : ''}</div>
        </div>
        ${statePill(w)}${ICON.chev}
      </div>`).join('') : '<div class="empty"><div class="ic">∅</div><div class="t">没有匹配的单词</div></div>'}
  </div>`;
}

function viewEntry(id) {
  const w = word(id);
  if (!w) return '<div class="empty">词条不存在</div>';
  const cj = DATA.conj[id];
  const p = progOf(id);
  const exs = w.examples || [];

  let conjHtml = '';
  if (cj) {
    const groups = [
      ['时态与人称阶', r => r.tag.indexOf('해요체') >= 0 || r.tag.indexOf('합니다체') >= 0 || r.tag.indexOf('해체') >= 0],
      ['定语形（관형형）', r => r.tag.indexOf('관형형') >= 0],
      ['连接与条件', r => r.tag.indexOf('-') === 0 || r.tag.indexOf('-(으)') === 0],
    ];
    conjHtml = groups.map(([gname, fn]) => {
      const rows = cj.rows.map((r, i) => ({ r, i })).filter(x => fn(x.r));
      if (!rows.length) return '';
      return `<tr class="grp"><td colspan="3">${gname}</td></tr>` + rows.map(({ r, i }) => `
        <tr><td class="lbl">${esc(r.label)}</td><td class="val kr">${esc(r.form)}</td>
        <td class="act">${spk(URLS.conj(id, i), 26)}</td></tr>`).join('');
    }).join('');
  }

  return `
  <div class="entry-hd">
    <div style="display:flex;align-items:flex-start;gap:14px">
      <div style="flex:1">
        <div class="ko kr">${esc(w.korean)}</div>
        <div class="meta">
          <span class="pill acc">${esc(w.pos)}</span>
          ${w.topik ? '<span class="pill">TOPIK ' + w.topik + '</span>' : ''}
          ${w.irregular && w.irregular !== 'none' ? '<span class="pill warn">' + esc(w.irregular) + ' 不规则</span>' : ''}
          ${statePill(w)}
        </div>
      </div>
      ${spk(URLS.word(id), 44)}
    </div>
    <div class="zh">${esc(w.chinese)}</div>
  </div>

  <div class="sec-title">例句${exs.length > 1 ? ' · ' + exs.length + ' 条' : ''}</div>
  ${exs.length ? `<div class="card">
    ${exs.map((e, i) => `
    <div class="ex-item" data-play="${esc(URLS.sent(id, i + 1))}">
      <div class="ex-top">
        <div style="flex:1">
          <div class="ex-ko kr">${esc(e.ko)}</div>
          <div class="ex-zh">${esc(e.zh)}</div>
        </div>
        <span class="ex-lv ${e.level === 1 ? 'l1' : ''}">${['', '初', '中', '高'][e.level || 1]}</span>
        ${spk(URLS.sent(id, i + 1), 28)}
      </div>
    </div>`).join('')}
  </div>` : '<div class="card" style="padding:16px 18px;color:var(--muted);font-size:13px">这条例句还没配</div>'}

  ${cj ? `<div class="sec-title">变位表</div>
  <div class="card collapse" id="conj-box">
    <div class="collapse-hd" data-toggle="conj-box">
      <span class="ch-t">15 种变位形式</span>
      <span class="pill acc">${esc(w.pos)}</span>
      ${ICON.chev}
    </div>
    <div class="collapse-body"><div class="inner" style="padding-top:2px">
      <table class="conj-table">${conjHtml}</table>
    </div></div>
  </div>` : (['动词', '形容词', '补助谓词'].includes(w.pos))
  ? `<div class="sec-title">变位表</div>
  <div class="card" style="padding:14px 18px">
    <div class="conj-none">这条来自官方词表，原始数据没标不规则类型。硬算会得出
    错误形式（比如 모르다 会算成 모르어요），所以这里不出表。</div>
  </div>` : ''}

  <div class="sec-title">操作</div>
  <div class="card">
    <div class="row click" data-star="${id}"><div class="r-main"><div class="r-title">${p && p.starred ? '★ 已在生词本' : '☆ 加入生词本'}</div></div></div>
    <div class="row click" data-master="${id}"><div class="r-main"><div class="r-title">${p && p.mastered ? '↩ 取消已掌握' : '✓ 标记为已掌握'}</div><div class="r-sub">${p && p.mastered ? '会重新进入复习队列' : '不再出现在学习与复习里'}</div></div></div>
    <div class="row click" data-note="${id}"><div class="r-main"><div class="r-title">我的笔记</div><div class="r-sub">${(DB.notes[id] || []).map(n => esc(n.text)).join(' / ') || '暂无'}</div></div>${ICON.chev}</div>
    ${p ? `<div class="row"><div class="r-main"><div class="r-title">学习状态</div><div class="r-sub">复习 ${p.reps} 次　遗忘 ${p.lapses} 次　难度 ${p.difficulty.toFixed(1)}</div></div><div class="r-val">${esc(intervalText(id))}</div></div>` : ''}
  </div>`;
}

/* ==================== 列表 ==================== */
let listLimit = 80, listKind = '';
function viewList(kind) {
  if (listKind !== kind) { listKind = kind; listLimit = 80; }   // 换列表就回到第一屏
  const MAP = {
    starred: ['生词本', w => DB.progress[w.id] && DB.progress[w.id].starred],
    wrong: ['错题集', w => DB.progress[w.id] && DB.progress[w.id].wrong > 0],
    learned: ['已背单词', w => DB.progress[w.id] && DB.progress[w.id].state !== ST.New],
    learning: ['在学词本', w => DB.progress[w.id] && DB.progress[w.id].state !== ST.New && !DB.progress[w.id].mastered],
    due: ['等待复习', w => DB.progress[w.id] && !DB.progress[w.id].mastered && DB.progress[w.id].due <= Date.now() && DB.progress[w.id].state !== ST.New],
    mastered: ['已掌握', w => DB.progress[w.id] && DB.progress[w.id].mastered],
  };
  const cfg = MAP[kind] || MAP.learned;
  TITLES.list = cfg[0];
  const list = deckWords().filter(cfg[1]);
  if (kind === 'wrong') list.sort((a, b) => DB.progress[b.id].wrong - DB.progress[a.id].wrong);
  const shown = list.slice(0, listLimit);

  return `
  <div class="sec-title" style="margin-top:16px">${cfg[0]} · ${list.length} 个</div>
  ${list.length ? `<div class="card">
    ${shown.map(w => `
      <div class="row">
        <div class="r-main click" data-entry="${w.id}">
          <div class="r-title kr" style="font-size:16px">${esc(w.korean)}</div>
          <div class="r-sub">${esc(w.chinese)}${DB.progress[w.id] && DB.progress[w.id].wrong ? '　·　错 ' + DB.progress[w.id].wrong + ' 次' : ''}</div>
        </div>
        ${statePill(w)}
        ${kind === 'mastered' ? `<button class="pill" data-master="${w.id}" style="cursor:pointer">移回</button>` : ''}
        ${spk(URLS.word(w.id), 28)}
      </div>`).join('')}
  </div>` : `<div class="empty"><div class="ic">∅</div><div class="t">这里还是空的</div></div>`}
  ${list.length > shown.length ? `<button class="btn btn-ghost btn-block" style="margin-top:14px" data-act="morelist">还有 ${list.length - shown.length} 个 · 显示更多</button>` : ''}
  ${kind === 'wrong' && list.length ? `<button class="btn btn-ghost btn-block" style="margin-top:16px" data-act="drill">专项复习错题（${list.length}）</button>` : ''}
  `;
}

/* ==================== 笔记 / 收藏 ==================== */
function viewNotes() {
  const ids = Object.keys(DB.notes).filter(id => word(id));
  return `
  <div class="sec-title" style="margin-top:16px">我的笔记 · ${ids.length} 条</div>
  ${ids.length ? `<div class="card">${ids.map(id => {
    const w = word(id);
    return `<div class="row click" data-note="${id}">
      <div class="r-main"><div class="r-title kr" style="font-size:15.5px">${esc(w.korean)} <span style="color:var(--muted);font-size:13px">${esc(w.chinese)}</span></div>
      <div class="r-sub">${esc((DB.notes[id] || []).map(n => n.text).join(' / '))}</div></div>${ICON.chev}</div>`;
  }).join('')}</div>` : `<div class="empty"><div class="ic">✎</div><div class="t">还没有笔记。学习卡片翻面后可以记。</div></div>`}`;
}

function viewSent() {
  const ids = Object.keys(DB.sentStar).filter(id => word(id));
  return `
  <div class="sec-title" style="margin-top:16px">收藏句子 · ${ids.length} 条</div>
  ${ids.length ? `<div class="card">${ids.map(id => {
    const w = word(id);
    return `<div class="row">
      <div class="r-main click" data-entry="${id}">
        <div class="r-title kr" style="font-size:15.5px">${esc(w.examples && w.examples[0] ? w.examples[0].ko : w.korean)}</div>
        <div class="r-sub">${esc(w.examples && w.examples[0] ? w.examples[0].zh : w.chinese)}</div>
      </div>${spk(URLS.sent(id, 1), 28)}</div>`;
  }).join('')}</div>` : `<div class="empty"><div class="ic">❝</div><div class="t">还没有收藏句子</div></div>`}`;
}

/* ==================== 词本 ==================== */
function viewDecks() {
  const ls = libStats();
  return `
  <div class="sec-title" style="margin-top:16px">可用词本</div>
  <div class="lib-hint">合计 <b>${ls.all}</b> 词 / <b>${ls.ex}</b> 条带音频例句，条长表示该词本占全库的比例</div>
  <div class="card">
    ${allDecks().map(d => {
      const n = (d.words || []).length;
      const on = d.id === DB.settings.deck;
      const pct = Math.max(2, Math.round(n / Math.max(1, ls.all) * 100));
      return `<div class="row click deck-row" data-deck="${d.id}">
        <div class="r-main">
          <div class="r-title">${esc(d.name)}</div>
          <div class="r-sub">${esc(d.type)} · ${n} 词</div>
          <div class="dbar"><i style="width:${pct}%"></i></div>
        </div>
        ${on ? '<span class="pill acc">使用中</span>' : ICON.chev}
      </div>`;
    }).join('')}
  </div>
  <div class="sec-title">自定义导入</div>
  <div class="card">
    <div class="row click" data-act="import">
      <div class="r-main"><div class="r-title">导入 JSON 词库</div><div class="r-sub">字段：korean / chinese / pos / topik</div></div>${ICON.chev}
    </div>
  </div>
  <input type="file" id="file-import" accept=".json" style="display:none">
  <div class="drag-hint">导入格式示例：<br><code style="font-size:11.5px;color:var(--muted)">[{"korean":"먹다","chinese":"吃","pos":"动词","topik":1}]</code></div>`;
}

/* ==================== 统计 ==================== */
function viewStats() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayStr(d);
    days.push({ k, label: (d.getMonth() + 1) + '/' + d.getDate(), v: DB.log[k] || { new: 0, review: 0 } });
  }
  const maxV = Math.max(1, ...days.map(d => (d.v.new || 0) + (d.v.review || 0)));

  // 连续天数
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayStr(d);
    const l = DB.log[k];
    if (l && (l.new + l.review) > 0) streak++;
    else if (i > 0) break;
  }

  const totalNew = Object.values(DB.log).reduce((a, b) => a + (b.new || 0), 0);
  const totalRev = Object.values(DB.log).reduce((a, b) => a + (b.review || 0), 0);

  const W = 620, H = 150, bw = W / days.length - 8;
  const bars = days.map((d, i) => {
    const tot = (d.v.new || 0) + (d.v.review || 0);
    const h = tot ? Math.max(3, (tot / maxV) * (H - 30)) : 2;
    const x = i * (W / days.length) + 4;
    return `<g>
      <rect x="${x}" y="${H - 22 - h}" width="${bw}" height="${h}" rx="3" fill="${tot ? 'var(--accent)' : 'var(--line)'}" opacity="${tot ? .85 : 1}"/>
      <text x="${x + bw / 2}" y="${H - 8}" font-size="9" fill="var(--muted)" text-anchor="middle">${d.label}</text>
      ${tot ? `<text x="${x + bw / 2}" y="${H - 26 - h}" font-size="9.5" fill="var(--text-2)" text-anchor="middle">${tot}</text>` : ''}
    </g>`;
  }).join('');

  return `
  <div class="stat-grid" style="margin-top:20px">
    <div class="sg card"><div class="n">${streak}</div><div class="l">连续天数</div></div>
    <div class="sg card"><div class="n">${totalNew}</div><div class="l">累计新学</div></div>
    <div class="sg card"><div class="n">${totalRev}</div><div class="l">累计复习</div></div>
  </div>
  <div class="stat-grid" style="margin-top:10px">
    <div class="sg card"><div class="n">${learnedCount()}</div><div class="l">本词本已学</div></div>
    <div class="sg card"><div class="n">${masteredCount()}</div><div class="l">已掌握</div></div>
    <div class="sg card"><div class="n">${Object.values(DB.progress).filter(p => p.wrong > 0).length}</div><div class="l">错题在册</div></div>
  </div>

  <div class="sec-title">近 14 天学习量</div>
  <div class="card chart-box">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible">${bars}</svg>
    <div style="display:flex;gap:16px;font-size:11.5px;color:var(--muted);margin-top:6px;justify-content:center">
      <span>今日：新 ${todayLog().new || 0} · 复习 ${todayLog().review || 0}</span>
    </div>
  </div>

  <div class="sec-title">当前词本进度</div>
  <div class="card" style="padding:18px">
    <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-bottom:8px">
      <span>${esc(curDeck() ? curDeck().name : '')}</span>
      <span>${learnedCount()} / ${curDeck() ? (curDeck().words || []).length : 0}</span>
    </div>
    <div class="bar" style="height:6px"><i style="width:${curDeck() && (curDeck().words || []).length ? Math.round(learnedCount() / curDeck().words.length * 100) : 0}%"></i></div>
  </div>`;
}

/* ==================== 设置 ==================== */
function viewSettings() {
  const s = DB.settings;
  const accents = [['jade', '#2F5D50'], ['terra', '#B5553C'], ['indigo', '#3D4E8A'], ['plum', '#7A3E5C'], ['ochre', '#96692B'], ['slate', '#3A4750']];
  return `
  <div class="sec-title">学习</div>
  <div class="card">
    <div class="row click" data-go="deck"><div class="r-main"><div class="r-title">当前词本</div></div><div class="r-val">${esc(curDeck() ? curDeck().name : '')}</div>${ICON.chev}</div>
    <div class="row"><div class="r-main"><div class="r-title">每日新词上限</div><div class="r-sub">控制每天新学数量，防止复习雪崩</div></div>
      <div style="display:flex;align-items:center;gap:12px">
        <button class="tb-btn" data-np="-5" style="width:28px;height:28px;background:var(--line-2)">−</button>
        <span style="font-variant-numeric:tabular-nums;min-width:24px;text-align:center">${s.newPerDay}</span>
        <button class="tb-btn" data-np="5" style="width:28px;height:28px;background:var(--line-2)">＋</button>
      </div>
    </div>
    <div class="row" style="align-items:flex-start;flex-direction:column;gap:10px">
      <div style="width:100%">
        <div class="r-title">学习模式</div>
        <div class="r-sub">${s.mode === 'classic' ? '经典：看词 → 释义 → 四选一验证' : s.mode === 'pure' ? '纯背：一路翻下去，不测试' : '快速：词义同屏自评'}</div>
      </div>
      <div style="display:flex;gap:4px;background:var(--line-2);padding:3px;border-radius:9px;width:100%">
        ${[['classic', '经典'], ['pure', '纯背'], ['quick', '快速']].map(([k, n]) =>
          `<button style="flex:1;height:30px;border-radius:7px;font-size:13px;${s.mode === k ? 'background:var(--surface);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.07)' : 'color:var(--muted)'}" data-mode-set="${k}">${n}</button>`).join('')}
      </div>
    </div>
    <div class="row"><div class="r-main"><div class="r-title">自动读单词</div><div class="r-sub">翻到释义面时自动念一遍</div></div>
      <button class="sw-tg${s.autoWord ? ' on' : ''}" data-tg="autoWord" aria-label="自动读单词"><i></i></button></div>
    <div class="row"><div class="r-main"><div class="r-title">自动读例句</div><div class="r-sub">接着逐条把例句念完</div></div>
      <button class="sw-tg${s.autoSent ? ' on' : ''}" data-tg="autoSent" aria-label="自动读例句"><i></i></button></div>
  </div>

  <div class="sec-title">外观</div>
  <div class="card">
    <div class="row"><div class="r-main"><div class="r-title">主题</div></div>
      <div style="display:flex;gap:4px;background:var(--line-2);padding:3px;border-radius:9px">
        ${[['auto', '跟随'], ['light', '浅色'], ['dark', '深色']].map(([k, n]) =>
          `<button style="height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;${s.theme === k ? 'background:var(--surface);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.07)' : 'color:var(--muted)'}" data-theme-set="${k}">${n}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="align-items:flex-start;flex-direction:column;gap:10px">
      <div class="r-title">主题色</div>
      <div class="swatches">
        ${accents.map(([k, c]) => `<button class="sw ${s.accent === k ? 'on' : ''}" data-accent-set="${k}" style="background:${c}"></button>`).join('')}
      </div>
    </div>
  </div>

  <div class="sec-title">数据</div>
  <div class="card">
    <div class="row"><div class="r-main"><div class="r-title">本地音频</div><div class="r-sub">单词 ${DATA.words.length} · 例句 ${DATA.words.reduce((a, w) => a + (w.examples || []).length, 0)} · 字母 47 · 音节 399 · 变位形 ${Object.keys(DATA.conj).reduce((a, k) => a + DATA.conj[k].rows.length, 0)}</div></div><div class="r-val">已内置</div></div>
    <div class="row click" data-go="note"><div class="r-main"><div class="r-title">我的笔记</div></div><div class="r-val">${Object.keys(DB.notes).length}</div>${ICON.chev}</div>
    <div class="row click" data-go="sent"><div class="r-main"><div class="r-title">收藏句子</div></div><div class="r-val">${Object.keys(DB.sentStar).length}</div>${ICON.chev}</div>
    <div class="row"><div class="r-main"><div class="r-title">桌面快捷键</div><div class="r-sub">1–4 选项 · 空格/回车 翻面与继续</div></div><div class="r-val">可用</div></div>
    <div class="row click" data-act="export"><div class="r-main"><div class="r-title">导出学习进度</div><div class="r-sub">JSON，可用于备份</div></div>${ICON.chev}</div>
    <div class="row click" data-act="reset"><div class="r-main"><div class="r-title" style="color:var(--warn)">清空全部进度</div><div class="r-sub">不可恢复</div></div>${ICON.chev}</div>
  </div>

  <div style="text-align:center;font-size:12px;color:var(--muted);margin-top:34px;line-height:1.9">
    한글·学　v1.0<br>
    识别型韩语学习 · FSRS 记忆调度<br>
    发音：Microsoft Edge TTS（首尔音）
  </div>`;
}

/* ==================== 事件绑定 ==================== */
function bindView() {
  document.querySelectorAll('[data-go]').forEach(b => {
    b.onclick = () => {
      const g = b.dataset.go.split('/');
      go(g[0], g[1] || null);
    };
  });
  document.querySelectorAll('[data-tg]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.tg;
      DB.settings[k] = !DB.settings[k];
      save();
      b.classList.toggle('on', !!DB.settings[k]);
      toast(DB.settings[k] ? '已开启' : '已关闭');
    };
  });
  document.querySelectorAll('[data-entry]').forEach(b => {
    b.onclick = () => go('entry', b.dataset.entry);
  });
  document.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'start') {
        const m = DB.settings.mode;
        if (m === 'pure') startSession('pure');
        else if (dueWords().length) startSession('review');
        else if (newRemain() > 0) startSession('new');
        else toast('今天的学习任务已完成');
      }
      if (a === 'review') {
        if (b.dataset.lp === '1') { b.dataset.lp = ''; return; }
        startSession('review');
      }
      if (a === 'new') startSession('new');
      if (a === 'pure') startSession('pure');
      if (a === 'quick') startSession('quick');
      if (a === 'test') startSession('test');
      if (a === 'drill') startSession('wrong');
      if (a === 'morelist') { listLimit += 100; render(); return; }
    if (a === 'declare') {
        const t = document.querySelector('#conj-box');
        if (t) t.classList.remove('open');
        document.querySelectorAll('.collapse').forEach(c => c.classList.remove('open'));
        toast('全部变位表已收起');
      }
      if (a === 'import') { const f = $('#file-import'); if (f) f.click(); }
      if (a === 'export') doExport();
      if (a === 'reset') {
        if (confirm('确定清空所有学习进度、笔记与统计？此操作不可恢复。')) {
          localStorage.removeItem(SKEY); DB = JSON.parse(JSON.stringify(DEFAULTS));
          save(); applyTheme(); go('home'); toast('已重置');
        }
      }
    };
  });
  document.querySelectorAll('[data-open]').forEach(b => {});

  // 词典搜索
  const di = $('#dict-input');
  if (di) {
    di.oninput = () => {
      dictQ = di.value;
      const q = dictQ.trim().toLowerCase();
      const r0 = q ? searchWords() : null;
      let list = r0 ? r0.list : shuffle(DATA.words).slice(0, 30);
      // 局部刷新列表，保持输入焦点
      const card = $('#view .card');
      if (!card) return;
      card.innerHTML = list.length ? list.map(w => `
        <div class="row click" data-entry="${w.id}">
          <div class="r-main"><div class="r-title kr" style="font-size:17px">${esc(w.korean)}</div>
          <div class="r-sub">${esc(w.chinese)}　·　${esc(w.pos)}${w.topik ? '　·　TOPIK ' + w.topik : ''}</div></div>
          ${statePill(w)}${ICON.chev}
        </div>`).join('') : '<div class="empty"><div class="ic">∅</div><div class="t">没有匹配的单词</div></div>';
      card.querySelectorAll('[data-entry]').forEach(b => { b.onclick = () => go('entry', b.dataset.entry); });
      const t = $('#view .sec-title');
      if (t && q) t.textContent = searchHeading(r0.total);
    };
  }

  document.querySelectorAll('[data-star]').forEach(b => {
    b.onclick = () => { openStar(b.dataset.star); render(); };
  });
  document.querySelectorAll('[data-note]').forEach(b => {
    b.onclick = () => { openNote(b.dataset.note); render(); };
  });
  document.querySelectorAll('[data-master]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); toggleMaster(b.dataset.master); };
  });
  document.querySelectorAll('[data-deck]').forEach(b => {
    b.onclick = () => {
      DB.settings.deck = b.dataset.deck; save();
      toast('已切换到「' + curDeck().name + '」');
      go('home');
    };
  });
  document.querySelectorAll('[data-np]').forEach(b => {
    b.onclick = () => {
      DB.settings.newPerDay = Math.max(5, Math.min(200, DB.settings.newPerDay + (+b.dataset.np)));
      save(); render();
    };
  });
  document.querySelectorAll('[data-mode-set]').forEach(b => {
    b.onclick = () => { DB.settings.mode = b.dataset.modeSet; save(); render(); };
  });
  document.querySelectorAll('[data-theme-set]').forEach(b => {
    b.onclick = () => { DB.settings.theme = b.dataset.themeSet; save(); applyTheme(); render(); };
  });
  document.querySelectorAll('[data-accent-set]').forEach(b => {
    b.onclick = () => { DB.settings.accent = b.dataset.accentSet; save(); applyTheme(); render(); };
  });
  document.querySelectorAll('[data-toggle]').forEach(b => {
    b.onclick = () => {
      const box = document.getElementById(b.dataset.toggle);
      if (box) box.classList.toggle('open');
    };
  });
  // 长按「等待复习」→ 顺延到明天（复习债务缓解）
  const lpCard = document.querySelector('[data-longpress="due"]');
  if (lpCard) {
    let lpTimer = null;
    lpCard.addEventListener('pointerdown', () => {
      lpTimer = setTimeout(() => {
        lpTimer = null;
        const list = dueWords();
        if (!list.length) { toast('当前没有到期单词'); return; }
        lpCard.dataset.lp = '1';
        if (!confirm('把今天到期的 ' + list.length + ' 个词顺延到明天？\n\n进度不会丢，只是把复习推迟，用来缓解积压。')) return;
        const tomorrow = Date.now() + 86400000;
        list.forEach(w => { DB.progress[w.id].due = tomorrow; });
        save(); render();
        toast('已顺延 ' + list.length + ' 个词');
      }, 700);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      lpCard.addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }));
  }

  const fi = $('#file-import');
  if (fi) fi.onchange = () => doImport(fi.files[0]);

  bindAlpha();
}

function doExport() {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'krlearn-progress-' + todayStr() + '.json';
  a.click();
  toast('已导出');
}

function doImport(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const arr = JSON.parse(r.result);
      if (!Array.isArray(arr) || !arr.length) throw new Error('需要一个数组');
      const ids = [];
      arr.forEach((it, i) => {
        if (!it.korean || !it.chinese) return;
        const id = 'c' + Date.now().toString(36) + i;
        DATA.words.push({
          id, korean: it.korean, chinese: it.chinese,
          pos: it.pos || '名词', topik: it.topik || 0, irregular: it.irregular || 'none',
          examples: it.examples || []
        });
        DATA.wordMap[id] = DATA.words[DATA.words.length - 1];
        ids.push(id);
      });
      if (!ids.length) throw new Error('没有有效词条');
      DB.customDecks.push({ id: 'custom' + Date.now(), name: file.name.replace(/\.json$/i, ''), type: '自定义', words: ids });
      DB.settings.deck = DB.customDecks[DB.customDecks.length - 1].id;
      save();
      toast('导入 ' + ids.length + ' 词，已切换');
      go('home');
    } catch (e) { toast('导入失败：' + e.message); }
  };
  r.readAsText(file, 'utf-8');
}

/* ==================== 启动 ==================== */
async function boot() {
  load(); applyTheme();
  try {
    const [L, W, D, C, LM] = await Promise.all([
      fetch('data/letters.json').then(r => r.json()),
      fetch('data/words.json').then(r => r.json()),
      fetch('data/decks.json').then(r => r.json()),
      fetch('data/conjugations.json').then(r => r.json()).catch(() => ({})),
      fetch('data/legacy.json').then(r => r.json()).catch(() => ({})),
    ]);
    DATA.letters = L; DATA.words = W; DATA.decks = D; DATA.conj = C;
    DATA.legacy = LM;                 // 旧 id → 韩文，只用于迁移老存档
    DATA.wordMap = {};
    W.forEach(w => { DATA.wordMap[w.id] = w; });
  } catch (e) {
    $('#view').innerHTML = '<div class="empty" style="padding-top:120px"><div class="ic">!</div><div class="t">数据加载失败。请通过「启动.bat」运行（需要本地服务器，直接双击 HTML 会被浏览器拦截）。</div></div>';
    return;
  }
  migrateIds();          // 词库扩容后 word id 会重排，先把旧进度搬回来

  // 初始路由
  const h = (location.hash || '').replace(/^#/, '');
  if (h) {
    const [n, a] = h.split('/');
    route = { name: n || 'home', arg: a ? decodeURIComponent(a) : null };
  }
  render();

  window.addEventListener('scroll', () => {
    $('#topbar').classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  // 键盘快捷键（桌面端）
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!Ses.on) return;
    const opts = document.querySelectorAll('#study-wrap .opt');
    if (opts.length && ['1', '2', '3', '4'].indexOf(e.key) >= 0) {
      e.preventDefault(); opts[+e.key - 1].click();
    }
    if (e.code === 'Space' || e.key === 'Enter') {
      const nx = document.querySelector('#study-wrap [data-next]');
      const fl = document.querySelector('#study-wrap [data-act="flip"]');
      if (nx) { e.preventDefault(); nx.click(); }
      else if (fl) { e.preventDefault(); fl.click(); }
    }
  });
}

boot();
})();
