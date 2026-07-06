const mongoose = require('mongoose');

// Umbrales de consecuencias del SPJ, por centro y editables. Al alcanzar cierta
// puntuación (mensual) se aplica la consecuencia asociada.
const penaltyThresholdSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    points: { type: Number, required: true },
    consequence: { type: String, required: true, trim: true, maxlength: 300 },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PenaltyThreshold', penaltyThresholdSchema);
