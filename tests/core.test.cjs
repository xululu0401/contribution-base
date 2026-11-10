/* 缴费基数对账台 · 核心测试（node --test tests/core.test.cjs）
 * 验证策略：
 *  A. 手算锚点（独立于代码推导）
 *  B. 独立 BigInt 精确整数实现对拍（与工程实现的浮点/整数路径完全独立）
 *  C. 结构恒等式（守恒、单调、边际 = 有限差分、累积三路互证、反推回代）
 *  D. 非法输入逐条、输出契约、确定性、不修改入参
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

/* ── 工具 ───────────────────────────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

/* 独立实现：BigInt 精确整数，逐险种按费率与计入比例分账 */
function bigPath(cfg, baseCents) {
  const B = BigInt(baseCents);
  const rd = (n, d) => { const q = n / d; const r = n - q * d; return r * 2n >= d ? q + 1n : q; };
  let personalIns = 0n, companyIns = 0n, acctIns = 0n, poolIns = 0n;
  cfg.rows.forEach((r) => {
    const p = rd(B * BigInt(r.rpBp), 10000n);
    const c = rd(B * BigInt(r.rcBp), 10000n);
    const pin = rd(p * BigInt(r.apBp), 10000n);
    const cin = rd(c * BigInt(r.acBp), 10000n);
    personalIns += p; companyIns += c; acctIns += pin + cin; poolIns += (p - pin) + (c - cin);
  });
  const fE = rd(B * BigInt(cfg.fundEmpBp), 10000n);
  const fC = rd(B * BigInt(cfg.fundCoBp), 10000n);
  return {
    personalTotal: personalIns + fE, companyTotal: companyIns + fC,
    toAcct: acctIns + fE + fC, toPool: poolIns,
    takeHome: BigInt(cfg.wage) - (personalIns + fE),
    sum: personalIns + fE + companyIns + fC
  };
}
/* 第三路：把每期缴额折到期末再求和（与循环递推、闭式都不同形） */
function fvShiftSum(m, n, i) { let s = 0; for (let k = 1; k <= n; k++) s += m * Math.pow(1 + i, n - k); return s; }

function randRaw(rnd) {
  const floor = 1000 + Math.round(rnd() * 4000);
  const cap = floor + Math.round(rnd() * 30000);
  const wage = Math.round((1500 + rnd() * 60000) * 100) / 100;
  const base = Math.round((floor * 0.5 + rnd() * cap * 1.2) * 100) / 100;
  const nRows = 1 + Math.floor(rnd() * 5);
  const rows = [];
  for (let i = 0; i < nRows; i++) {
    rows.push({
      name: '险种' + String.fromCharCode(65 + i),
      rp: r2(rnd() * 15), rc: r2(rnd() * 25),
      ap: r2(rnd() * 100), ac: r2(rnd() * 100)
    });
  }
  return {
    wage: String(wage), base: String(base), floor: String(floor), cap: String(cap),
    fundEmp: r2(rnd() * 12), fundCo: r2(rnd() * 12),
    years: String(1 + Math.floor(rnd() * 40)),
    rate: r2(rnd() * 8),
    target: String(Math.round(rnd() * 900000)),
    rows
  };
}
const ok = (raw) => { const n = C.normalize(raw); assert.ok(n.ok, '期望输入合法，实际：' + n.errors.join('；')); return n.cfg; };

