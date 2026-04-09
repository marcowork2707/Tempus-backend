const mongoose = require('mongoose');

const centerOccupancyClassSchema = new mongoose.Schema(
  {
    className: { type: String, default: '', trim: true },
    classTime: { type: String, default: '', trim: true },
    instructorName: { type: String, default: '', trim: true },
    roomName: { type: String, default: '', trim: true },
    bookedCount: { type: Number, default: 0, min: 0 },
    attendanceCount: { type: Number, default: 0, min: 0 },
    noShowCount: { type: Number, default: 0, min: 0 },
    waitlistCount: { type: Number, default: 0, min: 0 },
    waitlistMembers: { type: [String], default: [] },
    capacity: { type: Number, default: 0, min: 0 },
    occupancyRate: { type: Number, default: 0, min: 0 },
    attendanceRate: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const centerOccupancySnapshotSchema = new mongoose.Schema(
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
    classes: {
      type: [centerOccupancyClassSchema],
      default: [],
    },
    refreshedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

centerOccupancySnapshotSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CenterOccupancySnapshot', centerOccupancySnapshotSchema);
