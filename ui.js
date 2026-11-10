/* 缴费基数对账台（contribution-base）· 界面层
 * 表单 → AppCore.normalize / analyze / verify → 渲染结论、五笔钱、两条路、边际账、
 * 长期累积、反推、敏感性、步骤、自检、边界；四种导出（CSV/MD/JSON/PNG）+ 本机保存。
 * 不联网、不上传、不打印调试日志（控制台保持干净）。
 */
'use strict';
(function () {
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'contribution-base-v1';
  const state = { input: C.defaultsClone(), lastInput: null, prevInput: null, inputKey: null, res: null, cfg: null, checks: [], exportCount: 0 };

  /* ── 工具 ─────────────────────────────────────────── */
  const fmt = (cents) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sgn = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + fmt(Math.abs(cents));
  const pct1 = (x) => (Math.round(x * 100) / 100).toFixed(2) + '%';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), 1900);
  }

  /* ── 表单读写 ─────────────────────────────────────── */
  function readInput() {
    const rows = [...document.querySelectorAll('#rows .rowline')].map((el) => ({
      name: el.querySelector('input[data-k=name]').value,
      rp: el.querySelector('input[data-k=rp]').value,
      rc: el.querySelector('input[data-k=rc]').value,
      ap: el.querySelector('input[data-k=ap]').value,
      ac: el.querySelector('input[data-k=ac]').value
    }));
    return {
      wage: $('wage').value, base: $('base').value, floor: $('floor').value, cap: $('cap').value,
      fundEmp: $('fundEmp').value, fundCo: $('fundCo').value,
      years: $('years').value, rate: $('rate').value, target: $('target').value, rows
    };
  }

  function writeInput(inp) {
    $('wage').value = inp.wage; $('base').value = inp.base;
    $('floor').value = inp.floor; $('cap').value = inp.cap;
    $('fundEmp').value = inp.fundEmp; $('fundCo').value = inp.fundCo;
    $('years').value = inp.years; $('rate').value = inp.rate; $('target').value = inp.target;
    renderRows(inp.rows || []);
  }

  function renderRows(rows) {
    const host = $('rows');
    host.innerHTML = '';
    rows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'rowline';
      const cells = [['rp', '个人%'], ['rc', '公司%'], ['ap', '个人计入%'], ['ac', '公司计入%']];
      el.innerHTML = '<label class="cell name"><span class="lb">险种名称</span><input type="text" data-k="name" aria-label="险种名称" value="' + esc(r.name || '') + '"></label>' +
        cells.map((c) => '<label class="cell"><span class="lb">' + c[1] + '</span><input type="text" inputmode="decimal" data-k="' + c[0] + '" aria-label="' + c[1] + '" value="' + esc(r[c[0]] == null ? '' : r[c[0]]) + '"></label>').join('') +
        '<button type="button" class="tiny" data-del="' + i + '" title="删除这一行">删</button>';
      host.appendChild(el);
    });
    $('rowNote').textContent = rows.length + ' / ' + C.MAX_ROWS + ' 行';
  }

  /* ── 计算与渲染 ───────────────────────────────────── */
  function compute() {
    const now = readInput();
    const n = C.normalize(now);
    const errBox = $('errors');
    markBad(n);
    if (!n.ok) {
      errBox.innerHTML = '<div class="errbox"><b>这些输入还不能算：</b><ul>' + n.errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
      return null;
    }
    errBox.innerHTML = n.warnings.length
      ? '<div class="warnbox"><b>注意：</b><ul>' + n.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>'
      : '';
    const res = C.analyze(n.cfg);
    const key = JSON.stringify(now);
    if (state.inputKey !== null && state.inputKey !== key && state.lastInput) state.prevInput = state.lastInput;
    state.lastInput = now; state.inputKey = key;
    state.res = res; state.cfg = n.cfg;
    state.checks = C.verify(n.cfg, res);
    render(res);
    return res;
  }

  function markBad(n) {
    ['wage', 'base', 'floor', 'cap', 'fundEmp', 'fundCo', 'years', 'rate', 'target'].forEach((id) => $(id).classList.remove('bad'));
    if (n.ok || !n.errors) return;
    const map = { '月工资': 'wage', '申报基数': 'base', '基数下限': 'floor', '基数上限': 'cap', '公积金个人比例': 'fundEmp', '公积金公司比例': 'fundCo', '累积年限': 'years', '记账利率': 'rate', '反推目标': 'target' };
    n.errors.forEach((e) => {
      Object.keys(map).forEach((k) => { if (e.indexOf(k) === 0) $(map[k]).classList.add('bad'); });
    });
  }

  function render(res) {
    renderHeadline(res); renderSplit(res); renderPaths(res); renderPer(res);
    renderLong(res); renderTarget(res); renderSens(res); renderSteps(res);
    renderChecks(); renderLimits(res);
  }

  function kpiHTML(items) {
    return items.map((x) => {
      const s = String(x.v);
      const px = s.length >= 22 ? 14 : (s.length >= 16 ? 17 : 20);
      return '<div class="kpi"><div class="k">' + x.k + '</div><div class="v" style="font-size:' + px + 'px">' + x.v + '</div><div class="s">' + x.s + '</div></div>';
    }).join('');
  }

  function renderHeadline(res) {
    const d = res.diff;
    $('baseTag').textContent = '按 ' + fmt(res.bases.declared) + ' 元 缴';
    // 方向：d.* 都是「足额 − 申报」，站在「按申报基数缴」这一侧的体验要取反
    const cashGain = -d.takeHome;
    const acctLoss = -d.toAcct;
    const shortTxt = cashGain > 0 ? '每月多拿 ' + fmt(cashGain) + ' 元现金' : (cashGain < 0 ? '每月少拿 ' + fmt(-cashGain) + ' 元现金' : '到手不变');
    const acctTxt = acctLoss > 0 ? '个人账户里每月少 ' + fmt(acctLoss) + ' 元' : (acctLoss < 0 ? '个人账户里每月多 ' + fmt(-acctLoss) + ' 元' : '个人账户不受影响');
    $('headline').innerHTML = '按申报基数 <b>' + fmt(res.bases.declared) + ' 元</b> 缴，而不是按足额 <b>' + fmt(res.bases.full) + ' 元</b> 缴：' +
      '你 <b>' + shortTxt + '</b>，但 <b>' + acctTxt + '</b>；' +
      '把两条路放到 <b>' + res.months + ' 个月</b>（' + res.cfg.years + ' 年，年化 ' + res.ratePct + '%）上看，个人账户累计相差 <b>' + fmt(Math.abs(res.diffFV)) + ' 元</b>。';

    const kpis = [
      { k: '本月到手（未扣个税）', v: fmt(res.declared.takeHome) + ' 元', s: '足额缴是 ' + fmt(res.full.takeHome) + ' 元' },
      { k: '本月进你个人账户', v: fmt(res.declared.toAcct) + ' 元', s: '养老 + 医保计入 + 公积金双边' },
      { k: '本月进统筹（不归你）', v: fmt(res.declared.toPool) + ' 元', s: '足额缴是 ' + fmt(res.full.toPool) + ' 元' },
      { k: '公司本月为这笔掏', v: fmt(res.declared.companyTotal) + ' 元', s: '足额缴要多掏 ' + fmt(Math.max(0, d.companyTotal)) + ' 元' }
    ];
    $('kpis').innerHTML = kpiHTML(kpis);

    const net = d.toAcct + d.takeHome;   // 站在「足额缴」这一侧：现金少拿、账户多进
    $('insight').innerHTML = d.base === 0
      ? '两条路的基数已经一样（都是 <b>' + fmt(res.bases.declared) + ' 元</b>），所以没有任何差额。想看差额，把「公司申报的缴费基数」改小，或者换一个内置场景。'
      : '换个方向看同一个差：<b>如果你改按足额缴</b>，每月现金 <b>' + sgn(d.takeHome) + ' 元</b>、个人账户 <b>' + sgn(d.toAcct) + ' 元</b>，一个月净 <b>' + sgn(net) + ' 元</b>（' + res.months + ' 个月合计 <b>' + sgn(net * res.months) + ' 元</b>，不含利率）。' +
        '反过来，<b>每少缴 100 元基数</b>，你这个月到手多 <b>' + res.perBase.takePer100.toFixed(2) + ' 元</b>、个人账户少 <b>' + res.perBase.acctPer100.toFixed(2) + ' 元</b>——手快过账，账快过手。';

    const acts = [
      { t: '把基数补到足额（' + fmt(res.bases.full) + ' 元）', fn: () => { $('base').value = (res.bases.full / 100).toFixed(2); } },
      { t: '按反推结果设基数', fn: () => { $('base').value = (res.target.appliedBaseCents / 100).toFixed(2); }, off: !res.target.reachable },
      { t: '公积金改 12% / 12%', fn: () => { $('fundEmp').value = '12'; $('fundCo').value = '12'; } },
      { t: '还原上一版输入（可来回切）', fn: () => { if (state.prevInput) writeInput(state.prevInput); }, off: !state.prevInput }
    ];
    $('actions').innerHTML = '';
    acts.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = a.t;
      if (a.off) b.disabled = true;
      b.addEventListener('click', () => {
        a.fn(); compute();
        toast('已按建议改输入并重算');
      });
      $('actions').appendChild(b);
    });
  }

  function renderSplit(res) {
    const p = res.declared;
    let h = '<thead><tr><th>项目</th><th>个人缴（元）</th><th>公司缴（元）</th><th>进你个人账户（元）</th><th>进统筹（元）</th></tr></thead><tbody>';
    p.rows.forEach((r) => {
      h += '<tr><td>' + esc(r.name) + '</td><td>' + fmt(r.personal) + '</td><td>' + fmt(r.company) + '</td><td>' + fmt(r.toAcct) + '</td><td>' + fmt(r.toPool) + '</td></tr>';
    });
    h += '<tr><td>住房公积金</td><td>' + fmt(p.fundEmp) + '</td><td>' + fmt(p.fundCo) + '</td><td>' + fmt(p.fundEmp + p.fundCo) + '</td><td>0.00</td></tr>';
    h += '<tr class="sum"><td>合计</td><td>' + fmt(p.personalTotal) + '</td><td>' + fmt(p.companyTotal) + '</td><td>' + fmt(p.toAcct) + '</td><td>' + fmt(p.toPool) + '</td></tr>';
    h += '<tr class="sum"><td>本月到手（月工资 − 个人缴合计）</td><td colspan="4">' + fmt(p.takeHome) + ' 元（月工资 ' + fmt(res.cfg.wage) + ' 元）</td></tr>';
    h += '</tbody>';
    $('splitTable').innerHTML = h;
  }

  function renderPaths(res) {
    const d = res.diff;
    const rows = [
      ['缴费基数（已按上下限截断）', res.declared.baseCents, res.full.baseCents],
      ['个人缴费合计', res.declared.personalTotal, res.full.personalTotal],
      ['本月到手（未扣个税）', res.declared.takeHome, res.full.takeHome],
      ['公司缴费合计', res.declared.companyTotal, res.full.companyTotal],
      ['公司用人现金成本（工资 + 公司缴费）', res.declared.companyCashCost, res.full.companyCashCost],
      ['本月进你个人账户', res.declared.toAcct, res.full.toAcct],
      ['本月进统筹', res.declared.toPool, res.full.toPool],
      ['每 100 元基数进个人账户', res.perBase.acctPer100 * 100, res.perBase.acctPer100 * 100]
    ];
    let h = '<thead><tr><th>项目</th><th>按申报基数缴</th><th>足额缴</th><th>差额（足额 − 申报）</th></tr></thead><tbody>';
    rows.forEach(([label, a, b], i) => {
      const money = i !== 7;
      const f = (x) => (money ? fmt(x) : (x / 100).toFixed(2) + ' 元 / 100 元基数');
      h += '<tr' + (i === 2 || i === 5 ? ' class="diff"' : '') + '><td>' + label + '</td><td>' + f(a) + '</td><td>' + f(b) + '</td><td>' + (money ? sgn(b - a) : '0.00') + '</td></tr>';
    });
    h += '</tbody>';
    $('pathTable').innerHTML = h;
    const bits = [];
    if (res.bases.declaredClamped) bits.push('申报基数 ' + fmt(res.cfg.base) + ' 元 已被' + (res.cfg.base > res.cfg.cap ? '上限' : '下限') + '截成 ' + fmt(res.bases.declared) + ' 元');
    if (res.bases.fullClamped) bits.push('月工资 ' + fmt(res.cfg.wage) + ' 元 已被' + (res.cfg.wage > res.cfg.cap ? '上限' : '下限') + '截成 ' + fmt(res.bases.full) + ' 元');
    $('pathNote').textContent = (bits.length ? bits.join('；') + '。' : '') +
      '「足额」这一路用的是月工资本身（再按上下限截断），不代表任何地区认定的应缴口径。';
  }

  function renderPer(res) {
    const b = res.perBase;
    const perList = [
      { k: '你到手（每 100 元）', v: '−' + b.takePer100.toFixed(2) + ' 元', s: '个人费率合计 ' + pct1(b.takePer100) },
      { k: '你的个人账户（每 100 元）', v: '+' + b.acctPer100.toFixed(2) + ' 元', s: '含公积金双边 ' + ((res.cfg.fundEmpBp + res.cfg.fundCoBp) / 100).toFixed(2) + ' 元' },
      { k: '公司多掏（每 100 元）', v: '+' + b.companyPer100.toFixed(2) + ' 元', s: '公司的边际成本' },
      { k: '你净得（每 100 元）', v: sgn(Math.round(b.netPer100 * 100)) + ' 元', s: '账户增 − 到手减' }
    ];
    $('perKpis').innerHTML = kpiHTML(perList);
    const net = b.acctPer100 - b.takePer100;
    $('perInsight').innerHTML = '每多缴 <b>100 元</b> 基数：你当月到手少 <b>' + b.takePer100.toFixed(2) + ' 元</b>，可你的个人账户里多 <b>' + b.acctPer100.toFixed(2) + ' 元</b>，' +
      '净 <b>' + sgn(Math.round(net * 100)) + ' 元</b>。原因是公积金两边都由公司代缴、但<b>双边都进你自己的账户</b>：基数越大，往你账户里搬的钱越多，' +
      '只是先从工资里扣走一小部分。' + (net > 0 ? '在这份费率表下，提基数对你是<b>净增益</b>——这解释了口径之争为什么总在「基数」上。' : '在这份费率表下，提基数对你是净损失（说明你的公积金比例或计入比例填得很低）。');
  }

  function renderLong(res) {
    $('longTag').textContent = res.cfg.years + ' 年 · 年化 ' + res.ratePct + '%';
    const longList = [
      { k: '按申报基数缴，个人账户 ' + res.cfg.years + ' 年后', v: fmt(res.declaredFV) + ' 元', s: '每月 ' + fmt(res.declared.toAcct) + ' 元 × ' + res.months + ' 个月' },
      { k: '足额缴，个人账户 ' + res.cfg.years + ' 年后', v: fmt(res.fullFV) + ' 元', s: '每月 ' + fmt(res.full.toAcct) + ' 元' },
      { k: '两者相差', v: fmt(res.diffFV) + ' 元', s: '占足额路的 ' + pct1(res.fullFV ? res.diffFV / res.fullFV * 100 : 0) },
      { k: '公司同期多掏', v: fmt(res.diff.companyTotal * res.months) + ' 元', s: '不含利率' }
    ];
    $('longKpis').innerHTML = kpiHTML(longList);

    // 曲线
    const W = 720, H = 260, padL = 54, padR = 12, padT = 12, padB = 28;
    const ys = res.perYear;
    const maxV = Math.max(1, ...ys.map((r) => Math.max(r.declaredBalance, r.fullBalance)));
    const x = (i) => padL + (W - padL - padR) * (ys.length <= 1 ? 0 : i / (ys.length - 1));
    const y = (v) => H - padB - (H - padT - padB) * (v / maxV);
    const line = (key) => ys.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r[key]).toFixed(1)).join(' ');
    let svg = '';
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4, yy = y(v);
      svg += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" stroke="#e2e8f0"/>' +
        '<text x="' + (padL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" font-size="10" fill="#7d8b9c" text-anchor="end">' + (v / 1e6).toFixed(1) + '万</text>';
    }
    svg += '<path d="' + line('fullBalance') + '" fill="none" stroke="#1d4ed8" stroke-width="2.5"/>';
    svg += '<path d="' + line('declaredBalance') + '" fill="none" stroke="#94a3b8" stroke-width="2.5"/>';
    [1, Math.round(ys.length / 2), ys.length].forEach((nth, k) => {
      const i = nth - 1;
      if (i < 0 || i >= ys.length) return;
      const anchor = k === 0 ? 'start' : (k === 2 ? 'end' : 'middle');
      svg += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="10" fill="#7d8b9c" text-anchor="' + anchor + '">第 ' + ys[i].year + ' 年</text>';
    });
    $('chart').innerHTML = svg;

    const step = 1;
    let h = '<thead><tr><th>年末</th><th>按申报基数缴（元）</th><th>足额缴（元）</th><th>相差（元）</th></tr></thead><tbody>';
    ys.forEach((r, i) => {
      if (r.year % step !== 0 && i !== ys.length - 1) return;
      h += '<tr><td>第 ' + r.year + ' 年</td><td>' + fmt(r.declaredBalance) + '</td><td>' + fmt(r.fullBalance) + '</td><td>' + fmt(r.fullBalance - r.declaredBalance) + '</td></tr>';
    });
    h += '</tbody>';
    $('yearTable').innerHTML = h;
  }

  function renderTarget(res) {
    const t = res.target;
    const box = $('targetBox');
    let h = '<div class="kpis">' + kpiHTML([
      { k: '目标', v: fmt(t.targetCents) + ' 元', s: t.months + ' 个月后想多出这么多' },
      { k: '需要的月账户增量', v: fmt(Math.round(t.neededMonthlyCents)) + ' 元/月', s: (t.ratePct ? '已按年化 ' + t.ratePct + '% 折现' : '利率为 0，直接是目标 ÷ 月数') },
      { k: '需要的缴费基数', v: (t.reachable ? fmt(t.neededBaseCents) + ' 元' : '超过上限'), s: '当前 ' + fmt(res.cfg.base) + ' 元 / 上限 ' + fmt(t.cappedAt) + ' 元' },
      { k: '回代残差', v: sgn(Math.round(t.residualCents)) + ' 元', s: '把解代回去再算一遍的差（每月账户增量只能精确到分）' }
    ]) + '</div>';
    h += t.reachable
      ? '<div class="okbox">把基数提到 <b>' + fmt(t.appliedBaseCents) + ' 元</b>（' + (t.appliedBaseCents > res.cfg.base ? '比现在高 ' : '比现在低 ') + fmt(Math.abs(t.appliedBaseCents - res.cfg.base)) + ' 元），个人账户每月进 <b>' + fmt(t.afterAcctPerMonth) + ' 元</b>，' + t.months + ' 个月后是 <b>' + fmt(t.afterFV) + ' 元</b>，比按现在基数缴多 <b>' + fmt(t.afterFV - res.declaredFV) + ' 元</b>。' + (t.fullBaseCovers ? '注意：足额缴（' + fmt(res.bases.full) + ' 元）本来就能覆盖这个目标。' : '足额缴也达不到这个目标。') + '</div>'
      : '<div class="warnbox">即使把基数顶到上限 <b>' + fmt(t.cappedAt) + ' 元</b>，这个目标也<b>达不到</b>（' + t.months + ' 个月后最多多出 ' + fmt(t.afterFV - res.declaredFV) + ' 元）。要么调低目标，要么把年限拉长——本页不会给你一个「做不到」的假数字。</div>';
    box.innerHTML = h;
  }

  function renderSens(res) {
    let h = '<thead><tr><th>条件</th><th>基数（元）</th><th>每月到手差（元）</th><th>每月账户差（元）</th><th>' + res.cfg.years + ' 年账户差（元）</th><th>公司月差（元）</th></tr></thead><tbody>';
    res.sensitivity.forEach((s) => {
      h += '<tr><td>' + esc(s.label) + '</td><td>' + fmt(s.baseCents) + '</td><td>' + sgn(Math.round(s.takeHomeDiff)) + '</td><td>' + sgn(Math.round(s.acctDiffMonthly)) + '</td><td>' + fmt(Math.round(s.acctDiffFV)) + '</td><td>' + fmt(Math.round(s.companyDiff)) + '</td></tr>';
    });
    h += '</tbody>';
    $('sensTable').innerHTML = h;
  }

  function renderSteps(res) { $('steps').innerHTML = res.steps.map((s) => '<li>' + esc(s) + '</li>').join(''); }
  function renderLimits(res) { $('limits').innerHTML = res.limits.map((s) => '<li>' + esc(s) + '</li>').join(''); }

  function renderChecks() {
    $('checks').innerHTML = state.checks.map((c) => '<li><span class="mark ' + (c.ok ? 'ok' : 'no') + '">' + (c.ok ? '✔' : '✖') + '</span><span>' + esc(c.name) + (c.detail ? ' <span class="d">（' + esc(c.detail) + '）</span>' : '') + '</span></li>').join('');
  }

  /* ── 导出 ─────────────────────────────────────────── */
  function download(name, text, type) {
    state.exportCount++;
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function csvText() {
    const res = state.res, cfg = res.cfg;
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const L = [];
    L.push(['缴费基数对账台 · 导出', '虚构示例口径，非任何地区政策'].map(q).join(','));
    L.push(['口径', '月工资 ' + fmt(cfg.wage) + ' 元', '申报基数 ' + fmt(cfg.base) + ' 元', '下限 ' + fmt(cfg.floor), '上限 ' + fmt(cfg.cap), '公积金 ' + (cfg.fundEmpBp / 100) + '% / ' + (cfg.fundCoBp / 100) + '%', '年限 ' + cfg.years, '年化 ' + res.ratePct + '%'].map(q).join(','));
    L.push('');
    L.push(['五笔钱（按申报基数）'].map(q).join(','));
    L.push(['项目', '个人缴(元)', '公司缴(元)', '进个人账户(元)', '进统筹(元)'].map(q).join(','));
    res.declared.rows.forEach((r) => L.push([r.name, (r.personal / 100).toFixed(2), (r.company / 100).toFixed(2), (r.toAcct / 100).toFixed(2), (r.toPool / 100).toFixed(2)].map(q).join(',')));
    L.push(['住房公积金', (res.declared.fundEmp / 100).toFixed(2), (res.declared.fundCo / 100).toFixed(2), ((res.declared.fundEmp + res.declared.fundCo) / 100).toFixed(2), '0.00'].map(q).join(','));
    L.push(['合计', (res.declared.personalTotal / 100).toFixed(2), (res.declared.companyTotal / 100).toFixed(2), (res.declared.toAcct / 100).toFixed(2), (res.declared.toPool / 100).toFixed(2)].map(q).join(','));
    L.push(['本月到手（未扣个税）', (res.declared.takeHome / 100).toFixed(2)].map(q).join(','));
    L.push('');
    L.push(['两条路对照'].map(q).join(','));
    L.push(['项目', '按申报基数缴', '足额缴', '差额'].map(q).join(','));
    L.push(['缴费基数(元)', (res.declared.baseCents / 100).toFixed(2), (res.full.baseCents / 100).toFixed(2), ((res.full.baseCents - res.declared.baseCents) / 100).toFixed(2)].map(q).join(','));
    L.push(['个人缴费合计(元)', (res.declared.personalTotal / 100).toFixed(2), (res.full.personalTotal / 100).toFixed(2), ((res.full.personalTotal - res.declared.personalTotal) / 100).toFixed(2)].map(q).join(','));
    L.push(['本月到手(元)', (res.declared.takeHome / 100).toFixed(2), (res.full.takeHome / 100).toFixed(2), (res.diff.takeHome / 100).toFixed(2)].map(q).join(','));
    L.push(['进个人账户(元)', (res.declared.toAcct / 100).toFixed(2), (res.full.toAcct / 100).toFixed(2), (res.diff.toAcct / 100).toFixed(2)].map(q).join(','));
    L.push(['进统筹(元)', (res.declared.toPool / 100).toFixed(2), (res.full.toPool / 100).toFixed(2), (res.diff.toPool / 100).toFixed(2)].map(q).join(','));
    L.push(['公司缴费合计(元)', (res.declared.companyTotal / 100).toFixed(2), (res.full.companyTotal / 100).toFixed(2), (res.diff.companyTotal / 100).toFixed(2)].map(q).join(','));
    L.push('');
    L.push(['边际账（每 100 元基数）', '到手', '个人账户', '公司', '你净得'].map(q).join(','));
    L.push(['元', (-res.perBase.takePer100).toFixed(2), res.perBase.acctPer100.toFixed(2), res.perBase.companyPer100.toFixed(2), (res.perBase.acctPer100 - res.perBase.takePer100).toFixed(2)].map(q).join(','));
    L.push('');
    L.push(['长期累积(年化 ' + res.ratePct + '%)'].map(q).join(','));
    L.push(['年末', '按申报基数缴(元)', '足额缴(元)', '相差(元)'].map(q).join(','));
    res.perYear.forEach((r) => L.push([r.year, (r.declaredBalance / 100).toFixed(2), (r.fullBalance / 100).toFixed(2), ((r.fullBalance - r.declaredBalance) / 100).toFixed(2)].map(q).join(',')));
    L.push('');
    L.push(['反推', '目标(元)', '需要月增量(元)', '需要基数(元)', '可达到', '回代残差(元)'].map(q).join(','));
    L.push(['', (res.target.targetCents / 100).toFixed(2), (res.target.neededMonthlyCents / 100).toFixed(2), res.target.reachable ? (res.target.neededBaseCents / 100).toFixed(2) : '超过上限', res.target.reachable ? '是' : '否', (res.target.residualCents / 100).toFixed(2)].map(q).join(','));
    L.push('');
    L.push(['敏感性'].map(q).join(','));
    L.push(['条件', '基数(元)', '到手差(元)', '账户月差(元)', '账户' + res.cfg.years + '年差(元)', '公司月差(元)'].map(q).join(','));
    res.sensitivity.forEach((s) => L.push([s.label, (s.baseCents / 100).toFixed(2), (s.takeHomeDiff / 100).toFixed(2), (s.acctDiffMonthly / 100).toFixed(2), (s.acctDiffFV / 100).toFixed(2), (s.companyDiff / 100).toFixed(2)].map(q).join(',')));
    return '\ufeff' + L.join('\r\n') + '\r\n';
  }

  function mdText() {
    const res = state.res, cfg = res.cfg, d = res.diff;
    const L = [];
    L.push('# 缴费基数对账台 · 导出');
    L.push('');
    L.push('> 口径：月工资 ' + fmt(cfg.wage) + ' 元 / 申报基数 ' + fmt(cfg.base) + ' 元 / 下限 ' + fmt(cfg.floor) + ' / 上限 ' + fmt(cfg.cap) + ' / 公积金 ' + (cfg.fundEmpBp / 100) + '% 与 ' + (cfg.fundCoBp / 100) + '% / ' + cfg.years + ' 年 / 年化 ' + res.ratePct + '%。默认与内置场景都是**虚构示例**，不是任何地区或年份的政策数值。');
    L.push('');
    L.push('## 结论');
    L.push('');
    L.push('按申报基数 ' + fmt(res.bases.declared) + ' 元 缴，而不是按足额 ' + fmt(res.bases.full) + ' 元 缴：本月到手 ' + (d.takeHome >= 0 ? '多' : '少') + ' ' + fmt(Math.abs(d.takeHome)) + ' 元，个人账户每月 ' + (d.toAcct >= 0 ? '多' : '少') + ' ' + fmt(Math.abs(d.toAcct)) + ' 元；' + res.months + ' 个月后个人账户相差 ' + fmt(Math.abs(res.diffFV)) + ' 元。');
    L.push('');
    L.push('## 五笔钱（按申报基数，每月）');
    L.push('');
    L.push('| 项目 | 个人缴 | 公司缴 | 进你个人账户 | 进统筹 |');
    L.push('|---|---:|---:|---:|---:|');
    res.declared.rows.forEach((r) => L.push('| ' + r.name + ' | ' + fmt(r.personal) + ' | ' + fmt(r.company) + ' | ' + fmt(r.toAcct) + ' | ' + fmt(r.toPool) + ' |'));
    L.push('| 住房公积金 | ' + fmt(res.declared.fundEmp) + ' | ' + fmt(res.declared.fundCo) + ' | ' + fmt(res.declared.fundEmp + res.declared.fundCo) + ' | 0.00 |');
    L.push('| **合计** | **' + fmt(res.declared.personalTotal) + '** | **' + fmt(res.declared.companyTotal) + '** | **' + fmt(res.declared.toAcct) + '** | **' + fmt(res.declared.toPool) + '** |');
    L.push('');
    L.push('- 本月到手（月工资 − 个人缴合计，未扣个税）：**' + fmt(res.declared.takeHome) + ' 元**');
    L.push('- 本月进你个人账户：**' + fmt(res.declared.toAcct) + ' 元**；本月进统筹：**' + fmt(res.declared.toPool) + ' 元**');
    L.push('- 公司本月为你缴：**' + fmt(res.declared.companyTotal) + ' 元**；用人现金成本 **' + fmt(res.declared.companyCashCost) + ' 元**');
    L.push('');
    L.push('## 边际账（每多缴 100 元基数）');
    L.push('');
    L.push('- 你到手 **−' + res.perBase.takePer100.toFixed(2) + ' 元**');
    L.push('- 你个人账户 **+' + res.perBase.acctPer100.toFixed(2) + ' 元**（含公积金双边）');
    L.push('- 公司多掏 **+' + res.perBase.companyPer100.toFixed(2) + ' 元**');
    L.push('- 你净得 **' + (res.perBase.acctPer100 - res.perBase.takePer100 >= 0 ? '+' : '−') + Math.abs(res.perBase.acctPer100 - res.perBase.takePer100).toFixed(2) + ' 元**');
    L.push('');
    L.push('## 长期累积（' + cfg.years + ' 年，年化 ' + res.ratePct + '%）');
    L.push('');
    L.push('| 年末 | 按申报基数缴 | 足额缴 | 相差 |');
    L.push('|---|---:|---:|---:|');
    const step = res.perYear.length > 20 ? 5 : 1;
    res.perYear.forEach((r, i) => { if (r.year % step === 0 || i === res.perYear.length - 1) L.push('| 第 ' + r.year + ' 年 | ' + fmt(r.declaredBalance) + ' | ' + fmt(r.fullBalance) + ' | ' + fmt(r.fullBalance - r.declaredBalance) + ' |'); });
    L.push('');
    L.push('## 反推');
    L.push('');
    if (res.target.reachable) {
      L.push('想让个人账户 ' + res.target.months + ' 个月后多出 ' + fmt(res.target.targetCents) + ' 元，需要把基数提到 **' + fmt(res.target.appliedBaseCents) + ' 元**（当前 ' + fmt(cfg.base) + ' 元）；回代残差 ' + sgn(Math.round(res.target.residualCents)) + ' 元。');
    } else {
      L.push('即使把基数顶到上限 ' + fmt(res.target.cappedAt) + ' 元，目标 ' + fmt(res.target.targetCents) + ' 元也**达不到**（最多多出 ' + fmt(res.target.afterFV - res.declaredFV) + ' 元）。');
    }
    L.push('');
    L.push('## 敏感性（每一行都完整重算）');
    L.push('');
    L.push('| 条件 | 基数(元) | 每月到手差 | 每月账户差 | ' + cfg.years + ' 年账户差 | 公司月差 |');
    L.push('|---|---:|---:|---:|---:|---:|');
    res.sensitivity.forEach((s) => L.push('| ' + s.label + ' | ' + fmt(s.baseCents) + ' | ' + fmt(s.takeHomeDiff) + ' | ' + fmt(s.acctDiffMonthly) + ' | ' + fmt(s.acctDiffFV) + ' | ' + fmt(s.companyDiff) + ' |'));
    L.push('');
    L.push('## 这份账不算什么');
    L.push('');
    res.limits.forEach((s) => L.push('- ' + s));
    L.push('');
    L.push('结构自检：' + state.checks.filter((c) => c.ok).length + ' / ' + state.checks.length + ' 项通过。');
    return L.join('\n') + '\n';
  }

  function jsonBackup() {
    return JSON.stringify({
      app: 'contribution-base', version: 1,
      savedAt: new Date().toISOString(),
      input: readInput(),
      anchors: {
        declaredBase: state.res.bases.declared, fullBase: state.res.bases.full,
        takeHome: state.res.declared.takeHome, toAcct: state.res.declared.toAcct,
        toPool: state.res.declared.toPool, companyTotal: state.res.declared.companyTotal,
        diffTakeHome: state.res.diff.takeHome, diffToAcct: state.res.diff.toAcct,
        diffFV: state.res.diffFV, months: state.res.months
      }
    }, null, 2);
  }

  /* ── 结果卡 PNG（1080×1350） ─────────────────────── */
  function pngCard() {
    const res = state.res;
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const F = (w, sz) => w + ' ' + sz + 'px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1d4ed8'; g.fillRect(0, 0, W, 12);
    g.fillStyle = '#16202c'; g.font = F(700, 50); g.fillText('缴费基数对账台', 72, 104);
    g.fillStyle = '#4a5a6e'; g.font = F(400, 25);
    g.fillText('公司按低基数缴，你亏在哪：五笔钱 + ' + res.cfg.years + ' 年账户差', 72, 146);

    /* 结论 182–332 */
    g.fillStyle = '#eef2ff'; g.fillRect(72, 182, W - 144, 150);
    g.fillStyle = '#16202c'; g.font = F(500, 29);
    g.fillText('按 ' + fmt(res.bases.declared) + ' 元 缴（不是足额 ' + fmt(res.bases.full) + ' 元）：', 96, 226);
    g.font = F(700, 33);
    g.fillStyle = '#1d4ed8';
    g.fillText('本月到手 ' + (res.diff.takeHome <= 0 ? '多' : '少') + ' ' + fmt(Math.abs(res.diff.takeHome)) + ' 元', 96, 272);
    g.fillStyle = '#b42318';
    g.fillText('个人账户每月 ' + (res.diff.toAcct >= 0 ? '少' : '多') + ' ' + fmt(Math.abs(res.diff.toAcct)) + ' 元', 96, 316);

    /* 四个 KPI */
    const kpi = [
      ['本月到手（未扣个税）', fmt(res.declared.takeHome) + ' 元'],
      ['本月进你个人账户', fmt(res.declared.toAcct) + ' 元'],
      ['本月进统筹', fmt(res.declared.toPool) + ' 元'],
      [res.cfg.years + ' 年账户差', fmt(Math.abs(res.diffFV)) + ' 元']
    ];
    kpi.forEach((x, i) => {
      const px = 72 + (i % 2) * 476, py = 352 + Math.floor(i / 2) * 126;
      g.fillStyle = '#fff'; g.fillRect(px, py, 452, 118);
      g.strokeStyle = '#e2e8f0'; g.strokeRect(px, py, 452, 118);
      g.fillStyle = '#4a5a6e'; g.font = F(400, 23); g.fillText(x[0], px + 24, py + 40);
      g.fillStyle = '#16202c'; g.font = F(700, 36); g.fillText(x[1], px + 24, py + 90);
    });

    /* 五笔钱表 */
    g.fillStyle = '#16202c'; g.font = F(700, 31); g.fillText('五笔钱（每月）', 72, 640);
    const cols = [72, 372, 552, 762, 962];
    g.font = F(400, 21); g.fillStyle = '#7d8b9c';
    ['项目', '个人缴', '公司缴', '进你账户', '进统筹'].forEach((t, i) => g.fillText(t, cols[i], 674));
    g.strokeStyle = '#e2e8f0'; g.beginPath(); g.moveTo(72, 686); g.lineTo(W - 72, 686); g.stroke();
    let yy = 716;
    const rowsT = res.declared.rows.map((r) => [r.name, fmt(r.personal), fmt(r.company), fmt(r.toAcct), fmt(r.toPool)]);
    rowsT.push(['住房公积金', fmt(res.declared.fundEmp), fmt(res.declared.fundCo), fmt(res.declared.fundEmp + res.declared.fundCo), '0.00']);
    rowsT.push(['合计', fmt(res.declared.personalTotal), fmt(res.declared.companyTotal), fmt(res.declared.toAcct), fmt(res.declared.toPool)]);
    rowsT.forEach((r, ri) => {
      g.font = F(ri === rowsT.length - 1 ? 700 : 400, 23);
      g.fillStyle = ri === rowsT.length - 1 ? '#16202c' : '#34455a';
      r.forEach((t, ci) => g.fillText(t, cols[ci], yy));
      yy += 32;
    });

    /* 边际账 940–1052 */
    g.fillStyle = '#e8f6ef'; g.fillRect(72, 940, W - 144, 112);
    g.fillStyle = '#0f7b52'; g.font = F(700, 26);
    g.fillText('每多缴 100 元基数：到手 −' + res.perBase.takePer100.toFixed(2) + ' 元，个人账户 +' + res.perBase.acctPer100.toFixed(2) + ' 元', 96, 982);
    g.font = F(400, 23); g.fillStyle = '#16202c';
    g.fillText('净得 ' + (res.perBase.acctPer100 - res.perBase.takePer100 >= 0 ? '+' : '−') + Math.abs(res.perBase.acctPer100 - res.perBase.takePer100).toFixed(2) + ' 元 / 100 元基数（公积金双边都进你的账户）', 96, 1024);

    /* 反推 */
    g.fillStyle = '#16202c'; g.font = F(700, 29); g.fillText('反推', 72, 1084);
    g.font = F(400, 24); g.fillStyle = '#34455a';
    if (res.target.reachable) {
      g.fillText('想让账户 ' + res.target.months + ' 个月后多出 ' + fmt(res.target.targetCents) + ' 元 → 把基数提到 ' + fmt(res.target.appliedBaseCents) + ' 元', 72, 1122);
      g.fillText('（当前 ' + fmt(res.bases.declared) + ' 元；回代残差 ' + sgn(Math.round(res.target.residualCents)) + ' 元）', 72, 1156);
    } else {
      g.fillText('目标 ' + fmt(res.target.targetCents) + ' 元 即使顶到上限 ' + fmt(res.target.cappedAt) + ' 元 也达不到', 72, 1122);
      g.fillText('（最多多出 ' + fmt(res.target.afterFV - res.declaredFV) + ' 元）', 72, 1156);
    }

    /* 页脚 */
    g.fillStyle = '#e2e8f0'; g.fillRect(72, 1200, W - 144, 1);
    g.fillStyle = '#7d8b9c'; g.font = F(400, 21);
    g.fillText('月工资 ' + fmt(res.cfg.wage) + ' 元 / 申报基数 ' + fmt(res.bases.declared) + ' 元 / 下限 ' + fmt(res.cfg.floor) + ' / 上限 ' + fmt(res.cfg.cap), 72, 1236);
    g.fillText('公积金 ' + (res.cfg.fundEmpBp / 100) + '% 与 ' + (res.cfg.fundCoBp / 100) + '% / ' + res.cfg.years + ' 年 / 年化 ' + res.ratePct + '% ｜ 「到手」未扣个税', 72, 1266);
    g.fillText('虚构示例口径，不是任何地区政策 · 不做合规判断 · 不联网', 72, 1296);

    const name = '缴费基数对账台-结果卡-' + (res.bases.declared / 100) + '.png';
    cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      state.exportCount++;
    }, 'image/png');
  }

  /* ── 本机保存 / 导入 ─────────────────────────────── */
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readInput()));
      $('saveState').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。只存在这个浏览器里。';
      toast('已保存到本机');
    } catch (e) { $('saveState').textContent = '这台浏览器不允许本机保存（可能是隐私模式）。'; }
  }

  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      writeInput(JSON.parse(raw));
      if (!silent) toast('已读取上次保存的输入');
      return true;
    } catch (e) { if (!silent) toast('本机保存的内容读不出来'); return false; }
  }

  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const o = JSON.parse(String(fr.result));
        if (!o || o.app !== 'contribution-base' || !o.input) { toast('这不是本页的备份文件'); return; }
        writeInput(o.input);
        compute();
        toast('已导入备份并重算');
      } catch (e) { toast('备份文件解析失败'); }
    };
    fr.readAsText(file);
  }

  /* ── 事件绑定与启动 ─────────────────────────────── */
  function bind() {
    const form = $('form');
    form.addEventListener('input', (e) => { if (e.target.matches('input[type=text]')) compute(); });
    form.addEventListener('change', () => compute());
    $('rows').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-del]');
      if (!b) return;
      const cur = readInput();
      if (cur.rows.length <= 1) { toast('至少保留一行'); return; }
      cur.rows.splice(Number(b.dataset.del), 1);
      writeInput(cur); compute();
    });
    $('btnAddRow').addEventListener('click', () => {
      const cur = readInput();
      if (cur.rows.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 行'); return; }
      cur.rows.push({ name: '新险种', rp: '0', rc: '0', ap: '0', ac: '0' });
      writeInput(cur); compute();
    });
    $('btnReset').addEventListener('click', () => { writeInput(C.defaultsClone()); $('scenario').value = 'default'; compute(); toast('已恢复默认示例'); });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', () => { if (loadLocal(false)) compute(); });
    $('scenario').addEventListener('change', (e) => {
      const sc = C.scenarios.find((s) => s.key === e.target.value);
      if (!sc) return;
      writeInput(Object.assign(C.defaultsClone(), sc.patch));
      compute(); toast('已套用场景：' + sc.label);
    });
    $('btnCsv').addEventListener('click', () => { download('缴费基数对账台.csv', csvText(), 'text/csv;charset=utf-8'); toast('CSV 已导出'); });
    $('btnMd').addEventListener('click', () => { download('缴费基数对账台.md', mdText(), 'text/markdown;charset=utf-8'); toast('Markdown 已导出'); });
    $('btnJson').addEventListener('click', () => { download('缴费基数对账台-备份.json', jsonBackup(), 'application/json'); toast('JSON 备份已导出'); });
    $('btnPng').addEventListener('click', () => { pngCard(); toast('结果卡 PNG 正在生成'); });
    $('btnPrint').addEventListener('click', () => window.print());
    $('importFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); });
    window.addEventListener('error', () => {});
  }

  function boot() {
    $('scenario').innerHTML = C.scenarios.map((s) => '<option value="' + s.key + '">' + esc(s.label) + '</option>').join('');
    writeInput(C.defaultsClone());
    bind();
    loadLocal(true);
    compute();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
