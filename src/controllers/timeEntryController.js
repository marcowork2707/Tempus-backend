const TimeEntry = require('../models/TimeEntry');
const UserCenterRole = require('../models/UserCenterRole');
const ShiftPattern = require('../models/ShiftPattern');
const ShiftOverride = require('../models/ShiftOverride');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

const getUserRoleForCenter = async (userId, centerId) => {
  if (!centerId) return null;

  const assignment = await UserCenterRole.findOne({
    user: userId,
    center: centerId,
    active: true,
  }).populate('role');

  return assignment?.role?.name || null;
};

const canReviewCenterEntries = (roleName) => roleName === 'admin' || roleName === 'encargado';

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const formatLocalDate = (date) => {
  const d = startOfDay(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const startOfISOWeek = (date) => {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
};

const timeToMinutes = (timeString) => {
  if (!timeString) return 0;
  const [hours, minutes] = timeString.split(':').map(Number);
  return (hours * 60) + minutes;
};

const getDurationFromTimes = (startTime, endTime) => {
  if (!startTime || !endTime) return 0;
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  return Math.max(0, end - start);
};

const getMinutesFromSegments = (segments = []) =>
  segments.reduce((total, segment) => total + getDurationFromTimes(segment.startTime, segment.endTime), 0);

const getSegmentsForPattern = (pattern, dayOfWeek) => {
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
};

function computeOccurrences(patterns, from, to) {
  const results = [];
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const fromDay = startOfDay(from);
  const toDay = startOfDay(to);

  for (const pattern of patterns) {
    if (!pattern.active) continue;
    if (!pattern.user?._id) continue;

    const patStart = startOfDay(pattern.startDate);
    const patEnd = pattern.endDate ? startOfDay(pattern.endDate) : null;
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
          const weekDiff = Math.round((startOfISOWeek(current) - startOfISOWeek(patStart)) / MS_PER_WEEK);
          applies = weekDiff % 2 === 0;
        } else if (pattern.recurrence === 'monthly') {
          const weekDiff = Math.round((startOfISOWeek(current) - startOfISOWeek(patStart)) / MS_PER_WEEK);
          applies = weekDiff % 4 === 0;
        } else if (pattern.recurrence === 'custom_cycle') {
          const weekDiff = Math.round((startOfISOWeek(current) - startOfISOWeek(patStart)) / MS_PER_WEEK);
          const cycleLength = pattern.cycleLengthWeeks || 1;
          const cycleWeek = ((weekDiff % cycleLength) + cycleLength) % cycleLength + 1;
          applies = (pattern.cycleWeeks || [1]).includes(cycleWeek);
        }

        if (applies) {
          const shift = pattern.shift;
          const segments = getSegmentsForPattern(pattern, dayOfWeek);
          results.push({
            date: formatLocalDate(current),
            userId: pattern.user._id.toString(),
            shiftName: pattern.label || shift?.name || 'Turno',
            startTime: segments[0]?.startTime || '',
            endTime: segments[segments.length - 1]?.endTime || '',
            timeSegments: segments,
            notes: pattern.notes || '',
            isOff: false,
          });
        }
      }

      current = new Date(current);
      current.setDate(current.getDate() + 1);
    }
  }

  return results;
}

function applyOverrides(baseOccurrences, overrides) {
  const byKey = new Map();

  for (const occurrence of baseOccurrences) {
    byKey.set(`${occurrence.userId}|${occurrence.date}`, occurrence);
  }

  for (const override of overrides) {
    if (!override.user?._id) continue;
    const date = formatLocalDate(override.date);
    const userId = override.user._id.toString();
    byKey.set(`${userId}|${date}`, {
      date,
      userId,
      shiftName: override.label || (override.isOff ? 'No laborable' : 'Turno'),
      startTime: override.isOff ? '' : override.startTime || '',
      endTime: override.isOff ? '' : override.endTime || '',
      timeSegments: override.isOff
        ? []
        : override.startTime && override.endTime
          ? [{ startTime: override.startTime, endTime: override.endTime }]
          : [],
      notes: override.notes || '',
      isOff: !!override.isOff,
      reasonType: override.reasonType || 'custom',
    });
  }

  return Array.from(byKey.values());
}