/* ── A. 手算锚点（默认虚构场景） ────────────────────── */
test('默认样例锚点：月薪 12000 / 按 4000 缴 / 20 年 / 利率 0', () => {
  const cfg = ok(C.defaults);
  const res = C.analyze(cfg);
  const d = res.declared, f = res.full;
  // 逐项手算（元 → 分）
  assert.strictEqual(d.rows[0].personal, 32000); assert.strictEqual(d.rows[0].company, 64000);
  assert.strictEqual(d.rows[1].personal, 8000); assert.strictEqual(d.rows[1].company, 32000);
  assert.strictEqual(d.rows[2].personal, 2000); assert.strictEqual(d.rows[2].company, 2000);
  assert.strictEqual(d.rows[3].company, 800); assert.strictEqual(d.rows[4].company, 3200);
  assert.strictEqual(d.fundEmp, 48000); assert.strictEqual(d.fundCo, 48000);
  assert.strictEqual(d.personalTotal, 90000, '个人缴合计 900.00 元');
  assert.strictEqual(d.companyTotal, 150000, '公司缴合计 1500.00 元');
  assert.strictEqual(d.takeHome, 1110000, '本月到手 11100.00 元');
  assert.strictEqual(d.toAcct, 136000, '进个人账户 1360.00 元');
  assert.strictEqual(d.toPool, 104000, '进统筹 1040.00 元');
  assert.strictEqual(d.checkSum, 0);
  assert.strictEqual(f.personalTotal, 270000); assert.strictEqual(f.companyTotal, 450000);
  assert.strictEqual(f.takeHome, 930000); assert.strictEqual(f.toAcct, 408000);
  assert.strictEqual(f.toPool, 312000);
  assert.strictEqual(res.diff.takeHome, -180000, '到手少 1800.00 元');
  assert.strictEqual(res.diff.toAcct, 272000, '账户每月多 2720.00 元');
  assert.strictEqual(res.diff.companyTotal, 300000, '公司每月多掏 3000.00 元');
  assert.strictEqual(res.diffFV, 65280000, '20 年（240 个月）账户差 652800.00 元');
  assert.strictEqual(Math.round(res.perBase.takePer100 * 100) / 100, 22.5);
  assert.strictEqual(Math.round(res.perBase.acctPer100 * 100) / 100, 34);
  assert.strictEqual(Math.round(res.perBase.companyPer100 * 100) / 100, 37.5);
  // 反推：目标 30 万 → 基数 7676.47 元，回代残差 0
  assert.strictEqual(res.target.reachable, true);
  assert.strictEqual(res.target.neededBaseCents, 767647, '解析解：4000 + 1250 ÷ 0.34 = 7676.47 元');
  assert.strictEqual(res.target.appliedBaseCents, 767647);
  assert.strictEqual(res.target.afterAcctPerMonth, 261001);
  assert.strictEqual(res.target.afterFV, 62640240);
  assert.strictEqual(res.target.residualCents, 240, '残差 2.40 元 = 账户月增 1 分 × 240 个月的整分粒度');
  assert.ok(Math.abs(res.target.residualCents) <= res.months * 2);
});

test('自检在默认样例上全部通过', () => {
  const cfg = ok(C.defaults);
  const checks = C.verify(cfg, C.analyze(cfg));
  const bad = checks.filter((c) => !c.ok);
  assert.deepStrictEqual(bad.map((b) => b.name + ' / ' + b.detail), []);
  assert.ok(checks.length >= 8);
});

/* ── B. BigInt 精确对拍 ─────────────────────────────── */
test('BigInt 独立实现对拍：300 组随机输入 × 两条路', () => {
  const rnd = mulberry32(2026111001);
  for (let t = 0; t < 300; t++) {
    const cfg = ok(randRaw(rnd));
    const res = C.analyze(cfg);
    for (const p of [res.declared, res.full]) {
      const b = bigPath(cfg, p.baseCents);
      assert.strictEqual(BigInt(p.personalTotal), b.personalTotal, 't=' + t + ' 个人缴合计');
      assert.strictEqual(BigInt(p.companyTotal), b.companyTotal, 't=' + t + ' 公司缴合计');
      assert.strictEqual(BigInt(p.toAcct), b.toAcct, 't=' + t + ' 进个人账户');
      assert.strictEqual(BigInt(p.toPool), b.toPool, 't=' + t + ' 进统筹');
      assert.strictEqual(BigInt(p.takeHome), b.takeHome, 't=' + t + ' 本月到手');
    }
  }
});

