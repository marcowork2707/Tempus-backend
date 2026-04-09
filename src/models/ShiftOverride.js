const mongoose = require('mongoose');

const shiftOverrideSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    vacationRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VacationRequest',
      default: null,
    },
    date: {
      type: Date,
      required: true,
    },
    label: {
      type: String,
      trim: true,
      maxlength: [80, 'Label cannot exceed 80 characters'],
    },
    startTime: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'startTime must be HH:MM'],
    },
    endTime: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'endTime must be HH:MM'],
    },
    isOff: {
      type: Boolean,
      default: false,
    },
    reasonType: {
      type: String,
      enum: ['custom', 'holiday', 'vacation'],
      default: 'custom',
    },
    notes: {
      type: String,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { timestamps: true }
);

shiftOverrideSchema.index({ center: 1, user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ShiftOverride', shiftOverrideSchema);
