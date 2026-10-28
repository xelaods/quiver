(() => {
  const { BUTTONS, build, mappings, tokenize, evaluate } = window.QuiverExpr;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // ---------------- 状態 ----------------
  const DEFAULTS = {
    hold: '0x00090002', trigger: '0x00090001', mode: 'sharp',
    amplitude: 8, frequency: 50, randomness: 40, angle: 45, enabled: true,
  };
  const BUILTIN_PRESETS = [
    { name: '標準', builtin: true, mode: 'sharp', amplitude: 8, frequency: 50, randomness: 40, angle: 45 },
    { name: '微振動', builtin: true, mode: 'sharp', amplitude: 3, frequency: 70, randomness: 30, angle: 45 },
    { name: '左右', builtin: true, mode: 'sharp', amplitude: 8, frequency: 50, randomness: 40, angle: 0 },
    { name: 'スムーズ', builtin: true, mode: 'smooth', amplitude: 10, frequency: 12, randomness: 40, angle: 45 },
  ];
  const PATTERN_KEYS = ['mode', 'amplitude', 'frequency', 'randomness', 'angle'];

  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const state = { ...DEFAULTS, ...load('quiver.state', {}) };
  let userPresets = load('quiver.presets', []);
  const pressed = new Set();
  let lastWritten = load('quiver.written', null);

  const remapper = (window.quiverRemapper = new Remapper());

  const params = () => ({
    hold: state.hold, trigger: state.trigger, mode: state.mode,
    amplitude: state.amplitude, period: Math.round(1000 / state.frequency),
    randomness: state.randomness / 100, angle: state.angle,
  });

  // ---------------- 小物 ----------------
  window.quiverToast = toast;
  function toast(msg, kind = 'info', ms = 3200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="ic">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i'}</span><span></span>`;
    el.lastChild.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }

  const tweens = new WeakMap();
  function tweenNumber(el, to, decimals = 0) {
    const from = tweens.get(el)?.value ?? to;
    const start = performance.now();
    const rec = { value: from };
    tweens.set(el, rec);
    const dur = 420;
    const step = (now) => {
      if (tweens.get(el) !== rec) return;
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 4);
      rec.value = from + (to - from) * e;
      el.textContent = rec.value.toFixed(decimals);
      if (k < 1) requestAnimationFrame(step); else rec.value = to;
    };
    requestAnimationFrame(step);
  }

  // ---------------- セグメント ----------------
  function setupSeg(root, value, onChange) {
    const pill = root.querySelector('.seg-pill');
    const btns = [...root.querySelectorAll('button')];
    const place = () => {
      const b = btns.find((x) => x.getAttribute('aria-selected') === 'true') || btns[0];
      pill.style.width = b.offsetWidth + 'px';
      pill.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    const select = (v, emit) => {
      btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === String(v))));
      place();
      if (emit) onChange(btns.find((b) => b.dataset.v === String(v)).dataset.v);
    };
    btns.forEach((b) => b.addEventListener('click', () => select(b.dataset.v, true)));
    new ResizeObserver(place).observe(root);
    select(value, false);
    return { select };
  }

  // ---------------- セレクト ----------------
  const CHECK = '<svg class="check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function setupSelect(root, options, getValue, onChange, isDisabled) {
    root.innerHTML = `<button class="select-trigger" type="button"><span></span>
      <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="select-menu" role="listbox"></div>`;
    const trigger = root.querySelector('.select-trigger');
    const menu = root.querySelector('.select-menu');
    const render = () => {
      const v = getValue();
      trigger.firstElementChild.textContent = options.find((o) => o.id === v)?.label ?? '';
      menu.innerHTML = '';
      for (const o of options) {
        const b = document.createElement('button');
        b.className = 'select-option';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(o.id === v));
        b.setAttribute('aria-disabled', String(!!isDisabled?.(o.id)));
        b.innerHTML = `<span></span>${CHECK}`;
        b.firstChild.textContent = o.label;
        b.addEventListener('click', () => { onChange(o.id); root.classList.remove('open'); });
        menu.appendChild(b);
      }
    };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      $$('.select.open').forEach((s) => s !== root && s.classList.remove('open'));
      render();
      root.classList.toggle('open');
    });
    document.addEventListener('click', () => root.classList.remove('open'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && root.classList.remove('open'));
    render();
    return { render };
  }

  // ---------------- UI 構築 ----------------
  const holdOptions = [{ id: null, label: 'なし（1ボタンで作動）' }, ...BUTTONS];
  const holdSel = setupSelect($('#holdSelect'), holdOptions, () => state.hold,
    (v) => { state.hold = v; changed(); triggerSel.render(); }, (id) => id && id === state.trigger);
  const triggerSel = setupSelect($('#triggerSelect'), BUTTONS, () => state.trigger,
    (v) => { state.trigger = v; changed(); holdSel.render(); }, (id) => id === state.hold);

  const modeSeg = setupSeg($('#modeSeg'), state.mode, (v) => { state.mode = v; changed(); });
  let simSpeed = load('quiver.simSpeed', 1);
  setupSeg($('#speedSeg'), simSpeed, (v) => { simSpeed = parseFloat(v); save('quiver.simSpeed', simSpeed); resetSim(); });

  const sliders = {};
  for (const el of $$('.layout .slider[data-key]')) {
    const key = el.dataset.key;
    const input = el.querySelector('input');
    Object.assign(input, { min: el.dataset.min, max: el.dataset.max, step: el.dataset.step });
    sliders[key] = { el, input, out: el.querySelector('output') };
    input.addEventListener('input', () => { state[key] = parseFloat(input.value); changed(); });
  }

  function paintSliders() {
    for (const [key, s] of Object.entries(sliders)) {
      s.input.value = state[key];
      const p = ((state[key] - s.input.min) / (s.input.max - s.input.min)) * 100;
      s.input.style.setProperty('--p', p + '%');
    }
    const P = Math.round(1000 / state.frequency);
    sliders.amplitude.out.innerHTML = `${state.amplitude}<small>カウント</small>`;
    sliders.frequency.out.innerHTML = `${state.frequency} Hz<small>（1往復 ${P}ms）</small>`;
    sliders.randomness.out.innerHTML = state.randomness === 0 ? 'なし' : `±${state.randomness}<small>%</small>`;
  }

  // 方向ダイヤル
  const dial = $('#dial');
  const ticks = dial.querySelector('.dial-ticks');
  for (let a = 0; a < 360; a += 15) {
    const r1 = a % 45 === 0 ? 44 : 47, r2 = 51, rad = (a * Math.PI) / 180;
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', 60 + r1 * Math.cos(rad)); l.setAttribute('y1', 60 - r1 * Math.sin(rad));
    l.setAttribute('x2', 60 + r2 * Math.cos(rad)); l.setAttribute('y2', 60 - r2 * Math.sin(rad));
    if (a % 45 === 0) l.classList.add('major');
    ticks.appendChild(l);
  }
  let shownAngle = state.angle;
  function paintDial(animate = true) {
    const target = state.angle;
    const from = shownAngle;
    const start = performance.now();
    const run = (now) => {
      const k = animate ? Math.min(1, (now - start) / 380) : 1;
      // 少しだけオーバーシュートするバネ風のイージング
      const e = 1 - Math.pow(1 - k, 3) + Math.sin(k * Math.PI) * 0.06;
      shownAngle = from + (target - from) * e;
      const rad = (shownAngle * Math.PI) / 180, r = 46;
      const ax = 60 + r * Math.cos(rad), ay = 60 - r * Math.sin(rad);
      const bx = 60 - r * Math.cos(rad), by = 60 + r * Math.sin(rad);
      const axis = $('#dialAxis');
      axis.setAttribute('x1', bx); axis.setAttribute('y1', by); axis.setAttribute('x2', ax); axis.setAttribute('y2', ay);
      $('#dialKnobA').setAttribute('cx', ax); $('#dialKnobA').setAttribute('cy', ay);
      $('#dialKnobB').setAttribute('cx', bx); $('#dialKnobB').setAttribute('cy', by);
      if (k < 1) requestAnimationFrame(run); else shownAngle = target;
    };
    requestAnimationFrame(run);
    $('#angleValue').textContent = state.angle;
    dial.setAttribute('aria-valuenow', state.angle);
    $$('#angleChips button').forEach((b) => b.classList.toggle('active', +b.dataset.a === state.angle));
  }
  function angleFromPointer(e) {
    const r = dial.getBoundingClientRect();
    let a = (Math.atan2(-(e.clientY - (r.top + r.height / 2)), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    if (a > 90) a -= 180;
    if (a <= -90) a += 180;
    a = Math.round(a);
    const snap = Math.round(a / 15) * 15;
    if (Math.abs(a - snap) <= 3 && !e.shiftKey) a = snap;
    return a === -90 ? 90 : a;
  }
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    state.angle = angleFromPointer(e); changed(false);
    const move = (ev) => { state.angle = angleFromPointer(ev); changed(false); };
    const up = () => { dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', up); };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
  });
  dial.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 15 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') state.angle = Math.max(-89, state.angle - d);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') state.angle = Math.min(90, state.angle + d);
    else return;
    e.preventDefault(); changed();
  });
  $$('#angleChips button').forEach((b) => b.addEventListener('click', () => { state.angle = +b.dataset.a; changed(); }));

  // プリセット
  const matches = (p) => PATTERN_KEYS.every((k) => p[k] === state[k]);
  function paintPresets() {
    const root = $('#presets');
    root.innerHTML = '';
    [...BUILTIN_PRESETS, ...userPresets].forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'preset' + (matches(p) ? ' active' : '');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = '<span class="preset-name"></span>';
      el.firstChild.textContent = p.name;
      if (!p.builtin) {
        const x = document.createElement('span');
        x.className = 'x'; x.textContent = '×'; x.title = '削除';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          userPresets = userPresets.filter((q) => q !== p);
          save('quiver.presets', userPresets); paintPresets();
        });
        el.appendChild(x);
        el.addEventListener('dblclick', () => {
          const name = el.firstChild;
          name.contentEditable = 'true'; name.focus();
          document.getSelection().selectAllChildren(name);
          const done = () => {
            name.contentEditable = 'false';
            p.name = name.textContent.trim() || p.name;
            save('quiver.presets', userPresets); paintPresets();
          };
          name.addEventListener('blur', done, { once: true });
          name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
        });
      }
      const apply = () => { PATTERN_KEYS.forEach((k) => (state[k] = p[k])); modeSeg.select(state.mode); changed(); };
      el.addEventListener('click', (e) => { if (el.firstChild.isContentEditable) return; apply(); });
      el.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
      root.appendChild(el);
    });
  }
  $('#savePreset').addEventListener('click', () => {
    const p = { name: `マイ設定 ${userPresets.length + 1}` };
    PATTERN_KEYS.forEach((k) => (p[k] = state[k]));
    userPresets.push(p);
    save('quiver.presets', userPresets);
    paintPresets();
    toast('プリセットを保存しました（ダブルクリックで名前を変更）', 'ok');
  });

  // 詳細
  $('#advToggle').addEventListener('click', () => {
    const open = $('#advToggle').getAttribute('aria-expanded') !== 'true';
    $('#advToggle').setAttribute('aria-expanded', String(open));
    $('#advBody').classList.toggle('open', open);
  });
  $$('.copy').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent);
    b.textContent = 'コピー済み'; setTimeout(() => (b.textContent = 'コピー'), 1400);
  }));

  // 有効スイッチ
  const enabledEl = $('#enabled');
  enabledEl.checked = state.enabled;
  enabledEl.addEventListener('change', () => { state.enabled = enabledEl.checked; changed(); });

  // ---------------- 反映 ----------------
  let compiled = null;
  function changed(animateDial = true) {
    compiled = build(params());
    compiled.t1 = tokenize(compiled.expr1);
    compiled.t2 = tokenize(compiled.expr2);
    save('quiver.state', state);

    paintSliders();
    paintDial(animateDial);
    paintPresets();

    $('#expr1').textContent = compiled.expr1;
    $('#expr2').textContent = compiled.expr2;
    $('#modeHint').textContent = state.mode === 'smooth'
      ? '端で減速して折り返します。動いた軌跡が目で追える、なめらかな揺れです。'
      : '一定の速さで動いてパッと折り返す、細かく速い揺れです。';
    $('#enabledLabel').textContent = state.enabled ? '有効' : '無効';

    const holdBtn = BUTTONS.find((b) => b.id === state.hold);
    const trigBtn = BUTTONS.find((b) => b.id === state.trigger);
    $('#keyHold').textContent = holdBtn?.short ?? '';
    $('#keyHold').classList.toggle('hidden', !holdBtn);
    $('.key-plus').style.display = holdBtn ? '' : 'none';
    $('#keyTrigger').textContent = trigBtn?.short ?? '';

    tweenNumber($('#stAmp'), state.amplitude, state.amplitude % 1 ? 1 : 0);
    tweenNumber($('#stHz'), state.frequency);
    tweenNumber($('#stAngle'), state.angle);
    tweenNumber($('#stSpeed'), compiled.speed * (1 + state.randomness / 100), 2);

    paintWriteButton();
    resetSim(false);
  }

  // ---------------- デバイス ----------------
  const writeBtn = $('#writeBtn');
  let writeState = 'idle';
  const configKey = () => JSON.stringify({ ...params(), enabled: state.enabled });
  function setWriteState(s) { writeState = s; writeBtn.dataset.state = s; }
  function paintWriteButton() {
    writeBtn.disabled = !remapper.connected || writeState === 'busy';
    const label = writeBtn.querySelector('[data-s="idle"]');
    label.textContent = lastWritten === configKey() && remapper.connected ? '書き込み済み' : 'デバイスに書き込む';
  }
  setWriteState('idle');

  function paintDevice() {
    const on = remapper.connected;
    $('#deviceCard').dataset.state = on ? 'on' : 'off';
    $('#deviceName').textContent = on ? (remapper.name || 'HID Remapper') : '未接続';
    $('#deviceStatus').textContent = on ? '接続中・ボタン入力をモニター中' : 'HID Remapperを接続してください';
    $('#connectBtn').textContent = on ? '切断' : '接続';
    $('#keysNote').textContent = on ? 'ボタンを押すとここが光ります' : '接続するとボタンの状態がここに表示されます';
    if (!on) { pressed.clear(); paintKeys(); }
    paintWriteButton();
  }

  function paintKeys() {
    $('#keyHold').classList.toggle('down', pressed.has(state.hold));
    $('#keyTrigger').classList.toggle('down', pressed.has(state.trigger));
    const live = remapper.connected && state.enabled && lastWritten === configKey()
      && pressed.has(state.trigger) && (!state.hold || pressed.has(state.hold));
    $('#liveBadge').classList.toggle('on', live);
  }

  remapper.addEventListener('connected', () => { paintDevice(); toast(`${remapper.name || 'HID Remapper'} に接続しました`, 'ok'); });
  remapper.addEventListener('disconnected', () => { paintDevice(); toast('デバイスが切断されました', 'info'); });
  remapper.addEventListener('input', (e) => {
    const { usage, value } = e.detail;
    if (!usage.startsWith('0x0009')) return;
    if (value) pressed.add(usage); else pressed.delete(usage);
    paintKeys();
  });

  $('#connectBtn').addEventListener('click', async () => {
    try {
      if (remapper.connected) await remapper.disconnect();
      else await remapper.request();
    } catch (err) {
      if (err?.name !== 'NotFoundError') toast(err.message || String(err), 'err', 5000);
    }
  });

  async function write() {
    if (!remapper.connected || writeState === 'busy') return;
    setWriteState('busy');
    paintWriteButton();
    const bar = writeBtn.querySelector('.morph-progress');
    const cfg = state.enabled
      ? { mappings: mappings(params()), expressions: [compiled.expr1, compiled.expr2] }
      : { mappings: [], expressions: [] };
    try {
      // 専用ファームでコントローラーもオンなら、両方をまとめて書き込む
      const combined = window.quiverCombined?.();
      await remapper.write(combined || { ...cfg, descriptor: 0, passthrough: 0xff }, (k) => (bar.style.transform = `scaleX(${k})`));
      lastWritten = configKey();
      save('quiver.written', lastWritten);
      setWriteState('done');
      toast(state.enabled ? '揺れの設定をデバイスに保存しました' : '揺れをオフにしてデバイスに保存しました', 'ok');
      window.quiverAfterWrite?.(0, !!combined);
      setTimeout(() => { if (writeState === 'done') { setWriteState('idle'); paintWriteButton(); } }, 1800);
    } catch (err) {
      setWriteState('error');
      toast(err.message || String(err), 'err', 5000);
      setTimeout(() => { if (writeState === 'error') { setWriteState('idle'); paintWriteButton(); } }, 2400);
    } finally {
      bar.style.transform = 'scaleX(0)';
      paintWriteButton();
      paintKeys();
    }
  }
  writeBtn.addEventListener('click', write);
  // コントローラーモードをオフにして書き込むときは、今の揺れ設定（マウスモード）に戻す
  window.quiverShake = {
    config: () => (state.enabled
      ? { mappings: mappings(params()), expressions: [compiled.expr1, compiled.expr2] }
      : { mappings: [], expressions: [] }),
    markWritten: (yes) => { lastWritten = yes ? configKey() : null; save('quiver.written', lastWritten); paintWriteButton(); paintKeys(); },
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.body.dataset.page === 'shake') { e.preventDefault(); write(); }
  });

  // ---------------- プレビュー ----------------
  const canvas = $('#preview');
  const ctx = canvas.getContext('2d');
  const scaleNote = $('#scaleNote');
  let PX_PER_COUNT = 10;
  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }
  new ResizeObserver(resize).observe(canvas);

  const sim = { t: 0, x: 0, y: 0, cx: 0, cy: 0, acc: 0, reg: {}, trail: [] };
  function resetSim(clearTrail = true) {
    sim.acc = 0;
    if (clearTrail) { sim.trail = []; sim.x = sim.y = sim.cx = sim.cy = 0; sim.reg = {}; }
  }

  const cursorPath = new Path2D('M0 0 L0 15.5 L4 11.8 L6.8 18 L9.4 16.9 L6.7 10.8 L11.8 10.8 Z');
  let lastFrame = performance.now();

  function frame(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;

    if (compiled) {
      sim.acc += dt * simSpeed;
      let steps = Math.min(2000, Math.floor(sim.acc));
      sim.acc -= Math.floor(sim.acc);
      const env = { t: 0, pressed: new Set([state.hold, state.trigger].filter(Boolean)), reg: sim.reg };
      if (!state.enabled) env.pressed.clear();
      while (steps-- > 0) {
        sim.t += 1;
        env.t = sim.t;
        sim.x += evaluate(compiled.t1, env);
        sim.y += evaluate(compiled.t2, env);
        sim.trail.push({ x: sim.x, y: sim.y, at: now });
      }
      const life = trailLife();
      while (sim.trail.length && now - sim.trail[0].at > life) sim.trail.shift();
      if (sim.trail.length > 6000) sim.trail.splice(0, sim.trail.length - 6000);

      // 軌跡の中心にゆっくり追従
      if (sim.trail.length) {
        let mx = 0, my = 0;
        for (const p of sim.trail) { mx += p.x; my += p.y; }
        mx /= sim.trail.length; my /= sim.trail.length;
        sim.cx += (mx - sim.cx) * 0.12; sim.cy += (my - sim.cy) * 0.12;
      }
    }

    draw(now);
    requestAnimationFrame(frame);
  }

  function trailLife() { return simSpeed >= 1 ? 520 : simSpeed >= 0.1 ? 1200 : 2200; }

  function draw(now) {
    // 揺れ幅に合わせてゆっくりズーム（グリッドの細かさで大きさの違いが分かる）
    const reach = state.amplitude * (1 + state.randomness / 100);
    const target = Math.min(22, Math.max(3, (Math.min(W, H) * 0.42) / Math.max(1, reach)));
    PX_PER_COUNT += (target - PX_PER_COUNT) * 0.08;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ox = W / 2, oy = H / 2;
    const unit = PX_PER_COUNT * 5 < 18 ? 10 : 5;
    const grid = unit * PX_PER_COUNT;
    if (scaleNote.dataset.u !== String(unit)) { scaleNote.dataset.u = unit; scaleNote.textContent = `1マス = ${unit}カウント`; }

    // ドットグリッド（中心ほど明るい）
    for (let gx = ox % grid; gx < W; gx += grid) {
      for (let gy = oy % grid; gy < H; gy += grid) {
        const d = Math.hypot(gx - ox, gy - oy) / Math.max(W, H);
        ctx.fillStyle = `rgba(255,255,255,${Math.max(0.05, 0.24 - d * 0.36)})`;
        ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
      }
    }

    // 方向ガイド
    const rad = (state.angle * Math.PI) / 180;
    const L = Math.hypot(W, H);
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox - Math.cos(rad) * L, oy + Math.sin(rad) * L);
    ctx.lineTo(ox + Math.cos(rad) * L, oy - Math.sin(rad) * L);
    ctx.stroke();
    ctx.restore();

    // 揺れ幅の目安
    const half = (state.amplitude * PX_PER_COUNT) / 2;
    ctx.save();
    ctx.translate(ox, oy); ctx.rotate(-rad);
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    const bandH = 26 + state.randomness * 0.2;
    roundRect(ctx, -half - 14, -bandH / 2, half * 2 + 28, bandH, bandH / 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // 軌跡
    const tr = sim.trail;
    if (tr.length > 1) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const n = tr.length;
      const stride = Math.max(1, Math.floor(n / 1500));
      for (let i = stride; i < n; i += stride) {
        const a = tr[i - stride], b = tr[i];
        const age = (now - b.at) / trailLife();
        const alpha = Math.max(0, 1 - age) ** 1.6;
        ctx.strokeStyle = `rgba(250,250,250,${0.85 * alpha})`;
        ctx.lineWidth = 1 + 1.4 * alpha;
        ctx.beginPath();
        ctx.moveTo(ox + (a.x - sim.cx) * PX_PER_COUNT, oy + (a.y - sim.cy) * PX_PER_COUNT);
        ctx.lineTo(ox + (b.x - sim.cx) * PX_PER_COUNT, oy + (b.y - sim.cy) * PX_PER_COUNT);
        ctx.stroke();
      }
    }

    // カーソル
    const hx = ox + (sim.x - sim.cx) * PX_PER_COUNT;
    const hy = oy + (sim.y - sim.cy) * PX_PER_COUNT;
    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 26);
    glow.addColorStop(0, 'rgba(255,255,255,0.22)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(hx, hy, 26, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(hx, hy);
    ctx.fillStyle = '#fafafa';
    ctx.strokeStyle = '#050505';
    ctx.lineWidth = 1.4;
    ctx.stroke(cursorPath); ctx.fill(cursorPath);
    ctx.restore();

    if (!state.enabled) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'center';
      ctx.fillText('無効になっています', ox, oy + 48);
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------------- 起動 ----------------
  changed(false);
  paintDevice();
  remapper.autoConnect().catch(() => {});
  requestAnimationFrame((t) => { lastFrame = t; requestAnimationFrame(frame); });
})();
