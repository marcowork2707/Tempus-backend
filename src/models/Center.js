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
      dailyTaskKeys: {
        type: [String],
        default: [
          'fitohub',
          'absences',
          'occupancy',
          'class-notes',
          'class-report',
          'wod-recommendations',
          'whatsapp-reviews',
          'tpv-redsys',
          'pending-payments-no-tpv',
          'generate-payments',
          'weekly-planning',
          'stock-control',
        ],
      },
      cleaningTasks: {
        type: [
          {
            key: { type: String, required: true },
            label: { type: String, required: true },
            daysOfWeek: {
              type: [Number],
              default: [],
            },
          },
        ],
        default: [
          {
            key: 'limpieza-vestuarios',
            label: 'Limpieza vestuarios',
            daysOfWeek: [1, 3, 5],
          },
          {
            key: 'limpieza-caucho',
            label: 'Limpieza caucho',
            daysOfWeek: [2, 4],
          },
          {
            key: 'limpieza-accesorios',
            label: 'Limpieza accesorios',
            daysOfWeek: [6],
          },
        ],
      },
      generalCleaningTasks: {
        type: [
          {
            key: { type: String, required: true },
            label: { type: String, required: true },
            daysOfWeek: {
              type: [Number],
              default: [],
            },
          },
        ],
        default: [],
      },
    },
    overtimeSettings: {
      monthlyAggregationMode: {
        type: String,
        enum: ['net', 'positive_only'],
        default: 'positive_only',
      },
    },
    expenseCategories: {
      type: [String],
      default: ['General', 'Fijos', 'Consumible', 'Publicidad', 'Inversión', 'Otros'],
    },
    expenseTypes: {
      type: [String],
      default: ['Gasto fijo', 'Consumibles', 'Anuncios', 'Inversion', 'Impuestos', 'Sueldos', 'Otros'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Center', centerSchema);
