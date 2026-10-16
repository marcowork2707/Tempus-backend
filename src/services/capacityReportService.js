const CenterBookingSnapshot = require('../models/CenterBookingSnapshot');
const CenterTariffGroup = require('../models/CenterTariffGroup');
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

async function buildCapacityReport(centerId, options = {}) {
  const {
    weeks: rawWeeks = 4,
    dispersionFactor = 0.8,
    unlimitedClassesPerWeek = 6,
    includeNoCoach = false,
  } = options;

  const range = getCapacityRange(rawWeeks);
  const [snapshots, groups] = await Promise.all([
    CenterBookingSnapshot.find({ center: centerId, date: { $gte: range.start, $lte: range.end } })
      .sort({ date: 1 })
      .lean(),
    CenterTariffGroup.find({ center: centerId }).lean(),
  ]);

  const daysWithData = snapshots.length;
  // Con datos parciales los promedios semanales se calculan sobre las semanas realmente cubiertas.
  const effectiveWeeks = daysWithData > 0 ? daysWithData / 7 : range.weeks;

  const includeClass = (c) => {
    if (includeNoCoach) return true;
    if (!String(c.coachName || '').trim()) return false;
    if (/open/i.test(c.className || '')) return false;
    return true;
  };

  let totalCapacity = 0;
  let totalClasses = 0;
  let totalBookings = 0;
  const clientMap = new Map(); // key → { bookings, memberships: Map }
  const slotMap = new Map(); // classTime → { capacity, booked, classes }
  const weekdayMap = new Map(); // idx → { capacity, booked, classes, dates:Set }

  for (const snap of snapshots) {
    const wd = weekdayIndex(snap.date);
    for (const c of snap.classes || []) {
      if (!includeClass(c)) continue;
      const capacity = Number(c.capacity) || 0;
      const booked = Number(c.bookedCount) || 0;
      totalCapacity += capacity;
      totalClasses += 1;

      const slot = slotMap.get(c.classTime) || { capacity: 0, booked: 0, classes: 0 };
      slot.capacity += capacity;
      slot.booked += booked;
      slot.classes += 1;
      slotMap.set(c.classTime, slot);

      const day = weekdayMap.get(wd) || { capacity: 0, booked: 0, classes: 0, dates: new Set() };
      day.capacity += capacity;
      day.booked += booked;
      day.classes += 1;
      day.dates.add(snap.date);
      weekdayMap.set(wd, day);

      for (const a of c.athletes || []) {
        const key = a.aimharderUserId || normalizeName(a.name || '');
        if (!key) continue;
        const client = clientMap.get(key) || { bookings: 0, memberships: new Map() };
        client.bookings += 1;
        const m = a.membership || '';
        client.memberships.set(m, (client.memberships.get(m) || 0) + 1);
        clientMap.set(key, client);
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

  const byMembership = new Map(); // membership → { clients, bookings }
  let tariffSum = 0;
  let tariffClients = 0;
  for (const client of clientMap.values()) {
    const membership = mostFrequent(client.memberships);
    const entry = byMembership.get(membership) || { clients: 0, bookings: 0 };
    entry.clients += 1;
    entry.bookings += client.bookings;
    byMembership.set(membership, entry);

    const item = tariffLookup.get(normalizeName(membership));
    if (item && !item.excludeFromCapacity) {
      // Las tarifas se configuran en clases/mes; a semana: x12 meses / 52 semanas.
      const perWeek = item.unlimited
        ? Number(unlimitedClassesPerWeek)
        : (item.classesPerMonth !== null && item.classesPerMonth !== undefined ? (item.classesPerMonth * 12) / 52 : null);
      if (perWeek !== null && perWeek !== undefined && Number.isFinite(perWeek)) {
        tariffSum += perWeek;
        tariffClients += 1;
      }
    }
  }
  const tariffAvg = tariffClients > 0 ? tariffSum / tariffClients : null;

  const byTariff = [];
  const unmappedMemberships = [];
  for (const [membership, entry] of byMembership) {
    const item = tariffLookup.get(normalizeName(membership));
    byTariff.push({
      membership,
      tariffName: item ? item.name : null,
      clients: entry.clients,
      classesPerMonth: item && item.classesPerMonth !== undefined ? item.classesPerMonth : null,
      classesPerWeek: item && item.classesPerMonth !== null && item.classesPerMonth !== undefined ? round1((item.classesPerMonth * 12) / 52) : null,
      unlimited: Boolean(item && item.unlimited),
      excluded: Boolean(item && item.excludeFromCapacity),
      realAvg: round1(entry.bookings / entry.clients / effectiveWeeks),
    });
    if (!item) unmappedMemberships.push({ membership, clients: entry.clients });
  }
  byTariff.sort((a, b) => b.clients - a.clients);
  unmappedMemberships.sort((a, b) => b.clients - a.clients);

  const dispersion = Number(dispersionFactor);
  const theoreticalByReal = realAvg ? weeklySlots / realAvg : null;
  const theoreticalByTariff = tariffAvg ? weeklySlots / tariffAvg : null;
  const realisticByReal = theoreticalByReal !== null ? theoreticalByReal * dispersion : null;
  const realisticByTariff = theoreticalByTariff !== null ? theoreticalByTariff * dispersion : null;

  const pct = (booked, capacity) => (capacity > 0 ? (booked / capacity) * 100 : 0);

  const bySlot = [...slotMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([classTime, s]) => ({
      classTime,
      avgCapacityPerWeek: round1(s.capacity / effectiveWeeks),
      avgBookedPerWeek: round1(s.booked / effectiveWeeks),
      occupancyPct: round1(pct(s.booked, s.capacity)),
      freeSlotsPerWeek: round1((s.capacity - s.booked) / effectiveWeeks),
    }));

  // Por día de la semana: promedio por cada fecha con datos de ese día (= por semana)
  const byWeekday = [...weekdayMap.entries()]
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

  return {
    range,
    daysWithData,
    expectedDays: range.weeks * 7,
    weeklySlots: round1(weeklySlots),
    weeklyClasses: round1(weeklyClasses),
    activeBookers,
    totalBookings,
    realAvgClassesPerWeek: round1(realAvg),
    tariffAvgClassesPerWeek: round1(tariffAvg),
    tariffMappedClients: tariffClients,
    byTariff,
    unmappedMemberships,
    capacity: {
      dispersionFactor: dispersion,
      unlimitedClassesPerWeek: Number(unlimitedClassesPerWeek),
      theoreticalByReal: round1(theoreticalByReal),
      theoreticalByTariff: round1(theoreticalByTariff),
      realisticByReal: round1(realisticByReal),
      realisticByTariff: round1(realisticByTariff),
      currentLoadPct: realisticByReal ? round1((activeBookers / realisticByReal) * 100) : null,
      headroomClients: realisticByReal !== null ? round1(realisticByReal - activeBookers) : null,
      currentLoadPctByTariff: realisticByTariff ? round1((activeBookers / realisticByTariff) * 100) : null,
      headroomClientsByTariff: realisticByTariff !== null ? round1(realisticByTariff - activeBookers) : null,
    },
    bySlot,
    byWeekday,
  };
}

module.exports = { buildCapacityReport, getCapacityRange };
