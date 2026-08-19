const MessageCategory = require('../models/MessageCategory');
const MessageTemplate = require('../models/MessageTemplate');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

// GET /api/messages/categories?centerType=xxx
exports.getCategories = catchAsyncErrors(async (req, res) => {
  const { centerType } = req.query;

  const query = {};
  if (centerType) query.centerType = centerType;

  const categories = await MessageCategory.find(query).sort({ order: 1 });
  res.status(200).json({ success: true, categories });
});

// GET /api/messages/templates?centerType=xxx&category=yyy&branch=zzz
exports.getTemplates = catchAsyncErrors(async (req, res) => {
  const { centerType, category, branch } = req.query;

  const query = {};
  if (category) query.category = category;
  if (branch) query.branch = branch;

  if (centerType) {
    const categories = await MessageCategory.find({ centerType }).select('_id');
    query.category = { $in: categories.map((c) => c._id) };
  }

  const templates = await MessageTemplate.find(query).sort({ order: 1 });
  res.status(200).json({ success: true, templates });
});

// POST /api/messages/categories
exports.upsertCategory = catchAsyncErrors(async (req, res, next) => {
  const { id, centerType, funnelStage, name, order } = req.body;

  if (!centerType || !funnelStage || !name) {
    return next(new ErrorHandler('centerType, funnelStage and name are required', 400));
  }

  let category;
  if (id) {
    category = await MessageCategory.findByIdAndUpdate(
      id,
      { centerType, funnelStage, name, order },
      { new: true, runValidators: true }
    );
    if (!category) return next(new ErrorHandler('Category not found', 404));
  } else {
    category = await MessageCategory.create({ centerType, funnelStage, name, order });
  }

  res.status(200).json({ success: true, category });
});

// POST /api/messages/templates
exports.upsertTemplate = catchAsyncErrors(async (req, res, next) => {
  const { id, category, title, body, branch, order } = req.body;

  if (!category || !title || !body) {
    return next(new ErrorHandler('category, title and body are required', 400));
  }

  let template;
  if (id) {
    template = await MessageTemplate.findByIdAndUpdate(
      id,
      { category, title, body, branch, order, lastEditedBy: req.user.id, lastEditedAt: new Date() },
      { new: true, runValidators: true }
    );
    if (!template) return next(new ErrorHandler('Template not found', 404));
  } else {
    template = await MessageTemplate.create({
      category,
      title,
      body,
      branch,
      order,
      lastEditedBy: req.user.id,
      lastEditedAt: new Date(),
    });
  }

  res.status(200).json({ success: true, template });
});

// DELETE /api/messages/templates/:id
exports.deleteTemplate = catchAsyncErrors(async (req, res, next) => {
  const template = await MessageTemplate.findByIdAndDelete(req.params.id);
  if (!template) return next(new ErrorHandler('Template not found', 404));

  res.status(200).json({ success: true });
});
