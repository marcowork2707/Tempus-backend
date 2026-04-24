const Center = require('../models/Center');
const CenterKpiObjectives = require('../models/CenterKpiObjectives');
const UserCenterRole = require('../models/UserCenterRole');
const Role = require('../models/Role');
const Shift = require('../models/Shift');
const WorkerShift = require('../models/WorkerShift');
const ShiftPattern = require('../models/ShiftPattern');
const ShiftOverride = require('../models/ShiftOverride');
const VacationRequest = require('../models/VacationRequest');
const VacationConflictRule = require('../models/VacationConflictRule');
const ExtraIncentive = require('../models/ExtraIncentive');
const RecurringIncentiveRule = require('../models/RecurringIncentiveRule');
const PayrollEntry = require('../models/PayrollEntry');
const CenterExpense = require('../models/CenterExpense');
const RecurringExpenseConcept = require('../models/RecurringExpenseConcept');
const WeeklyPlanning = require('../models/WeeklyPlanning');
const CenterDashboardReview = require('../models/CenterDashboardReview');
const AimHarderClientMonthlySnapshot = require('../models/AimHarderClientMonthlySnapshot');
const AttendanceAbsenceSnapshot = require('../models/AttendanceAbsenceSnapshot');
const TimeEntry = require('../models/TimeEntry');
const Checklist = require('../models/Checklist');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const { buildPlanningMessage } = require('../services/weeklyPlanningService');

const hasResolvedUser = (record) => Boolean(record?.user && record.user._id);
const OVERTIME_AGGREGATION_MODES = ['net', 'positive_only'];
const DASHBOARD_REVIEW_ALLOWED_STATUSES = ['pending', 'ok', 'fail'];

const DASHBOARD_REVIEW_TEMPLATE = [
  {
    key: 'revision-clases',
    title: 'REVISION DE CLASES',
    items: [
      { key: 'nota_revision_clases', label: 'Resultado mensual de revision de clases' },
    ],
  },
  {
    key: 'personal',
    title: 'PERSONAL',
    items: [
      { key: 'formacion', label: 'Formación' },
      { key: 'implicacion-responsabilidad', label: 'Implicación y Responsabilidad' },
      { key: 'desarrollo-cultura-crecimiento', label: 'Desarrollo y cultura de crecimiento' },
      { key: 'bonificacion-trimestre', label: 'Bonificación trimestre' },
    ],
  },
  {
    key: 'online',
    title: 'ONLINE',
    items: [
      { key: 'resenas-google', label: 'Reseñas' },
      { key: 'stories-por-dia', label: 'Frecuencia mínima stories/día' },
      { key: 'publicaciones-por-mes', label: 'Frecuencia mínima publicaciones/mes' },
    ],
  },
  {
    key: 'back-office',
    title: 'BACK OFFICE',
    items: [
      { key: 'tareas-diarias', label: 'Tareas Diarias' },
      { key: 'pagos-ult-dia', label: 'Pagos Ult. Dia' },
      { key: 'mr-septiembre', label: 'Mr Septiembre' },
      { key: 'mr-enero', label: 'Mr Enero' },
      { key: '14-days-historico', label: '14 Days Histórico' },
    ],
  },
  {
    key: 'eventos',
    title: 'EVENTOS',
    items: [
      { key: 'recurrencia-objetivo', label: 'Recurrencia objetivo' },
      { key: 'comunicacion-difusion', label: 'Comunicación y difusión' },
      { key: 'fotos', label: 'Fotos' },
    ],
  },
  {
    key: 'promociones',
    title: 'PROMOCIONES',
    items: [
      { key: 'recurrencia-objetivo', label: 'Recurrencia objetivo' },
    ],
  },
  {
    key: 'kpis',
    title: 'KPIS',
    items: [
      { key: 'tarifas-activas', label: 'Tarifas Activas' },
      { key: 'altas', label: 'Altas' },
      { key: 'altas-bajas-plus', label: 'Altas-Bajas (+)' },
      { key: 'faltas-asistencia-menor-40', label: 'Faltas de asistencia' },
    ],
  },
];

const buildDefaultDashboardReviewSections = () =>
  DASHBOARD_REVIEW_TEMPLATE.map((section) => ({
    key: section.key,
    title: section.title,
    items: section.items.map((item) => ({
      key: item.key,
      label: item.label,
      status: 'pending',
      comment: '',
      subItems: [],
    })),
  }));

const normalizeDashboardReviewValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDashboardReviewSubItems = (incomingSubItems) => {
  if (!Array.isArray(incomingSubItems)) return [];

  const seenKeys = new Set();
  const normalized = [];

  for (const subItem of incomingSubItems) {
    if (!subItem || typeof subItem !== 'object') continue;

    const key = String(subItem.key || '').trim();
    const label = String(subItem.label || '').trim();
    if (!key || !label || seenKeys.has(key)) continue;

    const candidateStatus = String(subItem.status || 'pending').trim().toLowerCase();
    const status = DASHBOARD_REVIEW_ALLOWED_STATUSES.includes(candidateStatus)
      ? candidateStatus
      : 'pending';
    const comment = typeof subItem.comment === 'string' ? subItem.comment.trim().slice(0, 1200) : '';
    const value = normalizeDashboardReviewValue(subItem.value);

    const nestedSubItems = normalizeDashboardReviewSubItems(subItem.subItems);

    normalized.push({
      key,
      label,
      status: nestedSubItems.length > 0 ? 'pending' : status,
      comment: nestedSubItems.length > 0 ? '' : comment,
      value: nestedSubItems.length > 0 ? null : value,
      subItems: nestedSubItems,
    });
    seenKeys.add(key);
  }

  return normalized;
};

const resetDashboardReviewSubItemsProgress = (subItems = []) => {
  return (Array.isArray(subItems) ? subItems : []).map((subItem) => ({
    ...subItem,
    status: 'pending',
    value: null,
    subItems: resetDashboardReviewSubItemsProgress(subItem.subItems),
  }));
};

const resetDashboardReviewProgress = (sections = []) => {
  return (Array.isArray(sections) ? sections : []).map((section) => ({
    ...section,
    items: (Array.isArray(section.items) ? section.items : []).map((item) => ({
      ...item,
      status: 'pending',
      value: null,
      subItems: resetDashboardReviewSubItemsProgress(item.subItems),
    })),
  }));
};

const getNextMonth = (month) => {
  const [year, monthIndex] = String(month).split('-').map(Number);
  if (!year || !monthIndex) return null;
  if (monthIndex === 12) return `${year + 1}-01`;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
};

const readObjectiveMonthlyValue = (objectivesMap, key, monthIndex) => {
  const monthly = objectivesMap[key];
  if (!Array.isArray(monthly)) return null;
  const value = monthly[monthIndex];
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value);
};

const evaluateKpiAgainstObjective = ({
  actual,
  objective,
  comparator,
  fallbackObjective = null,
}) => {
  const safeActual = Number.isFinite(Number(actual)) ? Number(actual) : 0;
  const target = objective ?? fallbackObjective;

  if (target === null || target === undefined || Number.isNaN(Number(target))) {
    return {
      status: 'pending',
      comment: `Actual: ${safeActual}`,
      objective: null,
      actual: safeActual,
    };
  }

  const safeTarget = Number(target);
  const passed = comparator === 'lte' ? safeActual <= safeTarget : safeActual >= safeTarget;
  const objectiveLabel = comparator === 'lte' ? 'Objetivo máximo' : 'Objetivo';

  return {
    status: passed ? 'ok' : 'fail',
    comment: `Actual: ${safeActual} · ${objectiveLabel}: ${safeTarget}`,
    objective: safeTarget,
    actual: safeActual,
  };
};

const getCenterKpiObjectivesMap = async (centerId, year) => {
  const objectiveDoc = await CenterKpiObjectives.findOne({ center: centerId, year })
    .select('objectives')
    .lean();

  const objectivesMap = {};
  for (const objective of objectiveDoc?.objectives || []) {
    if (!objective?.key) continue;
    objectivesMap[objective.key] = objective.monthly;
  }

  return objectivesMap;
};

const getDashboardOnlineObjectives = (objectivesMap, monthIndex) => ({
  resenasGoogle: readObjectiveMonthlyValue(objectivesMap, 'online_resenas', monthIndex),
  storiesPorDia: readObjectiveMonthlyValue(objectivesMap, 'online_stories_min_dia', monthIndex),
  publicacionesPorMes: readObjectiveMonthlyValue(objectivesMap, 'online_publicaciones_min_mes', monthIndex),
});

const evaluateDashboardOnlineItems = (sections = [], onlineObjectives) => {
  const objectiveByItemKey = {
    'resenas-google': onlineObjectives?.resenasGoogle ?? null,
    'stories-por-dia': onlineObjectives?.storiesPorDia ?? null,
    'publicaciones-por-mes': onlineObjectives?.publicacionesPorMes ?? null,
  };

  return sections.map((section) => {
    if (section.key !== 'online') return section;

    return {
      ...section,
      items: (section.items || []).map((item) => {
        const objective = objectiveByItemKey[item.key];
        if (objective === undefined) return item;
        if (Array.isArray(item.subItems) && item.subItems.length > 0) return item;

        const value = normalizeDashboardReviewValue(item.value);
        if (value === null || objective === null) {
          return {
            ...item,
            value,
            status: 'pending',
          };
        }

        return {
          ...item,
          value,
          status: value >= objective ? 'ok' : 'fail',
        };
      }),
    };
  });
};

const computeDashboardKpiAutoEvaluation = async ({ centerId, month }) => {
  const monthIndex = Number(month.split('-')[1]) - 1;
  const year = Number(month.split('-')[0]);
  const nextMonth = getNextMonth(month);
  const startDate = `${month}-01`;

  const [snapshot, absenceSnapshots, objectivesMap] = await Promise.all([
    AimHarderClientMonthlySnapshot.findOne({ center: centerId, month })
      .select('activeClientsCount newSignups newSignupsManual monthlyCancellations monthlyCancellationsManual')
      .lean(),
    nextMonth
      ? AttendanceAbsenceSnapshot.find({
        center: centerId,
        date: { $gte: startDate, $lt: `${nextMonth}-01` },
      })
        .select('absences')
        .lean()
      : Promise.resolve([]),
    getCenterKpiObjectivesMap(centerId, year),
  ]);

  const tarifasActivas = Number(snapshot?.activeClientsCount || 0);
  const altas = Number(
    snapshot?.newSignupsManual ?? snapshot?.newSignups ?? 0
  );
  const bajas = Number(
    snapshot?.monthlyCancellationsManual ?? snapshot?.monthlyCancellations ?? 0
  );
  const altasBajasPlus = altas - bajas;
  const faltasAsistencia = (absenceSnapshots || []).reduce(
    (total, current) => total + (Array.isArray(current.absences) ? current.absences.length : 0),
    0
  );

  return {
    tarifasActivas: evaluateKpiAgainstObjective({
      actual: tarifasActivas,
      objective: readObjectiveMonthlyValue(objectivesMap, 'tarifas_activas', monthIndex),
      comparator: 'gte',
    }),
    altas: evaluateKpiAgainstObjective({
      actual: altas,
      objective: readObjectiveMonthlyValue(objectivesMap, 'nuevas_altas', monthIndex),
      comparator: 'gte',
    }),
    altasBajasPlus: evaluateKpiAgainstObjective({
      actual: altasBajasPlus,
      objective: readObjectiveMonthlyValue(objectivesMap, 'altas_bajas_plus', monthIndex),
      comparator: 'gte',
      fallbackObjective: 1,
    }),
    faltasAsistencia: evaluateKpiAgainstObjective({
      actual: faltasAsistencia,
      objective: readObjectiveMonthlyValue(objectivesMap, 'faltas_asistencia', monthIndex),
      comparator: 'lte',
      fallbackObjective: 40,
    }),
  };
};

const applyDashboardKpiAutoEvaluation = (sections = [], kpiAuto = null) => {
  if (!kpiAuto) return sections;

  const byItemKey = {
    'tarifas-activas': kpiAuto.tarifasActivas,
    altas: kpiAuto.altas,
    'altas-bajas-plus': kpiAuto.altasBajasPlus,
    'faltas-asistencia-menor-40': kpiAuto.faltasAsistencia,
  };

  return sections.map((section) => {
    if (section.key !== 'kpis') return section;

    return {
      ...section,
      items: (section.items || []).map((item) => {
        const evaluation = byItemKey[item.key];
        if (!evaluation) return item;
        if (Array.isArray(item.subItems) && item.subItems.length > 0) return item;

        return {
          ...item,
          status: evaluation.status,
          comment: item.comment?.trim() ? item.comment : evaluation.comment,
        };
      }),
    };
  });
};

const computeSectionRecurrenciaYearToDate = async (
  centerId,
  year,
  currentMonth,
  sectionsForCurrentMonth,
  sectionKey
) => {
  const section = (sectionsForCurrentMonth || []).find((s) => s.key === sectionKey);
  const recurrenciaItem = (section?.items || []).find((i) => i.key === 'recurrencia-objetivo');
  const currentValue = Number(recurrenciaItem?.value ?? 0);

  const previousReviews = await CenterDashboardReview.find({
    center: centerId,
    month: { $gte: `${year}-01`, $lt: currentMonth },
  })
    .select('sections')
    .lean();

  let previousTotal = 0;
  for (const review of previousReviews) {
    const previousSection = (review.sections || []).find((s) => s.key === sectionKey);
    const ri = (previousSection?.items || []).find((i) => i.key === 'recurrencia-objetivo');
    previousTotal += Number(ri?.value ?? 0);
  }

  return { total: previousTotal + currentValue, previousTotal, currentValue };
};

const applySectionRecurrenciaEvaluation = (sections, sectionKey, ytd, objective, monthNumber) => {
  const isDecember = monthNumber === 12;

  return sections.map((section) => {
    if (section.key !== sectionKey) return section;

    return {
      ...section,
      items: (section.items || []).map((item) => {
        if (item.key !== 'recurrencia-objetivo') return item;
        if (Array.isArray(item.subItems) && item.subItems.length > 0) return item;

        if (isDecember && objective !== null) {
          return { ...item, status: ytd.total >= objective ? 'ok' : 'fail' };
        }
        return { ...item, status: 'pending' };
      }),
    };
  });
};

