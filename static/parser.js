/* parser.js — OCR 文本解析（与 server.py 的 normalize_ocr / parse_fields / parse_list_group 对齐） */
(function () {
  "use strict";

  const FW_MAP = {
    "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5",
    "６": "6", "７": "7", "８": "8", "９": "9", "．": ".", "％": "%",
    "：": ":", "－": "-", "／": "/", "，": ",", "（": "(", "）": ")",
    "・": "·",
  };

  function toHalf(s) {
    return s.replace(/[０-９．％：－／，（）・]/g, (c) => FW_MAP[c] || c);
  }

  function normalizeOcr(text) {
    if (!text) return "";
    let t = toHalf(text).replace(/ /g, " ");
    t = t.replace(/(\d)\s*[.．·∙‧•]\s*(\d)/g, "$1.$2");
    t = t.replace(/(?<!\d)(\d)\s+(\d)(?!\d)/g, "$1$2");
    t = t.replace(/(\d{4})\s*[-—一]\s*(\d{1,2})\s*[-—一]\s*(\d{1,2})/g, "$1-$2-$3");
    t = t.replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2");
    t = t.replace(/([一-鿿])\s+(?=[一-鿿])/g, "$1");
    t = t.replace(/([一-鿿])\s+(?=[0-9A-Za-z%¥.])/g, "$1");
    t = t.replace(/([0-9A-Za-z%¥.])\s+(?=[一-鿿])/g, "$1");
    t = t.replace(/\s{2,}/g, " ");
    return t.trim();
  }

  function normDt(datePart, timePart) {
    if (!datePart) datePart = new Date().toISOString().slice(0, 10);
    let d = datePart.replace(/\//g, "-").replace(/[年月]/g, "-").replace(/日/g, "");
    const parts = d.split("-").filter(Boolean);
    if (parts.length === 3) {
      d = `${String(+parts[0]).padStart(4, "0")}-${String(+parts[1]).padStart(2, "0")}-${String(+parts[2]).padStart(2, "0")}`;
    }
    const hm = (timePart || "00:00").replace(/：/g, ":").split(":");
    return `${d} ${String(+hm[0]).padStart(2, "0")}:${(hm[1] || "00").slice(0, 2)}`;
  }

  function diffMin(start, end) {
    if (!start || !end) return null;
    const s = new Date(start.replace(" ", "T"));
    const e = new Date(end.replace(" ", "T"));
    if (isNaN(s) || isNaN(e)) return null;
    let delta = (e - s) / 60000;
    if (delta < 0) delta += 24 * 60;
    return Math.round(delta);
  }

  const OPS = ["星星充电", "特来电", "国家电网", "小桔充电", "云快充", "万城万充", "蔚景云",
    "特斯拉", "蔚来", "小鹏", "开迈斯", "依威能源", "深圳车电网", "汇充电", "广汽"];

  const LOC_JUNK = /分钟|时长|时间|电量|费用|金额|订单|详情|实付|支付|开始|结束|充电量|kWh|kwh|元|%/;

  function parseLocation(t) {
    let cands = [];
    const re1 = /([一-鿿A-Za-z]{2,14}(?:充电站|充电中心|快充站|换电站))/g;
    let m;
    while ((m = re1.exec(t))) cands.push(m[1]);
    if (!cands.length) {
      const re2 = /([一-鿿A-Za-z]{2,10}站)/g;
      while ((m = re2.exec(t))) cands.push(m[1]);
    }
    for (let cand of cands) {
      const parts = cand.split(new RegExp(LOC_JUNK.source, "g"));
      cand = parts[parts.length - 1] || cand;
      for (const op of OPS) {
        if (cand.startsWith(op) && cand.length > op.length) { cand = cand.slice(op.length); break; }
      }
      cand = cand.replace(/^[\s·・…\-—:：]+|[\s·・…\-—:：]+$/g, "");
      if (cand.length >= 2 && cand.length <= 16 && !LOC_JUNK.test(cand)) return cand;
    }
    return null;
  }

  function parseFields(text) {
    const t = normalizeOcr(text);
    const fields = { raw_text: text || "" };
    const conf = {};
    let m;

    m = t.match(/(?:充电电量|充电量|充电度数|本次用电|本次充电|电量|用电量)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(kWh|kwh|KWH|度)/);
    if (m) { fields.energy_kwh = +m[1]; conf.energy_kwh = 0.9; }
    else {
      m = t.match(/(\d+(?:\.\d+)?)\s*(kWh|kwh|KWH)/);
      if (m) { fields.energy_kwh = +m[1]; conf.energy_kwh = 0.5; }
    }

    m = t.match(/(?:充电电费|电[费贳])(?!用)[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?/);
    if (m) { fields.elec_fee = +m[1]; conf.elec_fee = 0.85; }
    m = t.match(/(?:充电服务费|服务[费贳])[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?/);
    if (m) { fields.service_fee = +m[1]; conf.service_fee = 0.85; }

    m = t.match(/(?:充电费用|消费金额|实付|支付金额|订单金额|合计|总费用|费用|金额|应付)[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?/);
    if (m) {
      fields.fee_yuan = +m[1];
      conf.fee_yuan = (+m[1] >= 1000 && !m[1].includes(".")) ? 0.4 : 0.9;
    } else {
      m = t.match(/[¥￥](\d+(?:\.\d+)?)/);
      if (m) { fields.fee_yuan = +m[1]; conf.fee_yuan = 0.5; }
    }
    if (fields.fee_yuan == null && fields.elec_fee != null) {
      fields.fee_yuan = Math.round((fields.elec_fee + (fields.service_fee || 0)) * 100) / 100;
      conf.fee_yuan = 0.5;
    }

    m = t.match(/(?:开始电量|起始电量|起始soc|开始soc|初始电量|开始)[^0-9]{0,4}(\d{1,3})\s*%/i);
    if (m && +m[1] <= 100) { fields.start_soc = +m[1]; conf.start_soc = 0.9; }
    m = t.match(/(?:结束电量|终止电量|结束soc|终止soc|结束时电量|结束)[^0-9]{0,4}(\d{1,3})\s*%/i);
    if (m && +m[1] <= 100) { fields.end_soc = +m[1]; conf.end_soc = 0.9; }
    if (fields.start_soc == null || fields.end_soc == null) {
      const socs = [...t.matchAll(/(\d{1,3})\s*%/g)].map((x) => +x[1]).filter((v) => v <= 100);
      if (socs.length >= 2 && fields.start_soc == null) {
        fields.start_soc = Math.min(socs[0], socs[socs.length - 1]);
        fields.end_soc = Math.max(socs[0], socs[socs.length - 1]);
        conf.start_soc = conf.end_soc = 0.4;
      }
    }

    const dtRe = /(\d{4}-\d{1,2}-\d{1,2})\s*(\d{1,2}:\d{2})/g;
    const dts = [...t.matchAll(dtRe)];
    if (dts.length >= 2) {
      fields.charge_start = normDt(dts[0][1], dts[0][2]);
      fields.charge_end = normDt(dts[1][1], dts[1][2]);
      conf.charge_start = conf.charge_end = 0.85;
    } else if (dts.length === 1) {
      fields.charge_start = normDt(dts[0][1], dts[0][2]);
      conf.charge_start = 0.6;
    }
    if (!fields.charge_start) {
      m = t.match(/(?:开始时间|充电开始)[^0-9]{0,4}(\d{4}-\d{1,2}-\d{1,2})?\s*(\d{1,2}:\d{2})/);
      if (m) { fields.charge_start = normDt(m[1], m[2]); conf.charge_start = 0.8; }
    }
    if (!fields.charge_end) {
      m = t.match(/(?:结束时间|充电结束|结束)[^0-9]{0,4}(\d{4}-\d{1,2}-\d{1,2})?\s*(\d{1,2}:\d{2})/);
      if (m) { fields.charge_end = normDt(m[1], m[2]); conf.charge_end = 0.8; }
    }
    if (!fields.charge_start) {
      m = t.match(/(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})/);
      if (m) {
        const day = new Date().toISOString().slice(0, 10);
        fields.charge_start = `${day} ${m[1]}`;
        fields.charge_end = `${day} ${m[2]}`;
        conf.charge_start = conf.charge_end = 0.4;
      }
    }

    m = t.match(/(?:充电时长|时长|历时)[^0-9]{0,4}(\d+)\s*小时\s*(\d+)?\s*分?/);
    if (m) { fields.duration_min = +m[1] * 60 + +(m[2] || 0); conf.duration_min = 0.9; }
    else {
      m = t.match(/(?:充电时长|时长|历时)[^0-9]{0,4}(\d+)\s*分(?:钟)?/);
      if (m) { fields.duration_min = +m[1]; conf.duration_min = 0.9; }
    }
    if (fields.duration_min == null) {
      const d = diffMin(fields.charge_start, fields.charge_end);
      if (d != null) { fields.duration_min = d; conf.duration_min = 0.5; }
    }

    for (const op of OPS) {
      if (t.includes(op)) { fields.operator = op; conf.operator = 0.8; break; }
    }
    const loc = parseLocation(t);
    if (loc) { fields.location = loc; conf.location = 0.7; }

    if (/小米|su7|XIAOMI/i.test(t)) fields.source_type = "xiaomi";
    else if (fields.operator) fields.source_type = "operator";
    else fields.source_type = "mixed";
    conf.source_type = 0.5;

    return { fields, conf };
  }

  const LIST_JUNK = /已完成|已关闭|已取消|预约订单|充电订单|充电中|¥|￥/g;

  function parseListGroup(text) {
    const t = normalizeOcr(text);
    if (!t) return null;
    const item = {};
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*度/))) item.energy_kwh = +m[1];
    if ((m = t.match(/(\d{4}-\d{2}-\d{2})\s*(\d{1,2}:\d{2}(?::\d{2})?)/))) {
      item.charge_start = normDt(m[1], m[2]);
    }
    if ((m = t.match(/[¥￥]?\s*(\d+(?:\.\d+)?)\s*元/))) item.fee_yuan = +m[1];
    if (/已关闭/.test(t)) item.status = "已关闭";
    else if (/已完成/.test(t)) item.status = "已完成";
    else if (/已取消/.test(t)) item.status = "已取消";

    const km = t.match(/(\d+(?:\.\d+)?)\s*度/);
    if (km) {
      let head = t.slice(0, km.index).replace(LIST_JUNK, " ");
      head = head.split(/[。；;|]/).pop() || "";
      head = head.replace(/^[\s·・…\-—]+|[\s·・…\-—]+$/g, "");
      const names = head.match(/[一-鿿A-Za-z0-9·]{2,24}/g);
      if (names) {
        let cand = names[names.length - 1].replace(/·+$/g, "");
        for (const op of OPS) {
          if (cand.startsWith(op)) { item.operator = op; break; }
        }
        item.location = cand;
      }
    }
    if (item.energy_kwh == null) return null; // 列表行必有「X 度」；详情页交还 parseFields
    return item;
  }

  window.SU7Parser = { normalizeOcr, parseFields, parseListGroup, normDt };
})();
