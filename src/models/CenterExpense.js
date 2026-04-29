const mongoose = require('mongoose');

const centerExpenseSchema = new mongoose.Schema(
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
      match: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
      index: true,
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    concept: {
      type: String,
      required: true,
      trim: true,
      maxlength: 400,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
      default: 'General',
    },
    expenseType: {
      type: String,
      trim: true,
      default: 'Otros',
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
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
    recurringConcept: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecurringExpenseConcept',
      default: null,
      index: true,
    },
    entryType: {
      type: String,
      enum: ['expense', 'income'],
      default: 'expense',
      index: true,
    },
    incomeCategory: {
      type: String,
      trim: true,
      maxlength: 80,
      default: '',
    },
    incomeItem: {
      type: String,
      trim: true,
      maxlength: 100,
      default: '',
    },
    checked: {
      type: Boolean,
      default: false,
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

centerExpenseSchema.index({ center: 1, month: 1, date: 1 });
centerExpenseSchema.index({ center: 1, month: 1, recurringConcept: 1 });

module.exports = mongoose.model('CenterExpense', centerExpenseSchema);