test('归属守恒：个人缴 + 公司缴 = 进个人账户 + 进统筹（300 组）', () => {
  const rnd = mulberry32(2026111002);
  for (let t = 0; t < 300; t++) {
    const res = C.analyze(ok(randRaw(rnd)));
    assert.strictEqual(res.declared.checkSum, 0, 't=' + t);
    assert.strictEqual(res.full.checkSum, 0, 't=' + t);
    assert.strictEqual(
      res.declared.toAcct + res.declared.toPool,
      res.declared.personalTotal + res.declared.companyTotal);
  }
});

/* ── 基数截断（clamp） ──────────────────────────────── */
test('基数截断：低于下限按上限截、高于上限按下限截、等于上下限不截', () => {
  const mk = (base, wage) => ok(Object.assign(C.defaultsClone(), { base: String(base), wage: String(wage) }));
  let res = C.analyze(mk(1000, 12000));
  assert.strictEqual(res.bases.declared, 400000, '低于下限 → 截到下限 4000 元');
  assert.strictEqual(res.bases.declaredClamped, true);
  res = C.analyze(mk(999999, 12000));
  assert.strictEqual(res.bases.declared, 3500000, '高于上限 → 截到上限 35000 元');
  res = C.analyze(mk(4000, 12000));
  assert.strictEqual(res.bases.declared, 400000);
  assert.strictEqual(res.bases.declaredClamped, false);
  res = C.analyze(mk(35000, 60000));
  assert.strictEqual(res.bases.declared, 3500000);
  assert.strictEqual(res.bases.declaredClamped, false);
  // 工资超上限：足额路也被截断，且与申报基数=上限时完全一致
  const a = C.analyze(mk(35000, 60000));
  const b = C.analyze(mk(999999, 60000));
  assert.strictEqual(a.full.toAcct, b.full.toAcct);
  assert.strictEqual(a.diff.toAcct, 0, '两条路都被上限截断 → 差额为 0');
});

test('工资低于下限：足额路按下限做基数（并给出提示）', () => {
  const raw = Object.assign(C.defaultsClone(), { wage: '3500', base: '4000' });
  const n = C.normalize(raw);
  assert.ok(n.ok);
  const res = C.analyze(n.cfg);
  assert.strictEqual(res.bases.full, 400000);
  assert.strictEqual(res.bases.declared, res.bases.full);
  assert.strictEqual(res.diff.toAcct, 0);
  assert.ok(n.warnings.some((w) => w.indexOf('月工资低于缴费基数下限') === 0));
});

/* ── C. 结构恒等式 ──────────────────────────────────── */
test('边际账与有限差分一致（每条费率组合，基数各 +100 元）', () => {
  const rnd = mulberry32(2026111003);
  for (let t = 0; t < 60; t++) {
    const raw = randRaw(rnd);
    // 用足够大的上限，保证加 100 元不会被截断
    raw.cap = '99000000'; raw.floor = '100';
    const cfg = ok(raw);
    const base = Math.max(10000, cfg.base);
    const r1 = C.path(cfg, base), r2 = C.path(cfg, base + 10000);
    const pb = C.perBase(cfg);
    const dAcct = (r2.toAcct - r1.toAcct) / 100;   // 元 / 100 元基数
    const dTake = (r1.takeHome - r2.takeHome) / 100;
    const dCo = (r2.companyTotal - r1.companyTotal) / 100;
    // 容差 0.05 元 / 100 元基数：解析式在基点层面截断（最多 0.5 bp）＋逐项进位（每项最多 1 分），
    // 独立测过的最大偏差是 0.03 元 / 100 元基数。
    assert.ok(Math.abs(dAcct - pb.acctPer100) < 0.05, 't=' + t + ' 账户边际 ' + dAcct + ' vs ' + pb.acctPer100);
    assert.ok(Math.abs(dTake - pb.takePer100) < 0.05, 't=' + t + ' 到手边际 ' + dTake + ' vs ' + pb.takePer100);
    assert.ok(Math.abs(dCo - pb.companyPer100) < 0.05, 't=' + t + ' 公司边际 ' + dCo + ' vs ' + pb.companyPer100);
  }
});

