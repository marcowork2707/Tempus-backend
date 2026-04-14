const mongoose = require('mongoose');

const classReportItemSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: true,
      trim: true,
    },
    classTime: {
      type: String,
      required: true,
      trim: true,
    },
    memberName: {
      type: String,
      required: true,
      trim: true,
    },
    note: {
      type: String,
      default: '',
      trim: true,
    },
    handoffDone: {
      type: Boolean,
      default: false,
    },
    handoffDoneBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    handoffDoneAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const classReportSavedClassSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: true,
      trim: true,
    },
    classTime: {
      type: String,
      required: true,
      trim: true,
    },
    savedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    savedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const classReportSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      index: true,
    },
    period: {
      type: String,
      enum: ['morning', 'afternoon'],
      required: true,
    },
    instructorName: {
      type: String,
      required: true,
      trim: true,
    },
    instructorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    items: {
      type: [classReportItemSchema],
      default: [],
    },
    savedClasses: {
      type: [classReportSavedClassSchema],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

classReportSchema.index({ center: 1, date: 1, instructorName: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('ClassReport', classReportSchema);
