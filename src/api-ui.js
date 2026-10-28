// 外部ソフト用API：設定画面のカードと、メイン側から来た移動の依頼をボードへ送る処理
(() => {
  const remapper = window.quiverRemapper;
  const toast = window.quiverToast;
  const native = window.quiverNative || null;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cfg = { enabled: false, port: 47810, token: '', ...load('quiver.api', {}) };
  let listen = { listening: false, port: cfg.port };
  let showToken = false;
  let lang = load('quiver.apiLang', 'py');
  const logs = [];

  const url = () => `http://127.0.0.1:${cfg.port}`;
  const mouseMode = () => load('quiver.descriptor', 0) === 0;

  // ---------------- ボードの状態をメイン側へ ----------------
  function publishDevice() {
    native?.apiSetDevice({
      connected: remapper.connected,
      canMove: !!remapper.canMove,
      mouseMode: mouseMode(),
      name: remapper.name || '',
    });
  }
  remapper.addEventListener('connected', () => { publishDevice(); paint(); });
  remapper.addEventListener('disconnected', () => { publishDevice(); paint(); });
  setInterval(publishDevice, 1000);

  // メイン側（APIサーバー）からの依頼
  native?.apiOnRequest(async ({ id, op, args }) => {
    try {
      if (op !== 'move') throw new Error('不明な操作です');
      await remapper.move(args.dx, args.dy, args.step, args.replace);
      native.apiRespond({ id, ok: true });
    } catch (e) {
      native.apiRespond({ id, ok: false, error: e.message || String(e) });
    }
  });

  native?.apiOnLog((l) => {
    logs.unshift({ at: new Date(), ...l });
    logs.length = Math.min(logs.length, 6);
    paintLog();
  });

  // ---------------- 設定の反映 ----------------
  async function apply() {
    if (cfg.enabled && !cfg.token && native) cfg.token = await native.apiNewToken();
    save('quiver.api', cfg);
    if (!native) { listen = { listening: false, error: 'この環境ではAPIを使えません' }; paint(); return; }
    listen = await native.apiConfigure(cfg);
    if (cfg.enabled && listen.error) toast(listen.error, 'err', 5000);
    paint();
  }

  // ---------------- 表示 ----------------
  function statusText() {
    if (!cfg.enabled) return ['off', 'オフ'];
    if (listen.error) return ['err', listen.error];
    if (!listen.listening) return ['wait', '準備中…'];
    if (!remapper.connected) return ['warn', `${url()} で待ち受け中。HID Remapper が接続されていません`];
    if (!remapper.canMove) return ['warn', `${url()} で待ち受け中。最新の専用ファーム（Quiver3）を書き込むと使えます`];
    if (!mouseMode()) return ['warn', `${url()} で待ち受け中。コントローラーの種類を「Quiver専用ファーム」にして書き込むと使えます`];
    return ['on', `${url()} で待ち受け中・使えます`];
  }

  function sample() {
    const tok = showToken ? cfg.token : '<トークン>';
    if (lang === 'py') return `import requests

QUIVER = "${url()}"
HEADERS = {"X-Quiver-Token": "${tok}"}

def move_to(x, y, duration=0):
    """画面の座標（物理ピクセル）へ動かす。duration はかける時間（ms）"""
    r = requests.post(f"{QUIVER}/move", json={"x": x, "y": y, "duration": duration}, headers=HEADERS)
    return r.json()

def move_by(dx, dy, duration=0):
    """今の位置から相対で動かす（カーソルが固定されるゲームの視点操作など）"""
    r = requests.post(f"{QUIVER}/move-by", json={"dx": dx, "dy": dy, "duration": duration}, headers=HEADERS)
    return r.json()

print(move_to(960, 540, duration=150))
print(move_by(200, 0))`;
    if (lang === 'curl') return `:: 画面の (960, 540) へ動かす
curl -X POST ${url()}/move -H "X-Quiver-Token: ${tok}" -H "Content-Type: application/json" -d "{\\"x\\":960,\\"y\\":540}"

:: 右へ200動かす（相対）
curl -X POST ${url()}/move-by -H "X-Quiver-Token: ${tok}" -H "Content-Type: application/json" -d "{\\"dx\\":200,\\"dy\\":0}"

:: 状態とカーソル位置
curl ${url()}/status -H "X-Quiver-Token: ${tok}"`;
    return `POST /move      {"x": 960, "y": 540}
  画面の座標（物理ピクセル）へ動かします。ずれた分は自動で最大3回補正します。
  任意: "duration" かける時間(ms) / "speed" 1msあたりの移動量 / "tolerance" 許容するずれ(既定1)

POST /move-by   {"dx": 100, "dy": -20}
  今の位置から相対で動かします。カーソルが固定されるゲームの視点操作はこちら。
  任意: "duration" / "speed" / "queue": true で前の移動に続けて足す

POST /stop
  動いている途中の移動を止めます。

GET  /status
  接続状態（connected / canMove / mouseMode）と今のカーソル位置を返します。

認証: ヘッダー X-Quiver-Token（または ?token=）。ブラウザのページからは呼べません。
座標: マウスの「ポインターの精度を高める」をオフにすると、1カウント＝1ピクセルで正確に動きます。`;
  }

  function paintLog() {
    const box = $('#apiLog');
    if (!logs.length) { box.innerHTML = '<p class="empty">まだありません</p>'; return; }
    box.innerHTML = logs.map((l) => {
      const t = l.at.toLocaleTimeString('ja-JP', { hour12: false });
      const b = l.body || {};
      const what = l.route.endsWith('/move') ? `(${b.x}, ${b.y}) へ` : l.route.endsWith('/move-by') ? `${b.dx}, ${b.dy} 動かす` : l.route;
      const res = l.result?.ok ? (l.result.to ? `→ (${l.result.to.x}, ${l.result.to.y})` : 'OK') : (l.result?.reason || '失敗');
      return `<div class="api-log-row${l.result?.ok ? '' : ' ng'}"><span class="t">${t}</span><span class="w">${esc(what)}</span><span class="r">${esc(res)}</span></div>`;
    }).join('');
  }

  function paint() {
    const [state, text] = statusText();
    $('#apiStatus').dataset.state = state;
    $('#apiStatusText').textContent = text;
    $('#apiEnabled').checked = cfg.enabled;
    $('#apiUrl').textContent = url();
    if (document.activeElement !== $('#apiPort')) $('#apiPort').value = cfg.port;
    const tk = $('#apiToken');
    tk.textContent = cfg.token ? (showToken ? cfg.token : '•'.repeat(Math.min(24, cfg.token.length))) : '（オンにすると作られます）';
    $('#apiTokenShow').textContent = showToken ? '隠す' : '表示';
    $('#apiSample').textContent = sample();
    const usable = state === 'on' || (remapper.canMove && mouseMode());
    $('#apiTestCenter').disabled = !usable;
    $('#apiTestCircle').disabled = !usable;
    $('#apiCard').classList.toggle('off', !cfg.enabled);
  }

  // ---------------- 操作 ----------------
  $('#apiEnabled').addEventListener('change', async (e) => {
    cfg.enabled = e.target.checked;
    await apply();
    if (cfg.enabled && listen.listening) toast(`外部ソフトからの操作を受け付けます（${url()}）`, 'ok', 4000);
  });
  $('#apiPort').addEventListener('change', async (e) => {
    const p = Math.round(+e.target.value);
    if (!(p >= 1024 && p <= 65535)) { e.target.value = cfg.port; toast('ポートは 1024〜65535 で指定してください', 'err'); return; }
    cfg.port = p;
    await apply();
  });
  $('#apiPort').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#apiTokenShow').addEventListener('click', () => { showToken = !showToken; paint(); });
  $('#apiTokenNew').addEventListener('click', async () => {
    if (!native) return;
    cfg.token = await native.apiNewToken();
    await apply();
    toast('トークンを作り直しました。外部ソフト側のトークンも書き換えてください', 'info', 4500);
  });
  $$('[data-copy-api]').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(b.dataset.copyApi === 'url' ? url() : cfg.token);
    const t = b.textContent; b.textContent = 'コピー済み'; setTimeout(() => (b.textContent = t), 1300);
  }));
  $('#apiCopySample').addEventListener('click', async () => {
    const was = showToken; showToken = true;
    await navigator.clipboard.writeText(sample());
    showToken = was;
    const b = $('#apiCopySample'); b.textContent = 'コピー済み'; setTimeout(() => (b.textContent = 'コピー'), 1300);
  });

  // 言語の切り替え
  (function setupLang() {
    const root = $('#apiLang'), pill = $('.seg-pill', root), btns = $$('button', root);
    const place = () => {
      const b = btns.find((x) => x.dataset.v === lang) || btns[0];
      btns.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      pill.style.width = b.offsetWidth + 'px';
      pill.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    btns.forEach((b) => b.addEventListener('click', () => { lang = b.dataset.v; save('quiver.apiLang', lang); place(); paint(); }));
    new ResizeObserver(place).observe(root);
    place();
  })();

  // テスト（アプリの中から直接動かす）
  async function testCenter() {
    try {
      const dpr = window.devicePixelRatio || 1;
      const target = { x: Math.round((screen.availLeft || 0) * dpr + (screen.width * dpr) / 2), y: Math.round((screen.availTop || 0) * dpr + (screen.height * dpr) / 2) };
      for (let i = 0; i < 3; i++) {
        const c = await native.cursor();
        const dx = target.x - c.x, dy = target.y - c.y;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
        await remapper.move(dx, dy, Math.max(4, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 150)), true);
        await sleep(i === 0 ? 190 : 40);
      }
      const c = await native.cursor();
      toast(`カーソルを (${c.x}, ${c.y}) に動かしました`, 'ok');
    } catch (e) { toast(e.message || String(e), 'err', 5000); }
  }
  async function testCircle() {
    try {
      const R = 60, N = 48;
      let px = R, py = 0;
      for (let i = 1; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const x = Math.round(R * Math.cos(a)), y = Math.round(R * Math.sin(a));
        await remapper.move(x - px, y - py, 0, false);
        px = x; py = y;
        await sleep(16);
      }
    } catch (e) { toast(e.message || String(e), 'err', 5000); }
  }
  $('#apiTestCenter').addEventListener('click', testCenter);
  $('#apiTestCircle').addEventListener('click', testCircle);

  // カーソル位置の表示（設定画面を開いているときだけ）
  setInterval(async () => {
    if (document.body.dataset.page !== 'settings' || !native) return;
    const c = await native.cursor();
    $('#apiCursor').textContent = `今のカーソル：(${c.x}, ${c.y})`;
  }, 250);

  // 起動時
  paint();
  publishDevice();
  if (cfg.enabled) apply();
})();
