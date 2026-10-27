const mongoose = require('mongoose');

// Bolsa de capacidad: tipo de clase con el que se venden las tarifas (CrossFit, Open, Iniciación…)
const centerClassPoolSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Subcadenas (sin mayúsculas ni acentos) que se buscan en el nombre de la clase de AimHarder
    patterns: { type: [String], default: [] },
    // Recoge las clases que no encajan en ninguna otra bolsa
    isDefault: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    // Complemento de las tarifas (p. ej. Open): no limita la capacidad ni cuenta en los totales del informe.
    // Sin definir se deduce del nombre (ver isComplementaryPool en capacityReportService).
    complementary: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CenterClassPool', centerClassPoolSchema);
