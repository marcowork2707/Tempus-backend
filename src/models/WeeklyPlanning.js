const mongoose = require('mongoose');

const weeklyPlanningSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    weekStart: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'weekStart must be YYYY-MM-DD'],
      index: true,
    },
    weekEnd: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'weekEnd must be YYYY-MM-DD'],
    },
    imageDataUrl: {
      type: String,
      required: true,
    },
    imageMimeType: {
      type: String,
      required: true,
      enum: ['image/png', 'image/jpeg', 'image/webp'],
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    sentAt: {
      type: Date,
      default: null,
      index: true,
    },
    sendAttempts: {
      type: Number,
      default: 0,
    },
    lastSendError: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

weeklyPlanningSchema.index({ center: 1, weekStart: 1, createdAt: -1 });

module.exports = mongoose.model('WeeklyPlanning', weeklyPlanningSchema);
