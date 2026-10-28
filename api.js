// 外部ソフトから Quiver 経由でマウスを動かすためのローカルAPI（127.0.0.1 だけで待ち受け）
//
//   POST /move     { "x": 960, "y": 540, "speed": 0 }   画面の座標（物理ピクセル）へ動かす
//   POST /move-by  { "dx": 100, "dy": -20, "speed": 0 }  今の位置から相対で動かす（ゲームの視点操作など）
//   POST /stop                                           動いている途中の移動を止める
//   GET  /status                                         接続状態と今のカーソル位置
//
// 認証：ヘッダー「X-Quiver-Token: <トークン>」（またはURLの ?token=）
// ブラウザのページからは呼べないよう、Origin ヘッダー付きのリクエストは断る。
const http = require('http');
const { screen } = require('electron');

const MAX_BODY = 4096;

function cursorPhysical() {
  const p = screen.getCursorScreenPoint();
  // Windows の表示スケール（125% など）を考慮して、物理ピクセルにそろえる
  const q = process.platform === 'win32' ? screen.dipToScreenPoint(p) : p;
  return { x: Math.round(q.x), y: Math.round(q.y) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);

function createApi({ sendMove, getDevice, onLog }) {
  let server = null;
  let conf = { enabled: false, port: 47810, token: '' };
  let seq = 0;

  function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('リクエストが大きすぎます'), { code: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('JSONの形式が正しくありません'), { code: 400 })); }
      });
      req.on('error', reject);
    });
  }

  // speed: 1msあたりの移動量（0 = できるだけ速く）、duration: かける時間(ms)。duration が優先
  function stepOf(body, dist) {
    const duration = num(body.duration);
    if (duration && duration > 0) return Math.max(1, Math.ceil(dist / duration));
    const speed = num(body.speed);
    return speed && speed > 0 ? Math.round(speed) : 0;
  }
  const framesOf = (dist, step) => Math.ceil(dist / (step > 0 ? step : 2000));

  async function moveAbsolute(body) {
    const x = num(body.x), y = num(body.y);
    if (x === null || y === null) throw Object.assign(new Error('x と y を数値で指定してください'), { code: 400 });
    const start = cursorPhysical();
    const tolerance = Math.max(0, num(body.tolerance) ?? 1);
    let cur = start, rounds = 0, moved = false;
    // 1回目で動かし、Windows のマウス加速などで残ったずれを最大3回まで補正する
    for (; rounds < 4; rounds++) {
      const dx = Math.round(x - cur.x), dy = Math.round(y - cur.y);
      if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) break;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const step = rounds === 0 ? stepOf(body, dist) : 0;
      await sendMove(dx, dy, step, true);
      await sleep(framesOf(dist, step) + 30);
      const next = cursorPhysical();
      if (next.x === cur.x && next.y === cur.y) {
        // カーソルが動かない＝ゲームがカーソルを固定している等。送り続けないよう止める
        if (!moved) {
          return { ok: false, reason: 'カーソルが動きませんでした（ゲームがカーソルを固定している場合は /move-by を使ってください）', from: start, to: next };
        }
        break;
      }
      moved = true;
      cur = next;
    }
    const end = cursorPhysical();
    return { ok: Math.abs(end.x - x) <= tolerance && Math.abs(end.y - y) <= tolerance, from: start, to: end, target: { x, y }, corrections: Math.max(0, rounds - 1) };
  }

  async function moveRelative(body) {
    const dx = num(body.dx), dy = num(body.dy);
    if (dx === null || dy === null) throw Object.assign(new Error('dx と dy を数値で指定してください'), { code: 400 });
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    const step = stepOf(body, dist);
    await sendMove(dx, dy, step, body.queue ? false : true);
    return { ok: true, dx: Math.round(dx), dy: Math.round(dy), estimatedMs: framesOf(dist, step) };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const id = ++seq;
    // ブラウザ（Webページ）からのリクエストは断る
    if (req.headers.origin) return json(res, 403, { ok: false, error: 'ブラウザからは使えません' });
    const token = req.headers['x-quiver-token'] || url.searchParams.get('token');
    if (!conf.token || token !== conf.token) return json(res, 401, { ok: false, error: 'トークンが違います' });

    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    try {
      if (route === 'GET /status') {
        const d = getDevice();
        return json(res, 200, { ok: true, ...d, cursor: cursorPhysical() });
      }
      const d = getDevice();
      if (!d.connected) return json(res, 503, { ok: false, error: 'HID Remapper が接続されていません' });
      if (!d.canMove) return json(res, 503, { ok: false, error: '最新のQuiver専用ファーム（Quiver3）が必要です' });
      if (!d.mouseMode) return json(res, 409, { ok: false, error: 'ボードがキーボード・マウスとして動いていません（コントローラーの種類が Switch / Stadia になっています）' });

      if (route === 'POST /stop') { await sendMove(0, 0, 0, true); return json(res, 200, { ok: true }); }
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      let result;
      if (route === 'POST /move') result = await moveAbsolute(body);
      else if (route === 'POST /move-by') result = await moveRelative(body);
      else return json(res, 404, { ok: false, error: '見つかりません。使えるのは /move /move-by /stop /status です' });
      onLog?.({ id, route, body, result });
      return json(res, result.ok ? 200 : 422, result);
    } catch (e) {
      return json(res, e.code && e.code >= 400 ? e.code : 500, { ok: false, error: e.message || String(e) });
    }
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server; server = null;
      s.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }

  async function configure(next) {
    const changed = next.port !== conf.port || next.enabled !== conf.enabled;
    conf = { ...conf, ...next };
    if (!changed && (server || !conf.enabled)) return { listening: !!server, port: conf.port };
    await stop();
    if (!conf.enabled) return { listening: false, port: conf.port };
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => { handle(req, res); });
      s.on('error', (e) => resolve({ listening: false, port: conf.port, error: e.code === 'EADDRINUSE' ? `ポート ${conf.port} はほかのアプリが使っています` : e.message }));
      s.listen(conf.port, '127.0.0.1', () => { server = s; resolve({ listening: true, port: conf.port }); });
    });
  }

  return { configure, stop, cursorPhysical };
}

module.exports = { createApi };
