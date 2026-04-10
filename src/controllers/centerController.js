const Center = require('../models/Center');
const UserCenterRole = require('../models/UserCenterRole');
const Role = require('../models/Role');
const Shift = require('../models/Shift');
const WorkerShift = require('../models/WorkerShift');
const ShiftPattern = require('../models/ShiftPattern');
const ShiftOverride = require('../models/ShiftOverride');
const VacationRequest = require('../models/VacationRequest');
const VacationConflictRule = require('../models/VacationConflictRule');
const Checklist = require('../models/Checklist');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

const hasResolvedUser = (record) => Boolean(record?.user && record.user._id);

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
  const { name, type, address, phone, email, active, aimharderKey } = req.body;

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
  const { userId, roleName } = req.body;

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
  });

  const populated = await assignment.populate([
    { path: 'user', select: 'name email active' },
    { path: 'role', select: 'name' },
  ]);

  res.status(201).json({ success: true, assignment: populated });
});

// Update user's role in a center
exports.updateUserCenterRole = catchAsyncErrors(async (req, res, next) => {
  const { roleName } = req.body;

  if (!roleName) return next(new ErrorHandler('roleName is required', 400));

  const role = await Role.findOne({ name: roleName });
  if (!role) return next(new ErrorHandler(`Role '${roleName}' not found`, 404));

  const assignment = await UserCenterRole.findOneAndUpdate(
    { user: req.params.userId, center: req.params.id },
    { role: role._id },
    { new: true }
  )
    .populate('user', 'name email active')
    .populate('role', 'name');

  if (!assignment) return next(new ErrorHandler('Assignment not found', 404));

  res.status(200).json({ success: true, assignment });
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
  if (req.query.status) filter.status = req.query.status;
  if (canManage && req.query.userId) filter.user = req.query.userId;
  if (req.query.mine === 'true') filter.user = req.user.id;

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
  const { status, reviewNotes } = req.body;
  const request = await VacationRequest.findOne({ _id: req.params.requestId, center: req.params.id });
  if (!request) return next(new ErrorHandler('Vacation request not found', 404));

  const roleName = await _getRoleNameInCenter(req.user.id, req.params.id);
  if (!_canManageVacationRequests(roleName, req.user.role)) {
    return next(new ErrorHandler('Unauthorized to review vacation requests', 403));
  }

  if (!['approved', 'denied'].includes(status)) {
    return next(new ErrorHandler('status must be approved or denied', 400));
  }

  request.status = status;
  request.reviewNotes = reviewNotes || undefined;
  request.reviewedBy = req.user.id;
  request.reviewedAt = new Date();

  if (status === 'approved') {
    await _assertVacationConflictRules(req.params.id, request.user, _startOfDay(request.startDate), _startOfDay(request.endDate), request._id);
  }

  await request.save();

  await ShiftOverride.deleteMany({
    center: req.params.id,
    user: request.user,
    vacationRequest: request._id,
  });

  if (status === 'approved') {
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
      timeSegments: override.isOff ? [] : override.startTime && override.endTime ? [{ startTime: override.startTime, endTime: override.endTime }] : [],
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
  const { userId, date, endDate, label, startTime, endTime, isOff, notes, reasonType } = req.body;

  if (!userId || !date) {
    return next(new ErrorHandler('userId and date are required', 400));
  }

  if (!isOff && (!label || !startTime || !endTime)) {
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
        startTime: isOff ? undefined : startTime,
        endTime: isOff ? undefined : endTime,
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
  const { from, to } = req.query;
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

  const overrides = await ShiftOverride.find(overrideFilter).populate('user', 'name email');

  let occurrences = applyOverrides(
    computeOccurrences(patterns.filter(hasResolvedUser), fromDate, toDate),
    overrides.filter(hasResolvedUser)
  );
  if (roleName === 'coach') {
    occurrences = occurrences.filter((occ) => occ.userId === req.user.id || occ.reasonType === 'vacation');
  }
  res.status(200).json({ success: true, occurrences });
});
