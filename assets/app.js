(function () {
  'use strict';

  var STORE_KEY = 'wordtype.v1';
  var MAX_TRIES = 3;
  var MIN = 60000;
  var DAY = 86400000;
  var DEFAULTS = {
    theme: 'light',
    sound: true,
    autoplay: true,
    hideAnswer: false,
    showPinyin: true,
    fontScale: 1
  };

  var el = function (id) { return document.getElementById(id); };

  // ================= 存储 =================
  var db = load();

  function load() {
    var raw = {};
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    var recs = raw.records || {};
    // 兼容旧数据：把按「天」存的 due 换成时间戳
    Object.keys(recs).forEach(function (k) {
      var r = recs[k];
      if (r.dueAt === undefined) {
        r.dueAt = 0;
        if (r.due && r.seen) {
          var t = new Date(r.due + 'T00:00:00').getTime();
          if (!isNaN(t)) r.dueAt = t;
        }
        delete r.due;
      }
      if (r.iv === undefined) r.iv = (r.interval || 0) * DAY;
      delete r.interval;
    });
    return {
      settings: Object.assign({}, DEFAULTS, raw.settings || {}),
      records: recs,
      days: raw.days || {},
      custom: raw.custom || []
    };
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
  }

  function getRec(word) {
    if (!db.records[word]) {
      db.records[word] = { ease: 2.5, reps: 0, iv: 0, dueAt: 0, last: 0, seen: 0, wrong: 0, lastAt: 0 };
    }
    var r = db.records[word];
    if (r.dueAt === undefined) r.dueAt = 0;
    if (r.iv === undefined) r.iv = 0;
    return r;
  }

  var wordCache = null;

  function allWords() {
    if (!wordCache) wordCache = db.custom.concat(window.WORD_BANK || []);
    return wordCache;
  }

  // ================= 日期 =================
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function dayEntry() {
    var k = todayKey();
    if (!db.days[k]) db.days[k] = { words: 0, clean: 0, chars: 0, seconds: 0, newWords: 0 };
    return db.days[k];
  }

  function mmss(sec) {
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
  }

  // 「3 分钟前」「2 天后」这类相对时间，给复习提示用
  function humanGap(ms) {
    var a = Math.abs(ms);
    var s = Math.round(a / 1000);
    if (s < 50) return '刚刚';
    var m = Math.round(s / 60);
    if (m < 60) return m + '分钟';
    var h = Math.round(m / 60);
    if (h < 24) return h + '小时';
    var d = Math.round(h / 24);
    if (d < 30) return d + '天';
    return Math.round(d / 30) + '个月';
  }

  // ================= 间隔重复 =================
  // 忘了：2 分钟后重来；模糊：8 分钟后重来；很熟：按 SM-2 拉长到 1/3/7… 天
  function applyGrade(rec, grade) {
    var now = Date.now();
    if (grade === 1) {
      rec.reps = 0;
      rec.iv = 0;
      rec.ease = Math.max(1.3, rec.ease - 0.18);
      rec.dueAt = now + 2 * MIN;
    } else if (grade === 2) {
      rec.reps = Math.max(1, rec.reps);
      rec.iv = rec.iv > 0 ? Math.round(rec.iv * 0.6) : 0;
      rec.ease = Math.max(1.3, rec.ease - 0.05);
      rec.dueAt = now + 8 * MIN;
    } else {
      rec.reps += 1;
      if (rec.iv <= 0 || rec.iv < MIN) rec.iv = DAY;
      else if (rec.reps <= 2) rec.iv = rec.reps === 1 ? DAY : 3 * DAY;
      else rec.iv = Math.round(rec.iv * rec.ease);
      rec.ease = Math.min(2.8, rec.ease + 0.05);
      rec.dueAt = now + rec.iv;
    }
    rec.last = grade;
  }

  // ================= 取词 =================
  function inRetry(word) {
    for (var i = 0; i < state.retry.length; i++) {
      if (state.retry[i].w.w === word) return true;
    }
    return false;
  }

  // 到期的旧词，越该复习的排越前
  function duePool(now) {
    var ws = allWords(), out = [];
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.seen > 0 && r.dueAt <= now && !inRetry(ws[i].w)) {
        out.push({ w: ws[i], at: r.dueAt });
      }
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  // 下一个没学过的词，严格按书的顺序
  function nextNew() {
    var ws = allWords();
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (!r || !r.seen) return ws[i];
    }
    return null;
  }

  // 返回 { w, mode }：mode = retry（本轮重来）/ due（到期复习）/ new（新词）
  function pickNext() {
    if (state.forced.length) return { w: state.forced.shift(), mode: 'due' };

    for (var i = 0; i < state.retry.length; i++) {
      if (state.retry[i].at <= state.step) {
        return { w: state.retry.splice(i, 1)[0].w, mode: 'retry' };
      }
    }

    var due = duePool(Date.now());
    if (due.length) return { w: due[0].w, mode: 'due' };

    var fresh = nextNew();
    if (fresh) return { w: fresh, mode: 'new' };

    return null;
  }

  // 卡里最该复习的 n 个词，用来「再复习一组」
  function reviewBatch(n) {
    var ws = allWords().filter(function (w) {
      var r = db.records[w.w];
      return r && r.seen > 0;
    });
    ws.sort(function (a, b) {
      return (db.records[a.w].dueAt || 0) - (db.records[b.w].dueAt || 0);
    });
    return ws.slice(0, n);
  }

  // ================= 状态 =================
  var state = {
    view: 'drill',
    phase: 'idle',
    current: null,
    origin: 'new',
    grade: 0,
    errors: 0,
    mistakes: 0,
    locked: false,
    lockValue: '',
    composing: false,
    committed: '',
    comp: '',
    wordStart: 0,
    step: 0,
    retry: [],
    forced: []
  };

  var timerId = null;
  var startedAt = Date.now();


  // ================= 键盘指法 =================
  var KB_ROWS = [
    [['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'],
     ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'],
     ['Digit0', '0'], ['Minus', '-'], ['Equal', '='], ['Backspace', '退格', 2.05, 1]],
    [['Tab', 'tab', 1.5, 1], ['KeyQ', 'q'], ['KeyW', 'w'], ['KeyE', 'e'], ['KeyR', 'r'],
     ['KeyT', 't'], ['KeyY', 'y'], ['KeyU', 'u'], ['KeyI', 'i'], ['KeyO', 'o'],
     ['KeyP', 'p'], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 1.5, 1]],
    [['CapsLock', 'caps', 1.8, 1], ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd'],
     ['KeyF', 'f'], ['KeyG', 'g'], ['KeyH', 'h'], ['KeyJ', 'j'], ['KeyK', 'k'],
     ['KeyL', 'l'], ['Semicolon', ';'], ['Quote', "'"], ['Enter', '回车', 2.2, 1]],
    [['ShiftLeft', 'shift', 2.6, 1], ['KeyZ', 'z'], ['KeyX', 'x'], ['KeyC', 'c'],
     ['KeyV', 'v'], ['KeyB', 'b'], ['KeyN', 'n'], ['KeyM', 'm'], ['Comma', ','],
     ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'shift', 2.6, 1]],
    [['ControlLeft', 'ctrl', 1.4, 1], ['AltLeft', 'alt', 1.2, 1], ['Space', '空格', 7.2],
     ['AltRight', 'alt', 1.2, 1], ['ControlRight', 'ctrl', 1.4, 1]]
  ];

  var FINGER_MAP = {};
  [
    ['left-pinky', ['Backquote', 'Digit1', 'KeyQ', 'KeyA', 'KeyZ', 'Tab', 'CapsLock', 'ShiftLeft', 'ControlLeft']],
    ['left-ring', ['Digit2', 'KeyW', 'KeyS', 'KeyX']],
    ['left-middle', ['Digit3', 'KeyE', 'KeyD', 'KeyC']],
    ['left-index', ['Digit4', 'Digit5', 'KeyR', 'KeyT', 'KeyF', 'KeyG', 'KeyV', 'KeyB']],
    ['right-index', ['Digit6', 'Digit7', 'KeyY', 'KeyU', 'KeyH', 'KeyJ', 'KeyN', 'KeyM']],
    ['right-middle', ['Digit8', 'KeyI', 'KeyK', 'Comma']],
    ['right-ring', ['Digit9', 'KeyO', 'KeyL', 'Period']],
    ['right-pinky', ['Digit0', 'Minus', 'Equal', 'KeyP', 'BracketLeft', 'BracketRight',
      'Backslash', 'Semicolon', 'Quote', 'Slash', 'Enter', 'Backspace', 'ShiftRight', 'ControlRight']],
    ['thumb', ['Space', 'AltLeft', 'AltRight']]
  ].forEach(function (g) {
    g[1].forEach(function (code) { FINGER_MAP[code] = g[0]; });
  });

  var FINGER_NAMES = {
    'left-pinky': '左手小指',
    'left-ring': '左手无名指',
    'left-middle': '左手中指',
    'left-index': '左手食指',
    'right-index': '右手食指',
    'right-middle': '右手中指',
    'right-ring': '右手无名指',
    'right-pinky': '右手小指',
    'thumb': '拇指'
  };

  function buildKeyboard() {
    var board = el('kbBoard');
    if (!board) return;
    board.innerHTML = KB_ROWS.map(function (row) {
      return '<div class="kb-row">' + row.map(function (k) {
        var flex = k[2] ? ' style="flex:' + k[2] + ' 1 0"' : '';
        var cls = 'kb-key' + (k[3] ? ' is-wide' : '') + (k[0] === 'Space' ? ' kb-space' : '');
        return '<span class="' + cls + '" data-code="' + k[0] + '" data-label="' + k[1] + '"' + flex + '>' +
          k[1] + '</span>';
      }).join('') + '</div>';
    }).join('');
  }

  function eventCode(e) {
    var c = e.code || '';
    if (c === 'NumpadEnter') return 'Enter';
    if (c) return c;

    var k = e.key || '';
    if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    var fallback = {
      ' ': 'Space', 'Backspace': 'Backspace', 'Enter': 'Enter', 'Tab': 'Tab',
      'CapsLock': 'CapsLock', 'Shift': 'ShiftLeft', 'Control': 'ControlLeft',
      'Alt': 'AltLeft', '`': 'Backquote', '-': 'Minus', '=': 'Equal',
      '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
      "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash'
    };
    return fallback[k] || '';
  }

  // ================= 手部 =================
  // 照搬 edclub 的机制：一张 716×380 的 SVG 里预先画好 58 个姿势图层，
  // 每个图层就是一整只手的静态画（放松 / 某根手指按某个键）。
  // 运行时只切 display，不做任何变形计算；左右手各显示一层，同时出现。

  // KeyboardEvent.code → 图层 id
  var LAYER_OF_CODE = {
    Backquote: 'tilda', Digit1: 'key-1', Digit2: 'key-2', Digit3: 'key-3', Digit4: 'key-4',
    Digit5: 'key-5', Digit6: 'key-6', Digit7: 'key-7', Digit8: 'key-8', Digit9: 'key-9',
    Digit0: 'key-0', Minus: 'minus', Equal: 'equal',
    BracketLeft: 'open-bracket', BracketRight: 'close-bracket', Backslash: 'backslash',
    KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u',
    KeyI: 'i', KeyO: 'o', KeyP: 'p',
    KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j',
    KeyK: 'k', KeyL: 'l',
    KeyZ: 'z', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm',
    Semicolon: 'semicolon', Quote: 'quote', Comma: 'comma', Period: 'dot', Slash: 'slash',
    Tab: 'tab', Enter: 'enter', Space: 'space',
    ShiftLeft: 'shift-left', ShiftRight: 'shift-right'
  };

  // 按住键的先后顺序，最新的在最前
  var heldStack = [];

  // 键盘提示：hintCode 是当前要伸手指的那个键（手部用），
  // hintKey 是提示状态的指纹，只有它变了才动 DOM
  var hintCode = '';
  var hintKey = '';

  function heldPush(code) {
    var i = heldStack.indexOf(code);
    if (i >= 0) heldStack.splice(i, 1);
    heldStack.unshift(code);
  }

  function heldDrop(code) {
    var i = heldStack.indexOf(code);
    if (i >= 0) heldStack.splice(i, 1);
  }

  // 某个手该显示哪一层：取这只手最近按下的键；
  // 没有按键（或该键没有画姿势层）就用放松层。
  function layerOfHand(side) {
    var neutral = side === 'left' ? 'neutral-left' : 'neutral-right';
    for (var i = 0; i < heldStack.length; i++) {
      var f = FINGER_MAP[heldStack[i]];
      if (!f) continue;
      var belong = f === 'thumb' ? 'right' : f.split('-')[0];
      if (belong !== side) continue;
      var layer = LAYER_OF_CODE[heldStack[i]];
      if (layer) return layer;
    }

    // 没按键时，把「下一个要敲的字母」那条手指伸到键上，当作指法提示
    var hf = FINGER_MAP[hintCode];
    if (hf && hintCode) {
      var hSide = hf === 'thumb' ? 'right' : hf.split('-')[0];
      if (hSide === side && LAYER_OF_CODE[hintCode]) return LAYER_OF_CODE[hintCode];
    }

    return neutral;
  }

  // 与 edclub 的 focus_hand(l, r) 逐行对应：
  // 两只手各亮一层，缺的一侧退回 neutral。
  function focusHand(leftId, rightId) {
    var host = el('handsSvg');
    if (!host) return;
    var layers = host.querySelectorAll('g.st0');
    var shown = [false, false];
    var neutral = [null, null];

    for (var i = 0; i < layers.length; i++) {
      var g = layers[i];
      var id = g.id.replace(/^hb-/, '');
      if (id === 'neutral-left') neutral[0] = g;
      if (id === 'neutral-right') neutral[1] = g;
      if (id === leftId || id === rightId) {
        g.style.display = 'block';
        shown[id === leftId ? 0 : 1] = true;
      } else {
        g.style.display = 'none';
      }
    }

    for (var k = 0; k < 2; k++) {
      if (!shown[k] && neutral[k]) neutral[k].style.display = 'block';
    }
  }

  function syncHands() {
    focusHand(layerOfHand('left'), layerOfHand('right'));
  }

  // ===== 下一个字母的指法提示 =====
  // 整串推进：从当前字开始，把后面所有字的拼音接成一条，减去输入法缓冲里已敲的字母，
  // 剩下的第一个就是下一个字母。这样一路敲到底，不会在每个字边界停下。
  function restPinyin() {
    var w = state.current;
    if (!w) return '';
    var chars = Array.from(w.a || '');
    var py = pinyinAlign(w.a || '');
    var typed = Array.from(state.committed || '').length;
    var rest = '';
    for (var j = typed; j < chars.length; j++) rest += (py[j] || '');
    return rest.replace(/ü/g, 'v').replace(/[^a-z]/g, '');
  }

  // 键盘常驻，时刻告诉用户“现在该做什么”。
  // codes: 要高亮的键（可能多个）；text: 状态栏文案；hand: 手部要伸到哪个键
  function hintState() {
    var out = { codes: [], text: '', hand: '' };
    if (state.view !== 'drill') return out;

    // ① 看词自评：J / K / L 三选一，三个键一起亮
    if (state.phase === 'recall') {
      out.codes = ['KeyJ', 'KeyK', 'KeyL'];
      out.text = '选择记忆程度 · J 忘了 / K 模糊 / L 很熟';
      return out;
    }

    if (state.phase !== 'typing') return out;

    // ② 打错了被锁住：先把错的删掉
    if (state.locked) {
      out.codes = ['Backspace'];
      out.text = '打错了 · Backspace 删掉重来';
      return out;
    }

    var w = state.current;
    if (!w) return out;

    var chars = Array.from(w.a || '');
    var typed = Array.from(state.committed || '').length;

    // ③ 答案已全部上屏：Enter 提交
    if (typed >= chars.length) {
      out.codes = ['Enter'];
      out.text = '答案已输入完 · Enter 提交';
      out.hand = 'Enter';
      return out;
    }

    // 开了「隐藏答案」就不再提示字母，否则等于把读音漏出来
    if (db.settings.hideAnswer) {
      out.text = '按拼音输入中文';
      return out;
    }

    var target = restPinyin();
    if (!target) return out;

    var buf = String(state.comp || '').toLowerCase().replace(/[^a-z]/g, '');
    var n = 0;
    while (n < buf.length && n < target.length && buf.charAt(n) === target.charAt(n)) n++;

    // ④ 整串拼音敲完：空格上屏
    if (n >= target.length) {
      out.codes = ['Space'];
      out.text = '拼音已敲完 · 空格上屏';
      out.hand = 'Space';
      return out;
    }

    // ⑤ 逐字母提示；敲错/简拼对不上时，提示的仍是「这一位该敲的字母」，把人带回来
    var letter = target.charAt(n);
    var code = 'Key' + letter.toUpperCase();
    var name = FINGER_NAMES[FINGER_MAP[code]] || '';
    out.codes = [code];
    out.text = '下一个 ' + letter + (name ? ' · ' + name : '');
    out.hand = code;
    return out;
  }

  function clearHint() {
    hintCode = '';
    hintKey = '';
    document.querySelectorAll('.kb-key.is-hint').forEach(function (n) {
      n.classList.remove('is-hint');
    });
  }

  // 提示变化时才动 DOM：换高亮的键、换手的图层
  function updateHint() {
    var h = hintState();
    var codes = h.codes || [];
    var fp = codes.join(',') + '|' + h.text;

    if (fp === hintKey) return;
    hintKey = fp;

    hintCode = h.hand || '';

    document.querySelectorAll('.kb-key.is-hint').forEach(function (n) {
      n.classList.remove('is-hint');
    });
    codes.forEach(function (code) {
      var keyEl = document.querySelector('.kb-key[data-code="' + code + '"]');
      if (keyEl) keyEl.classList.add('is-hint');
    });

    syncHands();
    if (!document.querySelector('.kb-key.is-down')) {
      var live = el('kbState');
      if (live) live.textContent = h.text || '';
    }
  }

  function mountHands() {
    var host = el('handsSvg');
    if (!host || !window.HANDS_SVG) return;
    host.innerHTML = window.HANDS_SVG;
    syncHands();
    fitHands();
  }

  // ===== 手部与键位对位 =====
  // 画布 716.3×380。下面这张表是每个按键图层里「指尖」的坐标（单位＝SVG 单位，
  // 由 hand-both.svg 中 st5 高亮笔迹的顶点量得），和 DOM 里真实键心做最小二乘，
  // 求出「画布 → 屏幕」的等比缩放 s 与平移 tx/ty，直接写成 transform。
  // 这样键盘宽度、键帽大小、行高怎么变，手指都会重新落到键上，不依赖任何魔法数。
  var HAND_CANVAS_H = 380;
  var HAND_TIPS = {
    KeyA: [171.7, 151.0], KeyS: [203.5, 146.7], KeyD: [230.9, 147.9], KeyF: [262.4, 149.5],
    KeyJ: [355.4, 146.1], KeyK: [383.4, 142.9], KeyL: [410.5, 145.8], Semicolon: [439.3, 151.0]
  };

  function fitHands() {
    var host = el('handsSvg');
    var wrap = host && host.parentNode;
    if (!host || !wrap || !host.firstChild) return;

    var wr = wrap.getBoundingClientRect();
    if (wr.width < 1) return; // 窄屏键盘整块隐藏，量不到

    // 只取主键区八键：那是手停留时间最长的位置，其余行是抬手瞬间的姿势层，
    // 画稿本身带几像素误差，混进去反而把整体拟合拽偏。
    var pairs = [];
    for (var code in HAND_TIPS) {
      if (!Object.prototype.hasOwnProperty.call(HAND_TIPS, code)) continue;
      var key = document.querySelector('.kb-key[data-code="' + code + '"]');
      if (!key) continue;
      var r = key.getBoundingClientRect();
      if (r.width < 1) continue;
      pairs.push([HAND_TIPS[code][0], HAND_TIPS[code][1],
        r.left + r.width / 2 - wr.left, r.top + r.height / 2 - wr.top]);
    }
    if (pairs.length < 2) return;

    // 等比缩放 + 平移（无旋转）：先去均值，再 s = Σ(a·b) / Σ|a|²
    var n = pairs.length, mx = 0, my = 0, kx = 0, ky = 0, i;
    for (i = 0; i < n; i++) {
      mx += pairs[i][0]; my += pairs[i][1];
      kx += pairs[i][2]; ky += pairs[i][3];
    }
    mx /= n; my /= n; kx /= n; ky /= n;

    var num = 0, den = 0;
    for (i = 0; i < n; i++) {
      var ax = pairs[i][0] - mx, ay = pairs[i][1] - my;
      num += ax * (pairs[i][2] - kx) + ay * (pairs[i][3] - ky);
      den += ax * ax + ay * ay;
    }
    if (den < 1) return;

    var s = num / den;
    if (!(s > 0)) return;
    var tx = kx - s * mx, ty = ky - s * my;

    host.style.transform = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) +
      'px) scale(' + s.toFixed(4) + ')';

    // 手腕的淡出终点：把「可视底边」反算回画布坐标，缩放变化后渐变才不会被推到视野外。
    // 底边＝键位底 + 面板下内边距（那里就是卡片裁切线）
    var panel = wrap.parentNode;
    var padBottom = parseFloat(window.getComputedStyle(panel).paddingBottom) || 0;
    var localEnd = (wrap.clientHeight + padBottom - ty) / s;
    var pct = localEnd / HAND_CANVAS_H * 100;
    host.style.setProperty('--hand-fade-end', Math.min(100, Math.max(45, pct)).toFixed(1) + '%');
  }

  // 键盘尺寸随视口变化（键帽 1:1、矮屏收窄面板），每次变化都要重新对位
  var fitRaf = 0;
  function scheduleFitHands() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitHands();
    });
  }

  function clearKeyboard() {
    document.querySelectorAll('.kb-key.is-down').forEach(function (n) { n.classList.remove('is-down'); });
    heldStack = [];
    clearHint();
    syncHands();
    var live = el('kbState');
    if (live) live.textContent = '等待输入';
  }

  function showKeyboard(on) {
    var dock = el('keyboardDock');
    if (!dock) return;
    dock.classList.toggle('on', !!on);
    dock.setAttribute('aria-hidden', on ? 'false' : 'true');
    var drill = document.querySelector('.drill');
    if (drill) drill.classList.toggle('kb-open', !!on);
    if (on) { syncHands(); fitHands(); } else clearKeyboard();
  }

  function visualKey(e, down) {
    if (state.view !== 'drill') return;
    if (state.phase !== 'typing' && state.phase !== 'recall') return;
    // 抬起一律处理：否则按着键切走焦点时，手会一直停在下压姿势
    if (down && state.phase === 'typing' && document.activeElement !== el('typeInput')) return;
    var code = eventCode(e);
    if (!code) return;
    var key = document.querySelector('.kb-key[data-code="' + code + '"]');
    if (!key) return;

    key.classList.toggle('is-down', !!down);
    if (down) heldPush(code); else heldDrop(code);
    syncHands();
    var finger = FINGER_MAP[code];

    if (down) {
      var name = FINGER_NAMES[finger] || '';
      el('kbState').textContent = (key.dataset.label || '') + (name ? ' · ' + name : '');
    } else if (!document.querySelector('.kb-key.is-down')) {
      el('kbState').textContent = hintState().text || '';
    }
  }

  // ================= 音效 =================
  var actx = null;
  var noiseBuf = null;

  function ensureCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function noiseSource() {
    if (!noiseBuf) {
      // 一段平坦白噪，包络完全交给 gain 控制，这样每次敲击都能硬起硬落
      var len = Math.floor(actx.sampleRate * 0.06);
      noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    var s = actx.createBufferSource();
    s.buffer = noiseBuf;
    return s;
  }

  // 机械键盘「嗒」：1.5ms 起音 + 十几毫秒急收，不留尾巴
  // kind: 'down' 按下 / 'up' 抬起 / 'space' 空格 / 'enter' 回车
  var CLICK = {
    down: { f: 3300, q: 0.95, hp: 1300, dur: 0.021, amp: 0.62, body: 0.042, bf: 620 },
    up: { f: 4700, q: 1.2, hp: 2200, dur: 0.012, amp: 0.30, body: 0.012, bf: 760 },
    space: { f: 2900, q: 0.8, hp: 1100, dur: 0.025, amp: 0.68, body: 0.058, bf: 420 },
    enter: { f: 2600, q: 0.78, hp: 1000, dur: 0.028, amp: 0.70, body: 0.062, bf: 350 }
  };

  function keyClick(kind) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;

    var c = CLICK[kind] || CLICK.down;
    var t = actx.currentTime;
    var j = 0.94 + Math.random() * 0.12;

    try {
      var src = noiseSource();
      var bp = actx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = c.f * j;
      bp.Q.value = c.q;

      var hp = actx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = c.hp;

      // 提亮 7.2kHz，让「嗒」更脆
      var pk = actx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = 7200 * j;
      pk.Q.value = 1.1;
      pk.gain.value = 8;

      var g1 = actx.createGain();
      g1.gain.setValueAtTime(0, t);
      g1.gain.linearRampToValueAtTime(c.amp, t + 0.0015);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);

      src.connect(bp); bp.connect(hp); hp.connect(pk); pk.connect(g1); g1.connect(actx.destination);
      src.start(t); src.stop(t + c.dur + 0.004);

      // 一点点腔体厚度，只做 10ms 左右的起音，不拖
      if (c.body > 0.012) {
        var o = actx.createOscillator();
        var g2 = actx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(c.bf * j, t);
        o.frequency.exponentialRampToValueAtTime(c.bf * 0.5, t + c.dur * 0.7);
        g2.gain.setValueAtTime(0, t);
        g2.gain.linearRampToValueAtTime(c.body, t + 0.0018);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + c.dur * 0.8);
        o.connect(g2); g2.connect(actx.destination);
        o.start(t); o.stop(t + c.dur);
      }
    } catch (e) {}
  }

  function beep(freq, dur, type, vol) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;
    try {
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      o.connect(g); g.connect(actx.destination);
      var t = actx.currentTime;
      g.gain.setValueAtTime(vol || 0.04, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }

  function isClickKey(e) {
    var k = e.key;
    if (!k) return false;
    return k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta' &&
      k !== 'CapsLock' && k !== 'AltGraph' && k !== 'Tab' && k !== 'Dead' &&
      k !== 'ContextMenu' && k !== 'Escape';
  }

  // 打错的提示音：两声下行的方波，明显区别于键盘咔声
  function errBeep(vol) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;
    try {
      var t = actx.currentTime;
      var lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1900;
      lp.connect(actx.destination);

      [0, 0.085].forEach(function (off, i) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'square';
        o.frequency.value = i ? 152 : 214;
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.linearRampToValueAtTime(vol || 0.15, t + off + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.075);
        o.connect(g); g.connect(lp);
        o.start(t + off); o.stop(t + off + 0.09);
      });
    } catch (e) {}
  }

  // ================= 发音 =================
  var player = null;
  var preloader = null;

  function voiceUrl(word) {
    return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=2';
  }

  function tts(word) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.92;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function speak(word, force) {
    if (!word) return;
    if (!db.settings.autoplay && !force) return;

    var fellBack = false;
    var fallback = function () {
      if (fellBack) return;
      fellBack = true;
      tts(word);
    };

    try {
      if (!player) player = new Audio();
      player.onerror = fallback;
      player.pause();
      player.src = voiceUrl(word);
      var p = player.play();
      if (p && p.catch) p.catch(fallback);
    } catch (e) {
      fallback();
    }
  }

  // 预取下一个词的发音（只窥探，不改动队列）
  function peekNext() {
    for (var i = 0; i < state.retry.length; i++) {
      if (state.retry[i].at <= state.step) return state.retry[i].w;
    }
    if (state.forced.length) return state.forced[0];
    var due = duePool(Date.now());
    if (due.length) return due[0].w;
    return nextNew();
  }

  function preloadNext() {
    var n = peekNext();
    if (!n) return;
    try {
      if (!preloader) { preloader = new Audio(); preloader.preload = 'auto'; }
      preloader.src = voiceUrl(n.w);
    } catch (e) {}
  }

  // ================= 文本处理 =================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalize(s) {
    return String(s)
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。、；：！？·…—\-–—""''（）()《》〈〉【】\[\]{}~～]/g, '')
      .toLowerCase();
  }

  function extractAnswer(def) {
    var s = String(def).replace(/^[a-zA-Z]{1,5}\.\s*/, '');
    s = s.split(/[；;、\/]/)[0];
    s = s.replace(/[\s，。,.；;、：:]/g, '');
    return s.slice(0, 14);
  }

  // ================= 拼音 =================
  var HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/;
  var pyCache = {};

  // 返回与字符一一对应的无声调拼音；非汉字位置为空串
  function pinyinAlign(text) {
    if (pyCache[text]) return pyCache[text];

    var chars = Array.from(text);
    var out = chars.map(function () { return ''; });
    var zh = '', idx = [];

    chars.forEach(function (c, i) {
      if (HAN.test(c)) { zh += c; idx.push(i); }
    });

    var arr = [];
    if (zh && window.pinyinPro) {
      try {
        arr = window.pinyinPro.pinyin(zh, { toneType: 'none', type: 'array', nonZh: 'removed' }) || [];
      } catch (e) { arr = []; }
    }

    idx.forEach(function (pos, k) {
      var p = String(arr[k] || '').toLowerCase();
      out[pos] = /^[a-zü]+$/.test(p) ? p : '';
    });

    pyCache[text] = out;
    return out;
  }

  // ================= 视图切换 =================
  function setView(name) {
    state.view = name;
    ['drill', 'done', 'stats', 'words'].forEach(function (v) {
      var node = el('view-' + v);
      if (node) node.classList.toggle('is-active', v === name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name || (name === 'done' && b.dataset.view === 'drill'));
    });
    if (name === 'stats') renderStats();
    if (name === 'words') renderWords(true);
    // 键盘只跟着学习区走，切到统计/词库时收起
    showKeyboard(name === 'drill');
    if (name === 'drill') updateHint();
    // 学习页锁住文档滚动：练习时页面不能因为聚焦、锚定或内容变高而整体位移
    var lock = name === 'drill';
    document.documentElement.classList.toggle('is-drill-locked', lock);
    document.body.classList.toggle('is-drill-locked', lock);
    if (!lock) window.scrollTo(0, 0);
  }

  // ================= 学习流程 =================
  // 没有「每日任务」：进来就接着上次的位置往下走，取词规则见 pickNext
  function loadNext() {
    var pick = pickNext();
    if (!pick) { endAll(); return; }
    setView('drill');
    loadWord(pick.w, pick.mode);
  }

  function startTimer() {
    stopTimer();
    el('drillTimer').textContent = '00:00';
    startedAt = Date.now();
    timerId = setInterval(function () {
      el('drillTimer').textContent = mmss(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function loadWord(w, mode) {
    state.current = w;
    state.origin = mode || 'new';
    state.phase = 'recall';
    state.grade = 0;
    state.errors = 0;
    state.mistakes = 0;
    state.locked = false;
    state.lockValue = '';
    state.wordStart = Date.now();

    el('wordText').textContent = w.w;
    el('stageMode').textContent = mode === 'retry' ? '巩固记忆' : mode === 'due' ? '间隔复习' : '看词自评';
    el('wordPhonetic').textContent = w.ph || '';
    el('fullDef').textContent = w.def;
    el('fullDef').classList.remove('show');
    // 三个自评选项在看词阶段就出现：先凭印象定级，定完才揭晓中文
    el('rateRow').classList.add('show');
    el('typeRow').classList.remove('show');
    // 这一屏还没有答案，把答案区收起来，别留一大片空白
    document.querySelector('.drill').classList.add('is-recall');
    // 键盘常驻：从看词自评这一屏就摆出来，提示当前该按什么
    showKeyboard(true);

    var inp = el('typeInput');
    inp.value = '';
    inp.disabled = true;
    inp.classList.remove('is-ok', 'is-bad');
    state.committed = '';
    state.comp = '';

    setFeedback('');
    renderAnswer();
    renderProgress();
    el('hints').textContent = hintText(w, state.origin);

    if (db.settings.autoplay) speak(w.w);
    preloadNext();
  }

  // 提示语随取词来源变化，让人知道这是刚见过的词
  function hintText(w, mode) {
    var tail = '　·　R 重听发音';
    var rate = 'J 忘了　·　K 模糊　·　L 很熟';
    if (mode === 'retry') return '这个词刚才没记住，再打一遍　·　' + rate + tail;
    if (mode === 'due') {
      var r = db.records[w.w];
      var gap = r && r.lastAt ? humanGap(Date.now() - r.lastAt) : '';
      return '复习' + (gap ? ' · 上次是 ' + gap + '前' : '') + '　·　' + rate + tail;
    }
    return '先凭印象判断：' + rate + tail;
  }

  function renderProgress() {
    var ws = allWords();
    var learned = 0;
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.seen > 0) learned++;
    }
    var total = ws.length || 1;
    el('drillIndex').textContent = '已学 ' + learned + ' / ' + ws.length;
    el('drillBar').style.width = (learned / total) * 100 + '%';
  }

  // ================= 打字判定 =================
  function firstMismatch(typed) {
    var w = state.current;
    if (!w) return -1;
    var chars = Array.from(w.a || '');
    for (var i = 0; i < typed.length; i++) {
      if (i >= chars.length || typed[i] !== chars[i]) return i;
    }
    return -1;
  }

  function onWrongChar() {
    errBeep(0.16);
    var ans = el('answerText');
    ans.classList.add('shake');
    setTimeout(function () { ans.classList.remove('shake'); }, 340);
    setFeedback('打错了 · Backspace 删掉这个字再继续', 'bad');
  }

  function refreshTyped() {
    var inp = el('typeInput');
    state.committed = inp.value;
    var bad = firstMismatch(Array.from(state.committed));

    if (bad >= 0) {
      if (!state.locked) {
        state.locked = true;
        state.lockValue = inp.value;
        state.mistakes += 1;
        onWrongChar();
      }
    } else if (state.locked) {
      state.locked = false;
      setFeedback('');
    }

    renderAnswer();
  }

  // 上锁期间只接受从尾部删除，其它一律回滚
  function acceptEdit() {
    var inp = el('typeInput');
    if (state.locked) {
      var v = inp.value, old = state.lockValue;
      var isDelete = v.length < old.length && old.indexOf(v) === 0;
      if (v !== old && !isDelete) {
        inp.value = old;
        renderAnswer();
        beep(120, 0.03, 'square', 0.028);
        return;
      }
    }
    refreshTyped();
  }

  function renderAnswer() {
    var w = state.current;
    if (!w) return;

    var host = el('answerText');
    var chars = Array.from(w.a || '');
    var py = pinyinAlign(w.a || '');
    var typed = Array.from(state.committed || '');
    var masked = state.phase === 'recall' || state.phase === 'idle';
    var hide = db.settings.hideAnswer && state.phase === 'typing';
    var showPy = !masked && !hide && db.settings.showPinyin !== false;

    // 自评阶段整个答案区都不出现，连字数也不透露
    if (masked) {
      host.innerHTML = '';
      updateHint();
      return;
    }

    // 每个字起始位置对应的字母序号
    var pre = [0];
    for (var k = 0; k < chars.length; k++) pre.push(pre[k] + (py[k] || '').length);
    var base = pre[Math.min(typed.length, chars.length)];

    // 输入法组词中：数出当前已经敲对的字母（前缀匹配，错位即停）
    var compOn = 0;
    var comp = String(state.comp || '').toLowerCase().replace(/[^a-z]/g, '');
    if (showPy && comp && !state.locked) {
      var rest = '';
      for (var j = typed.length; j < chars.length; j++) rest += (py[j] || '');
      rest = rest.replace(/ü/g, 'v');
      var n = 0;
      while (n < comp.length && n < rest.length && comp.charAt(n) === rest.charAt(n)) n++;
      compOn = n;
    }

    var html = '';

    // 下一个待敲字母在整串拼音里的序号（用于拼音行与键盘的同步提示）
    var nextIdx = base + compOn;
    // 一路走到整条拼音串末尾：字边界不再是提示的终点
    var nxLimit = pre[chars.length];

    chars.forEach(function (ch, i) {
      var cls = 'pending';
      if (i < typed.length) cls = typed[i] === ch ? 'ok' : 'bad';

      if (hide) {
        var color = cls === 'ok' ? '--accent' : cls === 'bad' ? '--bad' : '--pending';
        html += '<span class="cell"><span class="py"></span>' +
          '<span class="mask" style="opacity:1;background:var(' + color + ')"></span></span>';
        return;
      }

      var pyHtml = '';
      var p = py[i] || '';
      if (showPy && p) {
        pyHtml = Array.from(p).map(function (L, li) {
          var g = pre[i] + li;
          var on = i < typed.length
            ? cls === 'ok'
            : (g >= base && g < base + compOn);
          // 紧挨着已敲字母后的那一个，就是键盘上要提示、手指要落下的字母
          var nx = (!on && !state.locked && state.phase === 'typing' && g === nextIdx && nextIdx < nxLimit);
          return '<i class="' + (on ? 'on' : '') + (nx ? ' nx' : '') + '">' + esc(L) + '</i>';
        }).join('');
      }

      html += '<span class="cell">' +
        '<span class="py">' + pyHtml + '</span>' +
        '<span class="ch ' + cls + '">' + esc(ch) + '</span>' +
        '</span>';
    });

    if (!hide && typed.length > chars.length) {
      for (var i = chars.length; i < typed.length; i++) {
        html += '<span class="cell"><span class="py"></span>' +
          '<span class="ch bad">' + esc(typed[i]) + '</span></span>';
      }
    }

    host.innerHTML = html;
    updateHint();
  }

  function setFeedback(msg, kind) {
    var f = el('feedback');
    f.textContent = msg || '';
    f.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  // 自评即揭示：三个选项在看词阶段就摆着，选完才把中文释义放出来
  function rate(g) {
    if (state.phase !== 'recall') return;
    state.grade = g;
    state.phase = 'typing';
    el('stageMode').textContent = '中文打字';
    el('fullDef').classList.add('show');
    el('rateRow').classList.remove('show');
    el('typeRow').classList.add('show');
    document.querySelector('.drill').classList.remove('is-recall');
    showKeyboard(true);
    beep(520, 0.05, 'sine', 0.03);

    var inp = el('typeInput');
    inp.disabled = false;
    inp.value = '';
    state.committed = '';
    state.comp = '';
    state.locked = false;
    state.lockValue = '';
    // preventScroll：聚焦输入框时不要顺手把页面滚一下
    try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }

    renderAnswer();
    setFeedback('');
    el('hints').textContent = 'Enter 提交　·　打错会锁住，Backspace 删掉重来';
  }

  function submit() {
    if (state.phase !== 'typing') return;

    var w = state.current;
    var inp = el('typeInput');
    var typed = inp.value;
    if (!typed.trim()) return;

    if (normalize(typed) === normalize(w.a)) {
      finish(true);
      return;
    }

    state.errors += 1;
    inp.classList.add('is-bad');
    el('typeRow').classList.add('shake');
    errBeep(0.14);
    setTimeout(function () { el('typeRow').classList.remove('shake'); }, 360);

    if (state.errors >= MAX_TRIES) {
      state.phase = 'judged';
      inp.value = w.a;
      state.committed = w.a;
      state.comp = '';
      state.locked = false;
      state.lockValue = '';
      renderAnswer();
      setFeedback('已给出答案 · 这个词记为「忘了」', 'bad');
      setTimeout(function () { finish(false, 1); }, 1200);
      return;
    }

    setFeedback('不对，再试一次（还剩 ' + (MAX_TRIES - state.errors) + ' 次）', 'bad');
    inp.value = '';
    state.committed = '';
    state.comp = '';
    state.locked = false;
    state.lockValue = '';
    renderAnswer();
    setTimeout(function () { inp.classList.remove('is-bad'); }, 500);
  }

  function finish(ok, forcedGrade) {
    if (state.phase === 'judged' && !forcedGrade) return;
    state.phase = 'judged';
    updateHint();   // 这一词已结束，清掉键位提示

    var w = state.current;
    var rec = getRec(w.w);
    var wasNew = rec.seen === 0;

    var grade = forcedGrade || state.grade || 2;
    if (db.settings.hideAnswer && state.errors > 0) grade = Math.min(grade, 2);

    applyGrade(rec, grade);
    rec.seen += 1;
    rec.lastAt = Date.now();
    if (!ok || state.errors > 0 || state.mistakes > 0) rec.wrong += 1;

    var d = dayEntry();
    d.words += 1;
    d.chars += Array.from(w.a).length;
    d.seconds += Math.max(1, (Date.now() - state.wordStart) / 1000);
    if (ok && state.errors === 0 && state.mistakes === 0) d.clean += 1;
    if (wasNew) d.newWords += 1;

    // 忘了、模糊的词在本次学习里换个位置再出现一次：
    // 忘了插在 4~6 个词之后（趁还有印象），模糊插在 11~14 个词之后（稍稍拉开）
    if (grade === 1) {
      scheduleRetry(w, 4 + Math.round(Math.random() * 2));
    } else if (grade === 2) {
      scheduleRetry(w, 11 + Math.round(Math.random() * 3));
    }

    save();

    var inp = el('typeInput');
    if (ok) {
      inp.classList.remove('is-bad');
      inp.classList.add('is-ok');
      setFeedback('对了', 'ok');
      beep(660, 0.07, 'sine', 0.04);
      setTimeout(function () { beep(990, 0.09, 'sine', 0.032); }, 75);
      setTimeout(next, 430);
    } else {
      setFeedback('已给出答案 · 记为「忘了」', 'bad');
      setTimeout(next, 1150);
    }
  }

  function scheduleRetry(w, gap) {
    for (var i = 0; i < state.retry.length; i++) {
      if (state.retry[i].w.w === w.w) {
        state.retry[i].at = state.step + gap;
        return;
      }
    }
    state.retry.push({ w: w, at: state.step + gap });
  }

  function next() {
    state.step += 1;
    loadNext();
  }

  // 整本书都学过、且没有到期复习时才会走到这里
  function endAll() {
    stopTimer();
    var d = dayEntry();
    var cpm = d.seconds ? Math.round(d.chars / (d.seconds / 60)) : 0;
    var acc = d.words ? Math.round((d.clean / d.words) * 100) : 0;

    el('doneTitle').textContent = '整本书都过完了，暂时没有到期的词';
    el('doneWords').textContent = d.words;
    el('doneAcc').innerHTML = acc + '<small>%</small>';
    el('doneCpm').innerHTML = cpm + '<small>字/分</small>';
    el('doneTime').innerHTML = Math.max(1, Math.round(d.seconds / 60)) + '<small>分</small>';

    state.current = null;
    state.phase = 'idle';
    setView('done');
  }

  function forceBatch(n) {
    var batch = reviewBatch(n);
    if (!batch.length) return;
    state.retry = [];
    state.step = 0;
    state.forced = batch;
    startTimer();
    loadNext();
  }

  // ================= 统计 =================
  function renderStats() {
    var keys = Object.keys(db.days).sort();
    var tw = 0, tc = 0, tch = 0, ts = 0;
    keys.forEach(function (k) {
      var d = db.days[k];
      tw += d.words; tc += d.clean; tch += d.chars; ts += d.seconds;
    });

    var mastered = 0;
    Object.keys(db.records).forEach(function (k) {
      if (db.records[k].seen > 0) mastered++;
    });

    el('statWords').textContent = tw;
    el('statAcc').innerHTML = (tw ? Math.round((tc / tw) * 100) : 0) + '<small>%</small>';
    el('statCpm').innerHTML = (ts ? Math.round(tch / (ts / 60)) : 0) + '<small>字/分</small>';
    el('statMastered').textContent = mastered;

    var recent = keys.slice(-14);

    var accPts = recent.map(function (k) {
      var d = db.days[k];
      return { k: k, v: d.words ? (d.clean / d.words) * 100 : 0 };
    });
    var cpmPts = recent.map(function (k) {
      var d = db.days[k];
      return { k: k, v: d.seconds ? d.chars / (d.seconds / 60) : 0 };
    });

    el('accLatest').textContent = accPts.length ? Math.round(accPts[accPts.length - 1].v) + '%' : '';
    el('cpmLatest').textContent = cpmPts.length ? Math.round(cpmPts[cpmPts.length - 1].v) + ' 字/分' : '';

    renderChart(document.querySelector('.chart[data-series="acc"]'), accPts, 100, 'var(--ok)', '');
    renderChart(document.querySelector('.chart[data-series="cpm"]'), cpmPts, 0, 'var(--muted)', '');
  }

  var chartSeq = 0;

  function renderChart(host, pts, fixedMax, color, unit) {
    if (!host) return;
    if (!pts.length) {
      host.innerHTML = '<div class="empty-note">还没有数据，先练几个词</div>';
      return;
    }

    var gid = 'chartGrad' + (++chartSeq);
    var W = 640, H = 150, PL = 42, PR = 16, PT = 16, PB = 28;
    var iw = W - PL - PR, ih = H - PT - PB;

    var maxV = fixedMax || Math.max.apply(null, pts.map(function (p) { return p.v; }).concat([1])) * 1.18;
    var X = function (i) { return pts.length === 1 ? PL + iw / 2 : PL + (iw * i) / (pts.length - 1); };
    var Y = function (v) { return PT + ih - (Math.min(v, maxV) / maxV) * ih; };

    var line = '';
    pts.forEach(function (p, i) {
      line += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1) + ' ';
    });

    var area = line + 'L' + X(pts.length - 1).toFixed(1) + ' ' + (PT + ih) +
      ' L' + X(0).toFixed(1) + ' ' + (PT + ih) + ' Z';

    var dots = pts.map(function (p, i) {
      return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) +
        '" r="2.7" fill="var(--surface)" stroke="' + color + '" stroke-width="1.6" />';
    }).join('');

    var grid = '';
    [0, 0.5, 1].forEach(function (t) {
      var y = PT + ih - t * ih;
      grid += '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
        '" stroke="var(--line)" stroke-width="1" />';
      grid += '<text x="' + (PL - 8) + '" y="' + (y + 4) + '" text-anchor="end" ' +
        'font-size="10" font-family="ui-monospace, Menlo, Consolas, monospace" fill="var(--faint)">' +
        Math.round(maxV * t) + '</text>';
    });

    var labels = '';
    var step = pts.length > 1 ? Math.ceil(pts.length / 5) : 1;
    pts.forEach(function (p, i) {
      if (i % step !== 0 && i !== pts.length - 1) return;
      labels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" ' +
        'font-size="10" font-family="ui-monospace, Menlo, Consolas, monospace" fill="var(--faint)">' +
        p.k.slice(5) + '</text>';
    });

    host.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.11" />' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0" />' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + gid + ')" />' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round" />' +
      dots + labels +
      '</svg>';
  }

  // ================= 词库 =================
  var WORD_CHUNK = 200;
  var wordFilter = '';
  var wordShown = 0;
  var wordMatched = 0;

  function wordRow(w) {
    var r = db.records[w.w];
    var badge = '<span class="badge">未学</span>';
    if (r && r.seen > 0) {
      var left = (r.dueAt || 0) - Date.now();
      if (left <= 0) {
        badge = '<span class="badge bad">该复习了</span>';
      } else if (r.last === 1) {
        badge = '<span class="badge bad">' + humanGap(left) + '后再来</span>';
      } else {
        badge = '<span class="badge ok">' + humanGap(left) + '后复习</span>';
      }
    }
    return '<tr>' +
      '<td class="w">' + esc(w.w) + '</td>' +
      '<td class="p">' + esc(w.ph || '—') + '</td>' +
      '<td class="a">' + esc(w.a) + '</td>' +
      '<td>' + badge + '</td>' +
      '</tr>';
  }

  function renderWords(reset) {
    var words = allWords();
    var q = wordFilter.trim().toLowerCase();

    if (q) {
      words = words.filter(function (w) {
        return w.w.toLowerCase().indexOf(q) >= 0 ||
          String(w.def || '').toLowerCase().indexOf(q) >= 0 ||
          String(w.a || '').indexOf(wordFilter.trim()) >= 0;
      });
    }
    wordMatched = words.length;

    if (reset) {
      el('wordTableBody').innerHTML = '';
      wordShown = 0;
    }

    var slice = words.slice(wordShown, wordShown + WORD_CHUNK);
    if (slice.length) {
      el('wordTableBody').insertAdjacentHTML('beforeend', slice.map(wordRow).join(''));
      wordShown += slice.length;
    }

    var total = allWords().length;
    el('wordCount').textContent = q
      ? '匹配 ' + wordMatched + ' 词 / 共 ' + total
      : '显示 ' + wordShown + ' / ' + total;

    var more = el('btnMoreWords');
    if (more) more.hidden = wordShown >= wordMatched;
  }

  function parseImport(text) {
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var out = [];

    lines.forEach(function (line) {
      var parts = line.split(/\s*[|｜\t]\s*/);
      if (parts.length < 2) parts = line.split(/\s*[,，]\s*/);
      if (parts.length < 2) return;

      var w = parts[0].trim();
      if (!/^[a-zA-Z][a-zA-Z' \-]*$/.test(w)) return;

      var ph = '', def = '';
      if (parts.length >= 3) {
        ph = parts[1].trim();
        def = parts.slice(2).join(' ').trim();
      } else {
        def = parts[1].trim();
      }

      var a = extractAnswer(def);
      if (!a) return;
      out.push({ w: w, ph: ph, def: def, a: a });
    });

    return out;
  }

  function doImport() {
    var text = el('importText').value;
    var parsed = parseImport(text);

    if (!parsed.length) {
      el('importHint').textContent = '没认出有效的词，检查一下分隔符';
      return;
    }

    var existing = {};
    allWords().forEach(function (w) { existing[w.w.toLowerCase()] = true; });

    var added = 0;
    parsed.forEach(function (w) {
      if (existing[w.w.toLowerCase()]) return;
      existing[w.w.toLowerCase()] = true;
      db.custom.push(w);
      added++;
    });

    save();
    wordCache = null;
    el('importHint').textContent = '导入 ' + added + ' 个新词（跳过重复 ' + (parsed.length - added) + ' 个）';
    el('importText').value = '';
    renderWords(true);
  }

  // ================= 设置 =================
  function applySettings() {
    document.documentElement.dataset.theme = db.settings.theme;
    document.documentElement.style.setProperty('--scale', db.settings.fontScale);
    syncControls();
  }

  function syncControls() {
    document.querySelectorAll('[data-toggle]').forEach(function (node) {
      node.classList.toggle('on', !!db.settings[node.dataset.toggle]);
    });
    document.querySelectorAll('[data-seg]').forEach(function (seg) {
      var key = seg.dataset.seg;
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', String(db.settings[key]) === b.dataset.val);
      });
    });
  }

  function openDrawer() {
    el('drawer').classList.add('open');
    el('drawerMask').classList.add('open');
  }

  function closeDrawer() {
    el('drawer').classList.remove('open');
    el('drawerMask').classList.remove('open');
  }

  // ================= 事件绑定 =================
  function bind() {
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'drill') {
          // 已经有正在学的词就原样回来，不要跳到下一个（不然敲一半的内容会丢）
          if (!state.current) {
            if (!timerId) startTimer();
            loadNext();
          } else {
            setView('drill');
          }
          return;
        }
        setView(b.dataset.view);
      });
    });

    el('btnTheme').addEventListener('click', function () {
      db.settings.theme = db.settings.theme === 'dark' ? 'light' : 'dark';
      save();
      applySettings();
    });

    el('btnSettings').addEventListener('click', openDrawer);
    el('btnDrawerClose').addEventListener('click', closeDrawer);
    el('drawerMask').addEventListener('click', closeDrawer);

    el('btnAgain').addEventListener('click', function () { forceBatch(15); });
    el('btnHome').addEventListener('click', function () { setView('stats'); });

    el('btnSpeak').addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.current) speak(state.current.w, true);
    });

    document.querySelectorAll('.rate').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        rate(parseInt(b.dataset.grade, 10));
      });
    });

    var inp = el('typeInput');

    inp.addEventListener('compositionstart', function () {
      state.composing = true;
      state.comp = '';
    });

    // 组词过程中实时读拼音，逐字母点亮
    inp.addEventListener('compositionupdate', function (e) {
      state.composing = true;
      state.comp = e.data || '';
      renderAnswer();
    });

    inp.addEventListener('compositionend', function () {
      state.composing = false;
      state.comp = '';
      acceptEdit();
    });

    inp.addEventListener('input', function () {
      if (state.composing) return;
      acceptEdit();
    });

    // 锁定时拦掉一切插入（含粘贴、拖入）
    inp.addEventListener('beforeinput', function (e) {
      if (!state.locked) return;
      var t = e.inputType || '';
      if (t.indexOf('insert') === 0) {
        e.preventDefault();
        beep(120, 0.03, 'square', 0.028);
      }
    });

    inp.addEventListener('keydown', function (e) {
      // 长按不连发「咔」声，也避免误提交
      if (e.repeat) return;

      if (e.key === 'Enter') {
        if (e.isComposing || state.composing) { keyClick('enter'); return; }
        keyClick('enter');
        e.preventDefault();
        submit();
        return;
      }

      // 打错后锁死：只放行删除与方向键，其余按键无效
      if (state.locked && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        beep(120, 0.03, 'square', 0.028);
        return;
      }

      if (isClickKey(e)) keyClick(e.key === ' ' ? 'space' : 'down');
    });

    inp.addEventListener('keyup', function (e) {
      if (e.key === 'Enter') return;
      if (isClickKey(e)) keyClick('up');
    });

    document.addEventListener('keydown', function (e) {
      if (state.view !== 'drill') return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        if (tag === 'INPUT' && e.key !== 'Enter') return;
      }

      // 看词阶段先自评：J/K/L 定了级，才揭晓中文并进入打字
      if (state.phase === 'recall') {
        if (e.key === 'j' || e.key === 'J' || e.key === '1') { e.preventDefault(); rate(1); return; }
        if (e.key === 'k' || e.key === 'K' || e.key === '2') { e.preventDefault(); rate(2); return; }
        if (e.key === 'l' || e.key === 'L' || e.key === '3') { e.preventDefault(); rate(3); return; }
        if (e.key === 'r' || e.key === 'R') { if (state.current) speak(state.current.w, true); return; }
      }
    });

    document.addEventListener('keydown', function (e) { visualKey(e, true); });
    document.addEventListener('keyup', function (e) { visualKey(e, false); });
    window.addEventListener('blur', clearKeyboard);

    // 设置项
    document.querySelectorAll('[data-toggle]').forEach(function (node) {
      node.addEventListener('click', function () {
        var key = node.dataset.toggle;
        db.settings[key] = !db.settings[key];
        save();
        applySettings();
        if (key === 'sound' && db.settings.sound) beep(880, 0.06, 'sine', 0.04);
      });
    });

    document.querySelectorAll('[data-seg]').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = seg.dataset.seg;
          var val = b.dataset.val;
          db.settings[key] = key === 'fontScale' ? parseFloat(val) : val;
          save();
          applySettings();
        });
      });
    });

    el('btnImport').addEventListener('click', doImport);

    var searchTimer = null;
    el('wordSearch').addEventListener('input', function (e) {
      wordFilter = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { renderWords(true); }, 120);
    });

    el('btnMoreWords').addEventListener('click', function () { renderWords(false); });

    el('btnImportDemo').addEventListener('click', function () {
      el('importText').value =
        'apple | /ˈæpəl/ | n. 苹果；苹果树\n' +
        'abandon | /əˈbændən/ | v. 放弃；抛弃\n' +
        'fragile | /ˈfrædʒəl/ | adj. 脆弱的；易碎的';
    });

    el('btnReset').addEventListener('click', function () {
      if (!confirm('会清空所有学习记录和导入的词，确定吗？')) return;
      localStorage.removeItem(STORE_KEY);
      db = load();
      wordCache = null;
      state.retry = [];
      state.forced = [];
      state.step = 0;
      applySettings();
      closeDrawer();
      startTimer();
      loadNext();
    });
  }

  // ================= 启动 =================
  // 没有欢迎页也没有每日任务：打开就是接着上次的那个词
  buildKeyboard();
  mountHands();
  // 视口/容器尺寸一变，键位就动了，手要跟着重新落位
  window.addEventListener('resize', scheduleFitHands);
  window.addEventListener('orientationchange', scheduleFitHands);
  if (window.ResizeObserver) {
    var kbWrapEl = document.querySelector('.kb-wrap');
    if (kbWrapEl) new ResizeObserver(scheduleFitHands).observe(kbWrapEl);
  }
  applySettings();
  bind();
  startTimer();
  loadNext();

})();
