require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/db');
const errorMiddleware = require('./src/middleware/error');
const Center = require('./src/models/Center');

// Routes
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const centerRoutes = require('./src/routes/centerRoutes');
const {
  syncActiveClients,
  refreshAndStoreOccupancy,
  getYesterday,
  toDateString,
  seedAimHarderIntegrationsFromEnv,
} = require('./src/services/aimharderService');
const { dispatchPendingWeeklyPlannings } = require('./src/services/weeklyPlanningService');

// Connect to database
connectDB();

const app = express();

// Middleware
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);

// Health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/centers', centerRoutes);
app.use('/api/checklists', require('./src/routes/checklistRoutes'));
app.use('/api/time-entries', require('./src/routes/timeEntryRoutes'));
app.use('/api/aimharder', require('./src/routes/aimharderRoutes'));
app.use('/api/settings', require('./src/routes/settingsRoutes'));
app.use('/api/stock', require('./src/routes/stockRoutes'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Error handling middleware (must be last)
app.use(errorMiddleware);

async function getSyncDay(key) {
  try {
    const AppSetting = require('./src/models/AppSetting');
    const doc = await AppSetting.findOne({ key }).lean();
    return doc ? doc.value : null;
  } catch (_) {
    return null;
  }
}

async function setSyncDay(key, value) {
  try {
    const AppSetting = require('./src/models/AppSetting');
    await AppSetting.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
  } catch (_) {}
}

function getMadridClockParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    todayKey: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

async function maybeRunDailyAimharderSync() {
  const { hour, todayKey } = getMadridClockParts();

  // Run once per day after 08:00 (Europe/Madrid), including catch-up after restarts.
  if (hour < 8) return;
  const lastSyncDayAh = await getSyncDay('aimharder_sync_day');
  if (lastSyncDayAh === todayKey) return;

  try {
    console.log('[AimHarder Scheduler] Lanzando sincronización diaria de clientes activos...');
    const centers = await Center.find({ active: true }).select('_id name');
    for (const center of centers) {
      try {
        await syncActiveClients(todayKey, center._id.toString());
      } catch (error) {
        console.warn(`[AimHarder Scheduler] Se omite ${center.name}: ${error.message}`);
      }
    }
    await setSyncDay('aimharder_sync_day', todayKey);
    console.log('[AimHarder Scheduler] Sincronización diaria completada');
  } catch (error) {
    console.error('[AimHarder Scheduler] Error en sincronización diaria:', error.message);
  }
}

async function maybeRunDailyOccupancySync() {
  const { hour, minute, todayKey } = getMadridClockParts();

  // Run once per day from 08:05 onward (Europe/Madrid), including catch-up after restarts.
  const afterScheduledTime = hour > 8 || (hour === 8 && minute >= 5);
  if (!afterScheduledTime) return;
  const lastSyncDayOcc = await getSyncDay('aimharder_occupancy_day');
  if (lastSyncDayOcc === todayKey) return;

  try {
    const targetDate = toDateString(getYesterday());
    console.log(`[AimHarder Scheduler] Guardando ocupación automática para ${targetDate}...`);
    const centers = await Center.find({ active: true }).select('_id name');
    for (const center of centers) {
      try {
        await refreshAndStoreOccupancy(targetDate, center._id.toString());
      } catch (error) {
        console.warn(`[AimHarder Scheduler] Se omite ocupación de ${center.name}: ${error.message}`);
      }
    }
    lastOccupancySyncDay = todayKey;
    await setSyncDay('aimharder_occupancy_day', todayKey);
    console.log('[AimHarder Scheduler] Ocupación automática completada');
  } catch (error) {
    console.error('[AimHarder Scheduler] Error en ocupación automática:', error.message);
  }
}

async function maybeRunWeeklyPlanningDispatch() {
  try {
    const result = await dispatchPendingWeeklyPlannings(new Date());
    if (result.processed === 0) return;
    console.log(`[Weekly Planning Scheduler] Procesadas: ${result.processed}, enviadas: ${result.sent}, fallidas: ${result.failed}`);
  } catch (error) {
    console.error('[Weekly Planning Scheduler] Error en envío automático:', error.message);
  }
}

setInterval(() => {
  maybeRunDailyAimharderSync().catch((error) => {
    console.error('[AimHarder Scheduler] Error inesperado:', error.message);
  });
  maybeRunDailyOccupancySync().catch((error) => {
    console.error('[AimHarder Scheduler] Error inesperado en ocupación:', error.message);
  });
  maybeRunWeeklyPlanningDispatch().catch((error) => {
    console.error('[Weekly Planning Scheduler] Error inesperado:', error.message);
  });
}, 60 * 1000);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  seedAimHarderIntegrationsFromEnv().catch((error) => {
    console.error('[AimHarder Seed] Error al sembrar integraciones:', error.message);
  });
  maybeRunDailyAimharderSync().catch((error) => {
    console.error('[AimHarder Scheduler] Error al arrancar:', error.message);
  });
  maybeRunDailyOccupancySync().catch((error) => {
    console.error('[AimHarder Scheduler] Error de ocupación al arrancar:', error.message);
  });
  maybeRunWeeklyPlanningDispatch().catch((error) => {
    console.error('[Weekly Planning Scheduler] Error al arrancar:', error.message);
  });
});