const getPlannedOccurrencesMap = async (centerId, from, to, userId) => {
  const patternFilter = { center: centerId, active: true };
  if (userId) patternFilter.user = userId;

  const overrideFilter = {
    center: centerId,
    date: { $gte: startOfDay(from), $lte: startOfDay(to) },
  };
  if (userId) overrideFilter.user = userId;

  const [patterns, overrides] = await Promise.all([
    ShiftPattern.find(patternFilter).populate('user', 'name email').populate('shift', 'name startTime endTime'),
    ShiftOverride.find(overrideFilter).populate('user', 'name email'),
  ]);

  const occurrences = applyOverrides(
    computeOccurrences(patterns.filter((pattern) => pattern.user && pattern.user._id), from, to),
    overrides.filter((override) => override.user && override.user._id)
  );
  return new Map(occurrences.map((occ) => [`${occ.userId}|${occ.date}`, occ]));
};

// Check-in
exports.checkIn = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.body;

  if (!centerId) {
    return next(new ErrorHandler('centerId is required', 400));
  }

  const userRoleInCenter = await getUserRoleForCenter(req.user.id, centerId);

  if (!userRoleInCenter) {
    return next(new ErrorHandler('Unauthorized for this center', 403));
  }

  if (userRoleInCenter === 'encargado') {
    return next(new ErrorHandler('Managers do not use check-in/check-out', 403));
  }

  // Check if user already has an active entry for today
  const today = new Date();
  const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dateNext = new Date(dateOnly);
  dateNext.setDate(dateNext.getDate() + 1);

  const existingEntry = await TimeEntry.findOne({
    user: req.user.id,
    center: centerId,
    date: { $gte: dateOnly, $lt: dateNext },
    status: 'active',
  });

  if (existingEntry) {
    return next(
      new ErrorHandler('You already have an active check-in for today', 400)
    );
  }

  const entry = await TimeEntry.create({
    user: req.user.id,
    center: centerId,
    date: dateOnly,
    entryTime: new Date(),
    status: 'active',
  });

  const populatedEntry = await entry.populate('user', 'name email');
  res.status(201).json({ success: true, entry: populatedEntry });
});

// Check-out
exports.checkOut = catchAsyncErrors(async (req, res, next) => {
  const { notes } = req.body;
  const entry = await TimeEntry.findById(req.params.id);

  if (!entry) {
    return next(new ErrorHandler('Time entry not found', 404));
  }

  const userRoleInCenter = await getUserRoleForCenter(req.user.id, entry.center);
  const canManageEntry = canReviewCenterEntries(userRoleInCenter) || req.user.role === 'admin';

  if (entry.user.toString() !== req.user.id && !canManageEntry) {
    return next(new ErrorHandler('Unauthorized', 403));
  }

  if (entry.user.toString() === req.user.id && userRoleInCenter === 'encargado') {
    return next(new ErrorHandler('Managers do not use check-in/check-out', 403));
  }

  if (entry.status !== 'active') {
    return next(new ErrorHandler('Entry is not active', 400));
  }

  const exitTime = new Date();
  const duration = Math.round((exitTime - entry.entryTime) / (1000 * 60)); // in minutes

  entry.exitTime = exitTime;
  entry.duration = duration;
  entry.status = 'completed';
  entry.notes = notes || entry.notes;

  await entry.save();

  const populatedEntry = await entry.populate('user', 'name email');
  res.status(200).json({ success: true, entry: populatedEntry });
});

