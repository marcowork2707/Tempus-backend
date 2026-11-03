// Port servidor de la lógica de tareas diarias de
// tempus-frontend/components/checklists/DailyOperationsPanel.tsx y lib/taskDefinitions.ts.
// Mantener sincronizado con el frontend si cambian las reglas.
const AppSetting = require('../models/AppSetting');

const TASK_DEFINITIONS = [
  { key: 'fitohub', label: 'Engagement + 14-Days-Rule', defaultFrequency: 'daily' },
  { key: 'absences', label: 'Faltas de asistencia', defaultFrequency: 'daily' },
  { key: 'occupancy', label: 'Ocupación', defaultFrequency: 'daily' },
  { key: 'class-notes', label: 'Anotar avisos', defaultFrequency: 'daily' },
  { key: 'class-report', label: 'Pasar reportes a AimHarder', defaultFrequency: 'daily' },
  { key: 'wod-recommendations', label: 'Pasar recomendaciones wod', defaultFrequency: 'daily' },
  { key: 'social-content', label: 'Grabar contenido RRSS', defaultFrequency: 'every_shift_day' },
  { key: 'whatsapp-reviews', label: 'Pedir reseñas por WhatsApp', defaultFrequency: 'first_monday_month' },
  { key: 'tpv-redsys', label: 'Contactar clientes con fallo TPV', defaultFrequency: 'daily' },
  { key: 'pending-payments-no-tpv', label: 'Contactar clientes con pagos pendientes', defaultFrequency: 'day_3_or_next_working_repeating' },
  { key: 'generate-payments', label: 'Generar pagos del próximo mes', defaultFrequency: 'day_25_month' },
  { key: 'term-renewals', label: 'Escribir fines de trimestre/semestre', defaultFrequency: 'specific_days_month:21' },
  { key: 'weekly-planning', label: 'Planificación semanal (subir + enviar WA)', defaultFrequency: 'thursday_sunday' },
  { key: 'stock-control', label: 'Control de stock', defaultFrequency: 'daily' },
];

const DEFAULT_FREQUENCIES = Object.fromEntries(TASK_DEFINITIONS.map((t) => [t.key, t.defaultFrequency]));
const DEFAULT_PENDING_PAYMENTS_WORKING_DAYS = 3;

// El frontend las oculta dinámicamente cuando su lista está vacía; el servidor no puede saberlo.
const KEYS_EXCLUDED_FROM_REMINDERS = new Set(['tpv-redsys', 'pending-payments-no-tpv']);

// Etiquetas antiguas que el frontend normaliza (getDisplayTaskLabel)
function getDisplayTaskLabel(label) {
  if (label === 'Tareas de FitoHub') return 'Engagement + 14-Days-Rule';
  if (label === 'Report clases de AimHarder') return 'Pasar reportes a AimHarder';
  if (label === 'Enviar planificación semanal por WhatsApp') return 'Planificación semanal (subir + enviar WA)';
  return label;
}

function noon(dateStr) {
  return new Date(`${dateStr}T12:00:00`);
}

function isFirstMondayOfMonth(dateStr) {
  const date = noon(dateStr);
  return date.getDay() === 1 && date.getDate() <= 7;
}

function isFirstWorkingDayOfMonth(dateStr) {
  const date = noon(dateStr);
  const dayOfWeek = date.getDay();
  const dayOfMonth = date.getDate();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const firstDOW = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  let targetDay;
  if (firstDOW === 0) targetDay = 2;
  else if (firstDOW === 6) targetDay = 3;
  else targetDay = 1;
  return dayOfMonth === targetDay;
}

function isFirstWorkingDayOfMonthNotDay1(dateStr) {
  const date = noon(dateStr);
  const dayOfWeek = date.getDay();
  const dayOfMonth = date.getDate();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const firstDOW = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  let targetDay;
  if (firstDOW === 0) targetDay = 2;
  else if (firstDOW === 6) targetDay = 3;
  else if (firstDOW === 5) targetDay = 4;
  else targetDay = 2;
  return dayOfMonth === targetDay;
}

