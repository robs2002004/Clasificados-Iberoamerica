const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const paypal = require('@paypal/checkout-server-sdk');

admin.initializeApp();
const db = admin.firestore();

// Secrets: se configuran una sola vez con la Firebase CLI, NO se suben al
// repo ni a GitHub. Ver instrucciones al final de este archivo.
const PAYPAL_CLIENT_ID = defineSecret('PAYPAL_CLIENT_ID');
const PAYPAL_CLIENT_SECRET = defineSecret('PAYPAL_CLIENT_SECRET');

const PAYPAL_MODE = 'live';

const SITE_URL = 'https://robs2002004.github.io/Clasificados-Iberoamerica';

// Debe coincidir con los planes y precios definidos en tu index.html.
const PLAN_DIAS = { destacado: 3, basico: 8, intermedio: 15, full: 30 };
const PLAN_PRECIOS = { destacado: 1.39, basico: 2.99, intermedio: 5.99, full: 12.99 };

function clientePaypal(clientId, clientSecret) {
  const Environment = PAYPAL_MODE === 'live'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;
  return new paypal.core.PayPalHttpClient(new Environment(clientId, clientSecret));
}

/**
 * Llamada desde index.html cuando el usuario elige un plan de pago.
 * Crea el anuncio en Firestore como "pendiente_pago" (no visible aún al
 * público) y crea la orden en PayPal. Devuelve { url } con el link de
 * aprobación de PayPal, igual que hacía Stripe, así el frontend no cambia.
 */
exports.crearSesionPago = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Método no permitido');
    try {
      const datos = req.body || {};
      const plan = datos.plan;
      const dias = PLAN_DIAS[plan];
      const precio = PLAN_PRECIOS[plan];
      if (!dias || !precio) {
        return res.status(400).json({ error: 'Plan inválido' });
      }
      if (!datos.titulo || !datos.whatsapp || !datos.uid) {
        return res.status(400).json({ error: 'Faltan datos del anuncio' });
      }

      // 1. Anuncio en Firestore, todavía no activo.
      const anuncioRef = await db.collection('anuncios').add({
        titulo: datos.titulo,
        categoria: datos.categoria || '',
        subcategoria: datos.subcategoria || '',
        pais: datos.pais || '',
        departamento: datos.departamento || '',
        descripcion: datos.descripcion || '',
        whatsapp: datos.whatsapp || '',
        fotos: Array.isArray(datos.fotos) ? datos.fotos : [],
        uid: datos.uid,
        email: datos.email || '',
        plan,
        precioPagado: precio,
        estadoPago: 'pendiente',
        estado: 'pendiente_pago',
        fechaCreacion: admin.firestore.FieldValue.serverTimestamp()
      });

      // 2. Orden de PayPal por el monto del plan.
      const client = clientePaypal(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: anuncioRef.id,
          description: `Anuncio "${datos.titulo}" — plan ${plan} (${dias} días)`,
          amount: { currency_code: 'USD', value: precio.toFixed(2) }
        }],
        application_context: {
          brand_name: 'Clasificados Iberoamérica',
          user_action: 'PAY_NOW',
          return_url: `${SITE_URL}/pago-confirmado.html?anuncioId=${anuncioRef.id}`,
          cancel_url: `${SITE_URL}/pago-cancelado.html?anuncioId=${anuncioRef.id}`
        }
      });

      const orden = await client.execute(request);
      await anuncioRef.update({ paypalOrderId: orden.result.id });

      const linkAprobar = orden.result.links.find(l => l.rel === 'approve');
      if (!linkAprobar) throw new Error('PayPal no devolvió un link de aprobación');

      return res.status(200).json({ url: linkAprobar.href, anuncioId: anuncioRef.id });
    } catch (err) {
      console.error('Error creando la orden de PayPal:', err);
      return res.status(500).json({ error: err.message || 'Error al crear el pago' });
    }
  }
);

/**
 * El usuario vuelve a tu sitio (return_url) después de aprobar el pago en
 * PayPal. Llamá a esta función desde esa página con el orderId (viene en la
 * URL como "token") para confirmar el cobro de verdad antes de activar el
 * anuncio. Nunca actives un anuncio solo porque el usuario "volvió".
 */
exports.capturarPago = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET], cors: true },
  async (req, res) => {
    try {
      const orderId = req.method === 'POST' ? (req.body || {}).orderId : req.query.orderId;
      if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

      const client = clientePaypal(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      request.requestBody({});
      const captura = await client.execute(request);

      if (captura.result.status !== 'COMPLETED') {
        return res.status(400).json({ error: 'El pago no se completó', estado: captura.result.status });
      }

      const referenceId = captura.result.purchase_units[0].reference_id;
      const anuncioRef = db.collection('anuncios').doc(referenceId);
      const anuncioSnap = await anuncioRef.get();
      if (!anuncioSnap.exists) return res.status(404).json({ error: 'Anuncio no encontrado' });

      const plan = anuncioSnap.data().plan;
      const dias = PLAN_DIAS[plan] || 30;
      const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

      await anuncioRef.update({
        estado: 'activo',
        estadoPago: 'pagado',
        fechaPago: admin.firestore.FieldValue.serverTimestamp(),
        fechaExpiracion: admin.firestore.Timestamp.fromDate(expira)
      });

      return res.status(200).json({ ok: true, anuncioId: referenceId });
    } catch (err) {
      console.error('Error capturando el pago de PayPal:', err);
      return res.status(500).json({ error: err.message || 'Error al confirmar el pago' });
    }
  }
);

/**
 * (Recomendado) Webhook de respaldo por si el usuario cierra el navegador
 * antes de volver a tu sitio. Configurar en PayPal Developer Dashboard →
 * tu app → Webhooks, apuntando a esta URL, escuchando al menos el evento
 * PAYMENT.CAPTURE.COMPLETED.
 */
exports.paypalWebhook = onRequest(async (req, res) => {
  try {
    const evento = req.body || {};
    console.log('Webhook de PayPal recibido:', evento.event_type);
    // TODO: verificar la firma del webhook con el PAYPAL_WEBHOOK_ID antes de
    // confiar en el evento. Ver:
    // https://developer.paypal.com/api/rest/webhooks/rest/#link-verifywebhooksignature
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error en webhook de PayPal:', err);
    res.status(500).send('Error');
  }
});

/*
============================================================
 PASOS PARA DEJARLO FUNCIONANDO
============================================================
1. Sacá tus credenciales de Sandbox en developer.paypal.com → Apps & Credentials.

2. Guardalas como secrets de Firebase (una sola vez, desde tu compu):
     firebase functions:secrets:set PAYPAL_CLIENT_ID
     firebase functions:secrets:set PAYPAL_CLIENT_SECRET

3. Reemplazá SITE_URL arriba con tu dominio real.

4. Desde la carpeta functions/:
     npm install
     firebase deploy --only functions

5. En tu index.html, cambiá la constante:
     const URL_CREAR_PAGO = "https://REGION-TU-PROYECTO.cloudfunctions.net/crearSesionPago";
   (te la da la consola al desplegar).

6. Creá pago-confirmado.html: una página simple que lea "?anuncioId=" y
   "?token=" de la URL, llame a capturarPago con ese token como orderId, y
   muestre "¡Listo, tu anuncio ya está activo!" o el error correspondiente.

7. Cuando termines de probar en Sandbox, cambiá PAYPAL_MODE a 'live' y
   repetí los pasos 1-2 con tus credenciales reales.
===========================================================
*/
