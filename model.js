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

  // метры относительно точки (lat0, lng0): x — на восток, y — на север
  function toMeters(lat, lng, lat0, lng0) {
    return [(lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * 110540];
  }

  /** Относительная концентрация у земли в точке приёмника от источника с высотой H.
   *  windFromDeg — откуда дует ветер (метеорологический угол). */
  function plumeAt(src, rcp, windFromDeg, u10, cls) {
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
    if (H < 5) sy = Math.hypot(sy, 100); // наземный площадной источник (пруд, очистные) — начальная ширина ~100 м
    return Math.exp(-(y * y) / (2 * sy * sy)) * Math.exp(-(H * H) / (2 * sz * sz)) / (Math.PI * u * sy * sz);
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
        const v = plumeAt(s, o.station, w.dir, w.speed, stabilityClass(w.speed, w.rad, w.cloud));
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

  /** Контур факела для карты: точки [lat,lng] по краям ±2σy до maxKm */
  function plumeOutline(src, windFromDeg, cls, maxKm = 12) {
    const to = (windFromDeg + 180) * Math.PI / 180;
    const dx = Math.sin(to), dy = Math.cos(to);
    const kx = 1 / (111320 * Math.cos(src.lat * Math.PI / 180)), ky = 1 / 110540;
    const left = [], right = [];
    for (let x = 0; x <= maxKm * 1000; x += 250) {
      let [sy] = x > 0 ? BRIGGS[cls](x) : [0];
      sy = Math.hypot(sy, x * MEANDER);
      if ((+src.height_m || 0) < 5) sy = Math.hypot(sy, 100);
      const w = 2 * sy;
      const cx = x * dx, cy = x * dy;
      left.push([src.lat + (cy + w * dx) * ky, src.lng + (cx - w * dy) * kx]);
      right.push([src.lat + (cy - w * dx) * ky, src.lng + (cx + w * dy) * kx]);
    }
    return [...left, ...right.reverse()];
  }

  globalThis.AirModel = { stabilityClass, plumeAt, rankSources, plumeOutline, NAMES };
})();
