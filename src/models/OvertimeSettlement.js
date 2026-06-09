const mongoose = require('mongoose');

// Liquidación mensual de la "bolsa de horas extra" de un trabajador.
// Cada documento es un snapshot inmutable del cierre de un mes: toma el neto
// real de horas extra calculado desde los fichajes y registra qué decidió el
// admin (pagar vs guardar en bolsa). El saldo acumulado vive cacheado en
// UserCenterRole.overtimeBankMinutes y es reconstruible sumando estas liquidaciones.
const overtimeSettlementSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    // Neto real del mes con signo (= totalDeltaMinutes del resumen), snapshot al liquidar.
    generatedMinutes: {
      type: Number,
      required: true,
    },
    // Saldo de la bolsa antes de aplicar este mes.
    balanceBeforeMinutes: {
      type: Number,
      required: true,
    },
    // Cuánto del positivo generado limpió deuda previa (solo informativo).
    amortizedMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Horas que el admin decidió pagar (salen de la bolsa).
    paidMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Aporte neto a la bolsa este mes (= generatedMinutes - paidMinutes), con signo.
    bankedMinutes: {
      type: Number,
      default: 0,
    },
    // Saldo resultante tras la liquidación (= before + generated - paid).
    balanceAfterMinutes: {
      type: Number,
      required: true,
    },
    decision: {
      type: String,
      enum: ['banked', 'paid', 'mixed', 'debt'],
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// Una liquidación por trabajador, centro y mes.
overtimeSettlementSchema.index({ center: 1, user: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('OvertimeSettlement', overtimeSettlementSchema);
