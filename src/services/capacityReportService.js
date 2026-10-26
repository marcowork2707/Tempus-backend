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

// Franjas de demanda por hora de inicio (HH:MM)
const BANDS = [
  { key: 'manana', label: 'Mañana (hasta 12:00)' },
  { key: 'mediodia', label: 'Mediodía (12:00–16:00)' },
  { key: 'tarde', label: 'Tarde (desde 16:00)' },
];

function bandKeyOf(classTime) {
  const hour = parseInt(String(classTime || '').split(':')[0], 10);
  if (!Number.isFinite(hour) || hour < 12) return 'manana';
  if (hour < 16) return 'mediodia';
  return 'tarde';
}

const newBandAcc = () => new Map(BANDS.map((b) => [b.key, { capacity: 0, booked: 0, free: 0 }]));

// Margen ponderado por demanda: los clientes nuevos reparten sus clases como la demanda actual
// y el margen se agota en la franja más llena. `acc` = Map(bandKey → { capacity, booked, free }).
function buildBandHeadroom(acc, { weeks, realAvg, dispersion, activeBookers }) {
  const totalBooked = [...acc.values()].reduce((s, b) => s + b.booked, 0);
  const rows = BANDS.map(({ key, label }) => {
    const b = acc.get(key);
    const demandShare = totalBooked > 0 ? b.booked / totalBooked : 0;
    const freeSlotsPerWeek = b.free / weeks;
    const fitsClients = realAvg && demandShare > 0 ? freeSlotsPerWeek / (realAvg * demandShare) : null;
    const fitsClientsRealistic = fitsClients !== null ? fitsClients * dispersion : null;
    return {
      key,
      label,
      capacityPerWeek: round1(b.capacity / weeks),
      bookedPerWeek: round1(b.booked / weeks),
      freeSlotsPerWeek: round1(freeSlotsPerWeek),
      occupancyPct: round1(b.capacity > 0 ? (b.booked / b.capacity) * 100 : 0),
      demandShare: Math.round(demandShare * 1000) / 1000,
      demandSharePct: round1(demandShare * 100),
      fitsClients: round1(fitsClients),
      fitsClientsRealistic: round1(fitsClientsRealistic),
      _raw: fitsClientsRealistic,
    };
  });
  let limiting = null;
  for (const r of rows) {
    if (r._raw !== null && (!limiting || r._raw < limiting._raw)) limiting = r;
  }
  const headroom = limiting ? limiting._raw : null;
  const capacity = headroom !== null ? activeBookers + headroom : null;
  return {
    bands: rows.map(({ _raw, ...r }) => r),
    effective: {
      headroom: round1(headroom),
      limitingBand: limiting ? limiting.label : null,
      capacity: round1(capacity),
      loadPct: capacity ? round1((activeBookers / capacity) * 100) : null,
    },
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
        patterns: p.patterns || [],
        normPatterns: (p.patterns || []).map((x) => normalizeName(x)).filter(Boolean),
      }))
    : [{ id: IMPLICIT_POOL_ID, name: 'Todas las clases', isDefault: true, patterns: [], normPatterns: [] }];
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
      bands: newBandAcc(),
    });
  }
  const totalBands = newBandAcc();
  const ignored = new Map(); // className → count
  const clientMap = new Map(); // key → { bookings, memberships, byPool: Map }
  let totalCapacity = 0;
  let totalClasses = 0;
  let totalBookings = 0;

  for (const snap of snapshots) {
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
      totalCapacity += capacity;
      totalClasses += 1;
      st.capacity += capacity;
      st.classes += 1;

      const bandKey = bandKeyOf(c.classTime);
      for (const acc of [st.bands, totalBands]) {
        const band = acc.get(bandKey);
        band.capacity += capacity;
        band.booked += booked;
        band.free += Math.max(0, capacity - booked); // una clase sobrereservada no resta huecos
      }

      const slot = st.slotMap.get(c.classTime) || { capacity: 0, booked: 0 };
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
        const client = clientMap.get(key) || { bookings: 0, memberships: new Map(), byPool: new Map() };
        client.bookings += 1;
        const m = a.membership || '';
        client.memberships.set(m, (client.memberships.get(m) || 0) + 1);
        client.byPool.set(pool.id, (client.byPool.get(pool.id) || 0) + 1);
        clientMap.set(key, client);
        st.clients.set(key, (st.clients.get(key) || 0) + 1);
        st.bookings += 1;
        totalBookings += 1;
      }
    }
  }

  const weeklySlots = totalCapacity / effectiveWeeks;
  const weeklyClasses = totalClasses / effectiveWeeks;
  const activeBookers = clientMap.size;
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
  const poolNameById = new Map(pools.map((p) => [p.id, p.name]));
  const allPoolIds = pools.map((p) => p.id);

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
    entry.clients += 1;
    entry.bookings += client.bookings;
    for (const [poolId, n] of client.byPool) {
      const pe = entry.byPool.get(poolId) || { clients: 0, bookings: 0 };
      pe.clients += 1;
      pe.bookings += n;
      entry.byPool.set(poolId, pe);
    }
    byMembership.set(membership, entry);

    const item = tariffLookup.get(normalizeName(membership));
    if (!item || item.excludeFromCapacity) continue;
    const allowances = effectiveAllowances(item);
    if (allowances.length === 0) continue;

    tariffClients += 1;
    const contribution = new Map(); // poolId → clases/semana de este cliente en la bolsa
    for (const a of allowances) {
      tariffSum += a.weekly;
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
  }
  const tariffAvg = tariffClients > 0 ? tariffSum / tariffClients : null;

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

    const bandHeadroom = buildBandHeadroom(st.bands, {
      weeks: effectiveWeeks,
      realAvg: poolRealAvg,
      dispersion,
      activeBookers: poolActive,
    });

    return {
      id: pool.id,
      name: pool.name,
      isDefault: pool.isDefault,
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
      effective: bandHeadroom.effective,
      bySlot,
      byWeekday,
    };
  });

  // Bolsa que limita: la de menor capacidad realista (por reservas reales)
  let bindingBlock = null;
  for (const b of poolBlocks) {
    if (b.realisticByReal === null) continue;
    if (!bindingBlock || b.realisticByReal < bindingBlock.realisticByReal) bindingBlock = b;
  }
  const bindingPool = bindingBlock
    ? { id: bindingBlock.id, name: bindingBlock.name, realisticByReal: bindingBlock.realisticByReal }
    : null;

  const byTariff = [];
  const tariffs = [];
  const unmappedMemberships = [];
  for (const [membership, entry] of byMembership) {
    const item = tariffLookup.get(normalizeName(membership));
    const realAvgMembership = round1(entry.bookings / entry.clients / effectiveWeeks);
    byTariff.push({
      membership,
      tariffName: item ? item.name : null,
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
      tariffName: item ? item.name : null,
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
    if (!item) unmappedMemberships.push({ membership, clients: entry.clients });
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
      for (const r of b[key]) {
        const k = r[label];
        const cur = merged.get(k) || { ...r, avgCapacityPerWeek: 0, avgBookedPerWeek: 0 };
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

  const overallBandHeadroom = buildBandHeadroom(totalBands, {
    weeks: effectiveWeeks,
    realAvg,
    dispersion,
    activeBookers,
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
    effective: overallBandHeadroom.effective,
    bySlot,
    byWeekday,
  };
}

module.exports = { buildCapacityReport, getCapacityRange };
