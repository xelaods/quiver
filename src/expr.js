// 揺れパターン → HID Remapper の式（逆ポーランド記法）を生成し、
// 同じ式をアプリ内で評価してプレビューに使う。
(function (global) {
  const BUTTONS = [
    { id: '0x00090001', label: '左クリック', short: 'L' },
    { id: '0x00090002', label: '右クリック', short: 'R' },
    { id: '0x00090003', label: 'ホイールクリック', short: 'M' },
    { id: '0x00090004', label: 'サイドボタン（戻る）', short: 'B4' },
    { id: '0x00090005', label: 'サイドボタン（進む）', short: 'B5' },
  ];

  const CURSOR_X = '0x00010030';
  const CURSOR_Y = '0x00010031';
  const EXPR_1 = '0xfff30001';
  const EXPR_2 = '0xfff30002';

  // 小数第3位まで（デバイス内部は x1000 の固定小数点）
  function num(x) {
    const r = Math.round(x * 1000) / 1000;
    return Object.is(r, -0) || r === 0 ? '0' : String(r);
  }

  /**
   * p = { hold, trigger, mode: 'sharp'|'smooth', amplitude, period, randomness, angle }
   *  amplitude : 片道の移動量（カウント）
   *  period    : 1往復の時間（ms）
   *  randomness: 0〜0.8（揺れ幅のばらつき）
   *  angle     : 0=左右, 45=右上↔左下, 90=上下, -45=左上↔右下
   */
  function build(p) {
    const P = Math.max(4, Math.round(p.period));
    const A = Math.max(0.1, p.amplitude);
    const R = Math.min(0.9, Math.max(0, p.randomness));

    const gate = p.hold
      ? `${p.hold} input_state_binary ${p.trigger} input_state_binary mul`
      : `${p.trigger} input_state_binary`;

    let wave, speed, noise;
    if (p.mode === 'smooth') {
      // 速度を cos にすると位置は sin（端で減速して折り返す）
      wave = `time ${P} mod ${num(360 / P)} mul cos`;
      speed = (A * Math.PI) / P;
      noise = 'time 7000 mod 0.051 mul sin time 3100 mod 0.116 mul sin mul';
    } else {
      const H = P / 2;
      wave = `time ${P} mod ${num(H)} lt 2 mul -1 add`;
      speed = A / H;
      noise = 'time 360 mod 97 mul sin time 1000 mod 3.7 mul sin mul';
    }

    const rad = (p.angle * Math.PI) / 180;
    const cx = Math.cos(rad);
    const cy = -Math.sin(rad); // 画面のYは下向きが正

    let s = `${gate} ${wave} mul ${num(speed)} mul`;
    if (R > 0) s += ` ${noise} ${num(R)} mul 1 add mul`;

    return {
      expr1: `${s} dup 1 store ${num(cx)} mul`,
      expr2: `1 recall ${num(cy)} mul`,
      speed,
    };
  }

  function mappings(p) {
    const list = [
      { source: EXPR_1, target: CURSOR_X },
      { source: EXPR_2, target: CURSOR_Y },
    ];
    // 式でボタンを読むと「割り当て済み」扱いになるので、クリックを素通しさせる
    const pass = new Set([p.trigger, p.hold].filter(Boolean));
    for (const b of pass) list.push({ source: b, target: b });
    return list;
  }

  // --- 評価器（プレビュー用）---
  function tokenize(expr) {
    return expr.trim().split(/\s+/).filter(Boolean);
  }

  function evaluate(tokens, env) {
    const st = [];
    const pop = () => (st.length ? st.pop() : 0);
    for (const tk of tokens) {
      if (/^0x/i.test(tk)) { st.push(tk.toLowerCase()); continue; }
      if (/^[0-9-]/.test(tk)) { st.push(parseFloat(tk)); continue; }
      switch (tk) {
        case 'input_state_binary': st.push(env.pressed.has(pop()) ? 1 : 0); break;
        case 'input_state': { const u = pop(); st.push(env.axes && u in env.axes ? env.axes[u] : env.pressed.has(u) ? 1 : 0); break; }
        case 'time': st.push(env.t); break;
        case 'add': { const y = pop(), x = pop(); st.push(x + y); break; }
        case 'sub': { const y = pop(), x = pop(); st.push(x - y); break; }
        case 'mul': { const y = pop(), x = pop(); st.push(x * y); break; }
        case 'div': { const y = pop(), x = pop(); st.push(y === 0 ? 0 : x / y); break; }
        case 'mod': { const y = pop(), x = pop(); st.push(y === 0 ? 0 : ((x % y) + y) % y); break; }
        case 'lt': { const y = pop(), x = pop(); st.push(x < y ? 1 : 0); break; }
        case 'gt': { const y = pop(), x = pop(); st.push(x > y ? 1 : 0); break; }
        case 'sin': st.push(Math.sin((pop() * Math.PI) / 180)); break;
        case 'cos': st.push(Math.cos((pop() * Math.PI) / 180)); break;
        case 'abs': st.push(Math.abs(pop())); break;
        case 'sign': st.push(Math.sign(pop())); break;
        case 'sqrt': { const x = pop(); st.push(x >= 0 ? Math.sqrt(x) : x); break; }
        case 'max': { const y = pop(), x = pop(); st.push(Math.max(x, y)); break; }
        case 'min': { const y = pop(), x = pop(); st.push(Math.min(x, y)); break; }
        case 'clamp': { const z = pop(), y = pop(), x = pop(); st.push(Math.min(z, Math.max(y, x))); break; }
        case 'not': st.push(pop() === 0 ? 1 : 0); break;
        case 'dup': { const x = pop(); st.push(x, x); break; }
        case 'swap': { const y = pop(), x = pop(); st.push(y, x); break; }
        case 'store': { const n = pop(), x = pop(); env.reg[n] = x; break; }
        case 'recall': st.push(env.reg[pop()] || 0); break;
        default: throw new Error('未対応の命令: ' + tk);
      }
    }
    return st.length ? st[st.length - 1] : 0;
  }

  global.QuiverExpr = { BUTTONS, CURSOR_X, CURSOR_Y, build, mappings, tokenize, evaluate };
})(window);