function isDay3OrNextWorkingDayReached(dateStr, maxWorkingDays = DEFAULT_PENDING_PAYMENTS_WORKING_DAYS) {
  const date = noon(dateStr);
  const thirdDow = new Date(date.getFullYear(), date.getMonth(), 3).getDay();

  let activationDay = 3;
  if (thirdDow === 6) activationDay = 5;
  else if (thirdDow === 0) activationDay = 4;

  const activationDate = new Date(date.getFullYear(), date.getMonth(), activationDay);
  activationDate.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  if (date < activationDate) return false;
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;

  let workingDaysFromActivation = 0;
  const cursor = new Date(activationDate);
  while (cursor <= date) {
    const day = cursor.getDay();
    if (day >= 1 && day <= 5) workingDaysFromActivation += 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  return workingDaysFromActivation <= maxWorkingDays;
}

function taskPassesFrequency(taskKey, dateStr, frequencies, pendingPaymentsWindowDays = DEFAULT_PENDING_PAYMENTS_WORKING_DAYS) {
  const freq = frequencies[taskKey] ?? DEFAULT_FREQUENCIES[taskKey] ?? 'daily';
  if (freq === 'every_shift_day') return true;
  const dayOfWeek = noon(dateStr).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isSpecificMonthDayFrequency =
    freq === 'day_23_month' || freq === 'day_25_month' || freq.startsWith('specific_days_month:');

  if (isWeekend && !isSpecificMonthDayFrequency) return false;

  if (taskKey === 'stock-control') return freq !== 'never';

  switch (freq) {
    case 'never': return false;
    case 'first_monday_month': return isFirstMondayOfMonth(dateStr);
    case 'first_working_day_month': return isFirstWorkingDayOfMonth(dateStr);
    case 'first_working_day_not_1': return isFirstWorkingDayOfMonthNotDay1(dateStr);
    case 'early_month_working_days': {
      const d = noon(dateStr);
      const dow = d.getDay();
      return dow >= 1 && dow <= 5 && d.getDate() <= 10;
    }
    case 'day_25_month': return noon(dateStr).getDate() === 25;
    case 'day_23_month': return noon(dateStr).getDate() === 23;
    case 'day_3_or_next_working_repeating': return isDay3OrNextWorkingDayReached(dateStr, pendingPaymentsWindowDays);
    case 'every_other_day': return noon(dateStr).getDate() % 2 === 1;
    case 'monday_wednesday': {
      const dow = noon(dateStr).getDay();
      return dow === 1 || dow === 3;
    }
    case 'sunday': return noon(dateStr).getDay() === 0;
    case 'thursday_sunday': {
      const dow = noon(dateStr).getDay();
      return dow === 4 || dow === 0;
    }
    default: {
      if (freq.startsWith('specific_days_month:')) {
        const days = freq.slice('specific_days_month:'.length).split(',').map(Number).filter(Boolean);
        return days.includes(noon(dateStr).getDate());
      }
      return true;
    }
  }
}

function getActiveTasks(dateStr, frequencies = {}, allowedTasks = null, role = undefined, pendingPaymentsWindowDays = DEFAULT_PENDING_PAYMENTS_WORKING_DAYS) {
  return TASK_DEFINITIONS.filter((task) => {
    if (allowedTasks !== null && !allowedTasks.includes(task.key)) return false;
    if (task.key === 'stock-control' && role !== 'admin' && role !== 'encargado' && role !== 'coach') return false;
    return taskPassesFrequency(task.key, dateStr, frequencies, pendingPaymentsWindowDays);
  });
}

// Lee los ajustes globales (centerType null) que afectan a las tareas diarias
async function loadTaskSettings() {
  const docs = await AppSetting.find({
    centerType: null,
    $or: [
      { key: /^task_frequency_/ },
      { key: 'pending_payments_working_days_window' },
      { key: 'user_task_permissions' },
    ],
  }).lean();

  const frequencies = {};
  let pendingPaymentsWorkingDaysWindow = DEFAULT_PENDING_PAYMENTS_WORKING_DAYS;
  let userTaskPermissions = {};

  for (const doc of docs) {
    if (doc.key.startsWith('task_frequency_')) {
      frequencies[doc.key.replace('task_frequency_', '')] = doc.value;
    } else if (doc.key === 'pending_payments_working_days_window') {
      const parsed = Number.parseInt(doc.value, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) pendingPaymentsWorkingDaysWindow = parsed;
    } else if (doc.key === 'user_task_permissions') {
      try {
        const parsed = JSON.parse(doc.value);
        if (parsed && typeof parsed === 'object') userTaskPermissions = parsed;
      } catch (_) { /* JSON inválido: se ignora */ }
    }
  }

  return { frequencies, pendingPaymentsWorkingDaysWindow, userTaskPermissions };
}

// settings: resultado de loadTaskSettings()
function getActiveTaskKeysForUser({ center, dateKey, userId, role, settings }) {
  const frequencies = settings?.frequencies || {};
  const windowDays = settings?.pendingPaymentsWorkingDaysWindow || DEFAULT_PENDING_PAYMENTS_WORKING_DAYS;
  const userEntry = settings?.userTaskPermissions?.[String(userId)];
  const userAllowed = Array.isArray(userEntry) ? userEntry : null;
  const centerKeys = center?.checklistTemplates?.dailyTaskKeys;
  const centerAllowed = Array.isArray(centerKeys) ? centerKeys : null;

  let allowed;
  if (userAllowed === null && centerAllowed === null) allowed = null;
  else if (userAllowed === null) allowed = centerAllowed;
  else if (centerAllowed === null) allowed = userAllowed;
  else {
    const centerSet = new Set(centerAllowed);
    allowed = userAllowed.filter((key) => centerSet.has(key));
  }

  return getActiveTasks(dateKey, frequencies, allowed, role, windowDays)
    .filter((task) => !KEYS_EXCLUDED_FROM_REMINDERS.has(task.key))
    .map((task) => task.key);
}

function getTaskLabel(key) {
  return TASK_DEFINITIONS.find((task) => task.key === key)?.label || key;
}

module.exports = {
  TASK_DEFINITIONS,
  getActiveTasks,
  getActiveTaskKeysForUser,
  getTaskLabel,
  getDisplayTaskLabel,
  loadTaskSettings,
};