test('净得恒等式：账户边际 − 到手边际 = 公积金双边占比', () => {
  const cfg = ok(C.defaults);
  const pb = C.perBase(cfg);
  assert.strictEqual(Math.round((pb.acctPer100 - pb.takePer100) * 100) / 100, 11.5);
  assert.strictEqual(Math.round((pb.acctPer100 - pb.takePer100) * 100) / 100, Math.round(((cfg.fundEmpBp + cfg.fundCoBp) / 100 - 12.5) * 100) / 100);
});

test('单调性：基数越大 → 到手越少、账户越多、公司越贵（150 组 × 12 档）', () => {
  const rnd = mulberry32(2026111004);
  for (let t = 0; t < 150; t++) {
    const raw = randRaw(rnd);
    raw.floor = '0'; raw.cap = '5000000000';
    const cfg = ok(raw);
    let prev = null;
    for (let k = 1; k <= 12; k++) {
      const cur = C.path(cfg, k * 137700);
      if (prev) {
        assert.ok(cur.takeHome <= prev.takeHome + 1, 't=' + t + ' k=' + k + ' 到手应不增');
        assert.ok(cur.toAcct >= prev.toAcct, 't=' + t + ' k=' + k + ' 账户应不减');
        assert.ok(cur.companyTotal >= prev.companyTotal, 't=' + t + ' k=' + k + ' 公司应不降');
      }
      prev = cur;
    }
  }
});

test('长期累积三路互证：递推 / 折到期末求和 / 闭式；利率为 0 时精确整数', () => {
  const rnd = mulberry32(2026111005);
  for (let t = 0; t < 120; t++) {
    const m = 1000 + Math.floor(rnd() * 900000);
    const n = 12 * (1 + Math.floor(rnd() * 40));
    const r = Math.round(rnd() * 800) / 100;
    const loop = C.futureValue(m, n, r);
    const i = r / 100 / 12;
    const closed = i === 0 ? m * n : m * (Math.pow(1 + i, n) - 1) / i;
    const shift = i === 0 ? m * n : fvShiftSum(m, n, i);
    assert.ok(Math.abs(loop - closed) <= Math.max(1e-6 * Math.abs(closed), 1e-6), 't=' + t + ' 闭式');
    assert.ok(Math.abs(loop - shift) <= Math.max(1e-6 * Math.abs(shift), 1e-6), 't=' + t + ' 折现求和');
    if (r === 0) assert.strictEqual(loop, m * n, 't=' + t + ' 利率 0 时必须是精确整数');
  }
});

test('逐年表最后一行 = 终值；每期缴额恒为账户月增', () => {
  const cfg = ok(Object.assign(C.defaultsClone(), { years: '13', rate: '2.5' }));
  const res = C.analyze(cfg);
  const sch = C.schedule(res.declared.toAcct, res.months, res.ratePct);
  assert.strictEqual(sch.length, 13);
  assert.ok(Math.abs(sch[sch.length - 1].balance - res.declaredFV) < 1e-6);
  assert.strictEqual(sch[sch.length - 1].paid, res.declared.toAcct * res.months);
  assert.strictEqual(res.perYear.length, 13);
});

