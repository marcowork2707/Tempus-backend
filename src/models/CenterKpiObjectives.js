const mongoose = require('mongoose');

// One document per center+year. Each KPI stores an array of 12 monthly target values (Jan=0..Dec=11).
const kpiObjectiveSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    monthly: {
      type: [Number],
      default: () => Array(12).fill(null),
      validate: {
        validator: (v) => Array.isArray(v) && v.length === 12,
        message: 'monthly must have exactly 12 values',
      },
    },
  },
  { _id: false }
);

const centerKpiObjectivesSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    objectives: {
      type: [kpiObjectiveSchema],
      default: [],
    },
  },
  { timestamps: true }
);

centerKpiObjectivesSchema.index({ center: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('CenterKpiObjectives', centerKpiObjectivesSchema);
