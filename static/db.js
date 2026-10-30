/* db.js — 独立模式本地存储（IndexedDB），与服务端 records 表同构 */
(function () {
  "use strict";

  const DB_NAME = "su7-charging";
  const DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("records")) {
          const st = db.createObjectStore("records", { keyPath: "id", autoIncrement: true });
          st.createIndex("charge_start", "charge_start");
        }
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images"); // key: image_file -> {blob, thumb}
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv"); // key -> value (settings)
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, mode);
          const s = t.objectStore(store);
          const out = fn(s);
          t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
          t.onerror = () => reject(t.error);
        })
    );
  }

  const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  function dupKey(f) {
    const e = Math.round((f.energy_kwh || 0) * 100) / 100;
    const fee = Math.round((f.fee_yuan || 0) * 100) / 100;
    const cs = (f.charge_start || "").trim();
    if (cs) return `t|${cs}|${e}|${fee}`;
    return `l|${e}|${fee}|${(f.location || "").trim()}`;
  }

  const DB = {
    async list(q = {}) {
      let rows = await tx("records", "readonly", (s) => s.getAll());
      rows = rows.map((r) => ({ ...r }));
      if (q.from) rows = rows.filter((r) => (r.charge_start || "").slice(0, 10) >= q.from);
      if (q.to) rows = rows.filter((r) => (r.charge_start || "").slice(0, 10) <= q.to);
      if (q.q) {
        const needle = String(q.q).toLowerCase();
        rows = rows.filter((r) =>
          [r.location, r.operator, r.note].some((x) => (x || "").toLowerCase().includes(needle))
        );
      }
      rows.sort((a, b) => (b.charge_start || "").localeCompare(a.charge_start || "") || b.id - a.id);
      return rows;
    },

    async get(id) {
      return tx("records", "readonly", (s) => s.get(Number(id)));
    },

    async create(f) {
      const all = await tx("records", "readonly", (s) => s.getAll());
      const key = dupKey(f);
      const dup = all.find((r) => dupKey(r) === key);
      if (dup) return { record: dup, duplicate: true, dup_id: dup.id };
      const rec = {
        ...f,
        created_at: nowIso(),
        energy_kwh: f.energy_kwh != null ? Math.round(f.energy_kwh * 1000) / 1000 : null,
        fee_yuan: f.fee_yuan != null ? Math.round(f.fee_yuan * 100) / 100 : null,
        confidence: f.confidence != null ? f.confidence : 1.0,
      };
      const id = await tx("records", "readwrite", (s) => s.add(rec));
      return { record: { ...rec, id }, duplicate: false };
    },

    async batch(rows) {
      const all = await tx("records", "readonly", (s) => s.getAll());
      const existing = new Set(all.map((r) => dupKey(r)));
      const saved = [], duplicates = [];
      let skipped = 0;
      for (const f of rows) {
        if (!f.energy_kwh && !f.fee_yuan) { skipped++; continue; }
        const key = dupKey(f);
        if (existing.has(key)) { duplicates.push({ key }); continue; }
        existing.add(key);
        const rec = {
          ...f,
          created_at: nowIso(),
          energy_kwh: f.energy_kwh != null ? Math.round(f.energy_kwh * 1000) / 1000 : null,
          fee_yuan: f.fee_yuan != null ? Math.round(f.fee_yuan * 100) / 100 : null,
          confidence: f.confidence != null ? f.confidence : 1.0,
        };
        const id = await tx("records", "readwrite", (s) => s.add(rec));
        saved.push(id);
      }
      return { saved: saved.length, ids: saved, skipped, duplicates: duplicates.length, dup_detail: duplicates };
    },

    async update(id, patch) {
      const rec = await tx("records", "readonly", (s) => s.get(Number(id)));
      if (!rec) throw new Error("记录不存在");
      const merged = { ...rec, ...patch, id: rec.id };
      if (patch.energy_kwh !== undefined && patch.energy_kwh !== null)
        merged.energy_kwh = Math.round(Number(patch.energy_kwh) * 1000) / 1000;
      if (patch.fee_yuan !== undefined && patch.fee_yuan !== null)
        merged.fee_yuan = Math.round(Number(patch.fee_yuan) * 100) / 100;
      await tx("records", "readwrite", (s) => s.put(merged));
      return merged;
    },

    async remove(id) {
      const rec = await tx("records", "readonly", (s) => s.get(Number(id)));
      await tx("records", "readwrite", (s) => s.delete(Number(id)));
      if (rec && rec.image_file) await tx("images", "readwrite", (s) => s.delete(rec.image_file));
    },

    // ---- images ----
    async putImage(name, blob, thumbBlob) {
      await tx("images", "readwrite", (s) => s.put({ blob, thumb: thumbBlob }, name));
      return name;
    },
    async getImage(name, wantThumb) {
      const row = await tx("images", "readonly", (s) => s.get(name));
      if (!row) return null;
      return wantThumb ? row.thumb || row.blob : row.blob;
    },
    async deleteImage(name) {
      await tx("images", "readwrite", (s) => s.delete(name));
    },

    // ---- settings kv ----
    async kvGet(key, dflt = "") {
      const v = await tx("kv", "readonly", (s) => s.get(key));
      return v === undefined ? dflt : v;
    },
    async kvSet(key, value) {
      await tx("kv", "readwrite", (s) => s.put(value, key));
    },
  };

  window.SU7DB = DB;
})();