// Get entries with filters
exports.getTimeEntries = catchAsyncErrors(async (req, res, next) => {
  const user = req.user;
  const filter = {};

  if (req.query.centerId) {
    filter.center = req.query.centerId;
  }

  if (req.query.userId) {
    filter.user = req.query.userId;
  }

  const userRoleInCenter = req.query.centerId
    ? await getUserRoleForCenter(user.id, req.query.centerId)
    : null;

  // Date range filter
  if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) {
      filter.date.$gte = new Date(req.query.startDate);
    }
    if (req.query.endDate) {
      const endDate = new Date(req.query.endDate);
      endDate.setDate(endDate.getDate() + 1);
      filter.date.$lt = endDate;
    }
  }

  // Workers see only their entries unless they can review the selected center.
  if (user.role !== 'admin' && !canReviewCenterEntries(userRoleInCenter)) {
    filter.user = user.id;
  }

  const entries = await TimeEntry.find(filter)
    .populate('user', 'name email')
    .populate('center', 'name type')
    .sort({ date: -1, entryTime: -1 });

  const validEntries = entries.filter((entry) => entry.user && entry.center);

  let plannedMap = new Map();
  if (filter.center && validEntries.length > 0) {
    const rangeStart = req.query.startDate ? new Date(req.query.startDate) : validEntries[validEntries.length - 1].date;
    const rangeEnd = req.query.endDate ? new Date(req.query.endDate) : validEntries[0].date;
    plannedMap = await getPlannedOccurrencesMap(filter.center, rangeStart, rangeEnd, req.query.userId);
  }

  const enrichedEntries = validEntries.map((entry) => {
    const dateKey = formatLocalDate(entry.date);
    const planned = plannedMap.get(`${entry.user._id.toString()}|${dateKey}`);
    const plannedMinutes = planned?.isOff
      ? 0
      : planned?.timeSegments?.length
        ? getMinutesFromSegments(planned.timeSegments)
        : getDurationFromTimes(planned?.startTime, planned?.endTime);
    const workedMinutes = entry.duration || 0;
    const overtimeMinutes = entry.status === 'completed'
      ? Math.max(0, workedMinutes - plannedMinutes)
      : 0;

    return {
      ...entry.toObject(),
      plannedShift: planned
        ? {
            label: planned.shiftName,
            startTime: planned.startTime,
            endTime: planned.endTime,
            segments: planned.timeSegments || [],
            minutes: plannedMinutes,
            isOff: !!planned.isOff,
            reasonType: planned.reasonType || 'custom',
            notes: planned.notes || '',
          }
        : null,
      workedMinutes,
      overtimeMinutes,
    };
  });

  const summary = enrichedEntries.reduce((acc, entry) => {
    acc.totalWorkedMinutes += entry.workedMinutes || 0;
    acc.totalPlannedMinutes += entry.plannedShift?.minutes || 0;
    acc.totalOvertimeMinutes += entry.overtimeMinutes || 0;
    return acc;
  }, {
    totalEntries: enrichedEntries.length,
    totalWorkedMinutes: 0,
    totalPlannedMinutes: 0,
    totalOvertimeMinutes: 0,
  });

  res.status(200).json({ success: true, entries: enrichedEntries, summary });
});

// Get user's active check-in
exports.getActiveCheckIn = catchAsyncErrors(async (req, res, next) => {
  const today = new Date();
  const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dateNext = new Date(dateOnly);
  dateNext.setDate(dateNext.getDate() + 1);

  const entry = await TimeEntry.findOne({
    user: req.user.id,
    date: { $gte: dateOnly, $lt: dateNext },
    status: 'active',
  }).populate('center', 'name type');

  res.status(200).json({ success: true, entry });
});

// Export to Excel (simple CSV)
exports.exportToExcel = catchAsyncErrors(async (req, res, next) => {
  const filter = {};
  const user = req.user;

  if (req.query.centerId) {
    filter.center = req.query.centerId;
  }

  const userRoleInCenter = req.query.centerId
    ? await getUserRoleForCenter(user.id, req.query.centerId)
    : null;

  if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) {
      filter.date.$gte = new Date(req.query.startDate);
    }
    if (req.query.endDate) {
      const endDate = new Date(req.query.endDate);
      endDate.setDate(endDate.getDate() + 1);
      filter.date.$lt = endDate;
    }
  }

  if (user.role !== 'admin' && !canReviewCenterEntries(userRoleInCenter)) {
    filter.user = user.id;
  }

  const entries = await TimeEntry.find(filter)
    .populate('user', 'name email')
    .populate('center', 'name')
    .sort({ date: 1, entryTime: 1 });

  const validEntries = entries.filter((entry) => entry.user && entry.center);

  let plannedMap = new Map();
  if (filter.center && validEntries.length > 0) {
    plannedMap = await getPlannedOccurrencesMap(
      filter.center,
      req.query.startDate ? new Date(req.query.startDate) : validEntries[0].date,
      req.query.endDate ? new Date(req.query.endDate) : validEntries[validEntries.length - 1].date,
      req.query.userId
    );
  }

  // Generate CSV
  let csv = 'Instructor,Día,Turno planificado,Hora de entrada,Hora de salida,Tiempo trabajado,Horas extra,Motivo\n';

  validEntries.forEach((entry) => {
    const date = entry.date.toLocaleDateString('es-ES');
    const planned = plannedMap.get(`${entry.user._id.toString()}|${formatLocalDate(entry.date)}`);
    const plannedMinutes = planned?.isOff
      ? 0
      : planned?.timeSegments?.length
        ? getMinutesFromSegments(planned.timeSegments)
        : getDurationFromTimes(planned?.startTime, planned?.endTime);
    const overtimeMinutes = entry.duration ? Math.max(0, entry.duration - plannedMinutes) : 0;
    const entryTime = entry.entryTime.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const exitTime = entry.exitTime
      ? entry.exitTime.toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    const duration = entry.duration
      ? `${Math.floor(entry.duration / 60)}h ${entry.duration % 60}m`
      : '';
    const overtime = `${Math.floor(overtimeMinutes / 60)}h ${overtimeMinutes % 60}m`;
    const plannedLabel = planned
      ? `${planned.shiftName}${planned.timeSegments?.length ? ` ${planned.timeSegments.map((segment) => `${segment.startTime}-${segment.endTime}`).join(' / ')}` : planned.startTime && planned.endTime ? ` ${planned.startTime}-${planned.endTime}` : ''}`
      : '';
    const line = `"${entry.user.name}","${date}","${plannedLabel}","${entryTime}","${exitTime}","${duration}","${overtime}","${planned?.notes || entry.notes || ''}"`;
    csv += line + '\n';
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename=fichajes_' + new Date().toISOString().split('T')[0] + '.csv'
  );
  res.send(csv);
});

