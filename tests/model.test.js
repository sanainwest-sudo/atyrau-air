// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
require('../model.js');
const { stabilityClass, plumeAt, rankSources } = globalThis.AirModel;

// реальные координаты постов Атырау (с карты ecodata.kz)
const STATIONS = [
  { name: 'ПНЗ№8', lat: 47.0964, lng: 51.9414 }, { name: 'ПНЗ№9', lat: 47.139, lng: 51.965 },
  { name: 'ПНЗ№6', lat: 47.156, lng: 51.981 }, { name: 'Перетаска', lat: 47.069, lng: 51.905 },
  { name: 'Химпоселок', lat: 47.089, lng: 51.935 }, { name: 'Мирный', lat: 47.076, lng: 51.911 },
  { name: 'Пропарка', lat: 47.073, lng: 51.951 }, { name: 'СМКВ103', lat: 47.112, lng: 51.922 },
  { name: 'СМКВ109', lat: 47.095, lng: 51.925 }, { name: 'СМКВ111', lat: 47.099, lng: 51.901 },
  { name: 'СМКВ112', lat: 47.105, lng: 51.916 }, { name: 'СМКВ113', lat: 47.093, lng: 51.887 },
  { name: 'ПНЗ№12', lat: 47.094, lng: 51.891 }, { name: 'ПНЗ№15', lat: 47.116, lng: 51.884 },
  { name: 'ПНЗ№17', lat: 47.135, lng: 51.869 },
];
const SOURCES = [
  { id: 'anpz', lat: 47.0718, lng: 51.9239, height_m: 60 },
  { id: 'kos_east', lat: 47.1255, lng: 52.0232, height_m: 0 },
  { id: 'pond', lat: 47.085, lng: 51.985, height_m: 0 },
  { id: 'oilbase', lat: 47.0621, lng: 51.8657, height_m: 10 },
];

// откуда должен дуть ветер, чтобы нести выброс от источника к центру постов
const C = { lat: STATIONS.reduce((a, s) => a + s.lat, 0) / STATIONS.length, lng: STATIONS.reduce((a, s) => a + s.lng, 0) / STATIONS.length };
function windFrom(src) {
  const ex = (C.lng - src.lng) * Math.cos(src.lat * Math.PI / 180), ny = C.lat - src.lat;
  return (Math.atan2(ex, ny) * 180 / Math.PI + 180 + 360) % 360;
}
// вечер: 4 часа, ветер гуляет вокруг направления «от источника к постам», ясная ночь, слабый ветер
function evening(src) {
  const d = windFrom(src);
  return {
    '2026-10-20 20': { dir: d - 25, speed: 1.5, rad: 0, cloud: 10 },
    '2026-10-20 21': { dir: d - 8, speed: 1.8, rad: 0, cloud: 10 },
    '2026-10-20 22': { dir: d + 10, speed: 2.2, rad: 0, cloud: 60 },
    '2026-10-20 23': { dir: d + 25, speed: 1.2, rad: 0, cloud: 10 },
  };
}

// искусственные наблюдения: один источник выбрасывает; модель «видит» ветер с ошибкой dirError°, плюс шум
function synth(src, hours, dirError = 10, Q = 2e6) {
  const obs = [];
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.4;
  for (const [hour, w] of Object.entries(hours)) {
    const cls = stabilityClass(w.speed, w.rad, w.cloud);
    for (const st of STATIONS) obs.push({ hour, station: st, excess: Math.max(0, Q * plumeAt(src, st, w.dir + dirError, w.speed, cls) + noise()) });
  }
  return obs;
}

test('класс устойчивости: ясная тихая ночь — F, солнечный день со слабым ветром — A, пасмурно с ветром — D', () => {
  assert.equal(stabilityClass(1, 0, 0), 'F');
  assert.equal(stabilityClass(1, 700, 0), 'A');
  assert.equal(stabilityClass(7, 100, 100), 'D');
});

test('пост против ветра не получает ничего', () => {
  const src = SOURCES[0];
  // ветер с востока (90°) → факел уходит на запад; пост восточнее источника
  assert.equal(plumeAt(src, { lat: 47.0718, lng: 51.97 }, 90, 3, 'D'), 0);
  assert.ok(plumeAt(src, { lat: 47.0718, lng: 51.88 }, 90, 3, 'D') > 0);
});

