const mongoose = require('mongoose');

const centerWaitlistEntrySchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    tariffType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WaitlistTariffType',
      default: null,
    },
    tariffTypeLabel: {
      type: String,
      default: '',
      trim: true,
    },
    paidWaitlist: {
      type: Boolean,
      default: false,
    },
    signupDate: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

centerWaitlistEntrySchema.index({ center: 1, signupDate: -1, createdAt: -1 });

module.exports = mongoose.model('CenterWaitlistEntry', centerWaitlistEntrySchema);
