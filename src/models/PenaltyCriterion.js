const mongoose = require('mongoose');

// Catálogo editable de criterios del SPJ (Sistema de Penalizaciones Justa),
// por centro. Cada centro arranca con la lista por defecto y puede ajustarla.
const penaltyCriterionSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    order: { type: Number, default: 0 },
    category: {
      type: String,
      enum: ['clase', 'personal', 'backoffice'],
      required: true,
    },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    priority: { type: Number, min: 1, max: 3, default: 1 },
    probability: { type: Number, min: 1, max: 3, default: 1 },
    points: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PenaltyCriterion', penaltyCriterionSchema);
