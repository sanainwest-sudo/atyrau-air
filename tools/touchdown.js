// Где газ из труб опускается к земле: расстояние до максимума приземной концентрации и зона ≥ 50% максимума.
// Гауссов факел (model.js) + подъём горячего факела по Бриггсу для труб АТЭЦ (параметры из «Проекта НДВ ТОО АТЭЦ»).
// Запуск: node tools/touchdown.js
require('../model.js');
const { plumeAt } = globalThis.AirModel;

const g = 9.81, Ta = 283; // воздух ~10 °C (октябрь, ночь) — ОЦЕНКА
// источники: H — высота трубы; для АТЭЦ d, v, T из таблицы параметров выбросов
const SOURCES = [
  { name: 'АНПЗ — қондырғылар (20 м, болжам)', H: 20 },
  { name: 'АНПЗ факелдері (130 м)', H: 130 },
  { name: 'АТЭЦ №1 (60 м)', H: 60, d: 6, v: 1.91, T: 120 },
  { name: 'АТЭЦ №2 (120 м)', H: 120, d: 4.3, v: 5.26, T: 120 },
  { name: 'АТЭЦ №4 (180 м)', H: 180, d: 6.6, v: 2.29, T: 130 },
];
// типичные условия
const CASES = [
  { cls: 'B', u: 3, label: 'күндіз, күн ашық, жел 3 м/с' },
  { cls: 'D', u: 5, label: 'бұлтты / жел 5 м/с' },
  { cls: 'E', u: 3, label: 'түн, жел 3 м/с' },
  { cls: 'F', u: 1.5, label: 'тымық ашық түн (инверсия)' },
];
const WIND_EXP = { A: 0.07, B: 0.07, C: 0.10, D: 0.15, E: 0.35, F: 0.55 };
const DTHETA = { E: 0.02, F: 0.035 }; // К/м — устойчивые классы

// подъём факела по Бриггсу (окончательный)
function rise(s, cls, u10) {
  if (!s.d) return 0;
  const Ts = s.T + 273;
  const F = g * s.v * s.d * s.d / 4 * (Ts - Ta) / Ts;            // поток плавучести, м⁴/с³
  const u = Math.max(0.5, u10 * Math.pow(s.H / 10, WIND_EXP[cls]));
  if (DTHETA[cls]) {                                              // устойчиво
    const S = g / Ta * DTHETA[cls];
    return 2.6 * Math.cbrt(F / (u * S));
  }
  return (F < 55 ? 21.425 * Math.pow(F, 0.75) : 38.71 * Math.pow(F, 0.6)) / u; // нейтрально/неустойчиво
}

console.log('Ветер — вдоль оси факела; расстояние от трубы по ветру.\n');
for (const c of CASES) {
  console.log(`== ${c.cls}: ${c.label}`);
  for (const s of SOURCES) {
    const dh = rise(s, c.cls, c.u), He = s.H + dh;
    const src = { lat: 47.0, lng: 52.0, height_m: He, width_m: 0 };
    let best = { x: 0, C: 0 }; const prof = [];
    for (let x = 100; x <= 40000; x += 100) {
      // приёмник строго по ветру (ветер с запада → на восток)
      const rcp = { lat: 47.0, lng: 52.0 + x / (111320 * Math.cos(47 * Math.PI / 180)) };
      const C = plumeAt(src, rcp, 270, c.u, c.cls);
      prof.push([x, C]); if (C > best.C) best = { x, C };
    }
    const half = prof.filter(p => p[1] >= best.C / 2);
    const x0 = half[0]?.[0], x1 = half.at(-1)?.[0];
    const far = best.x >= 40000;
    console.log(`  ${s.name.padEnd(34)} эфф. высота ${String(Math.round(He)).padStart(3)} м` +
      (dh ? ` (+${Math.round(dh)} подъём)` : '') +
      ` | максимум у земли: ${far ? '> 40 км' : (best.x / 1000).toFixed(1) + ' км'}` +
      ` | зона ≥50%: ${x0 ? (x0 / 1000).toFixed(1) : '—'}–${far ? '>40' : (x1 / 1000).toFixed(1)} км`);
  }
}
