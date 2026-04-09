const mongoose = require('mongoose');

const aimHarderIntegrationSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      unique: true,
      index: true,
    },
    key: {
      type: String,
      trim: true,
      default: '',
    },
    baseUrl: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    username: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    password: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    accessToken: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    refreshToken: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    lastTokenRefreshAt: {
      type: Date,
      default: null,
      select: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AimHarderIntegration', aimHarderIntegrationSchema);
