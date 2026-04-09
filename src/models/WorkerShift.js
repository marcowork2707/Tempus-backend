const mongoose = require('mongoose');

const workerShiftSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shift',
      required: true,
    },
    date: {
      type: Date,
      required: [true, 'Please provide a date'],
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
workerShiftSchema.index({ user: 1, center: 1, date: 1 });

module.exports = mongoose.model('WorkerShift', workerShiftSchema);