const normalizeDashboardReviewSections = (incomingSections) => {
  const sections = Array.isArray(incomingSections) ? incomingSections : [];
  const incomingBySectionKey = new Map();

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const key = String(section.key || '').trim();
    if (!key) continue;
    incomingBySectionKey.set(key, section);
  }

  return DASHBOARD_REVIEW_TEMPLATE.map((sectionTemplate) => {
    const incomingSection = incomingBySectionKey.get(sectionTemplate.key);
    const incomingItems = Array.isArray(incomingSection?.items) ? incomingSection.items : [];
    const incomingByItemKey = new Map();

    for (const item of incomingItems) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.key || '').trim();
      if (!key) continue;
      incomingByItemKey.set(key, item);
    }

    return {
      key: sectionTemplate.key,
      title: sectionTemplate.title,
      items: sectionTemplate.items.map((itemTemplate) => {
        const incomingItem = incomingByItemKey.get(itemTemplate.key);
        const normalizedSubItems = normalizeDashboardReviewSubItems(incomingItem?.subItems);
        const candidateStatus = String(incomingItem?.status || 'pending').trim().toLowerCase();
        const status = DASHBOARD_REVIEW_ALLOWED_STATUSES.includes(candidateStatus)
          ? candidateStatus
          : 'pending';
        const comment = typeof incomingItem?.comment === 'string' ? incomingItem.comment.trim().slice(0, 1200) : '';
        const value = normalizeDashboardReviewValue(incomingItem?.value);

        return {
          key: itemTemplate.key,
          label: itemTemplate.label,
          // If an item has subItems, status/comment belongs to each subItem, not the parent.
          status: normalizedSubItems.length > 0 ? 'pending' : status,
          comment: normalizedSubItems.length > 0 ? '' : comment,
          value: normalizedSubItems.length > 0 ? null : value,
          subItems: normalizedSubItems,
        };
      }),
    };
  });
};

const startOfDayLocal = (date) => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
};

const endOfDayLocal = (date) => {
  const value = startOfDayLocal(date);
  value.setDate(value.getDate() + 1);
  return value;
};

const formatLocalDateKey = (date) => {
  const value = startOfDayLocal(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getStartOfIsoWeek = (date) => {
  const value = startOfDayLocal(date);
  const day = value.getDay();
  value.setDate(value.getDate() + (day === 0 ? -6 : 1 - day));
  return value;
};

const addDaysLocal = (date, days) => {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
};

const formatMinutesForLabel = (minutes) => {
  const safeMinutes = Math.abs(Math.round(minutes || 0));
  const hours = Math.floor(safeMinutes / 60);
  const restMinutes = safeMinutes % 60;
  return `${hours}h ${restMinutes}m`;
};

const timeToMinutes = (timeString) => {
  if (!timeString) return 0;
  const [hours, minutes] = String(timeString).split(':').map(Number);
  return (hours * 60) + minutes;
};

const getDurationFromTimes = (startTime, endTime) => {
  if (!startTime || !endTime) return 0;
  return Math.max(0, timeToMinutes(endTime) - timeToMinutes(startTime));
};

const getMinutesFromSegments = (segments = []) =>
  segments.reduce((total, segment) => total + getDurationFromTimes(segment.startTime, segment.endTime), 0);

const getOccurrenceMinutes = (occurrence) => {
  if (!occurrence || occurrence.isOff) return 0;
  if (Array.isArray(occurrence.timeSegments) && occurrence.timeSegments.length > 0) {
    return getMinutesFromSegments(occurrence.timeSegments);
  }
  return getDurationFromTimes(occurrence.startTime, occurrence.endTime);
};

const isCreditedOffDayOverride = (override) => {
  if (!override) return false;

  const reasonType = String(override.reasonType || '').toLowerCase();
  if (reasonType === 'vacation' || reasonType === 'holiday') return true;

  if (!override.isOff) return false;

  const labelAndNotes = `${override.label || ''} ${override.notes || ''}`.toLowerCase();
  return labelAndNotes.includes('festivo') || labelAndNotes.includes('vacacion');
};

const buildOffDayCreditMap = ({ baseOccurrences, overrides }) => {
  const baseMinutesByKey = new Map();
  for (const occurrence of baseOccurrences) {
    const key = `${occurrence.userId}|${occurrence.date}`;
    baseMinutesByKey.set(key, (baseMinutesByKey.get(key) || 0) + getOccurrenceMinutes(occurrence));
  }

  const vacationMinutesByKey = new Map();
  for (const override of overrides) {
    if (!override.user?._id) continue;
    if (!isCreditedOffDayOverride(override)) continue;
    const key = `${override.user._id.toString()}|${formatLocalDateKey(override.date)}`;
    vacationMinutesByKey.set(key, baseMinutesByKey.get(key) || 0);
  }

  return vacationMinutesByKey;
};

const parseMonthRange = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) {
    throw new ErrorHandler('month must be YYYY-MM', 400);
  }

  const [yearString, monthString] = month.split('-');
  const year = Number(yearString);
  const monthIndex = Number(monthString) - 1;
  const monthStart = new Date(year, monthIndex, 1);
  const monthEnd = new Date(year, monthIndex + 1, 0);
  return { monthStart, monthEnd };
};

const buildWeeklyOvertimeSummaries = ({ month, assignments, entries, aggregationMode, vacationCreditByUserDate = new Map() }) => {
  const { monthStart, monthEnd } = parseMonthRange(month);
  const rangeStart = getStartOfIsoWeek(monthStart);
  const rangeEnd = addDaysLocal(getStartOfIsoWeek(monthEnd), 6);
  const entriesByUser = new Map();

  for (const entry of entries) {
    if (!entry.user?._id) continue;
    const userId = entry.user._id.toString();
    if (!entriesByUser.has(userId)) entriesByUser.set(userId, []);
    entriesByUser.get(userId).push(entry);
  }

  const summaries = assignments.map((assignment) => {
    const userId = assignment.user._id.toString();
    const weeklyContractHours = Number(assignment.weeklyContractHours);
    const weeklyContractMinutes = Number.isFinite(weeklyContractHours) && weeklyContractHours > 0
      ? Math.round(weeklyContractHours * 60)
      : 0;
    const userEntries = entriesByUser.get(userId) || [];
    const vacationCreditMinutesInMonth = Array.from(vacationCreditByUserDate.entries()).reduce((total, [key, minutes]) => {
      const [entryUserId, dateKey] = key.split('|');
      if (entryUserId !== userId) return total;
      const entryDate = startOfDayLocal(dateKey);
      if (entryDate < monthStart || entryDate > monthEnd) return total;
      return total + Number(minutes || 0);
    }, 0);
    const workedMinutesInMonth = userEntries.reduce((total, entry) => {
      const entryDate = startOfDayLocal(entry.date);
      if (entryDate < monthStart || entryDate > monthEnd) return total;
      return total + Number(entry.duration || 0);
    }, 0) + vacationCreditMinutesInMonth;
    const weeks = [];

    let cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
      const weekStart = new Date(cursor);
      const weekEnd = addDaysLocal(weekStart, 6);
      const intersectsMonth = weekEnd >= monthStart && weekStart <= monthEnd;

      if (intersectsMonth) {
        const weekEntries = userEntries.filter((entry) => {
          const entryDate = startOfDayLocal(entry.date);
          return entryDate >= weekStart && entryDate <= weekEnd;
        });
        const vacationCreditMinutes = Array.from(vacationCreditByUserDate.entries()).reduce((total, [key, minutes]) => {
          const [entryUserId, dateKey] = key.split('|');
          if (entryUserId !== userId) return total;
          const entryDate = startOfDayLocal(dateKey);
          if (entryDate < weekStart || entryDate > weekEnd) return total;
          return total + Number(minutes || 0);
        }, 0);
        const workedMinutes = weekEntries.reduce((total, entry) => total + Number(entry.duration || 0), 0) + vacationCreditMinutes;
        const deltaMinutes = weeklyContractMinutes > 0 ? workedMinutes - weeklyContractMinutes : 0;
        const countedExtraMinutes = aggregationMode === 'net'
          ? deltaMinutes
          : Math.max(0, deltaMinutes);

        weeks.push({
          weekStart: formatLocalDateKey(weekStart),
          weekEnd: formatLocalDateKey(weekEnd),
          workedMinutes,
          theoreticalMinutes: weeklyContractMinutes,
          deltaMinutes,
          countedExtraMinutes,
          workedLabel: formatMinutesForLabel(workedMinutes),
          theoreticalLabel: formatMinutesForLabel(weeklyContractMinutes),
          deltaLabel: `${deltaMinutes > 0 ? '+' : deltaMinutes < 0 ? '-' : ''}${formatMinutesForLabel(deltaMinutes)}`,
          countedExtraLabel: `${countedExtraMinutes > 0 ? '+' : countedExtraMinutes < 0 ? '-' : ''}${formatMinutesForLabel(countedExtraMinutes)}`,
        });
      }

      cursor = addDaysLocal(cursor, 7);
    }

    const totalTheoreticalMinutes = weeks.reduce((total, week) => total + week.theoreticalMinutes, 0);
    const totalExtraMinutes = weeks.reduce((total, week) => total + week.countedExtraMinutes, 0);
    const totalDeltaMinutes = weeks.reduce((total, week) => total + week.deltaMinutes, 0);

    return {
      user: {
        _id: assignment.user._id,
        name: assignment.user.name,
        email: assignment.user.email,
      },
      weeklyContractHours: weeklyContractHours || null,
      weeklyContractMinutes,
      configurationMissing: weeklyContractMinutes <= 0,
      totalWorkedMinutes: workedMinutesInMonth,
      totalTheoreticalMinutes,
      totalExtraMinutes,
      totalDeltaMinutes,
      totalWorkedLabel: formatMinutesForLabel(workedMinutesInMonth),
      totalTheoreticalLabel: formatMinutesForLabel(totalTheoreticalMinutes),
      totalExtraLabel: `${totalExtraMinutes > 0 ? '+' : totalExtraMinutes < 0 ? '-' : ''}${formatMinutesForLabel(totalExtraMinutes)}`,
      totalDeltaLabel: `${totalDeltaMinutes > 0 ? '+' : totalDeltaMinutes < 0 ? '-' : ''}${formatMinutesForLabel(totalDeltaMinutes)}`,
      weeks,
    };
  });

  return summaries.sort((left, right) => left.user.name.localeCompare(right.user.name, 'es'));
};

// Public centers list for registration flow
exports.getPublicCenters = catchAsyncErrors(async (req, res, next) => {
  const centers = await Center.find({ active: true }).sort({ name: 1 });

  res.status(200).json({
    success: true,
    count: centers.length,
    centers,
  });
});

// Get Centers (all for admins, assigned for others)
exports.getAllCenters = catchAsyncErrors(async (req, res, next) => {
  let centers;

  if (req.user.role === 'admin') {
    // Admin sees all centers
    centers = await Center.find();
  } else {
    // Non-admins see only their assigned centers
    const userCenterRoles = await UserCenterRole.find({ user: req.user.id }).populate('center');
    centers = userCenterRoles.map((ucr) => ucr.center);
  }

  res.status(200).json({
    success: true,
    count: centers.length,
    centers,
  });
});

// Get Center by ID
exports.getCenterById = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);

  if (!center) {
    return next(new ErrorHandler('Center not found', 404));
  }

  res.status(200).json({
    success: true,
    center,
  });
});

// Create Center (Admin only)
exports.createCenter = catchAsyncErrors(async (req, res, next) => {
  const { name, type, address, phone, email, aimharderKey } = req.body;

  if (!name || !type) {
    return next(new ErrorHandler('Please provide name and type', 400));
  }

  const center = await Center.create({
    name,
    type,
    address,
    phone,
    email,
    aimharderKey,
  });

  res.status(201).json({
    success: true,
    message: 'Center created successfully',
    center,
  });
});

// Update Center (Admin only)
exports.updateCenter = catchAsyncErrors(async (req, res, next) => {
  const { name, type, address, phone, email, active, aimharderKey, overtimeSettings } = req.body;

  let center = await Center.findById(req.params.id);

  if (!center) {
    return next(new ErrorHandler('Center not found', 404));
  }

  if (name) center.name = name;
  if (type) center.type = type;
  if (address) center.address = address;
  if (phone) center.phone = phone;
  if (email) center.email = email;
  if (aimharderKey !== undefined) center.aimharderKey = aimharderKey;
  if (active !== undefined) center.active = active;
  if (overtimeSettings && typeof overtimeSettings === 'object') {
    const nextAggregationMode = overtimeSettings.monthlyAggregationMode;
    if (nextAggregationMode !== undefined) {
      if (!OVERTIME_AGGREGATION_MODES.includes(nextAggregationMode)) {
        return next(new ErrorHandler('Invalid overtime monthlyAggregationMode', 400));
      }
      center.overtimeSettings = {
        ...(center.overtimeSettings || {}),
        monthlyAggregationMode: nextAggregationMode,
      };
    }
  }

  await center.save();

  res.status(200).json({
    success: true,
    message: 'Center updated successfully',
    center,
  });
});

// Update Checklist Templates (Admin only)
exports.updateChecklistTemplates = catchAsyncErrors(async (req, res, next) => {
  const { openingTasks, closingTasks, dailyTaskKeys, cleaningTasks } = req.body;

  let center = await Center.findById(req.params.id);

  if (!center) {
    return next(new ErrorHandler('Center not found', 404));
  }

  if (openingTasks && Array.isArray(openingTasks)) {
    center.checklistTemplates.opening = openingTasks;
  }

  if (closingTasks && Array.isArray(closingTasks)) {
    center.checklistTemplates.closing = closingTasks;
  }

  if (dailyTaskKeys && Array.isArray(dailyTaskKeys)) {
    center.checklistTemplates.dailyTaskKeys = dailyTaskKeys
      .map((key) => String(key || '').trim())
      .filter(Boolean);
  }

  if (Array.isArray(cleaningTasks)) {
    const normalizedCleaningTasks = cleaningTasks
      .map((task) => ({
        key: String(task?.key || '').trim(),
        label: String(task?.label || '').trim(),
        daysOfWeek: Array.isArray(task?.daysOfWeek)
          ? task.daysOfWeek
            .map((day) => Number(day))
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          : [],
      }))
      .filter((task) => task.key && task.label)
      .map((task) => ({
        ...task,
        daysOfWeek: Array.from(new Set(task.daysOfWeek)).sort((a, b) => a - b),
      }));

    center.checklistTemplates.cleaningTasks = normalizedCleaningTasks;
  }

  await center.save();

  res.status(200).json({
    success: true,
    message: 'Checklist templates updated successfully',
    center,
  });
});

