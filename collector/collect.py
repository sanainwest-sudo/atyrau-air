"""Сборщик: посты качества воздуха Атырауской области (карта Казгидромета ecodata.kz) + ветер (Open-Meteo).

Запуск раз в час. Дописывает новые строки в data/stations.csv и data/wind.csv, повторы пропускает.
"""
import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATIONS_CSV = DATA / "stations.csv"
WIND_CSV = DATA / "wind.csv"
LOG = DATA / "collect.log"

ECODATA_URL = "http://ecodata.kz:3838/app_dem_visual/"
# Атырауская область с запасом (город, Кульсары, Тенгиз, Жанбай, Макат)
BBOX = {"lat_min": 45.5, "lat_max": 48.5, "lng_min": 50.0, "lng_max": 55.0}
# Ветер берём над центром Атырау
WIND_POINT = (47.11, 51.92)
ATYRAU_TZ = timezone(timedelta(hours=5))  # Казахстан UTC+5; сервер GitHub работает в UTC
# На Windows — установленный Edge, на сервере GitHub — Chromium из Playwright (BROWSER_CHANNEL пустой)
BROWSER_CHANNEL = os.environ.get("BROWSER_CHANNEL", "msedge" if os.name == "nt" else "") or None

STATION_FIELDS = ["fetched_at_utc", "station", "address", "lat", "lng", "measured_at", "pollutant", "value"]
WIND_FIELDS = ["time_local", "wind_dir_deg", "wind_speed_ms", "wind_gust_ms", "radiation_wm2", "cloud_pct"]
WEATHER_START = "2026-10-12"  # погода нужна с начала сбора постов (с запасом)

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


def collect_wind():
    """Погода по часам с WEATHER_START до текущего часа; файл пересобирается целиком (Open-Meteo уточняет прошлые часы)."""
    lat, lng = WIND_POINT
    now_local = datetime.now(ATYRAU_TZ).replace(tzinfo=None)
    url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}"
           "&hourly=wind_direction_10m,wind_speed_10m,wind_gusts_10m,shortwave_radiation,cloud_cover"
           f"&wind_speed_unit=ms&timezone=Asia%2FAtyrau&start_date={WEATHER_START}&end_date={now_local:%Y-%m-%d}")
    h = get_json(url)["hourly"]
    rows = []
    for t, d, s, g, rad, cl in zip(h["time"], h["wind_direction_10m"], h["wind_speed_10m"], h["wind_gusts_10m"],
                                   h["shortwave_radiation"], h["cloud_cover"]):
        if datetime.fromisoformat(t) > now_local or d is None:
            continue  # только прошедшие часы, без прогноза
        rows.append({"time_local": t, "wind_dir_deg": d, "wind_speed_ms": s, "wind_gust_ms": g,
                     "radiation_wm2": rad, "cloud_pct": cl})
    tmp = WIND_CSV.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=WIND_FIELDS)
        w.writeheader()
        w.writerows(rows)
    tmp.replace(WIND_CSV)
    return len(rows)


def main():
    ok = True
    try:
        n_points, n_rows = collect_stations()
        log(f"посты: {n_points} точек, новых строк {n_rows}")
    except Exception as e:
        ok = False
        log(f"ОШИБКА посты: {e!r}")
    try:
        log(f"погода: часов в файле {collect_wind()}")
    except Exception as e:
        ok = False
        log(f"ОШИБКА ветер: {e!r}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
