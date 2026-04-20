const mongoose = require('mongoose');

const recurringExpenseConceptSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    concept: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    category: {
      type: String,
      trim: true,
      maxlength: 60,
      default: 'General',
    },
    expenseType: {
      type: String,
      enum: ['fixed', 'consumable', 'ads', 'investment', 'other'],
      default: 'fixed',
      index: true,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },
    paymentMethod: {
      type: String,
      trim: true,
      maxlength: 40,
      default: '',
    },
    supplier: {
      type: String,
      trim: true,
      maxlength: 100,
      default: '',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 400,
      default: '',
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

recurringExpenseConceptSchema.index({ center: 1, active: 1, concept: 1 });

module.exports = mongoose.model('RecurringExpenseConcept', recurringExpenseConceptSchema);
