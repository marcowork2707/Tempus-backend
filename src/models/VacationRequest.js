const mongoose = require('mongoose');

const vacationRequestSchema = new mongoose.Schema(
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
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'pending',
    },
    reviewNotes: {
      type: String,
      maxlength: [500, 'Review notes cannot exceed 500 characters'],
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

vacationRequestSchema.index({ center: 1, user: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('VacationRequest', vacationRequestSchema);
