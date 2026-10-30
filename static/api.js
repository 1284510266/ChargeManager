/* api.js — 统一数据层：服务模式（/api/*）与独立模式（IndexedDB + 本地 OCR）自动切换 */
(function () {
  "use strict";

  let mode = null; // 'server' | 'local'
  let settingsCache = null;

  async function detect() {
    if (mode) return mode;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch("/api/records", { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        await r.json();
        mode = "server";
        return mode;
      }
    } catch (e) { /* fallthrough */ }
    mode = "local";
    return mode;
  }

  async function req(path, payload, method) {
    const r = await fetch(path, {
      method: method || (payload ? "POST" : "GET"),
      headers: { "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!r.ok) throw new Error((data && data.error) || `请求失败 ${r.status}`);
    return data;
  }

  // ---- settings ----
  const localSettingsKeys = ["vision_enabled", "vision_base_url", "vision_api_key", "vision_model"];

  async function getSettings() {
    if (settingsCache) return settingsCache;
    if (mode === "server") {
      settingsCache = await req("/api/settings");
    } else {
      settingsCache = {};
      for (const k of localSettingsKeys) settingsCache[k] = await window.SU7DB.kvGet(k, "");
    }
    return settingsCache;
  }

  async function saveSettings(patch) {
    if (mode === "server") {
      await req("/api/settings", patch);
    } else {
      for (const [k, v] of Object.entries(patch)) await window.SU7DB.kvSet(k, String(v));
    }
    settingsCache = { ...settingsCache, ...patch };
    return settingsCache;
  }

  // ---- records ----
  const api = {
    async init() { await detect(); await getSettings(); return mode; },
    get mode() { return mode; },
    isServer() { return mode === "server"; },

    async listRecords(q = {}) {
      if (mode === "server") {
        const p = new URLSearchParams();
        if (q.from) p.set("from", q.from);
        if (q.to) p.set("to", q.to);
        if (q.q) p.set("q", q.q);
        return (await req("/api/records?" + p)).records;
      }
      return window.SU7DB.list(q);
    },

    async createRecord(body) {
      return mode === "server" ? req("/api/records", body) : window.SU7DB.create(body);
    },

    async batchCreate(records) {
      return mode === "server"
        ? req("/api/records/batch", { records })
        : window.SU7DB.batch(records);
    },

    async updateRecord(id, patch) {
      if (mode === "server") return req("/api/records/" + id, patch, "PUT");
      return { record: await window.SU7DB.update(id, patch) };
    },

    async deleteRecord(id) {
      return mode === "server" ? req("/api/records/" + id, null, "DELETE") : window.SU7DB.remove(id);
    },

    async extract(fileOrBlob, filename) {
      if (mode === "server") {
        const b64 = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result.split(",")[1]);
          fr.onerror = rej;
          fr.readAsDataURL(fileOrBlob);
        });
        return req("/api/extract", { image_base64: b64, filename, mime: fileOrBlob.type || "image/png" });
      }
      return window.SU7OCR.extract(fileOrBlob, filename, await getSettings());
    },

    /* 图片访问：server 走 /images/，local 走 IndexedDB object URL */
    async imageUrl(imageFile, thumb) {
      if (!imageFile) return "";
      if (mode === "server") return "/images/" + imageFile;
      const blob = await window.SU7DB.getImage(imageFile, thumb !== false);
      return blob ? URL.createObjectURL(blob) : "";
    },

    getSettings,
    saveSettings,

    // ---- stats（双模式共用同一实现） ----
    async stats() {
      const recs = await api.listRecords();
      return computeStats(recs);
    },

    // ---- JSON 同步 ----
    async exportJSON() {
      const recs = await api.listRecords();
      const out = {
        app: "su7-charging",
        version: 1,
        exported_at: new Date().toISOString(),
        records: recs.map((r) => {
          const c = { ...r };
          delete c.id;
          return c;
        }),
      };
      return JSON.stringify(out, null, 2);
    },

    async importJSON(json, onProgress) {
      let data;
      try { data = typeof json === "string" ? JSON.parse(json) : json; } catch {
        throw new Error("JSON 格式无效");
      }
      const rows = Array.isArray(data) ? data : data.records;
      if (!Array.isArray(rows)) throw new Error("缺少 records 数组");
      const cleaned = rows.map((r) => {
        const c = { ...r };
        delete c.id;
        return c;
      });
      const res = await api.batchCreate(cleaned);
      if (onProgress) onProgress(res);
      return res;
    },
  };

  /* 与 server.py compute_stats 对齐 */
  function computeStats(recs) {
    const totalKwh = round2(recs.reduce((a, r) => a + (r.energy_kwh || 0), 0));
    const totalFee = round2(recs.reduce((a, r) => a + (r.fee_yuan || 0), 0));
    const totalMin = recs.reduce((a, r) => a + (r.duration_min || 0), 0);
    const n = recs.length;
    const avgPrice = totalKwh ? round2(totalFee / totalKwh) : null;

    const months = {};
    const hours = Array.from({ length: 24 }, () => 0);
    const priceTrend = [];
    const locEnergy = {};
    const socPoints = [];

    for (const r of recs) {
      const cs = r.charge_start || "";
      if (cs.length >= 7) {
        const key = cs.slice(0, 7);
        const m = months[key] || (months[key] = { month: key, kwh: 0, fee: 0, count: 0 });
        m.kwh += r.energy_kwh || 0;
        m.fee += r.fee_yuan || 0;
        m.count++;
      }
      if (cs.length >= 13) {
        const hh = parseInt(cs.slice(11, 13), 10);
        if (!isNaN(hh) && hh >= 0 && hh < 24) hours[hh] += r.energy_kwh || 0;
      }
      if (r.energy_kwh && r.fee_yuan != null && r.energy_kwh > 0) {
        priceTrend.push({ date: cs.slice(0, 10), price: round2(r.fee_yuan / r.energy_kwh), kwh: r.energy_kwh });
      }
      const loc = r.location || r.operator || "未知";
      locEnergy[loc] = round2((locEnergy[loc] || 0) + (r.energy_kwh || 0));
      if (r.start_soc != null && r.end_soc != null) socPoints.push({ start: r.start_soc, end: r.end_soc, kwh: r.energy_kwh });
    }

    const monthly = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
    monthly.forEach((m) => { m.kwh = round2(m.kwh); m.fee = round2(m.fee); });

    return {
      summary: {
        count: n,
        total_kwh: totalKwh,
        total_fee: totalFee,
        total_hours: round1(totalMin / 60),
        avg_kwh: n ? round2(totalKwh / n) : 0,
        avg_price: avgPrice,
        avg_duration_min: n ? Math.round(totalMin / n) : 0,
      },
      monthly,
      hourly: hours.map((v, h) => ({ hour: h, kwh: round2(v) })),
      price_trend: priceTrend,
      top_locations: Object.entries(locEnergy)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([location, kwh]) => ({ location, kwh })),
      soc_points: socPoints.slice(-60),
      recent: recs.slice(0, 8),
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round1(v) { return Math.round(v * 10) / 10; }

  window.SU7API = api;
})();
