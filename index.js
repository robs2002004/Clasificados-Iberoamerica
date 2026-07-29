// functions/index.js
//
// Cloud Functions para Clasificados Iberoamérica.
// Requiere: firebase-functions, firebase-admin, stripe
//
// Instalación:
//   cd functions
//   npm install firebase-admin firebase-functions stripe
//
// Configurar la llave secreta de Stripe (NUNCA la pongas en el HTML):
//   firebase functions:config:set stripe.secret="sk_live_xxxxx" stripe.webhook_secret="whsec_xxxxx"
//
// Deploy:
//   firebase deploy --only functions

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const stripe = require("stripe")(functions.config().stripe.secret);

// Duración de cada plan, en días
const DIAS_POR_PLAN = {
  destacado: 30,
  premium: 60,
};

// URL base de tu sitio (para success_url / cancel_url de Stripe)
const SITIO_URL = "https://www.runcar.app"; // TODO: ajustar al dominio real del sitio de clasificados

/**
 * 1) El cliente llama esta función cuando elige un plan de pago.
 *    - Crea el anuncio en Firestore con estado "pendiente".
 *    - Crea una sesión de Stripe Checkout.
 *    - Devuelve la URL para redirigir al usuario a pagar.
 */
exports.crearSesionPago = functions.https.onRequest(async (req, res) => {
  // CORS básico para que el fetch() del sitio funcione
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).send("");
  }

  try {
    const { titulo, categoria, pais, descripcion, whatsapp, uid, email, plan, precio } = req.body;

    if (!uid || !titulo || !whatsapp || !plan || !precio) {
      return res.status(400).json({ error: "Faltan datos requeridos." });
    }
    if (!DIAS_POR_PLAN[plan]) {
      return res.status(400).json({ error: "Plan inválido." });
    }

    // Crear el anuncio como "pendiente" — se activa cuando llegue el webhook de pago confirmado
    const anuncioRef = await db.collection("anuncios").add({
      titulo, categoria, pais, descripcion, whatsapp,
      uid, email,
      plan,
      precioPagado: precio,
      estadoPago: "pendiente",
      destacado: plan !== "basico",
      estado: "pendiente",
      fechaCreacion: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Crear la sesión de pago en Stripe
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Anuncio ${plan} — ${titulo}` },
          unit_amount: Math.round(precio * 100), // Stripe usa centavos
        },
        quantity: 1,
      }],
      metadata: { anuncioId: anuncioRef.id, plan, dias: String(DIAS_POR_PLAN[plan]) },
      success_url: `${SITIO_URL}/?pago=exitoso&anuncio=${anuncioRef.id}`,
      cancel_url: `${SITIO_URL}/?pago=cancelado&anuncio=${anuncioRef.id}`,
    });

    return res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 2) Stripe llama a esta función automáticamente cuando el pago se confirma.
 *    Configurar este endpoint en el Dashboard de Stripe → Developers → Webhooks
 *    Evento a escuchar: checkout.session.completed
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      functions.config().stripe.webhook_secret
    );
  } catch (err) {
    console.error("Webhook inválido:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { anuncioId, dias } = session.metadata;

    const expira = new Date(Date.now() + Number(dias) * 24 * 60 * 60 * 1000);

    await db.collection("anuncios").doc(anuncioId).update({
      estadoPago: "pagado",
      estado: "activo",
      fechaExpiracion: admin.firestore.Timestamp.fromDate(expira),
      stripeSessionId: session.id,
    });
  }

  res.json({ recibido: true });
});

/**
 * 3) (Opcional, recomendado) Función programada diaria que vence anuncios
 *    cuya fechaExpiracion ya pasó. Reutiliza el patrón de "función de vigilancia"
 *    que ya usás en RUN CAR PRO MAX, pero corriendo en el servidor en vez del cliente.
 */
exports.vencerAnunciosDiario = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const ahora = admin.firestore.Timestamp.now();
    const vencidos = await db.collection("anuncios")
      .where("estado", "==", "activo")
      .where("fechaExpiracion", "<=", ahora)
      .get();

    const lote = db.batch();
    vencidos.forEach(doc => lote.update(doc.ref, { estado: "vencido" }));
    await lote.commit();

    console.log(`Anuncios vencidos hoy: ${vencidos.size}`);
    return null;
  });