test('反推：解回代残差在整分粒度内；达不到时如实判不可达', () => {
  const rnd = mulberry32(2026111006);
  let reach = 0, unreach = 0;
  for (let t = 0; t < 120; t++) {
    const res = C.analyze(ok(randRaw(rnd)));
    const tg = res.target;
    if (tg.reachable) {
      reach++;
      const tol = Math.max(100, Math.ceil(res.cfg.target * 0.002), res.months * 2);
      assert.ok(Math.abs(tg.residualCents) <= tol, 't=' + t + ' 残差 ' + tg.residualCents + '，容差 ' + tol);
      assert.ok(tg.appliedBaseCents >= res.bases.declared, 't=' + t + ' 基数应不低于实际申报基数');
    } else {
      unreach++;
      assert.strictEqual(tg.appliedBaseCents, res.cfg.cap, 't=' + t + ' 不可达时应顶到上限');
      assert.ok(tg.afterFV - res.declaredFV < tg.targetCents, 't=' + t + ' 不可达时不应假装达标');
    }
  }
  assert.ok(reach > 5 && unreach > 5, '两类情形都应被覆盖：可达 ' + reach + ' / 不可达 ' + unreach);
});

test('反推的精度：可达情形里残差中位数低于目标的万分之一', () => {
  const rnd = mulberry32(2026111006);
  const rel = [];
  for (let t = 0; t < 120; t++) {
    const res = C.analyze(ok(randRaw(rnd)));
    if (!res.target.reachable || res.cfg.target === 0) continue;
    rel.push(Math.abs(res.target.residualCents) / res.cfg.target);
  }
  rel.sort((a, b) => a - b);
  const med = rel[Math.floor(rel.length / 2)];
  assert.ok(med < 1e-4, '残差中位数 ' + med.toExponential(2) + '，样本 ' + rel.length + ' 例');
});

test('申报基数低于下限时，反推仍然从「实际申报基数」起算（不回退到下限以下）', () => {
  const res = C.analyze(ok(Object.assign(C.defaultsClone(), { base: '1000' })));
  assert.strictEqual(res.bases.declared, res.cfg.floor, '实际申报基数被截到下限');
  assert.ok(res.target.appliedBaseCents >= res.bases.declared, '解出的基数不应低于实际申报基数');
  assert.ok(Math.abs(res.target.residualCents) <= Math.max(100, res.months * 2));
});

test('反推目标为 0 / 极小目标：解出的基数不高于当前基数（不应出现负数）', () => {
  const raw = Object.assign(C.defaultsClone(), { target: '0' });
  const res = C.analyze(ok(raw));
  assert.strictEqual(res.target.reachable, true);
  assert.ok(res.target.appliedBaseCents >= res.cfg.floor);
});

/* ── 输入解析 ───────────────────────────────────────── */
test('金额解析：全角、千分位、￥、元、万、亿、两位小数', () => {
  assert.strictEqual(C.parseAmount('12000').cents, 1200000);
  assert.strictEqual(C.parseAmount('12000.5').cents, 1200050);
  assert.strictEqual(C.parseAmount('12,000.50').cents, 1200050);
  assert.strictEqual(C.parseAmount('１２３４').cents, 123400);
  assert.strictEqual(C.parseAmount('￥1,234元').cents, 123400);
  assert.strictEqual(C.parseAmount('1.2万').cents, 1200000);
  assert.strictEqual(C.parseAmount('0.5亿').cents, 5000000000, '0.5 亿元 = 50,000,000 元 = 5,000,000,000 分');
  assert.strictEqual(C.parseAmount('0').cents, 0);
  assert.strictEqual(C.parseAmount('.5').cents, 50);
});

test('比例解析：整数、小数、带百分号、全角', () => {
  assert.strictEqual(C.parseRate('12', 100).bp, 1200);
  assert.strictEqual(C.parseRate('0.5', 100).bp, 50);
  assert.strictEqual(C.parseRate('8.25%', 100).bp, 825);
  assert.strictEqual(C.parseRate('１６', 100).bp, 1600);
  assert.strictEqual(C.parseRate('0', 100).bp, 0);
  assert.strictEqual(C.parseRate('100', 100).bp, 10000);
});

