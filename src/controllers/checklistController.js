const Checklist = require('../models/Checklist');
const ChecklistAlertDismissal = require('../models/ChecklistAlertDismissal');
const UserCenterRole = require('../models/UserCenterRole');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

function buildDayRange(dateInput) {
  const baseDate = new Date(dateInput);
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function isSharedChecklistType(type) {
  return type === 'daily' || type === 'general_cleaning';
}

// Worker creates a checklist (for daily tasks) or admin generates
exports.createChecklist = catchAsyncErrors(async (req, res, next) => {
  const { centerId, type, date, items, assignedUserId } = req.body;
  const checklistType = type || 'daily';

  if (!centerId || !date || !items || items.length === 0 || (!isSharedChecklistType(checklistType) && !assignedUserId)) {
    return next(new ErrorHandler('centerId, date and at least one item are required', 400));
  }

  // Handle items that can be strings or objects with label property
  const processedItems = items.map((item) => {
    if (typeof item === 'string') {
      return { label: item };
    }
    return item;
  });

  const baseDate = new Date(date);
  const { start, end } = buildDayRange(baseDate);

  const uniquenessFilter =
    isSharedChecklistType(checklistType)
      ? { center: centerId, type: checklistType, date: { $gte: start, $lt: end } }
      : { center: centerId, type: checklistType, assignedUser: assignedUserId, date: { $gte: start, $lt: end } };

  const existingChecklist = await Checklist.findOne(uniquenessFilter)
    .populate('assignedUser', 'name email')
    .populate('reviewedBy', 'name email')
    .populate('items.doneBy', 'name email');

  if (existingChecklist) {
    if (isSharedChecklistType(checklistType) && processedItems.length > 0) {
      const existingLabels = new Set(existingChecklist.items.map((item) => item.label));
      const missingItems = processedItems.filter((item) => !existingLabels.has(item.label));

      if (missingItems.length > 0) {
        existingChecklist.items.push(...missingItems);
        await existingChecklist.save();
      }
    }

    return res.status(200).json({ success: true, checklist: existingChecklist });
  }

  const checklist = await Checklist.create({
    center: centerId,
    date: baseDate,
    assignedUser: isSharedChecklistType(checklistType) ? undefined : assignedUserId,
    type: checklistType,
    items: processedItems,
    status: 'pending',
  });

  res.status(201).json({ success: true, checklist });
});

exports.getChecklists = catchAsyncErrors(async (req, res, next) => {
  const user = req.user;

  let filter = {};

  if (req.query.centerId) {
    filter.center = req.query.centerId;
  }

  if (req.query.date) {
    const date = new Date(req.query.date);
    const dateOnly = new Date(date.toISOString().split('T')[0]);
    const dateNext = new Date(dateOnly);
    dateNext.setDate(dateNext.getDate() + 1);
    filter.date = { $gte: dateOnly, $lt: dateNext };
  }

  if (req.query.status) {
    filter.status = req.query.status;
  }

  // workers get their own assigned tasks
  if (user.role !== 'admin') {
    if (req.query.centerId) {
      const assignment = await UserCenterRole.findOne({
        user: user.id,
        center: req.query.centerId,
        active: true,
      });

      if (!assignment) {
        return next(new ErrorHandler('Unauthorized', 403));
      }

      filter.$or = [{ assignedUser: user.id }, { type: 'daily' }, { type: 'general_cleaning' }];
    } else {
      filter.assignedUser = user.id;
    }
  }

  const checklists = await Checklist.find(filter)
    .populate('assignedUser', 'name email')
    .populate('center', 'name type')
    .populate('reviewedBy', 'name email');

  res.status(200).json({ success: true, checklists });
});

exports.markItemDone = catchAsyncErrors(async (req, res, next) => {
  const checklist = await Checklist.findById(req.params.id);
  if (!checklist) return next(new ErrorHandler('Checklist not found', 404));

  const isAssignedUser = checklist.assignedUser && checklist.assignedUser.toString() === req.user.id;
  if (!isAssignedUser && req.user.role !== 'admin') {
    const assignment = await UserCenterRole.findOne({
      user: req.user.id,
      center: checklist.center,
      active: true,
    });

    if (!assignment) {
      return next(new ErrorHandler('Unauthorized', 403));
    }
  }

  const { itemIndex, done } = req.body;

  if (itemIndex === undefined || itemIndex < 0 || itemIndex >= checklist.items.length) {
    return next(new ErrorHandler('Invalid itemIndex', 400));
  }

  checklist.items[itemIndex].done = !!done;
  checklist.items[itemIndex].doneAt = !!done ? new Date() : null;
  checklist.items[itemIndex].doneBy = !!done ? req.user.id : null;

  const allDone = checklist.items.every((item) => item.done);
  checklist.status = allDone ? 'completed' : 'in_progress';

  await checklist.save();

  res.status(200).json({ success: true, checklist });
});

exports.adminReview = catchAsyncErrors(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(new ErrorHandler('Only admin can review', 403));
  }

  const checklist = await Checklist.findById(req.params.id);
  if (!checklist) return next(new ErrorHandler('Checklist not found', 404));

  const { status, reviewNotes } = req.body;
  if (!['reviewed', 'pending', 'completed'].includes(status)) {
    return next(new ErrorHandler('Status must be reviewed/pending/completed', 400));
  }

  checklist.status = status;
  checklist.reviewNotes = reviewNotes || checklist.reviewNotes;
  checklist.reviewedBy = req.user.id;
  checklist.reviewedAt = new Date();
  await checklist.save();

  res.status(200).json({ success: true, checklist });
});

exports.getOverdueDismissals = catchAsyncErrors(async (req, res, next) => {
  const { centerId, startDate, endDate } = req.query;

  if (!centerId || !startDate || !endDate) {
    return next(new ErrorHandler('centerId, startDate and endDate are required', 400));
  }

  if (req.user.role !== 'admin') {
    const assignment = await UserCenterRole.findOne({
      user: req.user.id,
      center: centerId,
      active: true,
    });

    if (!assignment) {
      return next(new ErrorHandler('Unauthorized', 403));
    }
  }

  const start = new Date(startDate);
  const endRange = buildDayRange(endDate).end;

  const dismissals = await ChecklistAlertDismissal.find({
    center: centerId,
    date: { $gte: start, $lt: endRange },
  }).select('date dismissedAt dismissedBy');

  res.status(200).json({ success: true, dismissals });
});

exports.dismissOverdueAlert = catchAsyncErrors(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(new ErrorHandler('Only admin can dismiss overdue alerts', 403));
  }

  const { centerId, date } = req.body;

  if (!centerId || !date) {
    return next(new ErrorHandler('centerId and date are required', 400));
  }

  const { start } = buildDayRange(date);

  const dismissal = await ChecklistAlertDismissal.findOneAndUpdate(
    { center: centerId, date: start },
    {
      $set: {
        dismissedBy: req.user.id,
        dismissedAt: new Date(),
      },
      $setOnInsert: {
        center: centerId,
        date: start,
      },
    },
    { new: true, upsert: true }
  );

  res.status(200).json({ success: true, dismissal });
});
