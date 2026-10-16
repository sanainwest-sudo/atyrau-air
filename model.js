/* Модель «откуда запах»: гауссов факел + сравнение с постами.
   Гауссов факел (отражение от земли), классы устойчивости Паскуилла (по ветру, солнцу, облачности),
   σy/σz — формулы Бриггса для открытой местности, ветер на высоте источника — степенной закон.
   Выброс Q = 1 (относительный): нас интересует рисунок концентраций по постам, а не абсолютные цифры.
   Работает и в браузере, и в Node (для тестов): всё кладётся в globalThis.AirModel. */
(() => {
  // σy, σz (м) от расстояния x (м) по ветру — Briggs (1973), открытая местность
  const BRIGGS = {
    A: x => [0.22 * x / Math.sqrt(1 + 1e-4 * x), 0.20 * x],
    B: x => [0.16 * x / Math.sqrt(1 + 1e-4 * x), 0.12 * x],
    C: x => [0.11 * x / Math.sqrt(1 + 1e-4 * x), 0.08 * x / Math.sqrt(1 + 2e-4 * x)],
    D: x => [0.08 * x / Math.sqrt(1 + 1e-4 * x), 0.06 * x / Math.sqrt(1 + 1.5e-3 * x)],
    E: x => [0.06 * x / Math.sqrt(1 + 1e-4 * x), 0.03 * x / (1 + 3e-4 * x)],
    F: x => [0.04 * x / Math.sqrt(1 + 1e-4 * x), 0.016 * x / (1 + 3e-4 * x)],
  };
  // показатель степени профиля ветра для открытой местности
  const WIND_EXP = { A: 0.07, B: 0.07, C: 0.10, D: 0.15, E: 0.35, F: 0.55 };
  // часовое блуждание направления ветра ±15° (tan 15° ≈ 0.27)
  const MEANDER = Math.tan(15 * Math.PI / 180);
  const NAMES = {
    A: 'өте тұрақсыз (күшті күн, тымық)', B: 'тұрақсыз', C: 'аздап тұрақсыз',
    D: 'бейтарап (бұлтты немесе қатты жел)', E: 'тұрақты (түн)', F: 'өте тұрақты (ашық түн, тымық — инверсия)',
  };

  /** Класс устойчивости по Паскуиллу–Тёрнеру (упрощённо).
   *  u10 — ветер 10 м (м/с), rad — солнечная радиация (Вт/м²), cloud — облачность (%). */
  function stabilityClass(u10, rad, cloud) {
    if (rad > 25) { // день
      const sun = rad > 600 ? 0 : rad > 300 ? 1 : 2; // сильное / умеренное / слабое солнце
      const table = [['A', 'B', 'B'], ['B', 'B', 'C'], ['B', 'C', 'C'], ['C', 'D', 'D'], ['C', 'D', 'D']];
      const row = u10 < 2 ? 0 : u10 < 3 ? 1 : u10 < 5 ? 2 : u10 < 6 ? 3 : 4;
      return table[row][sun];
    }
    // ночь
    if (cloud >= 50) return u10 < 3 ? 'E' : 'D';
    return u10 < 3 ? 'F' : u10 < 5 ? 'E' : 'D';
  }

  // начальная ширина факела: площадной источник размером size_m (большой пруд) — size/4,
  // наземный без размера (очистные) — 100 м, труба — 0
  function initialWidth(src) {
    if (src.width_m != null) return src.width_m;
    const size = +src.size_m || 0;
    if (size > 0) return size / 4;
    return (+src.height_m || 0) < 5 ? 100 : 0;
  }

  const G = 9.81;
  // Тұрақты кластарда потенциалды температураның градиенті (К/м). Бір деңгейлі өлшем болғандықтан нақты градиент жоқ — класқа қарай қабылданады
  const DTHETA = { E: 0.02, F: 0.035 };

  /** Ыстық құбыр түтінінің көтерілуі Δh(x), м (Бриггс). stack = { d_m, v_ms, ts_c } — НДВ параметрлері.
   *  u — құбыр биіктігіндегі жел (м/с), Ta — қоршаған ауа (°C), x — құбырдан қашықтық (м).
   *  Ta немесе stack жоқ болса, көтерілу 0 — модель бұрынғыша жұмыс істейді. */
  function plumeRise(stack, Ta, u, cls, x) {
    if (!stack || !(stack.d_m > 0) || !(stack.v_ms > 0) || stack.ts_c == null || Ta == null || !isFinite(Ta)) return 0;
    const Ts = stack.ts_c + 273.15, Tk = Ta + 273.15;
    if (Ts <= Tk) return 0; // газ суық болса, көтерілмейді
    const F = G * stack.v_ms * stack.d_m * stack.d_m / 4 * (Ts - Tk) / Ts; // көтеру күшінің ағыны, м⁴/с³
    const growing = 1.6 * Math.cbrt(F) * Math.pow(Math.max(x, 0), 2 / 3) / u; // қашықтықпен өсетін көтерілу
    let final; // соңғы (шектік) көтерілу
    if (DTHETA[cls]) final = 2.6 * Math.cbrt(F / (u * (G / Tk * DTHETA[cls])));
    else final = (F < 55 ? 21.425 * Math.pow(F, 0.75) : 38.71 * Math.pow(F, 0.6)) / u;
    return Math.min(growing, final);
  }

  /** Көз маңындағы ауа температурасы: бекеттердің мәндері 1/d² салмағымен орташаланады.
   *  stations: [{ lat, lng, temp }] — температурасы бар бекеттер. Біреуі де жоқ болса — fallback (Open-Meteo).
   *  Қашықтық 500 м-ден кіші болса, 500 м деп алынады — бір бекет бәрін басып кетпесін. */
  function localTemp(point, stations, fallback) {
    let sw = 0, st = 0;
    for (const s of stations || []) {
      if (s.temp == null || !isFinite(s.temp)) continue;
      const [ex, ny] = toMeters(s.lat, s.lng, point.lat, point.lng);
      const w = 1 / Math.max(500, Math.hypot(ex, ny)) ** 2;
      sw += w; st += w * s.temp;
    }
    return sw > 0 ? st / sw : fallback;
  }

  // метры относительно точки (lat0, lng0): x — на восток, y — на север
  function toMeters(lat, lng, lat0, lng0) {
    return [(lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * 110540];
  }

  // ---- площадные источники (пруд): пишут контур `area` = [[ [lat,lng], ... ], ...] (несколько частей).
  // Внутренность режем сеткой AREA_STEP м, выброс делится поровну между точками — так учитываются и ближний край, и середина.
  const AREA_STEP = 1000;
  const areaCache = new WeakMap();
  function inside(lat, lng, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ai, oi] = ring[i], [aj, oj] = ring[j];
      if ((ai > lat) !== (aj > lat) && lng < (oj - oi) * (lat - ai) / (aj - ai) + oi) c = !c;
    }
    return c;
  }
  function areaPoints(area) {
    if (areaCache.has(area)) return areaCache.get(area);
    const pts = [];
    for (const ring of area) {
      const la = ring.map(p => p[0]), lo = ring.map(p => p[1]);
      const lat0 = Math.min(...la), lat1 = Math.max(...la), lng0 = Math.min(...lo), lng1 = Math.max(...lo);
      const dLat = AREA_STEP / 110540, dLng = AREA_STEP / (111320 * Math.cos(lat0 * Math.PI / 180));
      const before = pts.length;
      for (let a = lat0 + dLat / 2; a < lat1; a += dLat)
        for (let o = lng0 + dLng / 2; o < lng1; o += dLng)
          if (inside(a, o, ring)) pts.push([a, o]);
      if (pts.length === before) pts.push([la.reduce((x, y) => x + y) / la.length, lo.reduce((x, y) => x + y) / lo.length]); // маленькая часть — её центр
    }
    areaCache.set(area, pts);
    return pts;
  }

  /** Относительная концентрация у земли в точке приёмника от источника (точечного или площадного).
   *  windFromDeg — откуда дует ветер (метеорологический угол). */
  function plumeAt(src, rcp, windFromDeg, u10, cls, Ta) {
    if (!Array.isArray(src.area) || !src.area.length) return plumePoint(src, rcp, windFromDeg, u10, cls, Ta);
    const pts = areaPoints(src.area);
    let sum = 0;
    for (const [lat, lng] of pts) sum += plumePoint({ lat, lng, height_m: src.height_m, width_m: AREA_STEP / 2 }, rcp, windFromDeg, u10, cls, Ta);
    return sum / pts.length;
  }

  function plumePoint(src, rcp, windFromDeg, u10, cls, Ta) {
    const [ex, ny] = toMeters(rcp.lat, rcp.lng, src.lat, src.lng);
    const to = (windFromDeg + 180) * Math.PI / 180; // направление, куда дует
    const dx = Math.sin(to), dy = Math.cos(to);
    const x = ex * dx + ny * dy;          // по ветру
    const y = -ex * dy + ny * dx;         // поперёк ветра
    if (x < 50) return 0;                 // приёмник против ветра или вплотную — вклада нет
    const H = Math.max(0, +src.height_m || 0);
    const u = Math.max(0.5, u10 * Math.pow(Math.max(H, 10) / 10, WIND_EXP[cls]));
    let [sy, sz] = BRIGGS[cls](x);
    sy = Math.hypot(sy, x * MEANDER);     // за час факел «гуляет» шире, чем 10-минутный σy Бриггса
    sy = Math.hypot(sy, initialWidth(src));
    const He = H + plumeRise(src.stack, Ta, u, cls, x); // түтін көтерілгеннен кейінгі тиімді биіктік
    return Math.exp(-(y * y) / (2 * sy * sy)) * Math.exp(-(He * He) / (2 * sz * sz)) / (Math.PI * u * sy * sz);
  }

  /** Рейтинг источников.
   *  obs: [{ hour, station: {lat,lng,name}, excess }] — превышение над фоном поста (≥0)
   *  weather: { [hour]: { dir, speed, rad, cloud } }
   *  Для каждого источника подбираем Q ≥ 0 (метод наименьших квадратов) и смотрим,
   *  какую долю «лишнего» H2S он объясняет. */
  function rankSources(sources, obs, weather) {
    const rows = obs.filter(o => weather[o.hour]);
    const total = rows.reduce((a, o) => a + o.excess * o.excess, 0);
    const result = sources.filter(s => s.lat != null).map(s => {
      let em = 0, mm = 0;
      const m = rows.map(o => {
        const w = weather[o.hour];
        // Ta — көзге жақын бекеттердің температурасы (1/d²), жоқ болса — Open-Meteo (w.temp)
        const v = plumeAt(s, o.station, w.dir, w.speed, stabilityClass(w.speed, w.rad, w.cloud), localTemp(s, w.stationTemps, w.temp));
        em += o.excess * v; mm += v * v;
        return v;
      });
      const Q = mm > 0 ? Math.max(0, em / mm) : 0;
      const resid = rows.reduce((a, o, i) => a + (o.excess - Q * m[i]) ** 2, 0);
      const explained = total > 0 ? Math.max(0, 1 - resid / total) : 0;
      return { source: s, explained, Q };
    });
    const sum = result.reduce((a, r) => a + r.explained, 0);
    result.forEach(r => r.share = sum > 0 ? r.explained / sum : 0);
    return { ranking: result.sort((a, b) => b.explained - a.explained), total, n: rows.length };
  }

  /** Көздің түтіні x метр қашықтықта қанша метрге көтерілетіні (бетте көрсету үшін). w — { speed, rad, cloud, temp, stationTemps } */
  function riseAt(src, w, x) {
    const cls = stabilityClass(w.speed, w.rad, w.cloud);
    const H = Math.max(0, +src.height_m || 0);
    const u = Math.max(0.5, w.speed * Math.pow(Math.max(H, 10) / 10, WIND_EXP[cls]));
    return plumeRise(src.stack, localTemp(src, w.stationTemps, w.temp), u, cls, x);
  }

  /** Контур факела для карты: точки [lat,lng] по краям ±2σy до maxKm */
  function plumeOutline(src, windFromDeg, cls, maxKm = 12) {
    const to = (windFromDeg + 180) * Math.PI / 180;
    const dx = Math.sin(to), dy = Math.cos(to);
    const kx = 1 / (111320 * Math.cos(src.lat * Math.PI / 180)), ky = 1 / 110540;
    const left = [], right = [];
    for (let x = 0; x <= maxKm * 1000; x += 250) {
      let [sy] = x > 0 ? BRIGGS[cls](x) : [0];
      sy = Math.hypot(sy, x * MEANDER);
      sy = Math.hypot(sy, initialWidth(src));
      const w = 2 * sy;
      const cx = x * dx, cy = x * dy;
      left.push([src.lat + (cy + w * dx) * ky, src.lng + (cx - w * dy) * kx]);
      right.push([src.lat + (cy - w * dx) * ky, src.lng + (cx + w * dy) * kx]);
    }
    return [...left, ...right.reverse()];
  }

  globalThis.AirModel = { stabilityClass, plumeAt, plumeRise, riseAt, localTemp, rankSources, plumeOutline, areaPoints, NAMES };
})();