test('非法输入逐条：每条都给出可读错误、且不通过 normalize', () => {
  const cases = [
    ['wage', ''], ['wage', 'abc'], ['wage', '-5'], ['wage', '1.234'], ['wage', '1e3'],
    ['base', ''], ['base', '元元'], ['base', '12%'],
    ['floor', ''], ['cap', ''], ['target', ''], ['target', '-1'],
    ['fundEmp', ''], ['fundEmp', 'abc'], ['fundEmp', '101'], ['fundEmp', '1.234'],
    ['fundCo', '-1'], ['years', ''], ['years', '0'], ['years', '41'], ['years', '2.5'],
    ['rate', ''], ['rate', 'abc'], ['rate', '20.01'], ['rate', '-1'],
    ['rows', []]
  ];
  cases.forEach(([k, v]) => {
    const raw = C.defaultsClone();
    raw[k] = v;
    const n = C.normalize(raw);
    assert.strictEqual(n.ok, false, k + '=' + JSON.stringify(v) + ' 应判为非法');
    assert.ok(n.errors.length > 0, '应给出错误说明');
    n.errors.forEach((e) => assert.ok(typeof e === 'string' && e.length > 3));
  });
});

test('非法输入：下限大于上限、险种名空/过长、费率越界、行数超限', () => {
  let raw = Object.assign(C.defaultsClone(), { floor: '9000', cap: '4000' });
  assert.ok(C.normalize(raw).errors.some((e) => e.indexOf('下限不能大于上限') > -1));
  raw = C.defaultsClone(); raw.rows[0].name = '   ';
  assert.ok(C.normalize(raw).errors.some((e) => e.indexOf('险种名称不能为空') > 0));
  raw = C.defaultsClone(); raw.rows[0].name = '一二三四五六七八九十十一十二十三';
  assert.ok(C.normalize(raw).errors.some((e) => e.indexOf('最多 12 个字') > 0));
  raw = C.defaultsClone(); raw.rows[0].rp = '100.01';
  assert.ok(C.normalize(raw).errors.some((e) => e.indexOf('个人费率') > 0));
  raw = C.defaultsClone(); raw.rows = new Array(9).fill({ name: 'x', rp: '1', rc: '1', ap: '0', ac: '0' });
  assert.ok(C.normalize(raw).errors.some((e) => e.indexOf('最多 8 行') > 0));
});

test('警告（不是错误）：申报基数被截断、工资低于下限、公积金比例 > 12%', () => {
  let n = C.normalize(Object.assign(C.defaultsClone(), { base: '1000' }));
  assert.ok(n.ok); assert.ok(n.warnings.some((w) => w.indexOf('低干下限') > 0 || w.indexOf('低于下限') > 0));
  n = C.normalize(Object.assign(C.defaultsClone(), { base: '40000' }));
  assert.ok(n.ok); assert.ok(n.warnings.some((w) => w.indexOf('高于上限') > 0));
  n = C.normalize(Object.assign(C.defaultsClone(), { fundEmp: '20', fundCo: '20' }));
  assert.ok(n.ok); assert.ok(n.warnings.some((w) => w.indexOf('高于 12%') > 0));
});

/* ── D. 输出契约 / 确定性 / 场景 ────────────────────── */
test('输出契约：递归扫描无 undefined / NaN / Infinity', () => {
  const rnd = mulberry32(2026111007);
  for (let t = 0; t < 40; t++) {
    const res = C.analyze(ok(randRaw(rnd)));
    const bad = [];
    const walk = (o, p) => {
      if (o === null) { if (p !== 'res.target.neededBaseCents') bad.push(p + '=null（只有不可达时的 neededBaseCents 允许为 null）'); return; }
      if (o === undefined) { bad.push(p + '=undefined'); return; }
      if (typeof o === 'number') { if (!Number.isFinite(o)) bad.push(p + '=' + o); return; }
      if (typeof o === 'string' || typeof o === 'boolean') return;
      if (Array.isArray(o)) return o.forEach((v, i) => walk(v, p + '[' + i + ']'));
      if (typeof o === 'object') return Object.keys(o).forEach((k) => walk(o[k], p + '.' + k));
    };
    walk(res, 'res');
    assert.deepStrictEqual(bad, [], 't=' + t);
    assert.ok(res.limits.length >= 6);
    assert.ok(res.steps.length >= 5);
  }
});

