const WeeklyPlanning = require('../models/WeeklyPlanning');
const AppSetting = require('../models/AppSetting');

const WHATSAPP_GROUP_BY_CENTER_TYPE = {
  funcional: 'https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t',
  crossfit: 'https://chat.whatsapp.com/Hd7Id89rznmAu26mojLwUT?mode=gi_t',
};

function parseIsoDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function weekLabelEs(weekStart) {
  const start = parseIsoDate(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startLabel = start.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  const endLabel = end.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  return `${startLabel} - ${endLabel}`;
}

function buildPlanningMessage(weekStart, template) {
  const fallback = `Hola Equipo!\nAquí os dejamos la planificación de la semana {semana}.\nPasad buen domingo!`;
  const baseTemplate = template || fallback;
  return baseTemplate.replace(/\{semana\}/gi, weekLabelEs(weekStart));
}

async function resolveWeeklyPlanningMessage(centerType) {
  const specific = await AppSetting.findOne({
    key: 'weekly_planning_whatsapp_message',
    centerType: centerType || null,
  });
  if (specific?.value) return specific.value;

  const global = await AppSetting.findOne({
    key: 'weekly_planning_whatsapp_message',
    centerType: null,
  });
  return global?.value || '';
}

async function postDispatchWebhook(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Webhook dispatch failed: ${response.status} ${bodyText}`);
  }
}

async function dispatchPendingWeeklyPlannings(now = new Date()) {
  const webhookUrl = process.env.WEEKLY_PLANNING_DISPATCH_WEBHOOK_URL;
  if (!webhookUrl) {
    return { processed: 0, sent: 0, failed: 0, skipped: true };
  }

  const pending = await WeeklyPlanning.find({
    sentAt: null,
    scheduledFor: { $lte: now },
  }).populate('center', 'name type active');

  if (!pending.length) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const planning of pending) {
    planning.sendAttempts = Number(planning.sendAttempts || 0) + 1;

    try {
      const center = planning.center;
      if (!center || center.active === false) {
        throw new Error('Center missing or inactive');
      }

      const centerType = center.type || 'funcional';
      const groupUrl = WHATSAPP_GROUP_BY_CENTER_TYPE[centerType] || WHATSAPP_GROUP_BY_CENTER_TYPE.funcional;
      const customTemplate = await resolveWeeklyPlanningMessage(centerType);
      const message = buildPlanningMessage(planning.weekStart, customTemplate);

      await postDispatchWebhook(webhookUrl, {
        event: 'weekly_planning_dispatch',
        centerId: center._id.toString(),
        centerName: center.name,
        centerType,
        groupUrl,
        weekStart: planning.weekStart,
        weekEnd: planning.weekEnd,
        message,
        imageDataUrl: planning.imageDataUrl,
        imageMimeType: planning.imageMimeType,
        planningId: planning._id.toString(),
      });

      planning.sentAt = new Date();
      planning.lastSendError = '';
      sent += 1;
    } catch (error) {
      planning.lastSendError = error.message || 'Unknown dispatch error';
      failed += 1;
    }

    await planning.save();
  }

  return { processed: pending.length, sent, failed };
}

module.exports = {
  dispatchPendingWeeklyPlannings,
  buildPlanningMessage,
};
