const mongoose = require('mongoose');

const classReportRosterInstructorSchema = new mongoose.Schema(
  {
    instructorName: {
      type: String,
      required: true,
      trim: true,
    },
    period: {
      type: String,
      enum: ['morning', 'afternoon'],
      required: true,
    },
  },
  { _id: false }
);

const classReportRosterSchema = new mongoose.Schema(
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
    instructors: {
      type: [classReportRosterInstructorSchema],
      default: [],
    },
    refreshedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

classReportRosterSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ClassReportRoster', classReportRosterSchema);
