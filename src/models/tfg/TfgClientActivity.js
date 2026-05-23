const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// TfgClientActivity — actividad individual de un cliente para la vista detalle
//
// Decisión arquitectónica (ver reports/06_integracion.md §6.9):
// El batch score_batch.py escribe un documento por cliente con los últimos
// 365 días de asistencias, no-shows, pagos y cambios de tarifa. Esto evita
// que el backend Node tenga que leer parquets directamente y mantiene el
// contrato Python → Mongo → Node intacto.
// Tamaño estimado: < 50 KB por documento (365 días × eventos diarios).
// ---------------------------------------------------------------------------

const attendanceItemSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },       // YYYY-MM-DD
    count: { type: Number, default: 1 },
    classTypes: [{ type: String }],
  },
  { _id: false }
);

const noShowItemSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },       // YYYY-MM-DD
    classType: { type: String, default: '' },
    time: { type: String, default: '' },          // HH:MM
  },
  { _id: false }
);

const paymentItemSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },       // YYYY-MM-DD
    amount: { type: Number, default: 0 },
    tarifa: { type: String, default: '' },
    concepto: { type: String, default: '' },
  },
  { _id: false }
);

const tarifaChangeItemSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },       // YYYY-MM-DD
    from: { type: String, default: '' },
    to: { type: String, default: '' },
  },
  { _id: false }
);

const tfgClientActivitySchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    clientHash: { type: String, required: true, index: true },
    cutoffDate: { type: Date, required: true },
    attendances: [attendanceItemSchema],
    noShows: [noShowItemSchema],
    payments: [paymentItemSchema],
    tarifaChanges: [tarifaChangeItemSchema],
  },
  { timestamps: true, collection: 'tfgclientactivity' }
);

tfgClientActivitySchema.index({ center: 1, clientHash: 1 }, { unique: true });

module.exports = mongoose.model('TfgClientActivity', tfgClientActivitySchema);
