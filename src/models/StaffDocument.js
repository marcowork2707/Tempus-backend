const mongoose = require('mongoose');

// Documentos (PDF, DOCX, TXT) adjuntos a un trabajador dentro de un centro.
// Railway tiene filesystem efimero y no usamos bucket externo, asi que el
// contenido binario se guarda en MongoDB (limite de 10 MB por archivo, muy por
// debajo de los 16 MB de un documento BSON).
const staffDocumentSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    originalName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    // select:false para que los listados no arrastren el binario.
    data: { type: Buffer, required: true, select: false },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

staffDocumentSchema.index({ center: 1, user: 1, createdAt: -1 });

module.exports = mongoose.model('StaffDocument', staffDocumentSchema);
