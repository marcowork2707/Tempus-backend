const mongoose = require('mongoose');

const reviewItemSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'ok', 'fail'],
      default: 'pending',
    },
    comment: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1200,
    },
    value: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

reviewItemSchema.add({
  subItems: {
    type: [reviewItemSchema],
    default: [],
  },
});

const reviewSectionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    items: {
      type: [reviewItemSchema],
      default: [],
    },
  },
  { _id: false }
);

const centerDashboardReviewSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    sections: {
      type: [reviewSectionSchema],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

centerDashboardReviewSchema.index({ center: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('CenterDashboardReview', centerDashboardReviewSchema);
