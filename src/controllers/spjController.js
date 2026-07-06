const PenaltyCriterion = require('../models/PenaltyCriterion');
const PenaltyThreshold = require('../models/PenaltyThreshold');
const PenaltyRecord = require('../models/PenaltyRecord');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthFromDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CATEGORIES = ['clase', 'personal', 'backoffice'];

// Lista por defecto (tu tabla) con la que se siembra cada centro la primera vez.
const DEFAULT_CRITERIA = [
  { order: 1, category: 'clase', description: 'Pizarra contiene bloques definidos, con tiempos por bloque y progresiones definidas', priority: 3, probability: 3, points: 1.0 },
  { order: 2, category: 'clase', description: 'Timing: clase termina a tiempo', priority: 2, probability: 1, points: 2.0 },
  { order: 3, category: 'clase', description: 'Música de la clase acorde a la situación', priority: 1, probability: 3, points: 0.3 },
  { order: 4, category: 'clase', description: 'Coach empieza la clase aseado', priority: 2, probability: 1, points: 2.0 },
  { order: 5, category: 'clase', description: 'Coach recuerda evento pizarra en caso de haberlo', priority: 1, probability: 2, points: 0.5 },
  { order: 6, category: 'personal', description: 'Imagen personal adecuada: camiseta/sudadera corporativa y calzado deportivo acorde', priority: 2, probability: 1, points: 2.0 },
  { order: 7, category: 'personal', description: 'Puntualidad: si no hay fichaje, o si se ficha/desficha mal, se considera impuntual', priority: 3, probability: 3, points: 1.0 },
  { order: 8, category: 'personal', description: 'Pizarra borrada', priority: 1, probability: 1, points: 1.0 },
  { order: 9, category: 'personal', description: 'Coach responsable de la clase amplía si es necesario', priority: 2, probability: 2, points: 1.0 },
  { order: 10, category: 'personal', description: 'Altavoces se apagan correctamente, pensando en el siguiente turno', priority: 2, probability: 1, points: 2.0 },
  { order: 11, category: 'personal', description: 'Prioridad OPEN para socios', priority: 3, probability: 1, points: 3.0 },
  { order: 12, category: 'personal', description: 'Mala contestación/actitud frente a un socio', priority: 3, probability: 1, points: 3.0 },
  { order: 13, category: 'backoffice', description: 'Todas las tareas del día (mañana o tarde) completadas', priority: 3, probability: 3, points: 1.0 },
  { order: 14, category: 'backoffice', description: 'Reporte de clase pasado al día', priority: 2, probability: 2, points: 1.0 },
  { order: 15, category: 'backoffice', description: 'Tareas limpieza diarias hechas', priority: 3, probability: 3, points: 1.0 },
];

const DEFAULT_THRESHOLDS = [
  { order: 1, points: 12, consequence: 'Formación obligatoria (ej. leer un libro, archivo, documento recomendado)' },
  { order: 2, points: 15, consequence: 'Trabajar un sábado' },
  { order: 3, points: 18, consequence: 'No entrenar en OPEN durante una semana' },
  { order: 4, points: 20, consequence: 'Restar un 25% en lo facturado en un PT dentro del mes' },
  { order: 5, points: 24, consequence: 'Restar un 25% en el sueldo extra en cash' },
  { order: 6, points: 28, consequence: 'Despido' },
];

// ─── Criterios ───────────────────────────────────────────────────────────────

exports.getSpjCriteria = catchAsyncErrors(async (req, res) => {
  const { centerId } = req.params;
  let criteria = await PenaltyCriterion.find({ center: centerId }).sort({ order: 1, createdAt: 1 });
  if (criteria.length === 0) {
    criteria = await PenaltyCriterion.insertMany(
      DEFAULT_CRITERIA.map((c) => ({ ...c, center: centerId }))
    );
    criteria.sort((a, b) => a.order - b.order);
  }
  res.status(200).json({ criteria });
});