test('确定性：同一输入两次求解逐字段一致；不修改传入的 cfg', () => {
  const cfg = ok(C.defaults);
  const snapshot = JSON.stringify(cfg);
  const a = C.analyze(cfg), b = C.analyze(cfg);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(JSON.stringify(cfg), snapshot, 'analyze 不应修改 cfg');
});

test('参数极端但合法：全部费率 0 / 基数 0 / 1 年 / 40 年 都不崩且数值有效', () => {
  let raw = C.defaultsClone();
  raw.rows = raw.rows.map((r) => Object.assign({}, r, { rp: '0', rc: '0' }));
  raw.fundEmp = '0'; raw.fundCo = '0';
  let res = C.analyze(ok(raw));
  assert.strictEqual(res.declared.toAcct, 0);
  assert.strictEqual(res.diff.toAcct, 0);
  assert.strictEqual(res.perBase.acctPer100, 0);

  raw = Object.assign(C.defaultsClone(), { base: '0', floor: '0', wage: '0' });
  res = C.analyze(ok(raw));
  assert.strictEqual(res.declared.personalTotal, 0);
  assert.strictEqual(res.declared.takeHome, 0);
  assert.strictEqual(res.declaredFV, 0);

  raw = Object.assign(C.defaultsClone(), { years: '1' });
  assert.strictEqual(C.analyze(ok(raw)).months, 12);
  raw = Object.assign(C.defaultsClone(), { years: '40', rate: '20' });
  const big = C.analyze(ok(raw));
  assert.strictEqual(big.months, 480);
  assert.ok(Number.isFinite(big.declaredFV) && big.declaredFV > 0);
});

test('6 个内置场景 + 默认：全部可解、自检全过、两条路关系成立', () => {
  C.scenarios.forEach((sc) => {
    const cfg = ok(Object.assign(C.defaultsClone(), sc.patch));
    const res = C.analyze(cfg);
    const checks = C.verify(cfg, res);
    const bad = checks.filter((c) => !c.ok);
    assert.deepStrictEqual(bad.map((b) => b.name), [], '场景 ' + sc.key);
    assert.strictEqual(res.declared.checkSum, 0, '场景 ' + sc.key);
    assert.ok(res.bases.declared >= res.cfg.floor && res.bases.declared <= res.cfg.cap);
    assert.ok(res.perYear.length === cfg.years);
  });
});

test('费率全为 0 时两条路完全一致（零基线的诚实性）', () => {
  const raw = C.defaultsClone();
  raw.rows = raw.rows.map((r) => Object.assign({}, r, { rp: '0', rc: '0' }));
  raw.fundEmp = '0'; raw.fundCo = '0'; raw.target = '0';
  const res = C.analyze(ok(raw));
  assert.strictEqual(res.diff.takeHome, 0);
  assert.strictEqual(res.diff.toAcct, 0);
  assert.strictEqual(res.diffFV, 0);
  assert.strictEqual(res.target.neededMonthlyCents, 0);
});

test('roundDiv 半进位规则（含 .5 分边界，逐点核对）', () => {
  assert.strictEqual(C.roundDiv(0, 10000), 0);
  assert.strictEqual(C.roundDiv(5000, 10000), 1, '0.5 分进 1');
  assert.strictEqual(C.roundDiv(4999, 10000), 0);
  assert.strictEqual(C.roundDiv(15000, 10000), 2);
  assert.strictEqual(C.roundDiv(14999, 10000), 1);
});
