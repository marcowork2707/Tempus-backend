const mongoose = require('mongoose');

const payrollEntrySchema = new mongoose.Schema(
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
    month: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    grossSalary: {
      type: Number,
      required: true,
      min: 0,
    },
    netSalary: {
      type: Number,
      required: true,
      min: 0,
    },
    // Legacy compatibility fields. Keep them to avoid breaking existing data.
    baseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    variableAmount: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

payrollEntrySchema.index({ center: 1, user: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('PayrollEntry', payrollEntrySchema);