"""Сборщик: посты качества воздуха Атырауской области (карта Казгидромета ecodata.kz) + погода (Open-Meteo).

Запуск раз в час. ecodata.kz открывается только из Казахстана, поэтому:
  ноутбук:  collect.py --only stations --log local.log --push   (посты → сразу в GitHub)
  GitHub:   collect.py --only weather,kgm --log cloud.log        (погода + посты Казгидромета с tabigat.gov.kz)
"""
import argparse
import csv
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATIONS_CSV = DATA / "stations.csv"
WIND_CSV = DATA / "wind.csv"
KGM_CSV = DATA / "kgm.csv"
LOG = DATA / "collect.log"  # меняется аргументом --log

ECODATA_URL = "http://ecodata.kz:3838/app_dem_visual/"
# Атырауская область с запасом (город, Кульсары, Тенгиз, Жанбай, Макат, Ганюшкино)
BBOX = {"lat_min": 45.5, "lat_max": 48.5, "lng_min": 48.5, "lng_max": 55.0}  # 48.5 — Ганюшкино (Құрманғазы ауданы)
# Ветер берём над центром Атырау
WIND_POINT = (47.11, 51.92)
ATYRAU_TZ = timezone(timedelta(hours=5))  # Казахстан UTC+5; сервер GitHub работает в UTC
# На Windows — установленный Edge, на сервере GitHub — Chromium из Playwright (BROWSER_CHANNEL пустой)
BROWSER_CHANNEL = os.environ.get("BROWSER_CHANNEL", "msedge" if os.name == "nt" else "") or None

STATION_FIELDS = ["fetched_at_utc", "station", "address", "lat", "lng", "measured_at", "pollutant", "value"]
WIND_FIELDS = ["time_local", "wind_dir_deg", "wind_speed_ms", "wind_gust_ms", "radiation_wm2", "cloud_pct", "temp_c"]
WEATHER_START = "2026-10-12"  # погода нужна с начала сбора постов (с запасом)

# tabigat.gov.kz (портал Минэкологии): слой «Состояние атмосферного воздуха» — посты Казгидромета
# с десятичными значениями и СВОИМ ветром. Открытый GeoServer WFS, координаты EPSG:3857.
TABIGAT_LAYER_ID = "85a41068-0bd1-427d-8958-86b44a696eba"
TABIGAT_ATTRS = f"https://tabigat.gov.kz/api/v1/gis/main/open-api-layers/{TABIGAT_LAYER_ID}/attrs"
TABIGAT_WFS = ("https://tabigat.gov.kz/geoserver/gis/wfs?service=WFS&version=1.0.0&request=GetFeature"
               "&typeName=gis:layer_48572&outputFormat=application/json&maxFeatures=5000")
KGM_PARAMS = {  # nameRu поля → код в kgm.csv (единицы как в источнике)
    "Направление ветра (градусы)": "wind_dir", "Скорость ветра (м/с)": "wind_speed",
    "Температура (°C)": "temp", "Давление (мм рт. ст.)": "pressure",
    "Сероводород (мкг/м3)": "H2S", "Диоксид серы (мкг/м3)": "SO2", "Оксид азота (мкг/м3)": "NO",
    "Диоксид азота (мкг/м3)": "NO2", "Оксид углерода (мкг/м3)": "CO",
    "Частицы PM2.5 (мг/м3)": "PM2.5_mg", "Частицы PM10 (мг/м3)": "PM10_mg",
    "Взвешенные вещества (частицы, мг/м3)": "PMtot_mg",
}
KGM_FIELDS = ["fetched_at_utc", "station_id", "lat", "lng", "measured_at", "param", "value"]

# Достаёт из карты все точки в рамке BBOX и разбирает таблицу во всплывающем окне
EXTRACT_JS = """(b) => {
  const el = document.querySelector('.leaflet.html-widget');
  const map = HTMLWidgets.find('#' + el.id).getMap();
  const out = [];
  map.eachLayer(l => {
    if (!l.getLatLng || !l.getPopup || !l.getPopup()) return;
    const p = l.getLatLng();
    if (p.lat < b.lat_min || p.lat > b.lat_max || p.lng < b.lng_min || p.lng > b.lng_max) return;
    const html = String(l.getPopup().getContent());
    // в заголовке сайта лишний <tr>, поэтому заголовок берём из сырого текста, а не из DOM
    const capRaw = (html.match(/<caption>([\\s\\S]*?)<\\/caption>/) || [, ''])[1];
    const cap = capRaw.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');
    const div = document.createElement('div');
    div.innerHTML = html;
    const m = cap.match(/^\\s*(.*?)\\s*:\\s*(.*?)\\s+(\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2}:\\d{2})?)\\s*$/s);
    const rows = [...div.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
    out.push({
      station: m ? m[1] : cap.trim(), address: m ? m[2] : '', measured_at: m ? m[3] : '',
      lat: p.lat, lng: p.lng,
      values: rows.filter(r => r.length >= 2 && r[1] !== '').map(r => ({ pollutant: r[0], value: r[1] })),
    });
  });
  return out;
}"""


