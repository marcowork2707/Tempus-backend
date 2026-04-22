const mongoose = require('mongoose');

const classReviewTemplateSectionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    items: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  { _id: false }
);

const classReviewTemplateSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: [true, 'Center is required'],
      unique: true,
    },
    sections: [classReviewTemplateSectionSchema],
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClassReviewTemplate', classReviewTemplateSchema);