// Delete Center (Admin only)
exports.deleteCenter = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);

  if (!center) {
    return next(new ErrorHandler('Center not found', 404));
  }

  await Center.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: 'Center deleted successfully',
  });
});

// ─── STAFF MANAGEMENT ───────────────────────────────────────────────────────

// Get all users assigned to a center
exports.getCenterUsers = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const assignments = await UserCenterRole.find({ center: req.params.id })
    .populate('user', 'name email active')
    .populate('role', 'name');

  res.status(200).json({ success: true, assignments });
});

// Assign a user to a center with a role
exports.addUserToCenter = catchAsyncErrors(async (req, res, next) => {
  const { userId, roleName, weeklyContractHours } = req.body;

  if (!userId || !roleName) {
    return next(new ErrorHandler('userId and roleName are required', 400));
  }

  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  let role = await Role.findOne({ name: roleName });
  if (!role && roleName === 'limpieza') {
    role = await Role.create({
      name: 'limpieza',
      description: 'Limpieza - Completes cleaning tasks and check-in/out',
      permissions: ['view_own_tasks', 'complete_tasks', 'view_checklist', 'check_in_out'],
    });
  }
  if (!role) return next(new ErrorHandler(`Role '${roleName}' not found`, 404));

  const existing = await UserCenterRole.findOne({ user: userId, center: req.params.id });
  if (existing) return next(new ErrorHandler('User is already assigned to this center', 400));

  const assignment = await UserCenterRole.create({
    user: userId,
    center: req.params.id,
    role: role._id,
    weeklyContractHours: weeklyContractHours === undefined || weeklyContractHours === null || weeklyContractHours === ''
      ? null
      : Number(weeklyContractHours),
  });

  const populated = await assignment.populate([
    { path: 'user', select: 'name email active' },
    { path: 'role', select: 'name' },
  ]);

  res.status(201).json({ success: true, assignment: populated });
});

// Update user's role in a center
exports.updateUserCenterRole = catchAsyncErrors(async (req, res, next) => {
  const { roleName, weeklyContractHours } = req.body;
  if (roleName === undefined && weeklyContractHours === undefined) {
    return next(new ErrorHandler('Provide roleName or weeklyContractHours', 400));
  }

  const assignment = await UserCenterRole.findOne({ user: req.params.userId, center: req.params.id });
  if (!assignment) return next(new ErrorHandler('Assignment not found', 404));

  if (roleName !== undefined) {
    let role = await Role.findOne({ name: roleName });
    if (!role && roleName === 'limpieza') {
      role = await Role.create({
        name: 'limpieza',
        description: 'Limpieza - Completes cleaning tasks and check-in/out',
        permissions: ['view_own_tasks', 'complete_tasks', 'view_checklist', 'check_in_out'],
      });
    }
    if (!role) return next(new ErrorHandler(`Role '${roleName}' not found`, 404));
    assignment.role = role._id;
  }

  if (weeklyContractHours !== undefined) {
    if (weeklyContractHours === null || weeklyContractHours === '') {
      assignment.weeklyContractHours = null;
    } else {
      const parsedWeeklyContractHours = Number(weeklyContractHours);
      if (!Number.isFinite(parsedWeeklyContractHours) || parsedWeeklyContractHours < 0) {
        return next(new ErrorHandler('weeklyContractHours must be a valid number >= 0', 400));
      }
      assignment.weeklyContractHours = Number(parsedWeeklyContractHours.toFixed(2));
    }
  }

  await assignment.save();

  const populatedAssignment = await UserCenterRole.findById(assignment._id)
    .populate('user', 'name email active')
    .populate('role', 'name');

  res.status(200).json({ success: true, assignment: populatedAssignment });
});

exports.getCenterMonthlyOvertimeSummary = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { month, userId } = req.query;
  if (!month) {
    return next(new ErrorHandler('month query param is required', 400));
  }

  const { monthStart, monthEnd } = parseMonthRange(month);
  const queryStart = getStartOfIsoWeek(monthStart);
  const queryEnd = addDaysLocal(getStartOfIsoWeek(monthEnd), 6);
  const coachRole = await Role.findOne({ name: 'coach' });
  if (!coachRole) {
    return next(new ErrorHandler('Coach role not found', 404));
  }

  const assignmentFilter = {
    center: req.params.id,
    role: coachRole._id,
    active: true,
  };
  if (userId) assignmentFilter.user = userId;

  const assignments = await UserCenterRole.find(assignmentFilter)
    .populate('user', 'name email active')
    .populate('role', 'name');

  const validAssignments = assignments.filter((assignment) => Boolean(assignment.user?._id));
  const userIds = validAssignments.map((assignment) => assignment.user._id);
  const entries = userIds.length === 0
    ? []
    : await TimeEntry.find({
        center: req.params.id,
        user: { $in: userIds },
        date: {
          $gte: queryStart,
          $lt: endOfDayLocal(queryEnd),
        },
        status: 'completed',
      })
        .populate('user', 'name email')
        .sort({ date: 1, entryTime: 1 });

  const [patterns, vacationOverrides] = userIds.length === 0
    ? [[], []]
    : await Promise.all([
        ShiftPattern.find({ center: req.params.id, user: { $in: userIds }, active: true })
          .populate('user', 'name email')
          .populate('shift', 'name startTime endTime'),
        ShiftOverride.find({
          center: req.params.id,
          user: { $in: userIds },
          date: {
            $gte: queryStart,
            $lte: queryEnd,
          },
        }).populate('user', 'name email'),
      ]);

  const vacationCreditByUserDate = buildOffDayCreditMap({
    baseOccurrences: computeOccurrences(patterns.filter(hasResolvedUser), queryStart, queryEnd),
    overrides: vacationOverrides.filter(hasResolvedUser),
  });

  const aggregationMode = center.overtimeSettings?.monthlyAggregationMode || 'positive_only';
  const summaries = buildWeeklyOvertimeSummaries({
    month,
    assignments: validAssignments,
    entries,
    aggregationMode,
    vacationCreditByUserDate,
  });

  res.status(200).json({
    success: true,
    month,
    aggregationMode,
    summaries,
  });
});

// Remove a user from a center
exports.removeUserFromCenter = catchAsyncErrors(async (req, res, next) => {
  const deleted = await UserCenterRole.findOneAndDelete({
    user: req.params.userId,
    center: req.params.id,
  });

  if (!deleted) return next(new ErrorHandler('Assignment not found', 404));

  res.status(200).json({ success: true, message: 'User removed from center' });
});

exports.getCenterExtraIncentives = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const month = typeof req.query.month === 'string' ? req.query.month : '';
  const year = typeof req.query.year === 'string' ? req.query.year : '';
  const userId = typeof req.query.userId === 'string' ? req.query.userId : '';

  const filter = { center: req.params.id };
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return next(new ErrorHandler('month must be in format YYYY-MM', 400));
    }
    filter.month = month;
  } else if (year) {
    if (!/^\d{4}$/.test(year)) {
      return next(new ErrorHandler('year must be in format YYYY', 400));
    }
    filter.month = new RegExp(`^${year}-`);
  } else {
    return next(new ErrorHandler('Provide month (YYYY-MM) or year (YYYY)', 400));
  }

  if (userId) filter.user = userId;

  const incentives = await ExtraIncentive.find(filter)
    .populate('user', 'name email active')
    .populate('createdBy', 'name email')
    .sort({ month: -1, createdAt: -1 });

  res.status(200).json({
    success: true,
    incentives: incentives.filter((incentive) => Boolean(incentive.user)),
  });
});

exports.createCenterExtraIncentive = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { userId, month, concept, amount } = req.body;

  if (!userId || !month || !concept || amount === undefined) {
    return next(new ErrorHandler('userId, month, concept and amount are required', 400));
  }

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return next(new ErrorHandler('month must be in format YYYY-MM', 400));
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return next(new ErrorHandler('amount must be a number greater than 0', 400));
  }

  const assignment = await UserCenterRole.findOne({
    center: req.params.id,
    user: userId,
    active: true,
  });

  if (!assignment) {
    return next(new ErrorHandler('User is not assigned to this center', 400));
  }

  const incentive = await ExtraIncentive.create({
    center: req.params.id,
    user: userId,
    month,
    concept: String(concept).trim(),
    amount: Number(parsedAmount.toFixed(2)),
    createdBy: req.user.id,
  });

  const populated = await ExtraIncentive.findById(incentive._id)
    .populate('user', 'name email active')
    .populate('createdBy', 'name email');

  res.status(201).json({ success: true, incentive: populated });
});

exports.deleteCenterExtraIncentive = catchAsyncErrors(async (req, res, next) => {
  const incentive = await ExtraIncentive.findOneAndDelete({
    _id: req.params.incentiveId,
    center: req.params.id,
  });

  if (!incentive) return next(new ErrorHandler('Extra incentive not found', 404));

  res.status(200).json({ success: true, message: 'Extra incentive deleted' });
});

exports.getCenterRecurringIncentiveRules = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const rules = await RecurringIncentiveRule.find({ center: req.params.id })
    .populate('user', 'name email active')
    .populate('createdBy', 'name email')
    .sort({ active: -1, createdAt: -1 });

  res.status(200).json({
    success: true,
    rules: rules.filter((rule) => Boolean(rule.user)),
  });
});

exports.createCenterRecurringIncentiveRule = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { userId, concept, amount, startMonth, endMonth, active } = req.body;

  if (!userId || !concept || amount === undefined || !startMonth) {
    return next(new ErrorHandler('userId, concept, amount and startMonth are required', 400));
  }

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth)) {
    return next(new ErrorHandler('startMonth must be in format YYYY-MM', 400));
  }
  if (endMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth)) {
    return next(new ErrorHandler('endMonth must be in format YYYY-MM', 400));
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return next(new ErrorHandler('amount must be a number greater than 0', 400));
  }

  const assignment = await UserCenterRole.findOne({
    center: req.params.id,
    user: userId,
    active: true,
  });
  if (!assignment) {
    return next(new ErrorHandler('User is not assigned to this center', 400));
  }

  const rule = await RecurringIncentiveRule.create({
    center: req.params.id,
    user: userId,
    concept: String(concept).trim(),
    amount: Number(parsedAmount.toFixed(2)),
    startMonth,
    endMonth: endMonth || undefined,
    active: active !== false,
    createdBy: req.user.id,
  });

  const populated = await RecurringIncentiveRule.findById(rule._id)
    .populate('user', 'name email active')
    .populate('createdBy', 'name email');

  res.status(201).json({ success: true, rule: populated });
});

exports.updateCenterRecurringIncentiveRule = catchAsyncErrors(async (req, res, next) => {
  const rule = await RecurringIncentiveRule.findOne({
    _id: req.params.ruleId,
    center: req.params.id,
  });
  if (!rule) return next(new ErrorHandler('Recurring incentive rule not found', 404));

  const { concept, amount, startMonth, endMonth, active } = req.body;

  if (concept !== undefined) rule.concept = String(concept).trim();
  if (amount !== undefined) {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return next(new ErrorHandler('amount must be a number greater than 0', 400));
    }
    rule.amount = Number(parsed.toFixed(2));
  }
  if (startMonth !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth)) {
      return next(new ErrorHandler('startMonth must be in format YYYY-MM', 400));
    }
    rule.startMonth = startMonth;
  }
  if (endMonth !== undefined) {
    if (endMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth)) {
      return next(new ErrorHandler('endMonth must be in format YYYY-MM', 400));
    }
    rule.endMonth = endMonth || undefined;
  }
  if (active !== undefined) rule.active = !!active;

  await rule.save();

  const populated = await RecurringIncentiveRule.findById(rule._id)
    .populate('user', 'name email active')
    .populate('createdBy', 'name email');

  res.status(200).json({ success: true, rule: populated });
});

exports.deleteCenterRecurringIncentiveRule = catchAsyncErrors(async (req, res, next) => {
  const deleted = await RecurringIncentiveRule.findOneAndDelete({
    _id: req.params.ruleId,
    center: req.params.id,
  });

  if (!deleted) return next(new ErrorHandler('Recurring incentive rule not found', 404));

  res.status(200).json({ success: true, message: 'Recurring incentive rule deleted' });
});

function monthInRange(month, startMonth, endMonth) {
  if (month < startMonth) return false;
  if (endMonth && month > endMonth) return false;
  return true;
}

function assertMonthFormat(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) {
    throw new ErrorHandler('month must be in format YYYY-MM', 400);
  }
}

function assertDateFormat(date) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date || '')) {
    throw new ErrorHandler('date must be in format YYYY-MM-DD', 400);
  }
}

function monthFromDate(date) {
  return String(date).slice(0, 7);
}

function normalizeExpenseType(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'Otros';

  const lowered = normalized.toLowerCase();
  if (lowered === 'fixed' || lowered === 'gastos fijos' || lowered === 'gasto fijo') {
    return 'Gasto fijo';
  }
  if (lowered === 'sueldo' || lowered === 'sueldos') {
    return 'Sueldos';
  }

  return normalized;
}

async function syncRecurringExpensesForMonth({ centerId, month, userId }) {
  const recurringConcepts = await RecurringExpenseConcept.find({
    center: centerId,
    active: true,
  })
    .select('_id concept category expenseType comment paymentMethod supplier notes')
    .sort({ createdAt: 1 });

  if (!recurringConcepts.length) return;

  const recurringIds = recurringConcepts.map((concept) => concept._id);
  const alreadyCreated = await CenterExpense.find({
    center: centerId,
    month,
    recurringConcept: { $in: recurringIds },
  }).select('recurringConcept');

  const existingByRecurringId = new Set(alreadyCreated.map((item) => String(item.recurringConcept)));
  const missing = recurringConcepts.filter((concept) => !existingByRecurringId.has(String(concept._id)));

  if (!missing.length) return;

  await CenterExpense.insertMany(
    missing.map((concept) => ({
      center: centerId,
      date: `${month}-01`,
      month,
      concept: concept.concept,
      category: concept.category || 'General',
      expenseType: normalizeExpenseType(concept.expenseType),
      amount: 0,
      comment: concept.comment || '',
      paymentMethod: concept.paymentMethod || '',
      supplier: concept.supplier || '',
      notes: concept.notes || '',
      recurringConcept: concept._id,
      createdBy: userId,
      updatedBy: userId,
    }))
  );
}

