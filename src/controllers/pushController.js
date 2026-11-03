const PushSubscription = require('../models/PushSubscription');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const { getPublicKey, isPushConfigured, sendToUser } = require('../services/pushService');

exports.getPublicKey = catchAsyncErrors(async (req, res) => {
  const publicKey = getPublicKey();
  if (!publicKey) {
    return res.status(200).json({ success: true, configured: false });
  }
  res.status(200).json({ success: true, configured: true, publicKey });
});

exports.subscribe = catchAsyncErrors(async (req, res, next) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return next(new ErrorHandler('Suscripción push inválida', 400));
  }

  await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      user: req.user.id,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgent: req.headers['user-agent'] || undefined,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(200).json({ success: true });
});

exports.unsubscribe = catchAsyncErrors(async (req, res, next) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return next(new ErrorHandler('endpoint requerido', 400));
  }
  await PushSubscription.deleteOne({ endpoint, user: req.user.id });
  res.status(200).json({ success: true });
});

exports.sendTest = catchAsyncErrors(async (req, res, next) => {
  if (!isPushConfigured()) {
    return next(new ErrorHandler('Las notificaciones push no están configuradas', 503));
  }
  const sent = await sendToUser(req.user.id, {
    title: 'Tempus',
    body: 'Los avisos funcionan correctamente.',
    url: '/dashboard',
    tag: 'push-test',
  });
  res.status(200).json({ success: true, sent });
});
