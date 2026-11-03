const mongoose = require('mongoose');
const Center = require('../models/Center');
const Checklist = require('../models/Checklist');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const UserCenterRole = require('../models/UserCenterRole');
const { isPushConfigured, sendToUser } = require('./pushService');
const {
  getActiveTaskKeysForUser,
  getTaskLabel,
  getDisplayTaskLabel,
  loadTaskSettings,
} = require('./dailyTaskRules');

const TICK_MS = 5 * 60 * 1000;
const REMINDER_LEAD_MINUTES = 15;
const WINDOW_MINUTES = 6; // 1 min de margen sobre el tick; la deduplicación evita repetidos

function getMadridNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    // Algunas versiones de ICU devuelven "24" a medianoche
    minutes: (Number(map.hour) % 24) * 60 + Number(map.minute),
  };
}

function toMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})/.exec(time || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function getShiftEnd(occurrence) {
  const segments = Array.isArray(occurrence.timeSegments) ? occurrence.timeSegments : [];
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  return lastSegment?.endTime || occurrence.endTime || null;
}

function isWorking(occurrence) {
  return !occurrence.isOff && !occurrence.isCleared;
}

async function getTodayChecklist(centerId, dateKey) {
  // Mismo criterio que checklistController.getChecklists: [medianoche UTC, +1 día)
  const dayStart = new Date(dateKey);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return Checklist.findOne({
    center: centerId,
    type: 'daily',
    date: { $gte: dayStart, $lt: dayEnd },
  }).sort({ createdAt: 1 });
}

async function processCenter(center, { dateKey, minutes }, settings) {
  // Se pasa la fecha igual que getShiftCalendar (new Date('YYYY-MM-DD'))
  const fromDate = new Date(dateKey);
  const toDate = new Date(dateKey);
  const dayStart = new Date(fromDate);
  dayStart.setHours(0, 0, 0, 0);

  // Require diferido: evita dependencia circular al cargar el controlador al arrancar
  const { _computeOccurrencesForCenter } = require('../controllers/centerController');
  const occurrences = (
    await _computeOccurrencesForCenter({
      centerId: center._id,
      patternFilter: { center: center._id, active: true },
      overrideFilter: { center: center._id, date: { $gte: dayStart, $lte: dayStart } },
      fromDate,
      toDate,
    })
  ).filter((occurrence) => occurrence.date === dateKey);

  const isHoliday =
    !occurrences.some(isWorking) && occurrences.some((occurrence) => occurrence.reasonType === 'holiday');
  if (isHoliday) return;

  const due = occurrences.filter((occurrence) => {
    if (!isWorking(occurrence)) return false;
    const end = toMinutes(getShiftEnd(occurrence));
    if (end === null) return false;
    const reminderAt = end - REMINDER_LEAD_MINUTES;
    return reminderAt > minutes - WINDOW_MINUTES && reminderAt <= minutes;
  });
  if (due.length === 0) return;

  let checklist;
  let checklistLoaded = false;

  for (const occurrence of due) {
    try {
      const userId = occurrence.userId;
      const shiftEnd = getShiftEnd(occurrence);

      const subscriptionCount = await PushSubscription.countDocuments({ user: userId });
      if (subscriptionCount === 0) continue;

      const subject = `task-reminder:${center._id}:${dateKey}:${shiftEnd}`;
      const alreadySent = await Notification.exists({ user: userId, channel: 'push', status: 'sent', subject });
      if (alreadySent) continue;

      const assignment = await UserCenterRole.findOne({ user: userId, center: center._id, active: true }).populate('role');
      const role = assignment?.role?.name;

      const activeKeys = getActiveTaskKeysForUser({ center, dateKey, userId, role, settings });
      if (activeKeys.length === 0) continue;

      if (!checklistLoaded) {
        checklist = await getTodayChecklist(center._id, dateKey);
        checklistLoaded = true;
      }
      const doneLabels = new Set(
        (checklist?.items || []).filter((item) => item.done).map((item) => getDisplayTaskLabel(item.label))
      );
      const pendingLabels = activeKeys.map(getTaskLabel).filter((label) => !doneLabels.has(label));
      if (pendingLabels.length === 0) continue;

      const count = pendingLabels.length;
      const delivered = await sendToUser(userId, {
        title: 'Tareas pendientes',
        body: `Te quedan ${count} tareas en ${center.name}: ${pendingLabels.slice(0, 3).join(', ')}${count > 3 ? '…' : ''}`,
        url: '/dashboard/checklists',
        tag: `tasks-${center._id}-${dateKey}`,
      });

      if (delivered > 0) {
        await Notification.create({
          user: userId,
          channel: 'push',
          // Clave de deduplicación: fecha + fin de turno (no es un instante real)
          scheduledFor: new Date(`${dateKey}T${shiftEnd}:00.000Z`),
          sentAt: new Date(),
          status: 'sent',
          subject,
          message: `${count} tareas pendientes`,
        });
        console.log(`[Task Reminders] Aviso enviado a ${userId} en ${center.name} (${count} pendientes)`);
      }
    } catch (error) {
      console.error('[Task Reminders] Error con un turno:', error.message);
    }
  }
}

async function runTaskReminderTick() {
  if (mongoose.connection.readyState !== 1) return;
  const now = getMadridNow();
  const settings = await loadTaskSettings();
  const centers = await Center.find({ active: true });
  for (const center of centers) {
    try {
      await processCenter(center, now, settings);
    } catch (error) {
      console.error(`[Task Reminders] Error en ${center.name}:`, error.message);
    }
  }
}

function startTaskReminderScheduler() {
  if (process.env.DISABLE_TASK_REMINDERS === 'true') {
    console.log('[Task Reminders] Desactivado por DISABLE_TASK_REMINDERS');
    return;
  }
  if (!isPushConfigured()) {
    console.log('[Task Reminders] Push no configurado (VAPID_*); recordatorios desactivados');
    return;
  }

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runTaskReminderTick()
      .catch((error) => console.error('[Task Reminders] Error inesperado:', error.message))
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[Task Reminders] Programador iniciado (cada 5 min)');
}

module.exports = { startTaskReminderScheduler };
