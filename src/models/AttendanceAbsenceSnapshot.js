const mongoose = require('mongoose');

const attendanceAbsenceItemSchema = new mongoose.Schema(
  {
    memberName: { type: String, required: true, trim: true },
    classTime: { type: String, default: '', trim: true },
    className: { type: String, default: '', trim: true },
    date: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    activeMembership: { type: String, default: '', trim: true },
    membershipStartDate: { type: String, default: '', trim: true },
    joinDate: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const attendanceAbsenceSnapshotSchema = new mongoose.Schema(
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
    absences: {
      type: [attendanceAbsenceItemSchema],
      default: [],
    },
    refreshedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

attendanceAbsenceSnapshotSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceAbsenceSnapshot', attendanceAbsenceSnapshotSchema);