function getWeekRangeFromDate(dateStr) {
  const start = getStartOfIsoWeek(dateStr);
  const end = addDaysLocal(start, 6);
  return {
    weekStart: formatLocalDateKey(start),
    weekEnd: formatLocalDateKey(end),
  };
}

function getSunday10LocalDateFromWeekStart(weekStart) {
  const start = startOfDayLocal(weekStart);
  const sunday = addDaysLocal(start, 6);
  sunday.setHours(10, 0, 0, 0);
  return sunday;
}

function parseDataUrlImage(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new ErrorHandler('imageDataUrl must be a valid base64 data URL (png/jpeg/webp)', 400);
  }

  const mimeType = match[1];
  const base64Content = String(match[3] || '').replace(/\s+/g, '');
  const bytes = Buffer.byteLength(base64Content, 'base64');
  if (bytes <= 0) {
    throw new ErrorHandler('imageDataUrl has no content', 400);
  }
  if (bytes > 5 * 1024 * 1024) {
    throw new ErrorHandler('imageDataUrl exceeds max size of 5MB', 400);
  }

  return {
    normalizedDataUrl: `data:${mimeType};base64,${base64Content}`,
    mimeType,
  };
}

function buildExpensesSummary({ manualExpenses, salaryExpenses }) {
  const incomeEntries = manualExpenses.filter((i) => i.entryType === 'income');
  const expenseEntries = manualExpenses.filter((i) => i.entryType !== 'income');

  const incomeTotal = incomeEntries.reduce((total, item) => total + Number(item.amount || 0), 0);
  const manualExpenseTotal = expenseEntries.reduce((total, item) => total + Number(item.amount || 0), 0);
  const salaryTotal = salaryExpenses.reduce((total, item) => total + Number(item.amount || 0), 0);
  const totalExpenses = manualExpenseTotal + salaryTotal;
  const manualTotal = manualExpenseTotal; // kept for backwards compat (only expense entries)
  const total = totalExpenses;
  const profit = incomeTotal - totalExpenses;

  const byCategoryMap = new Map();
  for (const item of expenseEntries) {
    const category = item.category || 'General';
    const current = byCategoryMap.get(category) || { category, amount: 0, count: 0 };
    current.amount += Number(item.amount || 0);
    current.count += 1;
    byCategoryMap.set(category, current);
  }

  const byCategory = Array.from(byCategoryMap.values())
    .map((row) => ({
      ...row,
      percentage: manualTotal > 0 ? Number(((row.amount / manualTotal) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const byTypeMap = new Map();
  for (const item of expenseEntries) {
    const type = normalizeExpenseType(item.expenseType);
    const current = byTypeMap.get(type) || { type, amount: 0, count: 0 };
    current.amount += Number(item.amount || 0);
    current.count += 1;
    byTypeMap.set(type, current);
  }
  if (salaryTotal > 0) {
    byTypeMap.set('payroll', {
      type: 'payroll',
      amount: salaryTotal,
      count: salaryExpenses.length,
    });
  }

  const byType = Array.from(byTypeMap.values())
    .map((row) => ({
      ...row,
      percentage: total > 0 ? Number(((row.amount / total) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const byIncomeCategoryMap = new Map();
  for (const item of incomeEntries) {
    const cat = item.incomeCategory || item.category || 'Ingreso';
    const current = byIncomeCategoryMap.get(cat) || { category: cat, amount: 0, count: 0 };
    current.amount += Number(item.amount || 0);
    current.count += 1;
    byIncomeCategoryMap.set(cat, current);
  }
  const byIncomeCategory = Array.from(byIncomeCategoryMap.values())
    .map((row) => ({
      ...row,
      percentage: incomeTotal > 0 ? Number(((row.amount / incomeTotal) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    manualTotal: Number(manualTotal.toFixed(2)),
    salaryTotal: Number(salaryTotal.toFixed(2)),
    total: Number(total.toFixed(2)),
    incomeTotal: Number(incomeTotal.toFixed(2)),
    incomeCount: incomeEntries.length,
    profit: Number(profit.toFixed(2)),
    manualCount: expenseEntries.length,
    salaryCount: salaryExpenses.length,
    averageManualExpense: expenseEntries.length > 0 ? Number((manualTotal / expenseEntries.length).toFixed(2)) : 0,
    byCategory,
    byType,
    byIncomeCategory,
  };
}

exports.applyRecurringIncentivesForMonth = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { month } = req.body;
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return next(new ErrorHandler('month is required in format YYYY-MM', 400));
  }

  const rules = await RecurringIncentiveRule.find({ center: req.params.id, active: true });
  const applicable = rules.filter((rule) => monthInRange(month, rule.startMonth, rule.endMonth));

  let createdCount = 0;
  for (const rule of applicable) {
    const exists = await ExtraIncentive.findOne({
      center: req.params.id,
      user: rule.user,
      month,
      concept: rule.concept,
      amount: rule.amount,
    });
    if (exists) continue;

    await ExtraIncentive.create({
      center: req.params.id,
      user: rule.user,
      month,
      concept: rule.concept,
      amount: rule.amount,
      createdBy: req.user.id,
    });
    createdCount += 1;
  }

  res.status(200).json({ success: true, createdCount, totalRules: applicable.length });
});

exports.getCenterPayroll = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const filter = { center: req.params.id };
  if (typeof req.query.userId === 'string' && req.query.userId) filter.user = req.query.userId;
  if (typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year)) {
    filter.month = new RegExp(`^${req.query.year}-`);
  }

  const entries = await PayrollEntry.find(filter)
    .populate('user', 'name email active')
    .populate('createdBy', 'name email')
    .sort({ month: 1, createdAt: -1 });

  const safeEntries = entries.filter((entry) => Boolean(entry.user));
  const totalsByUser = {};
  for (const entry of safeEntries) {
    const userId = entry.user._id.toString();
    const gross = Number(entry.grossSalary ?? entry.baseAmount ?? 0);
    const net = Number(entry.netSalary ?? entry.variableAmount ?? 0);
    const total = gross + net;
    if (!totalsByUser[userId]) {
      totalsByUser[userId] = { userId, userName: entry.user.name, total: 0, count: 0 };
    }
    totalsByUser[userId].total += total;
    totalsByUser[userId].count += 1;
  }

  res.status(200).json({
    success: true,
    entries: safeEntries,
    totalsByUser: Object.values(totalsByUser).sort((a, b) => b.total - a.total),
  });
});

exports.upsertCenterPayrollEntry = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { userId, month, grossSalary, netSalary, baseAmount, variableAmount, notes } = req.body;
  const hasGross = grossSalary !== undefined || baseAmount !== undefined;
  if (!userId || !month || !hasGross) {
    return next(new ErrorHandler('userId, month and grossSalary are required', 400));
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return next(new ErrorHandler('month must be in format YYYY-MM', 400));
  }

  const parsedGross = Number(grossSalary ?? baseAmount);
  const parsedNet = netSalary === undefined
    ? (variableAmount === undefined ? parsedGross : Number(variableAmount))
    : Number(netSalary);

  if (!Number.isFinite(parsedGross) || parsedGross < 0) {
    return next(new ErrorHandler('grossSalary must be a valid number >= 0', 400));
  }
  if (!Number.isFinite(parsedNet) || parsedNet < 0) {
    return next(new ErrorHandler('netSalary must be a valid number >= 0', 400));
  }

  const assignment = await UserCenterRole.findOne({ center: req.params.id, user: userId, active: true });
  if (!assignment) {
    return next(new ErrorHandler('User is not assigned to this center', 400));
  }

  const entry = await PayrollEntry.findOneAndUpdate(
    { center: req.params.id, user: userId, month },
    {
      center: req.params.id,
      user: userId,
      month,
      grossSalary: Number(parsedGross.toFixed(2)),
      netSalary: Number(parsedNet.toFixed(2)),
      // Keep legacy fields synchronized
      baseAmount: Number(parsedGross.toFixed(2)),
      variableAmount: Number(parsedNet.toFixed(2)),
      notes: notes ? String(notes).trim() : undefined,
      createdBy: req.user.id,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .populate('user', 'name email active')
    .populate('createdBy', 'name email');

  res.status(200).json({ success: true, entry });
});

exports.deleteCenterPayrollEntry = catchAsyncErrors(async (req, res, next) => {
  const deleted = await PayrollEntry.findOneAndDelete({
    _id: req.params.entryId,
    center: req.params.id,
  });

  if (!deleted) return next(new ErrorHandler('Payroll entry not found', 404));

  res.status(200).json({ success: true, message: 'Payroll entry deleted' });
});

exports.getCenterExpensesSummary = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const month = typeof req.query.month === 'string' && req.query.month
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  assertMonthFormat(month);

  await syncRecurringExpensesForMonth({
    centerId: req.params.id,
    month,
    userId: req.user.id,
  });

  const [manualExpenses, payrollEntries] = await Promise.all([
    CenterExpense.find({ center: req.params.id, month })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .populate('recurringConcept', 'concept category expenseType active')
      .sort({ date: 1, createdAt: 1 }),
    PayrollEntry.find({ center: req.params.id, month })
      .populate('user', 'name email active')
      .sort({ createdAt: 1 }),
  ]);

  const safePayrollEntries = payrollEntries.filter((entry) => Boolean(entry.user));
  const salaryExpenses = safePayrollEntries.map((entry) => ({
    _id: `salary-${entry._id}`,
    sourceType: 'salary',
    payrollEntryId: entry._id,
    month: entry.month,
    date: `${entry.month}-01`,
    category: 'Sueldos',
    concept: `Sueldo ${entry.user.name}`,
    amount: Number(entry.netSalary ?? entry.variableAmount ?? 0),
    netSalary: Number(entry.netSalary ?? entry.variableAmount ?? 0),
    notes: entry.notes || '',
    user: entry.user,
    createdAt: entry.createdAt,
  }));

  const summary = buildExpensesSummary({
    manualExpenses,
    salaryExpenses,
  });

  res.status(200).json({
    success: true,
    month,
    summary,
    manualExpenses,
    salaryExpenses,
  });
});

exports.createCenterExpense = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const {
    date,
    concept,
    category,
    expenseType,
    amount,
    comment,
    paymentMethod,
    supplier,
    notes,
    recurringConceptId,
    entryType,
    incomeCategory,
  } = req.body;

  assertDateFormat(date);
  if (!concept || !String(concept).trim()) {
    return next(new ErrorHandler('concept is required', 400));
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
    return next(new ErrorHandler('amount must be a number greater than or equal to 0', 400));
  }

  let recurringConcept = null;
  if (recurringConceptId) {
    recurringConcept = await RecurringExpenseConcept.findOne({
      _id: recurringConceptId,
      center: req.params.id,
    }).select('_id');
    if (!recurringConcept) {
      return next(new ErrorHandler('Recurring concept not found for this center', 404));
    }
  }

  const expense = await CenterExpense.create({
    center: req.params.id,
    date,
    month: monthFromDate(date),
    concept: String(concept).trim(),
    category: String(category || 'General').trim(),
    expenseType: normalizeExpenseType(expenseType),
    entryType: entryType === 'income' ? 'income' : 'expense',
    incomeCategory: incomeCategory ? String(incomeCategory).trim() : '',
    amount: Number(parsedAmount.toFixed(2)),
    comment: comment ? String(comment).trim() : '',
    paymentMethod: paymentMethod ? String(paymentMethod).trim() : '',
    supplier: supplier ? String(supplier).trim() : '',
    notes: notes ? String(notes).trim() : '',
    recurringConcept: recurringConcept ? recurringConcept._id : null,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });

  const populated = await CenterExpense.findById(expense._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .populate('recurringConcept', 'concept category expenseType active');

  res.status(201).json({ success: true, expense: populated });
});

exports.updateCenterExpense = catchAsyncErrors(async (req, res, next) => {
  const expense = await CenterExpense.findOne({
    _id: req.params.expenseId,
    center: req.params.id,
  });
  if (!expense) return next(new ErrorHandler('Expense not found', 404));

  const { date, concept, category, expenseType, amount, comment, paymentMethod, supplier, notes, entryType, incomeCategory } = req.body;

  if (date !== undefined) {
    assertDateFormat(date);
    expense.date = date;
    expense.month = monthFromDate(date);
  }
  if (concept !== undefined) {
    const normalizedConcept = String(concept).trim();
    if (!normalizedConcept) return next(new ErrorHandler('concept cannot be empty', 400));
    expense.concept = normalizedConcept;
  }
  if (category !== undefined) {
    expense.category = String(category || 'General').trim() || 'General';
  }
  if (expenseType !== undefined) {
    expense.expenseType = normalizeExpenseType(expenseType);
  }
  if (entryType !== undefined) {
    expense.entryType = entryType === 'income' ? 'income' : 'expense';
  }
  if (incomeCategory !== undefined) {
    expense.incomeCategory = String(incomeCategory || '').trim();
  }
  if (amount !== undefined) {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return next(new ErrorHandler('amount must be a number greater than or equal to 0', 400));
    }
    expense.amount = Number(parsedAmount.toFixed(2));
  }
  if (comment !== undefined) expense.comment = String(comment || '').trim();
  if (paymentMethod !== undefined) expense.paymentMethod = String(paymentMethod || '').trim();
  if (supplier !== undefined) expense.supplier = String(supplier || '').trim();
  if (notes !== undefined) expense.notes = String(notes || '').trim();
  expense.updatedBy = req.user.id;

  await expense.save();

  const populated = await CenterExpense.findById(expense._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .populate('recurringConcept', 'concept category expenseType active');

  res.status(200).json({ success: true, expense: populated });
});

exports.deleteCenterExpense = catchAsyncErrors(async (req, res, next) => {
  const expense = await CenterExpense.findOne({
    _id: req.params.expenseId,
    center: req.params.id,
  });

  if (!expense) return next(new ErrorHandler('Expense not found', 404));

  const shouldDeleteRecurring = String(req.query.deleteRecurringConcept || '').toLowerCase() === 'true';
  if (shouldDeleteRecurring && expense.recurringConcept) {
    await RecurringExpenseConcept.findOneAndUpdate(
      { _id: expense.recurringConcept, center: req.params.id },
      { active: false, updatedBy: req.user.id },
      { new: true }
    );
  }

  await CenterExpense.findByIdAndDelete(expense._id);

  res.status(200).json({ success: true, message: 'Expense deleted' });
});

exports.getCenterWeeklyPlanning = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('_id name type active');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const date = typeof req.query.date === 'string' && req.query.date
    ? req.query.date
    : formatLocalDateKey(new Date());
  assertDateFormat(date);

  const { weekStart, weekEnd } = getWeekRangeFromDate(date);

  const planning = await WeeklyPlanning.findOne({
    center: req.params.id,
    weekStart,
  })
    .populate('uploadedBy', 'name email')
    .sort({ createdAt: -1 });

  const message = planning ? buildPlanningMessage(weekStart) : null;

  res.status(200).json({
    success: true,
    weekStart,
    weekEnd,
    planning,
    whatsappPreview: planning
      ? {
        message,
        scheduledFor: planning.scheduledFor,
        sentAt: planning.sentAt,
        lastSendError: planning.lastSendError || '',
      }
      : null,
  });
});

exports.createCenterWeeklyPlanning = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('_id name type active');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { date, imageDataUrl } = req.body;
  assertDateFormat(date);

  const sourceDate = new Date(`${date}T12:00:00`);
  if (sourceDate.getDay() !== 4) {
    return next(new ErrorHandler('Weekly planning upload is only enabled on Thursdays', 400));
  }

  const { normalizedDataUrl, mimeType } = parseDataUrlImage(imageDataUrl);
  const { weekStart, weekEnd } = getWeekRangeFromDate(date);

  const planning = await WeeklyPlanning.create({
    center: req.params.id,
    weekStart,
    weekEnd,
    imageDataUrl: normalizedDataUrl,
    imageMimeType: mimeType,
    uploadedBy: req.user.id,
    scheduledFor: getSunday10LocalDateFromWeekStart(weekStart),
    sentAt: null,
    sendAttempts: 0,
    lastSendError: '',
  });

  const populated = await WeeklyPlanning.findById(planning._id)
    .populate('uploadedBy', 'name email');

  res.status(201).json({ success: true, planning: populated });
});

exports.getCenterDashboardReview = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('_id');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const month = typeof req.query.month === 'string' && req.query.month
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return next(new ErrorHandler('month must be in format YYYY-MM', 400));
  }

  const review = await CenterDashboardReview.findOne({
    center: req.params.id,
    month,
  }).populate('updatedBy', 'name email');

  let normalizedSections = [];

  if (review) {
    normalizedSections = normalizeDashboardReviewSections(review.sections);
  } else {
    // If there's no review for the requested month, inherit structure from latest previous month.
    // This keeps subapartado changes for future months, while preserving historical months untouched.
    const previousReview = await CenterDashboardReview.findOne({
      center: req.params.id,
      month: { $lt: month },
    })
      .sort({ month: -1 })
      .select('sections')
      .lean();

    if (previousReview?.sections?.length) {
      normalizedSections = resetDashboardReviewProgress(
        normalizeDashboardReviewSections(previousReview.sections)
      );
    } else {
      normalizedSections = buildDefaultDashboardReviewSections();
    }
  }

  const monthIndex = Number(month.split('-')[1]) - 1;
  const year = Number(month.split('-')[0]);
  const objectivesMap = await getCenterKpiObjectivesMap(req.params.id, year);

  const kpiAuto = await computeDashboardKpiAutoEvaluation({
    centerId: req.params.id,
    month,
  });
  const onlineObjectives = getDashboardOnlineObjectives(objectivesMap, monthIndex);

  normalizedSections = applyDashboardKpiAutoEvaluation(normalizedSections, kpiAuto);
  normalizedSections = evaluateDashboardOnlineItems(normalizedSections, onlineObjectives);

  const monthNumber = monthIndex + 1;
  const eventosObjective = readObjectiveMonthlyValue(objectivesMap, 'eventos_anio', 0);
  const eventosYTD = await computeSectionRecurrenciaYearToDate(
    req.params.id,
    year,
    month,
    normalizedSections,
    'eventos'
  );
  normalizedSections = applySectionRecurrenciaEvaluation(
    normalizedSections,
    'eventos',
    eventosYTD,
    eventosObjective,
    monthNumber
  );

  const promocionesObjectiveRaw = readObjectiveMonthlyValue(objectivesMap, 'promociones_anio', 0);
  const promocionesObjective = promocionesObjectiveRaw ?? 3;
  const promocionesYTD = await computeSectionRecurrenciaYearToDate(
    req.params.id,
    year,
    month,
    normalizedSections,
    'promociones'
  );
  normalizedSections = applySectionRecurrenciaEvaluation(
    normalizedSections,
    'promociones',
    promocionesYTD,
    promocionesObjective,
    monthNumber
  );

  res.status(200).json({
    success: true,
    month,
    kpiAuto,
    onlineObjectives,
    eventosYTD,
    eventosObjective,
    promocionesYTD,
    promocionesObjective,
    review: {
      center: req.params.id,
      month,
      sections: normalizedSections,
      updatedBy: review?.updatedBy || null,
      updatedAt: review?.updatedAt || null,
    },
  });
});

