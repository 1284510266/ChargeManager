/* ocr.js — 独立模式识别：tesseract.js 本地离线 OCR + 可选视觉 API */
(function () {
  "use strict";

  let workerPromise = null;

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const T = window.Tesseract;
      const worker = await T.createWorker("chi_sim", 1, {
        workerPath: "/static/tesseract/worker.min.js",
        corePath: "/static/tesseract/tesseract-core-simd.wasm.js",
        langPath: "/static/tessdata",
        gzip: true,
        logger: () => {},
      });
      return worker;
    })();
    return workerPromise;
  }

  /* 与 server.py 的 segment_groups 对应：按水平内容条带聚类成订单卡 */
  function segmentGroups(canvas) {
    const w = canvas.width, h = canvas.height;
    if (h <= 1200) return [];
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, w, h).data;
    const density = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 240) cnt++;
      }
      density[y] = cnt * 2;
    }
    const bands = [];
    let inb = false, s = 0;
    for (let y = 0; y < h; y++) {
      const content = density[y] > 3;
      if (content && !inb) { inb = true; s = y; }
      else if (!content && inb) {
        inb = false;
        if (y - s > 12) bands.push([s, y]);
      }
    }
    if (inb) bands.push([s, h]);
    const groups = [];
    for (const [a, b] of bands) {
      if (groups.length && a - groups[groups.length - 1][1] <= 170) groups[groups.length - 1][1] = b;
      else groups.push([a, b]);
    }
    return groups;
  }

  async function imageToCanvas(fileOrBlob, scale) {
    const bmp = await createImageBitmap(fileOrBlob);
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * (scale || 1));
    cv.height = Math.round(bmp.height * (scale || 1));
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close && bmp.close();
    return cv;
  }

  async function recognizeCanvas(cv) {
    const worker = await getWorker();
    const { data } = await worker.recognize(cv);
    return data.text || "";
  }

  /* 长截图按块 2 倍放大识别；短图整图识别。返回 texts[] + isBlockMode */
  async function ocrImageBlocks(fileOrBlob) {
    const base = await imageToCanvas(fileOrBlob, 1);
    const groups = segmentGroups(base);
    const texts = [];
    if (groups.length >= 2) {
      for (const [top, bottom] of groups) {
        if (bottom - top < 30) continue;
        const pad = 8;
        const y0 = Math.max(0, top - pad);
        const y1 = Math.min(base.height, bottom + pad);
        const crop = document.createElement("canvas");
        crop.width = base.width * 2;
        crop.height = (y1 - y0) * 2;
        const cctx = crop.getContext("2d");
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = "high";
        cctx.drawImage(base, 0, y0, base.width, y1 - y0, 0, 0, crop.width, crop.height);
        texts.push(await recognizeCanvas(crop));
      }
      return { texts, blocked: true };
    }
    const cv2 = await imageToCanvas(fileOrBlob, 2);
    return { texts: [await recognizeCanvas(cv2)], blocked: false };
  }

  /* 视觉 API（OpenAI 兼容），配了 key 才启用 */
  async function visionExtract(fileOrBlob, settings) {
    const base = (settings.vision_base_url || "").trim();
    const key = (settings.vision_api_key || "").trim();
    if (!base || !key) throw new Error("未配置视觉模型 API");
    const model = (settings.vision_model || "").trim() || "gpt-4o-mini";
    let url = base.replace(/\/+$/, "");
    if (!url.endsWith("/chat/completions")) {
      url += url.includes("/v1") ? "/chat/completions" : "/v1/chat/completions";
    }
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result.split(",")[1]);
      fr.onerror = rej;
      fr.readAsDataURL(fileOrBlob);
    });
    const mime = fileOrBlob.type || "image/png";
    const prompt = `你是充电记录识别助手。请识别这张充电截图中的信息，返回严格的 JSON（不要 markdown 代码块，不要多余文字）。
字段如下，识别不到就用 null：
{"charge_start":"YYYY-MM-DD HH:MM","charge_end":"YYYY-MM-DD HH:MM","duration_min":整数分钟,"start_soc":整数百分比,"end_soc":整数百分比,"energy_kwh":充电电量(度),"fee_yuan":总费用(元),"elec_fee":电费(元),"service_fee":服务费(元),"location":充电站/地点,"operator":运营商或充电桩品牌,"source_type":"xiaomi"或"operator","status":"已完成"/"已关闭","note":备注}
注意：费用若明显像丢失小数点（如 3872 元），请换算为 38.72 并在 note 里说明。
若截图是「充电订单列表」（一屏多条记录），请返回 {"records":[{...}, {...}]}（每条同上字段），不要合并。`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`视觉 API ${resp.status}`);
    const body = await resp.json();
    let content = body.choices[0].message.content.trim().replace(/^```(?:json)?|```$/gm, "").trim();
    const jm = content.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error("视觉模型未返回 JSON");
    return JSON.parse(jm[0]);
  }

  function cleanVisionRow(data) {
    const keys = ["charge_start", "charge_end", "duration_min", "start_soc", "end_soc",
      "energy_kwh", "fee_yuan", "elec_fee", "service_fee", "location",
      "operator", "source_type", "status", "note"];
    const f = {};
    for (const k of keys) if (data[k] != null && data[k] !== "" && data[k] !== "null") f[k] = data[k];
    for (const k of ["duration_min", "start_soc", "end_soc"]) {
      if (k in f) { const n = Math.round(Number(f[k])); if (isNaN(n)) delete f[k]; else f[k] = n; }
    }
    for (const k of ["energy_kwh", "fee_yuan", "elec_fee", "service_fee"]) {
      if (k in f) { const n = Number(f[k]); if (isNaN(n)) delete f[k]; else f[k] = Math.round(n * 100) / 100; }
    }
    if (f.charge_start && String(f.charge_start).length > 10) {
      const cs = String(f.charge_start);
      f.charge_start = window.SU7Parser.normDt(cs.slice(0, 10), cs.slice(11, 16) || "00:00");
    }
    if (f.energy_kwh == null && f.fee_yuan == null) return null;
    return f;
  }

  /* 主入口：返回与服务端 /api/extract 同构 {image_file, image_url, mode, records, fields, engine} */
  async function extract(fileOrBlob, filename, settings) {
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
    // 生成缩略图
    const full = await imageToCanvas(fileOrBlob, 1);
    const thumb = document.createElement("canvas");
    const maxW = 480;
    const sc = Math.min(1, maxW / full.width);
    thumb.width = Math.round(full.width * sc);
    thumb.height = Math.round(full.height * sc);
    thumb.getContext("2d").drawImage(full, 0, 0, thumb.width, thumb.height);
    const [blob, thumbBlob] = await Promise.all([
      new Promise((r) => full.toBlob(r, fileOrBlob.type || "image/png")),
      new Promise((r) => thumb.toBlob(r, "image/jpeg", 0.72)),
    ]);
    await window.SU7DB.putImage(name, blob, thumbBlob);
    const imageUrl = URL.createObjectURL(thumbBlob);

    // 1) 视觉 API
    if (settings && settings.vision_enabled === "1" && (settings.vision_api_key || "").trim()) {
      try {
        const data = await visionExtract(fileOrBlob, settings);
        if (Array.isArray(data.records) && data.records.length >= 2) {
          const recs = data.records.map(cleanVisionRow).filter(Boolean).map((r) => ({
            ...r, image_file: name, extract_engine: "vision-api", confidence: 0.95,
          }));
          return { image_file: name, image_url: imageUrl, mode: "list", records: recs, fields: recs[0], engine: "vision-api" };
        }
        const f = cleanVisionRow(data);
        if (f) {
          f.image_file = name; f.extract_engine = "vision-api"; f.confidence = 0.95;
          return { image_file: name, image_url: imageUrl, mode: "single", records: [f], fields: f, engine: "vision-api" };
        }
      } catch (e) {
        console.warn("vision api failed, fallback to local ocr:", e);
      }
    }

    // 2) tesseract.js 本地识别
    const { texts, blocked } = await ocrImageBlocks(fileOrBlob);
    const recs = [];
    for (const text of texts) {
      const item = window.SU7Parser.parseListGroup(text);
      if (item) {
        recs.push({ ...item, raw_text: text, extract_engine: "local-ocr", confidence: blocked ? 0.85 : 0.8, image_file: name });
      }
    }
    if (recs.length >= 2) {
      return { image_file: name, image_url: imageUrl, mode: "list", records: recs, fields: recs[0], engine: "local-ocr" };
    }
    if (recs.length === 1 && blocked) {
      const fullText = texts.join("\n");
      const { fields, conf } = window.SU7Parser.parseFields(fullText);
      if (fields.energy_kwh || fields.fee_yuan) {
        const vals = Object.values(conf);
        fields.extract_engine = "local-ocr";
        fields.confidence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.7;
        fields.image_file = name;
        fields.raw_text = fullText;
        return { image_file: name, image_url: imageUrl, mode: "single", records: [fields], fields, engine: "local-ocr" };
      }
      recs[0].confidence = recs[0].confidence || 0.7;
      return { image_file: name, image_url: imageUrl, mode: "single", records: recs, fields: recs[0], engine: "local-ocr" };
    }
    if (recs.length) {
      return { image_file: name, image_url: imageUrl, mode: "single", records: recs, fields: recs[0], engine: "local-ocr" };
    }
    const fullText = texts[0] || "";
    const { fields, conf } = window.SU7Parser.parseFields(fullText);
    const vals = Object.values(conf);
    fields.extract_engine = "local-ocr";
    fields.confidence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.7;
    fields.image_file = name;
    fields.raw_text = fullText;
    return { image_file: name, image_url: imageUrl, mode: "single", records: [fields], fields, engine: "local-ocr" };
  }

  window.SU7OCR = { extract };
})();
