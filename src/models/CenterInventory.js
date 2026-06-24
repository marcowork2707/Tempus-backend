const mongoose = require('mongoose');

// Inventario mensual de un centro: un documento autocontenido por (centro, mes)
// con la estructura de grupos → artículos → cantidad. Mirroriza el patrón
// mensual de PayrollEntry/AimHarderClientMonthlySnapshot para poder ver el
// histórico mes a mes. La estructura (grupos/artículos) solo la editan
// encargado/admin; las cantidades las puede actualizar cualquier rol del centro.
const inventoryArticleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, trim: true, maxlength: 30, default: '' },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: true }
);

const inventoryGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    articles: { type: [inventoryArticleSchema], default: [] },
  },
  { _id: true }
);

const centerInventorySchema = new mongoose.Schema(
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
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'],
      index: true,
    },
    groups: {
      type: [inventoryGroupSchema],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// Un inventario por centro y mes.
centerInventorySchema.index({ center: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('CenterInventory', centerInventorySchema);
