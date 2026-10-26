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

// Tarifas de CrossFit Tempus (folletos de octubre de 2026) con su reparto por
// bolsa. Idempotente: crea los grupos/tarifas que falten por nombre, nunca pisa
// los existentes. Requiere las bolsas estándar (se crean si faltan).
const CROSSFIT_TARIFF_PRESET = [
  {
    group: 'Tarifas',
    items: [
      { name: 'IRON', price: 59.9, aliases: ['trimestral iron', 'semestral iron'], allowances: [{ pools: ['CrossFit'], classesPerMonth: 8 }, { pools: ['Open'], classesPerMonth: 4 }] },
      { name: 'SILVER', price: 69.9, aliases: ['trimestral silver', 'semestral silver'], allowances: [{ pools: ['CrossFit'], classesPerMonth: 12 }, { pools: ['Open'], classesPerMonth: 4 }] },
      { name: 'GOLD', price: 79.9, aliases: ['trimestral gold', 'semestral gold'], allowances: [{ pools: ['CrossFit'], classesPerMonth: 17 }, { pools: ['Open'], classesPerMonth: 4 }] },
      { name: 'FULL', price: 89.9, aliases: ['trimestral full', 'semestral full'], allowances: [{ pools: ['CrossFit', 'Open'], unlimited: true }] },
      { name: 'COMPETITOR', price: 99.9, aliases: ['trimestral competitor', 'semestral competitor'], allowances: [{ pools: ['CrossFit', 'Open'], unlimited: true }] },
    ],
  },
  {
    group: 'Tarifas Iniciación',
    items: [
      { name: 'ON RAMP', price: 55, aliases: ['onramp', 'on-ramp'], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 8 }] },
      { name: 'ON RAMP PLUS', price: 65, aliases: ['onramp plus', 'on-ramp plus'], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 12 }] },
      { name: 'ON RAMP PLUS+', price: 75, aliases: ['on ramp plus +', 'onramp plus+', 'on ramp plus plus'], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 16 }] },
      { name: 'MEDIUM', price: 59.9, aliases: [], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 4 }, { pools: ['CrossFit'], classesPerMonth: 4 }] },
      { name: 'MEDIUM PLUS', price: 69.9, aliases: [], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 6 }, { pools: ['CrossFit'], classesPerMonth: 6 }] },
      { name: 'MEDIUM PLUS+', price: 79.9, aliases: ['medium plus +', 'medium plus plus'], allowances: [{ pools: ['Iniciación', 'Funcional'], classesPerMonth: 8 }, { pools: ['CrossFit'], classesPerMonth: 8 }] },
    ],
  },
  {
    group: 'Bonos',
    items: [
      { name: 'Bono 5 Clases', price: null, aliases: ['bono 5', 'bono 5 clases'], excludeFromCapacity: true, allowances: [] },
      { name: 'Bono 10 Clases', price: null, aliases: ['bono 10', 'bono 10 clases'], excludeFromCapacity: true, allowances: [] },
    ],
  },
];

exports.createTariffPreset = catchAsyncErrors(async (req, res, next) => {
  const preset = String(req.body?.preset || 'crossfit-tempus');
  if (preset !== 'crossfit-tempus') return next(new ErrorHandler('Preset desconocido', 400));

  // Bolsas por nombre (se crean las estándar si faltan)
  let pools = await CenterClassPool.find({ center: req.params.id });
  const poolByName = () => new Map(pools.map((p) => [p.name.trim().toLowerCase(), p]));
  const missingPools = CROSSFIT_PRESET.filter((def) => !poolByName().has(def.name.toLowerCase()));
  for (const def of missingPools) {
    const hasDefault = pools.some((p) => p.isDefault);
    pools.push(await CenterClassPool.create({ center: req.params.id, name: def.name, patterns: def.patterns, isDefault: def.isDefault && !hasDefault, order: def.order }));
  }
  const byName = poolByName();

  let createdGroups = 0;
  let createdItems = 0;
  const existingGroups = await CenterTariffGroup.find({ center: req.params.id });
  for (const [index, def] of CROSSFIT_TARIFF_PRESET.entries()) {
    let group = existingGroups.find((g) => g.name.trim().toLowerCase() === def.group.toLowerCase());
    if (!group) {
      group = await CenterTariffGroup.create({ center: req.params.id, name: def.group, order: existingGroups.length + index, items: [] });
      createdGroups += 1;
    }
    const itemNames = new Set(group.items.map((i) => i.name.trim().toLowerCase()));
    for (const item of def.items) {
      if (itemNames.has(item.name.toLowerCase())) continue;
      group.items.push({
        name: item.name,
        price: item.price,
        aliases: item.aliases,
        active: true,
        excludeFromCapacity: Boolean(item.excludeFromCapacity),
        allowances: item.allowances.map((a) => ({
          pools: a.pools.map((n) => byName.get(n.toLowerCase())?._id).filter(Boolean),
          classesPerMonth: a.unlimited ? null : a.classesPerMonth,
          unlimited: Boolean(a.unlimited),
        })),
      });
      createdItems += 1;
    }
    await group.save();
  }

  const groups = await CenterTariffGroup.find({ center: req.params.id }).sort({ order: 1, createdAt: 1 });
  res.status(200).json({ success: true, createdGroups, createdItems, groups, pools });
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
