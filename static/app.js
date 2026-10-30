/* SU7 充电账本 — 前端逻辑（双模式：服务端 / 独立本地） */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    records: [],
    stats: null,
    reviewDraft: null,
    editId: null,
  };

  // ---------------- utils ----------------
  function toast(msg, isErr = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("err", isErr);
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3000);
  }

  const fmt = {
    num(v, d = 1) {
      if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
      return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    int(v) {
      if (v === null || v === undefined) return "—";
      return Number(v).toLocaleString("zh-CN");
    },
    money(v) {
      if (v === null || v === undefined) return "—";
      return "¥" + Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    time(v) { return !v ? "—" : (v.length > 16 ? v.slice(5, 16) : v); },
    full(v) { return v || "—"; },
  };

  function priceOf(r) {
    return r.energy_kwh > 0 && r.fee_yuan != null ? r.fee_yuan / r.energy_kwh : null;
  }

  function sourceTag(s) {
    const map = { xiaomi: "小米", operator: "运营商", mixed: "混合", manual: "手动" };
    return `<span class="tag ${s || "manual"}">${map[s] || "手动"}</span>`;
  }

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // ---------------- tabs ----------------
  function switchTab(name) {
    if (!["dashboard", "records", "settings"].includes(name)) name = "dashboard";
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
    if (name === "dashboard") loadDashboard();
    if (name === "records") loadRecords();
    if (name === "settings") loadSettings();
  }

  // ---------------- dashboard ----------------
  async function loadDashboard() {
    try {
      const stats = await SU7API.stats();
      state.stats = stats;
      renderKpis(stats.summary);
      drawMonthly($("#chart-monthly"), stats.monthly);
      drawHourly($("#chart-hourly"), stats.hourly);
      drawPrice($("#chart-price"), stats.price_trend);
      drawLocations($("#chart-loc"), stats.top_locations);
      renderRecent(stats.recent);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderKpis(s) {
    const sp = state.stats && state.stats.soc_points ? state.stats.soc_points : [];
    let socText = "—", socSub = "见记录明细", socUnit = "";
    if (sp.length) {
      const avgAdd = sp.reduce((a, b) => a + (b.end - b.start), 0) / sp.length;
      socText = fmt.num(avgAdd, 0); socUnit = "%"; socSub = `${sp.length} 条含电量区间`;
    }
    const items = [
      { label: "充电次数", value: fmt.int(s.count), unit: "次", sub: "全部已入库" },
      { label: "累计电量", value: fmt.num(s.total_kwh), unit: "kWh", sub: `平均单次 ${fmt.num(s.avg_kwh)} 度` },
      { label: "累计费用", value: fmt.num(s.total_fee), unit: "元", sub: `平均单次 ${fmt.money(s.count ? s.total_fee / s.count : 0)}` },
      { label: "平均单价", value: s.avg_price == null ? "—" : fmt.num(s.avg_price, 2), unit: "元/度", sub: "费用 ÷ 电量" },
      { label: "累计时长", value: fmt.num(s.total_hours), unit: "小时", sub: `平均单次 ${fmt.int(s.avg_duration_min)} 分钟` },
      { label: "平均 SOC 提升", value: socText, unit: socUnit, sub: socSub },
    ];
    $("#kpi-row").innerHTML = items
      .map((it) => `<div class="kpi">
          <div class="k-label">${it.label}</div>
          <div class="k-value">${it.value}<span class="unit">${it.unit || ""}</span></div>
          <div class="k-sub">${it.sub}</div>
        </div>`)
      .join("");
  }

  async function renderRecent(recs) {
    const tb = $("#recent-table tbody");
    if (!recs || !recs.length) {
      tb.innerHTML = `<tr class="empty-row"><td colspan="7">还没有充电记录，先到「充电记录」导入截图</td></tr>`;
      return;
    }
    tb.innerHTML = recs
      .map((r) => {
        const p = priceOf(r);
        return `<tr>
          <td>${fmt.time(r.charge_start)}</td>
          <td>${r.energy_kwh != null ? fmt.num(r.energy_kwh) + " 度" : "—"}</td>
          <td>${fmt.money(r.fee_yuan)}</td>
          <td class="price">${p != null ? fmt.num(p, 2) : "—"}</td>
          <td class="soc">${r.start_soc != null ? `${r.start_soc}% → ${r.end_soc ?? "?"}%` : "—"}</td>
          <td class="loc">${fmt.full(r.location) || fmt.full(r.operator)}</td>
          <td>${sourceTag(r.source_type)}</td>
        </tr>`;
      })
      .join("");
  }

  // ---------------- SVG charts ----------------
  const C = { orange: "#ff6900", teal: "#0fa47f", ink: "#17181c", muted: "#69707d", line: "#e8eaee" };

  function svgOpen(w, h) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">`;
  }

  function txt(x, y, s, opt = {}) {
    const size = opt.size || 11;
    const fill = opt.fill || C.muted;
    const anchor = opt.anchor || "middle";
    const weight = opt.weight || 400;
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" font-family="PingFang SC, Microsoft YaHei, sans-serif">${s}</text>`;
  }

  function drawMonthly(el, data) {
    if (!data || !data.length) return emptyChart(el);
    const W = 560, H = 240, padL = 40, padR = 40, padT = 20, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxK = Math.max(...data.map((d) => d.kwh), 1);
    const maxF = Math.max(...data.map((d) => d.fee), 1);
    const bw = Math.min(28, (iw / data.length) * 0.42);
    let s = svgOpen(W, H);
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ih * i) / 4;
      s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`;
      s += txt(padL - 8, y + 3, fmt.num(maxK * (1 - i / 4), 0), { anchor: "end", size: 10 });
    }
    const pts = [];
    data.forEach((d, i) => {
      const cx = padL + ((i + 0.5) * iw) / data.length;
      const bh = (d.kwh / maxK) * ih;
      s += `<rect x="${cx - bw / 2}" y="${padT + ih - bh}" width="${bw}" height="${Math.max(bh, 1)}" rx="4" fill="${C.orange}" opacity="0.85"/>`;
      pts.push([cx, padT + ih - (d.fee / maxF) * ih]);
      s += txt(cx, H - 12, d.month.slice(2), { size: 10 });
    });
    s += `<polyline fill="none" stroke="${C.teal}" stroke-width="2" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    pts.forEach((p) => (s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="#fff" stroke="${C.teal}" stroke-width="2"/>`));
    s += txt(W - padR + 10, padT + 4, "费", { fill: C.teal, anchor: "start", size: 10, weight: 600 });
    s += txt(padL - 8, padT - 6, "度", { anchor: "end", size: 10, weight: 600 });
    s += `</svg>`;
    el.innerHTML = s;
  }

  function drawHourly(el, data) {
    const total = (data || []).reduce((a, b) => a + b.kwh, 0);
    if (!total) return emptyChart(el, "还没有带开始时间的记录");
    const W = 560, H = 240, padL = 36, padR = 14, padT = 18, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxV = Math.max(...data.map((d) => d.kwh), 1);
    const bw = iw / 24 - 3;
    let s = svgOpen(W, H);
    for (let i = 0; i <= 3; i++) {
      const y = padT + (ih * i) / 3;
      s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${C.line}"/>`;
      s += txt(padL - 6, y + 3, fmt.num(maxV * (1 - i / 3), 0), { anchor: "end", size: 10 });
    }
    data.forEach((d, i) => {
      const x = padL + (i * iw) / 24 + 1.5;
      const h = (d.kwh / maxV) * ih;
      const inValley = d.hour >= 23 || d.hour < 7;
      s += `<rect x="${x}" y="${padT + ih - h}" width="${bw}" height="${Math.max(h, d.kwh > 0 ? 2 : 0)}" rx="3" fill="${inValley ? C.teal : C.orange}" opacity="${d.kwh > 0 ? 0.9 : 0}"/>`;
      if (i % 3 === 0) s += txt(x + bw / 2, H - 10, String(d.hour), { size: 10 });
    });
    s += txt(W - padR, padT + 2, "青=谷电时段(23-7点)", { anchor: "end", size: 10, fill: C.teal });
    s += `</svg>`;
    el.innerHTML = s;
  }

  function drawPrice(el, data) {
    if (!data || data.length < 2) return emptyChart(el, "至少两条含电量+费用的记录才有趋势");
    const W = 560, H = 240, padL = 44, padR = 18, padT = 18, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const vals = data.map((d) => d.price);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 0.2) { min -= 0.15; max += 0.15; }
    const pad = (max - min) * 0.12;
    min = Math.max(0, min - pad); max = max + pad;
    const X = (i) => padL + (i * iw) / (data.length - 1);
    const Y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
    let s = svgOpen(W, H);
    for (let i = 0; i <= 3; i++) {
      const y = padT + (ih * i) / 3;
      s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${C.line}"/>`;
      s += txt(padL - 6, y + 3, fmt.num(max - ((max - min) * i) / 3, 2), { anchor: "end", size: 10 });
    }
    s += `<polyline fill="none" stroke="${C.orange}" stroke-width="2" points="${data.map((d, i) => `${X(i)},${Y(d.price)}`).join(" ")}"/>`;
    data.forEach((d, i) => {
      s += `<circle cx="${X(i)}" cy="${Y(d.price)}" r="3" fill="#fff" stroke="${C.orange}" stroke-width="1.8"><title>${d.date} · ${fmt.num(d.price, 2)} 元/度 · ${fmt.num(d.kwh)} 度</title></circle>`;
    });
    if (data.length) {
      s += txt(padL, H - 10, data[0].date.slice(5) || "", { anchor: "start", size: 10 });
      s += txt(W - padR, H - 10, data[data.length - 1].date.slice(5) || "", { anchor: "end", size: 10 });
    }
    s += `</svg>`;
    el.innerHTML = s;
  }

  function drawLocations(el, data) {
    if (!data || !data.length) return emptyChart(el, "暂无场站数据");
    const rows = data.slice(0, 6);
    const W = 560, rowH = 30, H = rows.length * rowH + 16;
    const labelW = 150, barMax = W - labelW - 70;
    const maxV = Math.max(...rows.map((r) => r.kwh), 1);
    let s = svgOpen(W, H);
    rows.forEach((r, i) => {
      const y = 12 + i * rowH;
      const w = (r.kwh / maxV) * barMax;
      s += txt(labelW - 10, y + 8, r.location.length > 10 ? r.location.slice(0, 10) + "…" : r.location, { anchor: "end", size: 12, fill: C.ink });
      s += `<rect x="${labelW}" y="${y}" width="${Math.max(w, 2)}" height="14" rx="7" fill="${i % 2 ? C.teal : C.orange}" opacity="0.88"/>`;
      s += txt(labelW + w + 8, y + 11, `${fmt.num(r.kwh)} 度`, { anchor: "start", size: 11, fill: C.muted });
    });
    s += `</svg>`;
    el.innerHTML = s;
  }

  function emptyChart(el, msg = "暂无数据，先导入几张充电截图") {
    el.innerHTML = `<div class="empty">${msg}</div>`;
  }

  // ---------------- records ----------------
  async function loadRecords() {
    const q = {
      from: $("#filter-from").value,
      to: $("#filter-to").value,
      q: $("#filter-q").value.trim(),
    };
    try {
      state.records = await SU7API.listRecords(q);
      renderRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderRecords() {
    const tb = $("#records-table tbody");
    $("#rec-count").textContent = `共 ${state.records.length} 条`;
    if (!state.records.length) {
      tb.innerHTML = `<tr class="empty-row"><td colspan="10">没有匹配的记录</td></tr>`;
      return;
    }
    tb.innerHTML = state.records
      .map((r) => {
        const p = priceOf(r);
        const dur = r.duration_min != null ? fmt.int(r.duration_min) + " 分" : "—";
        return `<tr data-id="${r.id}">
          <td>${fmt.full(r.charge_start)}</td>
          <td>${r.energy_kwh != null ? fmt.num(r.energy_kwh, 3) : "—"}</td>
          <td>${fmt.money(r.fee_yuan)}</td>
          <td class="price">${p != null ? fmt.num(p, 2) : "—"}</td>
          <td class="soc">${r.start_soc != null ? `${r.start_soc}→${r.end_soc ?? "?"}%` : "—"}</td>
          <td>${dur}</td>
          <td class="loc" title="${r.location || ""}">${fmt.full(r.location)}</td>
          <td>${sourceTag(r.source_type)}</td>
          <td title="${r.extract_engine || ""}">${engineLabel(r)}</td>
          <td>
            <button class="btn sm ghost" data-act="edit">编辑</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function engineLabel(r) {
    const map = { "vision-api": "视觉", winocr: "本地OCR", "local-ocr": "本地OCR", manual: "手动" };
    const name = map[r.extract_engine] || r.extract_engine || "手动";
    const low = r.confidence != null && r.confidence < 0.6;
    return `${name}${low ? ' <span class="badge low">待确认</span>' : ""}`;
  }

  // ---------------- import & review ----------------
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return toast("请选择图片文件", true);
    for (const file of files) {
      const qItem = addQueueItem(file);
      try {
        setQueueState(qItem, "识别中…", "busy");
        const res = await SU7API.extract(file, file.name);
        setQueueState(qItem, "识别完成", "ok", res.image_url);
        if (!state.reviewDraft) {
          openReview(res);
        } else {
          pendingResults.push(res);
          toast(`已识别 ${file.name}，请先处理当前校对单`);
        }
      } catch (e) {
        setQueueState(qItem, e.message, "err");
      }
    }
  }

  const pendingResults = [];

  function addQueueItem(file) {
    const el = document.createElement("div");
    el.className = "q-item";
    el.innerHTML = `<img alt=""><div><div class="q-name">${esc(file.name)}</div><div class="q-state">等待识别</div></div>`;
    $("#queue").appendChild(el);
    const img = el.querySelector("img");
    fileToDataUrl(file).then((u) => (img.src = u));
    return el;
  }

  function setQueueState(el, text, cls, imgUrl) {
    const st = el.querySelector(".q-state");
    st.textContent = text;
    st.className = "q-state " + (cls || "");
    if (imgUrl) el.querySelector("img").src = imgUrl;
  }

  function openReview(res) {
    if (res.mode === "list" && (res.records || []).length >= 2) {
      return openBatchReview(res);
    }
    closeBatchReview();
    state.reviewDraft = res;
    $("#review-card").classList.remove("hidden");
    $("#review-img").src = res.image_url;
    $("#review-engine").textContent = ({
      "vision-api": "视觉大模型识别",
      winocr: "Windows 本地 OCR",
      "local-ocr": "本地 OCR（离线）",
      manual: "手动录入",
    })[res.engine] || res.engine;
    $("#review-raw").textContent = (res.fields && res.fields.raw_text) || "（无识别文本）";
    fillForm($("#review-form"), res.fields || {}, res.confidence || {});
    $("#review-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fillForm(form, fields, confidence) {
    $$("#" + form.id + " [name]").forEach((input) => {
      const key = input.name;
      const v = fields[key];
      input.value = v === null || v === undefined ? "" : v;
      const lab = input.closest("label");
      if (!lab) return;
      lab.querySelectorAll(".badge").forEach((b) => b.remove());
      if (confidence[key] != null && confidence[key] < 0.6 && v != null && v !== "") {
        const b = document.createElement("span");
        b.className = "badge low";
        b.textContent = "待确认";
        lab.appendChild(b);
      }
    });
  }

  function readForm(form) {
    const out = {};
    $$("#" + form.id + " [name]").forEach((input) => {
      const v = input.value.trim();
      if (v !== "") out[input.name] = v;
    });
    return out;
  }

  async function saveReview() {
    const draft = state.reviewDraft;
    if (!draft) return;
    const payload = {
      ...readForm($("#review-form")),
      image_file: draft.image_file,
      status: ($("#review-form [name=status]") || {}).value || "",
      raw_text: (draft.fields && draft.fields.raw_text) || "",
      extract_engine: draft.engine,
      confidence: draft.fields && draft.fields.confidence,
    };
    try {
      const res = await SU7API.createRecord(payload);
      if (res.duplicate) {
        toast("已存在相同充电记录（#" + res.dup_id + "），未重复入库");
      } else {
        toast("已保存");
      }
      closeReview();
      loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function closeReview() {
    state.reviewDraft = null;
    closeBatchReview();
    $("#review-card").classList.add("hidden");
    if (pendingResults.length) {
      openReview(pendingResults.shift());
    }
  }

  // ---------------- batch review (一图多单) ----------------
  function openBatchReview(res) {
    state.reviewDraft = res;
    $("#review-card").classList.remove("hidden");
    $("#review-img").src = res.image_url;
    $("#review-engine").textContent = "订单列表 · " + (({
      "vision-api": "视觉大模型识别",
      winocr: "Windows 本地 OCR",
      "local-ocr": "本地 OCR（离线）",
    })[res.engine] || res.engine);
    $("#review-raw").textContent = (res.records || [])
      .map((r, i) => "#" + (i + 1) + " " + (r.charge_start || "") + " " + (r.energy_kwh ?? "?") + "度 " + (r.fee_yuan ?? "?") + "元 " + (r.location || ""))
      .join("\n");
    $("#batch-wrap").classList.remove("hidden");
    $("#single-review").classList.add("hidden");

    const tb = $("#batch-table tbody");
    tb.innerHTML = (res.records || [])
      .map((r, i) => {
        const closed = r.status === "已关闭" && !r.energy_kwh && !r.fee_yuan;
        return "<tr data-i=\"" + i + "\" class=\"" + (closed ? "off" : "") + "\">"
          + "<td><input type=\"checkbox\" class=\"row-on\"" + (closed ? "" : " checked") + "></td>"
          + "<td class=\"c-time\"><input data-k=\"charge_start\" value=\"" + esc(r.charge_start) + "\"></td>"
          + "<td class=\"c-num\"><input data-k=\"energy_kwh\" type=\"number\" step=\"0.001\" value=\"" + esc(r.energy_kwh) + "\"></td>"
          + "<td class=\"c-num\"><input data-k=\"fee_yuan\" type=\"number\" step=\"0.01\" value=\"" + esc(r.fee_yuan) + "\"></td>"
          + "<td class=\"c-num\"><input data-k=\"start_soc\" type=\"number\" value=\"" + esc(r.start_soc) + "\"></td>"
          + "<td class=\"c-num\"><input data-k=\"end_soc\" type=\"number\" value=\"" + esc(r.end_soc) + "\"></td>"
          + "<td class=\"c-loc\"><input data-k=\"location\" value=\"" + esc(r.location) + "\"></td>"
          + "<td class=\"c-op\"><input data-k=\"operator\" value=\"" + esc(r.operator) + "\"></td>"
          + "<td class=\"c-st\"><select data-k=\"status\">"
          + ["", "已完成", "已关闭", "已取消"].map(function (s) {
              return "<option value=\"" + s + "\"" + ((r.status || "") === s ? " selected" : "") + ">" + (s || "—") + "</option>";
            }).join("")
          + "</select></td></tr>";
      })
      .join("");
    updateBatchHint();
    $("#review-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeBatchReview() {
    const el = $("#batch-wrap");
    if (el) el.classList.add("hidden");
    const sr = $("#single-review");
    if (sr) sr.classList.remove("hidden");
  }

  function updateBatchHint() {
    const boxes = $$("#batch-table tbody .row-on");
    const on = boxes.filter((c) => c.checked).length;
    $("#batch-hint").textContent = "识别到 " + boxes.length + " 条订单，勾选 " + on + " 条入库（已关闭 0 元的默认不勾）";
  }

  async function saveBatch() {
    const draft = state.reviewDraft;
    if (!draft) return;
    const rows = [];
    $$("#batch-table tbody tr").forEach((tr) => {
      if (!tr.querySelector(".row-on").checked) return;
      const rec = { image_file: draft.image_file, extract_engine: draft.engine, confidence: draft.fields && draft.fields.confidence };
      tr.querySelectorAll("[data-k]").forEach((inp) => {
        const v = (inp.value || "").trim();
        if (v !== "") rec[inp.dataset.k] = v;
      });
      rows.push(rec);
    });
    if (!rows.length) return toast("请至少勾选一条记录", true);
    try {
      const res = await SU7API.batchCreate(rows);
      let msg = "已入库 " + res.saved + " 条";
      if (res.duplicates) msg += "，去重跳过 " + res.duplicates + " 条";
      if (res.skipped) msg += "，无效 " + res.skipped + " 条";
      toast(msg);
      closeReview();
      loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------- edit / delete ----------------
  function openEdit(id) {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    state.editId = id;
    $("#edit-id").textContent = "#" + id;
    fillForm($("#edit-form"), rec, {});
    const box = $("#edit-image");
    if (rec.image_file) {
      box.classList.remove("hidden");
      SU7API.imageUrl(rec.image_file, false).then((u) => {
        if (u) box.querySelector("img").src = u;
      });
    } else {
      box.classList.add("hidden");
    }
    $("#edit-modal").classList.remove("hidden");
  }

  async function saveEdit() {
    try {
      await SU7API.updateRecord(state.editId, readForm($("#edit-form")));
      toast("已更新");
      $("#edit-modal").classList.add("hidden");
      loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function removeRecord(id) {
    if (!confirm("确定删除这条充电记录？截图也会一并删除。")) return;
    try {
      await SU7API.deleteRecord(id);
      toast("已删除");
      loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------- settings ----------------
  async function loadSettings() {
    try {
      const s = await SU7API.getSettings();
      $("#vision-enabled").checked = s.vision_enabled === "1";
      $("#vision-base").value = s.vision_base_url || "";
      $("#vision-key").value = s.vision_api_key || "";
      $("#vision-model").value = s.vision_model || "";
      $("#mode-indicator").textContent = SU7API.isServer()
        ? "服务模式（Windows 本地 OCR + 数据库）"
        : "独立模式（本机存储 + 离线 OCR）";
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function saveSettings() {
    try {
      await SU7API.saveSettings({
        vision_enabled: $("#vision-enabled").checked ? "1" : "0",
        vision_base_url: $("#vision-base").value.trim(),
        vision_api_key: $("#vision-key").value.trim(),
        vision_model: $("#vision-model").value.trim(),
      });
      $("#settings-msg").textContent = "已保存 · " + new Date().toLocaleTimeString();
      toast("设置已保存");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------- CSV export ----------------
  async function exportCSV() {
    try {
      const recs = await SU7API.listRecords();
      const cols = ["id", "charge_start", "charge_end", "duration_min", "start_soc", "end_soc",
        "energy_kwh", "fee_yuan", "elec_fee", "service_fee", "location",
        "operator", "source_type", "status", "note", "extract_engine", "confidence", "image_file"];
      const lines = [cols.join(",")];
      for (const r of recs) {
        lines.push(cols.map((c) => {
          const v = r[c] == null ? "" : String(r[c]);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(","));
      }
      // UTF-8 BOM 便于 Excel 打开
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, "su7-charging.csv");
    } catch (e) {
      toast(e.message, true);
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // ---------------- JSON sync ----------------
  async function exportJSON() {
    try {
      const json = await SU7API.exportJSON();
      downloadBlob(new Blob([json], { type: "application/json" }), `su7-charging-${new Date().toISOString().slice(0, 10)}.json`);
      toast("已导出 JSON，可拷到其他设备导入");
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function importJSON(file) {
    try {
      const text = await file.text();
      const res = await SU7API.importJSON(text);
      let msg = `导入完成：新增 ${res.saved} 条`;
      if (res.duplicates) msg += `，去重跳过 ${res.duplicates} 条`;
      if (res.skipped) msg += `，无效 ${res.skipped} 条`;
      toast(msg);
      loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------- events ----------------
  function bind() {
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $$("[data-goto]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.goto)));

    const dz = $("#dropzone");
    const fi = $("#file-input");
    const cam = $("#camera-input");
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      handleFiles(e.dataTransfer.files);
    });
    fi.addEventListener("change", () => {
      handleFiles(fi.files);
      fi.value = "";
    });
    if (cam) {
      cam.addEventListener("change", () => {
        handleFiles(cam.files);
        cam.value = "";
      });
      const btnCam = $("#btn-camera");
      const btnPick = $("#btn-pick");
      if (btnCam) btnCam.addEventListener("click", () => cam.click());
      if (btnPick) btnPick.addEventListener("click", () => fi.click());
    }

    $("#btn-review-save").addEventListener("click", saveReview);
    $("#btn-batch-save").addEventListener("click", saveBatch);
    $("#batch-all").addEventListener("change", (e) => {
      $$("#batch-table tbody .row-on").forEach((c) => (c.checked = e.target.checked));
      updateBatchHint();
    });
    $("#batch-table").addEventListener("change", (e) => {
      if (e.target.classList.contains("row-on")) {
        e.target.closest("tr").classList.toggle("off", !e.target.checked);
        updateBatchHint();
      }
    });
    $("#btn-review-skip").addEventListener("click", () => {
      closeReview();
      toast("已丢弃本条识别结果");
    });

    ["filter-from", "filter-to"].forEach((id) => $("#" + id).addEventListener("change", loadRecords));
    let t = null;
    $("#filter-q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(loadRecords, 300);
    });
    $("#btn-filter-reset").addEventListener("click", () => {
      $("#filter-from").value = "";
      $("#filter-to").value = "";
      $("#filter-q").value = "";
      loadRecords();
    });

    $("#records-table").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = Number(e.target.closest("tr").dataset.id);
      if (btn.dataset.act === "edit") openEdit(id);
      if (btn.dataset.act === "del") removeRecord(id);
    });

    $("#btn-edit-save").addEventListener("click", saveEdit);
    $("#btn-edit-cancel").addEventListener("click", () => $("#edit-modal").classList.add("hidden"));
    $("#edit-modal").addEventListener("click", (e) => {
      if (e.target.id === "edit-modal") $("#edit-modal").classList.add("hidden");
    });

    $("#btn-save-settings").addEventListener("click", saveSettings);
    $("#btn-export").addEventListener("click", exportCSV);
    $("#btn-export2").addEventListener("click", exportCSV);
    $("#btn-export-json").addEventListener("click", exportJSON);
    $("#import-json-input").addEventListener("change", (e) => {
      if (e.target.files[0]) importJSON(e.target.files[0]);
      e.target.value = "";
    });
    $("#btn-import-json").addEventListener("click", () => $("#import-json-input").click());

    document.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
      if (items.length) {
        handleFiles(items.map((i) => i.getAsFile()).filter(Boolean));
      }
    });
  }

  // ---------------- boot ----------------
  async function boot() {
    bind();
    try {
      await SU7API.init();
    } catch (e) {
      console.warn("init failed", e);
    }
    const badge = $("#mode-badge");
    if (badge) {
      badge.textContent = SU7API.isServer() ? "服务模式" : "独立模式";
      badge.classList.toggle("local", !SU7API.isServer());
    }
    switchTab(location.hash.slice(1) || "dashboard");
    window.addEventListener("hashchange", () => switchTab(location.hash.slice(1) || "dashboard"));
  }

  boot();
})();
