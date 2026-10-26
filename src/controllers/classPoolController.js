const CenterClassPool = require('../models/CenterClassPool');
const CenterTariffGroup = require('../models/CenterTariffGroup');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

function parsePatterns(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((p) => String(p).trim()).filter(Boolean))];
}

exports.getClassPools = catchAsyncErrors(async (req, res) => {
  const pools = await CenterClassPool.find({ center: req.params.id }).sort({ order: 1, createdAt: 1 });
  res.status(200).json({ success: true, pools });
});

exports.createClassPool = catchAsyncErrors(async (req, res, next) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return next(new ErrorHandler('name is required', 400));
  const isDefault = Boolean(req.body?.isDefault);
  const count = await CenterClassPool.countDocuments({ center: req.params.id });
  const pool = await CenterClassPool.create({
    center: req.params.id,
    name,
    patterns: parsePatterns(req.body?.patterns),
    isDefault,
    order: req.body?.order !== undefined && Number.isFinite(Number(req.body.order)) ? Number(req.body.order) : count,
  });
  // Solo una bolsa por defecto por centro
  if (isDefault) await CenterClassPool.updateMany({ center: req.params.id, _id: { $ne: pool._id } }, { isDefault: false });
  res.status(200).json({ success: true, pool });
});

// Bolsas estándar de un box de CrossFit. Idempotente: solo crea las que falten
// (por nombre). "CrossFit" es la bolsa por defecto: recoge todo lo que no sea
// Open, Iniciación o Funcional (Halterofilia, T-Hybrid, Run & Sweat...).
const CROSSFIT_PRESET = [
  { name: 'Open', patterns: ['open'], isDefault: false, order: 0 },
  { name: 'Iniciación', patterns: ['iniciaci'], isDefault: false, order: 1 },
  { name: 'Funcional', patterns: ['funcional'], isDefault: false, order: 2 },
  { name: 'CrossFit', patterns: [], isDefault: true, order: 3 },
];

exports.createClassPoolPreset = catchAsyncErrors(async (req, res, next) => {
  const preset = String(req.body?.preset || 'crossfit');
  if (preset !== 'crossfit') return next(new ErrorHandler('Preset desconocido', 400));

  const existing = await CenterClassPool.find({ center: req.params.id });
  const existingNames = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  const hasDefault = existing.some((p) => p.isDefault);
  const created = [];
  for (const def of CROSSFIT_PRESET) {
    if (existingNames.has(def.name.toLowerCase())) continue;
    const pool = await CenterClassPool.create({
      center: req.params.id,
      name: def.name,
      patterns: def.patterns,
      // No se pisa una bolsa por defecto que ya exista
      isDefault: def.isDefault && !hasDefault,
      order: def.order,
    });
    created.push(pool);
  }
  const pools = await CenterClassPool.find({ center: req.params.id }).sort({ order: 1, createdAt: 1 });
  res.status(200).json({ success: true, created: created.length, pools });
});

exports.updateClassPool = catchAsyncErrors(async (req, res, next) => {
  const pool = await CenterClassPool.findOne({ _id: req.params.poolId, center: req.params.id });
  if (!pool) return next(new ErrorHandler('Class pool not found', 404));
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return next(new ErrorHandler('name cannot be empty', 400));
    pool.name = name;
  }
  if (req.body?.patterns !== undefined) pool.patterns = parsePatterns(req.body.patterns);
  if (req.body?.order !== undefined && Number.isFinite(Number(req.body.order))) pool.order = Number(req.body.order);
  if (req.body?.isDefault !== undefined) pool.isDefault = Boolean(req.body.isDefault);
  await pool.save();
  if (pool.isDefault) await CenterClassPool.updateMany({ center: req.params.id, _id: { $ne: pool._id } }, { isDefault: false });
  res.status(200).json({ success: true, pool });
});

exports.deleteClassPool = catchAsyncErrors(async (req, res, next) => {
  const deleted = await CenterClassPool.findOneAndDelete({ _id: req.params.poolId, center: req.params.id });
  if (!deleted) return next(new ErrorHandler('Class pool not found', 404));
  // Quitar la bolsa de los repartos de las tarifas; los repartos que se quedan sin bolsas se eliminan
  const groups = await CenterTariffGroup.find({ center: req.params.id, 'items.allowances.pools': deleted._id });
  for (const group of groups) {
    for (const item of group.items) {
      item.allowances = (item.allowances || [])
        .map((a) => ({ pools: a.pools.filter((p) => String(p) !== String(deleted._id)), classesPerMonth: a.classesPerMonth, unlimited: a.unlimited }))
        .filter((a) => a.pools.length > 0);
    }
    await group.save();
  }
  res.status(200).json({ success: true, message: 'Class pool deleted' });
});
