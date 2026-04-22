const ClassReview = require('../models/ClassReview');
const User = require('../models/User');
const Center = require('../models/Center');
const ErrorHandler = require('../utils/errorHandler');

// Definir los datos de revisión de clases
const REVIEW_TEMPLATE = [
  {
    title: "2' Rule",
    weight: 0.15,
    items: [
      'Intercepta al idoneo (nuevo, lesionado o menos integrado)',
      'No habla de sí mismo/a',
      'No critica a nadie',
      'Transmite buena impresión',
    ],
  },
  {
    title: 'Warm Up General + Movilidad',
    weight: 0.11,
    items: ['Atención activa: lanza correcciones', 'Creativo y dinámico', 'Pasa lista'],
  },
  {
    title: 'Bloque Específico',
    weight: 0.3,
    items: [
      'Warm Up específico',
      'Funcionario Cárceles',
      'Corrige sobre los objetivos que pide',
      'Utiliza el nombre de cada uno al menos 1 vez para dar feedback',
      'Corrige con sandwich',
      'Da opción B en caso de haberla',
    ],
  },
  {
    title: 'WOD',
    weight: 0.15,
    items: ['EFI', 'Está conectado con la clase', 'Recorre metros (no se queda parado)', 'Escala si es necesario', 'Correcciones'],
  },
  {
    title: 'Estirar + Vuelta a la calma',
    weight: 0.04,
    items: ['Da las gracias y aplaude'],
  },
  {
    title: '2\' Rule (Cierre)',
    weight: 0.04,
    items: [],
  },
  {
    title: 'Aspectos Generales',
    weight: 0.22,
    items: [
      'Presencia y actitud',
      'Manejo del Grupo',
      'Anticipación',
      'Lenguaje inclusivo',
      'Scalings adecuados',
      'Prioriza en correcciones',
      'Clase termina a tiempo',
      'Pizarra con tiempos y notas',
    ],
  },
];

/**
 * GET /api/class-reviews/:centerId
 * Obtener revisiones de un centro
 */
exports.getClassReviews = async (req, res) => {
  try {
    const { centerId } = req.params;
    const { workerId, month, year } = req.query;

    const filter = { center: centerId };
    if (workerId) filter.worker = workerId;
    if (month && year) {
      filter.month = parseInt(month);
      filter.year = parseInt(year);
    }

    const reviews = await ClassReview.find(filter)
      .populate('worker', 'firstName lastName email')
      .populate('reviewedBy', 'firstName lastName')
      .sort({ year: -1, month: -1, createdAt: -1 });

    res.status(200).json({ success: true, data: reviews });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/class-reviews/:centerId/:reviewId
 * Obtener una revisión específica
 */
exports.getClassReview = async (req, res) => {
  try {
    const { centerId, reviewId } = req.params;

    const review = await ClassReview.findOne({ _id: reviewId, center: centerId })
      .populate('worker', 'firstName lastName email')
      .populate('reviewedBy', 'firstName lastName');

    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    res.status(200).json({ success: true, data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/class-reviews/:centerId
 * Crear o actualizar una revisión
 */
exports.upsertClassReview = async (req, res) => {
  try {
    const { centerId } = req.params;
    const { workerId, month, year, sections, notes } = req.body;
    const userId = req.user._id;

    if (!workerId || !month || !year) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validar que el trabajador exista en el centro
    const worker = await User.findById(workerId);
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    // Calcular nota total
    let totalScore = 0;
    let validSections = 0;

    if (sections && Array.isArray(sections)) {
      sections.forEach((section) => {
        if (!section.items || section.items.length === 0) return;

        const ticks = section.items.filter((item) => item.tick === true).length;
        const crosses = section.items.filter((item) => item.tick === false).length;
        const total = ticks + crosses;

        if (total > 0) {
          const sectionScore = (ticks / total) * 10 * section.weight;
          totalScore += sectionScore;
          validSections += 1;
        }
      });
    }

    const review = await ClassReview.findOneAndUpdate(
      { center: centerId, worker: workerId, month, year },
      {
        sections,
        totalScore: Number(totalScore.toFixed(2)),
        notes,
        reviewedBy: userId,
        status: 'completed',
      },
      { upsert: true, new: true }
    )
      .populate('worker', 'firstName lastName email')
      .populate('reviewedBy', 'firstName lastName');

    res.status(200).json({ success: true, data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/class-reviews/:centerId/template
 * Obtener el template de revisión
 */
exports.getReviewTemplate = async (req, res) => {
  try {
    res.status(200).json({ success: true, data: REVIEW_TEMPLATE });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/class-reviews/:centerId/workers
 * Obtener trabajadores del centro
 */
exports.getCenterWorkers = async (req, res) => {
  try {
    const { centerId } = req.params;
    const UserCenterRole = require('../models/UserCenterRole');

    // Buscar todos los registros de UserCenterRole para este centro
    const userRoles = await UserCenterRole.find({ center: centerId, active: true })
      .populate('user', 'firstName lastName email _id')
      .populate('role', 'name');

    // Filtrar solo trainers/instructors y extraer usuarios únicos
    const trainerRoles = userRoles.filter(ur => {
      const roleName = ur.role?.name?.toLowerCase() || '';
      return roleName.includes('trainer') || roleName.includes('instructor') || roleName.includes('coach');
    });

    const workers = trainerRoles.map(ur => ({
      _id: ur.user._id,
      firstName: ur.user.firstName,
      lastName: ur.user.lastName,
      email: ur.user.email,
    }));

    // Eliminar duplicados por _id
    const uniqueWorkers = Array.from(
      new Map(workers.map(w => [w._id.toString(), w])).values()
    ).sort((a, b) => a.firstName.localeCompare(b.firstName));

    res.status(200).json({ success: true, data: uniqueWorkers });
  } catch (error) {
    console.error('Error fetching center workers:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/class-reviews/:centerId/:reviewId
 * Eliminar una revisión
 */
exports.deleteClassReview = async (req, res) => {
  try {
    const { centerId, reviewId } = req.params;

    const review = await ClassReview.findOneAndDelete({ _id: reviewId, center: centerId });

    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    res.status(200).json({ success: true, message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
