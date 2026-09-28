/**
 * Sustituye por completo la biblioteca de mensajes de Tempus Funcional (centerType: 'funcional')
 * por el embudo definitivo de Marco (sept-2026): 3 vías (General / +65 / Base), con lista de
 * espera por vía y dirección del centro en las confirmaciones. No toca 'crossfit'.
 * Ejecutar desde tempus-backend/: node scripts/migrateFuncionalFunnel.js
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
  console.log(`✓ ${categoryDef.name} — ${templates.length} plantilla(s)`);
  return category._id;
}

const DIRECCION = '📍 Nos encontramos en Avenida América 1, Toledo — aquí tienes la ubicación: https://maps.app.goo.gl/veaRGbqAwdKNdMho8';

async function run() {
  await connectDB();

  // 1. Borra TODO el contenido anterior de 'funcional' (categorías + plantillas). No toca 'crossfit'.
  const oldCats = await MessageCategory.find({ centerType: 'funcional' }).select('_id');
  const oldCatIds = oldCats.map((c) => c._id);
  const delTemplates = await MessageTemplate.deleteMany({ category: { $in: oldCatIds } });
  const delCats = await MessageCategory.deleteMany({ centerType: 'funcional' });
  console.log(`🗑  Borrado: ${delCats.deletedCount} categorías, ${delTemplates.deletedCount} plantillas antiguas de 'funcional'\n`);

  // ============================================================
  // APERTURA
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'apertura', name: 'Apertura', order: 1 },
    [
      {
        title: 'Mensaje 1 — común a las tres vías',
        order: 1,
        body: `Hola 👋 Soy Diego, de Tempus Funcional Fitness.

¡Muchas gracias por escribirnos y por interesarte en nuestro centro en Toledo! 💪

Antes de enviarte toda la información, me gustaría conocerte un poco mejor para recomendarte la modalidad que mejor encaje contigo 😊

¿Podrías contarme brevemente?

🎂 Tu edad.
💪 Cómo definirías tu forma física actual: buena, media, baja o empezando desde cero.
🏃 Si entrenas actualmente o cuánto tiempo llevas sin hacer deporte.
🎯 Qué te gustaría conseguir entrenando.
🕐 Si tienes disponibilidad de mañana o de tarde.
👥 Si te sentirías cómodo en un grupo habitual o preferirías empezar en un grupo especialmente reducido, con una atención más individual.
🩺 Si existe alguna lesión o limitación que debamos tener en cuenta.

Con esta información podré orientarte mucho mejor 💙

¡Te leo!`,
      },
    ]
  );

  // ============================================================
  // CLASIFICACIÓN — reglas internas, no se envían al cliente
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'clasificacion', name: 'Reglas internas de clasificación (no enviar)', order: 2 },
    [
      {
        title: 'Vía General',
        order: 1,
        body: `Utilizar cuando la persona:

• Tiene entre 15 y 65 años.
• Entrena actualmente, ha entrenado antes o presenta una condición física media o buena.
• Se siente cómoda en un grupo habitual.
• Busca mejorar fuerza, movilidad, resistencia o condición física general.`,
      },
      {
        title: 'Vía Tempus Base',
        order: 2,
        body: `Utilizar cuando la persona tiene entre 15 y 65 años y aparecen uno o varios de estos indicios:

• Lleva mucho tiempo sin hacer deporte.
• Considera que su condición física es baja o empieza desde cero.
• Siente vergüenza, inseguridad o reparo al comenzar.
• Prefiere un grupo muy pequeño.
• Cree que necesita más correcciones y atención del entrenador.
• Tiene sobrepeso o alguna circunstancia que hace recomendable comenzar progresivamente.
• Menciona una lesión o limitación concreta que requiere una atención más cercana.`,
      },
      {
        title: 'Vía Tempus +65',
        order: 3,
        body: `Utilizar cuando la persona:

• Tiene más de 65 años.
• Realiza poca actividad física o no entrena actualmente.
• Tiene una condición física baja.
• Busca mejorar fuerza, movilidad, equilibrio y autonomía.
• Quiere entrenar en un grupo adaptado y reducido.`,
      },
    ]
  );

  // ============================================================
  // RAMA — General
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Vía General — Clases habituales', order: 3 },
    [
      {
        title: 'Encaje',
        branch: 'general',
        order: 1,
        body: `¡Estupendo! 🙌

Gracias por contarme un poco más sobre ti.

Por lo que nos comentas, creemos que nuestras clases habituales pueden encajar muy bien contigo para mejorar tu forma física, ganar fuerza y sentirte con más energía 💪

Todas las sesiones están guiadas por un entrenador y los ejercicios se adaptan al nivel de cada persona.

Te dejo a continuación un vídeo para que puedas ver cómo trabajamos 💙`,
      },
      {
        title: 'Resumen',
        branch: 'general',
        order: 2,
        body: `En resumen 👇

Somos un centro de *entrenamiento funcional* con sesiones guiadas por un entrenador y adaptadas al nivel de cada persona.

Disponemos de tres tipos de clases:

🟢 *Tempus Funcional*: combina fuerza, movilidad y cardio. Es nuestra modalidad principal y se adapta a diferentes niveles.
🩷 *Tempus Hybrid*: una clase más dinámica e intensa para quienes buscan un reto adicional.
🟣 *Tempus Stretching*: centrada en movilidad, flexibilidad y bienestar.

Trabajamos en grupos reducidos para ofrecer una atención cercana, corregir la técnica y ayudar a cada persona a progresar con seguridad.

Ahora te envío el horario completo y las tarifas disponibles 📅`,
      },
    ]
  );

  // ============================================================
  // RAMA — Tempus +65
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Vía Tempus +65', order: 4 },
    [
      {
        title: 'Encaje',
        branch: '+65',
        order: 1,
        body: `¡Muchas gracias por contármelo! 🙌

Por tu edad, tu nivel de actividad actual y lo que buscas conseguir, creemos que la modalidad que mejor puede encajar contigo es *Tempus +65*.

Es un entrenamiento pensado específicamente para personas mayores que quieren conservar o recuperar fuerza, movilidad, equilibrio y seguridad en sus movimientos cotidianos.

Te envío un vídeo breve para que puedas conocer mejor cómo funciona 💙`,
      },
      {
        title: 'Resumen',
        branch: '+65',
        order: 2,
        body: `En resumen 👇

🟠 *Tempus +65* es una modalidad de entrenamiento diseñada para personas mayores de 65 años.

En las clases trabajamos:

💪 Fuerza para mantener la autonomía.
🤸 Movilidad y elasticidad.
⚖️ Equilibrio y coordinación.
🚶 Movimientos útiles para el día a día, como levantarse, caminar con seguridad o subir escaleras.

Todos los ejercicios se realizan de manera progresiva y adaptada al nivel de cada persona.

Las clases tienen un máximo de *8 personas*, lo que permite que el entrenador supervise de cerca a cada participante.

📅 La tarifa incluye *8 clases al mes*, con dos sesiones semanales.

Los horarios disponibles son:
• Martes y jueves a las 10:15.
• Martes y jueves a las 11:15.

En esta modalidad se elige uno de los dos horarios. Las clases de todos los martes y jueves quedarán reservadas automáticamente, por lo que no será necesario reservar cada sesión.

Ahora te envío el horario completo y las tarifas 📲`,
      },
    ]
  );

  // ============================================================
  // RAMA — Tempus Base
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'rama', name: 'Vía Tempus Base', order: 5 },
    [
      {
        title: 'Encaje',
        branch: 'base',
        order: 1,
        body: `¡Muchas gracias por contármelo! 🙌

Por lo que nos explicas, creemos que *Tempus Base* puede ser la mejor forma de empezar.

Está pensada para personas que quieren comenzar o retomar el ejercicio con más tranquilidad, en un grupo especialmente pequeño y con una atención más individual por parte del entrenador.

Te envío un vídeo breve para que veas cómo funciona 💙`,
      },
      {
        title: 'Resumen',
        branch: 'base',
        order: 2,
        body: `En resumen 👇

🔵 *Tempus Base* ofrece las mismas bases del entrenamiento funcional, pero en un grupo de un máximo de *6 personas*.

Este formato permite:

✅ Entrenar a tu propio ritmo.
✅ Empezar de manera progresiva.
✅ Recibir más atención del entrenador.
✅ Corregir mejor la técnica.
✅ Resolver dudas durante la sesión.
✅ Adaptar los ejercicios a tu nivel.

Es una opción especialmente adecuada si llevas tiempo sin entrenar, empiezas desde cero, no te sientes cómodo en grupos más grandes o buscas un acompañamiento más cercano.

📅 Tempus Base tiene una *tarifa específica de 8 clases al mes* e incluye además *2 clases mensuales de Stretching*.

Las clases se imparten los martes y jueves en estos horarios:
• 16:15.
• 17:00.
• 18:00.

No tienes que elegir un grupo fijo. Podrás reservar libremente cualquiera de estos horarios los martes y jueves, según tu disponibilidad y las plazas disponibles en cada sesión.

Ahora te envío el horario completo y las tarifas 📲`,
      },
    ]
  );

  // ============================================================
  // ALTA Y PAGO — General
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Clases generales', order: 6 },
    [
      {
        title: 'Petición de datos',
        branch: 'general',
        order: 1,
        body: `Si quieres que comprobemos disponibilidad y preparemos tu inscripción, necesito estos datos:

👉 Nombre y apellidos.
👉 Correo electrónico.
👉 Teléfono.
👉 Tarifa elegida.

En cuanto los reciba, comprobaré la disponibilidad y te explicaré el siguiente paso para dejar tu plaza preparada 💙`,
      },
      {
        title: 'Alta en AimHarder (hay hueco)',
        branch: 'general',
        order: 2,
        body: `¡Muchas gracias por haberte inscrito!

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

Para *confirmar tu plaza*, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la aplicación *AimHarder* en tu móvil.
5️⃣ Desde la aplicación, realiza el *pago de la tarifa que has elegido* para dejar tu plaza confirmada.

⚠️ Las plazas se están asignando por orden de confirmación, por lo que te recomiendo completar el proceso *lo antes posible* para no quedarte sin sitio.

Una vez hayas realizado el pago, *avísame por aquí* y seguimos con el siguiente paso 😊

Si necesitas ayuda en algún momento, estoy aquí para lo que necesites 🙌`,
      },
      {
        title: 'Lista de espera (grupo completo)',
        branch: 'general',
        order: 3,
        body: `¡Muchas gracias por haberte inscrito! 🙌

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

👉 Ahora mismo el horario que buscas está *completo*, pero te vamos a incluir en nuestra *lista de espera prioritaria*.

Para asegurar tu posición en la lista, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la aplicación *AimHarder* en tu móvil.
5️⃣ Desde la aplicación, realiza el pago de *60€* para confirmar tu entrada en la lista de espera.

👉 En cuanto se libere una plaza (normalmente entre *2 y 4 semanas*), te avisaremos para que puedas incorporarte.

En ese momento, simplemente abonarás la diferencia hasta completar tu tarifa.

⚠️ Las plazas se asignan por orden de confirmación en lista de espera, por lo que te recomiendo completar el proceso lo antes posible.`,
      },
    ]
  );

  // ============================================================
  // ALTA Y PAGO — Tempus +65
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Tempus +65', order: 7 },
    [
      {
        title: 'Petición de datos + turno',
        branch: '+65',
        order: 1,
        body: `Si quieres que comprobemos disponibilidad y preparemos tu inscripción, necesito:

👉 Nombre y apellidos.
👉 Teléfono.
👉 Grupo fijo elegido: martes y jueves a las 10:15 o martes y jueves a las 11:15.

Para Tempus +65 no necesitamos correo electrónico ni tendrás que utilizar la aplicación para reservar tus clases.

En cuanto reciba los datos, comprobaré si quedan plazas en el grupo elegido 💙`,
      },
      {
        title: 'Confirmación de inscripción (hay hueco)',
        branch: '+65',
        order: 2,
        body: `¡Perfecto! 🙌

Ya tenemos tus datos y hemos comprobado la disponibilidad en el grupo de *Tempus +65*.

Para completar la inscripción y confirmar tu plaza, puedes pasar por nuestro centro para:

✅ Conocernos personalmente.
✅ Conocer las instalaciones.
✅ Resolver cualquier duda antes de empezar.
✅ Abonar la tarifa elegida.

No necesitas registrarte mediante correo electrónico ni reservar las clases desde la aplicación. Una vez completada la inscripción, dejaremos reservadas automáticamente tus sesiones de todos los martes y jueves en el horario elegido.

Cuando sepas qué día puedes acercarte, avísame por aquí y te estaremos esperando 😊`,
      },
      {
        title: 'Lista de espera (grupo completo)',
        branch: '+65',
        order: 3,
        body: `¡Muchas gracias por contármelo! 🙌

👉 Ahora mismo el grupo de *Tempus +65* de [10:15 / 11:15] está *completo*, pero te vamos a incluir en nuestra *lista de espera prioritaria*.

Para asegurar tu posición en la lista, solo tienes que seguir estos pasos:

1️⃣ Nombre y apellidos.
2️⃣ Teléfono.
3️⃣ Realizar el pago de *60€* para confirmar tu entrada en la lista de espera (puedes hacerlo en efectivo o tarjeta pasando por el centro).

👉 En cuanto se libere una plaza (normalmente entre *2 y 4 semanas*), te avisaremos para que puedas incorporarte.

En ese momento, simplemente abonarás la diferencia hasta completar la tarifa (69,90€).

⚠️ Las plazas se asignan por orden de confirmación en lista de espera, por lo que te recomiendo completar el proceso lo antes posible.`,
      },
    ]
  );

  // ============================================================
  // ALTA Y PAGO — Tempus Base
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'alta_pago', name: 'Alta y pago — Tempus Base', order: 8 },
    [
      {
        title: 'Petición de datos',
        branch: 'base',
        order: 1,
        body: `Si quieres que comprobemos disponibilidad y preparemos tu inscripción en Tempus Base, necesito:

👉 Nombre y apellidos.
👉 Correo electrónico.
👉 Teléfono.
👉 Confirmación de que eliges la tarifa Tempus Base.

En cuanto reciba los datos, comprobaré si quedan plazas y te explicaré el siguiente paso 💙`,
      },
      {
        title: 'Alta en AimHarder (hay hueco)',
        branch: 'base',
        order: 2,
        body: `¡Muchas gracias por haberte inscrito!

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

Para *confirmar tu plaza*, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la aplicación *AimHarder* en tu móvil.
5️⃣ Desde la aplicación, realiza el *pago de la tarifa que has elegido* para dejar tu plaza confirmada.

⚠️ Las plazas se están asignando por orden de confirmación, por lo que te recomiendo completar el proceso *lo antes posible* para no quedarte sin sitio.

Una vez hayas realizado el pago, *avísame por aquí* y seguimos con el siguiente paso 😊

Si necesitas ayuda en algún momento, estoy aquí para lo que necesites 🙌`,
      },
      {
        title: 'Lista de espera (grupo completo)',
        branch: 'base',
        order: 3,
        body: `¡Muchas gracias por haberte inscrito! 🙌

Ya he creado tu cuenta en *AimHarder* y en breve recibirás un correo con la invitación para completar el registro.

👉 Ahora mismo *Tempus Base* está completo, pero te vamos a incluir en nuestra *lista de espera prioritaria*.

Para asegurar tu posición en la lista, solo tienes que seguir estos pasos:

1️⃣ Revisa tu correo y copia la contraseña que has recibido.
2️⃣ Haz clic en el enlace azul que aparece como "aquí".
3️⃣ Completa tus datos y vincula tu cuenta.
4️⃣ Descarga la aplicación *AimHarder* en tu móvil.
5️⃣ Desde la aplicación, realiza el pago de *60€* para confirmar tu entrada en la lista de espera.

👉 En cuanto se libere una plaza (normalmente entre *2 y 4 semanas*), te avisaremos para que puedas incorporarte.

En ese momento, simplemente abonarás la diferencia hasta completar la tarifa de Tempus Base.

⚠️ Las plazas se asignan por orden de confirmación en lista de espera, por lo que te recomiendo completar el proceso lo antes posible.`,
      },
    ]
  );

  // ============================================================
  // CONFIRMACIÓN — Clases generales y Tempus Base (compartida)
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'confirmacion', name: 'Confirmación — Clases generales y Tempus Base', order: 9 },
    [
      {
        title: 'Confirmación del pago',
        branch: 'general',
        order: 1,
        body: `¡Perfecto, muchas gracias! 🙌

Hemos recibido la confirmación del pago y *tu plaza en Tempus Functional Fitness ya está asegurada* ✔️

Para ir organizándolo todo, dime por favor *qué día y a qué hora te vendría mejor tu primera clase*, y así te la dejamos reservada desde el primer día.

${DIRECCION}

Además, para que estés al tanto de avisos importantes y novedades del centro, puedes *unirte a nuestro grupo oficial de WhatsApp* aquí 👇
🔗 https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t

Si tienes cualquier duda antes de empezar, estoy por aquí 😊`,
      },
    ]
  );

  // ============================================================
  // CONFIRMACIÓN — Tempus +65
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'confirmacion', name: 'Confirmación — Tempus +65', order: 10 },
    [
      {
        title: 'Confirmación del pago',
        branch: '+65',
        order: 1,
        body: `¡Perfecto, muchas gracias! 🙌

Hemos recibido el pago y *tu plaza en Tempus +65 ya está asegurada* ✔️

Tus clases quedarán reservadas automáticamente todos los martes y jueves a las *[10:15 / 11:15]*. No tendrás que reservarlas manualmente ni utilizar la aplicación para asegurar tu plaza.

Antes de comenzar, te esperamos en el centro unos minutos antes de tu primera sesión para enseñarte las instalaciones, presentarte al entrenador y conocer cualquier consideración que debamos tener en cuenta 😊

${DIRECCION}

Además, para recibir los avisos importantes y novedades del centro, puedes *unirte a nuestro grupo oficial de WhatsApp* aquí 👇
🔗 https://chat.whatsapp.com/C4qtl2IBvJq1hubgiQMznD?mode=gi_t

Si tienes cualquier duda antes de empezar, estoy por aquí 🙌`,
      },
    ]
  );

  // ============================================================
  // SEGUIMIENTO
  // ============================================================
  await loadGroup(
    { centerType: 'funcional', funnelStage: 'seguimiento', name: 'Seguimiento', order: 11 },
    [
      {
        title: 'Sin respuesta en 24 horas',
        order: 1,
        body: `¡Hola! 👋

Te escribo por si no pudiste revisar la información que te envié.

¿Has podido ver el vídeo, los horarios y las tarifas? Si tienes cualquier duda o quieres que te ayude a elegir modalidad, estaré encantado de orientarte 😊`,
      },
      {
        title: 'Sin respuesta en 3 días',
        order: 2,
        body: `¡Hola de nuevo! 😊

Solo quería saber si sigues interesado en empezar a entrenar con nosotros.

Trabajamos con grupos reducidos y la disponibilidad depende de cada modalidad. Si quieres, puedo comprobar las plazas disponibles.

¿Te gustaría que lo revisara? 💪`,
      },
    ]
  );

  const categoryCount = await MessageCategory.countDocuments({ centerType: 'funcional' });
  const templateCount = await MessageTemplate.countDocuments({
    category: { $in: (await MessageCategory.find({ centerType: 'funcional' }).select('_id')).map((c) => c._id) },
  });
  console.log(`\n✓ Listo. Funcional ahora tiene: ${categoryCount} categorías, ${templateCount} plantillas.`);

  process.exit(0);
}

run().catch((err) => {
  console.error('Error migrando el embudo de Funcional:', err);
  process.exit(1);
});
