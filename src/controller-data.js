// コントローラーモードのデータ定義と、HID Remapper 設定への変換。
(function (global) {
  const LS = { x: '0x00010030', y: '0x00010031' };
  const RS = { x: '0x00010032', y: '0x00010035' };
  const LAYER_1 = '0xfff10001';
  const PAUSE_MONITOR = '0xfff10000';
  const MODE_REG = 10; // 専用ファームのモード（0=キーボード・マウス、1=コントローラー）

  // ---- ボタンのアイコン（線画。色は currentColor）----
  const I = (body, vb = '0 0 16 16') =>
    `<svg class="ic" viewBox="${vb}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    view: I('<rect x="2.2" y="3.2" width="7.6" height="6.2" rx="1.4"/><path d="M6.2 9.4v1.9a1.3 1.3 0 0 0 1.3 1.3h5a1.3 1.3 0 0 0 1.3-1.3V7.3A1.3 1.3 0 0 0 12.5 6h-2.7"/>'),
    menu: I('<path d="M3 4.5h10M3 8h10M3 11.5h10"/>'),
    guide: I('<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>'),
    share: I('<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4"/><path d="M8 10.8V5.4M5.8 7.4 8 5.2l2.2 2.2"/>'),
    minus: I('<path d="M4 8h8" stroke-width="1.8"/>'),
    plus: I('<path d="M4 8h8M8 4v8" stroke-width="1.8"/>'),
    home: I('<path d="M2.8 7.4 8 3l5.2 4.4M4.4 6.2v6.4h7.2V6.2"/>'),
    capture: I('<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2"/><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>'),
    options: I('<circle cx="4" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>'),
    stick: I('<circle cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="2.2"/>'),
  };

  // 出力の種類（意味で持っておき、コントローラーの種類ごとに実際のコードへ変換）
  // ボタン: [HIDコード, 表示名, 短い表示, アイコン名]
  // face: A/B/X/Y の位置（n=上, e=右, s=下, w=左）と色付きにするか
  const TYPES = {
    quiver: {
      name: 'Quiver専用ファーム',
      descriptor: 0,
      instant: true,
      badge: 'おすすめ',
      desc: 'キーボード・マウスとコントローラーを、切り替えキーで挿し直しなしに瞬時に切り替えます。PCとSteam向けです。',
      ls: { x: '0x00010033', y: '0x00010034' },
      rs: { x: '0x00010032', y: '0x00010035' },
      face: { A: 's', B: 'e', X: 'w', Y: 'n' },
      faceColor: true,
      buttons: {
        A: ['0x00090009', 'A'], B: ['0x0009000a', 'B'], X: ['0x0009000b', 'X'], Y: ['0x0009000c', 'Y'],
        L: ['0x0009000d', 'LB'], R: ['0x0009000e', 'RB'], ZL: ['0x0009000f', 'LT'], ZR: ['0x00090010', 'RT'],
        minus: ['0x00090011', 'View', null, 'view'], plus: ['0x00090012', 'Menu', null, 'menu'],
        L3: ['0x00090013', '左スティック押し込み', 'LS'], R3: ['0x00090014', '右スティック押し込み', 'RS'],
        home: ['0x00090015', 'Guide', null, 'guide'], capture: ['0x00090016', 'Share', null, 'share'],
      },
    },
    switch: {
      name: 'Switch（HORIPAD互換）',
      descriptor: 2,
      desc: 'Nintendo Switch にそのまま使えます。PCでは Steam 経由で使うのがおすすめです。',
      face: { A: 'e', B: 's', X: 'n', Y: 'w' },
      buttons: {
        A: ['0x00090003', 'A'], B: ['0x00090002', 'B'], X: ['0x00090004', 'X'], Y: ['0x00090001', 'Y'],
        L: ['0x00090005', 'L'], R: ['0x00090006', 'R'], ZL: ['0x00090007', 'ZL'], ZR: ['0x00090008', 'ZR'],
        L3: ['0x0009000b', '左スティック押し込み', 'LS'], R3: ['0x0009000c', '右スティック押し込み', 'RS'],
        minus: ['0x00090009', '−ボタン', null, 'minus'], plus: ['0x0009000a', '＋ボタン', null, 'plus'],
        home: ['0x0009000d', 'HOME', null, 'home'], capture: ['0x0009000e', 'キャプチャー', null, 'capture'],
      },
    },
    stadia: {
      name: 'Stadia（PC向け）',
      descriptor: 4,
      desc: 'PC向けの汎用コントローラーとして認識されます。Steam ではXboxコントローラーのように使えます。',
      face: { A: 's', B: 'e', X: 'w', Y: 'n' },
      buttons: {
        A: ['0x00090001', 'A'], B: ['0x00090002', 'B'], X: ['0x00090004', 'X'], Y: ['0x00090005', 'Y'],
        L: ['0x00090007', 'L1'], R: ['0x00090008', 'R1'], ZL: ['0x00090014', 'L2'], ZR: ['0x00090013', 'R2'],
        L3: ['0x0009000e', '左スティック押し込み', 'L3'], R3: ['0x0009000f', '右スティック押し込み', 'R3'],
        minus: ['0x0009000b', 'Options', null, 'options'], plus: ['0x0009000c', 'Menu', null, 'menu'],
        home: ['0x0009000d', 'Stadia', null, 'guide'], capture: ['0x00090012', 'キャプチャー', null, 'capture'],
      },
    },
  };

  // コントローラー図の配置（360×256 の座標。cx, cy は中心）
  const PAD_W = 360, PAD_H = 256;
  const STICK_L = { cx: 82, cy: 112 }, STICK_R = { cx: 230, cy: 180 };
  const DPAD = { cx: 130, cy: 180 }, FACE = { cx: 284, cy: 112 };
  const LAYOUT = {
    ZL: { cx: 62, cy: 14, w: 76, h: 24, kind: 'trig' },
    ZR: { cx: 298, cy: 14, w: 76, h: 24, kind: 'trig' },
    L: { cx: 72, cy: 42, w: 92, h: 22, kind: 'bump' },
    R: { cx: 288, cy: 42, w: 92, h: 22, kind: 'bump' },
    L3: { ...STICK_L, w: 36, h: 36, kind: 'stick' },
    R3: { ...STICK_R, w: 36, h: 36, kind: 'stick' },
    lsU: { cx: STICK_L.cx, cy: STICK_L.cy - 34, w: 22, h: 22, kind: 'dir', rot: 0 },
    lsD: { cx: STICK_L.cx, cy: STICK_L.cy + 34, w: 22, h: 22, kind: 'dir', rot: 180 },
    lsL: { cx: STICK_L.cx - 34, cy: STICK_L.cy, w: 22, h: 22, kind: 'dir', rot: 270 },
    lsR: { cx: STICK_L.cx + 34, cy: STICK_L.cy, w: 22, h: 22, kind: 'dir', rot: 90 },
    rsU: { cx: STICK_R.cx, cy: STICK_R.cy - 34, w: 22, h: 22, kind: 'dir', rot: 0 },
    rsD: { cx: STICK_R.cx, cy: STICK_R.cy + 34, w: 22, h: 22, kind: 'dir', rot: 180 },
    rsL: { cx: STICK_R.cx - 34, cy: STICK_R.cy, w: 22, h: 22, kind: 'dir', rot: 270 },
    rsR: { cx: STICK_R.cx + 34, cy: STICK_R.cy, w: 22, h: 22, kind: 'dir', rot: 90 },
    dU: { cx: DPAD.cx, cy: DPAD.cy - 23, w: 22, h: 22, kind: 'dpad', rot: 0 },
    dD: { cx: DPAD.cx, cy: DPAD.cy + 23, w: 22, h: 22, kind: 'dpad', rot: 180 },
    dL: { cx: DPAD.cx - 23, cy: DPAD.cy, w: 22, h: 22, kind: 'dpad', rot: 270 },
    dR: { cx: DPAD.cx + 23, cy: DPAD.cy, w: 22, h: 22, kind: 'dpad', rot: 90 },
    minus: { cx: 148, cy: 104, w: 24, h: 24, kind: 'sys' },
    plus: { cx: 212, cy: 104, w: 24, h: 24, kind: 'sys' },
    home: { cx: 180, cy: 80, w: 32, h: 32, kind: 'sys big' },
    capture: { cx: 180, cy: 124, w: 26, h: 20, kind: 'sys' },
  };
  const FACE_POS = { n: [0, -28], s: [0, 28], w: [-28, 0], e: [28, 0] };
  function layoutOf(type, key) {
    if (LAYOUT[key]) return LAYOUT[key];
    const pos = TYPES[type].face[key];
    if (!pos) return null;
    const [dx, dy] = FACE_POS[pos];
    return { cx: FACE.cx + dx, cy: FACE.cy + dy, w: 26, h: 26, kind: 'face' };
  }
  const PAD_KEYS = ['ZL', 'ZR', 'L', 'R', 'lsU', 'lsD', 'lsL', 'lsR', 'L3', 'dU', 'dD', 'dL', 'dR',
    'minus', 'home', 'plus', 'capture', 'A', 'B', 'X', 'Y', 'rsU', 'rsD', 'rsL', 'rsR', 'R3'];

  const GROUPS = [
    { name: 'ボタン', items: ['A', 'B', 'X', 'Y'] },
    { name: 'ショルダー', items: ['L', 'R', 'ZL', 'ZR'] },
    { name: 'その他', items: ['L3', 'R3', 'minus', 'plus', 'home', 'capture'] },
    { name: '十字キー', items: ['dU', 'dD', 'dL', 'dR'] },
    { name: '左スティック', items: ['lsU', 'lsD', 'lsL', 'lsR'] },
    { name: '右スティック', items: ['rsU', 'rsD', 'rsL', 'rsR'] },
  ];

  const FIXED = {
    dU: { label: '十字↑', short: '↑', usage: '0xfff90003' },
    dD: { label: '十字↓', short: '↓', usage: '0xfff90004' },
    dL: { label: '十字←', short: '←', usage: '0xfff90001' },
    dR: { label: '十字→', short: '→', usage: '0xfff90002' },
    lsU: { label: '左スティック↑', short: 'L↑', stick: 'ls', axis: 'y', scaling: 0 },
    lsD: { label: '左スティック↓', short: 'L↓', stick: 'ls', axis: 'y', scaling: 255000 },
    lsL: { label: '左スティック←', short: 'L←', stick: 'ls', axis: 'x', scaling: 0 },
    lsR: { label: '左スティック→', short: 'L→', stick: 'ls', axis: 'x', scaling: 255000 },
    rsU: { label: '右スティック↑', short: 'R↑', stick: 'rs', axis: 'y', scaling: 0 },
    rsD: { label: '右スティック↓', short: 'R↓', stick: 'rs', axis: 'y', scaling: 255000 },
    rsL: { label: '右スティック←', short: 'R←', stick: 'rs', axis: 'x', scaling: 0 },
    rsR: { label: '右スティック→', short: 'R→', stick: 'rs', axis: 'x', scaling: 255000 },
  };

  const sticksOf = (type) => ({ ls: TYPES[type].ls || LS, rs: TYPES[type].rs || RS });

  function output(type, key) {
    const f = FIXED[key];
    if (f) {
      const usage = f.stick ? sticksOf(type)[f.stick][f.axis] : f.usage;
      return { key, ...f, usage };
    }
    const t = TYPES[type];
    const b = t.buttons[key];
    if (!b) return null;
    const face = t.face[key] ? (t.faceColor ? key.toLowerCase() : 'mono') : null;
    return { key, label: b[1], short: b[2] || b[1], usage: b[0], icon: b[3] ? ICONS[b[3]] : null, face };
  }

  // ---- キーボード（US配列ベース。かっこ内はHIDコード）----
  const k = (label, code, hid, w = 1) => ({ label, code, usage: '0x000700' + hid, w });
  const KEYBOARD = [
    [k('Esc', 'Escape', '29'), { gap: 0.5 }, k('F1', 'F1', '3a'), k('F2', 'F2', '3b'), k('F3', 'F3', '3c'), k('F4', 'F4', '3d'), { gap: 0.5 },
      k('F5', 'F5', '3e'), k('F6', 'F6', '3f'), k('F7', 'F7', '40'), k('F8', 'F8', '41'), { gap: 0.5 },
      k('F9', 'F9', '42'), k('F10', 'F10', '43'), k('F11', 'F11', '44'), k('F12', 'F12', '45')],
    [k('`', 'Backquote', '35'), k('1', 'Digit1', '1e'), k('2', 'Digit2', '1f'), k('3', 'Digit3', '20'), k('4', 'Digit4', '21'),
      k('5', 'Digit5', '22'), k('6', 'Digit6', '23'), k('7', 'Digit7', '24'), k('8', 'Digit8', '25'), k('9', 'Digit9', '26'),
      k('0', 'Digit0', '27'), k('-', 'Minus', '2d'), k('=', 'Equal', '2e'), k('Back', 'Backspace', '2a', 2)],
    [k('Tab', 'Tab', '2b', 1.5), ...'QWERTYUIOP'.split('').map((c, i) => k(c, 'Key' + c, ['14', '1a', '08', '15', '17', '1c', '18', '0c', '12', '13'][i])),
      k('[', 'BracketLeft', '2f'), k(']', 'BracketRight', '30'), k('\\', 'Backslash', '31', 1.5)],
    [k('Caps', 'CapsLock', '39', 1.75), ...'ASDFGHJKL'.split('').map((c, i) => k(c, 'Key' + c, ['04', '16', '07', '09', '0a', '0b', '0d', '0e', '0f'][i])),
      k(';', 'Semicolon', '33'), k("'", 'Quote', '34'), k('Enter', 'Enter', '28', 2.25)],
    [k('Shift', 'ShiftLeft', 'e1', 2.25), ...'ZXCVBNM'.split('').map((c, i) => k(c, 'Key' + c, ['1d', '1b', '06', '19', '05', '11', '10'][i])),
      k(',', 'Comma', '36'), k('.', 'Period', '37'), k('/', 'Slash', '38'), k('Shift', 'ShiftRight', 'e5', 2.75)],
    [k('Ctrl', 'ControlLeft', 'e0', 1.5), k('Win', 'MetaLeft', 'e3', 1.25), k('Alt', 'AltLeft', 'e2', 1.25), k('Space', 'Space', '2c', 6.5),
      k('Alt', 'AltRight', 'e6', 1.25), k('Ctrl', 'ControlRight', 'e4', 1.25), { gap: 0.25 },
      k('←', 'ArrowLeft', '50'), k('↓', 'ArrowDown', '51'), k('→', 'ArrowRight', '4f')],
  ];
  // ↑キーは最下段の↓の真上に配置（UI側で処理）
  const ARROW_UP = k('↑', 'ArrowUp', '52');

  const KEY_BY_CODE = {};
  const KEY_BY_USAGE = {};
  for (const key of [...KEYBOARD.flat(), ARROW_UP]) {
    if (!key.usage) continue;
    KEY_BY_CODE[key.code] = key;
    KEY_BY_USAGE[key.usage] = key;
  }

  const MOUSE_BUTTONS = [
    { usage: '0x00090001', label: '左クリック', short: '左' },
    { usage: '0x00090002', label: '右クリック', short: '右' },
    { usage: '0x00090003', label: 'ホイールクリック', short: '中' },
    { usage: '0x00090004', label: 'サイド（戻る）', short: '戻' },
    { usage: '0x00090005', label: 'サイド（進む）', short: '進' },
    { usage: 'wheelUp', label: 'ホイール上', short: '↑', wheel: 1 },
    { usage: 'wheelDown', label: 'ホイール下', short: '↓', wheel: -1 },
  ];
  const MOUSE_BY_USAGE = Object.fromEntries(MOUSE_BUTTONS.map((b) => [b.usage, b]));

  function sourceLabel(usage) {
    if (MOUSE_BY_USAGE[usage]) return MOUSE_BY_USAGE[usage].label;
    const key = KEY_BY_USAGE[usage];
    if (!key) return usage;
    if (key.code.endsWith('Right') && /Shift|Control|Alt/.test(key.code)) return '右' + key.label;
    return key.label;
  }

  const kb = (code) => KEY_BY_CODE[code].usage;

  // マウス移動 → スティックの初期値
  //  sens: 感度, yRatio: 縦の感度の倍率, curve: 反応カーブ(-100〜100),
  //  smoothMs: なめらかさ(ms), deadzone: デッドゾーン補正(%), maxOut: 最大の倒し具合(%)
  const MOUSE_DEFAULT = {
    on: true, stick: 'right', sens: 1, yRatio: 1, curve: 0, smoothMs: 8,
    deadzone: 18, maxOut: 100, invertY: false, wheelMs: 40,
  };
  const MOUSE_PRESETS = [
    { name: '標準', v: { sens: 1, yRatio: 1, curve: 0, smoothMs: 8, deadzone: 18, maxOut: 100 } },
    { name: 'FPS・精密', v: { sens: 0.8, yRatio: 0.85, curve: 35, smoothMs: 6, deadzone: 22, maxOut: 100 } },
    { name: 'キビキビ', v: { sens: 1.6, yRatio: 1, curve: -30, smoothMs: 3, deadzone: 20, maxOut: 100 } },
    { name: 'なめらか', v: { sens: 1, yRatio: 1, curve: 15, smoothMs: 18, deadzone: 15, maxOut: 95 } },
  ];
  function defaults() {
    return {
      enabled: false,
      type: 'switch',
      pauseKey: kb('F12'),
      map: {
        [kb('KeyW')]: { out: 'lsU', on: true },
        [kb('KeyA')]: { out: 'lsL', on: true },
        [kb('KeyS')]: { out: 'lsD', on: true },
        [kb('KeyD')]: { out: 'lsR', on: true },
        [kb('Space')]: { out: 'B', on: true },
        [kb('KeyE')]: { out: 'A', on: true },
        [kb('KeyR')]: { out: 'Y', on: true },
        [kb('KeyF')]: { out: 'X', on: true },
        [kb('KeyQ')]: { out: 'L', on: true },
        [kb('ShiftLeft')]: { out: 'L3', on: true },
        [kb('KeyC')]: { out: 'R3', on: true },
        [kb('Tab')]: { out: 'minus', on: true },
        [kb('Escape')]: { out: 'plus', on: true },
        [kb('Digit1')]: { out: 'dU', on: true },
        [kb('Digit2')]: { out: 'dR', on: true },
        [kb('Digit3')]: { out: 'dD', on: true },
        [kb('Digit4')]: { out: 'dL', on: true },
        '0x00090001': { out: 'ZR', on: true },
        '0x00090002': { out: 'ZL', on: true },
        '0x00090003': { out: 'R3', on: true },
        '0x00090004': { out: 'R', on: true },
        '0x00090005': { out: 'L', on: true },
      },
      mouse: { ...MOUSE_DEFAULT },
    };
  }

  const num = (x) => { const r = Math.round(x * 1000) / 1000; return r === 0 ? '0' : String(r); };

  // マウスの移動量（相対）→ スティックの倒し具合（0〜255、中央128）
  //  1. 1msごとの移動量に感度をかけ、指数移動平均でなめらかにする（レジスタ reg）
  //  2. 反応カーブ：+ は小さな動きを細かく、− は小さな動きでも大きく倒す
  //  3. デッドゾーン補正と最大の倒し具合をかけて、中央128に足す
  function mouseExpr(axisUsage, reg, tmp, m, axis = 'x') {
    const D = m.smoothMs > 0 ? Math.exp(-1 / m.smoothMs) : 0;
    const ratio = axis === 'y' ? (m.yRatio ?? 1) : 1;
    const inv = axis === 'y' && m.invertY ? -1 : 1;
    const G = inv * m.sens * ratio * (1 - D) * 8;
    const DZ = Math.min(100, Math.max(0, Math.round((m.deadzone / 100) * 127)));
    const M = Math.max(DZ + 1, Math.round(127 * (m.maxOut ?? 100) / 100));
    const S = (M - DZ) / 127;
    const c = Math.max(-1, Math.min(1, (m.curve || 0) / 100));

    let e = `${axisUsage} input_state ${num(G)} mul`;
    if (D > 0) e += ` ${reg} recall ${num(D)} mul add`;
    e += ' -127 127 clamp';
    if (D > 0) e += ` dup ${reg} store`;
    e += ` dup ${tmp} store`;
    if (c > 0.0005) {
      e += ` dup abs mul 127 div ${num(c)} mul ${tmp} recall ${num(1 - c)} mul add`;
    } else if (c < -0.0005) {
      e += ` dup sign swap abs 127 mul sqrt mul ${num(-c)} mul ${tmp} recall ${num(1 + c)} mul add`;
    }
    // ほぼ止まっている（カーブ前の値が1未満）ときは、すぐ中央に戻す
    e += ` dup sign ${DZ} mul swap ${num(S)} mul add ${tmp} recall abs 1 gt mul 128 add`;
    return e;
  }

  // 反応グラフ用：入力（-127〜127）→ 出力（-127〜127）
  function responseOf(m, u) {
    const DZ = Math.min(100, Math.max(0, Math.round((m.deadzone / 100) * 127)));
    const M = Math.max(DZ + 1, Math.round(127 * (m.maxOut ?? 100) / 100));
    const c = Math.max(-1, Math.min(1, (m.curve || 0) / 100));
    let o = u;
    if (c > 0) o = u * (1 - c) + (u * Math.abs(u) / 127) * c;
    else if (c < 0) o = u * (1 + c) - c * Math.sign(u) * Math.sqrt(127 * Math.abs(u));
    return Math.abs(u) > 1 ? Math.sign(o) * DZ + o * (M - DZ) / 127 : 0;
  }

  // ホイール：1ノッチを、決まった時間だけ押した入力に変える（レジスタ reg で残り時間を数える）
  function wheelExpr(dir, reg, ms, target) {
    let e = `0x00010038 input_state 0 ${dir > 0 ? 'gt' : 'lt'} ${Math.max(1, Math.round(ms))} mul ${reg} recall 1 sub max dup ${reg} store 0 gt`;
    // スティックの方向へ割り当てるときは、倒し具合（中央128）を直接出す
    if (target.stick) e += ` ${target.scaling ? 127 : -127} mul 128 add`;
    return e;
  }

  /**
   * ctl    : コントローラーの設定
   * shake  : Quiver専用ファームのとき、キーボード・マウス側（レイヤー0）に一緒に入れる揺れの設定
   *          { mappings, expressions }（揺れの式は Expression 1・2 を使う前提）
   */
  function buildConfig(ctl, shake = null) {
    const type = TYPES[ctl.type] || TYPES.switch;
    const instant = !!type.instant;
    // 専用ファーム：レイヤー0 = キーボード・マウス、レイヤー1 = コントローラー
    const ctlLayers = instant ? 0b10 : 0b01;
    const mappings = [];
    const expressions = [];
    const m = { ...MOUSE_DEFAULT, ...ctl.mouse };

    if (instant && shake) {
      for (const x of shake.mappings) mappings.push({ ...x, layers: 0b01 });
      expressions.push(...shake.expressions);
    }
    while (instant && expressions.length < 2) expressions.push('0');

    // レジスタ：揺れ=1、マウス=3・4、ホイール=5・6、計算用=7
    const wheels = [];
    for (const [source, a] of Object.entries(ctl.map)) {
      if (!a.on || source === ctl.pauseKey) continue;
      const o = output(ctl.type, a.out);
      if (!o) continue;
      const wb = MOUSE_BY_USAGE[source];
      if (wb && wb.wheel) { wheels.push({ wb, o }); continue; }
      mappings.push({ source, target: o.usage, scaling: o.scaling ?? 1000, layers: ctlLayers });
    }
    if (m.on && m.stick !== 'off') {
      const st = sticksOf(ctl.type)[m.stick === 'left' ? 'ls' : 'rs'];
      const ix = expressions.length + 1;
      expressions.push(mouseExpr('0x00010030', 3, 7, m, 'x'));
      expressions.push(mouseExpr('0x00010031', 4, 7, m, 'y'));
      mappings.push({ source: exprUsage(ix), target: st.x, layers: ctlLayers });
      mappings.push({ source: exprUsage(ix + 1), target: st.y, layers: ctlLayers });
    }
    for (const { wb, o } of wheels) {
      const ix = expressions.length + 1;
      expressions.push(wheelExpr(wb.wheel, wb.wheel > 0 ? 5 : 6, m.wheelMs, o));
      mappings.push({ source: exprUsage(ix), target: o.usage, scaling: 1000, layers: ctlLayers });
    }
    if (instant) {
      // 専用ファーム：モードはレジスタ10（0=キーボード・マウス、1=コントローラー）で決める。
      // 切り替えキーを押すたびに反転し、PCの自動切り替えからも書き換えられる。
      const k = ctl.pauseKey;
      const toggle = k
        ? `${k} input_state_binary ${k} prev_input_state_binary not mul ${MODE_REG} recall add 2 mod dup ${MODE_REG} store`
        : `${MODE_REG} recall`;
      const ix = expressions.length + 1;
      expressions.push(`layer_state ${PAUSE_MONITOR} monitor ${toggle}`);
      mappings.push({ source: exprUsage(ix), target: LAYER_1, layers: 0b11 });
    } else if (ctl.pauseKey) {
      // 押すたびにレイヤー1を固定／解除
      mappings.push({ source: ctl.pauseKey, target: LAYER_1, layers: 0b11, sticky: true });
      // 今のレイヤー状態をアプリのモニターに送る（表示用）
      expressions.push(`layer_state ${PAUSE_MONITOR} monitor 0`);
    }
    return {
      descriptor: type.descriptor,
      // 専用ファームではレイヤー0だけ素通し（キーボード・マウスとして普通に使える）
      passthrough: instant ? 0b01 : 0,
      mappings,
      expressions,
    };
  }

  const exprUsage = (n) => '0xfff3' + n.toString(16).padStart(4, '0');

  global.QuiverCtl = {
    TYPES, GROUPS, FIXED, KEYBOARD, ARROW_UP, KEY_BY_CODE, KEY_BY_USAGE, MOUSE_BUTTONS, MOUSE_BY_USAGE,
    output, sourceLabel, defaults, buildConfig, mouseExpr, responseOf, wheelExpr, PAUSE_MONITOR,
    ICONS, MODE_REG, LAYOUT, PAD_KEYS, PAD_W, PAD_H, layoutOf, MOUSE_DEFAULT, MOUSE_PRESETS,
  };
})(window);