def log(msg):
    DATA.mkdir(exist_ok=True)
    line = f"{datetime.now(ATYRAU_TZ):%Y-%m-%d %H:%M:%S} {msg}"
    if sys.stdout:  # из планировщика (pythonw) консоли нет
        sys.stdout.reconfigure(encoding="utf-8")
        print(line)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_keys(path, key_fn):
    if not path.exists():
        return set()
    with path.open(encoding="utf-8-sig", newline="") as f:
        return {key_fn(r) for r in csv.DictReader(f)}


def append_rows(path, fields, rows):
    new_file = not path.exists()
    with path.open("a", encoding="utf-8-sig" if new_file else "utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if new_file:
            w.writeheader()
        w.writerows(rows)


def fetch_stations():
    from playwright.sync_api import sync_playwright  # нужен только для постов

    with sync_playwright() as p:
        browser = p.chromium.launch(channel=BROWSER_CHANNEL, headless=True)
        page = browser.new_page()
        page.goto(ECODATA_URL, timeout=90_000)
        # ждём, пока Shiny нарисует карту с маркерами
        page.wait_for_function(
            """() => { const el = document.querySelector('.leaflet.html-widget');
                       if (!el || !window.HTMLWidgets) return false;
                       const w = HTMLWidgets.find('#' + el.id); if (!w || !w.getMap) return false;
                       let n = 0; w.getMap().eachLayer(l => { if (l.getPopup && l.getPopup()) n++; });
                       return n > 50; }""",
            timeout=120_000,
        )
        points = page.evaluate(EXTRACT_JS, BBOX)
        browser.close()
    return points


def collect_stations():
    try:
        points = fetch_stations()
    except Exception as e:  # разовые сбои запуска браузера/сайта — одна повторная попытка
        log(f"посты: повтор после ошибки {e!r}")
        points = fetch_stations()
    key = lambda r: (r["station"], r["lat"][:7], r["lng"][:7], r["measured_at"], r["pollutant"])
    seen = read_keys(STATIONS_CSV, key)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for pt in points:
        for v in pt["values"]:
            r = {"fetched_at_utc": now, "station": pt["station"], "address": pt["address"],
                 "lat": f"{pt['lat']:.5f}", "lng": f"{pt['lng']:.5f}",
                 "measured_at": pt["measured_at"], "pollutant": v["pollutant"], "value": v["value"]}
            if key(r) not in seen:
                seen.add(key(r))
                rows.append(r)
    append_rows(STATIONS_CSV, STATION_FIELDS, rows)
    return len(points), len(rows)


def get_json(url, attempts=3):
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.load(resp)
        except Exception:  # сервис иногда отвечает 503 — пробуем ещё
            if i == attempts - 1:
                raise
            time.sleep(10 * (i + 1))


def collect_kgm():
    """Посты Казгидромета с tabigat.gov.kz: дописывает новые (пост, час, параметр) в data/kgm.csv."""
    attrs = get_json(TABIGAT_ATTRS)
    code = {a["attrname"]: KGM_PARAMS[a["nameRu"]] for a in attrs if a.get("nameRu") in KGM_PARAMS}
    name = {a["nameRu"]: a["attrname"] for a in attrs}
    date_attr, id_attr = name["Дата"], name["ID Станции"]
    feats = get_json(TABIGAT_WFS)["features"]
    key = lambda r: (r["station_id"], r["measured_at"], r["param"])
    seen = read_keys(KGM_CSV, key)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, n_pts = [], 0
    for f in feats:
        x, y = f["geometry"]["coordinates"]
        lng = x / 6378137 * 180 / math.pi
        lat = math.degrees(2 * math.atan(math.exp(y / 6378137)) - math.pi / 2)
        if not (BBOX["lat_min"] <= lat <= BBOX["lat_max"] and BBOX["lng_min"] <= lng <= BBOX["lng_max"]):
            continue
        p = f["properties"]
        if not p.get(date_attr):
            continue
        n_pts += 1
        t = datetime.fromisoformat(p[date_attr].replace("Z", "+00:00")).astimezone(ATYRAU_TZ)
        for attr, c in code.items():
            v = p.get(attr)
            if v is None:
                continue
            r = {"fetched_at_utc": now, "station_id": p.get(id_attr), "lat": f"{lat:.5f}", "lng": f"{lng:.5f}",
                 "measured_at": t.strftime("%Y-%m-%d %H:%M:%S"), "param": c, "value": round(float(v), 4)}
            if key({k: str(v2) for k, v2 in r.items()}) not in seen:
                seen.add(key({k: str(v2) for k, v2 in r.items()}))
                rows.append(r)
    append_rows(KGM_CSV, KGM_FIELDS, rows)
    return n_pts, len(rows)


def collect_wind():
    """Погода по часам с WEATHER_START до текущего часа; файл пересобирается целиком (Open-Meteo уточняет прошлые часы)."""
    lat, lng = WIND_POINT
    now_local = datetime.now(ATYRAU_TZ).replace(tzinfo=None)
    url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}"
           "&hourly=wind_direction_10m,wind_speed_10m,wind_gusts_10m,shortwave_radiation,cloud_cover,temperature_2m"
           f"&wind_speed_unit=ms&timezone=Asia%2FAtyrau&start_date={WEATHER_START}&end_date={now_local:%Y-%m-%d}")
    h = get_json(url)["hourly"]
    rows = []
    for t, d, s, g, rad, cl, tc in zip(h["time"], h["wind_direction_10m"], h["wind_speed_10m"], h["wind_gusts_10m"],
                                       h["shortwave_radiation"], h["cloud_cover"], h["temperature_2m"]):
        if datetime.fromisoformat(t) > now_local or d is None:
            continue  # только прошедшие часы, без прогноза
        rows.append({"time_local": t, "wind_dir_deg": d, "wind_speed_ms": s, "wind_gust_ms": g,
                     "radiation_wm2": rad, "cloud_pct": cl, "temp_c": tc})
    tmp = WIND_CSV.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=WIND_FIELDS)
        w.writeheader()
        w.writerows(rows)
    tmp.replace(WIND_CSV)
    return len(rows)


