const ClassReview = require('../models/ClassReview');
const User = require('../models/User');
const Center = require('../models/Center');
const UserCenterRole = require('../models/UserCenterRole');
const ClassReviewTemplate = require('../models/ClassReviewTemplate');
const CenterKpiObjectives = require('../models/CenterKpiObjectives');

function getCenterIdFromParams(params = {}) {
  return params.centerId || params.id;
}

const DEFAULT_REVIEW_TEMPLATE = [
  {
    title: "2' Rule",
    items: [
      'Intercepta al idoneo (nuevo, lesionado o menos integrado)',
      'No habla de sí mismo/a',
      'No critica a nadie',
      'Transmite buena impresión',
    ],
  },
  {
    title: 'Warm Up General + Movilidad',
    items: ['Atención activa: lanza correcciones', 'Creativo y dinámico', 'Pasa lista'],
  },
  {
    title: 'Bloque Específico',
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
    items: ['EFI', 'Está conectado con la clase', 'Recorre metros (no se queda parado)', 'Escala si es necesario', 'Correcciones'],
  },
  {
    title: 'Estirar + Vuelta a la calma',
    items: ['Da las gracias y aplaude'],
  },
  {
    title: "2' Rule (Cierre)",
    items: [],
  },
  {
    title: 'Aspectos Generales',
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

function sanitizeTemplateSections(sections = []) {
  if (!Array.isArray(sections)) return [];

  return sections
    .map((section) => {
      const title = String(section?.title || '').trim();
      const items = Array.isArray(section?.items)
        ? section.items
            .map((item) => String(item || '').trim())
            .filter(Boolean)
        : [];

      return { title, items };
    })
    .filter((section) => section.title);
}

function applyDynamicWeights(sections = []) {
  const totalItems = sections.reduce(
    (sum, section) => sum + (Array.isArray(section.items) ? section.items.length : 0),
    0
  );

  return sections.map((section) => ({
    title: section.title,
    weight: totalItems > 0 ? (Array.isArray(section.items) ? section.items.length : 0) / totalItems : 0,
    items: Array.isArray(section.items) ? section.items : [],
  }));
}

async function getTemplateSectionsForCenter(centerId) {
  const templateDoc = await ClassReviewTemplate.findOne({ center: centerId }).lean();
  if (!templateDoc?.sections?.length) {
    return sanitizeTemplateSections(DEFAULT_REVIEW_TEMPLATE);
  }
  return sanitizeTemplateSections(templateDoc.sections);
}

exports.getClassReviews = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    const { workerId, month, year } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const filter = { center: centerId };
    if (workerId) filter.worker = workerId;
    if (month && year) {
      filter.month = parseInt(month, 10);
      filter.year = parseInt(year, 10);
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

exports.getClassReview = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    const { reviewId } = req.params;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

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

exports.upsertClassReview = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    const { workerId, month, year, sections, notes } = req.body;
    const userId = req.user?.id;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    if (!workerId || !month || !year) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const worker = await User.findById(workerId);
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const incomingSections = Array.isArray(sections) ? sections : [];
    const weightedSections = applyDynamicWeights(
      incomingSections.map((section) => ({
        title: String(section?.title || ''),
        items: Array.isArray(section?.items) ? section.items : [],
      }))
    );

    let totalScore = 0;
    weightedSections.forEach((section) => {
      if (!section.items || section.items.length === 0) return;
      const ticks = section.items.filter((item) => item.tick === true).length;
      const crosses = section.items.filter((item) => item.tick === false).length;
      const answered = ticks + crosses;
      if (answered > 0) {
        totalScore += (ticks / answered) * 10 * section.weight;
      }
    });

    const review = await ClassReview.findOneAndUpdate(
      { center: centerId, worker: workerId, month, year },
      {
        sections: weightedSections,
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

exports.getReviewTemplate = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const sections = await getTemplateSectionsForCenter(centerId);
    const weightedTemplate = applyDynamicWeights(sections);

    res.status(200).json({ success: true, data: weightedTemplate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.upsertReviewTemplate = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const sections = sanitizeTemplateSections(req.body?.sections || []);
    if (!sections.length) {
      return res.status(400).json({ success: false, message: 'La plantilla debe tener al menos un titulo' });
    }

    const centerExists = await Center.findById(centerId).select('_id');
    if (!centerExists) {
      return res.status(404).json({ success: false, message: 'Center not found' });
    }

    const updated = await ClassReviewTemplate.findOneAndUpdate(
      { center: centerId },
      {
        sections,
        updatedBy: req.user?.id || null,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    res.status(200).json({
      success: true,
      data: applyDynamicWeights(updated.sections || []),
      message: 'Plantilla de revision guardada',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCenterWorkers = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const assignments = await UserCenterRole.find({
      center: centerId,
      active: true,
    })
      .populate('user', 'name email firstName lastName _id')
      .populate('role', 'name');

    const workersMap = new Map();
    assignments.forEach((assignment) => {
      if (assignment?.role?.name !== 'coach') {
        return;
      }
      if (assignment.user && assignment.user._id) {
        const userId = assignment.user._id.toString();
        if (!workersMap.has(userId)) {
          const fullName = assignment.user.name || `${assignment.user.firstName || ''} ${assignment.user.lastName || ''}`.trim();
          workersMap.set(userId, {
            _id: assignment.user._id,
            firstName: assignment.user.firstName || '',
            lastName: assignment.user.lastName || '',
            email: assignment.user.email,
            name: fullName,
          });
        }
      }
    });

    const workers = Array.from(workersMap.values()).sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );

    res.status(200).json({ success: true, data: workers });
  } catch (error) {
    console.error('Error fetching center workers:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteClassReview = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    const { reviewId } = req.params;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const review = await ClassReview.findOneAndDelete({ _id: reviewId, center: centerId });

    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    res.status(200).json({ success: true, message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getClassReviewMonthSummary = async (req, res) => {
  try {
    const centerId = getCenterIdFromParams(req.params);
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'Center ID is required' });
    }

    const { month } = req.query; // expected format: YYYY-MM
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ success: false, message: 'month must be in format YYYY-MM' });
    }

    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10); // 1-12
    const monthIndex = monthNum - 1; // 0-based for monthly array

    // Get objetivo from CenterKpiObjectives
    let objetivo = null;
    const kpiDoc = await CenterKpiObjectives.findOne({ center: centerId, year });
    if (kpiDoc) {
      const kpiEntry = kpiDoc.objectives.find((o) => o.key === 'nota_revision_clases');
      if (kpiEntry && Array.isArray(kpiEntry.monthly) && kpiEntry.monthly[monthIndex] != null) {
        objetivo = kpiEntry.monthly[monthIndex];
      }
    }

    // Get all class reviews for this center+month+year
    const reviews = await ClassReview.find({ center: centerId, month: monthNum, year })
      .populate('worker', 'name firstName lastName')
      .select('totalScore worker');

    const coachCount = reviews.length;
    let resultado = null;
    const coaches = [];

    if (coachCount > 0) {
      let totalScore = 0;
      for (const review of reviews) {
        const score = Number(review.totalScore) || 0;
        totalScore += score;
        const workerName = review.worker
          ? review.worker.name || `${review.worker.firstName || ''} ${review.worker.lastName || ''}`.trim()
          : 'Desconocido';
        coaches.push({ name: workerName, score: Number(score.toFixed(2)) });
      }
      resultado = Number((totalScore / coachCount).toFixed(2));
    }

    res.status(200).json({
      success: true,
      month,
      objetivo,
      resultado,
      coachCount,
      coaches,
    });
  } catch (error) {
    console.error('Error fetching class review month summary:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
