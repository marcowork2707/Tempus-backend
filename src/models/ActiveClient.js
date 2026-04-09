const mongoose = require('mongoose');

const activeClientSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    aimharderId: {
      type: String,
      trim: true,
      default: '',
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      trim: true,
      default: '',
    },
    locality: {
      type: String,
      trim: true,
      default: '',
    },
    activeMembership: {
      type: String,
      trim: true,
      default: '',
    },
    membershipStartDate: {
      type: String,
      trim: true,
      default: '',
    },
    joinDate: {
      type: String,
      trim: true,
      default: '',
    },
    reportDate: {
      type: String,
      required: true,
      index: true,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

activeClientSchema.index({ center: 1, reportDate: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('ActiveClient', activeClientSchema);