exports.upsertCenterDashboardReview = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('_id');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const month = typeof req.body.month === 'string' ? req.body.month : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return next(new ErrorHandler('month is required in format YYYY-MM', 400));
  }

  let sections = normalizeDashboardReviewSections(req.body.sections);

  const monthIndex = Number(month.split('-')[1]) - 1;
  const year = Number(month.split('-')[0]);
  const objectivesMap = await getCenterKpiObjectivesMap(req.params.id, year);
  const onlineObjectives = getDashboardOnlineObjectives(objectivesMap, monthIndex);

  sections = evaluateDashboardOnlineItems(sections, onlineObjectives);

  const monthNumber = monthIndex + 1;
  const eventosObjective = readObjectiveMonthlyValue(objectivesMap, 'eventos_anio', 0);
  const eventosYTD = await computeSectionRecurrenciaYearToDate(
    req.params.id,
    year,
    month,
    sections,
    'eventos'
  );
  sections = applySectionRecurrenciaEvaluation(
    sections,
    'eventos',
    eventosYTD,
    eventosObjective,
    monthNumber
  );

  const promocionesObjectiveRaw = readObjectiveMonthlyValue(objectivesMap, 'promociones_anio', 0);
  const promocionesObjective = promocionesObjectiveRaw ?? 3;
  const promocionesYTD = await computeSectionRecurrenciaYearToDate(
    req.params.id,
    year,
    month,
    sections,
    'promociones'
  );
  sections = applySectionRecurrenciaEvaluation(
    sections,
    'promociones',
    promocionesYTD,
    promocionesObjective,
    monthNumber
  );

  const review = await CenterDashboardReview.findOneAndUpdate(
    { center: req.params.id, month },
    {
      $set: {
        sections,
        updatedBy: req.user.id,
      },
      $setOnInsert: {
        createdBy: req.user.id,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).populate('updatedBy', 'name email');

  res.status(200).json({
    success: true,
    review: {
      center: req.params.id,
      month,
      sections: normalizeDashboardReviewSections(review.sections),
      updatedBy: review.updatedBy || null,
      updatedAt: review.updatedAt || null,
    },
  });
});

// ─── SHIFT DEFINITIONS ──────────────────────────────────────────────────────

// Get shift definitions for a center
exports.getCenterShifts = catchAsyncErrors(async (req, res, next) => {
  const shifts = await Shift.find({ center: req.params.id }).sort('startTime');
  res.status(200).json({ success: true, shifts });
});

// Create a shift definition
exports.createShift = catchAsyncErrors(async (req, res, next) => {
  const { name, startTime, endTime } = req.body;

  if (!name || !startTime || !endTime) {
    return next(new ErrorHandler('name, startTime and endTime are required', 400));
  }

  const shift = await Shift.create({ center: req.params.id, name, startTime, endTime });
  res.status(201).json({ success: true, shift });
});

// Update a shift definition
exports.updateShift = catchAsyncErrors(async (req, res, next) => {
  const shift = await Shift.findOne({ _id: req.params.shiftId, center: req.params.id });
  if (!shift) return next(new ErrorHandler('Shift not found', 404));

  const { name, startTime, endTime, active } = req.body;
  if (name) shift.name = name;
  if (startTime) shift.startTime = startTime;
  if (endTime) shift.endTime = endTime;
  if (active !== undefined) shift.active = active;

  await shift.save();
  res.status(200).json({ success: true, shift });
});

// Delete a shift definition
exports.deleteShift = catchAsyncErrors(async (req, res, next) => {
  const shift = await Shift.findOne({ _id: req.params.shiftId, center: req.params.id });
  if (!shift) return next(new ErrorHandler('Shift not found', 404));

  await Shift.findByIdAndDelete(shift._id);
  res.status(200).json({ success: true, message: 'Shift deleted' });
});

// ─── WORKER SHIFT ASSIGNMENTS ────────────────────────────────────────────────

// Get worker-shift assignments for a center (with optional date range)
exports.getWorkerShifts = catchAsyncErrors(async (req, res, next) => {
  const filter = { center: req.params.id };

  if (req.query.date) {
    const d = new Date(req.query.date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    filter.date = { $gte: start, $lt: end };
  } else if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }

  const workerShifts = await WorkerShift.find(filter)
    .populate('user', 'name email')
    .populate('shift', 'name startTime endTime')
    .sort('date');

  res.status(200).json({
    success: true,
    workerShifts: workerShifts.filter((item) => item.user && item.shift),
  });
});

// Assign a worker to a shift on a date
exports.assignWorkerShift = catchAsyncErrors(async (req, res, next) => {
  const { userId, shiftId, date } = req.body;

  if (!userId || !shiftId || !date) {
    return next(new ErrorHandler('userId, shiftId and date are required', 400));
  }

  const shift = await Shift.findOne({ _id: shiftId, center: req.params.id });
  if (!shift) return next(new ErrorHandler('Shift not found for this center', 404));

  const dateOnly = new Date(new Date(date).toISOString().split('T')[0]);

  const existing = await WorkerShift.findOne({
    user: userId,
    center: req.params.id,
    shift: shiftId,
    date: dateOnly,
  });
  if (existing) return next(new ErrorHandler('Worker already assigned to this shift on that date', 400));

  const ws = await WorkerShift.create({
    user: userId,
    center: req.params.id,
    shift: shiftId,
    date: dateOnly,
  });

  const populated = await ws.populate([
    { path: 'user', select: 'name email' },
    { path: 'shift', select: 'name startTime endTime' },
  ]);

  res.status(201).json({ success: true, workerShift: populated });
});

// Remove a worker shift assignment
exports.deleteWorkerShift = catchAsyncErrors(async (req, res, next) => {
  const ws = await WorkerShift.findOne({ _id: req.params.wsId, center: req.params.id });
  if (!ws) return next(new ErrorHandler('Assignment not found', 404));

  await WorkerShift.findByIdAndDelete(ws._id);
  res.status(200).json({ success: true, message: 'Assignment removed' });
});

// ─── CHECKLIST REVIEW (admin) ────────────────────────────────────────────────