exports.updateTimeEntry = catchAsyncErrors(async (req, res, next) => {
  const entry = await TimeEntry.findById(req.params.id).populate('center', 'name');

  if (!entry) {
    return next(new ErrorHandler('Time entry not found', 404));
  }

  const userRoleInCenter = await getUserRoleForCenter(req.user.id, entry.center._id);
  const canManageEntry = canReviewCenterEntries(userRoleInCenter) || req.user.role === 'admin';

  if (!canManageEntry) {
    return next(new ErrorHandler('Unauthorized', 403));
  }

  const { date, entryTime, exitTime, notes } = req.body;

  const entryDate = date ? startOfDay(date) : startOfDay(entry.date);
  const currentEntryTime = entryTime
    ? new Date(`${formatLocalDate(entryDate)}T${entryTime}:00`)
    : new Date(entry.entryTime);
  const currentExitTime = exitTime
    ? new Date(`${formatLocalDate(entryDate)}T${exitTime}:00`)
    : null;

  if (currentExitTime && currentExitTime < currentEntryTime) {
    return next(new ErrorHandler('exitTime cannot be earlier than entryTime', 400));
  }

  entry.date = entryDate;
  entry.entryTime = currentEntryTime;
  entry.exitTime = currentExitTime;
  entry.notes = notes !== undefined ? notes : entry.notes;
  entry.status = currentExitTime ? 'completed' : 'active';
  entry.duration = currentExitTime
    ? Math.round((currentExitTime - currentEntryTime) / (1000 * 60))
    : null;

  await entry.save();

  const updatedEntry = await TimeEntry.findById(entry._id)
    .populate('user', 'name email')
    .populate('center', 'name type');

  res.status(200).json({ success: true, entry: updatedEntry });
});

exports.deleteTimeEntry = catchAsyncErrors(async (req, res, next) => {
  const entry = await TimeEntry.findById(req.params.id).populate('center', 'name');

  if (!entry) {
    return next(new ErrorHandler('Time entry not found', 404));
  }

  const userRoleInCenter = await getUserRoleForCenter(req.user.id, entry.center._id);
  const canManageEntry = canReviewCenterEntries(userRoleInCenter) || req.user.role === 'admin';

  if (!canManageEntry) {
    return next(new ErrorHandler('Unauthorized', 403));
  }

  await TimeEntry.findByIdAndDelete(req.params.id);

  res.status(200).json({ success: true, message: 'Fichaje eliminado correctamente' });
});

// Admin creates a time entry on behalf of a user
exports.adminCreateTimeEntry = catchAsyncErrors(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(new ErrorHandler('Unauthorized', 403));
  }

  const { centerId, userId, date, entryTime, exitTime, notes } = req.body;

  if (!centerId || !userId || !date || !entryTime) {
    return next(new ErrorHandler('centerId, userId, date and entryTime are required', 400));
  }

  const entryDate = startOfDay(date);
  const entryTimestamp = new Date(`${formatLocalDate(entryDate)}T${entryTime}:00`);
  const exitTimestamp = exitTime ? new Date(`${formatLocalDate(entryDate)}T${exitTime}:00`) : null;

  if (exitTimestamp && exitTimestamp < entryTimestamp) {
    return next(new ErrorHandler('exitTime cannot be earlier than entryTime', 400));
  }

  const duration = exitTimestamp
    ? Math.round((exitTimestamp - entryTimestamp) / (1000 * 60))
    : null;

  const entry = await TimeEntry.create({
    user: userId,
    center: centerId,
    date: entryDate,
    entryTime: entryTimestamp,
    exitTime: exitTimestamp,
    status: exitTimestamp ? 'completed' : 'active',
    duration,
    notes: notes || undefined,
  });

  const populated = await TimeEntry.findById(entry._id)
    .populate('user', 'name email')
    .populate('center', 'name type');

  res.status(201).json({ success: true, entry: populated });
});
