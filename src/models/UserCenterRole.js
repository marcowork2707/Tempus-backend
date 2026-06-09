const mongoose = require('mongoose');

const weeklyContractHoursHistorySchema = new mongoose.Schema(
  {
    effectiveMonth: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'effectiveMonth must be YYYY-MM'],
    },
    weeklyContractHours: {
      type: Number,
      min: [0, 'weeklyContractHours cannot be negative'],
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const userCenterRoleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    weeklyContractHours: {
      type: Number,
      min: [0, 'weeklyContractHours cannot be negative'],
      default: null,
    },
    weeklyContractHoursHistory: {
      type: [weeklyContractHoursHistorySchema],
      default: [],
    },
    // Saldo cacheado de la bolsa de horas extra (en minutos, con signo).
    // Positivo = el centro le debe horas al trabajador; negativo = el trabajador
    // las debe. Reconstruible desde las liquidaciones (OvertimeSettlement).
    overtimeBankMinutes: {
      type: Number,
      default: 0,
    },
    // Último mes liquidado (YYYY-MM). Marca hasta dónde llega el saldo cacheado
    // y fuerza que las liquidaciones se hagan en orden cronológico.
    overtimeBankUpdatedMonth: {
      type: String,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'overtimeBankUpdatedMonth must be YYYY-MM'],
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index
userCenterRoleSchema.index(
  { user: 1, center: 1, role: 1 },
  { unique: true }
);

module.exports = mongoose.model('UserCenterRole', userCenterRoleSchema);
