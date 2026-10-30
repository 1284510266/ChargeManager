#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SU7 充电账本 — 本地网页应用（纯标准库）。

用法:
    python server.py [port]
浏览器打开 http://127.0.0.1:8765/
"""
import base64
import csv
import io
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
SHOTS_DIR = DATA_DIR / "screenshots"
STATIC_DIR = BASE / "static"
DB_PATH = DATA_DIR / "charging.db"
OCR_PS1 = BASE / "ocr.ps1"
HOST = "0.0.0.0"  # 局域网监听：手机同 Wi-Fi 也能访问，用本机 IP:端口

DATA_DIR.mkdir(exist_ok=True)
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

DB_LOCK = threading.Lock()

# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source_type TEXT DEFAULT 'manual',
    charge_start TEXT,
    charge_end TEXT,
    duration_min INTEGER,
    start_soc INTEGER,
    end_soc INTEGER,
    energy_kwh REAL,
    fee_yuan REAL,
    elec_fee REAL,
    service_fee REAL,
    location TEXT,
    operator TEXT,
    note TEXT,
    image_file TEXT,
    raw_text TEXT,
    extract_engine TEXT,
    confidence REAL DEFAULT 1.0
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with DB_LOCK, db() as conn:
        conn.executescript(SCHEMA)
        try:
            conn.execute("ALTER TABLE records ADD COLUMN status TEXT")
        except sqlite3.OperationalError:
            pass


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- helpers

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_setting(key, default=""):
    with DB_LOCK, db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with DB_LOCK, db() as conn:
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def guess_mime(filename):
    mime, _ = mimetypes.guess_type(filename)
    return mime or "image/png"


def save_image(image_bytes, filename):
    ext = Path(filename or "shot.png").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        ext = ".png"
    name = f"{int(time.time() * 1000)}_{os.urandom(3).hex()}{ext}"
    (SHOTS_DIR / name).write_bytes(image_bytes)
    return name


# ---------------------------------------------------------------- OCR text parsing

_FW = str.maketrans(
    "０１２３４５６７８９．％：－／，（）",
    "0123456789.%:-/,()",
)


def normalize_ocr(text):
    """折叠 OCR 输出中的噪声：全角、CJK 之间空格、日期连字符误识别等。"""
    if not text:
        return ""
    t = text.translate(_FW)
    t = t.replace(" ", " ")
    # 数字间的小数点被识别成空格/全角点
    t = re.sub(r"(\d)\s*[\.\．·∙‧・•]\s*(\d)", r"\1.\2", t)
    # OCR 常把一个数字拆成 "1 2"；仅合并孤立单数字对，避免把 "01 0 元" 合成 "010"
    t = re.sub(r"(?<!\d)(\d)\s+(\d)(?!\d)", r"\1\2", t)
    # OCR 常把连字符读成汉字“一”
    t = re.sub(r"(\d{4})\s*[-—一]\s*(\d{1,2})\s*[-—一]\s*(\d{1,2})", r"\1-\2-\3", t)
    t = re.sub(r"(\d{1,2})\s*[:：]\s*(\d{2})", r"\1:\2", t)
    # CJK 字符之间的空格
    t = re.sub(r"(?<=[一-鿿])\s+(?=[一-鿿])", "", t)
    t = re.sub(r"(?<=[一-鿿])\s+(?=[0-9A-Za-z%¥.])", "", t)
    t = re.sub(r"(?<=[0-9A-Za-z%¥.])\s+(?=[一-鿿])", "", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _find(pattern, text, group=1):
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(group) if m else None



_LOC_JUNK = r"分钟|时长|时间|电量|费用|金额|订单|详情|实付|支付|开始|结束|充电量|kWh|kwh|元|%"


def _parse_location(t, ops):
    """从归一化文本中尽力提取充电站/地点名。"""
    cands = []
    for m in re.finditer(r"([一-鿿A-Za-z]{2,14}(?:充电站|充电中心|快充站|换电站))", t):
        cands.append(m.group(1))
    if not cands:
        for m in re.finditer(r"([一-鿿A-Za-z]{2,10}站)", t):
            cands.append(m.group(1))
    for cand in cands:
        # 站名前往往粘着 “开始时间/时长” 等杂质，取最后一个杂质词之后的部分
        parts = re.split(_LOC_JUNK, cand)
        cand = parts[-1] if parts else cand
        for op in ops:
            if cand.startswith(op) and len(cand) > len(op):
                cand = cand[len(op):]
                break
        cand = cand.strip(" ·・-—:")
        if 2 <= len(cand) <= 16 and not re.search(_LOC_JUNK, cand):
            return cand
    return None


def parse_fields(text):
    """从 OCR 文本抽取充电字段，返回 (fields, confidence_map)。"""
    t = normalize_ocr(text)
    fields = {}
    conf = {}

    # 电量 kWh / 度
    m = re.search(
        r"(?:充电电量|充电量|充电度数|本次用电|本次充电|电量|用电量)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(kWh|kwh|KWH|度)",
        t,
    )
    if m:
        fields["energy_kwh"] = _num(m.group(1))
        conf["energy_kwh"] = 0.9
    else:
        m = re.search(r"(\d+(?:\.\d+)?)\s*(kWh|kwh|KWH)", t)
        if m:
            fields["energy_kwh"] = _num(m.group(1))
            conf["energy_kwh"] = 0.5

    # 电费 / 服务费 / 总费用（“电费用”属于“充电费用”，不算电费；“贳”是 OCR 常见误识）
    m = re.search(r"(?:充电电费|电[费贳])(?!用)[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?", t)
    if m:
        fields["elec_fee"] = _num(m.group(1))
        conf["elec_fee"] = 0.85
    m = re.search(r"(?:充电服务费|服务[费贳])[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?", t)
    if m:
        fields["service_fee"] = _num(m.group(1))
        conf["service_fee"] = 0.85

    m = re.search(
        r"(?:充电费用|消费金额|实付|支付金额|订单金额|合计|总费用|费用|金额|应付)[^0-9¥]{0,6}[¥￥]?(\d+(?:\.\d+)?)\s*元?",
        t,
    )
    if m:
        val = _num(m.group(1))
        fields["fee_yuan"] = val
        conf["fee_yuan"] = 0.9
        # OCR 可能丢失小数点（如 38.72 → 3872）
        if val is not None and val >= 1000 and "." not in m.group(1):
            conf["fee_yuan"] = 0.4
    else:
        m = re.search(r"[¥￥](\d+(?:\.\d+)?)", t)
        if m:
            fields["fee_yuan"] = _num(m.group(1))
            conf["fee_yuan"] = 0.5

    if fields.get("fee_yuan") is None:
        e, s = fields.get("elec_fee"), fields.get("service_fee")
        if e is not None:
            fields["fee_yuan"] = round(e + (s or 0), 2)
            conf["fee_yuan"] = 0.5

    # SOC
    m = re.search(r"(?:开始电量|起始电量|起始soc|开始soc|初始电量|开始)[^0-9]{0,4}(\d{1,3})\s*%", t, re.I)
    if m and int(m.group(1)) <= 100:
        fields["start_soc"] = int(m.group(1))
        conf["start_soc"] = 0.9
    m = re.search(r"(?:结束电量|终止电量|结束soc|终止soc|结束时电量|结束)[^0-9]{0,4}(\d{1,3})\s*%", t, re.I)
    if m and int(m.group(1)) <= 100:
        fields["end_soc"] = int(m.group(1))
        conf["end_soc"] = 0.9
    if "start_soc" not in fields or "end_soc" not in fields:
        socs = [int(x) for x in re.findall(r"(\d{1,3})\s*%", t) if int(x) <= 100]
        if len(socs) >= 2 and "start_soc" not in fields:
            fields["start_soc"] = min(socs[0], socs[-1])
            conf["start_soc"] = 0.4
            fields["end_soc"] = max(socs[0], socs[-1])
            conf["end_soc"] = 0.4

    # 时间
    dt_re = r"(\d{4}-\d{1,2}-\d{1,2})\s*(\d{1,2}:\d{2})"
    dts = re.findall(dt_re, t)
    if len(dts) >= 2:
        fields["charge_start"] = _norm_dt(dts[0][0], dts[0][1])
        fields["charge_end"] = _norm_dt(dts[1][0], dts[1][1])
        conf["charge_start"] = conf["charge_end"] = 0.85
    elif len(dts) == 1:
        fields["charge_start"] = _norm_dt(dts[0][0], dts[0][1])
        conf["charge_start"] = 0.6

    if "charge_start" not in fields:
        m = re.search(
            r"(?:开始时间|充电开始)[^0-9]{0,4}(\d{4}-\d{1,2}-\d{1,2})?\s*(\d{1,2}:\d{2})", t
        )
        if m:
            fields["charge_start"] = _norm_dt(m.group(1), m.group(2))
            conf["charge_start"] = 0.8
    if "charge_end" not in fields:
        m = re.search(
            r"(?:结束时间|充电结束|结束)[^0-9]{0,4}(\d{4}-\d{1,2}-\d{1,2})?\s*(\d{1,2}:\d{2})", t
        )
        if m:
            fields["charge_end"] = _norm_dt(m.group(1), m.group(2))
            conf["charge_end"] = 0.8

    # 只有时分区间 22:15 - 00:47
    if "charge_start" not in fields:
        m = re.search(r"(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})", t)
        if m:
            day = datetime.now().strftime("%Y-%m-%d")
            fields["charge_start"] = f"{day} {m.group(1)}"
            fields["charge_end"] = f"{day} {m.group(2)}"
            conf["charge_start"] = conf["charge_end"] = 0.4

    # 时长
    m = re.search(r"(?:充电时长|时长|历时)[^0-9]{0,4}(\d+)\s*小时\s*(\d+)?\s*分?", t)
    if m:
        fields["duration_min"] = int(m.group(1)) * 60 + int(m.group(2) or 0)
        conf["duration_min"] = 0.9
    else:
        m = re.search(r"(?:充电时长|时长|历时)[^0-9]{0,4}(\d+)\s*分(?:钟|钟)?", t)
        if m:
            fields["duration_min"] = int(m.group(1))
            conf["duration_min"] = 0.9
    if fields.get("duration_min") is None:
        dur = _diff_min(fields.get("charge_start"), fields.get("charge_end"))
        if dur is not None:
            fields["duration_min"] = dur
            conf["duration_min"] = 0.5

    # 运营商 / 场站
    ops = ["星星充电", "特来电", "国家电网", "小桔充电", "云快充", "万城万充", "蔚景云",
           "特斯拉", "蔚来", "小鹏", "开迈斯", "依威能源", "深圳车电网", "汇充电", "广汽"]
    for op in ops:
        if op in t:
            fields["operator"] = op
            conf["operator"] = 0.8
            break

    loc = _parse_location(t, ops)
    if loc:
        fields["location"] = loc
        conf["location"] = 0.7

    # 来源类型
    if re.search(r"小米|su7|XIAOMI", t, re.I):
        fields["source_type"] = "xiaomi"
    elif fields.get("operator"):
        fields["source_type"] = "operator"
    else:
        fields["source_type"] = "mixed"
    conf["source_type"] = 0.5

    fields["raw_text"] = text
    return fields, conf


def _norm_dt(date_part, time_part):
    if not date_part:
        date_part = datetime.now().strftime("%Y-%m-%d")
    d = date_part.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    parts = d.split("-")
    if len(parts) == 3:
        d = f"{int(parts[0]):04d}-{int(parts[1]):02d}-{int(parts[2]):02d}"
    tp = time_part.replace("：", ":")
    hm = tp.split(":")
    tp = f"{int(hm[0]):02d}:{hm[1][:2]}"
    return f"{d} {tp}"


def _diff_min(start, end):
    if not start or not end:
        return None
    try:
        s = datetime.strptime(start, "%Y-%m-%d %H:%M")
        e = datetime.strptime(end, "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    delta = (e - s).total_seconds()
    if delta < 0:
        delta += 24 * 3600  # 跨天
    return int(delta // 60)


# ---------------------------------------------------------------- extraction engines

VISION_PROMPT = """你是充电记录识别助手。请识别这张充电截图中的信息，返回严格的 JSON（不要 markdown 代码块，不要多余文字）。
字段如下，识别不到就用 null：
{
  "charge_start": "YYYY-MM-DD HH:MM",
  "charge_end": "YYYY-MM-DD HH:MM",
  "duration_min": 整数分钟,
  "start_soc": 整数百分比,
  "end_soc": 整数百分比,
  "energy_kwh": 充电电量(度),
  "fee_yuan": 总费用(元),
  "elec_fee": 电费(元),
  "service_fee": 服务费(元),
  "location": 充电站/地点,
  "operator": 运营商或充电桩品牌,
  "source_type": "xiaomi" 或 "operator",
  "note": 备注
}
注意：费用若明显像丢失小数点（如 3872 元），请换算为 38.72 并在 note 里说明。
若截图是「充电订单列表」（一屏多条记录），请返回 {"records":[{...}, {...}]}（每条同上字段，可另带 "status": "已完成"/"已关闭"），不要合并。"""


_VISION_KEYS = ("charge_start", "charge_end", "duration_min", "start_soc", "end_soc",
               "energy_kwh", "fee_yuan", "elec_fee", "service_fee", "location",
               "operator", "source_type", "status", "note")


def _clean_vision_row(data):
    fields = {}
    for k in _VISION_KEYS:
        if data.get(k) not in (None, "", "null"):
            fields[k] = data[k]
    for k in ("duration_min", "start_soc", "end_soc"):
        if k in fields:
            try:
                fields[k] = int(float(fields[k]))
            except (TypeError, ValueError):
                fields.pop(k, None)
    for k in ("energy_kwh", "fee_yuan", "elec_fee", "service_fee"):
        if k in fields:
            try:
                fields[k] = round(float(fields[k]), 2)
            except (TypeError, ValueError):
                fields.pop(k, None)
    if fields.get("charge_start"):
        cs = str(fields["charge_start"])
        fields["charge_start"] = _norm_dt(cs[:10], cs[11:16] if len(cs) > 10 else "00:00") if len(cs) > 10 else cs
    if not fields.get("energy_kwh") and not fields.get("fee_yuan"):
        return None, None
    conf = {k: 0.95 for k in fields}
    return fields, conf


def vision_extract(image_bytes, mime):
    base = get_setting("vision_base_url").strip()
    key = get_setting("vision_api_key").strip()
    model = get_setting("vision_model").strip() or "gpt-4o-mini"
    if not base or not key:
        raise RuntimeError("未配置视觉模型 API")

    if not base.endswith("/chat/completions"):
        url = base.rstrip("/") + "/v1/chat/completions" if "/v1" not in base else base.rstrip("/") + "/chat/completions"
    else:
        url = base

    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 800,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": VISION_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    content = body["choices"][0]["message"]["content"]
    content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise RuntimeError("视觉模型未返回 JSON")
    data = json.loads(m.group(0))
    if isinstance(data.get("records"), list) and len(data["records"]) >= 2:
        out = []
        for row in data["records"]:
            f, c = _clean_vision_row(row)
            if f:
                out.append((f, c))
        if out:
            return out
    fields = {}
    for k in ("charge_start", "charge_end", "duration_min", "start_soc", "end_soc",
              "energy_kwh", "fee_yuan", "elec_fee", "service_fee", "location",
              "operator", "source_type", "note"):
        if data.get(k) not in (None, "", "null"):
            fields[k] = data[k]
    for k in ("duration_min", "start_soc", "end_soc"):
        if k in fields:
            try:
                fields[k] = int(float(fields[k]))
            except (TypeError, ValueError):
                fields.pop(k, None)
    for k in ("energy_kwh", "fee_yuan", "elec_fee", "service_fee"):
        if k in fields:
            try:
                fields[k] = round(float(fields[k]), 2)
            except (TypeError, ValueError):
                fields.pop(k, None)
    if fields.get("charge_start"):
        fields["charge_start"] = _norm_dt(
            fields["charge_start"][:10], fields["charge_start"][11:16] if len(fields["charge_start"]) > 10 else "00:00"
        ) if len(fields["charge_start"]) > 10 else fields["charge_start"]
    conf = {k: 0.95 for k in fields}
    fields["raw_text"] = content
    return [(fields, conf)]


def win_ocr(image_path):
    out_file = DATA_DIR / "ocr_out.json"
    if out_file.exists():
        out_file.unlink()
    cmd = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(OCR_PS1),
        "-ImagePath", str(image_path),
        "-OutFile", str(out_file),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=90)
    if not out_file.exists():
        raise RuntimeError(f"OCR 失败: {proc.stderr.decode('utf-8', 'replace')[:300]}")
    raw = out_file.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    data = json.loads(raw.decode("utf-8", "replace"))
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data["error"])
    return data.get("text", "") if isinstance(data, dict) else str(data)


_LIST_JUNK = "已完成|已关闭|已取消|预约订单|充电订单|充电中|¥|￥"


def parse_list_group(text):
    """把单个「订单卡」的 OCR 文本解析成一条记录；不像订单则返回 None。"""
    t = normalize_ocr(text)
    if not t:
        return None
    item = {}
    m = re.search(r"(\d+(?:\.\d+)?)\s*度", t)
    if m:
        item["energy_kwh"] = _num(m.group(1))
    m = re.search(r"(\d{4}-\d{2}-\d{2})\s*(\d{1,2}:\d{2}(?::\d{2})?)", t)
    if m:
        item["charge_start"] = _norm_dt(m.group(1), m.group(2))
    m = re.search(r"[¥￥]?\s*(\d+(?:\.\d+)?)\s*元", t)
    if m:
        item["fee_yuan"] = _num(m.group(1))
    if re.search(r"已关闭", t):
        item["status"] = "已关闭"
    elif re.search(r"已完成", t):
        item["status"] = "已完成"
    elif re.search(r"已取消", t):
        item["status"] = "已取消"
    # 场站名：电量前的文本，去掉状态词与省略号
    km = re.search(r"(\d+(?:\.\d+)?)\s*度", t)
    if km:
        head = t[: km.start()]
        head = re.sub(_LIST_JUNK, " ", head)
        head = re.split(r"[。；;|]", head)[-1]
        head = head.strip(" ·・…-—")
        names = re.findall(r"[一-鿿A-Za-z0-9·]{2,24}", head)
        if names:
            cand = names[-1].strip("·")
            for op in ("星星充电", "特来电", "国家电网", "小桔充电", "云快充", "万城万充",
                       "特斯拉", "蔚来", "小鹏", "开迈斯", "广汽"):
                if cand.startswith(op):
                    item["operator"] = op
                    break
            item["location"] = cand
    if item.get("energy_kwh") is None:
        return None  # 列表行必有「X 度」；详情页（kWh）交还 parse_fields
    return item


def segment_groups(im):
    """按水平内容条带把长截图聚类成「订单卡」区块。"""
    import numpy as np
    g = im.convert("L")
    a = np.asarray(g, dtype=np.int16)
    density = (a < 240).sum(axis=1)
    content = density > 3
    bands, inb, s = [], False, 0
    for y in range(len(content)):
        if content[y] and not inb:
            inb, s = True, y
        elif not content[y] and inb:
            inb = False
            if y - s > 12:
                bands.append((s, y))
    if inb:
        bands.append((s, len(content)))
    groups = []
    for s, e in bands:
        if groups and s - groups[-1][1] <= 170:
            groups[-1][1] = e
        else:
            groups.append([s, e])
    return groups


def ocr_image_blocks(image_path):
    """长截图按块 2 倍放大识别；短图整图识别。返回 (texts, is_block_mode)。"""
    im = Image.open(image_path)
    w, h = im.size
    groups = segment_groups(im) if h > 1200 else []
    texts = []
    if len(groups) >= 2:
        for i, (top, bottom) in enumerate(groups):
            if bottom - top < 30:
                continue
            pad = 8
            crop = im.crop((0, max(0, top - pad), w, min(h, bottom + pad)))
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
            tmp = DATA_DIR / f"ocr_blk_{i}.png"
            crop.save(tmp)
            try:
                texts.append(win_ocr(tmp))
            finally:
                tmp.unlink(missing_ok=True)
        return texts, True
    return [win_ocr(image_path)], False


def extract(image_path, image_bytes, mime):
    """识别截图。返回 (records, engine)；records 为记录列表（列表页会有 N 条）。"""
    errors = []
    if get_setting("vision_enabled", "1") == "1" and get_setting("vision_api_key").strip():
        try:
            rows = vision_extract(image_bytes, mime)
            recs = []
            for fields, conf in rows:
                fields = dict(fields)
                fields["extract_engine"] = "vision-api"
                fields["confidence"] = round(sum(conf.values()) / max(len(conf), 1), 2)
                recs.append(fields)
            return recs, "vision-api"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"vision-api: {exc}")

    try:
        texts, blocked = ocr_image_blocks(image_path)
        recs = []
        for text in texts:
            item = parse_list_group(text)
            if item:
                item["raw_text"] = text
                item["extract_engine"] = "winocr"
                item["confidence"] = 0.85 if blocked else 0.8
                recs.append(item)
        if len(recs) >= 2:
            return recs, "winocr"
        if len(recs) == 1 and blocked:
            # 分块下只解析出 1 条 —— 可能是单条详情页被切碎，退回整图解析
            full = win_ocr(image_path)
            fields, conf = parse_fields(full)
            if fields.get("energy_kwh") or fields.get("fee_yuan"):
                fields["extract_engine"] = "winocr"
                fields["confidence"] = round(sum(conf.values()) / max(len(conf), 1), 2)
                return [fields], "winocr"
            recs[0].setdefault("confidence", 0.7)
            return recs, "winocr"
        if recs:
            return recs, "winocr"
        # 详情页兜底
        full = texts[0] if texts else win_ocr(image_path)
        fields, conf = parse_fields(full)
        fields["extract_engine"] = "winocr"
        fields["confidence"] = round(sum(conf.values()) / max(len(conf), 1), 2)
        fields["raw_text"] = full
        return [fields], "winocr"
    except Exception as exc:  # noqa: BLE001
        errors.append(f"winocr: {exc}")

    return [{"raw_text": "", "extract_engine": "manual", "confidence": 1.0}], "manual:" + "; ".join(errors)


# ---------------------------------------------------------------- stats

def compute_stats(date_from=None, date_to=None):
    where, params = [], []
    if date_from:
        where.append("substr(charge_start,1,10) >= ?")
        params.append(date_from)
    if date_to:
        where.append("substr(charge_start,1,10) <= ?")
        params.append(date_to)
    cond = ("WHERE " + " AND ".join(where)) if where else ""

    with DB_LOCK, db() as conn:
        recs = rows_to_dicts(conn.execute(f"SELECT * FROM records {cond} ORDER BY charge_start", params))

    total_kwh = round(sum(r["energy_kwh"] or 0 for r in recs), 2)
    total_fee = round(sum(r["fee_yuan"] or 0 for r in recs), 2)
    total_min = sum(r["duration_min"] or 0 for r in recs)
    n = len(recs)
    avg_price = round(total_fee / total_kwh, 2) if total_kwh else None

    months = {}
    hours = {h: 0 for h in range(24)}
    price_trend = []
    loc_energy = {}
    soc_points = []

    for r in recs:
        cs = r.get("charge_start") or ""
        if len(cs) >= 7:
            key = cs[:7]
            m = months.setdefault(key, {"month": key, "kwh": 0.0, "fee": 0.0, "count": 0})
            m["kwh"] += r["energy_kwh"] or 0
            m["fee"] += r["fee_yuan"] or 0
            m["count"] += 1
        if len(cs) >= 13:
            try:
                hh = int(cs[11:13])
                hours[hh] += r["energy_kwh"] or 0
            except ValueError:
                pass
        if r.get("energy_kwh") and r.get("fee_yuan") and r["energy_kwh"] > 0:
            price_trend.append({
                "date": (cs or "")[:10],
                "price": round(r["fee_yuan"] / r["energy_kwh"], 2),
                "kwh": r["energy_kwh"],
            })
        loc = r.get("location") or r.get("operator") or "未知"
        loc_energy[loc] = round(loc_energy.get(loc, 0) + (r["energy_kwh"] or 0), 2)
        if r.get("start_soc") is not None and r.get("end_soc") is not None:
            soc_points.append({"start": r["start_soc"], "end": r["end_soc"], "kwh": r["energy_kwh"]})

    top_locations = sorted(
        [{"location": k, "kwh": v} for k, v in loc_energy.items() if v > 0],
        key=lambda x: -x["kwh"],
    )[:8]

    monthly = sorted(months.values(), key=lambda x: x["month"])
    for m in monthly:
        m["kwh"] = round(m["kwh"], 2)
        m["fee"] = round(m["fee"], 2)

    hourly = [{"hour": h, "kwh": round(hours[h], 2)} for h in range(24)]

    return {
        "summary": {
            "count": n,
            "total_kwh": total_kwh,
            "total_fee": total_fee,
            "total_hours": round(total_min / 60, 1),
            "avg_kwh": round(total_kwh / n, 2) if n else 0,
            "avg_price": avg_price,
            "avg_duration_min": round(total_min / n) if n else 0,
        },
        "monthly": monthly,
        "hourly": hourly,
        "price_trend": price_trend,
        "top_locations": top_locations,
        "soc_points": soc_points[-60:],
        "recent": recs[-8:][::-1],
    }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- plumbing
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {"_raw": raw}

    def _query(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in q.items()}

    def _route(self):
        path = self.path.split("?", 1)[0]
        return path.rstrip("/") or "/"

    # ---- GET
    def do_GET(self):
        path = self._route()
        try:
            if path == "/" or path == "/index.html":
                return self._send_file(STATIC_DIR / "index.html")
            if path == "/sw.js":
                return self._send(200, (STATIC_DIR / "sw.js").read_text(encoding="utf-8"),
                                  "application/javascript; charset=utf-8",
                                  {"Service-Worker-Allowed": "/"})
            if path.startswith("/static/"):
                return self._send_file(STATIC_DIR / path[len("/static/"):])
            if path.startswith("/images/"):
                name = Path(path[len("/images/"):]).name
                return self._send_file(SHOTS_DIR / name)
            if path == "/api/records":
                q = self._query()
                cond, params = [], []
                if q.get("from"):
                    cond.append("substr(charge_start,1,10) >= ?")
                    params.append(q["from"])
                if q.get("to"):
                    cond.append("substr(charge_start,1,10) <= ?")
                    params.append(q["to"])
                if q.get("q"):
                    cond.append("(location LIKE ? OR operator LIKE ? OR note LIKE ?)")
                    like = f"%{q['q']}%"
                    params += [like, like, like]
                sql = "SELECT * FROM records"
                if cond:
                    sql += " WHERE " + " AND ".join(cond)
                sql += " ORDER BY charge_start DESC, id DESC"
                with DB_LOCK, db() as conn:
                    recs = rows_to_dicts(conn.execute(sql, params))
                return self._send(200, {"records": recs})
            if path == "/api/stats":
                q = self._query()
                return self._send(200, compute_stats(q.get("from"), q.get("to")))
            if path == "/api/settings":
                keys = ["vision_enabled", "vision_base_url", "vision_api_key", "vision_model"]
                return self._send(200, {k: get_setting(k) for k in keys})
            if path == "/api/export.csv":
                return self._export_csv()
            return self._send(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    def _send_file(self, path: Path):
        path = path.resolve()
        if not str(path).startswith(str(BASE.resolve())) or not path.is_file():
            return self._send(404, {"error": "not found"})
        ctype = guess_mime(path.name)
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        return self._send(200, path.read_bytes(), ctype)

    def _export_csv(self):
        with DB_LOCK, db() as conn:
            recs = rows_to_dicts(conn.execute("SELECT * FROM records ORDER BY charge_start"))
        buf = io.StringIO()
        w = csv.writer(buf)
        cols = ["id", "charge_start", "charge_end", "duration_min", "start_soc", "end_soc",
                "energy_kwh", "fee_yuan", "elec_fee", "service_fee", "location",
                "operator", "source_type", "note", "extract_engine", "confidence", "image_file"]
        w.writerow(cols)
        for r in recs:
            w.writerow([r.get(c, "") for c in cols])
        data = buf.getvalue().encode("utf-8-sig")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", "attachment; filename=su7-charging.csv")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- POST / PUT / DELETE
    def do_POST(self):
        path = self._route()
        body = self._json_body()
        try:
            if path == "/api/extract":
                return self._api_extract(body)
            if path == "/api/records":
                return self._api_create(body)
            if path == "/api/records/batch":
                return self._api_create_batch(body)
            if path == "/api/settings":
                for k in ("vision_enabled", "vision_base_url", "vision_api_key", "vision_model"):
                    if k in body:
                        set_setting(k, str(body[k]))
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    def do_PUT(self):
        path = self._route()
        body = self._json_body()
        try:
            m = re.match(r"^/api/records/(\d+)$", path)
            if m:
                rid = int(m.group(1))
                cols = ["source_type", "charge_start", "charge_end", "duration_min",
                        "start_soc", "end_soc", "energy_kwh", "fee_yuan", "elec_fee",
                        "service_fee", "location", "operator", "note", "status"]
                sets, params = [], []
                for c in cols:
                    if c in body:
                        sets.append(f"{c}=?")
                        params.append(body[c])
                if not sets:
                    return self._send(400, {"error": "没有可更新字段"})
                params.append(rid)
                with DB_LOCK, db() as conn:
                    cur = conn.execute(f"UPDATE records SET {', '.join(sets)} WHERE id=?", params)
                    if cur.rowcount == 0:
                        return self._send(404, {"error": "记录不存在"})
                    rec = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
                return self._send(200, {"record": dict(rec)})
            return self._send(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    def do_DELETE(self):
        path = self._route()
        m = re.match(r"^/api/records/(\d+)$", path)
        if not m:
            return self._send(404, {"error": "not found"})
        rid = int(m.group(1))
        try:
            with DB_LOCK, db() as conn:
                row = conn.execute("SELECT image_file FROM records WHERE id=?", (rid,)).fetchone()
                conn.execute("DELETE FROM records WHERE id=?", (rid,))
            if row and row["image_file"]:
                p = SHOTS_DIR / Path(row["image_file"]).name
                if p.exists():
                    p.unlink()
            return self._send(200, {"ok": True})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    # ---- business
    def _api_extract(self, body):
        b64 = body.get("image_base64") or ""
        if "," in b64 and b64.strip().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(b64)
        except Exception:
            return self._send(400, {"error": "图片 base64 无效"})
        if len(image_bytes) > 20 * 1024 * 1024:
            return self._send(400, {"error": "图片过大（>20MB）"})
        filename = body.get("filename") or "shot.png"
        mime = body.get("mime") or guess_mime(filename)
        name = save_image(image_bytes, filename)
        image_path = SHOTS_DIR / name
        recs, engine = extract(image_path, image_bytes, mime)
        for r in recs:
            r["image_file"] = name
            r.setdefault("extract_engine", engine)
        mode = "list" if len(recs) >= 2 else "single"
        return self._send(200, {
            "image_file": name,
            "image_url": f"/images/{name}",
            "mode": mode,
            "records": recs,
            "fields": recs[0],
            "engine": recs[0].get("extract_engine"),
        })

    def _api_create_batch(self, body):
        rows = body.get("records") or []
        if not rows:
            return self._send(400, {"error": "没有可入库的记录"})
        saved, skipped, duplicates, seen = [], 0, [], set()
        with DB_LOCK, db() as conn:
            for body_row in rows:
                f = {
                    "source_type": body_row.get("source_type") or "manual",
                    "charge_start": body_row.get("charge_start") or None,
                    "charge_end": body_row.get("charge_end") or None,
                    "duration_min": _int_or_none(body_row.get("duration_min")),
                    "start_soc": _int_or_none(body_row.get("start_soc")),
                    "end_soc": _int_or_none(body_row.get("end_soc")),
                    "energy_kwh": _float_or_none(body_row.get("energy_kwh"), 3),
                    "fee_yuan": _float_or_none(body_row.get("fee_yuan")),
                    "elec_fee": _float_or_none(body_row.get("elec_fee")),
                    "service_fee": _float_or_none(body_row.get("service_fee")),
                    "location": body_row.get("location") or None,
                    "operator": body_row.get("operator") or None,
                    "note": body_row.get("note") or None,
                    "status": body_row.get("status") or None,
                    "image_file": body_row.get("image_file") or None,
                    "raw_text": body_row.get("raw_text") or None,
                    "extract_engine": body_row.get("extract_engine") or "manual",
                    "confidence": _float_or_none(body_row.get("confidence")) or 1.0,
                }
                if not f["energy_kwh"] and not f["fee_yuan"]:
                    skipped += 1
                    continue
                key = _dup_key(f)
                if key in seen:
                    duplicates.append({"key": key, "source": "batch"})
                    continue
                dup_id = _find_dup_id(conn, key)
                if dup_id:
                    duplicates.append({"id": dup_id, "key": key})
                    seen.add(key)
                    continue
                seen.add(key)
                cols = list(f.keys())
                sql = f"INSERT INTO records(created_at, {', '.join(cols)}) VALUES(?{', ?' * len(cols)})"
                cur = conn.execute(sql, [now_iso()] + [f[c] for c in cols])
                saved.append(cur.lastrowid)
        return self._send(200, {
            "saved": len(saved), "ids": saved, "skipped": skipped,
            "duplicates": len(duplicates), "dup_detail": duplicates,
        })

    def _api_create(self, body):
        fields = {
            "source_type": body.get("source_type") or "manual",
            "charge_start": body.get("charge_start") or None,
            "charge_end": body.get("charge_end") or None,
            "duration_min": _int_or_none(body.get("duration_min")),
            "start_soc": _int_or_none(body.get("start_soc")),
            "end_soc": _int_or_none(body.get("end_soc")),
            "energy_kwh": _float_or_none(body.get("energy_kwh"), 3),
            "fee_yuan": _float_or_none(body.get("fee_yuan")),
            "elec_fee": _float_or_none(body.get("elec_fee")),
            "service_fee": _float_or_none(body.get("service_fee")),
            "location": body.get("location") or None,
            "operator": body.get("operator") or None,
            "note": body.get("note") or None,
            "status": body.get("status") or None,
            "image_file": body.get("image_file") or None,
            "raw_text": body.get("raw_text") or None,
            "extract_engine": body.get("extract_engine") or "manual",
            "confidence": _float_or_none(body.get("confidence")) or 1.0,
        }
        if not fields["energy_kwh"] and not fields["fee_yuan"]:
            return self._send(400, {"error": "至少需要电量或费用之一"})
        with DB_LOCK, db() as conn:
            key = _dup_key(fields)
            dup_id = _find_dup_id(conn, key)
            if dup_id:
                rec = conn.execute("SELECT * FROM records WHERE id=?", (dup_id,)).fetchone()
                return self._send(200, {"record": dict(rec), "duplicate": True, "dup_id": dup_id})
            cols = list(fields.keys())
            sql = f"INSERT INTO records(created_at, {', '.join(cols)}) VALUES(?{', ?' * len(cols)})"
            cur = conn.execute(sql, [now_iso()] + [fields[c] for c in cols])
            rid = cur.lastrowid
            rec = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        return self._send(200, {"record": dict(rec), "duplicate": False})


def _int_or_none(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _float_or_none(v, nd=2):
    if v in (None, ""):
        return None
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


def _dup_key(f):
    """去重键：开始时间+电量+费用；无时间时退化为 电量+费用+场站。

    数值按 2 位小数比对，容忍 OCR/显示层的末位误差。
    """
    e = round(f.get("energy_kwh") or 0, 2)
    fee = round(f.get("fee_yuan") or 0, 2)
    cs = (f.get("charge_start") or "").strip()
    if cs:
        return ("t", cs, e, fee)
    return ("l", e, fee, (f.get("location") or "").strip())


def _find_dup_id(conn, key):
    rows = conn.execute(
        "SELECT id, charge_start, energy_kwh, fee_yuan, location FROM records"
    ).fetchall()
    for r in rows:
        if _dup_key(dict(r)) == key:
            return r["id"]
    return None


def main():
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer((HOST, port), Handler)
    print(f"SU7 充电账本已启动: http://127.0.0.1:{port}/")
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        print(f"手机同 Wi-Fi 访问: http://{ip}:{port}/  (浏览器打开后可「添加到主屏幕」)")
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