exports.upsertSpjCriterion = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const { criterionId } = req.params;
  const { category, description, priority, probability, points, order, active } = req.body || {};

  if (category !== undefined && !CATEGORIES.includes(category)) {
    return next(new ErrorHandler('category inválida', 400));
  }

  if (criterionId) {
    const criterion = await PenaltyCriterion.findOne({ _id: criterionId, center: centerId });
    if (!criterion) return next(new ErrorHandler('Criterio no encontrado', 404));
    if (category !== undefined) criterion.category = category;
    if (description !== undefined) criterion.description = String(description).trim();
    if (priority !== undefined) criterion.priority = Number(priority);
    if (probability !== undefined) criterion.probability = Number(probability);
    if (points !== undefined) criterion.points = round2(points);
    if (order !== undefined) criterion.order = Number(order);
    if (active !== undefined) criterion.active = Boolean(active);
    await criterion.save();
    return res.status(200).json({ criterion });
  }

  if (!category || !description) {
    return next(new ErrorHandler('category y description son obligatorios', 400));
  }
  const created = await PenaltyCriterion.create({
    center: centerId,
    category,
    description: String(description).trim(),
    priority: priority !== undefined ? Number(priority) : 1,
    probability: probability !== undefined ? Number(probability) : 1,
    points: round2(points),
    order: order !== undefined ? Number(order) : 999,
  });
  res.status(201).json({ criterion: created });
});

exports.deleteSpjCriterion = catchAsyncErrors(async (req, res, next) => {
  const { centerId, criterionId } = req.params;
  const deleted = await PenaltyCriterion.findOneAndDelete({ _id: criterionId, center: centerId });
  if (!deleted) return next(new ErrorHandler('Criterio no encontrado', 404));
  res.status(200).json({ success: true });
});

// ─── Umbrales de consecuencias ────────────────────────────────────────────────

exports.getSpjThresholds = catchAsyncErrors(async (req, res) => {
  const { centerId } = req.params;
  let thresholds = await PenaltyThreshold.find({ center: centerId }).sort({ points: 1 });
  if (thresholds.length === 0) {
    thresholds = await PenaltyThreshold.insertMany(
      DEFAULT_THRESHOLDS.map((t) => ({ ...t, center: centerId }))
    );
    thresholds.sort((a, b) => a.points - b.points);
  }
  res.status(200).json({ thresholds });
});

exports.upsertSpjThreshold = catchAsyncErrors(async (req, res, next) => {
  const { centerId, thresholdId } = req.params;
  const { points, consequence, order, active } = req.body || {};

  if (thresholdId) {
    const threshold = await PenaltyThreshold.findOne({ _id: thresholdId, center: centerId });
    if (!threshold) return next(new ErrorHandler('Umbral no encontrado', 404));
    if (points !== undefined) threshold.points = round2(points);
    if (consequence !== undefined) threshold.consequence = String(consequence).trim();
    if (order !== undefined) threshold.order = Number(order);
    if (active !== undefined) threshold.active = Boolean(active);
    await threshold.save();
    return res.status(200).json({ threshold });
  }

  if (points === undefined || !consequence) {
    return next(new ErrorHandler('points y consequence son obligatorios', 400));
  }
  const created = await PenaltyThreshold.create({
    center: centerId,
    points: round2(points),
    consequence: String(consequence).trim(),
    order: order !== undefined ? Number(order) : 999,
  });
  res.status(201).json({ threshold: created });
});

exports.deleteSpjThreshold = catchAsyncErrors(async (req, res, next) => {
  const { centerId, thresholdId } = req.params;
  const deleted = await PenaltyThreshold.findOneAndDelete({ _id: thresholdId, center: centerId });
  if (!deleted) return next(new ErrorHandler('Umbral no encontrado', 404));
  res.status(200).json({ success: true });
});

// ─── Penalizaciones (registros) ───────────────────────────────────────────────

exports.getSpjRecords = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const month = MONTH_REGEX.test(req.query.month || '') ? req.query.month : currentMonthStr();
  const filter = { center: centerId, month };
  if (req.query.userId) filter.user = req.query.userId;

  const records = await PenaltyRecord.find(filter)
    .populate('user', 'name email')
    .populate('createdBy', 'name email')
    .sort({ date: -1, createdAt: -1 });
  res.status(200).json({ month, records });
});

