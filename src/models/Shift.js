const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Please provide shift name'],
    },
    startTime: {
      type: String,
      required: [true, 'Please provide start time'],
    },
    endTime: {
      type: String,
      required: [true, 'Please provide end time'],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Shift', shiftSchema);
