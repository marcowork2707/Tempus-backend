const mongoose = require('mongoose');

const classReviewItemSchema = new mongoose.Schema({
  name: String,
  tick: Boolean, // true = tick, false = cross, null = no marcado
  comment: String,
});

const classReviewSectionSchema = new mongoose.Schema({
  title: String,
  weight: Number, // porcentaje (0.15, 0.11, 0.30, etc)
  items: [classReviewItemSchema],
});

const classReviewSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: [true, 'Center is required'],
    },
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Worker is required'],
    },
    month: {
      type: Number,
      required: [true, 'Month is required'],
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: [true, 'Year is required'],
    },
    sections: [classReviewSectionSchema],
    totalScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 10,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
    status: {
      type: String,
      enum: ['draft', 'completed'],
      default: 'draft',
    },
  },
  { timestamps: true }
);

// Índice para evitar duplicados
classReviewSchema.index({ center: 1, worker: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('ClassReview', classReviewSchema);
