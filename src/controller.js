(() => {
  const C = window.QuiverCtl;
  const { tokenize, evaluate } = window.QuiverExpr;
  const remapper = window.quiverRemapper;
  const toast = window.quiverToast;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------- 状態 ----------------
  const ctl = (() => {
    const d = C.defaults();
    const s = load('quiver.ctl', null);
    if (!s) return d;
    return { ...d, ...s, mouse: { ...d.mouse, ...(s.mouse || {}) }, map: s.map || d.map };
  })();
  let selected = load('quiver.ctlSel', '0x0007001a');
  let srcView = load('quiver.ctlView', 'keyboard');
  let ctlWritten = load('quiver.ctlWritten', null);
  const down = new Set();

  const persist = () => { save('quiver.ctl', ctl); paintWrite(); };
  const isQuiverFw = () => remapper.connected && /quiver/i.test(remapper.name || '');
  const instant = () => !!C.TYPES[ctl.type]?.instant;
  const pauseWord = () => (instant() ? '切り替えキー' : '一時停止キー');
  // 揺れの設定（マウスモード）
  const shakeCfg = () => window.quiverShake.config();
  // 専用ファーム＋コントローラーオンのときは、揺れとコントローラーを1つの設定にまとめる
  window.quiverCombined = () => (instant() && ctl.enabled ? C.buildConfig(ctl, shakeCfg()) : null);
  const cfgKey = () => JSON.stringify(ctl);

  // ---------------- 汎用UI ----------------
  function seg(root, value, onChange) {
    const pill = root.querySelector('.seg-pill');
    const btns = $$('button', root);
    const place = () => {
      const b = btns.find((x) => x.getAttribute('aria-selected') === 'true') || btns[0];
      pill.style.width = b.offsetWidth + 'px';
      pill.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    const select = (v, emit) => {
      btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === String(v))));
      place();
      if (emit) onChange(v);
    };
    btns.forEach((b) => b.addEventListener('click', () => select(b.dataset.v, true)));
    new ResizeObserver(place).observe(root);
    select(value, false);
    return { select, place };
  }

  function confirmDialog(title, text, okLabel = 'OK') {
    const m = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel;
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('open'));
    return new Promise((resolve) => {
      const close = (v) => {
        m.classList.remove('open');
        setTimeout(() => (m.hidden = true), 220);
        $('#confirmOk').onclick = $('#confirmCancel').onclick = $('.modal-backdrop', m).onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
      document.addEventListener('keydown', onKey, true);
      $('#confirmOk').onclick = () => close(true);
      $('#confirmCancel').onclick = $('.modal-backdrop', m).onclick = () => close(false);
      $('#confirmOk').focus();
    });
  }

  // ---------------- ページ切り替え ----------------
  const nav = $('#nav');
  const navPill = $('.nav-pill', nav);
  function placeNav() {
    const b = $(`button[data-page="${document.body.dataset.page}"]`, nav);
    if (!b) return;
    navPill.style.width = b.offsetWidth + 'px';
    navPill.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  function goto(page) {
    document.body.dataset.page = page;
    $$('button', nav).forEach((b) => b.setAttribute('aria-current', String(b.dataset.page === page)));
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
    save('quiver.page', page);
    placeNav();
    if (page === 'controller') { srcSegCtl.place(); fitKeyboard(); }
  }
  $$('button', nav).forEach((b) => b.addEventListener('click', () => goto(b.dataset.page)));
  new ResizeObserver(placeNav).observe(nav);

  // デバイス表示（タイトルバー）
  function paintChip() {
    const on = remapper.connected;
    $('#deviceChip').dataset.state = on ? 'on' : 'off';
    const type = load('quiver.descriptor', 0);
    $('#chipText').textContent = on
      ? `${remapper.name || 'HID Remapper'} ・ ${isQuiverFw() && ctl.enabled && instant() ? '切り替え対応' : type === 0 ? 'マウスモード' : 'コントローラーモード'}`
      : '未接続';
    paintWrite();
  }
  remapper.addEventListener('connected', () => {
    paintChip();
    if (isQuiverFw() && ctl.type !== 'quiver' && !load('quiver.fwPrompted', false)) {
      save('quiver.fwPrompted', true);
      ctl.type = 'quiver'; changed();
      toast('Quiver専用ファームを検出したので、コントローラーの種類を「Quiver専用ファーム」にしました', 'ok', 5000);
    }
    paintTypes();
  });
  remapper.addEventListener('disconnected', () => { down.clear(); paintChip(); paintDown(); });

  // ---------------- 出力の表示 ----------------
  // compact: キーの上など小さい場所用（アイコンか短い文字だけ）
  function glyph(o, withLabel = false) {
    if (!o) return '';
    let g = '';
    if (o.face) g = `<span class="face f-${o.face}">${esc(o.short)}</span>`;
    else if (o.icon) g = `<span class="gl-ic">${o.icon}</span>`;
    if (!withLabel) return g || `<span class="gl-tx">${esc(o.short)}</span>`;
    return `${g}<span class="gl-lb">${esc(o.label)}</span>`;
  }

  // ---------------- 割り当ての参照 ----------------
  const outOf = (src) => {
    const m = ctl.map[src];
    return m ? C.output(ctl.type, m.out) : null;
  };
  const isMouseSrc = (src) => src === 'move' || !!C.MOUSE_BY_USAGE[src];
  const srcName = (src) => (src === 'move' ? 'マウスの移動' : C.sourceLabel(src));

  // ---------------- キーボード ----------------
  const kbd = $('#kbd');
  const KEY_ROWS = C.KEYBOARD.map((row) => row.slice());
  // 右Shiftを短くして ↑キーを置く
  KEY_ROWS[4] = KEY_ROWS[4].map((k) => (k.code === 'ShiftRight' ? { ...k, w: 1.75 } : k));
  const KB_WIDTH = 16.25;
  const keyEls = {};
  (function buildKeyboard() {
    const place = (key, x, y) => {
      const el = document.createElement('button');
      el.className = 'kc';
      el.dataset.usage = key.usage;
      el.style.setProperty('--x', x);
      el.style.setProperty('--y', y);
      el.style.setProperty('--w', key.w);
      el.innerHTML = `<span class="kc-label">${esc(key.label)}</span><span class="kc-out"></span>`;
      el.addEventListener('click', () => select(key.usage));
      kbd.appendChild(el);
      keyEls[key.usage] = el;
    };
    KEY_ROWS.forEach((row, ri) => {
      let x = 0;
      const y = ri === 0 ? 0 : ri + 0.35;
      for (const key of row) {
        if (key.gap) { x += key.gap; continue; }
        place(key, x, y);
        if (key.code === 'ArrowDown') place(C.ARROW_UP, x, y - 1);
        x += key.w;
      }
    });
  })();
  function fitKeyboard() {
    const w = kbd.parentElement.clientWidth;
    const u = Math.min(64, Math.max(30, Math.floor(w / KB_WIDTH)));
    kbd.style.setProperty('--u', u + 'px');
  }
  new ResizeObserver(fitKeyboard).observe(kbd.parentElement);

  // ---------------- マウス ----------------
  const MOUSE_SVG = `
  <svg class="mouse-svg" viewBox="0 0 220 340" aria-hidden="true">
    <defs>
      <linearGradient id="mBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b1b"/><stop offset="1" stop-color="#0c0c0c"/></linearGradient>
    </defs>
    <path class="m-body" d="M110 18c52 0 86 34 88 98l4 104c2 68-40 104-92 104S16 288 18 220l4-104C24 52 58 18 110 18z" fill="url(#mBody)"/>
    <path class="m-zone" data-src="0x00090001" d="M106 22C60 24 30 54 26 112l-1 30h81z"/>
    <path class="m-zone" data-src="0x00090002" d="M114 22c46 2 76 32 80 90l1 30h-81z"/>
    <rect class="m-zone" data-src="0x00090003" x="101" y="66" width="18" height="30" rx="9"/>
    <rect class="m-zone wd" data-src="wheelUp" x="101" y="44" width="18" height="18" rx="7"/>
    <rect class="m-zone wd" data-src="wheelDown" x="101" y="100" width="18" height="18" rx="7"/>
    <path class="m-glyph" d="M106 55l4-4 4 4M106 107l4 4 4-4"/>
    <rect class="m-zone side" data-src="0x00090005" x="12" y="150" width="12" height="34" rx="5"/>
    <rect class="m-zone side" data-src="0x00090004" x="12" y="190" width="12" height="34" rx="5"/>
    <path class="m-zone move" data-src="move" d="M26 150h168l2 70c2 60-36 94-86 94s-88-34-86-94z"/>
    <g class="m-move-ic" transform="translate(110 236)">
      <path d="M0-22v44M-22 0h44M0-22l-5 6M0-22l5 6M0 22l-5-6M0 22l5-6M-22 0l6-5M-22 0l6 5M22 0l-6-5M22 0l-6 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
    </g>
  </svg>`;
  const MOUSE_CARDS = [
    { src: '0x00090001', side: 'l' },
    { src: '0x00090005', side: 'l' },
    { src: '0x00090004', side: 'l' },
    { src: 'move', side: 'l' },
    { src: '0x00090002', side: 'r' },
    { src: 'wheelUp', side: 'r' },
    { src: '0x00090003', side: 'r' },
    { src: 'wheelDown', side: 'r' },
  ];
  const mouseWrap = $('#mouseWrap');
  mouseWrap.innerHTML = `<div class="m-col l"></div><div class="m-center">${MOUSE_SVG}</div><div class="m-col r"></div>`;
  for (const c of MOUSE_CARDS) {
    const el = document.createElement('button');
    el.className = 'm-card';
    el.dataset.src = c.src;
    el.innerHTML = `<span class="m-card-name">${esc(srcName(c.src))}</span><span class="m-card-out"></span>`;
    el.addEventListener('click', () => select(c.src));
    el.addEventListener('mouseenter', () => $(`.m-zone[data-src="${c.src}"]`, mouseWrap)?.classList.add('hover'));
    el.addEventListener('mouseleave', () => $(`.m-zone[data-src="${c.src}"]`, mouseWrap)?.classList.remove('hover'));
    $(`.m-col.${c.side}`, mouseWrap).appendChild(el);
  }
  $$('.m-zone', mouseWrap).forEach((z) => {
    z.addEventListener('click', () => select(z.dataset.src));
    z.addEventListener('mouseenter', () => $(`.m-card[data-src="${z.dataset.src}"]`, mouseWrap)?.classList.add('hover'));
    z.addEventListener('mouseleave', () => $(`.m-card[data-src="${z.dataset.src}"]`, mouseWrap)?.classList.remove('hover'));
  });

  // ---------------- 表示の更新 ----------------
  function paintMap() {
    for (const [usage, el] of Object.entries(keyEls)) {
      const m = ctl.map[usage];
      const o = outOf(usage);
      const pause = usage === ctl.pauseKey;
      el.classList.toggle('mapped', !!o && m.on && !pause);
      el.classList.toggle('off', !!o && !m.on && !pause);
      el.classList.toggle('pause', pause);
      el.classList.toggle('sel', usage === selected);
      $('.kc-out', el).innerHTML = pause ? (instant() ? '切替' : '停止') : glyph(o);
    }
    for (const c of MOUSE_CARDS) {
      const card = $(`.m-card[data-src="${c.src}"]`, mouseWrap);
      const zone = $(`.m-zone[data-src="${c.src}"]`, mouseWrap);
      let html = '', mapped = false, off = false;
      if (c.src === 'move') {
        const st = ctl.mouse.stick;
        html = esc(st === 'off' ? '割り当てなし' : st === 'left' ? '左スティック' : '右スティック');
        mapped = st !== 'off' && ctl.mouse.on; off = st !== 'off' && !ctl.mouse.on;
      } else {
        const o = outOf(c.src), m = ctl.map[c.src];
        html = o ? glyph(o, true) : '割り当てなし';
        mapped = !!o && m.on; off = !!o && !m.on;
      }
      $('.m-card-out', card).innerHTML = html;
      for (const el of [card, zone]) {
        el.classList.toggle('mapped', mapped);
        el.classList.toggle('off', off);
        el.classList.toggle('sel', c.src === selected);
      }
    }
    const n = Object.values(ctl.map).filter((m) => m.on).length + (ctl.mouse.on && ctl.mouse.stick !== 'off' ? 1 : 0);
    $('#mapCount').textContent = `有効な割り当て ${n}`;
  }

  function paintDown() {
    for (const [usage, el] of Object.entries(keyEls)) el.classList.toggle('down', down.has(usage));
    for (const c of MOUSE_CARDS) {
      const on = down.has(c.src);
      $(`.m-card[data-src="${c.src}"]`, mouseWrap).classList.toggle('down', on);
      $(`.m-zone[data-src="${c.src}"]`, mouseWrap).classList.toggle('down', on);
    }
  }

  // ---------------- インスペクター ----------------
  const insp = $('#inspector');
  const PAD_BODY = `
    <svg class="cpad-body" viewBox="0 0 ${C.PAD_W} ${C.PAD_H}" aria-hidden="true">
      <path class="cp-shell" d="M62 56C104 48 140 54 180 54S256 48 298 56C334 64 350 118 355 174C360 228 344 250 316 250C292 250 278 236 262 230C246 224 222 234 180 234S114 224 98 230C82 236 68 250 44 250C16 250 0 228 5 174C10 118 26 64 62 56Z"/>
      <circle class="cp-well" cx="82" cy="112" r="47"/>
      <circle class="cp-well" cx="230" cy="180" r="47"/>
      <circle class="cp-well" cx="130" cy="180" r="38"/>
      <circle class="cp-well" cx="284" cy="112" r="45"/>
    </svg>`;
  const ARROW = (kind, rot) => kind === 'dpad'
    ? `<svg viewBox="0 0 16 16" style="transform:rotate(${rot}deg)"><path d="M8 2.8 13.6 10.8H2.4z" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 16 16" style="transform:rotate(${rot}deg)"><path d="M4.2 10 8 6.2l3.8 3.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function padButtons() {
    const cur = ctl.map[selected]?.out;
    const used = {};
    for (const [src, a] of Object.entries(ctl.map)) if (src !== selected && a.on && src !== ctl.pauseKey) used[a.out] = (used[a.out] || 0) + 1;
    return C.PAD_KEYS.map((key) => {
      const L = C.layoutOf(ctl.type, key), o = C.output(ctl.type, key);
      if (!L || !o) return '';
      let inner;
      if (L.kind === 'dir' || L.kind === 'dpad') inner = ARROW(L.kind, L.rot);
      else if (o.face) inner = `<b>${esc(o.short)}</b>`;
      else if (o.icon) inner = o.icon;
      else inner = `<span>${esc(o.short)}</span>`;
      const cls = ['cb', ...L.kind.split(' ').map((k) => 'k-' + k)];
      if (o.face) cls.push('f-' + o.face);
      if (cur === key) cls.push('active');
      if (used[key]) cls.push('used');
      return `<button class="${cls.join(' ')}" data-out="${key}" style="--cx:${L.cx};--cy:${L.cy};--w:${L.w};--h:${L.h}" aria-label="${esc(o.label)}" data-tip="${esc(o.label)}${used[key] ? `（ほかのキー${used[key]}個で使用中）` : ''}">${inner}</button>`;
    }).join('');
  }
  function paintInspector() {
    if (selected === 'move') { paintMoveInspector(); return; }
    const m = ctl.map[selected];
    const o = outOf(selected);
    const pause = selected === ctl.pauseKey;
    const mb = C.MOUSE_BY_USAGE[selected];
    const keycap = mb ? mb.short : (C.KEY_BY_USAGE[selected]?.label ?? '?');
    insp.innerHTML = `
      <div class="insp-head">
        <span class="big-cap${mb ? ' mouse' : ''}">${esc(keycap)}</span>
        <div class="insp-title">
          <span class="insp-name">${esc(srcName(selected))}</span>
          <span class="insp-out">${pause ? pauseWord() : o ? `<span class="arrow-to">→</span>${glyph(o, true)}` : '割り当てなし'}</span>
        </div>
        <label class="switch mini" title="この割り当てのオン／オフ">
          <input type="checkbox" id="mapOn" ${m?.on ? 'checked' : ''} ${!m || pause ? 'disabled' : ''}/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      ${pause ? `<div class="insp-note">このキーは<b>${pauseWord()}</b>に設定されています。${instant() ? '押すたびにキーボード・マウスとコントローラーが切り替わります。' : '押すたびにコントローラーの出力が止まる／戻ります。'}<button class="btn text sm" id="gotoSettings">設定で変更</button></div>` : ''}
      ${mb?.wheel ? `<div class="insp-note">ホイールを1ノッチ回すと、<b>${ctl.mouse.wheelMs ?? 40}ms</b>だけ押した扱いになります。<button class="btn text sm" id="gotoSettings">長さを変更</button></div>` : ''}
      <div class="cpad-wrap${pause ? ' disabled' : ''}">
        <div class="cpad">${PAD_BODY}${padButtons()}</div>
        <div class="cpad-cap" id="padCap"><span>${o ? '割り当て先：' + esc(o.label) : '割り当てるボタンを選んでください'}</span></div>
      </div>
      <div class="insp-foot">
        <span class="used-note"><i></i>明るいボタンは割り当て済み</span>
        <button class="btn text sm" id="unmap" ${m ? '' : 'disabled'}>割り当てを外す</button>
      </div>`;
    const cap = $('#padCap', insp);
    const capDefault = cap.innerHTML;
    $$('.cb', insp).forEach((b) => {
      b.addEventListener('mouseenter', () => { cap.innerHTML = `<span>${b.dataset.tip}</span>`; });
      b.addEventListener('mouseleave', () => { cap.innerHTML = capDefault; });
      b.addEventListener('click', () => {
        ctl.map[selected] = { out: b.dataset.out, on: true };
        changed();
        $(`.cb[data-out="${b.dataset.out}"]`, insp)?.classList.add('pop');
      });
    });
    $('#mapOn', insp)?.addEventListener('change', (e) => { ctl.map[selected].on = e.target.checked; changed(); });
    $('#unmap', insp)?.addEventListener('click', () => { delete ctl.map[selected]; changed(); });
    $('#gotoSettings', insp)?.addEventListener('click', () => goto('settings'));
  }

  // マウス移動の設定（インスペクターと設定画面で共通）
  const MOUSE_SLIDERS = [
    { k: 'sens', label: '感度', min: 0.1, max: 5, step: 0.05, inMax: 30, unit: '×', d: 2,
      hint: 'マウスを動かしたときに、スティックをどれだけ倒すか' },
    { k: 'yRatio', label: '縦の感度', min: 0.25, max: 3, step: 0.05, inMax: 5, unit: '×', d: 2,
      hint: '横に対する縦の感度。ゲームの縦が速すぎるときは下げます' },
    { k: 'curve', label: '反応カーブ', min: -100, max: 100, step: 1, unit: '', d: 0,
      hint: (v) => v > 0 ? '小さな動きを細かく（狙いを合わせやすい）' : v < 0 ? '小さな動きでも大きく倒す（キビキビ）' : '直線（動かした分だけ倒す）' },
    { k: 'smoothMs', label: 'なめらかさ', min: 0, max: 40, step: 1, inMax: 200, unit: 'ms', d: 0,
      hint: '大きいほどなめらか、小さいほど反応が速い' },
    { k: 'deadzone', label: 'デッドゾーン補正', min: 0, max: 40, step: 1, inMax: 80, unit: '%', d: 0,
      hint: 'ゲーム側の遊びを飛ばして、少しの動きでも反応させます' },
    { k: 'maxOut', label: '最大の倒し具合', min: 50, max: 100, step: 1, unit: '%', d: 0,
      hint: '大きく振ったときに倒す上限' },
  ];
  const WHEEL_SLIDER = { k: 'wheelMs', label: 'ホイール入力の長さ', min: 10, max: 150, step: 5, inMax: 500, unit: 'ms', d: 0,
    hint: 'ホイール上下を割り当てたとき、1ノッチを何msのボタン入力にするか' };
  const mouseRoots = new Set();
  const fmtNum = (def, v) => Number(v).toFixed(def.d);
  const hintOf = (def, v) => (typeof def.hint === 'function' ? def.hint(v) : def.hint);

  function sliderHtml(def, v) {
    return `<div class="slider fine" data-key="${def.k}">
      <div class="slider-head">
        <span class="sl-name">${def.label}</span>
        <label class="num-wrap"><input class="num" type="number" data-k="${def.k}" min="${def.min}" max="${def.inMax ?? def.max}" step="${def.step}" value="${fmtNum(def, v)}"/><small>${def.unit}</small></label>
      </div>
      <input type="range" data-k="${def.k}" min="${def.min}" max="${def.max}" step="${def.step}" value="${Math.min(def.max, v)}" />
      <p class="sl-hint">${hintOf(def, v)}</p>
    </div>`;
  }
  function curveSvg() {
    const m = ctl.mouse, pts = [];
    for (let i = -127; i <= 127; i += 2) pts.push([i, C.responseOf(m, i)]);
    const X = (u) => 60 + (u / 127) * 56, Y = (v) => 60 - (v / 127) * 56;
    const d = pts.map(([u, v], i) => `${i ? 'L' : 'M'}${X(u).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
    return `<svg class="curve" viewBox="0 0 120 120" aria-label="反応グラフ">
      <rect x="4" y="4" width="112" height="112" rx="10" class="cv-bg"/>
      <path d="M60 4V116M4 60H116" class="cv-axis"/>
      <path d="M4 116L116 4" class="cv-ref"/>
      <path d="${d}" class="cv-line"/>
    </svg>`;
  }
  function mouseControls(root, idp) {
    const m = ctl.mouse;
    for (const r of mouseRoots) if (!document.body.contains(r)) mouseRoots.delete(r);
    mouseRoots.add(root);
    const defs = root === settingsMouse ? [...MOUSE_SLIDERS, WHEEL_SLIDER] : MOUSE_SLIDERS;
    root.innerHTML = `
      <div class="seg wide" id="${idp}Stick" role="tablist">
        <span class="seg-pill"></span>
        <button data-v="right">右スティック</button>
        <button data-v="left">左スティック</button>
        <button data-v="off">使わない</button>
      </div>
      <div class="mouse-fine${m.stick === 'off' ? ' disabled' : ''}">
        <div class="mp-row">
          <div class="mp-graph">${curveSvg()}<span class="mp-cap">入力 → スティック</span></div>
          <div class="mp-side">
            <span class="mp-label">プリセット</span>
            <div class="chips mp-presets">${C.MOUSE_PRESETS.map((p, i) => `<button data-p="${i}">${esc(p.name)}</button>`).join('')}</div>
            <label class="check-row">
              <span>上下を反転</span>
              <span class="switch mini"><input type="checkbox" data-k="invertY" ${m.invertY ? 'checked' : ''}/><span class="switch-track"><span class="switch-thumb"></span></span></span>
            </label>
          </div>
        </div>
        ${defs.map((def) => sliderHtml(def, m[def.k] ?? C.MOUSE_DEFAULT[def.k])).join('')}
      </div>`;
    seg($(`#${idp}Stick`, root), m.stick, (v) => { m.stick = v; changed(); });
    const setVal = (k, raw, fromNum) => {
      const def = defs.find((d) => d.k === k);
      let v = parseFloat(raw);
      if (!Number.isFinite(v)) return;
      v = Math.min(def.inMax ?? def.max, Math.max(def.min, v));
      m[k] = Math.round(v / def.step) * def.step;
      m[k] = parseFloat(m[k].toFixed(4));
      mouseValuesChanged(fromNum ? null : root);
    };
    $$('input[type=range]', root).forEach((inp) => inp.addEventListener('input', () => setVal(inp.dataset.k, inp.value, false)));
    $$('input.num', root).forEach((inp) => {
      inp.addEventListener('change', () => setVal(inp.dataset.k, inp.value, true));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    $$('.mp-presets button', root).forEach((b) => b.addEventListener('click', () => {
      Object.assign(m, C.MOUSE_PRESETS[+b.dataset.p].v);
      mouseValuesChanged(null);
      toast(`マウスの設定を「${C.MOUSE_PRESETS[+b.dataset.p].name}」にしました`, 'ok');
    }));
    $('input[data-k=invertY]', root).addEventListener('change', (e) => { m.invertY = e.target.checked; changed(); });
    paintMouseValues(root);
  }
  // 値の表示だけを更新（ドラッグ中のスライダーを作り直さないため）
  function paintMouseValues(root, skipNum = false) {
    const m = ctl.mouse;
    $$('.slider.fine', root).forEach((el) => {
      const k = el.dataset.key;
      const def = [...MOUSE_SLIDERS, WHEEL_SLIDER].find((d) => d.k === k);
      const v = m[k] ?? C.MOUSE_DEFAULT[k];
      const r = $('input[type=range]', el), n = $('input.num', el);
      if (document.activeElement !== r) r.value = Math.min(def.max, v);
      r.style.setProperty('--p', ((Math.min(def.max, v) - def.min) / (def.max - def.min)) * 100 + '%');
      if (!skipNum && document.activeElement !== n) n.value = fmtNum(def, v);
      $('.sl-hint', el).textContent = hintOf(def, v);
    });
    const g = $('.mp-graph', root);
    if (g) g.firstElementChild.outerHTML = curveSvg();
    $$('.mp-presets button', root).forEach((b) => {
      const p = C.MOUSE_PRESETS[+b.dataset.p].v;
      b.classList.toggle('active', Object.entries(p).every(([k, v]) => Math.abs((m[k] ?? 0) - v) < 1e-6));
    });
  }
  function mouseValuesChanged() {
    persist(); compilePad();
    for (const r of mouseRoots) if (document.body.contains(r)) paintMouseValues(r);
    paintMap(); paintList();
  }

  function paintMoveInspector() {
    insp.innerHTML = `
      <div class="insp-head">
        <span class="big-cap mouse"><svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></span>
        <div class="insp-title">
          <span class="insp-name">マウスの移動</span>
          <span class="insp-out">${ctl.mouse.stick === 'off' ? '割り当てなし' : '→ ' + (ctl.mouse.stick === 'left' ? '左' : '右') + 'スティック'}</span>
        </div>
        <label class="switch mini">
          <input type="checkbox" id="moveOn" ${ctl.mouse.on ? 'checked' : ''} ${ctl.mouse.stick === 'off' ? 'disabled' : ''}/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="move-body"></div>
      <div class="pad-wrap">
        <div class="pad" id="pad">
          <div class="pad-ring"><span class="pad-max"></span><span class="pad-dz"></span><span class="pad-dot" id="padDot"></span></div>
          <span class="pad-hint">ここでマウスを動かして試せます</span>
        </div>
      </div>`;
    mouseControls($('.move-body', insp), 'insp');
    $('#moveOn', insp).addEventListener('change', (e) => { ctl.mouse.on = e.target.checked; changed(); });
    bindPad();
  }

  // ---- 試し打ちパッド：書き込む式と同じ計算でスティックの動きを表示 ----
  let padExpr = null;
  const padEnv = { pressed: new Set(), axes: {}, reg: {} };
  let padAcc = { x: 0, y: 0 }, padRaf = 0, padLast = 0;
  function compilePad() {
    padExpr = {
      x: tokenize(C.mouseExpr('0x00010030', 3, 7, ctl.mouse, 'x')),
      y: tokenize(C.mouseExpr('0x00010031', 4, 7, ctl.mouse, 'y')),
    };
    const dz = $('.pad-dz', insp);
    if (dz) dz.style.setProperty('--dz', ctl.mouse.deadzone / 100);
    const mx = $('.pad-max', insp);
    if (mx) mx.style.setProperty('--mx', (ctl.mouse.maxOut ?? 100) / 100);
  }
  function bindPad() {
    compilePad();
    const pad = $('#pad', insp);
    pad.addEventListener('pointermove', (e) => { padAcc.x += e.movementX; padAcc.y += e.movementY; });
    cancelAnimationFrame(padRaf);
    padLast = performance.now();
    const tick = (now) => {
      if (!document.body.contains(pad)) return;
      const ms = Math.max(1, Math.min(50, Math.round(now - padLast)));
      padLast = now;
      let ox = 128, oy = 128;
      for (let i = 0; i < ms; i++) {
        padEnv.axes['0x00010030'] = padAcc.x / ms;
        padEnv.axes['0x00010031'] = padAcc.y / ms;
        ox = evaluate(padExpr.x, padEnv);
        oy = evaluate(padExpr.y, padEnv);
      }
      padAcc = { x: 0, y: 0 };
      const dot = $('#padDot', insp);
      if (dot) {
        dot.style.setProperty('--px', ((ox - 128) / 127).toFixed(3));
        dot.style.setProperty('--py', ((oy - 128) / 127).toFixed(3));
        dot.classList.toggle('active', Math.abs(ox - 128) > 1 || Math.abs(oy - 128) > 1);
      }
      padRaf = requestAnimationFrame(tick);
    };
    padRaf = requestAnimationFrame(tick);
  }

  // ---------------- 一覧 ----------------
  function paintList() {
    const rows = [];
    const order = (u) => (C.MOUSE_BY_USAGE[u] ? 1 : 0);
    const entries = Object.entries(ctl.map).filter(([u]) => C.output(ctl.type, ctl.map[u].out))
      .sort((a, b) => order(a[0]) - order(b[0]) || srcName(a[0]).localeCompare(srcName(b[0]), 'ja', { numeric: true }));
    if (ctl.mouse.stick !== 'off') rows.push(['move', { on: ctl.mouse.on }]);
    rows.push(...entries);
    $('#listCount').textContent = rows.length;
    const list = $('#mapList');
    if (!rows.length) {
      list.innerHTML = '<p class="empty">まだ割り当てがありません。左のキーやボタンを選んで始めましょう。</p>';
      return;
    }
    list.innerHTML = rows.map(([src, m]) => {
      const out = src === 'move' ? esc(ctl.mouse.stick === 'left' ? '左スティック' : '右スティック') : glyph(C.output(ctl.type, m.out), true);
      const cap = src === 'move' ? '移動' : C.MOUSE_BY_USAGE[src] ? C.MOUSE_BY_USAGE[src].short : C.KEY_BY_USAGE[src]?.label ?? '?';
      const pause = src === ctl.pauseKey;
      return `<div class="row${m.on && !pause ? '' : ' muted'}${src === selected ? ' sel' : ''}" data-src="${src}">
        <span class="row-cap${isMouseSrc(src) ? ' mouse' : ''}">${esc(cap)}</span>
        <span class="row-name">${esc(srcName(src))}</span>
        <svg class="row-arrow" viewBox="0 0 16 16"><path d="M3 8h9M9 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="row-out">${pause ? pauseWord() : out}</span>
        <label class="switch mini"><input type="checkbox" data-src="${src}" ${m.on ? 'checked' : ''} ${pause ? 'disabled' : ''}/><span class="switch-track"><span class="switch-thumb"></span></span></label>
      </div>`;
    }).join('');
    $$('.row', list).forEach((r) => r.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      select(r.dataset.src, true);
    }));
    $$('input[type=checkbox]', list).forEach((inp) => inp.addEventListener('change', () => {
      if (inp.dataset.src === 'move') ctl.mouse.on = inp.checked; else ctl.map[inp.dataset.src].on = inp.checked;
      changed();
    }));
  }

  // ---------------- 選択 ----------------
  const srcSegCtl = seg($('#srcSeg'), srcView, (v) => setView(v));
  function setView(v) {
    srcView = v;
    save('quiver.ctlView', v);
    $$('.map-view').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
    srcSegCtl?.select(v, false);
    $('#mapSub').textContent = v === 'keyboard'
      ? 'キーを選んで、右側でコントローラーの入力を割り当てます'
      : 'ボタンや移動を選んで、右側でコントローラーの入力を割り当てます';
    if (v === 'keyboard') fitKeyboard();
  }
  function select(src, switchView = false) {
    selected = src;
    save('quiver.ctlSel', src);
    if (switchView) setView(isMouseSrc(src) ? 'mouse' : 'keyboard');
    paintMap(); paintInspector(); paintList();
    $('#inspector').classList.remove('swap'); void insp.offsetWidth; insp.classList.add('swap');
  }

  // ---------------- 設定画面 ----------------
  const settingsMouse = $('#settingsMouse');
  function paintSettingsMouse() { mouseControls(settingsMouse, 'set'); }

  const TYPE_ICON = {
    quiver: '<svg viewBox="0 0 48 32"><rect x="3" y="7" width="20" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 12h12M7 16h12M7 20h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M27 16h3M35.5 10h6a4 4 0 0 1 3.9 3.1l.6 3a2 2 0 0 1-3.4 1.8L41 16.5h-5l-1.6 1.4A2 2 0 0 1 31 16.1l.6-3A4 4 0 0 1 35.5 10z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M25 13l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    switch: '<svg viewBox="0 0 48 32"><rect x="2" y="4" width="12" height="24" rx="6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="34" y="4" width="12" height="24" rx="6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="5" width="20" height="22" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="12" r="2" fill="currentColor"/><circle cx="40" cy="20" r="2" fill="currentColor"/></svg>',
    stadia: '<svg viewBox="0 0 48 32"><path d="M12 5h24a7 7 0 0 1 6.8 5.4l2.5 11a4 4 0 0 1-6.8 3.6L34 21H14l-4.5 4a4 4 0 0 1-6.8-3.6l2.5-11A7 7 0 0 1 12 5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 11v6M11 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="33" cy="12" r="1.6" fill="currentColor"/><circle cx="36.5" cy="15.5" r="1.6" fill="currentColor"/></svg>',
  };
  function paintTypes() {
    $('#typeGrid').innerHTML = Object.entries(C.TYPES).map(([id, t]) => `
      <button class="type-card${ctl.type === id ? ' active' : ''}" data-type="${id}">
        <span class="type-ic">${TYPE_ICON[id]}</span>
        <span class="type-text"><b>${esc(t.name)}${t.badge ? `<em class="type-badge">${t.badge}</em>` : ''}</b><span>${esc(t.desc)}</span>
          ${t.instant ? `<span class="fw-state ${isQuiverFw() ? 'ok' : ''}">${isQuiverFw() ? '● 専用ファームを検出しました' : remapper.connected ? '○ 専用ファームが入っていません' : '○ 専用ファームが必要です'}</span>` : ''}</span>
        <span class="type-check"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>`).join('');
    $$('.type-card').forEach((b) => b.addEventListener('click', () => {
      if (ctl.type === b.dataset.type) return;
      ctl.type = b.dataset.type; changed();
      toast(`${C.TYPES[ctl.type].name} に切り替えました。書き込み後、初回だけUSBを挿し直すと反映されます`, 'info', 4200);
    }));
  }

  let capturingPause = false;
  function paintPauseKey() {
    $('#pauseTitle').textContent = pauseWord();
    $('#pauseDesc').textContent = instant()
      ? '押すたびに「キーボード・マウス」と「コントローラー」を瞬時に切り替えます。起動直後はキーボード・マウスです'
      : '押すたびにコントローラー出力を止める／戻すを切り替えます。ほかの割り当てより優先されます';
    $('.lg-pause').parentElement.lastChild.textContent = pauseWord();
    const b = $('#pauseKeyBtn');
    b.classList.toggle('capturing', capturingPause);
    b.textContent = capturingPause ? 'キーを押してください…' : ctl.pauseKey ? C.sourceLabel(ctl.pauseKey) : '未設定';
  }
  $('#pauseKeyBtn').addEventListener('click', () => { capturingPause = !capturingPause; paintPauseKey(); });
  $('#pauseKeyClear').addEventListener('click', () => { ctl.pauseKey = null; capturingPause = false; changed(); });
  function setPauseKey(usage) {
    capturingPause = false;
    ctl.pauseKey = usage;
    changed();
    toast(`${pauseWord()}を「${C.sourceLabel(usage)}」にしました`, 'ok');
  }

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'quiver', version: 1, controller: ctl }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'quiver-controller.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const c = data.controller;
      if (!c || typeof c.map !== 'object' || !C.TYPES[c.type]) throw new Error();
      const d = C.defaults();
      Object.assign(ctl, d, c, { mouse: { ...d.mouse, ...c.mouse } });
      changed(); toast('割り当てを読み込みました', 'ok');
    } catch { toast('このファイルは読み込めませんでした', 'err'); }
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!(await confirmDialog('初期配置に戻しますか？', '今の割り当てとマウス移動の設定が、最初の状態に戻ります。', '戻す'))) return;
    const d = C.defaults();
    Object.assign(ctl, { ...d, enabled: ctl.enabled, type: ctl.type });
    changed(); toast('初期配置に戻しました', 'ok');
  });
  $('#clearBtn').addEventListener('click', async () => {
    if (!(await confirmDialog('すべての割り当てを消しますか？', 'キーボードとマウスボタンの割り当てがすべて消えます。マウスの移動と一時停止キーは残ります。', '消す'))) return;
    ctl.map = {};
    changed(); toast('割り当てを消しました', 'ok');
  });

  // ---------------- 書き込み ----------------
  const wbtn = $('#ctlWriteBtn');
  let wstate = 'idle';
  const setW = (s) => { wstate = s; wbtn.dataset.state = s; };
  function paintWrite() {
    wbtn.disabled = !remapper.connected || wstate === 'busy';
    $('[data-s="idle"]', wbtn).textContent =
      remapper.connected && ctlWritten === cfgKey() ? '書き込み済み' : ctl.enabled ? 'デバイスに書き込む' : 'マウスモードで書き込む';
    $('#ctlEnabled').checked = ctl.enabled;
    $('#ctlEnabledLabel').textContent = ctl.enabled ? 'オン' : 'オフ';
  }
  $('#ctlEnabled').addEventListener('change', (e) => { ctl.enabled = e.target.checked; changed(); });

  function afterWrite(descriptor, fromShake = false, combined = false) {
    const prev = load('quiver.descriptor', 0);
    save('quiver.descriptor', descriptor);
    if (fromShake) { ctlWritten = combined ? cfgKey() : null; save('quiver.ctlWritten', ctlWritten); }
    if (prev !== descriptor) {
      toast('デバイスの種類が変わりました。ボードのUSBを一度抜いて挿し直すと切り替わります', 'info', 7000);
    }
    paintChip();
  }
  window.quiverAfterWrite = (d, combined) => afterWrite(d, true, combined);

  async function writeCtl() {
    if (!remapper.connected || wstate === 'busy') return;
    setW('busy'); paintWrite();
    const bar = $('.morph-progress', wbtn);
    if (ctl.enabled && instant() && !isQuiverFw()) {
      setW('error'); paintWrite();
      toast('Quiver専用ファームが入っていません。先に quiver-remapper.uf2 をボードに書き込んでください', 'err', 6000);
      setTimeout(() => { if (wstate === 'error') { setW('idle'); paintWrite(); } }, 2400);
      return;
    }
    const cfg = ctl.enabled
      ? C.buildConfig(ctl, instant() ? shakeCfg() : null)
      : { ...shakeCfg(), descriptor: 0, passthrough: 0xff };
    try {
      await remapper.write(cfg, (k) => (bar.style.transform = `scaleX(${k})`));
      ctlWritten = cfgKey(); save('quiver.ctlWritten', ctlWritten);
      window.quiverShake.markWritten(!ctl.enabled || instant());
      setW('done');
      toast(!ctl.enabled ? 'マウスモード（揺れの設定）に戻して保存しました'
        : instant() ? `保存しました。${C.sourceLabel(ctl.pauseKey || '')}でキーボード・マウスとコントローラーを切り替えられます`
        : 'コントローラーの割り当てを保存しました', 'ok', 4500);
      afterWrite(cfg.descriptor);
      setTimeout(() => { if (wstate === 'done') { setW('idle'); paintWrite(); } }, 1800);
    } catch (err) {
      setW('error');
      toast(err.message || String(err), 'err', 5000);
      setTimeout(() => { if (wstate === 'error') { setW('idle'); paintWrite(); } }, 2400);
    } finally {
      bar.style.transform = 'scaleX(0)';
      paintWrite();
    }
  }
  wbtn.addEventListener('click', writeCtl);

  // ---------------- 入力（キー操作・モニター）----------------
  document.addEventListener('keydown', (e) => {
    const page = document.body.dataset.page;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (page === 'controller') { e.preventDefault(); writeCtl(); }
      return;
    }
    if (e.target.closest?.('[contenteditable="true"], input[type=text], input[type=number], textarea')) return;
    const key = C.KEY_BY_CODE[e.code];
    if (capturingPause && page === 'settings') {
      e.preventDefault();
      if (e.code === 'Escape') { capturingPause = false; paintPauseKey(); return; }
      if (key) setPauseKey(key.usage);
      return;
    }
    if (page !== 'controller' || !key || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    down.add(key.usage); paintDown();
    if (srcView !== 'keyboard') setView('keyboard');
    if (selected !== key.usage) select(key.usage);
  });
  document.addEventListener('keyup', (e) => {
    const key = C.KEY_BY_CODE[e.code];
    if (key && down.delete(key.usage)) paintDown();
  });
  window.addEventListener('blur', () => { down.clear(); paintDown(); });

  let moveTimer = 0;
  const wheelTimers = {};
  let paused = false;
  function paintPaused() {
    document.body.classList.toggle('paused', paused);
    const b = $('#pausedBadge');
    b.classList.toggle('on', paused);
    b.classList.toggle('ctl', instant());
    b.lastChild.textContent = instant() ? 'コントローラー操作中' : '一時停止中';
  }
  remapper.addEventListener('disconnected', () => { paused = false; paintPaused(); });
  remapper.addEventListener('input', (e) => {
    const { usage, value } = e.detail;
    if (usage === C.PAUSE_MONITOR) { paused = (value & 2) !== 0; paintPaused(); return; }
    if (usage === '0x00010038') {
      if (value) {
        const k = value > 0 ? 'wheelUp' : 'wheelDown';
        down.add(k); paintDown();
        clearTimeout(wheelTimers[k]);
        wheelTimers[k] = setTimeout(() => { down.delete(k); paintDown(); }, 180);
      }
      return;
    }
    if (usage === '0x00010030' || usage === '0x00010031') {
      if (value) { down.add('move'); clearTimeout(moveTimer); moveTimer = setTimeout(() => { down.delete('move'); paintDown(); }, 160); paintDown(); }
      return;
    }
    if (!usage.startsWith('0x0007') && !usage.startsWith('0x0009')) return;
    if (capturingPause && usage.startsWith('0x0007') && value && C.KEY_BY_USAGE[usage]) { setPauseKey(usage); return; }
    if (value) down.add(usage); else down.delete(usage);
    paintDown();
  });

  // ---------------- まとめて反映 ----------------
  function changed() {
    persist();
    paintMap(); paintInspector(); paintList(); paintTypes(); paintPauseKey(); paintSettingsMouse(); paintWrite(); paintChip(); paintPaused();
  }

  // 起動
  goto(load('quiver.page', 'shake'));
  setView(srcView);
  changed();
})();
