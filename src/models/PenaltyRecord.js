const mongoose = require('mongoose');

// Una penalización aplicada a un trabajador. Los admins las van añadiendo durante
// el mes; el total mensual por trabajador determina la consecuencia. Todos los
// campos son editables (categoría/descripción/puntos se copian del criterio al
// crear, pero se pueden ajustar por registro).
const penaltyRecordSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // YYYY-MM derivado de la fecha, para agregación/filtrado mensual.
    month: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'],
      index: true,
    },
    date: { type: Date, required: true },
    criterion: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PenaltyCriterion',
      default: null,
    },
    category: { type: String, enum: ['clase', 'personal', 'backoffice'], default: 'personal' },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    points: { type: Number, default: 0 },
    comment: { type: String, trim: true, maxlength: 500, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PenaltyRecord', penaltyRecordSchema);