// Get all checklists for a center (admin overview)
exports.getCenterChecklists = catchAsyncErrors(async (req, res, next) => {
  const filter = { center: req.params.id };

  if (req.query.date) {
    const d = new Date(req.query.date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    filter.date = { $gte: start, $lt: end };
  } else if (req.query.from && req.query.to) {
    const startRaw = new Date(req.query.from);
    const endRaw = new Date(req.query.to);
    const start = new Date(startRaw.getFullYear(), startRaw.getMonth(), startRaw.getDate());
    const end = new Date(endRaw.getFullYear(), endRaw.getMonth(), endRaw.getDate());
    end.setDate(end.getDate() + 1);
    filter.date = { $gte: start, $lt: end };
  }

  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;

  const checklists = await Checklist.find(filter)
    .populate('assignedUser', 'name email')
    .populate('items.doneBy', 'name email')
    .sort('-date');

  res.status(200).json({ success: true, checklists });
});

async function _getRoleNameInCenter(userId, centerId) {
  const assignment = await UserCenterRole.findOne({
    user: userId,
    center: centerId,
    active: true,
  }).populate('role', 'name');

  return assignment?.role?.name || null;
}

function _canManageVacationRequests(roleName, globalRole) {
  return globalRole === 'admin' || roleName === 'admin' || roleName === 'encargado';
}

async function _assertVacationConflictRules(centerId, userId, start, end, ignoreRequestId = null) {
  const rules = await VacationConflictRule.find({
    center: centerId,
    blockedUser: userId,
    active: true,
  });

  if (rules.length === 0) return;

  const primaryUserIds = rules.map((rule) => rule.primaryUser);
  const overlapping = await VacationRequest.find({
    center: centerId,
    _id: ignoreRequestId ? { $ne: ignoreRequestId } : { $exists: true },
    user: { $in: primaryUserIds },
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).populate('user', 'name');

  if (overlapping.length > 0) {
    const conflictingUsers = [...new Set(overlapping.map((request) => request.user?.name).filter(Boolean))];
    throw new ErrorHandler(
      `No se puede aprobar o solicitar porque coincide con vacaciones aprobadas de ${conflictingUsers.join(', ')}`,
      400
    );
  }
}

async function _buildWorkingDaySetForUser(centerId, userId, from, to, ignoreVacationRequestId = null) {
  const fromDate = startOfDayLocal(from);
  const toDate = startOfDayLocal(to);

  const [patterns, rawOverrides] = await Promise.all([
    ShiftPattern.find({
      center: centerId,
      user: userId,
      active: true,
    })
      .populate('user', 'name email')
      .populate('shift', 'name startTime endTime'),
    ShiftOverride.find({
      center: centerId,
      user: userId,
      date: { $gte: fromDate, $lte: toDate },
    }).populate('user', 'name email'),
  ]);

  const overrides = ignoreVacationRequestId
    ? rawOverrides.filter((override) => (
        override.reasonType !== 'vacation'
        || String(override.vacationRequest || '') !== String(ignoreVacationRequestId)
      ))
    : rawOverrides;

  const occurrences = applyOverrides(
    computeOccurrences(patterns.filter(hasResolvedUser), fromDate, toDate),
    overrides.filter(hasResolvedUser)
  );

  const workingDays = new Set();
  for (const occurrence of occurrences) {
    if (!occurrence.isOff) {
      workingDays.add(occurrence.date);
    }
  }

  return workingDays;
}

async function _assertVacationRangeAlignedWithWorkCycle(centerId, userId, start, end, ignoreVacationRequestId = null) {
  const startDate = startOfDayLocal(start);
  const endDate = startOfDayLocal(end);
  const dayBeforeStart = addDaysLocal(startDate, -1);
  const dayAfterEnd = addDaysLocal(endDate, 1);

  const workingDays = await _buildWorkingDaySetForUser(
    centerId,
    userId,
    dayBeforeStart,
    dayAfterEnd,
    ignoreVacationRequestId
  );

  const startKey = formatLocalDateKey(startDate);
  const dayBeforeKey = formatLocalDateKey(dayBeforeStart);
  const dayAfterKey = formatLocalDateKey(dayAfterEnd);

  if (!workingDays.has(startKey)) {
    throw new ErrorHandler(
      'Las vacaciones deben empezar el primer día en el que la persona tendría turno de trabajo',
      400
    );
  }

  if (workingDays.has(dayBeforeKey)) {
    throw new ErrorHandler(
      'Las vacaciones deben pedirse desde el primer día laborable: el día anterior también tenía turno',
      400
    );
  }

  if (!workingDays.has(dayAfterKey)) {
    throw new ErrorHandler(
      'La fecha fin debe ser el último día antes de volver a trabajar (el día siguiente debe tener turno)',
      400
    );
  }
}

async function _syncApprovedVacationOverrides(centerId, request) {
  await ShiftOverride.deleteMany({
    center: centerId,
    user: request.user,
    vacationRequest: request._id,
  });

  let current = new Date(_startOfDay(request.startDate));
  const end = _startOfDay(request.endDate);

  while (current <= end) {
    const dateOnly = _startOfDay(current);
    await ShiftOverride.findOneAndUpdate(
      { center: centerId, user: request.user, date: dateOnly },
      {
        center: centerId,
        user: request.user,
        vacationRequest: request._id,
        date: dateOnly,
        label: 'Vacaciones',
        startTime: undefined,
        endTime: undefined,
        isOff: true,
        reasonType: 'vacation',
        notes: request.reason,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    current.setDate(current.getDate() + 1);
  }
}

async function _backfillVacationRequestsFromOverrides(centerId, reviewedByUserId = null) {
  const overrides = await ShiftOverride.find({
    center: centerId,
    reasonType: 'vacation',
  })
    .sort({ user: 1, date: 1 })
    .select('_id user date notes vacationRequest');

  if (overrides.length === 0) return;

  const existingRequests = await VacationRequest.find({
    center: centerId,
    status: { $in: ['pending', 'approved'] },
  })
    .sort({ startDate: 1 })
    .select('_id user startDate endDate');

  const requestsById = new Map();
  const requestsByUser = new Map();

  for (const request of existingRequests) {
    const requestId = String(request._id);
    const userId = String(request.user);
    requestsById.set(requestId, request);
    const userRequests = requestsByUser.get(userId) || [];
    userRequests.push(request);
    requestsByUser.set(userId, userRequests);
  }

  const linkedOverrideOps = [];
  const pendingByUser = new Map();

  for (const override of overrides) {
    const userId = String(override.user);
    const dateValue = startOfDayLocal(override.date);
    const existingRequestId = override.vacationRequest ? String(override.vacationRequest) : null;
    if (existingRequestId && requestsById.has(existingRequestId)) {
      continue;
    }

    const coveringRequest = (requestsByUser.get(userId) || []).find((request) => (
      startOfDayLocal(request.startDate) <= dateValue && startOfDayLocal(request.endDate) >= dateValue
    ));

    if (coveringRequest) {
      linkedOverrideOps.push({
        updateOne: {
          filter: { _id: override._id },
          update: { $set: { vacationRequest: coveringRequest._id } },
        },
      });
      continue;
    }

    const userPending = pendingByUser.get(userId) || [];
    userPending.push(override);
    pendingByUser.set(userId, userPending);
  }

  if (linkedOverrideOps.length > 0) {
    await ShiftOverride.bulkWrite(linkedOverrideOps);
  }

  const createdLinkOps = [];

  for (const [userId, userOverrides] of pendingByUser.entries()) {
    if (userOverrides.length === 0) continue;

    userOverrides.sort((a, b) => startOfDayLocal(a.date) - startOfDayLocal(b.date));

    const ranges = [];
    let currentRange = null;

    for (const override of userOverrides) {
      const currentDate = startOfDayLocal(override.date);
      if (!currentRange) {
        currentRange = {
          startDate: currentDate,
          endDate: currentDate,
          notes: override.notes,
          overrideIds: [override._id],
        };
        continue;
      }

      const nextExpectedDate = addDaysLocal(currentRange.endDate, 1);
      if (formatLocalDateKey(currentDate) === formatLocalDateKey(nextExpectedDate)) {
        currentRange.endDate = currentDate;
        currentRange.overrideIds.push(override._id);
      } else {
        ranges.push(currentRange);
        currentRange = {
          startDate: currentDate,
          endDate: currentDate,
          notes: override.notes,
          overrideIds: [override._id],
        };
      }
    }

    if (currentRange) ranges.push(currentRange);

    for (const range of ranges) {
      const createdRequest = await VacationRequest.create({
        center: centerId,
        user: userId,
        startDate: startOfDayLocal(range.startDate),
        endDate: startOfDayLocal(range.endDate),
        reason: (range.notes || '').trim() || 'Vacaciones asignadas desde horario semanal',
        status: 'approved',
        reviewedBy: reviewedByUserId || null,
        reviewedAt: new Date(),
      });

      const userRequestList = requestsByUser.get(userId) || [];
      userRequestList.push(createdRequest);
      requestsByUser.set(userId, userRequestList);
      requestsById.set(String(createdRequest._id), createdRequest);

      for (const overrideId of range.overrideIds) {
        createdLinkOps.push({
          updateOne: {
            filter: { _id: overrideId },
            update: { $set: { vacationRequest: createdRequest._id } },
          },
        });
      }
    }
  }

  if (createdLinkOps.length > 0) {
    await ShiftOverride.bulkWrite(createdLinkOps);
  }
}

exports.getVacationRequests = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  const canManage = _canManageVacationRequests(roleName, req.user.role);

  if (!roleName && req.user.role !== 'admin') {
    return next(new ErrorHandler('Unauthorized for this center', 403));
  }

  await _backfillVacationRequestsFromOverrides(
    req.params.id,
    canManage ? req.user.id : null
  );

  const filter = { center: req.params.id };
  if (canManage) {
    if (req.query.status) filter.status = req.query.status;
    if (req.query.userId) filter.user = req.query.userId;
  } else {
    filter.$or = [
      { user: req.user.id },
      { user: { $ne: req.user.id }, status: 'approved' },
    ];
  }

  const requests = await VacationRequest.find(filter)
    .populate('user', 'name email')
    .populate('reviewedBy', 'name email')
    .sort({ createdAt: -1, startDate: -1 });

  res.status(200).json({
    success: true,
    requests: requests.filter((request) => request.user),
  });
});

exports.createVacationRequest = catchAsyncErrors(async (req, res, next) => {
  const { startDate, endDate, reason, userId } = req.body;
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  const canManage = _canManageVacationRequests(roleName, req.user.role);
  const requesterCanSelfRequest = ['coach', 'limpieza', 'encargado'].includes(roleName);
  if (!canManage && !requesterCanSelfRequest) {
    return next(new ErrorHandler('Only workers and managers can request vacation from Mis turnos', 403));
  }

  const targetUserId = canManage && userId ? userId : req.user.id;

  if (!startDate || !endDate || !reason?.trim()) {
    return next(new ErrorHandler('startDate, endDate and reason are required', 400));
  }

  const start = _startOfDay(startDate);
  const end = _startOfDay(endDate);
  if (end < start) {
    return next(new ErrorHandler('endDate cannot be earlier than startDate', 400));
  }

  await _assertVacationRangeAlignedWithWorkCycle(req.params.id, targetUserId, start, end);

  await _assertVacationConflictRules(req.params.id, targetUserId, start, end);

  const overlapping = await VacationRequest.findOne({
    center: req.params.id,
    user: targetUserId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });

  if (overlapping) {
    return next(new ErrorHandler('You already have a vacation request overlapping those dates', 400));
  }

  const createAsApproved = canManage && Boolean(userId);

  const request = await VacationRequest.create({
    center: req.params.id,
    user: targetUserId,
    startDate: start,
    endDate: end,
    reason: reason.trim(),
    status: createAsApproved ? 'approved' : 'pending',
    reviewedBy: createAsApproved ? req.user.id : null,
    reviewedAt: createAsApproved ? new Date() : null,
  });

  if (createAsApproved) {
    await _syncApprovedVacationOverrides(req.params.id, request);
  }

  const populated = await VacationRequest.findById(request._id)
    .populate('user', 'name email')
    .populate('reviewedBy', 'name email');

  res.status(201).json({ success: true, request: populated });
});

exports.reviewVacationRequest = catchAsyncErrors(async (req, res, next) => {
  const { status, reviewNotes, startDate, endDate } = req.body;
  const request = await VacationRequest.findOne({ _id: req.params.requestId, center: req.params.id });
  if (!request) return next(new ErrorHandler('Vacation request not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!_canManageVacationRequests(roleName, req.user.role)) {
    return next(new ErrorHandler('Unauthorized to review vacation requests', 403));
  }

  if (status && !['approved', 'denied'].includes(status)) {
    return next(new ErrorHandler('status must be approved or denied', 400));
  }

  const nextStartDate = startDate ? _startOfDay(startDate) : _startOfDay(request.startDate);
  const nextEndDate = endDate ? _startOfDay(endDate) : _startOfDay(request.endDate);

  if (nextEndDate < nextStartDate) {
    return next(new ErrorHandler('endDate cannot be earlier than startDate', 400));
  }

  await _assertVacationRangeAlignedWithWorkCycle(
    req.params.id,
    request.user,
    nextStartDate,
    nextEndDate,
    request._id
  );

  const overlapping = await VacationRequest.findOne({
    center: req.params.id,
    user: request.user,
    _id: { $ne: request._id },
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: nextEndDate },
    endDate: { $gte: nextStartDate },
  });

  if (overlapping) {
    return next(new ErrorHandler('This user already has another vacation request overlapping those dates', 400));
  }

  const nextStatus = status || request.status;

  if (nextStatus === 'approved') {
    await _assertVacationConflictRules(req.params.id, request.user, nextStartDate, nextEndDate, request._id);
  }

  request.startDate = nextStartDate;
  request.endDate = nextEndDate;
  request.status = nextStatus;
  if (reviewNotes !== undefined) {
    request.reviewNotes = reviewNotes || undefined;
  }
  request.reviewedBy = req.user.id;
  request.reviewedAt = new Date();

  await request.save();

  await ShiftOverride.deleteMany({
    center: req.params.id,
    user: request.user,
    vacationRequest: request._id,
  });

  if (nextStatus === 'approved') {
    await _syncApprovedVacationOverrides(req.params.id, request);
  }

  const populated = await VacationRequest.findById(request._id)
    .populate('user', 'name email')
    .populate('reviewedBy', 'name email');

  res.status(200).json({ success: true, request: populated });
});

exports.getVacationConflictRules = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!_canManageVacationRequests(roleName, req.user.role)) {
    return next(new ErrorHandler('Unauthorized to manage vacation conflict rules', 403));
  }

  const rules = await VacationConflictRule.find({ center: req.params.id, active: true })
    .populate('primaryUser', 'name email')
    .populate('blockedUser', 'name email')
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    rules: rules.filter((rule) => rule.primaryUser && rule.blockedUser),
  });
});

exports.createVacationConflictRule = catchAsyncErrors(async (req, res, next) => {
  const { primaryUserId, blockedUserId } = req.body;
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!_canManageVacationRequests(roleName, req.user.role)) {
    return next(new ErrorHandler('Unauthorized to manage vacation conflict rules', 403));
  }

  if (!primaryUserId || !blockedUserId) {
    return next(new ErrorHandler('primaryUserId and blockedUserId are required', 400));
  }
  if (primaryUserId === blockedUserId) {
    return next(new ErrorHandler('Select two different people', 400));
  }

  const rule = await VacationConflictRule.create({
    center: req.params.id,
    primaryUser: primaryUserId,
    blockedUser: blockedUserId,
  });

  const populated = await VacationConflictRule.findById(rule._id)
    .populate('primaryUser', 'name email')
    .populate('blockedUser', 'name email');

  res.status(201).json({ success: true, rule: populated });
});

exports.deleteVacationConflictRule = catchAsyncErrors(async (req, res, next) => {
  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!_canManageVacationRequests(roleName, req.user.role)) {
    return next(new ErrorHandler('Unauthorized to manage vacation conflict rules', 403));
  }

  const rule = await VacationConflictRule.findOneAndDelete({ _id: req.params.ruleId, center: req.params.id });
  if (!rule) return next(new ErrorHandler('Vacation conflict rule not found', 404));

  res.status(200).json({ success: true, message: 'Vacation conflict rule deleted' });
});

// ─── SHIFT PATTERNS (recurring schedules) ────────────────────────────────────

