const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let configured = false;

function configure() {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:marcowork2707@gmail.com',
    publicKey,
    privateKey
  );
  configured = true;
  return true;
}

function isPushConfigured() {
  try {
    return configure();
  } catch (error) {
    console.error('[Push] Configuración VAPID inválida:', error.message);
    return false;
  }
}

function getPublicKey() {
  return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

// Devuelve el número de dispositivos a los que se entregó el aviso
async function sendToUser(userId, { title, body, url, tag }) {
  if (!isPushConfigured()) return 0;
  const subscriptions = await PushSubscription.find({ user: userId });
  if (subscriptions.length === 0) return 0;

  const payload = JSON.stringify({ title, body, url, tag });
  let delivered = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
          },
          payload
        );
        delivered += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: subscription._id }).catch(() => {});
        } else {
          console.error('[Push] Error enviando aviso:', error.statusCode || '', error.message);
        }
      }
    })
  );

  return delivered;
}

module.exports = { isPushConfigured, getPublicKey, sendToUser };