exports.createSpjRecord = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const { userId, date, criterionId, category, description, points, comment } = req.body || {};

  if (!userId || !date) {
    return next(new ErrorHandler('userId y date son obligatorios', 400));
  }

  let resolved = { category, description, points };
  // Si viene de un criterio del catálogo, copiamos sus valores como base.
  if (criterionId) {
    const criterion = await PenaltyCriterion.findOne({ _id: criterionId, center: centerId });
    if (criterion) {
      resolved = {
        category: category ?? criterion.category,
        description: description ?? criterion.description,
        points: points !== undefined ? points : criterion.points,
      };
    }
  }

  if (!CATEGORIES.includes(resolved.category)) {
    return next(new ErrorHandler('category inválida', 400));
  }

  const record = await PenaltyRecord.create({
    center: centerId,
    user: userId,
    month: monthFromDate(date),
    date: new Date(date),
    criterion: criterionId || null,
    category: resolved.category,
    description: String(resolved.description || '').trim(),
    points: round2(resolved.points),
    comment: comment ? String(comment).trim() : '',
    createdBy: req.user.id,
  });

  const populated = await PenaltyRecord.findById(record._id)
    .populate('user', 'name email')
    .populate('createdBy', 'name email');
  res.status(201).json({ record: populated });
});

exports.updateSpjRecord = catchAsyncErrors(async (req, res, next) => {
  const { centerId, recordId } = req.params;
  const { userId, date, category, description, points, comment, criterionId } = req.body || {};

  const record = await PenaltyRecord.findOne({ _id: recordId, center: centerId });
  if (!record) return next(new ErrorHandler('Penalización no encontrada', 404));

  if (userId !== undefined) record.user = userId;
  if (date !== undefined) {
    record.date = new Date(date);
    record.month = monthFromDate(date);
  }
  if (criterionId !== undefined) record.criterion = criterionId || null;
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) return next(new ErrorHandler('category inválida', 400));
    record.category = category;
  }
  if (description !== undefined) record.description = String(description).trim();
  if (points !== undefined) record.points = round2(points);
  if (comment !== undefined) record.comment = String(comment).trim();

  await record.save();
  const populated = await PenaltyRecord.findById(record._id)
    .populate('user', 'name email')
    .populate('createdBy', 'name email');
  res.status(200).json({ record: populated });
});

exports.deleteSpjRecord = catchAsyncErrors(async (req, res, next) => {
  const { centerId, recordId } = req.params;
  const deleted = await PenaltyRecord.findOneAndDelete({ _id: recordId, center: centerId });
  if (!deleted) return next(new ErrorHandler('Penalización no encontrada', 404));
  res.status(200).json({ success: true });
});

// ─── Resumen mensual ──────────────────────────────────────────────────────────

exports.getSpjSummary = catchAsyncErrors(async (req, res) => {
  const { centerId } = req.params;
  const month = MONTH_REGEX.test(req.query.month || '') ? req.query.month : currentMonthStr();

  const [records, thresholdsRaw] = await Promise.all([
    PenaltyRecord.find({ center: centerId, month }).populate('user', 'name email'),
    PenaltyThreshold.find({ center: centerId, active: true }).sort({ points: 1 }),
  ]);

  const thresholds = thresholdsRaw.map((t) => ({ points: t.points, consequence: t.consequence }));

  const byUser = new Map();
  for (const record of records) {
    if (!record.user?._id) continue;
    const key = record.user._id.toString();
    if (!byUser.has(key)) {
      byUser.set(key, {
        userId: key,
        userName: record.user.name,
        totalPoints: 0,
        count: 0,
      });
    }
    const entry = byUser.get(key);
    entry.totalPoints = round2(entry.totalPoints + (Number(record.points) || 0));
    entry.count += 1;
  }

  const summary = Array.from(byUser.values()).map((entry) => {
    // Consecuencia = umbral más alto alcanzado (points >= threshold).
    const reached = thresholds.filter((t) => entry.totalPoints >= t.points);
    const topConsequence = reached.length > 0 ? reached[reached.length - 1] : null;
    return { ...entry, consequence: topConsequence };
  }).sort((a, b) => b.totalPoints - a.totalPoints);

  res.status(200).json({ month, summary, thresholds });
});
