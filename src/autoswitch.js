// 自動切り替え：登録した参考画像と今の画面を見比べて、
// 一致したら「キーボード・マウス」と「コントローラー」を切り替える。
(() => {
  const C = window.QuiverCtl;
  const remapper = window.quiverRemapper;
  const toast = window.quiverToast;
  const native = window.quiverNative || null;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);

  const WORK_W = 960;   // 判定用に縮小した画面の幅
  const TPL_MAX = 48;   // 判定に使う部分を、長い辺この大きさに縮めて比べる
  const MODE_NAME = { kbm: 'キーボード・マウス', ctl: 'コントローラー' };

  // ---------------- 状態 ----------------
  const st = Object.assign({
    enabled: false, sourceId: null, fallback: 'none', intervalMs: 300, stable: 2, keepAlive: true, rules: [],
  }, load('quiver.auto', {}));
  let selectedId = load('quiver.autoSel', st.rules[0]?.id ?? null);
  const scores = {};          // ルールID → 0〜100
  const tplCache = {};        // ルールID → { data: Uint8ClampedArray(RGB), w, h }
  let actualMode = null;      // デバイスから届いた今のモード
  let lastSent = null;        // 最後に送ったモード
  let candidate = null, candidateCount = 0;
  let hitRule = null;

  const persist = () => {
    if (!save('quiver.auto', st)) toast('保存できませんでした（画像が多すぎる可能性があります）', 'err', 5000);
  };
  const shotKey = (id) => 'quiver.autoShot.' + id;
  const getShot = (id) => { try { return localStorage.getItem(shotKey(id)); } catch { return null; } };
  const setShot = (id, url) => { try { localStorage.setItem(shotKey(id), url); return true; } catch { return false; } };
  const ruleOf = (id) => st.rules.find((r) => r.id === id) || null;
  const selRule = () => ruleOf(selectedId);

  // 書き込みとは別に、ルールの数値だけを素早く保存（テンプレートはキャッシュとして持つ）
  function packTpl(rule, t) {
    rule.tw = t.w; rule.th = t.h;
    let bin = ''; for (let i = 0; i < t.data.length; i++) bin += String.fromCharCode(t.data[i]);
    rule.tpl = btoa(bin);
    tplCache[rule.id] = t;
  }
  function tplOf(rule) {
    if (tplCache[rule.id]) return tplCache[rule.id];
    if (!rule.tpl) return null;
    const bin = atob(rule.tpl);
    const data = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return (tplCache[rule.id] = { data, w: rule.tw, h: rule.th });
  }

  // ---------------- 画像処理 ----------------
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });

  function tplSize(region, srcW, srcH) {
    const w = region.w * srcW, h = region.h * srcH;
    const k = TPL_MAX / Math.max(w, h);
    return { w: Math.max(4, Math.round(w * k)), h: Math.max(4, Math.round(h * k)) };
  }
  // src（画像やcanvas）の region 部分を w×h に縮めて RGB で返す
  function sampleRGB(src, srcW, srcH, region, w, h) {
    small.width = w; small.height = h;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'medium';
    sctx.drawImage(src, region.x * srcW, region.y * srcH, region.w * srcW, region.h * srcH, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data;
    const rgb = new Uint8ClampedArray(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
    return rgb;
  }
  // 一致率（0〜1）：形の一致（正規化相互相関）と色の近さを組み合わせる
  function similarity(a, b) {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let cov = 0, va = 0, vb = 0, mad = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma, db = b[i] - mb;
      cov += da * db; va += da * da; vb += db * db; mad += Math.abs(a[i] - b[i]);
    }
    mad /= n * 255;
    const sa = Math.sqrt(va / n), sb = Math.sqrt(vb / n);
    const near = 1 - Math.min(1, mad * 2.5);
    if (sa < 6 || sb < 6) return Math.max(0, 1 - Math.min(1, mad * 4)); // ほぼ単色の範囲は色の近さだけで判定
    const ncc = cov / Math.sqrt(va * vb);
    return Math.max(0, 0.75 * Math.max(0, ncc) + 0.25 * near);
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  }
  async function rebuildTemplate(rule) {
    const url = getShot(rule.id);
    if (!url) return;
    const img = await loadImage(url);
    const sz = tplSize(rule.region, img.naturalWidth, img.naturalHeight);
    packTpl(rule, { data: sampleRGB(img, img.naturalWidth, img.naturalHeight, rule.region, sz.w, sz.h), w: sz.w, h: sz.h });
    persist();
    drawTplView(); paintList();
  }

  // ---------------- 画面キャプチャ ----------------
  const video = document.createElement('video');
  video.muted = true;
  let stream = null, starting = null, captureFailed = false;
  async function ensureStream() {
    if (stream && stream.active && video.videoWidth) return true;
    if (starting) return starting;
    starting = (async () => {
      try {
        native?.setCaptureSource(st.sourceId);
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
        video.srcObject = stream;
        await video.play();
        stream.getVideoTracks()[0].addEventListener('ended', () => { stream = null; });
        captureFailed = false;
        return true;
      } catch (e) {
        stream = null;
        if (!captureFailed) toast('画面を取得できませんでした: ' + (e.message || e), 'err', 5000);
        captureFailed = true;
        return false;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }
  function stopStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = WORK_W, h = Math.round((WORK_W * vh) / vw);
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    wctx.drawImage(video, 0, 0, w, h);
    return work;
  }

  // ---------------- 参考画像の編集 ----------------
  const stage = $('#refStage'), canvasEl = $('#refCanvas'), img = $('#refImg'), regionEl = $('#refRegion');
  function fitCanvas() {
    if (!img.naturalWidth) return;
    const pad = 28;
    const W = stage.clientWidth - pad * 2, H = stage.clientHeight - pad * 2;
    const ar = img.naturalWidth / img.naturalHeight;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    canvasEl.style.width = Math.max(10, w) + 'px';
    canvasEl.style.height = Math.max(10, h) + 'px';
  }
  new ResizeObserver(fitCanvas).observe(stage);
  img.addEventListener('load', fitCanvas);

  function paintRegion() {
    const r = selRule();
    if (!r) return;
    const g = r.region;
    Object.assign(regionEl.style, { left: g.x * 100 + '%', top: g.y * 100 + '%', width: g.w * 100 + '%', height: g.h * 100 + '%' });
    regionEl.classList.toggle('full', g.w > 0.98 && g.h > 0.98);
  }

  let drag = null;
  canvasEl.addEventListener('pointerdown', (e) => {
    const r = selRule();
    if (!r || !img.naturalWidth) return;
    canvasEl.setPointerCapture(e.pointerId);
    const b = canvasEl.getBoundingClientRect();
    const p = (ev) => ({ x: Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (ev.clientY - b.top) / b.height)) });
    const s = p(e);
    // 範囲の中をつかんだら移動、外なら新しく囲む
    const g = r.region;
    const inside = s.x >= g.x && s.x <= g.x + g.w && s.y >= g.y && s.y <= g.y + g.h && !(g.w > 0.98 && g.h > 0.98);
    drag = { s, inside, orig: { ...g } };
    canvasEl.classList.add('dragging');
    const move = (ev) => {
      const q = p(ev);
      if (drag.inside) {
        const dx = q.x - drag.s.x, dy = q.y - drag.s.y;
        r.region = {
          ...drag.orig,
          x: Math.min(1 - drag.orig.w, Math.max(0, drag.orig.x + dx)),
          y: Math.min(1 - drag.orig.h, Math.max(0, drag.orig.y + dy)),
        };
      } else {
        r.region = { x: Math.min(s.x, q.x), y: Math.min(s.y, q.y), w: Math.abs(q.x - s.x), h: Math.abs(q.y - s.y) };
      }
      paintRegion();
    };
    const up = () => {
      canvasEl.removeEventListener('pointermove', move);
      canvasEl.removeEventListener('pointerup', up);
      canvasEl.classList.remove('dragging');
      if (r.region.w < 0.01 || r.region.h < 0.01) r.region = drag.orig;
      drag = null;
      paintRegion();
      rebuildTemplate(r);
    };
    canvasEl.addEventListener('pointermove', move);
    canvasEl.addEventListener('pointerup', up);
  });

  // ---------------- 表示 ----------------
  const tplView = $('#tplView'), liveView = $('#liveView');
  function sizeViews(rule) {
    const g = rule?.region || { w: 1, h: 1 };
    const ar = (g.w * 16) / (g.h * 9);
    const W = 112, H = 64;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    for (const c of [tplView, liveView]) {
      c.width = Math.max(8, Math.round(w)); c.height = Math.max(8, Math.round(h));
    }
  }
  function drawRGB(canvas, t) {
    const off = document.createElement('canvas');
    off.width = t.w; off.height = t.h;
    const o = off.getContext('2d');
    const id = o.createImageData(t.w, t.h);
    for (let i = 0, j = 0; j < t.data.length; i += 4) { id.data[i] = t.data[j++]; id.data[i + 1] = t.data[j++]; id.data[i + 2] = t.data[j++]; id.data[i + 3] = 255; }
    o.putImageData(id, 0, 0);
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(off, 0, 0, canvas.width, canvas.height);
  }
  function drawTplView() {
    const r = selRule();
    sizeViews(r);
    const t = r && tplOf(r);
    if (t) drawRGB(tplView, t); else tplView.getContext('2d').clearRect(0, 0, tplView.width, tplView.height);
  }

  const modeSeg = (() => {
    const root = $('#ruleModeSeg');
    const pill = $('.seg-pill', root);
    const btns = $$('button', root);
    const place = () => {
      const b = btns.find((x) => x.getAttribute('aria-selected') === 'true') || btns[0];
      pill.style.width = b.offsetWidth + 'px';
      pill.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    btns.forEach((b) => b.addEventListener('click', () => {
      const r = selRule(); if (!r) return;
      r.mode = b.dataset.v; persist(); paintEditor(); paintList();
    }));
    new ResizeObserver(place).observe(root);
    return { set(v) { btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === v))); place(); } };
  })();

  function paintEditor() {
    const r = selRule();
    const has = !!r && !!getShot(r.id);
    $('#refEmpty').classList.toggle('on', !r);
    canvasEl.classList.toggle('on', has);
    $('#refFoot').classList.toggle('disabled', !r);
    $('#ruleName').disabled = !r;
    $('#ruleName').value = r ? r.name : '';
    $('#deleteRule').disabled = !r;
    if (r) {
      if (has && img.dataset.id !== r.id) { img.dataset.id = r.id; img.src = getShot(r.id); }
      if (!has) { img.removeAttribute('src'); img.dataset.id = ''; }
      paintRegion();
      modeSeg.set(r.mode);
      $('#thRange').value = r.threshold;
      $('#thRange').style.setProperty('--p', ((r.threshold - 50) / 49) * 100 + '%');
      $('#thOut').textContent = r.threshold + '%';
      $('#matchMeter').style.setProperty('--th', r.threshold + '%');
    } else {
      img.removeAttribute('src'); img.dataset.id = '';
    }
    drawTplView();
    paintMatch();
  }

  function paintMatch() {
    const r = selRule();
    const v = r ? scores[r.id] : undefined;
    $('#matchVal').textContent = v === undefined ? '--' : Math.round(v);
    const m = $('#matchMeter');
    m.style.setProperty('--v', (v ?? 0) + '%');
    m.classList.toggle('hit', !!r && v !== undefined && v >= r.threshold);
  }

  function paintList() {
    const list = $('#ruleList');
    if (!st.rules.length) {
      list.innerHTML = '<p class="empty">まだ画面が登録されていません。「＋ 画面を追加」から始めましょう。</p>';
      return;
    }
    // 並べ替えずに、行ごとに作り直す（数が少ないので十分速い）
    list.innerHTML = st.rules.map((r) => `
      <div class="rule${r.id === selectedId ? ' sel' : ''}${r.on ? '' : ' muted'}" data-id="${r.id}">
        <canvas class="rule-thumb" width="64" height="36"></canvas>
        <div class="rule-main">
          <div class="rule-top">
            <span class="rule-name">${esc(r.name)}</span>
            <span class="mode-chip ${r.mode}">${r.mode === 'ctl' ? 'コントローラー' : 'キーボード・マウス'}</span>
          </div>
          <div class="meter" style="--th:${r.threshold}%"><span class="meter-fill"></span><span class="meter-th"></span></div>
        </div>
        <span class="rule-score">--</span>
        <label class="switch mini"><input type="checkbox" ${r.on ? 'checked' : ''}/><span class="switch-track"><span class="switch-thumb"></span></span></label>
      </div>`).join('');
    $$('.rule', list).forEach((row) => {
      const r = ruleOf(row.dataset.id);
      const t = tplOf(r);
      const cv = $('canvas', row);
      if (t) {
        const ar = t.w / t.h;
        cv.width = 64; cv.height = 36;
        const c = cv.getContext('2d');
        let w = 64, h = 64 / ar; if (h > 36) { h = 36; w = 36 * ar; }
        const off = document.createElement('canvas'); off.width = Math.round(w); off.height = Math.round(h);
        drawRGB(off, t);
        c.drawImage(off, (64 - off.width) / 2, (36 - off.height) / 2);
      }
      row.addEventListener('click', (e) => { if (e.target.closest('.switch')) return; select(r.id); });
      $('input', row).addEventListener('change', (e) => { r.on = e.target.checked; persist(); row.classList.toggle('muted', !r.on); });
    });
    paintScores();
  }
  function paintScores() {
    for (const row of $$('#ruleList .rule')) {
      const r = ruleOf(row.dataset.id);
      const v = scores[r.id];
      $('.meter', row).style.setProperty('--v', (v ?? 0) + '%');
      $('.meter', row).classList.toggle('hit', v !== undefined && v >= r.threshold);
      $('.rule-score', row).textContent = v === undefined ? '--' : Math.round(v) + '%';
      row.classList.toggle('active', hitRule === r.id);
    }
  }

  function select(id) {
    selectedId = id;
    save('quiver.autoSel', id);
    paintEditor(); paintList();
  }

  // ---------------- 操作 ----------------
  function addRule() {
    const r = {
      id: uid(), name: `画面 ${st.rules.length + 1}`, mode: 'kbm', threshold: 85, on: true,
      region: { x: 0, y: 0, w: 1, h: 1 },
    };
    st.rules.push(r);
    persist();
    select(r.id);
    return r;
  }
  $('#addRule').addEventListener('click', addRule);
  $('#emptyAdd').addEventListener('click', addRule);

  $('#ruleName').addEventListener('input', (e) => {
    const r = selRule(); if (!r) return;
    r.name = e.target.value.trim() || r.name;
    persist();
    const row = $(`#ruleList .rule[data-id="${r.id}"] .rule-name`);
    if (row) row.textContent = r.name;
  });
  $('#thRange').addEventListener('input', (e) => {
    const r = selRule(); if (!r) return;
    r.threshold = +e.target.value; persist();
    e.target.style.setProperty('--p', ((r.threshold - 50) / 49) * 100 + '%');
    $('#thOut').textContent = r.threshold + '%';
    $('#matchMeter').style.setProperty('--th', r.threshold + '%');
    const meter = $(`#ruleList .rule[data-id="${r.id}"] .meter`);
    if (meter) meter.style.setProperty('--th', r.threshold + '%');
    paintMatch();
  });
  $('#deleteRule').addEventListener('click', () => {
    const r = selRule(); if (!r) return;
    st.rules = st.rules.filter((x) => x !== r);
    try { localStorage.removeItem(shotKey(r.id)); } catch {}
    delete tplCache[r.id]; delete scores[r.id];
    persist();
    select(st.rules[0]?.id ?? null);
    toast(`「${r.name}」を削除しました`, 'info');
  });

  async function setShotFrom(source, w, h) {
    const r = selRule() || addRule();
    const c = document.createElement('canvas');
    c.width = WORK_W; c.height = Math.round((WORK_W * h) / w);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    if (!setShot(r.id, c.toDataURL('image/jpeg', 0.82))) {
      toast('画像を保存できませんでした。使っていない画面を削除してください', 'err', 5000);
      return;
    }
    img.dataset.id = '';
    paintEditor();
    await rebuildTemplate(r);
    toast('画面を登録しました。その画面だけに出る部分をドラッグで囲むと、判定が正確になります', 'ok', 5500);
  }

  let counting = false;
  $('#captureShot').addEventListener('click', async () => {
    if (counting) return;
    if (!(await ensureStream())) return;
    counting = true;
    const cd = $('#countdown');
    cd.classList.add('on');
    for (let n = 3; n > 0; n--) {
      $('b', cd).textContent = n;
      $('#captureLabel').textContent = `${n}秒後に撮影`;
      await new Promise((res) => setTimeout(res, 1000));
    }
    cd.classList.remove('on');
    $('#captureLabel').textContent = '今の画面を撮る';
    counting = false;
    const f = grabFrame();
    if (f) setShotFrom(f, f.width, f.height);
  });
  $('#importShot').addEventListener('click', () => $('#shotFile').click());
  $('#shotFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
    try {
      const im = await loadImage(url);
      setShotFrom(im, im.naturalWidth, im.naturalHeight);
    } catch { toast('この画像は読み込めませんでした', 'err'); }
  });

  // ---------------- 設定 ----------------
  function seg(root, value, onChange) {
    const pill = $('.seg-pill', root);
    const btns = $$('button', root);
    const place = () => {
      const b = btns.find((x) => x.getAttribute('aria-selected') === 'true') || btns[0];
      pill.style.width = b.offsetWidth + 'px';
      pill.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    const set = (v) => { btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === v))); place(); };
    btns.forEach((b) => b.addEventListener('click', () => { set(b.dataset.v); onChange(b.dataset.v); }));
    new ResizeObserver(place).observe(root);
    set(value);
  }
  seg($('#fallbackSeg'), st.fallback, (v) => { st.fallback = v; persist(); });

  function rangeSetting(id, key, fmt) {
    const root = $(id), inp = $('input', root), out = $('output', root);
    const paint = () => {
      inp.value = st[key];
      inp.style.setProperty('--p', ((st[key] - inp.min) / (inp.max - inp.min)) * 100 + '%');
      out.textContent = fmt(st[key]);
    };
    inp.addEventListener('input', () => { st[key] = +inp.value; persist(); paint(); restartTimer(); });
    paint();
  }
  rangeSetting('#intervalSlider', 'intervalMs', (v) => `${v}ms（1秒に${(1000 / v).toFixed(1)}回）`);
  rangeSetting('#stableSlider', 'stable', (v) => (v === 1 ? '1回（すぐ切り替える）' : `${v}回`));

  const keepEl = $('#keepAlive');
  keepEl.checked = st.keepAlive;
  keepEl.addEventListener('change', () => { st.keepAlive = keepEl.checked; persist(); syncKeepAlive(); });
  const syncKeepAlive = () => native?.setKeepAlive(st.enabled && st.keepAlive);

  // 見る画面（モニター）の選択
  const screenSel = $('#screenSelect');
  let screens = [];
  async function loadScreens() {
    try { screens = native ? await native.screens() : []; } catch { screens = []; }
    paintScreenSelect();
  }
  function paintScreenSelect() {
    const cur = screens.find((s) => s.id === st.sourceId) || screens[0];
    screenSel.innerHTML = `<button class="select-trigger" type="button"><span>${esc(cur ? cur.name : '画面を取得できません')}</span>
      <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="select-menu screen-menu">${screens.map((s) => `
        <button class="select-option screen-opt" data-id="${esc(s.id)}" aria-selected="${s === cur}">
          <img src="${s.thumb}" alt="" /><span>${esc(s.name)}</span>
        </button>`).join('')}</div>`;
    $('.select-trigger', screenSel).addEventListener('click', (e) => {
      e.stopPropagation();
      loadScreens().then(() => screenSel.classList.add('open'));
    });
    $$('.screen-opt', screenSel).forEach((b) => b.addEventListener('click', () => {
      st.sourceId = b.dataset.id; persist();
      screenSel.classList.remove('open');
      paintScreenSelect();
      stopStream(); ensureStream();
    }));
  }
  document.addEventListener('click', () => screenSel.classList.remove('open'));

  // ---------------- 判定と切り替え ----------------
  const ctlState = () => load('quiver.ctl', {}) || {};
  function warning() {
    if (!remapper.connected) return 'HID Remapperが接続されていません。判定だけ行います。';
    if (!remapper.canSetRegister) return '自動切り替えには新しい専用ファーム（quiver-remapper.uf2）が必要です。書き込み直すと使えます。';
    const c = ctlState();
    if (c.type !== 'quiver' || !c.enabled) return 'コントローラー画面で種類を「Quiver専用ファーム」にし、オンにして書き込んでください。';
    return '';
  }
  function paintStatus() {
    const box = $('#autoStatus');
    const w = st.enabled ? warning() : '';
    box.dataset.state = !st.enabled ? 'off' : w ? 'warn' : 'on';
    $('#autoEnabled').checked = st.enabled;
    $('#autoSub').textContent = !st.enabled ? 'オフ' : stream ? `監視中・${(1000 / st.intervalMs).toFixed(1)}回/秒` : '画面を準備中…';
    const mode = actualMode ?? lastSent;
    $('#autoMode').textContent = mode ? MODE_NAME[mode] : '--';
    $('#autoMode').className = 'as-mode' + (mode ? ' ' + mode : '');
    const h = hitRule && ruleOf(hitRule);
    $('#autoHit').textContent = h ? `「${h.name}」と一致` : '一致している画面はありません';
    const warn = $('#autoWarn');
    warn.hidden = !w;
    warn.textContent = w;
  }
  $('#autoEnabled').addEventListener('change', (e) => {
    st.enabled = e.target.checked;
    persist();
    lastSent = null; candidate = null; candidateCount = 0;
    if (st.enabled) ensureStream();
    syncKeepAlive();
    paintStatus();
    restartTimer();
    toast(st.enabled ? '自動切り替えをオンにしました' : '自動切り替えをオフにしました', st.enabled ? 'ok' : 'info');
  });

  remapper.addEventListener('input', (e) => {
    if (e.detail.usage !== C.PAUSE_MONITOR) return;
    actualMode = (e.detail.value & 2) ? 'ctl' : 'kbm';
    paintStatus();
  });
  remapper.addEventListener('disconnected', () => { actualMode = null; lastSent = null; paintStatus(); });
  remapper.addEventListener('connected', paintStatus);

  async function tick() {
    const visible = document.body.dataset.page === 'auto' && document.visibilityState === 'visible';
    if (!st.enabled && !visible) return;
    if (!(await ensureStream())) { paintStatus(); return; }
    const frame = grabFrame();
    if (!frame) return;

    // 一致率の計算
    let best = null;
    for (const r of st.rules) {
      const t = tplOf(r);
      if (!t) { delete scores[r.id]; continue; }
      const live = sampleRGB(frame, frame.width, frame.height, r.region, t.w, t.h);
      const v = similarity(t.data, live) * 100;
      scores[r.id] = v;
      if (r.on && v >= r.threshold && (!best || v - r.threshold > best.margin)) best = { r, margin: v - r.threshold };
      if (r.id === selectedId && visible) {
        drawRGB(liveView, { data: sampleRGB(frame, frame.width, frame.height, r.region, liveView.width, liveView.height), w: liveView.width, h: liveView.height });
      }
    }
    hitRule = best ? best.r.id : null;
    if (visible) { paintMatch(); paintScores(); }

    // 切り替え：同じ判定が続いたら送る
    if (st.enabled) {
      const want = best ? best.r.mode : st.fallback === 'none' ? null : st.fallback;
      if (want !== candidate) { candidate = want; candidateCount = 1; } else candidateCount++;
      if (want && candidateCount >= st.stable && want !== lastSent && !warning()) {
        try {
          if (await remapper.setRegister(C.MODE_REG, want === 'ctl' ? 1 : 0)) lastSent = want;
        } catch (err) {
          toast(err.message || String(err), 'err', 5000);
        }
      }
    }
    paintStatus();
  }

  let timer = 0, running = false;
  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try { await tick(); } finally { running = false; }
    }, st.intervalMs);
  }

  // ページを開いたら画面一覧を読み込み、キャプチャを始める
  const nav = $('#nav');
  nav.addEventListener('click', (e) => {
    if (e.target.closest('button')?.dataset.page === 'auto') { loadScreens(); ensureStream(); requestAnimationFrame(() => { fitCanvas(); paintEditor(); }); }
  });

  // ---------------- 起動 ----------------
  for (const r of st.rules) tplOf(r);
  paintEditor();
  paintList();
  paintStatus();
  loadScreens();
  syncKeepAlive();
  restartTimer();
  if (st.enabled || document.body.dataset.page === 'auto') ensureStream();
})();