def git(*args):
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # без всплывающих окон из планировщика
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                          creationflags=flags, timeout=120)


def push(paths):
    """Отправить новые данные в GitHub (чтобы страница в интернете их видела)."""
    git("add", *[str(p.relative_to(ROOT)) for p in paths])
    if git("diff", "--cached", "--quiet").returncode == 0:
        return "нет изменений"
    git("commit", "-m", f"Посты {datetime.now(ATYRAU_TZ):%Y-%m-%d %H:%M}")
    pull = git("pull", "--rebase", "-q")
    if pull.returncode != 0:
        git("rebase", "--abort")
        return f"ОШИБКА pull: {pull.stderr.strip()[:300]}"
    res = git("push", "-q")
    return "отправлено" if res.returncode == 0 else f"ОШИБКА push: {res.stderr.strip()[:300]}"


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="all", help="через запятую: stations, weather, kgm (или all)")
    ap.add_argument("--log", default="collect.log")
    ap.add_argument("--push", action="store_true", help="после сбора отправить данные в GitHub")
    a = ap.parse_args()
    LOG = DATA / a.log
    parts = {"stations", "weather", "kgm"} if a.only == "all" else set(a.only.split(","))
    ok = True
    if "stations" in parts:
        try:
            n_points, n_rows = collect_stations()
            log(f"посты: {n_points} точек, новых строк {n_rows}")
        except Exception as e:
            ok = False
            log(f"ОШИБКА посты: {e!r}")
    if "kgm" in parts:
        try:
            n_pts, n_rows = collect_kgm()
            log(f"казгидромет (tabigat): {n_pts} постов, новых строк {n_rows}")
        except Exception as e:
            ok = False
            log(f"ОШИБКА казгидромет: {e!r}")
    if "weather" in parts:
        try:
            log(f"погода: часов в файле {collect_wind()}")
        except Exception as e:
            ok = False
            log(f"ОШИБКА погода: {e!r}")
    if a.push:
        try:
            r = push([STATIONS_CSV, LOG])
            log(f"github: {r}")
            ok = ok and not r.startswith("ОШИБКА")
        except Exception as e:
            ok = False
            log(f"ОШИБКА github: {e!r}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
