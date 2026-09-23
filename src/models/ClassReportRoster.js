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
    className: {
      type: String,
      trim: true,
      default: '',
    },
    classTime: {
      type: String,
      trim: true,
      default: '',
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
    // true solo si el scrapeo demostró que el horario mostraba ESE día. Un
    // roster sin verificar puede contener las clases de otro día (era el caso
    // de los días pasados) y no debe enseñarse como si fuera real.
    verified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

classReportRosterSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ClassReportRoster', classReportRosterSchema);