test('высота важна: ночью в 1 км наземный источник даёт у земли намного больше, чем труба 60 м', () => {
  const rcp = { lat: 47.0718, lng: 51.9239 - 1000 / (111320 * Math.cos(47.07 * Math.PI / 180)) };
  const ground = plumeAt({ lat: 47.0718, lng: 51.9239, height_m: 0 }, rcp, 90, 1.5, 'F');
  const stack = plumeAt({ lat: 47.0718, lng: 51.9239, height_m: 60 }, rcp, 90, 1.5, 'F');
  assert.ok(ground > 50 * stack, `наземный ${ground}, труба ${stack}`);
});

for (const src of SOURCES) {
  test(`по искусственному выбросу (ошибка ветра 10°) находит источник «${src.id}»`, () => {
    const hours = evening(src);
    const { ranking } = rankSources(SOURCES, synth(src, hours), hours);
    const info = ranking.map(r => `${r.source.id}:${r.explained.toFixed(2)}`).join(' ');
    assert.equal(ranking[0].source.id, src.id, info);
    assert.ok(ranking[0].explained > 0.5, info);
    assert.ok(ranking[0].share > 0.5, info);
  });
}

test('нет превышения — нет ответа (все доли 0)', () => {
  const obs = STATIONS.map(st => ({ hour: '2026-10-20 20', station: st, excess: 0 }));
  const { ranking, total } = rankSources(SOURCES, obs, evening(SOURCES[0]));
  assert.equal(total, 0);
  assert.ok(ranking.every(r => r.share === 0));
});

test('одна точка, разная высота: модель отличает наземный выброс от трубы 60 м', () => {
  const ground = { id: 'ground', lat: 47.0718, lng: 51.9239, height_m: 0 };
  const stack = { id: 'stack', lat: 47.0718, lng: 51.9239, height_m: 60 };
  for (const truth of [ground, stack]) {
    const hours = evening(truth);
    const { ranking } = rankSources([ground, stack], synth(truth, hours), hours);
    const info = ranking.map(r => `${r.source.id}:${r.explained.toFixed(2)}`).join(' ');
    assert.equal(ranking[0].source.id, truth.id, info);
    console.log(`  истина ${truth.id} → ${info}`);
  }
});

test('площадной источник (Сасық сай): ближний край учитывается, по выбросу из пруда находит пруд', () => {
  const pond = require('../sources.json').find(s => s.id === 'tukhlaya');
  // ясная тихая ночь, ветер с востока — к городу; пост Химпоселок (~3 км от западного края, ~8 км от центра)
  const him = STATIONS.find(s => s.name === 'Химпоселок');
  const pts = globalThis.AirModel.areaPoints(pond.area);
  const per = list => list.reduce((a, [lat, lng]) => a + plumeAt({ lat, lng, height_m: 0, width_m: 500 }, him, 95, 1.5, 'F'), 0) / list.length;
  const near = per(pts.filter(p => p[1] < 52.01)), far = per(pts.filter(p => p[1] > 52.05));
  console.log(`  Химпоселок: точка у ближнего края ${near.toExponential(2)}, у дальнего ${far.toExponential(2)} (×${(near / far).toFixed(1)})`);
  assert.ok(near > 2 * far, 'ближний край должен весить больше дальнего');
  const hours = evening(pond);
  const { ranking } = rankSources([...SOURCES, pond], synth(pond, hours), hours);
  assert.equal(ranking[0].source.id, 'tukhlaya', ranking.map(r => `${r.source.id}:${r.explained.toFixed(2)}`).join(' '));
});

// ---- Құбыр түтінінің көтерілуі (Бриггс) және температураны салмақтау ----
const { plumeRise, localTemp } = globalThis.AirModel;
const STACK = { d_m: 6.6, v_ms: 2.29, ts_c: 130 }; // АТЭЦ №4 (НДВ)

test('көтерілу: stack немесе Ta жоқ болса — 0', () => {
  assert.strictEqual(plumeRise(undefined, 10, 5, 'D', 1000), 0);
  assert.strictEqual(plumeRise(STACK, undefined, 5, 'D', 1000), 0);
  assert.strictEqual(plumeRise({ ...STACK, ts_c: 5 }, 10, 5, 'D', 1000), 0); // газ ауадан суық
});

