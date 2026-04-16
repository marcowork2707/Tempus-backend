const Center = require('../models/Center');
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
const WeeklyPlanning = require('../models/WeeklyPlanning');
const TimeEntry = require('../models/TimeEntry');
const Checklist = require('../models/Checklist');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const { buildPlanningMessage } = require('../services/weeklyPlanningService');

const hasResolvedUser = (record) => Boolean(record?.user && record.user._id);
const OVERTIME_AGGREGATION_MODES = ['net', 'positive_only'];

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
  const { openingTasks, closingTasks } = req.body;

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

  const role = await Role.findOne({ name: roleName });
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
    const role = await Role.findOne({ name: roleName });
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
  const manualTotal = manualExpenses.reduce((total, item) => total + Number(item.amount || 0), 0);
  const salaryTotal = salaryExpenses.reduce((total, item) => total + Number(item.amount || 0), 0);
  const total = manualTotal + salaryTotal;

  const byCategoryMap = new Map();
  for (const item of manualExpenses) {
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

  return {
    manualTotal: Number(manualTotal.toFixed(2)),
    salaryTotal: Number(salaryTotal.toFixed(2)),
    total: Number(total.toFixed(2)),
    manualCount: manualExpenses.length,
    salaryCount: salaryExpenses.length,
    averageManualExpense: manualExpenses.length > 0 ? Number((manualTotal / manualExpenses.length).toFixed(2)) : 0,
    byCategory,
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

  const [manualExpenses, payrollEntries] = await Promise.all([
    CenterExpense.find({ center: req.params.id, month })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
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
    amount: Number(entry.grossSalary ?? entry.baseAmount ?? 0),
    grossSalary: Number(entry.grossSalary ?? entry.baseAmount ?? 0),
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

  const { date, concept, category, amount, paymentMethod, supplier, notes } = req.body;

  assertDateFormat(date);
  if (!concept || !String(concept).trim()) {
    return next(new ErrorHandler('concept is required', 400));
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return next(new ErrorHandler('amount must be a number greater than 0', 400));
  }

  const expense = await CenterExpense.create({
    center: req.params.id,
    date,
    month: monthFromDate(date),
    concept: String(concept).trim(),
    category: String(category || 'General').trim(),
    amount: Number(parsedAmount.toFixed(2)),
    paymentMethod: paymentMethod ? String(paymentMethod).trim() : '',
    supplier: supplier ? String(supplier).trim() : '',
    notes: notes ? String(notes).trim() : '',
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });

  const populated = await CenterExpense.findById(expense._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');

  res.status(201).json({ success: true, expense: populated });
});

exports.updateCenterExpense = catchAsyncErrors(async (req, res, next) => {
  const expense = await CenterExpense.findOne({
    _id: req.params.expenseId,
    center: req.params.id,
  });
  if (!expense) return next(new ErrorHandler('Expense not found', 404));

  const { date, concept, category, amount, paymentMethod, supplier, notes } = req.body;

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
  if (amount !== undefined) {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return next(new ErrorHandler('amount must be a number greater than 0', 400));
    }
    expense.amount = Number(parsedAmount.toFixed(2));
  }
  if (paymentMethod !== undefined) expense.paymentMethod = String(paymentMethod || '').trim();
  if (supplier !== undefined) expense.supplier = String(supplier || '').trim();
  if (notes !== undefined) expense.notes = String(notes || '').trim();
  expense.updatedBy = req.user.id;

  await expense.save();

  const populated = await CenterExpense.findById(expense._id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');

  res.status(200).json({ success: true, expense: populated });
});

exports.deleteCenterExpense = catchAsyncErrors(async (req, res, next) => {
  const deleted = await CenterExpense.findOneAndDelete({
    _id: req.params.expenseId,
    center: req.params.id,
  });
  if (!deleted) return next(new ErrorHandler('Expense not found', 404));

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

exports.getVacationRequests = catchAsyncErrors(async (req, res, next) => {
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  const canManage = _canManageVacationRequests(roleName, req.user.role);

  if (!roleName && req.user.role !== 'admin') {
    return next(new ErrorHandler('Unauthorized for this center', 403));
  }

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
  const { startDate, endDate, reason } = req.body;
  const center = await Center.findById(req.params.id);
  if (!center) return next(new ErrorHandler('Center not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!['coach', 'encargado'].includes(roleName)) {
    return next(new ErrorHandler('Only coaches and managers can request vacation from Mis turnos', 403));
  }

  if (!startDate || !endDate || !reason?.trim()) {
    return next(new ErrorHandler('startDate, endDate and reason are required', 400));
  }

  const start = _startOfDay(startDate);
  const end = _startOfDay(endDate);
  if (end < start) {
    return next(new ErrorHandler('endDate cannot be earlier than startDate', 400));
  }

  await _assertVacationConflictRules(req.params.id, req.user.id, start, end);

  const overlapping = await VacationRequest.findOne({
    center: req.params.id,
    user: req.user.id,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });

  if (overlapping) {
    return next(new ErrorHandler('You already have a vacation request overlapping those dates', 400));
  }

  const request = await VacationRequest.create({
    center: req.params.id,
    user: req.user.id,
    startDate: start,
    endDate: end,
    reason: reason.trim(),
  });

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
    let current = new Date(_startOfDay(request.startDate));
    const end = _startOfDay(request.endDate);

    while (current <= end) {
      const dateOnly = _startOfDay(current);
      await ShiftOverride.findOneAndUpdate(
        { center: req.params.id, user: request.user, date: dateOnly },
        {
          center: req.params.id,
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
  const { userId, date, endDate, label, startTime, endTime, segments, isOff, notes, reasonType } = req.body;

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
  let current = new Date(start);
  while (current <= end) {
    const dateOnly = _startOfDay(current);
    const override = await ShiftOverride.findOneAndUpdate(
      { center: req.params.id, user: userId, date: dateOnly },
      {
        center: req.params.id,
        user: userId,
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
  if (roleName === 'coach') {
    occurrences = occurrences.filter((occ) => occ.userId === req.user.id || occ.reasonType === 'vacation');
  }
  res.status(200).json({ success: true, occurrences });
});
