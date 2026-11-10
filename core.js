/* 缴费基数对账台（contribution-base）· 核心计算层
 * 纯函数、无 DOM、无网络、不读时钟。
 * 口径：金额一律用整数「分」；费率/比例一律用「基点 bp」（1% = 100 bp，即万分位）。
 * 全部金额与费率都用整数运算（parse 阶段逐字符转整数），不用 parseFloat，
 * 以便与测试里的 BigInt 精确实现逐分对拍。
 * window.AppCore（浏览器）/ module.exports（Node 测试）
 */
'use strict';
(function (root) {
  const MAX_ROWS = 8;
  const MAX_YEARS = 40;
  const MAX_RATE_PCT = 20;      // 年化记账利率上限（%）
  const MAX_AMOUNT_CENTS = 1e12; // 单笔金额上限 100 亿元

  /* ── 默认输入：全部为虚构示例，不是任何地区/年份的真实政策数值 ── */
  const defaults = {
    wage: '12000',   // 月工资（应发）元
    base: '4000',    // 公司申报的缴费基数 元
    floor: '4000',   // 缴费基数下限 元
    cap: '35000',    // 缴费基数上限 元
    fundEmp: '12',   // 公积金 个人比例 %
    fundCo: '12',    // 公积金 公司比例 %
    years: '20',     // 累积年限
    rate: '0',       // 个人账户年化记账利率 %
    target: '300000',// 反推目标：N 年后个人账户想多出多少元
    rows: [
      { name: '养老保险', rp: '8', rc: '16', ap: '100', ac: '0' },
      { name: '医疗保险', rp: '2', rc: '8', ap: '100', ac: '0' },
      { name: '失业保险', rp: '0.5', rc: '0.5', ap: '0', ac: '0' },
      { name: '工伤保险', rp: '0', rc: '0.2', ap: '0', ac: '0' },
      { name: '生育保险', rp: '0', rc: '0.8', ap: '0', ac: '0' }
    ]
  };

  /* ── 内置场景（全部虚构示例） ── */
  const scenarios = [
    { key: 'default', label: '默认：月薪 1.2 万 / 按 4000 缴 / 20 年', patch: {} },
    { key: 'full', label: '足额缴对照：基数 = 月薪 12000', patch: { base: '12000' } },
    { key: 'capped', label: '顶格：月薪 6 万 / 申报 45000（被上限 35000 截断）', patch: { wage: '60000', base: '45000', cap: '35000', floor: '4000', target: '300000' } },
    { key: 'fund5', label: '公积金按 5% 缴（下限比例）', patch: { fundEmp: '5', fundCo: '5' } },
    { key: 'growth', label: '20 年 + 年化 3% 记账利率', patch: { rate: '3' } },
    { key: 'long', label: '35 年长跑：月薪 2 万 / 按 6000 缴', patch: { wage: '20000', base: '6000', years: '35', target: '300000' } },
    { key: 'lowwage', label: '月薪 3500（低于下限 4000）', patch: { wage: '3500', base: '4000', target: '300000' } }
  ];

  /* ── 整数工具 ───────────────────────────────────────── */

  // 四舍五入到整数（half-up，全部为非负整数输入）
  function roundDiv(n, d) {
    const q = Math.floor(n / d);
    const rem = n - q * d;
    return rem * 2 >= d ? q + 1 : q;
  }

  const FULL2HALF = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '．': '.', '，': ',', '　': ' ' };

  function toHalf(s) {
    return String(s == null ? '' : s).replace(/[０-９．，　]/g, (c) => FULL2HALF[c]);
  }

  // 金额 → 整数分。支持 ￥/¥/元、千分位逗号、全角数字、万/亿 后缀；最多两位小数。
  function parseAmount(input) {
    let s = toHalf(input).trim();
    if (!s) return { ok: false, err: '金额不能为空' };
    s = s.replace(/[￥¥\s元]/g, '').replace(/,/g, '');
    let mult = 1n;
    if (/[万萬]$/.test(s)) { mult = 10000n; s = s.slice(0, -1); }
    else if (/亿$/.test(s)) { mult = 100000000n; s = s.slice(0, -1); }
    if (s === '') return { ok: false, err: '金额格式无法识别' };
    if (!/^\d*(\.\d*)?$/.test(s)) return { ok: false, err: '金额只能是数字（可带两位小数）' };
    const parts = s.split('.');
    const intPart = parts[0] === '' ? '0' : parts[0];
    const decPart = parts[1] === undefined ? '' : parts[1];
    if (decPart.length > 2) return { ok: false, err: '金额最多两位小数' };
    const centsStr = intPart + (decPart + '00').slice(0, 2);
    let cents = BigInt(centsStr) * mult;
    if (cents > BigInt(MAX_AMOUNT_CENTS)) return { ok: false, err: '金额超出本页上限（100 亿元）' };
    return { ok: true, cents: Number(cents) };
  }

  // 比例（%）→ 基点。0–maxPct，最多两位小数。
  function parseRate(input, maxPct) {
    let s = toHalf(input).trim().replace(/[%％\s]/g, '');
    if (!s) return { ok: false, err: '比例不能为空' };
    if (!/^\d*(\.\d*)?$/.test(s)) return { ok: false, err: '比例只能是数字（可带两位小数）' };
    const parts = s.split('.');
    const intPart = parts[0] === '' ? '0' : parts[0];
    const decPart = parts[1] === undefined ? '' : parts[1];
    if (decPart.length > 2) return { ok: false, err: '比例最多两位小数' };
    const bp = Number(intPart + (decPart + '00').slice(0, 2));
    const max = (maxPct === undefined ? 100 : maxPct) * 100;
    if (bp > max) return { ok: false, err: '比例不能超过 ' + (max / 100) + '%' };
    return { ok: true, bp };
  }

  function parseIntStrict(input, min, max, label) {
    const s = toHalf(input).trim().replace(/,/g, '');
    if (!/^\d+$/.test(s)) return { ok: false, err: label + '只能是整数' };
    const v = Number(s);
    if (v < min || v > max) return { ok: false, err: label + '应在 ' + min + '–' + max + ' 之间' };
    return { ok: true, v };
  }

  /* ── 输入归一化 ─────────────────────────────────────── */
  function normalize(input) {
    const raw = Object.assign({}, defaults, input || {});
    const errors = [];
    const warnings = [];
    const cfg = { rows: [] };
    const put = (key, res, label) => { if (!res.ok) errors.push(label + '：' + res.err); else cfg[key] = res.cents; return res.ok; };

    put('wage', parseAmount(raw.wage), '月工资');
    put('base', parseAmount(raw.base), '申报基数');
    put('floor', parseAmount(raw.floor), '基数下限');
    put('cap', parseAmount(raw.cap), '基数上限');
    put('target', parseAmount(raw.target), '反推目标');

    const fr = parseRate(raw.fundEmp, 100); if (!fr.ok) errors.push('公积金个人比例：' + fr.err); else cfg.fundEmpBp = fr.bp;
    const fc = parseRate(raw.fundCo, 100); if (!fc.ok) errors.push('公积金公司比例：' + fc.err); else cfg.fundCoBp = fc.bp;
    const yr = parseIntStrict(raw.years, 1, MAX_YEARS, '累积年限'); if (!yr.ok) errors.push(yr.err); else cfg.years = yr.v;
    const rt = parseRate(raw.rate, MAX_RATE_PCT); if (!rt.ok) errors.push('记账利率：' + rt.err); else cfg.rateBp = rt.bp;

    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    if (!rows.length) errors.push('至少要有一个险种行');
    if (rows.length > MAX_ROWS) errors.push('险种行最多 ' + MAX_ROWS + ' 行');
    rows.slice(0, MAX_ROWS).forEach((r, i) => {
      const no = '第 ' + (i + 1) + ' 行';
      const name = String(r && r.name == null ? '' : r.name).trim();
      if (!name) errors.push(no + '：险种名称不能为空');
      if (name.length > 12) errors.push(no + '：险种名称最多 12 个字');
      const out = { name };
      let ok = true;
      [['rp', '个人费率', 100], ['rc', '公司费率', 100], ['ap', '个人缴费计入个人账户比例', 100], ['ac', '公司缴费计入个人账户比例', 100]].forEach(([k, label, max]) => {
        const p = parseRate(r && r[k], max);
        if (!p.ok) { errors.push(no + '「' + name + '」' + label + '：' + p.err); ok = false; } else out[k + 'Bp'] = p.bp;
      });
      if (ok) cfg.rows.push(out);
    });

    if (cfg.floor !== undefined && cfg.cap !== undefined && cfg.floor > cfg.cap) {
      errors.push('基数下限不能大于上限（当前下限 ' + yuan(cfg.floor) + ' 元 > 上限 ' + yuan(cfg.cap) + ' 元）');
    }
    if (cfg.base !== undefined && cfg.floor !== undefined && cfg.base < cfg.floor) {
      warnings.push('申报基数低于下限，计算时已按下限 ' + yuan(cfg.floor) + ' 元 截断。');
    }
    if (cfg.base !== undefined && cfg.cap !== undefined && cfg.base > cfg.cap) {
      warnings.push('申报基数高于上限，计算时已按上限 ' + yuan(cfg.cap) + ' 元 截断。');
    }
    if (cfg.wage !== undefined && cfg.floor !== undefined && cfg.wage < cfg.floor) {
      warnings.push('月工资低于缴费基数下限：足额路会按下限 ' + yuan(cfg.floor) + ' 元 作为基数，此时「扣缴额」可能高于工资本身。');
    }
    if (cfg.fundEmpBp !== undefined && (cfg.fundEmpBp > 1200 || cfg.fundCoBp > 1200)) {
      warnings.push('公积金比例高于 12%（常见上限），本页照你填的比例计算，不做合规判断。');
    }

    return { ok: errors.length === 0, cfg, errors, warnings };
  }

  const yuan = (cents) => (cents / 100).toFixed(2);

  /* ── 单条路的逐项计算 ───────────────────────────────── */
  function path(cfg, baseCents) {
    const rows = cfg.rows.map((r) => {
      const personal = roundDiv(baseCents * r.rpBp, 10000);
      const company = roundDiv(baseCents * r.rcBp, 10000);
      const pIn = roundDiv(personal * r.apBp, 10000);
      const cIn = roundDiv(company * r.acBp, 10000);
      const toAcct = pIn + cIn;
      return {
        name: r.name, rpBp: r.rpBp, rcBp: r.rcBp, apBp: r.apBp, acBp: r.acBp,
        personal, company, personalToAcct: pIn, companyToAcct: cIn,
        toAcct, toPool: (personal - pIn) + (company - cIn)
      };
    });
    const fundEmp = roundDiv(baseCents * cfg.fundEmpBp, 10000);
    const fundCo = roundDiv(baseCents * cfg.fundCoBp, 10000);
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    const personalIns = sum((r) => r.personal);
    const companyIns = sum((r) => r.company);
    const acctIns = sum((r) => r.toAcct);
    const poolIns = sum((r) => r.toPool);
    const personalTotal = personalIns + fundEmp;
    const companyTotal = companyIns + fundCo;
    const toAcct = acctIns + fundEmp + fundCo;
    const toPool = poolIns;
    return {
      baseCents, rows, fundEmp, fundCo,
      personalIns, companyIns, acctIns, poolIns,
      personalTotal, companyTotal, toAcct, toPool,
      takeHome: cfg.wage - personalTotal,
      companyCashCost: cfg.wage + companyTotal,
      checkSum: personalTotal + companyTotal - (toAcct + toPool)   // 恒等于 0
    };
  }

  /* ── 长期累积 ───────────────────────────────────────── */
  function growthFactor(months, ratePct) {
    const i = ratePct / 100 / 12;
    if (i === 0) return months;
    return (Math.pow(1 + i, months) - 1) / i;
  }

  function futureValue(monthlyCents, months, ratePct) {
    const i = ratePct / 100 / 12;
    if (i === 0) return monthlyCents * months;
    let bal = 0;
    for (let m = 0; m < months; m++) bal = bal * (1 + i) + monthlyCents;
    return bal;
  }

  function schedule(monthlyCents, months, ratePct) {
    const i = ratePct / 100 / 12;
    let bal = 0, paid = 0;
    const out = [];
    for (let m = 1; m <= months; m++) {
      bal = bal * (1 + i) + monthlyCents;
      paid += monthlyCents;
      if (m % 12 === 0) out.push({ year: m / 12, balance: bal, paid });
    }
    return out;
  }

  /* ── 边际账：每多 100 元基数 ────────────────────────── */
  function perBase(cfg) {
    // 解析口径的「每 1 元基数」边际率（以 1e-8 为单位的整数，避免浮点误差）
    let takeE8 = cfg.fundEmpBp * 10000;      // 个人缴 = 基数 × bp/1e4
    let coE8 = cfg.fundCoBp * 10000;
    let acctE8 = (cfg.fundEmpBp + cfg.fundCoBp) * 10000;
    cfg.rows.forEach((r) => {
      takeE8 += r.rpBp * 10000;
      coE8 += r.rcBp * 10000;
      acctE8 += roundDiv(r.rpBp * r.apBp, 10000) * 10000;
      acctE8 += roundDiv(r.rcBp * r.acBp, 10000) * 10000;
    });
    const per100 = (e8) => (e8 / 1e8) * 100;  // 每 100 元基数的元数
    return {
      takePer100: per100(takeE8),
      acctPer100: per100(acctE8),
      companyPer100: per100(coE8),
      netPer100: per100(acctE8 - takeE8),
      acctFrac: acctE8 / 1e8,      // 每 1 元基数进个人账户的元数
      takeFrac: takeE8 / 1e8
    };
  }

  /* ── 主计算 ─────────────────────────────────────────── */
  function analyze(cfg) {
    const declaredBase = Math.min(Math.max(cfg.base, cfg.floor), cfg.cap);
    const fullBase = Math.min(Math.max(cfg.wage, cfg.floor), cfg.cap);
    const declared = path(cfg, declaredBase);
    const full = path(cfg, fullBase);
    const ratePct = cfg.rateBp / 100;
    const months = cfg.years * 12;

    const diff = {
      base: fullBase - declaredBase,
      takeHome: full.takeHome - declared.takeHome,
      toAcct: full.toAcct - declared.toAcct,
      toPool: full.toPool - declared.toPool,
      companyTotal: full.companyTotal - declared.companyTotal,
      companyCashCost: full.companyCashCost - declared.companyCashCost
    };

    const pb = perBase(cfg);

    // 长期累积（申报路 / 足额路）
    const declaredFV = futureValue(declared.toAcct, months, ratePct);
    const fullFV = futureValue(full.toAcct, months, ratePct);
    const schedDeclared = schedule(declared.toAcct, months, ratePct);
    const schedFull = schedule(full.toAcct, months, ratePct);
    const perYear = schedDeclared.map((row, i) => ({
      year: row.year,
      declaredBalance: row.balance, fullBalance: schedFull[i].balance,
      declaredPaid: row.paid, fullPaid: schedFull[i].paid
    }));

    // 反推：让个人账户在 N 年后多出 target，需要把基数提到多少
    const needMonthly = months > 0 ? cfg.target / growthFactor(months, ratePct) : 0;
    const needBaseDelta = pb.acctFrac > 0 ? needMonthly / pb.acctFrac : Infinity;
    // 锚点必须是「截断后的实际申报基数」：申报基数低于下限时，实际缴的是下限，
    // 从 cfg.base 起算会把解算到下限以下，反推就退化成「一步都不动」。
    const wantedBase = declaredBase + needBaseDelta;
    const reachable = Number.isFinite(wantedBase) && wantedBase <= cfg.cap + 1e-9;
    // 反推三步：解析解 → 牛顿迭代（用实测局部斜率，不用假设的边际率） → ±64 分整数微调。
    // 这样做是因为账面每一笔都四舍五入到分，「基数 → 账户月增」是一个阶梯函数，
    // 纯解析解在大基数区间会偏出百分之零点几，放大到几十年就是几百元。
    const gf = growthFactor(months, ratePct);
    const evalBase = (b) => {
      const bb = Math.min(Math.max(b, cfg.floor), cfg.cap);
      const p = path(cfg, bb);
      const fv = futureValue(p.toAcct, months, ratePct);
      return { b: bb, fv, acct: p.toAcct, residual: fv - declaredFV - cfg.target };
    };
    let b1 = reachable ? wantedBase : cfg.cap;
    if (reachable) {
      for (let it = 0; it < 8; it++) {
        const cur = evalBase(Math.round(b1));
        if (Math.abs(cur.residual) <= Math.max(1, gf)) break;
        const probe = evalBase(Math.round(b1) + 1000);
        const slope = (probe.acct - cur.acct) * gf / 1000;
        if (!(slope > 0)) break;
        const step = -cur.residual / slope;
        if (!Number.isFinite(step) || Math.abs(step) < 0.5) break;
        b1 = Math.min(b1 + step, cfg.cap);
      }
    }
    let best = evalBase(Math.round(b1));
    if (reachable) {
      const loLimit = cfg.target > 0 ? declaredBase : cfg.floor;
      const lo = Math.max(loLimit, Math.round(b1) - 64);
      const hi = Math.min(cfg.cap, Math.round(b1) + 64);
      for (let b = lo; b <= hi; b++) {
        const c = evalBase(b);
        if (Math.abs(c.residual) < Math.abs(best.residual) - 1e-9) best = c;
      }
    }
    const residual = best.residual;

    const target = {
      targetCents: cfg.target, months, ratePct,
      neededMonthlyCents: needMonthly,
      neededBaseCents: reachable ? Math.round(wantedBase) : null,
      appliedBaseCents: best.b,
      refinedCents: reachable ? best.b - Math.round(wantedBase) : 0,
      reachable,
      cappedAt: cfg.cap,
      afterAcctPerMonth: best.acct,
      afterFV: best.fv, residualCents: residual,
      fullBaseFV: fullFV,
      fullBaseCovers: fullFV - declaredFV >= cfg.target
    };

    // 敏感性：每行都完整重算
    const sens = [];
    const mk = (label, patch) => {
      const c2 = Object.assign({}, cfg, patch);
      const d2 = Math.min(Math.max(c2.base, c2.floor), c2.cap);
      const f2 = Math.min(Math.max(c2.wage, c2.floor), c2.cap);
      const p2 = path(c2, d2), q2 = path(c2, f2);
      const m2 = c2.years * 12, r2 = c2.rateBp / 100;
      sens.push({
        label,
        baseCents: d2,
        takeHomeDiff: q2.takeHome - p2.takeHome,
        acctDiffMonthly: q2.toAcct - p2.toAcct,
        acctDiffFV: futureValue(q2.toAcct, m2, r2) - futureValue(p2.toAcct, m2, r2),
        companyDiff: q2.companyTotal - p2.companyTotal
      });
    };
    mk('申报基数 = 月工资的一半', { base: Math.round(cfg.wage / 2) });
    mk('申报基数 +50%', { base: Math.round(cfg.base * 1.5) });
    mk('申报基数 = 月工资（足额）', { base: cfg.wage });
    mk('公积金比例 12% → 5%', { fundEmpBp: 500, fundCoBp: 500 });
    mk('年限 +5 年', { years: Math.min(cfg.years + 5, MAX_YEARS) });
    mk('记账利率 → 3%', { rateBp: 300 });

    const steps = [
      '① 两条路的缴费基数：申报 ' + yuan(cfg.base) + ' → 截成 ' + yuan(declaredBase) + ' 元（下限 ' + yuan(cfg.floor) + ' / 上限 ' + yuan(cfg.cap) + '）；足额 ' + yuan(cfg.wage) + ' → 截成 ' + yuan(fullBase) + ' 元。',
      '② 逐险种按「基数 × 费率」算出个人缴与公司缴（每项四舍五入到分）。',
      '③ 把每一笔缴费按「计入个人账户比例」拆成两份：进你个人账户的、进统筹的；公积金双边全额进个人账户。',
      '④ 本月到手 = 月工资 − 个人缴费合计；个人账户月增 = 各险种计入 + 公积金双边。',
      '⑤ 长期累积 = 每月账户增额按年化 ' + ratePct + '% 按月复利累积 ' + months + ' 个月。',
      '⑥ 反推：需要的月账户增量 ÷ 每元基数带来的账户增量 = 需要的基数。'
    ];

    const limits = [
      '不判断「按低基数缴」是否合规，也不给举报、仲裁或谈判建议；本页只做同一套规则下的算术对照。',
      '不内置任何地区、任何年份的真实费率与基数上下限。默认值是虚构示例，请按你自己的口径逐项改。',
      '不计算个人所得税：这里的「到手」指扣掉社保与公积金个人缴费之后的金额，未扣个税。',
      '不算「退休后每月能领多少养老金」：统筹账户的待遇取决于当地计发规则与社会平均工资，本页只算「钱进不进你的个人账户」。',
      '医保个人账户的计入规则各地不同，本页用你填的「计入比例」，不替你判断。',
      '不处理断缴、补缴、滞纳金、历年基数调整、年终奖与股权、多地重复参保、上下限随年份变动。',
      '记账利率是你自己填的假设，不是任何机构的真实利率；含利率时用按月复利浮点累加，只有利率为 0 时全程是精确整数分。',
      '「多缴基数对你净增益」是这份规则下的算术结论，不等于建议你去做任何事（公积金能否提取、什么时候提取，取决于你所在地的规则）。'
    ];

    return {
      bases: { declared: declaredBase, full: fullBase, declaredClamped: declaredBase !== cfg.base, fullClamped: fullBase !== cfg.wage },
      cfg, declared, full, diff, perBase: pb, months, ratePct,
      declaredFV, fullFV, diffFV: fullFV - declaredFV,
      perYear, target, sensitivity: sens, steps, limits
    };
  }

  /* ── 结构自检（每次重算都跑） ───────────────────────── */
  function verify(cfg, res) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    const fin = (x) => typeof x === 'number' && Number.isFinite(x);
    const scan = (o, path, bad) => {
      if (o === null) { if (path !== 'res.target.neededBaseCents') bad.push(path + ' = null'); return; }
      if (o === undefined) { bad.push(path + ' = undefined'); return; }
      if (typeof o === 'number') { if (!Number.isFinite(o)) bad.push(path + ' = ' + o); return; }
      if (typeof o === 'string' || typeof o === 'boolean') return;
      if (Array.isArray(o)) { o.forEach((v, i) => scan(v, path + '[' + i + ']', bad)); return; }
      if (typeof o === 'object') { Object.keys(o).forEach((k) => scan(o[k], path + '.' + k, bad)); }
    };
    const bad = [];
    scan({ declared: res.declared, full: res.full, diff: res.diff, target: res.target, sensitivity: res.sensitivity }, 'res', bad);
    add('结果对象无 undefined / NaN / Infinity', bad.length === 0, bad.slice(0, 4).join('；'));

    const cons = res.declared.checkSum === 0 && res.full.checkSum === 0;
    add('归属守恒：个人缴 + 公司缴 = 进个人账户 + 进统筹', cons,
      '申报路 ' + yuan(res.declared.personalTotal + res.declared.companyTotal) + ' = ' + yuan(res.declared.toAcct + res.declared.toPool) + ' 元');

    const mono = res.diff.base >= 0
      ? (res.diff.toAcct >= 0 && res.diff.takeHome <= 0 && res.diff.companyTotal >= 0)
      : (res.diff.toAcct <= 0 && res.diff.takeHome >= 0 && res.diff.companyTotal <= 0);
    add('单调性：基数越高 → 到手越少、账户越多、公司越贵', mono);

    const round1 = res.declared.rows.every((r) => Math.abs(r.toAcct + r.toPool - (r.personal + r.company)) === 0);
    add('逐险种分账无零头丢失', round1);

    const perOk = fin(res.perBase.acctPer100) && fin(res.perBase.takePer100) && fin(res.perBase.companyPer100) && fin(res.perBase.netPer100);
    add('边际账已解析算出（每 100 元基数的到手 / 账户 / 公司成本）', perOk, '到手 −' + res.perBase.takePer100.toFixed(2) + ' 元 / 账户 +' + res.perBase.acctPer100.toFixed(2) + ' 元');

    const exact = res.ratePct === 0 ? Math.abs(res.declaredFV - res.declared.toAcct * res.months) === 0 : true;
    add('利率为 0 时累积 = 月增 × 月数（精确整数）', exact,
      res.ratePct === 0 ? yuan(res.declaredFV) + ' = ' + yuan(res.declared.toAcct) + ' × ' + res.months : '含利率，跳过该精确断言');

    const reTol = Math.max(100, Math.ceil(cfg.target * 0.002), res.months * 2);
    const reOk = !res.target.reachable || Math.abs(res.target.residualCents) <= reTol;
    add('反推解回代残差在容差内（max(1 元, 目标 0.2%, 月数 × 2 分)）', reOk,
      '残差 ' + (res.target.residualCents / 100).toFixed(2) + ' 元 / 容差 ' + (reTol / 100).toFixed(2) + ' 元');

    const monotoneSens = res.sensitivity.every((s) => fin(s.acctDiffFV) && fin(s.takeHomeDiff));
    add('敏感性每一行都完整重算且数值有限', monotoneSens, res.sensitivity.length + ' 行');
    return checks;
  }

  const api = { defaults, scenarios, normalize, analyze, verify, path, perBase, parseAmount, parseRate, parseIntStrict, futureValue, schedule, growthFactor, roundDiv, MAX_ROWS, MAX_YEARS, defaultsClone };
  function defaultsClone() { return JSON.parse(JSON.stringify(defaults)); }
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
