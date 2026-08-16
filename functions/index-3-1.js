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

// Los precios y días de cada plan viven en Firestore (colección "configuracion",
// documento "precios"), editables desde el panel de administración del sitio
// sin necesidad de un nuevo deploy. Estos valores son el respaldo por si el
// documento todavía no existe.
const PLANES_POR_DEFECTO = {
  basico:     { precio: 0,    dias: 1,  fotos: 1  },
  destacado:  { precio: 1.29, dias: 3,  fotos: 4  },
  intermedio: { precio: 3.39, dias: 7,  fotos: 6  },
  avanzado:   { precio: 6.99, dias: 15, fotos: 8  },
  premium:    { precio: 9.99, dias: 30, fotos: 10 }
};

// Tarifas de banners y videos de portada: precio en USD según alcance
// (nacional = un solo país, internacional = todos) y días de duración.
const TARIFAS_MEDIA_DEFECTO = {
  banner: {
    nacional:      { '7': 3.99, '15': 7.99,  '30': 13.99 },
    internacional: { '7': 6.99, '15': 19.99, '30': 34.99 }
  },
  video: {
    nacional:      { '15': 8.99,  '30': 16.99 },
    internacional: { '15': 31.99, '30': 53.99 }
  }
};

async function obtenerPrecios() {
  try {
    const snap = await db.collection('configuracion').doc('precios').get();
    if (snap.exists) {
      const datos = snap.data() || {};
      // Combina lo guardado con los valores por defecto, por si falta algún plan.
      return { ...PLANES_POR_DEFECTO, ...datos };
    }
  } catch (e) {
    console.error('No se pudo leer configuracion/precios, usando valores por defecto:', e);
  }
  return PLANES_POR_DEFECTO;
}

async function obtenerTarifasMedia() {
  try {
    const snap = await db.collection('configuracion').doc('tarifasMedia').get();
    if (snap.exists) {
      const datos = snap.data() || {};
      return {
        banner: { ...TARIFAS_MEDIA_DEFECTO.banner, ...(datos.banner || {}) },
        video: { ...TARIFAS_MEDIA_DEFECTO.video, ...(datos.video || {}) }
      };
    }
  } catch (e) {
    console.error('No se pudo leer configuracion/tarifasMedia, usando valores por defecto:', e);
  }
  return TARIFAS_MEDIA_DEFECTO;
}

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
// Determina la colección de Firestore, el precio y los días de vigencia
// según el tipo de compra (anuncio, banner o video).
async function resolverCompra(datos) {
  const tipo = datos.tipo || 'anuncio'; // 'anuncio' | 'banner' | 'video'

  if (tipo === 'banner' || tipo === 'video') {
    const tarifas = await obtenerTarifasMedia();
    const alcance = datos.alcance === 'internacional' ? 'internacional' : 'nacional';
    const dias = String(datos.dias || '');
    const tablaTipo = tarifas[tipo] || {};
    const precio = tablaTipo[alcance] ? tablaTipo[alcance][dias] : undefined;
    if (precio === undefined || precio === null) return null;
    return {
      tipo,
      coleccion: tipo === 'banner' ? 'banners' : 'videos',
      precio,
      dias: parseInt(dias, 10),
      etiqueta: `${tipo === 'banner' ? 'Banner' : 'Video'} ${alcance} (${dias} días)`
    };
  }

  // Anuncio
  const precios = await obtenerPrecios();
  const planInfo = precios[datos.plan];
  if (!planInfo || !planInfo.dias || planInfo.precio === undefined || planInfo.precio === null) {
    return null;
  }
  return {
    tipo: 'anuncio',
    coleccion: 'anuncios',
    precio: planInfo.precio,
    dias: planInfo.dias,
    etiqueta: `Anuncio "${datos.titulo}" — plan ${datos.plan} (${planInfo.dias} días)`
  };
}

