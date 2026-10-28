// HID Remapper（ファーム r2026 系 / 設定バージョン18）との通信。
// 公式設定ツール config-tool-web と同じフィーチャーレポートを送る。
(function (global) {
  const REPORT_ID_CONFIG = 100;
  const REPORT_ID_MONITOR = 101;
  const CONFIG_SIZE = 32;
  const CONFIG_VERSION = 18;

  const CMD = {
    SET_CONFIG: 2, GET_CONFIG: 3, CLEAR_MAPPING: 4, ADD_MAPPING: 5, PERSIST_CONFIG: 7,
    SUSPEND: 10, RESUME: 11, CLEAR_MACROS: 15, CLEAR_EXPRESSIONS: 19,
    APPEND_TO_EXPRESSION: 20, SET_MONITOR_ENABLED: 22, CLEAR_QUIRKS: 23,
  };

  const OPS = {
    PUSH: 0, PUSH_USAGE: 1, INPUT_STATE: 2, ADD: 3, MUL: 4, EQ: 5, TIME: 6, MOD: 7, GT: 8,
    NOT: 9, INPUT_STATE_BINARY: 10, ABS: 11, DUP: 12, SIN: 13, COS: 14, RELU: 17, CLAMP: 18,
    STORE: 29, RECALL: 30, SQRT: 31, ROUND: 33, MIN: 39, MAX: 40, DIV: 42, SWAP: 43,
    SIGN: 45, SUB: 46, LT: 49, LAYER_STATE: 20, BITWISE_AND: 25, MONITOR: 44, PREV_INPUT_STATE_BINARY: 28,
  };

  const U8 = 1, U16 = 2, U32 = 4, I32 = -4, I16 = -2;

  function encodeExpression(expr) {
    return expr.trim().split(/\s+/).filter(Boolean).map((tk) => {
      if (/^0x/i.test(tk)) return [OPS.PUSH_USAGE, parseInt(tk, 16) >>> 0];
      if (/^[0-9-]/.test(tk)) return [OPS.PUSH, Math.round(parseFloat(tk) * 1000) >>> 0];
      const op = OPS[tk.toUpperCase()];
      if (op === undefined) throw new Error('式に未知の命令があります: ' + tk);
      return [op];
    });
  }

  class Remapper extends EventTarget {
    constructor() {
      super();
      this.device = null;
      this.busy = false;
      this._onReport = this._onReport.bind(this);
      navigator.hid.addEventListener('disconnect', (e) => {
        if (this.device && e.device === this.device) {
          this.device = null;
          this.dispatchEvent(new Event('disconnected'));
        }
      });
      navigator.hid.addEventListener('connect', () => this.autoConnect());
    }

    get connected() { return !!(this.device && this.device.opened); }
    get name() { return this.device ? this.device.productName : ''; }

    static pick(devices) {
      return devices.find((d) => d.collections.some((c) => c.usagePage === 0xff00));
    }

    async autoConnect() {
      if (this.connected) return true;
      const d = Remapper.pick(await navigator.hid.getDevices());
      if (!d) return false;
      try { await this._open(d); return true; } catch { return false; }
    }

    async request() {
      const devices = await navigator.hid.requestDevice({ filters: [{ usagePage: 0xff00, usage: 0x0020 }] });
      const d = Remapper.pick(devices);
      if (!d) throw new Error('HID Remapper が見つかりません。ボードの「USB」側がPCにつながっているか確認してください。');
      await this._open(d);
    }

    async _open(d) {
      if (!d.opened) await d.open();
      this.device = d;
      await this._send(CMD.GET_CONFIG);
      const [ver] = await this._read([U8]);
      if (ver !== CONFIG_VERSION) {
        this.device = null;
        throw new Error(`ファームのバージョンが合いません（設定v${ver}）。最新のHID Remapperファームを書き込んでください。`);
      }
      d.addEventListener('inputreport', this._onReport);
      this.dispatchEvent(new Event('connected'));
      this.setMonitor(true).catch(() => {});
    }

    async disconnect() {
      if (!this.device) return;
      try { await this.setMonitor(false); await this.device.close(); } catch {}
      this.device = null;
      this.dispatchEvent(new Event('disconnected'));
    }

    // Quiver専用ファーム（Quiver2以降）：レジスタを直接書き換える
    get canSetRegister() { return this.connected && /quiver[2-9]/i.test(this.name || ''); }
    // Quiver専用ファーム（Quiver3以降）：PCからマウスカーソルを動かす
    get canMove() { return this.connected && /quiver[3-9]/i.test(this.name || ''); }
    /**
     * dx, dy : 動かす量（カウント。ポインターの精度を高めるがオフなら、ほぼピクセルと同じ）
     * step   : 1msあたりの最大の移動量（0 = できるだけ速く）
     * replace: まだ動き終わっていない分を捨ててから動かす
     */
    async move(dx, dy, step = 0, replace = true) {
      if (!this.canMove) throw new Error('この機能には最新のQuiver専用ファーム（Quiver3）が必要です');
      if (this.busy) throw new Error('設定を書き込み中です');
      const clamp16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v)));
      await this._send(65, [[I16, clamp16(dx)], [I16, clamp16(dy)], [U16, Math.max(0, Math.min(2000, Math.round(step)))], [U8, replace ? 1 : 0]]);
    }
    async setRegister(reg, value) {
      if (!this.canSetRegister) throw new Error('この機能には新しいQuiver専用ファームが必要です');
      if (this.busy) return false;
      await this._send(64, [[U8, reg], [I32, Math.round(value * 1000)]]);
      return true;
    }

    async setMonitor(on) {
      if (this.connected) await this._send(CMD.SET_MONITOR_ENABLED, [[U8, on ? 1 : 0]]);
    }

    _onReport(e) {
      if (e.reportId !== REPORT_ID_MONITOR) return;
      for (let i = 0; i < 7; i++) {
        const usage = e.data.getUint32(i * 9, true);
        if (!usage) continue;
        this.dispatchEvent(new CustomEvent('input', {
          detail: { usage: '0x' + usage.toString(16).padStart(8, '0'), value: e.data.getInt32(i * 9 + 4, true) },
        }));
      }
    }

    async _send(command, fields = []) {
      const buf = new ArrayBuffer(CONFIG_SIZE);
      const dv = new DataView(buf);
      dv.setUint8(0, CONFIG_VERSION);
      dv.setUint8(1, command);
      let pos = 2;
      for (const [t, v] of fields) {
        if (t === U8) { dv.setUint8(pos, v); pos += 1; }
        else if (t === U16) { dv.setUint16(pos, v, true); pos += 2; }
        else if (t === I16) { dv.setInt16(pos, v, true); pos += 2; }
        else if (t === U32) { dv.setUint32(pos, v >>> 0, true); pos += 4; }
        else { dv.setInt32(pos, v, true); pos += 4; }
      }
      dv.setUint32(CONFIG_SIZE - 4, crc32(dv, CONFIG_SIZE - 4), true);
      await this.device.sendFeatureReport(REPORT_ID_CONFIG, buf);
    }

    async _read(fields) {
      let delay = 2;
      for (let attempt = 0; attempt < 10; attempt++) {
        const raw = await this.device.receiveFeatureReport(REPORT_ID_CONFIG);
        const dv = new DataView(raw.buffer, 1);
        if (dv.byteLength > 0) {
          if (dv.getUint32(CONFIG_SIZE - 4, true) !== crc32(dv, CONFIG_SIZE - 4)) throw new Error('通信エラー（CRC不一致）');
          const out = []; let pos = 0;
          for (const t of fields) {
            if (t === U8) { out.push(dv.getUint8(pos)); pos += 1; }
            else if (t === U16) { out.push(dv.getUint16(pos, true)); pos += 2; }
            else if (t === U32) { out.push(dv.getUint32(pos, true)); pos += 4; }
            else { out.push(dv.getInt32(pos, true)); pos += 4; }
          }
          return out;
        }
        await new Promise((r) => setTimeout(r, delay)); delay *= 2;
      }
      throw new Error('デバイスから応答がありません');
    }

    /**
     * cfg = {
     *   descriptor: 0=マウス・キーボード, 2=Switch(HORIPAD), 4=Stadia ...
     *   passthrough: 割り当てのない入力をそのまま流すレイヤーのビットマスク
     *   mappings: [{ source, target, scaling?, layers?, sticky? }]
     *   expressions: [string, ...]（最大8個）
     * }
     */
    async write(cfg, onProgress = () => {}) {
      if (!this.connected) throw new Error('デバイスが接続されていません');
      if (this.busy) throw new Error('書き込み中です');
      if (cfg.expressions.length > 8) throw new Error('式は8個までです');
      this.busy = true;
      const steps = 6 + cfg.mappings.length + cfg.expressions.length;
      let done = 0;
      const tick = () => onProgress(++done / steps);
      try {
        await this._send(CMD.SUSPEND); tick();
        // 公式ツールの初期値と同じ基本設定（未割り当て入力は全レイヤーで素通し）
        await this._send(CMD.SET_CONFIG, [
          [U8, 1 << 6], [U8, cfg.passthrough ?? 0xff], [U32, 1000000], [U8, 0], [U32, 200000], [U8, 5],
          [U8, cfg.descriptor ?? 0], [U8, 0],
        ]); tick();
        await this._send(CMD.CLEAR_MAPPING);
        for (const m of cfg.mappings) {
          await this._send(CMD.ADD_MAPPING, [
            [U32, parseInt(m.target, 16)], [U32, parseInt(m.source, 16)], [I32, m.scaling ?? 1000],
            [U8, m.layers ?? 1], [U8, m.sticky ? 1 : 0], [U8, 0],
          ]); tick();
        }
        await this._send(CMD.CLEAR_MACROS); tick();
        await this._send(CMD.CLEAR_EXPRESSIONS);
        for (let i = 0; i < cfg.expressions.length; i++) {
          let elems = encodeExpression(cfg.expressions[i]);
          while (elems.length) {
            let left = 24, n = 0; const items = [];
            while (elems.length && left > 0) {
              const [op, val] = elems[0];
              if (op === OPS.PUSH || op === OPS.PUSH_USAGE) {
                if (left < 5) break;
                items.push([U8, op], [U32, val]); left -= 5;
              } else { items.push([U8, op]); left -= 1; }
              n++; elems = elems.slice(1);
            }
            await this._send(CMD.APPEND_TO_EXPRESSION, [[U8, i], [U8, n], ...items]);
          }
          tick();
        }
        await this._send(CMD.CLEAR_QUIRKS); tick();
        await this._send(CMD.PERSIST_CONFIG);
        const [code] = await this._read([U8]); tick();
        await this._send(CMD.RESUME); tick();
        if (code === 2) throw new Error('設定が大きすぎて保存できません');
        if (code !== 1) throw new Error('保存に失敗しました（コード ' + code + '）');
      } finally {
        this.busy = false;
      }
    }
  }

  global.Remapper = Remapper;
  global.encodeExpression = encodeExpression;
})(window);