function _startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function _formatLocalDate(date) {
  const d = _startOfDay(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _getSegmentsForPattern(pattern, dayOfWeek) {
  const dayOverride = (pattern.dayTimeOverrides || []).find((override) => override.dayOfWeek === dayOfWeek);
  if (dayOverride?.segments?.length) return dayOverride.segments;
  if (dayOverride?.startTime && dayOverride?.endTime) {
    return [{ startTime: dayOverride.startTime, endTime: dayOverride.endTime }];
  }
  if (pattern.timeSegments?.length) return pattern.timeSegments;
  if (pattern.startTimeOverride && pattern.endTimeOverride) {
    return [{ startTime: pattern.startTimeOverride, endTime: pattern.endTimeOverride }];
  }
  if (pattern.shift?.startTime && pattern.shift?.endTime) {
    return [{ startTime: pattern.shift.startTime, endTime: pattern.shift.endTime }];
  }
  return [];
}

// Returns the Monday of the week containing `date`
function _startOfISOWeek(date) {
  const d = _startOfDay(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Compute all occurrences for an array of populated ShiftPattern documents
 * within the [from, to] date range (inclusive).
 */
function computeOccurrences(patterns, from, to) {
  const results = [];
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  const fromDay = _startOfDay(from);
  const toDay = _startOfDay(to);

  for (const pattern of patterns) {
    if (!pattern.active) continue;
    if (!pattern.user?._id) continue;

    const patStart = _startOfDay(pattern.startDate);
    const patEnd = pattern.endDate ? _startOfDay(pattern.endDate) : null;

    const effFrom = fromDay > patStart ? fromDay : patStart;
    const effTo = patEnd && patEnd < toDay ? patEnd : toDay;

    if (effFrom > effTo) continue;

    let current = new Date(effFrom);
    while (current <= effTo) {
      const dayOfWeek = current.getDay();

      if (pattern.daysOfWeek.includes(dayOfWeek)) {
        let applies = false;

        if (pattern.recurrence === 'once' || pattern.recurrence === 'weekly') {
          applies = true;
        } else if (pattern.recurrence === 'biweekly') {
          const weekDiff = Math.round(
            (_startOfISOWeek(current) - _startOfISOWeek(patStart)) / MS_PER_WEEK
          );
          applies = weekDiff % 2 === 0;
        } else if (pattern.recurrence === 'monthly') {
          const weekDiff = Math.round(
            (_startOfISOWeek(current) - _startOfISOWeek(patStart)) / MS_PER_WEEK
          );
          applies = weekDiff % 4 === 0;
        } else if (pattern.recurrence === 'custom_cycle') {
          const weekDiff = Math.round(
            (_startOfISOWeek(current) - _startOfISOWeek(patStart)) / MS_PER_WEEK
          );
          const cycleLength = pattern.cycleLengthWeeks || 1;
          const cycleWeek = ((weekDiff % cycleLength) + cycleLength) % cycleLength + 1;
          applies = (pattern.cycleWeeks || [1]).includes(cycleWeek);
        }

        if (applies) {
          const sh = pattern.shift;
          const usr = pattern.user;
          const segments = _getSegmentsForPattern(pattern, dayOfWeek);
          for (const segment of segments) {
            results.push({
              date: _formatLocalDate(current),
              userId: (usr._id || usr).toString(),
              userName: usr.name || '',
              userEmail: usr.email || '',
              patternId: pattern._id.toString(),
              shiftId: sh ? (sh._id || sh).toString() : '',
              shiftName: pattern.label || sh?.name || 'Turno',
              startTime: segment.startTime || '',
              endTime: segment.endTime || '',
              timeSegments: segments,
              recurrence: pattern.recurrence,
              cycleLengthWeeks: pattern.cycleLengthWeeks || 1,
              cycleWeeks: pattern.cycleWeeks || [1],
              dayTimeOverrides: pattern.dayTimeOverrides || [],
              label: pattern.label || sh?.name || 'Turno',
              notes: pattern.notes || '',
            });
          }
        }
      }

      current = new Date(current);
      current.setDate(current.getDate() + 1);
    }
  }

  results.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return results;
}

function applyOverrides(baseOccurrences, overrides) {
  const byKey = new Map();

  for (const occurrence of baseOccurrences) {
    byKey.set(`${occurrence.userId}|${occurrence.date}`, occurrence);
  }

  for (const override of overrides) {
    if (!override.user?._id) continue;
    const date = _formatLocalDate(override.date);
    const userId = override.user._id.toString();
    const key = `${userId}|${date}`;
    byKey.delete(key);

    byKey.set(key, {
      date,
      userId,
      userName: override.user.name,
      userEmail: override.user.email,
      patternId: '',
      shiftId: '',
      shiftName: override.label || (override.isOff ? 'No laborable' : 'Turno'),
      startTime: override.isOff ? '' : override.startTime || '',
      endTime: override.isOff ? '' : override.endTime || '',
      timeSegments: override.isOff
        ? []
        : override.segments?.length
          ? override.segments
          : override.startTime && override.endTime
            ? [{ startTime: override.startTime, endTime: override.endTime }]
            : [],
      recurrence: 'override',
      cycleLengthWeeks: 1,
      cycleWeeks: [1],
      dayTimeOverrides: [],
      label: override.label || (override.isOff ? 'No laborable' : 'Turno'),
      notes: override.notes || '',
      isOverride: true,
      isOff: !!override.isOff,
      reasonType: override.reasonType || 'custom',
      overrideId: override._id.toString(),
    });
  }

  return Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date) || a.userName.localeCompare(b.userName));
}

// List shift patterns for a center
exports.getShiftPatterns = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const filter = { center: req.params.id };
  if (req.user.role !== 'admin') filter.user = req.user.id;

  const patterns = await ShiftPattern.find(filter)
    .populate('user', 'name email')
    .populate('shift', 'name startTime endTime')
    .sort('-createdAt');

  res.status(200).json({ success: true, patterns: patterns.filter(hasResolvedUser) });
});

// Create a shift pattern (admin only)
exports.createShiftPattern = catchAsyncErrors(async (req, res, next) => {
  const {
    userId, shiftId, label, daysOfWeek, recurrence, startDate, endDate,
    startTimeOverride, endTimeOverride, timeSegments, notes, cycleLengthWeeks, cycleWeeks, dayTimeOverrides,
  } = req.body;

  if (!userId || !daysOfWeek || !daysOfWeek.length || !startDate) {
    return next(new ErrorHandler('userId, daysOfWeek and startDate are required', 400));
  }

  if (endDate && _startOfDay(endDate) < _startOfDay(startDate)) {
    return next(new ErrorHandler('endDate cannot be earlier than startDate', 400));
  }

  if (recurrence === 'custom_cycle') {
    if (!cycleLengthWeeks || cycleLengthWeeks < 1) {
      return next(new ErrorHandler('cycleLengthWeeks is required for custom cycle patterns', 400));
    }

    if (!cycleWeeks || !cycleWeeks.length) {
      return next(new ErrorHandler('Select at least one cycle week for custom cycle patterns', 400));
    }
  }

  let shift = null;
  if (shiftId) {
    shift = await Shift.findOne({ _id: shiftId, center: req.params.id });
    if (!shift) return next(new ErrorHandler('Shift not found for this center', 404));
  }

  const pattern = await ShiftPattern.create({
    center: req.params.id,
    user: userId,
    shift: shift?._id,
    label: label || shift?.name || undefined,
    daysOfWeek,
    recurrence: recurrence || 'weekly',
    cycleLengthWeeks: recurrence === 'custom_cycle' ? cycleLengthWeeks : 1,
    cycleWeeks: recurrence === 'custom_cycle' ? cycleWeeks : [1],
    startDate: new Date(startDate),
    endDate: endDate ? new Date(endDate) : undefined,
    startTimeOverride: startTimeOverride || undefined,
    endTimeOverride: endTimeOverride || undefined,
    timeSegments: timeSegments || [],
    dayTimeOverrides: dayTimeOverrides || [],
    notes: notes || undefined,
  });

  const populated = await ShiftPattern.findById(pattern._id)
    .populate('user', 'name email')
    .populate('shift', 'name startTime endTime');

  res.status(201).json({ success: true, pattern: populated });
});

// Update a shift pattern (admin only)
exports.updateShiftPattern = catchAsyncErrors(async (req, res, next) => {
  const pattern = await ShiftPattern.findOne({ _id: req.params.patternId, center: req.params.id });
  if (!pattern) return next(new ErrorHandler('Pattern not found', 404));

  const nextStartDate = req.body.startDate !== undefined ? req.body.startDate : pattern.startDate;
  const nextEndDate = req.body.endDate !== undefined ? req.body.endDate : pattern.endDate;
  if (nextEndDate && _startOfDay(nextEndDate) < _startOfDay(nextStartDate)) {
    return next(new ErrorHandler('endDate cannot be earlier than startDate', 400));
  }

  const fields = [
    'daysOfWeek', 'recurrence', 'startDate', 'endDate',
    'startTimeOverride', 'endTimeOverride', 'timeSegments', 'notes', 'active',
    'cycleLengthWeeks', 'cycleWeeks', 'dayTimeOverrides',
  ];
  for (const key of fields) {
    if (req.body[key] !== undefined) {
      pattern[key] = key === 'startDate' || key === 'endDate'
        ? req.body[key] ? new Date(req.body[key]) : undefined
        : req.body[key];
    }
  }

  if (req.body.shiftId) {
    const shift = await Shift.findOne({ _id: req.body.shiftId, center: req.params.id });
    if (!shift) return next(new ErrorHandler('Shift not found for this center', 404));
    pattern.shift = shift._id;
    if (!req.body.label && !pattern.label) {
      pattern.label = shift.name;
    }
  } else if (req.body.shiftId === '' || req.body.shiftId === null) {
    pattern.shift = null;
  }

  if (req.body.label !== undefined) {
    pattern.label = req.body.label || undefined;
  }

  if (pattern.recurrence !== 'custom_cycle') {
    pattern.cycleLengthWeeks = 1;
    pattern.cycleWeeks = [1];
  }

  await pattern.save();

  const populated = await ShiftPattern.findById(pattern._id)
    .populate('user', 'name email')
    .populate('shift', 'name startTime endTime');

  res.status(200).json({ success: true, pattern: populated });
});

// Delete a shift pattern (admin only)
exports.deleteShiftPattern = catchAsyncErrors(async (req, res, next) => {
  const pattern = await ShiftPattern.findOne({ _id: req.params.patternId, center: req.params.id });
  if (!pattern) return next(new ErrorHandler('Pattern not found', 404));

  await ShiftPattern.findByIdAndDelete(pattern._id);
  res.status(200).json({ success: true, message: 'Pattern deleted' });
});

exports.upsertShiftOverride = catchAsyncErrors(async (req, res, next) => {
  const { userId, date, endDate, label, startTime, endTime, segments, isOff, notes, reasonType, vacationRequestId } = req.body;

  if (!userId || !date) {
    return next(new ErrorHandler('userId and date are required', 400));
  }

  const effectiveSegments = Array.isArray(segments)
    ? segments.filter((s) => s.startTime && s.endTime)
    : [];
  const effectiveStartTime = effectiveSegments.length > 0 ? effectiveSegments[0].startTime : startTime;
  const effectiveEndTime = effectiveSegments.length > 0 ? effectiveSegments[effectiveSegments.length - 1].endTime : endTime;

  if (!isOff && (!label || (!effectiveStartTime || !effectiveEndTime))) {
    return next(new ErrorHandler('label, startTime and endTime are required unless the day is marked off', 400));
  }

  const normalizedReasonType = ['custom', 'holiday', 'vacation'].includes(reasonType) ? reasonType : 'custom';

  if (normalizedReasonType === 'vacation' && !isOff) {
    return next(new ErrorHandler('Vacation overrides must be marked off', 400));
  }

  const start = _startOfDay(date);
  const end = endDate ? _startOfDay(endDate) : start;

  if (end < start) {
    return next(new ErrorHandler('endDate cannot be earlier than date', 400));
  }

  const savedOverrides = [];
  let linkedVacationRequest = null;

  if (normalizedReasonType === 'vacation') {
    await _assertVacationRangeAlignedWithWorkCycle(req.params.id, userId, start, end, vacationRequestId || null);
    await _assertVacationConflictRules(req.params.id, userId, start, end, vacationRequestId || null);

    const overlapFilter = {
      center: req.params.id,
      user: userId,
      status: { $in: ['pending', 'approved'] },
      startDate: { $lte: end },
      endDate: { $gte: start },
    };

    if (vacationRequestId) {
      overlapFilter._id = { $ne: vacationRequestId };
    }

    const overlappingRequest = await VacationRequest.findOne(overlapFilter);
    if (overlappingRequest) {
      return next(new ErrorHandler('This user already has another vacation request overlapping those dates', 400));
    }

    if (vacationRequestId) {
      linkedVacationRequest = await VacationRequest.findOneAndUpdate(
        { _id: vacationRequestId, center: req.params.id, user: userId },
        {
          startDate: start,
          endDate: end,
          reason: notes?.trim() || 'Vacaciones asignadas manualmente',
          status: 'approved',
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
        },
        { new: true }
      );
    }

    if (!linkedVacationRequest) {
      linkedVacationRequest = await VacationRequest.create({
        center: req.params.id,
        user: userId,
        startDate: start,
        endDate: end,
        reason: notes?.trim() || 'Vacaciones asignadas manualmente',
        status: 'approved',
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
      });
    }

    await ShiftOverride.deleteMany({
      center: req.params.id,
      user: userId,
      vacationRequest: linkedVacationRequest._id,
    });
  }

  let current = new Date(start);
  while (current <= end) {
    const dateOnly = _startOfDay(current);
    const override = await ShiftOverride.findOneAndUpdate(
      { center: req.params.id, user: userId, date: dateOnly },
      {
        center: req.params.id,
        user: userId,
        vacationRequest: normalizedReasonType === 'vacation' ? linkedVacationRequest?._id : undefined,
        date: dateOnly,
        label: label || (normalizedReasonType === 'vacation' ? 'Vacaciones' : normalizedReasonType === 'holiday' ? 'Festivo' : undefined),
        startTime: isOff ? undefined : effectiveStartTime,
        endTime: isOff ? undefined : effectiveEndTime,
        segments: isOff ? [] : effectiveSegments,
        isOff: !!isOff,
        reasonType: normalizedReasonType,
        notes: notes || undefined,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email');
    savedOverrides.push(override);
    current.setDate(current.getDate() + 1);
  }

  res.status(200).json({ success: true, overrides: savedOverrides });
});

exports.deleteShiftOverride = catchAsyncErrors(async (req, res, next) => {
  const override = await ShiftOverride.findOneAndDelete({ _id: req.params.overrideId, center: req.params.id });
  if (!override) return next(new ErrorHandler('Override not found', 404));
  res.status(200).json({ success: true, message: 'Override deleted' });
});

// Get computed shift calendar for a center (admin: all workers; others: own only)
exports.getShiftCalendar = catchAsyncErrors(async (req, res, next) => {
  const { from, to, ignoreVacationRequestId } = req.query;
  if (!from || !to) {
    return next(new ErrorHandler('from and to query params (YYYY-MM-DD) are required', 400));
  }

  // Limit range to 400 days to prevent abuse
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const diffDays = (toDate - fromDate) / (24 * 60 * 60 * 1000);
  if (diffDays < 0 || diffDays > 400) {
    return next(new ErrorHandler('Date range must be between 0 and 400 days', 400));
  }

  const filter = { center: req.params.id, active: true };
  const roleName = req.user.role === 'admin' ? 'admin' : await _getRoleNameInCenter(req.user.id, req.params.id);
  const canReviewCenterCalendar = roleName === 'admin' || roleName === 'encargado';
  if (!canReviewCenterCalendar) filter.user = req.user.id;

  const patterns = await ShiftPattern.find(filter)
    .populate('user', 'name email')
    .populate('shift', 'name startTime endTime');

  const overrideFilter = {
    center: req.params.id,
    date: { $gte: _startOfDay(fromDate), $lte: _startOfDay(toDate) },
  };
  if (roleName !== 'coach' && !canReviewCenterCalendar) overrideFilter.user = req.user.id;

  let overrides = await ShiftOverride.find(overrideFilter).populate('user', 'name email');

  if (ignoreVacationRequestId) {
    overrides = overrides.filter((override) => {
      if (override.reasonType !== 'vacation') return true;
      return String(override.vacationRequest || '') !== String(ignoreVacationRequestId);
    });
  }

  let occurrences = applyOverrides(
    computeOccurrences(patterns.filter(hasResolvedUser), fromDate, toDate),
    overrides.filter(hasResolvedUser)
  );

  occurrences = occurrences.map((occurrence) => {
    const matchedOverride = overrides.find((override) => (
      String(override.user?._id || '') === String(occurrence.userId)
      && _formatLocalDate(override.date) === occurrence.date
      && occurrence.isOverride
    ));

    return {
      ...occurrence,
      vacationRequestId: matchedOverride?.vacationRequest ? String(matchedOverride.vacationRequest) : undefined,
    };
  });

  if (roleName === 'coach') {
    occurrences = occurrences.filter((occ) => occ.userId === req.user.id || occ.reasonType === 'vacation');
  }
  res.status(200).json({ success: true, occurrences });
});

exports.getCenterRecurringExpenseConcepts = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('_id');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const activeOnly = String(req.query.activeOnly || 'true') !== 'false';
  const filter = { center: req.params.id };
  if (activeOnly) filter.active = true;

  const concepts = await RecurringExpenseConcept.find(filter)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .sort({ createdAt: 1 });

  res.status(200).json({ success: true, concepts });
});

