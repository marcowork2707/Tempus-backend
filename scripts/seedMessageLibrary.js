/**
 * Carga (idempotente) la biblioteca de mensajes de WhatsApp para ambos centros.
 * Solo escribe en MessageCategory / MessageTemplate — no toca ninguna otra colección.
 * Ejecutar desde tempus-backend/: node scripts/seedMessageLibrary.js
 */
require('dotenv').config();
const connectDB = require('../src/config/db');
const MessageCategory = require('../src/models/MessageCategory');
const MessageTemplate = require('../src/models/MessageTemplate');

async function upsertCategory({ centerType, funnelStage, name, order }) {
  return MessageCategory.findOneAndUpdate(
    { centerType, funnelStage, name },
    { centerType, funnelStage, name, order },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function upsertTemplate(categoryId, { title, body, branch, order }) {
  return MessageTemplate.findOneAndUpdate(
    { category: categoryId, title },
    { category: categoryId, title, body, branch, order },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function loadGroup(categoryDef, templates) {
  const category = await upsertCategory(categoryDef);
  for (const t of templates) {
    await upsertTemplate(category._id, t);
  }
  console.log(`✓ [${categoryDef.centerType}] ${categoryDef.name} — ${templates.length} plantilla(s)`);
}

async function run() {
  await connectDB();

  // ============================================================
  // TEMPUS FUNCIONAL (centerType: 'funcional')
  // ============================================================

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'apertura', name: 'Apertura', order: 1 },
    [
      {
        title: 'Apertura',
        order: 1,
        body: `Hola 👋 Soy Diego, de Tempus Functional Fitness.

¡Gracias por escribir y por interesarte en el centro! 💪

Antes de contarte todo, prefiero conocerte un poco para orientarte bien — tenemos varios formatos y quiero recomendarte el que de verdad encaja contigo, no mandarte información genérica.

Cuéntame en un par de líneas:

1️⃣ ¿Qué edad tienes?
2️⃣ ¿Cuál es tu objetivo principal? (ponerte en forma, ganar fuerza, recuperarte de algo, perder peso, mantenerte activo…)
3️⃣ ¿Entrenas actualmente o lo has hecho antes?
4️⃣ ¿Alguna lesión o limitación que debamos tener en cuenta?

Con esto te digo exactamente qué clase encaja contigo 😊

¡Te leo!`,
      },
      {
        title: 'Reconocimiento directo',
        order: 2,
        body: `¡Hola! 👋 Soy Diego, de Tempus Functional Fitness. Gracias por escribir.

Por lo que cuentas, creo que sé exactamente qué te interesa — dame un segundo y te lo explico bien 😊`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'clasificacion', name: 'Casos límite (desempate)', order: 2 },
    [
      {
        title: 'Desempate — 65+ que entrena fuerte',
        order: 1,
        body: `Genial. Para orientarte mejor: ¿prefieres un grupo pensado específicamente para tu franja de edad, con ritmo adaptado, o encajarías mejor en nuestras clases funcionales estándar? Las dos están abiertas para ti.`,
      },
      {
        title: 'Desempate — ¿PT o Funcional?',
        order: 2,
        body: `Entendido, gracias por contármelo. Con eso en mente: ¿prefieres empezar en grupo reducido con seguimiento cercano del entrenador, o crees que en tu caso lo ideal sería un entrenamiento diseñado 100% a tu medida, en grupo de máximo 4 personas?`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Rama Funcional / Hybrid / Stretching', order: 3 },
    [
      {
        title: 'Encaje',
        branch: 'funcional',
        order: 1,
        body: `¡Genial, gracias por contarme! 🙌

Por lo que me dices, encajas perfectamente en nuestras clases funcionales: son grupos reducidos (máximo 14 personas), siempre guiadas por un entrenador, y el ejercicio se adapta a tu nivel dentro de la propia clase — no necesitas tener experiencia previa.

Te dejo un vídeo cortito donde te explico cómo funcionan y qué diferencia hay entre nuestras tres modalidades 👇`,
      },
      {
        title: 'Resumen',
        branch: 'funcional',
        order: 2,
        body: `En resumen 👇

Somos un centro de entrenamiento funcional pensado para personas que quieren empezar a moverse, retomar el deporte o mejorar su forma física con clases siempre guiadas por un entrenador y adaptadas a tu nivel.

Tenemos tres tipos de clase, con la misma tarifa — puedes combinarlas libremente según lo que te apetezca cada día:

🟢 Tempus Funcional → fuerza, movilidad y cardio.
🔵 Tempus Hybrid → un punto más dinámico e intenso.
🟣 Tempus Stretching → movilidad, flexibilidad y bienestar.

Grupos reducidos (máx. 14 personas) para que el entrenador pueda corregirte y adaptarte los ejercicios de verdad, no solo "poner música y contar repeticiones".

Te paso el horario y las tarifas 👇`,
      },
      {
        title: 'Recomendación de tarifa',
        branch: 'funcional',
        order: 3,
        body: `Con lo que me has contado, yo te recomendaría empezar con el {Iron / Silver}, que te da {9 / 12} clases al mes — es la frecuencia con la que la mayoría de gente nota cambios reales sin que se haga cuesta arriba a nivel de agenda.

Si prefieres empezar más suave y ver cómo te encuentras, el Starter (6 clases) también es una opción totalmente válida — no hay compromiso de permanencia, puedes cambiar de tarifa cuando quieras.

¿Qué te encaja mejor?`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Rama Tempus +65', order: 4 },
    [
      {
        title: 'Encaje',
        branch: '+65',
        order: 1,
        body: `¡Muchas gracias por contarme! 🙌

Tenemos una clase pensada específicamente para tu franja de edad: Tempus +65. No es una clase funcional "a la que también van mayores" — está diseñada desde cero para vosotros: los ejercicios, la intensidad, las cargas y el ritmo se adaptan por completo, y los grupos son de máximo 8 personas, así que la atención del entrenador es muy cercana.

Te dejo un vídeo corto donde te lo explico bien 👇`,
      },
      {
        title: 'Resumen',
        branch: '+65',
        order: 2,
        body: `En resumen 👇

Tempus +65 es nuestra clase funcional adaptada por completo a personas mayores de 65 años: mismo espíritu de entrenamiento guiado, pero pensada al detalle para tu momento físico — trabajamos fuerza, movilidad y equilibrio con cargas y ritmo seguros.

Grupos de máximo 8 personas, para que el entrenador pueda estar pendiente de cada uno de verdad — cómo te mueves, cómo respondes, si algo hay que ajustar ese mismo día.

No necesitas experiencia previa ni estar "en forma" para empezar. Es justo al revés: la clase está para ayudarte a llegar ahí de forma segura.

Te paso el horario y la tarifa 👇`,
      },
      {
        title: 'Recomendación',
        branch: '+65',
        order: 3,
        body: `Tempus +65 tiene una única tarifa: 69,90€ al mes, con clase los martes y jueves — puedes elegir el turno de las 10:15 o el de las 11:15, el que mejor encaje con tu rutina.

La mayoría de quienes empiezan notan la diferencia sobre todo en el día a día: subir escaleras, levantarse del sofá, caminar más tiempo sin cansarse. No hace falta más que estas dos clases semanales para notarlo.

¿Qué turno te viene mejor: el de las 10:15 o el de las 11:15?`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Rama Personal Training', order: 5 },
    [
      {
        title: 'Encaje',
        branch: 'pt',
        order: 1,
        body: `Gracias por contarme esto con tanto detalle 🙏

Por lo que me dices, creo que lo tuyo es Personal Training — nuestra línea más personalizada. No son sesiones 1 a 1, sino grupos muy reducidos (máximo 4 personas), y todo el entrenamiento se construye a partir de una valoración inicial contigo: objetivos, historial, lesiones, mediciones. Nada genérico.

Te dejo un vídeo corto donde te explico exactamente cómo funciona 👇`,
      },
      {
        title: 'Resumen + qué incluye la valoración',
        branch: 'pt',
        order: 2,
        body: `En resumen 👇

Personal Training es nuestra línea más personalizada: grupos de máximo 4 personas, con un entrenamiento diseñado específicamente para ti, no una clase estándar adaptada sobre la marcha.

Antes de empezar hacemos una valoración inicial, sin coste, donde vemos:

• Tu objetivo real y tu historial deportivo
• Mediciones y punto de partida físico
• Lesiones o limitaciones a tener en cuenta
• Qué formato de entrenamiento encaja mejor contigo

A partir de ahí, tu entrenador diseña el plan y lo va ajustando sesión a sesión.

Las sesiones son los martes y jueves, en turno de 16:15, 18:15 o 19:15 — el turno concreto se asigna en la propia valoración.

Te paso el horario disponible y la tarifa 👇`,
      },
      {
        title: 'Cierre — agendar valoración',
        branch: 'pt',
        order: 3,
        body: `La tarifa es 149,90€/mes, con 2 sesiones semanales (unas 8 al mes) en tu grupo de máximo 4 personas.

El siguiente paso no es "apuntarte" sin más — es reservar tu valoración inicial (sin coste ni compromiso) para diseñar contigo el plan antes de empezar. Así, cuando entres a tu primera sesión, ya sabemos exactamente qué necesitas.

¿Qué días te vienen mejor para la valoración: entre semana o fin de semana?`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'objecion', name: 'Objeciones y dudas', order: 6 },
    [
      {
        title: 'Respuesta a "¿cuánto cuesta?"',
        order: 1,
        body: `¡Claro! Te lo digo directo 😊

Nuestras tarifas van desde 64,90€/mes (6 clases) hasta 94,90€/mes (16 clases) en Funcional, y tenemos líneas específicas para +65 años y para entrenamiento 100% personalizado con precios distintos.

Para no mandarte una tarifa que no te encaje: ¿qué edad tienes y qué buscas exactamente? Así te digo la que es para ti, sin rodeos.`,
      },
      {
        title: 'Duda por precio',
        order: 2,
        body: `Lo entiendo totalmente, es una decisión y quiero que la tomes con calma, no con prisa 😊

Una cosa que ayuda a mucha gente a decidir: no hay permanencia, así que puedes probar el primer mes y, si no es para ti, lo dejas sin más compromiso. Y si el pack mensual se te hace grande, el Starter (64,90€, 6 clases) es una forma muy manejable de empezar.

¿Qué es lo que más te frena — el precio, el horario, o simplemente quieres pensarlo?`,
      },
      {
        title: 'Duda por miedo al nivel / compromiso',
        order: 3,
        body: `Es una de las dudas más normales que nos llegan, así que tranquilo/a 😊

Las clases están pensadas justo para eso: nadie llega "en forma", se llega a construirla. El entrenador adapta cada ejercicio a tu nivel dentro de la propia clase, así que no hay manera de "no estar preparado" para empezar.

¿Te ayudaría venir a probar una clase antes de decidirte del todo?`,
      },
      {
        title: 'Duda genérica / "lo pienso y te digo"',
        order: 4,
        body: `¡Por supuesto, tómate el tiempo que necesites! 😊

Solo una cosa: si al final te decides, avísame por aquí mismo y te reservo la plaza mientras aún haya hueco en el horario que te interesa. Aquí estoy para lo que necesites mientras tanto.`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'seguimiento', name: 'Seguimiento (silencio)', order: 7 },
    [
      {
        title: 'Día +1 tras el silencio',
        order: 1,
        body: `¡Hola de nuevo! 👋 No sé si te llegó bien toda la info o si te ha surgido alguna duda por el camino — dime lo que sea, aunque sea una tontería, y te lo aclaro encantado 😊`,
      },
      {
        title: 'Día +3 tras el silencio',
        order: 2,
        body: `Te dejo por aquí algo que le pasa a mucha gente que empieza: las primeras 2-3 semanas son las que más cuesta arrancar, y luego se convierte en algo que se echa de menos si un día no vas 😄

Si el horario era lo que te frenaba, dime qué días te van mejor y miramos opciones.`,
      },
      {
        title: 'Día +7 — cierre de puerta abierta',
        order: 3,
        body: `No quiero ser pesado, así que este es mi último mensaje por aquí 😊

Si más adelante te apetece retomarlo, aquí seguimos — solo tienes que escribirme y seguimos justo donde lo dejamos, sin tener que volver a explicar nada. ¡Un abrazo!`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Funcional', order: 8 },
    [
      {
        title: 'Petición de datos',
        branch: 'funcional',
        order: 1,
        body: `¡Perfecto! 🙌 Para darte de alta solo necesito:

• Nombre y apellidos
• Correo electrónico
• Teléfono (si es distinto a este)
• Tarifa elegida: {tarifa recomendada / la que haya elegido}

En cuanto lo tenga, te doy de alta y te explico el siguiente paso.`,
      },
      {
        title: 'Alta en AimHarder',
        branch: 'funcional',
        order: 2,
        body: `¡Muchas gracias por haberte inscrito, {nombre}!

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

Para *confirmar tu plaza*, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la app *AimHarder* en tu móvil — la necesitarás para reservar tus clases cada semana.
5️⃣ Desde la app, realiza el *pago de la tarifa que has elegido* ({tarifa}) para dejar tu plaza confirmada.

⚠️ Las plazas se están asignando por orden de confirmación, por lo que te recomiendo completar el proceso *lo antes posible* para no quedarte sin sitio.

Una vez hayas realizado el pago, *avísame por aquí* y seguimos con el siguiente paso 😊

Si necesitas ayuda en algún momento, estoy aquí para lo que necesites 🙌`,
      },
      {
        title: 'Inscripción en lista de espera (grupos completos)',
        branch: 'funcional',
        order: 3,
        body: `¡Muchas gracias por haberte inscrito! 🙌

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

👉 Como tu disponibilidad es en {horario indicado}, ahora mismo los grupos están *completos*, pero te vamos a incluir en nuestra *lista de espera prioritaria*.

Para asegurar tu posición en la lista, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la app AimHarder en tu móvil.
5️⃣ Desde la app, realiza el pago de *60€* para confirmar tu entrada en la lista de espera.

👉 En cuanto se libere una plaza (normalmente entre *2 y 4 semanas*), te avisaremos para que puedas incorporarte.

En ese momento, simplemente abonarás la diferencia hasta completar tu tarifa.

⚠️ Las plazas se asignan por orden de confirmación en lista de espera, por lo que te recomiendo completar el proceso lo antes posible.`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Tempus +65', order: 9 },
    [
      {
        title: 'Petición de datos',
        branch: '+65',
        order: 1,
        body: `¡Perfecto! 🙌 Para dejarte apuntado/a en el turno de {turno elegido}, solo necesito:

• Nombre y apellidos
• Correo electrónico
• Teléfono (si es distinto a este)

En cuanto lo tenga, te confirmo tu plaza y te cuento cómo hacer el pago.`,
      },
      {
        title: 'Confirmación de turno + opciones de pago',
        branch: '+65',
        order: 2,
        body: `¡Genial, {nombre}! Tu turno de {turno elegido} (martes y jueves) queda apuntado.

Como es un horario fijo, no hace falta que te des de alta en ninguna app para reservar nada — tu plaza ya está asignada a ese turno. Solo queda confirmar el pago de la cuota (69,90€/mes), y tienes dos formas de hacerlo:

1️⃣ *Por AimHarder*, si prefieres pagar online — te paso los pasos.
2️⃣ *En el centro*, en efectivo o tarjeta, antes de tu primera clase.

Para asegurarte el hueco te recomiendo confirmar el pago cuanto antes — las plazas de ese turno son limitadas. ¿Cuál de las dos opciones prefieres?`,
      },
      {
        title: 'Si elige AimHarder',
        branch: '+65',
        order: 3,
        body: `¡Genial! Te dejo los pasos para pagar por AimHarder:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la app *AimHarder* en tu móvil (solo la necesitas para el pago, no vas a tener que reservar clases).
5️⃣ Desde la app, realiza el pago de tu tarifa (69,90€) para confirmar la plaza.

En cuanto hayas pagado, avísame por aquí y te lo confirmo 😊`,
      },
      {
        title: 'Si prefiere pagar en el centro',
        branch: '+65',
        order: 4,
        body: `¡Genial! Entonces solo tienes que traer el pago en efectivo o tarjeta.

Eso sí, para asegurarte el hueco del turno de {turno elegido}, si puedes acercarte a pagar *antes* de tu primer día, mejor que mejor — las plazas se van confirmando por orden de pago.

📍 Nos encontramos en {dirección del centro, Toledo}.`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Personal Training', order: 10 },
    [
      {
        title: 'Confirmación de la valoración',
        branch: 'pt',
        order: 1,
        body: `¡Genial, {nombre}! Tu valoración inicial queda agendada para el {día} a las {hora} — sin coste ni compromiso.

Trae ropa cómoda y, si tienes, cualquier informe médico o de lesión relevante; nos ayuda a diseñarte mejor el plan desde el primer día.

📍 Nos encontramos en {dirección del centro, Toledo}.

¡Nos vemos pronto! 💪`,
      },
      {
        title: 'Confirmación de turno + opciones de pago (tras la valoración)',
        branch: 'pt',
        order: 2,
        body: `¡Ha sido un placer conocerte, {nombre}! Tu turno queda asignado: {turno} (martes y jueves).

Solo queda confirmar el pago de la cuota (149,90€/mes), y tienes dos formas de hacerlo:

1️⃣ *Por AimHarder*, si prefieres pagar online — te paso los pasos.
2️⃣ *En el centro*, en efectivo o tarjeta, antes de tu primera sesión.

Para asegurarte el hueco te recomiendo confirmar el pago cuanto antes — los grupos de PT son de máximo 4 personas. ¿Cuál de las dos opciones prefieres?`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'confirmacion', name: 'Confirmación — Funcional', order: 11 },
    [
      {
        title: 'Tras confirmar el pago (elige su primer día)',
        branch: 'funcional',
        order: 1,
        body: `¡Perfecto, muchas gracias! 🙌

Hemos recibido la confirmación del pago y *tu plaza en Tempus Functional Fitness ya está asegurada* ✔️

Para ir organizándolo todo, dime por favor *qué día y a qué hora te vendría mejor tu primera clase*, y así te la dejamos reservada desde el primer día — a partir de ahí ya podrás reservar tú mismo/a el resto de clases desde la app, cuando quieras.

📍 Nos encontramos en {dirección del centro, Toledo}.

Además, para que estés al tanto de avisos importantes y novedades del centro, puedes *unirte a nuestro grupo oficial de WhatsApp* aquí 👇
🔗 https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t

Si tienes cualquier duda antes de empezar, estoy por aquí 😊`,
      },
      {
        title: 'Apuntado — primera clase ya reservada por nosotros (variante)',
        branch: 'funcional',
        order: 2,
        body: `¡Perfecto! 😊

Ya te hemos *reservado nosotros la primera clase*, así que no tienes que preocuparte por nada.

El *primer día*, te explicaremos con calma *cómo reservar el resto de clases desde la app AimHarder*, para que luego puedas gestionarlo tú de forma sencilla.

Cualquier duda que te surja antes de venir, escríbeme sin problema 🙌

¡Nos vemos pronto en *Tempus Funcional Fitness*! 💪`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'confirmacion', name: 'Confirmación — Tempus +65', order: 12 },
    [
      {
        title: 'Confirmación final',
        branch: '+65',
        order: 1,
        body: `¡Todo listo, {nombre}! Tu plaza en Tempus +65, turno de {turno elegido} (martes y jueves), está confirmada ✅

Ven 10 minutos antes tu primer día para que te enseñemos el centro y te presentemos al entrenador.

Además, para que estés al tanto de avisos importantes y novedades del centro, únete a nuestro grupo oficial de WhatsApp aquí 👇
🔗 https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t

¡Nos vemos pronto! 💪`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'confirmacion', name: 'Confirmación — Personal Training', order: 13 },
    [
      {
        title: 'Confirmación final',
        branch: 'pt',
        order: 1,
        body: `¡Todo listo, {nombre}! Tu plaza en Personal Training, turno de {turno} (martes y jueves), está confirmada ✅

Además, para que estés al tanto de avisos importantes y novedades del centro, únete a nuestro grupo oficial de WhatsApp aquí 👇
🔗 https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t

¡Nos vemos en tu primera sesión! 💪`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'funcional', funnelStage: 'gestion_cliente', name: 'Gestión de cliente activo', order: 14 },
    [
      {
        title: 'Congelación de tarifa',
        order: 1,
        body: `Si durante un mes (o varios) no vas a poder asistir a entrenar, puedes activar nuestra *Tarifa de Congelación* para mantener tu plaza y tu precio actual.

Esta tarifa tiene un coste de *10€ al mes* y se renueva automáticamente el día 1 de cada mes mientras esté activa.

¿Qué te permite?
✅ Mantener tu plaza asegurada
✅ Mantener tu tarifa actual
✅ No perder tu antigüedad
✅ Volver cuando quieras sin lista de espera

Es una opción pensada para viajes, oposiciones, picos de trabajo, lesiones puntuales o cualquier situación temporal.

Cuando quieras reincorporarte, simplemente nos avisas y reactivamos tu tarifa habitual 😊`,
      },
    ]
  );

  // ============================================================
  // CROSSFIT TEMPUS (centerType: 'crossfit')
  // ============================================================

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'apertura', name: 'Apertura', order: 1 },
    [
      {
        title: 'Apertura',
        order: 1,
        body: `¡Hola! 👋 Mi nombre es Miguel, estoy aquí para ayudarte. Gracias por interesarte por entrenar en nuestro centro.

Necesito que me respondas a las siguientes preguntas:

1️⃣ ¿Habías practicado CrossFit antes?
2️⃣ Disponibilidad horaria
3️⃣ Edad y lesiones en caso de haberlas`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'rama', name: 'CrossFit directo (con experiencia)', order: 2 },
    [
      {
        title: 'Respuesta — ya has practicado CrossFit',
        branch: 'crossfit_si',
        order: 1,
        body: `✅ Si ya habías practicado CrossFit antes puedes empezar directamente por nuestras clases de CrossFit.

Con las tarifas que te comparto aquí abajo 👇 podrás reservar todo tipo de clases, no siendo iniciación. Tienes bastante variedad, como clases de fuerza (Strength), clases de Entrenamiento Funcional (Funcional 45), clases más orientadas al Cardio (Endurance), y por supuesto, clases de CrossFit.

🔹 Aunque ya tengas experiencia, en CrossFit Tempus queremos ayudarte y que te sientas como en casa, tendrás un entrenador que irá haciéndote un seguimiento personalizado durante tus primeros meses y con el que podrás contar para cualquier consulta.

ℹ️ Para hacer el alta, necesito la siguiente información:

1️⃣ Nombre y Apellidos
2️⃣ Mail y tlfn
3️⃣ Tarifa elegida`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'rama', name: 'Iniciación (sin experiencia previa)', order: 3 },
    [
      {
        title: 'Iniciación — hueco disponible este mes',
        branch: 'iniciacion',
        order: 1,
        body: `El grupo de iniciación de este mes está casi completo. Al ser un grupo reducido y debido a la alta demanda, las plazas se completan siempre a principios de mes.

🔵 Nos quedan muy pocas plazas para este mes, por lo que te recomiendo hacerlo cuanto antes para asegurar tu hueco.

ℹ️ Para ello necesito la siguiente información:

1️⃣ Nombre y apellidos
2️⃣ Mail
3️⃣ Teléfono Móvil
4️⃣ Tarifa Seleccionada`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'rama', name: 'Lista de espera — Iniciación completa', order: 4 },
    [
      {
        title: 'Lista de espera (Iniciación)',
        branch: 'iniciacion_espera',
        order: 1,
        body: `El grupo de iniciación está completo. Al ser un grupo reducido y debido a la alta demanda, las plazas se completan siempre a principios de mes.

🔵 Tenemos lista de espera, lo que estamos haciendo es apuntar a los interesados en esta lista de espera. Las plazas de espera pueden variar pero oscilan entre 2-4 semanas.

🔗 El proceso es el siguiente:

1. Para acceder a la lista de espera debes hacer una preinscripción de 50€.
2. Una vez te avisemos para poder empezar a entrenar solo pagarías la diferencia hasta la tarifa elegida. Ejemplo: eliges tarifa ON RAMP, te quedaría por abonar 5€ sumados a los 50€ abonados de la lista de espera.

ℹ️ Para ello necesito la siguiente información:

1️⃣ Nombre y apellidos
2️⃣ Mail
3️⃣ Teléfono Móvil
4️⃣ Tarifa Seleccionada`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'rama', name: 'Lista de espera — CrossFit completo', order: 5 },
    [
      {
        title: 'Lista de espera (CrossFit)',
        branch: 'crossfit_espera',
        order: 1,
        body: `El grupo de CrossFit está completo. Siempre tenemos mucha demanda y antes de que las clases estén sobresaturadas ponemos lista de espera.

🔵 Lo que estamos haciendo es apuntar a los interesados en esta lista de espera. Las plazas de espera pueden variar pero oscilan entre 2-4 semanas.

🔗 El proceso es el siguiente:

1. Para acceder a la lista de espera debes hacer una preinscripción de 50€.
2. Una vez te avisemos para poder empezar a entrenar solo pagarías la diferencia hasta la tarifa elegida. Ejemplo: eliges tarifa IRON, te quedaría por abonar 9,90€ sumados a los 50€ abonados de la lista de espera.

ℹ️ Para ello necesito la siguiente información:

1️⃣ Nombre y apellidos
2️⃣ Mail
3️⃣ Teléfono Móvil
4️⃣ Tarifa Seleccionada`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'rama', name: 'Planificación nutricional', order: 6 },
    [
      {
        title: 'Info nutrición CrossFit Tempus',
        branch: 'nutricion',
        order: 1,
        body: `Hola 👋

Te paso la info sobre la planificación nutricional en CrossFit Tempus.

La realizan nuestros entrenadores y nutricionistas Javi y Sara. Puedes elegir con quién hacerla según disponibilidad, o nosotros te asignamos al que tenga hueco antes.

📍 *Proceso:*

1️⃣ *Primera consulta:* te medimos, pesamos y hacemos una pequeña entrevista sobre tu estilo de vida, entrenamientos, hábitos y objetivos.

2️⃣ *Planificación:* en un plazo máximo de 7-10 días recibirás tu planificación nutricional personalizada para el primer mes.

3️⃣ *Revisión mensual:* volvemos a medir, pesar y ajustar el plan según resultados y sensaciones.

Lo ideal es hacer revisiones mensuales durante los primeros 2-3 meses.

💰 *Precios:*

🔹 Pack individual: apertura + 3 revisiones → *150 €*
🔹 Pack pareja: apertura + 3 revisiones → *250 €*

Después del pack inicial:

🔸 Revisión suelta → *45 €*
🔸 Pack 3 revisiones → *100 €*

Si quieres empezar, dinos si prefieres hacerlo con Javi o con Sara 😊`,
      },
    ]
  );

  await loadGroup(
    { centerType: 'crossfit', funnelStage: 'gestion_cliente', name: 'Gestión de cliente activo', order: 7 },
    [
      {
        title: 'Congelación de tarifa',
        order: 1,
        body: `Si durante un mes (o varios) no vas a poder asistir a entrenar, puedes activar nuestra *Tarifa de Congelación* para mantener tu plaza y tu precio actual.

Esta tarifa tiene un coste de *10€ al mes* y se renueva automáticamente el día 1 de cada mes mientras esté activa.

¿Qué te permite?
✅ Mantener tu plaza asegurada
✅ Mantener tu tarifa actual
✅ No perder tu antigüedad
✅ Volver cuando quieras sin lista de espera

Es una opción pensada para viajes, oposiciones, picos de trabajo, lesiones puntuales o cualquier situación temporal.

Cuando quieras reincorporarte, simplemente nos avisas y reactivamos tu tarifa habitual 😊`,
      },
    ]
  );

  const categoryCount = await MessageCategory.countDocuments();
  const templateCount = await MessageTemplate.countDocuments();
  console.log(`\n✓ Listo. Total en BD: ${categoryCount} categorías, ${templateCount} plantillas.`);

  process.exit(0);
}

run().catch((err) => {
  console.error('Error cargando la biblioteca de mensajes:', err);
  process.exit(1);
});
