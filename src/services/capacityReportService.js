const CenterBookingSnapshot = require('../models/CenterBookingSnapshot');
const CenterTariffGroup = require('../models/CenterTariffGroup');
const CenterClassPool = require('../models/CenterClassPool');
const { normalizeName } = require('./aimharderService');

const WEEKDAY_LABELS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

// Últimas `weeks` semanas ISO completas (lunes-domingo) que terminan en el último domingo ya cerrado.
function getCapacityRange(weeks, today = new Date()) {
  const w = Math.min(Math.max(parseInt(weeks, 10) || 4, 1), 8);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  // getDay(): 0 = domingo. Si hoy es domingo la semana aún no está completa → domingo anterior.
  const daysSinceSunday = base.getDay() === 0 ? 7 : base.getDay();
  const end = new Date(base);
  end.setDate(end.getDate() - daysSinceSunday);
  const start = new Date(end);
  start.setDate(start.getDate() - (w * 7 - 1));
  return { start: fmt(start), end: fmt(end), weeks: w };
}

// Lunes = 0 … domingo = 6
function weekdayIndex(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return (d.getDay() + 6) % 7;
}

function mostFrequent(counter) {
  let best = '';
  let bestCount = -1;
  for (const [key, count] of counter) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

const IMPLICIT_POOL_ID = 'all';

// Bolsa complementaria (p. ej. Open): complemento de las tarifas que nunca es la razón de que un box se llene.
// Si el admin no lo ha fijado, se deduce del nombre ("Open").
function isComplementaryPool(pool) {
  if (typeof pool.complementary === 'boolean') return pool.complementary;
  return /\bopen\b/i.test(normalizeName(pool.name || ''));
}

// Franjas de demanda por hora de inicio (HH:MM)
const BANDS = [
  { key: 'manana', label: 'Mañana (hasta 12:00)' },
  { key: 'mediodia', label: 'Mediodía (12:00–16:00)' },
  { key: 'tarde', label: 'Tarde (16:00–18:00)' },
  { key: 'noche', label: 'Tarde-noche (desde 18:00)' },
];

function bandKeyOf(classTime) {
  const hour = parseInt(String(classTime || '').split(':')[0], 10);
  if (!Number.isFinite(hour) || hour < 12) return 'manana';
  if (hour < 16) return 'mediodia';
  if (hour < 18) return 'tarde';
  return 'noche';
}

const bandLabelOf = (key) => (BANDS.find((b) => b.key === key) || {}).label || key;

// Una clase (tipo × franja) solo marca el límite si pesa al menos esto en las reservas:
// si se llena una clase minoritaria (p. ej. una sesión semanal de Halterofilia), la gente cambia de clase o se abre otra.
const MIN_LIMITING_SHARE = 0.05;

// Clase de público propio (p. ej. "+65"): casi todas sus reservas son de clientes que apenas van a otra clase.
// Un cliente nuevo "como los actuales" no reserva ahí, así que no limita al resto; se informa aparte.
// `clientClasses` = iterable de Map(clase → reservas) por cliente del ámbito. La clase con más reservas
// del ámbito nunca es de público propio (es la principal: lo normal es que sus clientes solo vayan a ella).
const SEGMENT_CLIENT_SHARE = 0.75; // un cliente "es" de la clase si al menos este % de sus reservas son en ella
const SEGMENT_MIN_SHARE = 0.9; // la clase es de público propio si al menos este % de sus reservas son de esos clientes
const SEGMENT_MIN_CLIENTS = 3;
function detectSegments(clientClasses) {
  const stats = new Map(); // clase → { bookings, clients, exclusiveBookings }
  const maps = [...clientClasses];
  for (const m of maps) {
    let total = 0;
    for (const n of m.values()) total += n;
    for (const [cls, n] of m) {
      const e = stats.get(cls) || { bookings: 0, clients: 0, exclusiveBookings: 0 };
      e.bookings += n;
      e.clients += 1;
      if (total > 0 && n / total >= SEGMENT_CLIENT_SHARE) e.exclusiveBookings += n;
      stats.set(cls, e);
    }
  }
  let top = null;
  for (const [cls, e] of stats) if (!top || e.bookings > stats.get(top).bookings) top = cls;
  const segments = new Map(); // clase → { clients }
  for (const [cls, e] of stats) {
    if (cls === top || e.clients < SEGMENT_MIN_CLIENTS || e.bookings === 0) continue;
    if (e.exclusiveBookings / e.bookings >= SEGMENT_MIN_SHARE) segments.set(cls, { clients: e.clients });
  }
  // Clientes "generales": los que reservan alguna clase que no es de público propio
  const generalClients = maps.filter((m) => [...m.entries()].some(([cls, n]) => n > 0 && !segments.has(cls))).length;
  return { segments, generalClients };
}

// Celda = tipo de clase en una franja (o en una hora). Acumula plazas, reservas y huecos de todas sus sesiones.
const newCell = (extra) => ({ capacity: 0, booked: 0, free: 0, ...extra });
function addToCell(map, key, extra, capacity, booked) {
  const cell = map.get(key) || newCell(extra);
  cell.capacity += capacity;
  cell.booked += booked;
  cell.free += Math.max(0, capacity - booked); // una clase sobrerreservada no resta huecos
  map.set(key, cell);
}

// Margen ponderado por demanda real de cada TIPO DE CLASE en cada franja: los clientes nuevos reservan
// como los actuales (mismo reparto entre CrossFit, Endurance, Halterofilia… y entre franjas), así que una
// clase que nadie reserva no aporta margen y lo que limita es la clase con peso que antes se llena.
// Con N clientes generales, una celda con R reservas y L huecos admite N·L/R clientes nuevos (× dispersión).
// `cells` = iterable de { bandKey, className, capacity, booked, free } (totales del periodo).
// `segments` = clases de público propio (detectSegments): no limitan y se calculan con sus propios clientes.
// `limitShareBase` = reservas generales con las que se mide el 5 % mínimo para limitar (las del centro, para
// que una clase limite o no igual en su bolsa que en el total); por defecto, las del propio ámbito.
function buildBandHeadroom(cells, { weeks, dispersion, activeBookers, generalClients, segments = new Map(), limitShareBase = null }) {
  const list = [...cells].map((c) => ({ ...c, segment: segments.has(c.className) }));
  const generalBooked = list.filter((c) => !c.segment).reduce((s, c) => s + c.booked, 0);
  const shareBase = limitShareBase > 0 ? limitShareBase : generalBooked;
  const totalBooked = list.reduce((s, c) => s + c.booked, 0);
  const cellRows = list.map((c) => {
    const demandShare = !c.segment && generalBooked > 0 ? c.booked / generalBooked : null;
    const freeSlotsPerWeek = c.free / weeks;
    const ownClients = c.segment ? segments.get(c.className).clients : generalClients;
    const fitsClients = c.booked > 0 && ownClients > 0 ? (ownClients * c.free) / c.booked : null;
    const fitsClientsRealistic = fitsClients !== null ? fitsClients * dispersion : null;
    return {
      bandKey: c.bandKey,
      bandLabel: bandLabelOf(c.bandKey),
      className: c.className,
      capacityPerWeek: round1(c.capacity / weeks),
      bookedPerWeek: round1(c.booked / weeks),
      freeSlotsPerWeek: round1(freeSlotsPerWeek),
      occupancyPct: round1(c.capacity > 0 ? (c.booked / c.capacity) * 100 : 0),
      demandSharePct: demandShare === null ? null : round1(demandShare * 100),
      fitsClientsRealistic: round1(fitsClientsRealistic),
      noDemand: c.booked === 0,
      segment: c.segment,
      segmentClients: c.segment ? ownClients : null,
      canLimit: !c.segment && shareBase > 0 && c.booked / shareBase >= MIN_LIMITING_SHARE,
      _raw: fitsClientsRealistic,
    };
  });
  const pickMin = (rows) => rows.reduce((best, r) => (r._raw !== null && (!best || r._raw < best._raw) ? r : best), null);
  const eligible = cellRows.filter((r) => r.canLimit && r._raw !== null);
  const limiting = pickMin(eligible.length > 0 ? eligible : cellRows.filter((r) => !r.segment));

  const bandRows = BANDS.map(({ key, label }) => {
    const inBand = cellRows.filter((r) => r.bandKey === key);
    const src = list.filter((c) => c.bandKey === key);
    const capacity = src.reduce((s, c) => s + c.capacity, 0);
    const booked = src.reduce((s, c) => s + c.booked, 0);
    const free = src.reduce((s, c) => s + c.free, 0);
    const bandLimit = pickMin(inBand.filter((r) => r.canLimit)) || pickMin(inBand.filter((r) => !r.segment));
    return {
      key,
      label,
      classNames: [...new Set(inBand.map((r) => r.className).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es')),
      unusedClassNames: [...new Set(inBand.filter((r) => r.noDemand).map((r) => r.className).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es')),
      segmentClassNames: [...new Set(inBand.filter((r) => r.segment).map((r) => r.className).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es')),
      capacityPerWeek: round1(capacity / weeks),
      bookedPerWeek: round1(booked / weeks),
      freeSlotsPerWeek: round1(free / weeks),
      occupancyPct: round1(capacity > 0 ? (booked / capacity) * 100 : 0),
      demandSharePct: round1(totalBooked > 0 ? (booked / totalBooked) * 100 : 0),
      usableFreeSlotsPerWeek: round1(src.filter((c) => c.booked > 0 && !c.segment).reduce((s, c) => s + c.free, 0) / weeks),
      fitsClientsRealistic: bandLimit ? bandLimit.fitsClientsRealistic : null,
      limitingClass: bandLimit ? bandLimit.className : null,
    };
  });
  const limitingBandRow = limiting ? bandRows.find((b) => b.key === limiting.bandKey) : null;
  const headroom = limiting ? limiting._raw : null;
  const capacity = headroom !== null ? activeBookers + headroom : null;
  const bandOrder = new Map(BANDS.map((b, i) => [b.key, i]));
  return {
    bands: bandRows,
    cells: cellRows
      .map(({ _raw, ...r }) => ({ ...r, limiting: Boolean(limiting) && r.bandKey === limiting.bandKey && r.className === limiting.className }))
      .sort((a, b) => (bandOrder.get(a.bandKey) - bandOrder.get(b.bandKey)) || (b.demandSharePct - a.demandSharePct)),
    segments: [...segments.keys()].map((className) => {
      const rows = cellRows.filter((r) => r.className === className);
      const cap = list.filter((c) => c.className === className).reduce((s, c) => s + c.capacity, 0);
      const bk = list.filter((c) => c.className === className).reduce((s, c) => s + c.booked, 0);
      const fr = list.filter((c) => c.className === className).reduce((s, c) => s + c.free, 0);
      if (rows.length === 0) return null;
      return {
        className,
        clients: segments.get(className).clients,
        occupancyPct: round1(cap > 0 ? (bk / cap) * 100 : 0),
        freeSlotsPerWeek: round1(fr / weeks),
        fitsClientsRealistic: round1(bk > 0 ? ((segments.get(className).clients * fr) / bk) * dispersion : null),
      };
    }).filter(Boolean),
    effective: {
      headroom: round1(headroom),
      limitingBand: limiting ? limiting.bandLabel : null,
      limitingClass: limiting ? limiting.className : null,
      capacity: round1(capacity),
      loadPct: capacity ? round1((activeBookers / capacity) * 100) : null,
    },
    summary: {
      currentClients: activeBookers,
      capacityClients: round1(capacity),
      extraClients: round1(headroom),
      limitingBand: limiting ? limiting.bandLabel : null,
      limitingBandFreeSlotsPerWeek: limitingBandRow ? limitingBandRow.freeSlotsPerWeek : null,
      limitingBandOccupancyPct: limitingBandRow ? limitingBandRow.occupancyPct : null,
      limitingClass: limiting ? limiting.className : null,
      limitingClassFreeSlotsPerWeek: limiting ? limiting.freeSlotsPerWeek : null,
      limitingClassOccupancyPct: limiting ? limiting.occupancyPct : null,
      minLimitingSharePct: MIN_LIMITING_SHARE * 100,
    },
  };
}

// Plan de clientes nuevos por hora: los H clientes que caben reservan como los clientes generales actuales
// (mismo reparto real entre tipos de clase y horas) y se ve qué horas se llenan. Cada tipo de clase recibe
// H·R/N reservas nuevas a la semana (R = sus reservas/semana, N = clientes generales).
// `slotCells` = iterable de { classTime, className, capacity, booked, free } (totales del periodo, sin días cerrados).
// No reciben clientes nuevos ni aportan huecos: las clases que nadie reserva y las de público propio (+65).
function buildNewClientsPlan(slotCells, effective, { generalClients, weeks, segments = new Map() }) {
  const H = effective && effective.headroom > 0 ? Math.floor(effective.headroom) : 0;
  const N = generalClients > 0 ? generalClients : 0;
  const list = [...slotCells];
  const generalBookedPerWeek = list.filter((c) => !segments.has(c.className)).reduce((s, c) => s + c.booked, 0) / weeks;
  const avg = N > 0 ? generalBookedPerWeek / N : 0;
  const byTime = new Map();
  for (const c of list) {
    const arr = byTime.get(c.classTime) || [];
    arr.push(c);
    byTime.set(c.classTime, arr);
  }
  const rows = [...byTime.entries()].map(([classTime, types]) => {
    let capacityPerWeek = 0;
    let bookedPerWeek = 0;
    let freeSlotsPerWeek = 0;
    let newBookingsPerWeek = 0;
    let absorbClients = null;
    const fullClassNames = [];
    const unusedClassNames = [];
    const segmentClassNames = [];
    for (const t of types) {
      const tCap = t.capacity / weeks;
      const tBooked = t.booked / weeks;
      const tFree = t.free / weeks;
      if (segments.has(t.className)) {
        segmentClassNames.push(t.className);
        continue;
      }
      if (t.booked === 0) {
        if (t.className) unusedClassNames.push(t.className);
        continue;
      }
      const share = generalBookedPerWeek > 0 ? tBooked / generalBookedPerWeek : 0;
      const tNew = Math.min(tFree, N > 0 ? (H * tBooked) / N : 0);
      capacityPerWeek += tCap;
      bookedPerWeek += tBooked;
      freeSlotsPerWeek += tFree;
      newBookingsPerWeek += tNew;
      if (tCap > 0 && ((tBooked + tNew) / tCap) * 100 >= 95 && t.className) fullClassNames.push(t.className);
      if (share > 0 && N > 0) {
        const absorb = (N * tFree) / tBooked;
        if (absorbClients === null || absorb < absorbClients) absorbClients = absorb;
      }
    }
    const resultingBookedPerWeek = bookedPerWeek + newBookingsPerWeek;
    const resultingOccupancyPct = capacityPerWeek > 0 ? (resultingBookedPerWeek / capacityPerWeek) * 100 : 0;
    const status = resultingOccupancyPct >= 95 ? 'llena' : resultingOccupancyPct >= 85 ? 'casi' : 'sitio';
    const sortNames = (a) => [...new Set(a)].sort((x, y) => x.localeCompare(y, 'es'));
    return {
      classTime,
      classNames: sortNames(types.map((t) => t.className).filter(Boolean)),
      unusedClassNames: sortNames(unusedClassNames),
      segmentClassNames: sortNames(segmentClassNames),
      fullClassNames: sortNames(fullClassNames),
      capacityPerWeek: round1(capacityPerWeek),
      bookedPerWeek: round1(bookedPerWeek),
      occupancyPct: round1(capacityPerWeek > 0 ? (bookedPerWeek / capacityPerWeek) * 100 : 0),
      freeSlotsPerWeek: round1(freeSlotsPerWeek),
      demandShare: Math.round((generalBookedPerWeek > 0 ? bookedPerWeek / generalBookedPerWeek : 0) * 1000) / 1000,
      newBookingsPerWeek: round1(newBookingsPerWeek),
      resultingBookedPerWeek: round1(resultingBookedPerWeek),
      resultingOccupancyPct: round1(resultingOccupancyPct),
      status,
      absorbClients: round1(absorbClients),
      _freeAfter: Math.max(0, capacityPerWeek - resultingBookedPerWeek),
    };
  }).sort((a, b) => String(a.classTime).localeCompare(String(b.classTime)));
  const roomFreeSlotsPerWeek = rows.filter((r) => r.status === 'sitio').reduce((s, r) => s + r._freeAfter, 0);
  return {
    newClients: H,
    avgClassesPerWeek: round1(avg || null),
    rows: rows.map(({ _freeAfter, ...r }) => r),
    fullHours: rows.filter((r) => r.status !== 'sitio').map((r) => r.classTime),
    roomHours: rows.filter((r) => r.status === 'sitio').map((r) => r.classTime),
    roomFreeSlotsPerWeek: round1(roomFreeSlotsPerWeek),
    extraClientsIfDirected: avg > 0 ? Math.floor(roomFreeSlotsPerWeek / avg) : 0,
  };
}

async function buildCapacityReport(centerId, options = {}) {
  const {
    weeks: rawWeeks = 4,
    dispersionFactor = 0.8,
    unlimitedClassesPerWeek = 6,
    includeNoCoach = false,
  } = options;

  const range = getCapacityRange(rawWeeks);
  const [snapshots, groups, dbPools] = await Promise.all([
    CenterBookingSnapshot.find({ center: centerId, date: { $gte: range.start, $lte: range.end } })
      .sort({ date: 1 })
      .lean(),
    CenterTariffGroup.find({ center: centerId }).lean(),
    CenterClassPool.find({ center: centerId }).sort({ order: 1, createdAt: 1 }).lean(),
  ]);

  const daysWithData = snapshots.length;
  // Con datos parciales los promedios semanales se calculan sobre las semanas realmente cubiertas.
  const effectiveWeeks = daysWithData > 0 ? daysWithData / 7 : range.weeks;
  const dispersion = Number(dispersionFactor);
  const unlimitedPerWeek = Number(unlimitedClassesPerWeek);

  // Sin bolsas definidas: una bolsa implícita con todas las clases (comportamiento histórico).
  const hasPools = dbPools.length > 0;
  const pools = hasPools
    ? dbPools.map((p) => ({
        id: String(p._id),
        name: p.name,
        isDefault: Boolean(p.isDefault),
        complementary: isComplementaryPool(p),
        patterns: p.patterns || [],
        normPatterns: (p.patterns || []).map((x) => normalizeName(x)).filter(Boolean),
      }))
    : [{ id: IMPLICIT_POOL_ID, name: 'Todas las clases', isDefault: true, complementary: false, patterns: [], normPatterns: [] }];
  const defaultPool = pools.find((p) => p.isDefault) || null;

  // Sin bolsas: se excluyen clases sin coach y "Open". Con bolsas Open es una bolsa más.
  const includeLegacyClass = (c) => {
    if (includeNoCoach) return true;
    if (!String(c.coachName || '').trim()) return false;
    if (/open/i.test(c.className || '')) return false;
    return true;
  };

  // Primera bolsa (por orden) con algún patrón contenido en el nombre; si no, la por defecto; si no, null.
  const poolForClass = (className) => {
    if (!hasPools) return pools[0];
    const norm = normalizeName(className || '');
    for (const pool of pools) {
      if (pool.normPatterns.some((pt) => norm.includes(pt))) return pool;
    }
    return defaultPool;
  };

  const state = new Map(); // poolId → acumuladores
  for (const pool of pools) {
    state.set(pool.id, {
      capacity: 0,
      classes: 0,
      bookings: 0,
      clients: new Map(), // clientKey → reservas en la bolsa
      slotMap: new Map(),
      weekdayMap: new Map(),
      cells: new Map(), // `${banda}|${clase}` → celda (tipo de clase × franja)
      slotCells: new Map(), // `${hora}|${clase}` → celda (tipo de clase × hora)
      clientClasses: new Map(), // clientKey → Map(clase → reservas)
    });
  }
  const totalCells = new Map(); // celdas de todas las bolsas no complementarias
  const totalSlotCells = new Map();
  const ignored = new Map(); // className → count
  const clientMap = new Map(); // key → { bookings, memberships, byPool: Map }
  let totalCapacity = 0;
  let totalClasses = 0;
  let totalBookings = 0;

  // Día cerrado: tras el filtro de clases no suma ninguna reserva (p. ej. clases publicadas en fin de semana
  // sin nadie apuntado). No cuenta en ninguna suma, pero sí en el calendario (effectiveWeeks).
  const closedDates = [];
  const openSnapshots = [];
  for (const snap of snapshots) {
    let dayBookings = 0;
    for (const c of snap.classes || []) {
      if (!hasPools && !includeLegacyClass(c)) continue;
      const pool = poolForClass(c.className);
      if (!pool || pool.complementary) continue; // las bolsas complementarias no cuentan para abrir/cerrar el día
      dayBookings += Number(c.bookedCount) || (c.athletes || []).length || 0;
    }
    if (dayBookings === 0) closedDates.push(snap.date);
    else openSnapshots.push(snap);
  }

  for (const snap of openSnapshots) {
    const wd = weekdayIndex(snap.date);
    for (const c of snap.classes || []) {
      if (!hasPools && !includeLegacyClass(c)) continue;
      const pool = poolForClass(c.className);
      if (!pool) {
        const label = String(c.className || '').trim() || '(sin nombre)';
        ignored.set(label, (ignored.get(label) || 0) + 1);
        continue;
      }
      const st = state.get(pool.id);
      const capacity = Number(c.capacity) || 0;
      const booked = Number(c.bookedCount) || 0;
      st.capacity += capacity;
      st.classes += 1;
      const inScope = !pool.complementary; // los totales del centro solo suman bolsas no complementarias
      if (inScope) {
        totalCapacity += capacity;
        totalClasses += 1;
      }

      const className = String(c.className || '').trim();
      const bandKey = bandKeyOf(c.classTime);
      const cellKey = `${bandKey}|${className}`;
      const slotKey = `${c.classTime}|${className}`;
      addToCell(st.cells, cellKey, { bandKey, className }, capacity, booked);
      addToCell(st.slotCells, slotKey, { classTime: c.classTime, className }, capacity, booked);
      if (inScope) {
        addToCell(totalCells, `${pool.id}|${cellKey}`, { bandKey, className }, capacity, booked);
        addToCell(totalSlotCells, `${pool.id}|${slotKey}`, { classTime: c.classTime, className }, capacity, booked);
      }

      const slot = st.slotMap.get(c.classTime) || { capacity: 0, booked: 0, classNames: new Set() };
      if (className) slot.classNames.add(className);
      slot.capacity += capacity;
      slot.booked += booked;
      st.slotMap.set(c.classTime, slot);

      const day = st.weekdayMap.get(wd) || { capacity: 0, booked: 0, dates: new Set() };
      day.capacity += capacity;
      day.booked += booked;
      day.dates.add(snap.date);
      st.weekdayMap.set(wd, day);

      for (const a of c.athletes || []) {
        const key = a.aimharderUserId || normalizeName(a.name || '');
        if (!key) continue;
        const client = clientMap.get(key) || { bookings: 0, scopeBookings: 0, memberships: new Map(), byPool: new Map(), byClass: new Map() };
        if (inScope) client.byClass.set(className, (client.byClass.get(className) || 0) + 1);
        const poolClient = st.clientClasses.get(key) || new Map();
        poolClient.set(className, (poolClient.get(className) || 0) + 1);
        st.clientClasses.set(key, poolClient);
        client.bookings += 1;
        if (inScope) client.scopeBookings += 1;
        const m = a.membership || '';
        client.memberships.set(m, (client.memberships.get(m) || 0) + 1);
        client.byPool.set(pool.id, (client.byPool.get(pool.id) || 0) + 1);
        clientMap.set(key, client);
        st.clients.set(key, (st.clients.get(key) || 0) + 1);
        st.bookings += 1;
        if (inScope) totalBookings += 1;
      }
    }
  }

  const weeklySlots = totalCapacity / effectiveWeeks;
  const weeklyClasses = totalClasses / effectiveWeeks;
  // Cliente activo del centro = al menos una reserva en una bolsa no complementaria
  const scopeClients = [...clientMap.values()].filter((c) => c.scopeBookings > 0);
  const activeBookers = scopeClients.length;
  const realAvg = activeBookers > 0 ? totalBookings / activeBookers / effectiveWeeks : null;

  // Tarifas: nombre normalizado o alias → item
  const tariffLookup = new Map();
  for (const group of groups) {
    for (const item of group.items || []) {
      for (const label of [item.name, ...(item.aliases || [])]) {
        const key = normalizeName(label || '');
        if (key && !tariffLookup.has(key)) tariffLookup.set(key, item);
      }
    }
  }

  // Tarifa de un cliente = la membresía más frecuente en sus reservas
  const membershipOfClient = (client) => mostFrequent(client.memberships);
  const membershipNames = new Set([...clientMap.values()].map(membershipOfClient));

  const parseClassesPerMonth = (name) => {
    const m = String(name || '').match(/(\d+)\s*clases?\s*(?:\/|al|por)?\s*mes/i);
    return m ? Number(m[1]) : null;
  };
  const baseOfName = (name) => normalizeName(String(name || '').split(' - ')[0]);
  const PERIOD_PREFIX = /^(trimestral|semestral|anual)\s+/;
  const inferredItem = (name, classesPerMonth, excludeFromCapacity = false) => ({
    name, classesPerMonth, unlimited: false, excludeFromCapacity, aliases: [],
  });

  // Devuelve { source: 'configured' | 'inferred' | 'unmapped', item, inferredClassesPerMonth }.
  // Las tarifas deducidas se comportan como una única asignación sobre todas las bolsas.
  const resolveCache = new Map();
  const resolveMembership = (membership) => {
    if (resolveCache.has(membership)) return resolveCache.get(membership);
    const resolve = () => {
      const norm = normalizeName(membership || '');
      const configured = tariffLookup.get(norm);
      if (configured) return { source: 'configured', item: configured, inferredClassesPerMonth: null };
      if (!norm || norm === '(sin tarifa)') return { source: 'unmapped', item: null, inferredClassesPerMonth: null };

      const own = parseClassesPerMonth(membership);
      if (own !== null) return { source: 'inferred', item: inferredItem(membership, own), inferredClassesPerMonth: own };

      if (/bono/i.test(membership)) {
        return { source: 'inferred', item: inferredItem(membership, null, true), inferredClassesPerMonth: null };
      }

      const stripped = norm.replace(PERIOD_PREFIX, '');
      if (stripped !== norm && stripped) {
        const viaConfigured = tariffLookup.get(stripped);
        if (viaConfigured) {
          const cpm = viaConfigured.classesPerMonth ?? null;
          return { source: 'inferred', item: viaConfigured, inferredClassesPerMonth: cpm };
        }
        for (const other of membershipNames) {
          if (other === membership) continue;
          const n = parseClassesPerMonth(other);
          if (n !== null && baseOfName(other) === stripped) {
            return { source: 'inferred', item: inferredItem(membership, n), inferredClassesPerMonth: n };
          }
        }
      }
      return { source: 'unmapped', item: null, inferredClassesPerMonth: null };
    };
    const out = resolve();
    resolveCache.set(membership, out);
    return out;
  };
  const poolNameById = new Map(pools.map((p) => [p.id, p.name]));
  const allPoolIds = pools.map((p) => p.id);
  const poolComplementaryById = new Map(pools.map((p) => [p.id, p.complementary]));

  // Repartos efectivos de una tarifa: [{ poolIds, weekly, classesPerMonth, unlimited }]
  // Las clases/mes se pasan a semana: x12 meses / 52 semanas.
  const weeklyOf = (a) => (a.unlimited
    ? unlimitedPerWeek
    : (a.classesPerMonth !== null && a.classesPerMonth !== undefined ? (a.classesPerMonth * 12) / 52 : null));
  const effectiveAllowances = (item) => {
    const out = [];
    const configured = hasPools ? (item.allowances || []) : [];
    if (configured.length > 0) {
      for (const a of configured) {
        const poolIds = (a.pools || []).map(String).filter((id) => poolNameById.has(id));
        const weekly = weeklyOf(a);
        if (poolIds.length === 0 || weekly === null || !Number.isFinite(weekly)) continue;
        out.push({ poolIds, weekly, classesPerMonth: a.classesPerMonth ?? null, unlimited: Boolean(a.unlimited), legacy: false });
      }
    } else {
      const weekly = weeklyOf(item);
      if (weekly !== null && Number.isFinite(weekly)) {
        out.push({ poolIds: allPoolIds, weekly, classesPerMonth: item.classesPerMonth ?? null, unlimited: Boolean(item.unlimited), legacy: true });
      }
    }
    return out;
  };

  const tariffSumByPool = new Map(pools.map((p) => [p.id, { sum: 0, clients: 0 }]));
  const byMembership = new Map(); // membership → { clients, bookings, byPool: Map(poolId → { clients, bookings }) }
  let tariffSum = 0;
  let tariffClients = 0;
  for (const client of clientMap.values()) {
    const membership = mostFrequent(client.memberships);
    const entry = byMembership.get(membership) || { clients: 0, bookings: 0, byPool: new Map() };
    const inScopeClient = client.scopeBookings > 0;
    if (inScopeClient) entry.clients += 1;
    entry.bookings += client.scopeBookings;
    for (const [poolId, n] of client.byPool) {
      const pe = entry.byPool.get(poolId) || { clients: 0, bookings: 0 };
      pe.clients += 1;
      pe.bookings += n;
      entry.byPool.set(poolId, pe);
    }
    byMembership.set(membership, entry);

    const { item } = resolveMembership(membership);
    if (!item || item.excludeFromCapacity) continue;
    const allowances = effectiveAllowances(item);
    if (allowances.length === 0) continue;

    const contribution = new Map(); // poolId → clases/semana de este cliente en la bolsa
    for (const a of allowances) {
      // Reparto entre bolsas proporcional a las reservas reales del cliente; sin reservas, a partes iguales.
      const weights = a.poolIds.map((id) => client.byPool.get(id) || 0);
      const total = weights.reduce((x, y) => x + y, 0);
      a.poolIds.forEach((id, i) => {
        const share = total > 0 ? weights[i] / total : 1 / a.poolIds.length;
        contribution.set(id, (contribution.get(id) || 0) + a.weekly * share);
      });
    }
    for (const [id, v] of contribution) {
      const t = tariffSumByPool.get(id);
      t.sum += v;
      t.clients += 1;
    }
    // Tarifa media del centro: solo clientes activos y solo la parte repartida a bolsas no complementarias
    if (inScopeClient) {
      tariffClients += 1;
      for (const [id, v] of contribution) {
        if (!poolComplementaryById.get(id)) tariffSum += v;
      }
    }
  }
  const tariffAvg = tariffClients > 0 ? tariffSum / tariffClients : null;

  // Público propio y reservas generales del centro (solo bolsas no complementarias)
  const overallSeg = detectSegments(scopeClients.map((c) => c.byClass));
  const centerGeneralBooked = [...totalCells.values()]
    .filter((c) => !overallSeg.segments.has(c.className))
    .reduce((s, c) => s + c.booked, 0);

  const pct = (booked, capacity) => (capacity > 0 ? (booked / capacity) * 100 : 0);

  const poolBlocks = pools.map((pool) => {
    const st = state.get(pool.id);
    const poolWeeklySlots = st.capacity / effectiveWeeks;
    const poolActive = st.clients.size;
    const poolRealAvg = poolActive > 0 ? st.bookings / poolActive / effectiveWeeks : null;
    const t = tariffSumByPool.get(pool.id);
    const poolTariffAvg = t.clients > 0 ? t.sum / t.clients : null;

    const theoreticalByReal = poolRealAvg ? poolWeeklySlots / poolRealAvg : null;
    const theoreticalByTariff = poolTariffAvg ? poolWeeklySlots / poolTariffAvg : null;
    const realisticByReal = theoreticalByReal !== null ? theoreticalByReal * dispersion : null;
    const realisticByTariff = theoreticalByTariff !== null ? theoreticalByTariff * dispersion : null;

    const bySlot = [...st.slotMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([classTime, sl]) => ({
        classTime,
        classNames: [...sl.classNames].sort((x, y) => x.localeCompare(y, 'es')),
        avgCapacityPerWeek: round1(sl.capacity / effectiveWeeks),
        avgBookedPerWeek: round1(sl.booked / effectiveWeeks),
        occupancyPct: round1(pct(sl.booked, sl.capacity)),
        freeSlotsPerWeek: round1((sl.capacity - sl.booked) / effectiveWeeks),
      }));

    // Por día de la semana: promedio por cada fecha con datos de ese día (= por semana)
    const byWeekday = [...st.weekdayMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, d]) => {
        const occurrences = d.dates.size || 1;
        return {
          weekday: idx,
          label: WEEKDAY_LABELS[idx],
          avgCapacityPerWeek: round1(d.capacity / occurrences),
          avgBookedPerWeek: round1(d.booked / occurrences),
          occupancyPct: round1(pct(d.booked, d.capacity)),
          freeSlotsPerWeek: round1((d.capacity - d.booked) / occurrences),
        };
      });

    const poolSeg = detectSegments(st.clientClasses.values());
    const bandHeadroom = buildBandHeadroom(st.cells.values(), {
      weeks: effectiveWeeks,
      dispersion,
      activeBookers: poolActive,
      generalClients: poolSeg.generalClients,
      segments: poolSeg.segments,
      limitShareBase: pool.complementary ? null : centerGeneralBooked,
    });

    return {
      id: pool.id,
      name: pool.name,
      isDefault: pool.isDefault,
      complementary: pool.complementary,
      patterns: pool.patterns,
      weeklySlots: round1(poolWeeklySlots),
      weeklyClasses: round1(st.classes / effectiveWeeks),
      activeBookers: poolActive,
      totalBookings: st.bookings,
      realAvgClassesPerWeek: round1(poolRealAvg),
      tariffAvgClassesPerWeek: round1(poolTariffAvg),
      tariffMappedClients: t.clients,
      theoreticalByReal: round1(theoreticalByReal),
      theoreticalByTariff: round1(theoreticalByTariff),
      realisticByReal: round1(realisticByReal),
      realisticByTariff: round1(realisticByTariff),
      currentLoadPct: realisticByReal ? round1((poolActive / realisticByReal) * 100) : null,
      headroomClients: realisticByReal !== null ? round1(realisticByReal - poolActive) : null,
      currentLoadPctByTariff: realisticByTariff ? round1((poolActive / realisticByTariff) * 100) : null,
      headroomClientsByTariff: realisticByTariff !== null ? round1(realisticByTariff - poolActive) : null,
      bands: bandHeadroom.bands,
      cells: bandHeadroom.cells,
      segments: bandHeadroom.segments,
      effective: bandHeadroom.effective,
      summary: bandHeadroom.summary,
      bySlot,
      byWeekday,
      newClientsPlan: buildNewClientsPlan(st.slotCells.values(), bandHeadroom.effective, {
        generalClients: poolSeg.generalClients, weeks: effectiveWeeks, segments: poolSeg.segments,
      }),
    };
  });

  // Bolsa que limita: la de menor capacidad realista (por reservas reales)
  let bindingBlock = null;
  for (const b of poolBlocks) {
    if (b.complementary || b.realisticByReal === null) continue;
    if (!bindingBlock || b.realisticByReal < bindingBlock.realisticByReal) bindingBlock = b;
  }
  const bindingPool = bindingBlock
    ? { id: bindingBlock.id, name: bindingBlock.name, realisticByReal: bindingBlock.realisticByReal }
    : null;

  const byTariff = [];
  const tariffs = [];
  const unmappedMemberships = [];
  for (const [membership, entry] of byMembership) {
    if (entry.clients === 0) continue; // solo clientes de bolsas complementarias
    const { source, item, inferredClassesPerMonth } = resolveMembership(membership);
    const realAvgMembership = round1(entry.bookings / entry.clients / effectiveWeeks);
    byTariff.push({
      membership,
      tariffName: item && source === 'configured' ? item.name : null,
      source,
      inferredClassesPerMonth,
      clients: entry.clients,
      classesPerMonth: item && item.classesPerMonth !== undefined ? item.classesPerMonth : null,
      classesPerWeek: item && item.classesPerMonth !== null && item.classesPerMonth !== undefined ? round1((item.classesPerMonth * 12) / 52) : null,
      unlimited: Boolean(item && item.unlimited),
      excluded: Boolean(item && item.excludeFromCapacity),
      realAvg: realAvgMembership,
    });
    // Uso real por bolsa: reservas / clientes de esa tarifa con reservas en la bolsa / semanas
    const realByPool = {};
    for (const pool of pools) {
      const pe = entry.byPool.get(pool.id);
      if (pe) realByPool[pool.name] = round1(pe.bookings / pe.clients / effectiveWeeks);
    }
    tariffs.push({
      membership,
      tariffName: item && source === 'configured' ? item.name : null,
      source,
      inferredClassesPerMonth,
      clients: entry.clients,
      excluded: Boolean(item && item.excludeFromCapacity),
      allowances: item
        ? effectiveAllowances(item).map((a) => ({
            pools: a.legacy && hasPools ? pools.map((p) => p.name) : a.poolIds.map((id) => poolNameById.get(id)),
            classesPerMonth: a.classesPerMonth,
            unlimited: a.unlimited,
          }))
        : [],
      realByPool,
    });
    if (source === 'unmapped') unmappedMemberships.push({ membership, clients: entry.clients });
  }
  byTariff.sort((a, b) => b.clients - a.clients);
  tariffs.sort((a, b) => b.clients - a.clients);
  unmappedMemberships.sort((a, b) => b.clients - a.clients);

  const theoreticalByReal = realAvg ? weeklySlots / realAvg : null;
  const theoreticalByTariff = tariffAvg ? weeklySlots / tariffAvg : null;
  const realisticByReal = theoreticalByReal !== null ? theoreticalByReal * dispersion : null;
  const realisticByTariff = theoreticalByTariff !== null ? theoreticalByTariff * dispersion : null;

  // Totales del centro: suma de las franjas/días de todas las bolsas con clases incluidas
  const mergeRows = (key, label) => {
    const merged = new Map();
    for (const b of poolBlocks) {
      if (b.complementary) continue;
      for (const r of b[key]) {
        const k = r[label];
        const cur = merged.get(k) || { ...r, avgCapacityPerWeek: 0, avgBookedPerWeek: 0 };
        if (r.classNames) cur.classNames = [...new Set([...(cur.classNames || []), ...r.classNames])].sort((x, y) => x.localeCompare(y, 'es'));
        if (merged.has(k)) {
          cur.avgCapacityPerWeek += r.avgCapacityPerWeek || 0;
          cur.avgBookedPerWeek += r.avgBookedPerWeek || 0;
        } else {
          cur.avgCapacityPerWeek = r.avgCapacityPerWeek || 0;
          cur.avgBookedPerWeek = r.avgBookedPerWeek || 0;
        }
        merged.set(k, cur);
      }
    }
    return [...merged.values()].map((r) => ({
      ...r,
      avgCapacityPerWeek: round1(r.avgCapacityPerWeek),
      avgBookedPerWeek: round1(r.avgBookedPerWeek),
      occupancyPct: round1(pct(r.avgBookedPerWeek, r.avgCapacityPerWeek)),
      freeSlotsPerWeek: round1(r.avgCapacityPerWeek - r.avgBookedPerWeek),
    }));
  };
  const bySlot = mergeRows('bySlot', 'classTime').sort((a, b) => a.classTime.localeCompare(b.classTime));
  const byWeekday = mergeRows('byWeekday', 'weekday').sort((a, b) => a.weekday - b.weekday);

  const complementaryPools = poolBlocks
    .filter((b) => b.complementary)
    .map((b) => {
      const cells = [...state.get(b.id).cells.values()];
      const capacity = cells.reduce((x, y) => x + y.capacity, 0);
      const booked = cells.reduce((x, y) => x + y.booked, 0);
      const free = cells.reduce((x, y) => x + y.free, 0);
      return {
        name: b.name,
        weeklySlots: b.weeklySlots,
        freeSlotsPerWeek: hasPools ? round1(free / effectiveWeeks) : null,
        occupancyPct: round1(pct(booked, capacity)),
      };
    });

  const poolSummaries = hasPools
    ? poolBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        complementary: b.complementary,
        currentClients: b.activeBookers,
        extraClients: b.effective.headroom !== null && b.effective.headroom !== undefined ? Math.floor(b.effective.headroom) : null,
        limitingBand: b.effective.limitingBand,
        limitingBandOccupancyPct: b.summary.limitingBandOccupancyPct,
        limitingClass: b.summary.limitingClass,
        limitingClassOccupancyPct: b.summary.limitingClassOccupancyPct,
      }))
    : [];

  const overallBandHeadroom = buildBandHeadroom(totalCells.values(), {
    weeks: effectiveWeeks,
    dispersion,
    activeBookers,
    generalClients: overallSeg.generalClients,
    segments: overallSeg.segments,
  });

  return {
    range,
    daysWithData,
    expectedDays: range.weeks * 7,
    hasPools,
    weeklySlots: round1(weeklySlots),
    weeklyClasses: round1(weeklyClasses),
    activeBookers,
    totalBookings,
    realAvgClassesPerWeek: round1(realAvg),
    tariffAvgClassesPerWeek: round1(tariffAvg),
    tariffMappedClients: tariffClients,
    pools: poolBlocks,
    bindingPool,
    complementaryPools,
    poolSummaries,
    tariffs,
    ignoredClasses: [...ignored.entries()].map(([className, count]) => ({ className, count })).sort((a, b) => b.count - a.count),
    byTariff,
    unmappedMemberships,
    capacity: {
      dispersionFactor: dispersion,
      unlimitedClassesPerWeek: unlimitedPerWeek,
      theoreticalByReal: round1(theoreticalByReal),
      theoreticalByTariff: round1(theoreticalByTariff),
      realisticByReal: round1(realisticByReal),
      realisticByTariff: round1(realisticByTariff),
      currentLoadPct: realisticByReal ? round1((activeBookers / realisticByReal) * 100) : null,
      headroomClients: realisticByReal !== null ? round1(realisticByReal - activeBookers) : null,
      currentLoadPctByTariff: realisticByTariff ? round1((activeBookers / realisticByTariff) * 100) : null,
      headroomClientsByTariff: realisticByTariff !== null ? round1(realisticByTariff - activeBookers) : null,
    },
    bands: overallBandHeadroom.bands,
    cells: overallBandHeadroom.cells,
    segments: overallBandHeadroom.segments,
    effective: overallBandHeadroom.effective,
    summary: overallBandHeadroom.summary,
    closedDays: closedDates.length,
    closedDates,
    bySlot,
    byWeekday,
    newClientsPlan: buildNewClientsPlan(totalSlotCells.values(), overallBandHeadroom.effective, {
      generalClients: overallSeg.generalClients, weeks: effectiveWeeks, segments: overallSeg.segments,
    }),
  };
}

module.exports = { buildCapacityReport, getCapacityRange };