test('көтерілу: қашықтықпен өседі, содан соң шектік мәнде тұрақталады', () => {
  const a = plumeRise(STACK, 10, 5, 'D', 100), b = plumeRise(STACK, 10, 5, 'D', 300);
  const c = plumeRise(STACK, 10, 5, 'D', 40000), d = plumeRise(STACK, 10, 5, 'D', 80000);
  assert.ok(a > 0 && b > a && c >= b); // 300 м-де әлі өсіп жатыр, 40 км-де шекке жеткен
  assert.strictEqual(c, d);
});

test('көтерілу: газ ыстық болған сайын көп, тұрақты түнде (F) бейтараптан аз', () => {
  assert.ok(plumeRise({ ...STACK, ts_c: 160 }, 10, 5, 'D', 5000) > plumeRise(STACK, 10, 5, 'D', 5000));
  assert.ok(plumeRise(STACK, 10, 3, 'F', 40000) < plumeRise(STACK, 10, 3, 'D', 40000));
});

test('stack жоқ көз Ta-ға тәуелсіз: нәтиже өзгермейді', () => {
  const src = { lat: 47.0, lng: 52.0, height_m: 60 };
  const rcp = { lat: 47.0, lng: 52.0 + 2000 / (111320 * Math.cos(47 * Math.PI / 180)) };
  assert.strictEqual(plumeAt(src, rcp, 270, 4, 'D'), plumeAt(src, rcp, 270, 4, 'D', 10));
});

test('ыстық құбыр: жақын қашықтықта жерге түсетін концентрация азаяды', () => {
  const base = { lat: 47.0, lng: 52.0, height_m: 120 };
  const rcp = { lat: 47.0, lng: 52.0 + 1000 / (111320 * Math.cos(47 * Math.PI / 180)) };
  const plain = plumeAt(base, rcp, 270, 5, 'D', 10);
  const hot = plumeAt({ ...base, stack: STACK }, rcp, 270, 5, 'D', 10);
  assert.ok(hot < plain);
});

test('localTemp: жақын бекеттің салмағы көп; бекет жоқ болса — fallback', () => {
  const p = { lat: 47.0, lng: 52.0 };
  const near = { lat: 47.0, lng: 52.0 + 2000 / (111320 * Math.cos(47 * Math.PI / 180)), temp: 20 };
  const far = { lat: 47.0, lng: 52.0 + 8000 / (111320 * Math.cos(47 * Math.PI / 180)), temp: 30 };
  const t = localTemp(p, [near, far], 15);
  assert.ok(t > 20 && t < 21); // 1/d²: 16 : 1 → ≈ 20,6
  assert.strictEqual(localTemp(p, [], 15), 15);
  assert.strictEqual(localTemp(p, [{ ...near, temp: null }], 15), 15);
});

test('riseAt: stack жоқ көзге 0, бар көзге оң; бекет температурасы Open-Meteo-дан басымдау', () => {
  const { riseAt } = globalThis.AirModel;
  const src = { lat: 47.0, lng: 52.0, height_m: 180 };
  const w = { speed: 5, rad: 0, cloud: 100, temp: 10 };
  assert.strictEqual(riseAt(src, w, 5000), 0);
  assert.ok(riseAt({ ...src, stack: STACK }, w, 5000) > 0);
  // бекет 30 °C көрсетсе, түтін мен ауа айырмасы азаяды → көтерілу кемиді
  const hotAir = { ...w, stationTemps: [{ lat: 47.0, lng: 52.01, temp: 30 }] };
  assert.ok(riseAt({ ...src, stack: STACK }, hotAir, 5000) < riseAt({ ...src, stack: STACK }, w, 5000));
});

test('rankSources: pred мен rows сәйкес; жасанды шығарындыда болжам нақты мәнге жақын', () => {
  const src = SOURCES[2]; // тоған
  const hours = evening(src);
  const obs = synth(src, hours, 0);
  const { ranking, rows, n } = rankSources(SOURCES, obs, hours);
  const best = ranking[0];
  assert.strictEqual(best.source.id, 'pond');
  assert.strictEqual(best.pred.length, n);
  assert.strictEqual(rows.length, n);
  // ең көп артығы бар бекетте болжам да ең үлкендердің қатарында (нақты мәннің ±35% шегінде)
  const i = rows.reduce((k, o, j) => (o.excess > rows[k].excess ? j : k), 0);
  assert.ok(Math.abs(best.pred[i] - rows[i].excess) <= 0.35 * rows[i].excess + 1, `факт ${rows[i].excess}, модель ${best.pred[i]}`);
});