exports.crearSesionPago = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Método no permitido');
    try {
      const datos = req.body || {};
      const compra = await resolverCompra(datos);
      if (!compra) return res.status(400).json({ error: 'Plan o tarifa inválida' });
      if (!datos.uid) return res.status(400).json({ error: 'Falta el usuario' });

      let docRef;
      if (compra.tipo === 'anuncio') {
        if (!datos.titulo || (!datos.whatsapp && !datos.email)) {
          return res.status(400).json({ error: 'Faltan datos del anuncio (título y al menos un contacto)' });
        }
        docRef = await db.collection('anuncios').add({
          titulo: datos.titulo,
          categoria: datos.categoria || '',
          subcategoria: datos.subcategoria || '',
          pais: datos.pais || '',
          departamento: datos.departamento || '',
          descripcion: datos.descripcion || '',
          whatsapp: datos.whatsapp || '',
          email: datos.email || datos.emailContacto || '',
          fotos: Array.isArray(datos.fotos) ? datos.fotos : [],
          uid: datos.uid,
          plan: datos.plan,
          precioPagado: compra.precio,
          estadoPago: 'pendiente',
          estado: 'pendiente_pago',
          fechaCreacion: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // banner o video
        if (!datos.url && compra.tipo === 'video') {
          return res.status(400).json({ error: 'Falta el enlace del video' });
        }
        docRef = await db.collection(compra.coleccion).add({
          url: datos.url || '',
          link: datos.link || '',
          titulo: datos.titulo || '',
          pais: datos.pais || '',
          alcance: datos.alcance === 'internacional' ? 'internacional' : 'nacional',
          diasComprados: compra.dias,
          uid: datos.uid,
          email: datos.email || '',
          precioPagado: compra.precio,
          estadoPago: 'pendiente',
          estado: 'pendiente_pago',
          fechaCreacion: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Orden de PayPal por el monto correspondiente.
      const client = clientePaypal(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: docRef.id,
          description: compra.etiqueta,
          amount: { currency_code: 'USD', value: compra.precio.toFixed(2) }
        }],
        application_context: {
          brand_name: 'Clasificados Iberoamérica',
          user_action: 'PAY_NOW',
          return_url: `${SITE_URL}/pago-confirmado.html?docId=${docRef.id}&tipo=${compra.tipo}`,
          cancel_url: `${SITE_URL}/pago-cancelado.html?docId=${docRef.id}&tipo=${compra.tipo}`
        }
      });

      const orden = await client.execute(request);
      await docRef.update({ paypalOrderId: orden.result.id, tipoCompra: compra.tipo });

      const linkAprobar = orden.result.links.find(l => l.rel === 'approve');
      if (!linkAprobar) throw new Error('PayPal no devolvió un link de aprobación');

      return res.status(200).json({ url: linkAprobar.href, docId: docRef.id, tipo: compra.tipo });
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

      // Busca el doc primero en anuncios, luego en banners, luego en videos
      // (así no dependemos de que el frontend nos diga el tipo correcto).
      const colecciones = ['anuncios', 'banners', 'videos'];
      let docRef, docSnap, coleccion;
      for (const c of colecciones) {
        const ref = db.collection(c).doc(referenceId);
        const snap = await ref.get();
        if (snap.exists) { docRef = ref; docSnap = snap; coleccion = c; break; }
      }
      if (!docSnap) return res.status(404).json({ error: 'Compra no encontrada' });

      const datosDoc = docSnap.data();

      if (coleccion === 'anuncios') {
        const precios = await obtenerPrecios();
        const dias = (precios[datosDoc.plan] && precios[datosDoc.plan].dias) || 1;
        const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
        await docRef.update({
          estado: 'activo',
          estadoPago: 'pagado',
          fechaPago: admin.firestore.FieldValue.serverTimestamp(),
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expira)
        });
      } else {
        // banners / videos: quedan pendientes de aprobación del admin,
        // pero ya con la vigencia pagada calculada desde ahora.
        const dias = datosDoc.diasComprados || 7;
        const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
        await docRef.update({
          estado: 'pendiente',
          estadoPago: 'pagado',
          fechaPago: admin.firestore.FieldValue.serverTimestamp(),
          fechaExpiracion: admin.firestore.Timestamp.fromDate(expira)
        });
      }

      return res.status(200).json({ ok: true, docId: referenceId, tipo: coleccion });
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

6. Creá pago-confirmado.html: una página simple que lea "?docId=", "?tipo=" y
   "?token=" de la URL, llame a capturarPago con ese token como orderId, y
   muestre "¡Listo, tu compra ya está activa!" (o "pendiente de aprobación"
   si tipo es banner/video) o el error correspondiente.

7. Cuando termines de probar en Sandbox, cambiá PAYPAL_MODE a 'live' y
   repetí los pasos 1-2 con tus credenciales reales.
===========================================================
*/