exports.createCenterRecurringExpenseConcept = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { concept, category, expenseType, comment, paymentMethod, supplier, notes, active } = req.body;

  if (!concept || !String(concept).trim()) {
    return next(new ErrorHandler('concept is required', 400));
  }

  const recurringConcept = await RecurringExpenseConcept.create({
    center: req.params.id,
    concept: String(concept).trim(),
    category: String(category || 'General').trim() || 'General',
    expenseType: normalizeExpenseType(expenseType || center.expenseTypes?.[0] || 'Gasto fijo'),
    comment: comment ? String(comment).trim() : '',
    paymentMethod: paymentMethod ? String(paymentMethod).trim() : '',
    supplier: supplier ? String(supplier).trim() : '',
    notes: notes ? String(notes).trim() : '',
    active: active !== undefined ? Boolean(active) : true,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });

  const populated = await RecurringExpenseConcept.findById(recurringConcept._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');

  res.status(201).json({ success: true, concept: populated });
});

exports.updateCenterRecurringExpenseConcept = catchAsyncErrors(async (req, res, next) => {
  const concept = await RecurringExpenseConcept.findOne({
    _id: req.params.conceptId,
    center: req.params.id,
  });
  if (!concept) return next(new ErrorHandler('Recurring concept not found', 404));

  const { concept: conceptName, category, expenseType, comment, paymentMethod, supplier, notes, active } = req.body;

  if (conceptName !== undefined) {
    const normalizedConcept = String(conceptName).trim();
    if (!normalizedConcept) return next(new ErrorHandler('concept cannot be empty', 400));
    concept.concept = normalizedConcept;
  }
  if (category !== undefined) {
    concept.category = String(category || 'General').trim() || 'General';
  }
  if (expenseType !== undefined) {
    concept.expenseType = normalizeExpenseType(expenseType);
  }
  if (comment !== undefined) concept.comment = String(comment || '').trim();
  if (paymentMethod !== undefined) concept.paymentMethod = String(paymentMethod || '').trim();
  if (supplier !== undefined) concept.supplier = String(supplier || '').trim();
  if (notes !== undefined) concept.notes = String(notes || '').trim();
  if (active !== undefined) concept.active = Boolean(active);
  concept.updatedBy = req.user.id;

  await concept.save();

  const populated = await RecurringExpenseConcept.findById(concept._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');

  res.status(200).json({ success: true, concept: populated });
});

exports.deleteCenterRecurringExpenseConcept = catchAsyncErrors(async (req, res, next) => {
  const concept = await RecurringExpenseConcept.findOne({
    _id: req.params.conceptId,
    center: req.params.id,
  });
  if (!concept) return next(new ErrorHandler('Recurring concept not found', 404));

  concept.active = false;
  concept.updatedBy = req.user.id;
  await concept.save();

  res.status(200).json({ success: true, message: 'Recurring concept deactivated' });
});

exports.toggleExpenseChecked = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const expense = await CenterExpense.findOne({
    _id: req.params.expenseId,
    center: req.params.id,
  });
  if (!expense) return next(new ErrorHandler('Expense not found', 404));

  expense.checked = !expense.checked;
  await expense.save();

  res.status(200).json({ success: true, expense });
});

exports.getCenterExpenseTypes = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('expenseTypes');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const [manualTypes, recurringTypes] = await Promise.all([
    CenterExpense.distinct('expenseType', { center: req.params.id }),
    RecurringExpenseConcept.distinct('expenseType', { center: req.params.id }),
  ]);

  const mergedTypes = [];
  const allSources = [
    ...(center.expenseTypes || []),
    ...(manualTypes || []),
    ...(recurringTypes || []),
  ];

  for (const rawType of allSources) {
    const canonicalType = normalizeExpenseType(rawType);
    if (!canonicalType) continue;
    if (!mergedTypes.includes(canonicalType)) mergedTypes.push(canonicalType);
  }

  if (!mergedTypes.includes('Sueldos')) mergedTypes.push('Sueldos');

  if (mergedTypes.length === 0) mergedTypes.push('Gasto fijo');

  const currentTypes = center.expenseTypes || [];
  const changed =
    currentTypes.length !== mergedTypes.length ||
    currentTypes.some((type, index) => type !== mergedTypes[index]);

  if (changed) {
    center.expenseTypes = mergedTypes;
    await center.save();
  }

  res.status(200).json({
    success: true,
    types: mergedTypes,
  });
});

exports.addExpenseType = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { type } = req.body;
  if (!type || !String(type).trim()) {
    return next(new ErrorHandler('Type is required', 400));
  }

  const typeTrimmed = String(type).trim();
  if (center.expenseTypes?.includes(typeTrimmed)) {
    return next(new ErrorHandler('Type already exists', 400));
  }

  if (!Array.isArray(center.expenseTypes)) center.expenseTypes = [];
  center.expenseTypes.push(typeTrimmed);
  await center.save();

  res.status(201).json({ success: true, types: center.expenseTypes });
});

exports.updateExpenseType = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { oldType, newType } = req.body;
  if (!oldType || !newType) {
    return next(new ErrorHandler('oldType and newType are required', 400));
  }

  const oldIndex = center.expenseTypes?.indexOf(oldType) ?? -1;
  if (oldIndex === -1) {
    return next(new ErrorHandler('Type not found', 404));
  }

  const newTypeTrimmed = String(newType).trim();
  if (!newTypeTrimmed) {
    return next(new ErrorHandler('newType cannot be empty', 400));
  }
  if (center.expenseTypes.includes(newTypeTrimmed) && newTypeTrimmed !== oldType) {
    return next(new ErrorHandler('New type already exists', 400));
  }

  center.expenseTypes[oldIndex] = newTypeTrimmed;

  await Promise.all([
    CenterExpense.updateMany(
      { center: req.params.id, expenseType: oldType },
      { expenseType: newTypeTrimmed }
    ),
    RecurringExpenseConcept.updateMany(
      { center: req.params.id, expenseType: oldType },
      { expenseType: newTypeTrimmed }
    ),
  ]);

  await center.save();

  res.status(200).json({ success: true, types: center.expenseTypes });
});

exports.deleteExpenseType = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { type } = req.body;
  if (!type) {
    return next(new ErrorHandler('Type is required', 400));
  }

  if (normalizeExpenseType(type) === 'Sueldos') {
    return next(new ErrorHandler('Sueldos type is mandatory and cannot be deleted', 400));
  }

  const index = center.expenseTypes?.indexOf(type) ?? -1;
  if (index === -1) {
    return next(new ErrorHandler('Type not found', 404));
  }

  center.expenseTypes.splice(index, 1);
  await center.save();

  const fallbackType = center.expenseTypes[0] || 'Otros';
  await Promise.all([
    CenterExpense.updateMany(
      { center: req.params.id, expenseType: type },
      { expenseType: fallbackType }
    ),
    RecurringExpenseConcept.updateMany(
      { center: req.params.id, expenseType: type },
      { expenseType: fallbackType }
    ),
  ]);

  res.status(200).json({ success: true, types: center.expenseTypes });
});

exports.getCenterExpenseCategories = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id).select('expenseCategories');
  if (!center) return next(new ErrorHandler('Center not found', 404));

  res.status(200).json({
    success: true,
    categories: center.expenseCategories || [],
  });
});

exports.addExpenseCategory = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { category } = req.body;
  if (!category || !String(category).trim()) {
    return next(new ErrorHandler('Category is required', 400));
  }

  const categoryTrimmed = String(category).trim();
  if (center.expenseCategories.includes(categoryTrimmed)) {
    return next(new ErrorHandler('Category already exists', 400));
  }

  center.expenseCategories.push(categoryTrimmed);
  await center.save();

  res.status(201).json({
    success: true,
    categories: center.expenseCategories,
  });
});

exports.updateExpenseCategory = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { oldCategory, newCategory } = req.body;
  if (!oldCategory || !newCategory) {
    return next(new ErrorHandler('oldCategory and newCategory are required', 400));
  }

  const oldIndex = center.expenseCategories.indexOf(oldCategory);
  if (oldIndex === -1) {
    return next(new ErrorHandler('Category not found', 404));
  }

  const newCategoryTrimmed = String(newCategory).trim();
  if (center.expenseCategories.includes(newCategoryTrimmed) && newCategoryTrimmed !== oldCategory) {
    return next(new ErrorHandler('New category already exists', 400));
  }

  center.expenseCategories[oldIndex] = newCategoryTrimmed;
  
  // Update all expenses with this category
  await CenterExpense.updateMany(
    { center: req.params.id, category: oldCategory },
    { category: newCategoryTrimmed }
  );

  await center.save();

  res.status(200).json({
    success: true,
    categories: center.expenseCategories,
  });
});

exports.deleteExpenseCategory = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const { category } = req.body;
  if (!category) {
    return next(new ErrorHandler('Category is required', 400));
  }

  const index = center.expenseCategories.indexOf(category);
  if (index === -1) {
    return next(new ErrorHandler('Category not found', 404));
  }

  center.expenseCategories.splice(index, 1);
  await center.save();

  res.status(200).json({
    success: true,
    categories: center.expenseCategories,
  });
});

exports.getBalanceRange = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const fromMonth = typeof req.query.from === 'string' && req.query.from ? req.query.from : null;
  const toMonth = typeof req.query.to === 'string' && req.query.to ? req.query.to : null;

  if (!fromMonth || !toMonth) {
    return next(new ErrorHandler('from and to query params are required (YYYY-MM)', 400));
  }
  assertMonthFormat(fromMonth);
  assertMonthFormat(toMonth);

  if (fromMonth > toMonth) {
    return next(new ErrorHandler('from must be <= to', 400));
  }

  // Build list of months between from and to (inclusive)
  const months = [];
  let cursor = fromMonth;
  while (cursor <= toMonth) {
    months.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    cursor = next;
    if (months.length > 36) break; // safety cap
  }

  const monthlyData = await Promise.all(
    months.map(async (month) => {
      const [manualExpenses, payrollEntries] = await Promise.all([
        CenterExpense.find({ center: req.params.id, month }).select(
          'concept amount expenseType entryType incomeCategory category date'
        ),
        PayrollEntry.find({ center: req.params.id, month })
          .populate('user', 'name')
          .select('netSalary variableAmount month'),
      ]);

      const safePayroll = payrollEntries.filter((e) => Boolean(e.user));
      const salaryExpenses = safePayroll.map((e) => ({
        _id: `salary-${e._id}`,
        amount: Number(e.netSalary ?? e.variableAmount ?? 0),
      }));

      const summary = buildExpensesSummary({ manualExpenses, salaryExpenses });
      return { month, ...summary };
    })
  );

  res.status(200).json({
    success: true,
    months,
    monthly: monthlyData,
  });
});

// ─── KPI Objectives ──────────────────────────────────────────────────────────

const ALLOWED_KPI_KEYS = [
  'facturacion',
  'costes',
  'beneficio_neto',
  'ticket_medio',
  'tarifas_activas',
  'nuevas_altas',
  'altas_bajas_plus',
  'bajas_mensuales',
  'retencion_socios',
  'faltas_asistencia',
  'capacidad_clases',
  'nota_revision_clases',
  'eventos_anio',
  'promociones_anio',
  'online_resenas',
  'online_stories_min_dia',
  'online_publicaciones_min_mes',
];

exports.getCenterKpiObjectives = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const year = parseInt(req.query.year, 10);
  if (!year || year < 2000 || year > 2100) {
    return next(new ErrorHandler('Valid year query param is required', 400));
  }

  const doc = await CenterKpiObjectives.findOne({ center: req.params.id, year });

  // Return objectives or empty defaults for all allowed keys
  const objectivesMap = {};
  if (doc) {
    for (const obj of doc.objectives) {
      objectivesMap[obj.key] = obj.monthly;
    }
  }

  const objectives = ALLOWED_KPI_KEYS.map((key) => ({
    key,
    monthly: objectivesMap[key] ?? Array(12).fill(null),
  }));

  res.status(200).json({ success: true, year, objectives });
});

exports.upsertCenterKpiObjectives = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const year = parseInt(req.body.year, 10);
  if (!year || year < 2000 || year > 2100) {
    return next(new ErrorHandler('Valid year in body is required', 400));
  }

  const incoming = Array.isArray(req.body.objectives) ? req.body.objectives : [];

  // Validate and sanitise
  const objectives = ALLOWED_KPI_KEYS.map((key) => {
    const found = incoming.find((o) => o.key === key);
    const monthly = Array.isArray(found?.monthly) && found.monthly.length === 12
      ? found.monthly.map((v) => (v === null || v === undefined ? null : Number(v)))
      : Array(12).fill(null);
    return { key, monthly };
  });

  const doc = await CenterKpiObjectives.findOneAndUpdate(
    { center: req.params.id, year },
    { center: req.params.id, year, objectives },
    { upsert: true, new: true, runValidators: true }
  );

  res.status(200).json({ success: true, year, objectives: doc.objectives });
});
