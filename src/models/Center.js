const mongoose = require('mongoose');

const centerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide center name'],
    },
    type: {
      type: String,
      enum: ['crossfit', 'funcional'],
      required: [true, 'Please provide center type'],
    },
    address: String,
    phone: String,
    email: String,
    aimharderKey: {
      type: String,
      trim: true,
      default: '',
    },
    active: {
      type: Boolean,
      default: true,
    },
    checklistTemplates: {
      opening: {
        type: [String],
        default: [
          'Fichar entrada',
          'Subir cierre delantero y trasero',
          'Encendido luminarias: Alumbrado Sala 1,2 y 3 + Enchufado Led mostrador',
          'Hilo Musical de fondo (Vol. medio-bajo)',
          'Revisión limpieza sala (Aspirado y fregado *si necesario*)',
          'Encender extracción vestuarios',
          'Encender aire',
        ],
      },
      closing: {
        type: [String],
        default: [
          'Ordenado sala (mancuernas, gomas, remos etc)',
          'Apagar altavoz',
          'Ordenar mostrador y recepción',
          'Apagar PC',
          'Revisión limpieza sala (Aspirado y fregado *si necesario*)',
          'Apagar aire',
          'Apagar extracción vestuarios',
          'Bajar cierres',
          'Conectar alarma',
          'Fichar Salida',
        ],
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Center', centerSchema);
