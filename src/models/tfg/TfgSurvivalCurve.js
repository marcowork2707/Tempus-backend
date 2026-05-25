const mongoose = require('mongoose');

const tfgSurvivalCurveSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true },
    segmentation: {
      type: String,
      enum: ['global', 'tarifa', 'onramp'],
      required: true,
    },
    group: { type: String, required: true }, // 'global', 'IRON', 'on_ramp', etc.
    timeline: [Number],      // dias desde alta [0, 30, 60, ...]
    survival: [Number],      // S(t) en cada punto del timeline [1.0, 0.95, ...]
    ci_lower: [Number],      // IC95 inferior
    ci_upper: [Number],      // IC95 superior
    median_survival: { type: Number, default: null }, // dias hasta S(t)=0.5
    n_subjects: { type: Number, default: 0 },
    cutoffDate: { type: Date, required: true },
  },
  { timestamps: true, collection: 'tfgsurvivalcurves' }
);

tfgSurvivalCurveSchema.index({ center: 1, segmentation: 1, group: 1 }, { unique: true });
tfgSurvivalCurveSchema.index({ center: 1, segmentation: 1 });

module.exports = mongoose.model('TfgSurvivalCurve', tfgSurvivalCurveSchema);
