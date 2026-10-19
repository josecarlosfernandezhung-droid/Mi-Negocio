/* Enlace de Gestión Negocio con el Servidor de Pedidos (servidor_pedidos.ps1).
 *  - Ventas: cada venta cobrada se manda al servidor como pedido "cobrado" (igual que la app del vendedor).
 *    Sin conexión se quedan en cola y salen solas al reconectar (clienteId evita duplicados).
 *  - Datos: con conexión trae productos, precios y stock del servidor (emparejando código = SKU).
 *  - Se configura en Ajustes → Sistema y seguridad → "Servidor de pedidos". Sin dirección guardada no hace nada.
 */
(function () {
  'use strict';
  var LS_CFG = 'gn_srv_cfg', LS_ST = 'gn_srv_state', LS_MEM = 'gn_srv_mem';
  var CICLO_MS = 15000, CATALOGO_MS = 45000, ALMACENES_MS = 120000, REINTENTO_RECHAZO_MS = 5 * 60 * 1000;
  var native = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

  /* ---------- almacenamiento ---------- */
  function leer(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function guardar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function cfg() { return leer(LS_CFG, {}) || {}; }
  function estado() {
    var s = leer(LS_ST, null) || {};
    s.sent = s.sent || {}; s.rej = s.rej || {};
    return s;
  }
  function guardarEstado(s) { guardar(LS_ST, s); }

  var ui = { almacenes: [], online: null, msg: '', buscando: '', ultimaSync: '', ultimoCatalogo: 0, authError: '', trabajando: false };
  var oyentes = [];
  function avisar() { oyentes.forEach(function (f) { try { f(); } catch (e) {} }); }

  /* ---------- HTTP (nativo en el APK: sin problemas de https/http mixto) ---------- */
  function normBase(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    if (!/:\d+$/.test(u.replace(/^https?:\/\//i, ''))) u += ':8080';
    return u;
  }
  async function http(method, url, cuerpo, ms, vendedor) {
    ms = ms || 6000;
    var cab = { 'Content-Type': 'application/json' };
    if (vendedor) cab['X-Vendedor'] = encodeURIComponent(vendedor);
    if (native) {
      var r = await Capacitor.nativePromise('CapacitorHttp', 'request', {
        url: url, method: method, headers: cab, data: cuerpo, connectTimeout: ms, readTimeout: ms, responseType: 'json'
      });
      var d = r.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
      return { status: r.status, data: d };
    }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    try {
      var res = await fetch(url, { method: method, headers: cab, body: cuerpo ? JSON.stringify(cuerpo) : undefined, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      var dd = null; try { dd = await res.json(); } catch (e) {}
      return { status: res.status, data: dd };
    } finally { if (t) clearTimeout(t); }
  }
  async function ping(base, ms) {
    try { var r = await http('GET', base + '/api/ping', null, ms || 3000); return !!(r.data && r.data.app === 'toto-pedidos'); }
    catch (e) { return false; }
  }

  /* ---------- buscar el servidor solo si la dirección guardada deja de responder ---------- */
  function prefijoDe(ip) { var m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(String(ip || '')); return m ? m[1] : null; }
  function leerMem() { return leer(LS_MEM, {}) || {}; }
  function recordar(base) {
    var m = /^https?:\/\/(\d+\.\d+\.\d+)\.(\d+)(?::\d+)?$/i.exec(String(base || ''));
    if (!m) return; var mem = leerMem(); mem[m[1]] = m[2]; guardar(LS_MEM, mem);
  }
  function ipsLocales() {
    return new Promise(function (resolve) {
      var ips = {}, pc = null, listo = false;
      function fin() { if (listo) return; listo = true; try { if (pc) pc.close(); } catch (e) {} resolve(Object.keys(ips)); }
      try { pc = new RTCPeerConnection({ iceServers: [] }); } catch (e) { resolve([]); return; }
      try {
        pc.createDataChannel('x');
        pc.onicecandidate = function (ev) {
          if (!ev || !ev.candidate) { fin(); return; }
          var m = /(\d+\.\d+\.\d+\.\d+)/.exec(ev.candidate.candidate || '');
          if (m && !/^(0\.|127\.|169\.254\.)/.test(m[1])) ips[m[1]] = 1;
        };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(fin);
      } catch (e) { fin(); }
      setTimeout(fin, 1500);
    });
  }
  async function escanear(prefijo, puerto) {
    var encontrado = null, i = 1;
    async function trabajador() {
      while (!encontrado && i <= 254) {
        var base = 'http://' + prefijo + '.' + (i++) + ':' + puerto;
        if (await ping(base, 700)) encontrado = base;
      }
    }
    await Promise.all(Array.from({ length: 40 }, trabajador));
    return encontrado;
  }
  async function buscarServidor(actual) {
    var mp = /:(\d+)$/.exec(String(actual || '').replace(/^https?:\/\//i, ''));
    var puerto = mp ? mp[1] : '8080', limite = Date.now() + 45000, mem = leerMem();
    var directas = Object.keys(mem).map(function (p) { return 'http://' + p + '.' + mem[p] + ':' + puerto; });
    var rd = await Promise.all(directas.map(function (b) { return ping(b, 1200).then(function (ok) { return ok ? b : null; }); }));
    var dir = rd.filter(Boolean)[0]; if (dir) return dir;
    var prefijos = [];
    function agregar(p) { if (p && prefijos.indexOf(p) < 0) prefijos.push(p); }
    (await ipsLocales()).forEach(function (ip) { agregar(prefijoDe(ip)); });
    agregar(prefijoDe(String(actual || '').replace(/^https?:\/\//i, '').split(':')[0]));
    Object.keys(mem).forEach(agregar);
    ['192.168.43', '192.168.137', '192.168.0', '192.168.1', '192.168.2', '172.20.10', '192.168.42', '10.0.0', '192.168.100'].forEach(agregar);
    for (var k = 0; k < prefijos.length; k++) {
      if (Date.now() > limite) break;
      ui.buscando = 'Buscando el servidor en ' + prefijos[k] + '.x …'; avisar();
      var b = await escanear(prefijos[k], puerto);
      if (b) return b;
    }
    return '';
  }

  /* ---------- estado de la venta (solo con conexión): cobrado / pendiente de pago ---------- */
  var pickEstado = 'cobrado', intent = null, lastPend = false;
  function conectado() { var c = cfg(); return !!(c.url && c.vendedor && c.enviar !== false && ui.online === true); }

  /* ---------- venta de la app -> pedido del servidor ---------- */
  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function payloadDe(venta, prods, c) {
    var items = [], suma = 0;
    (venta.items || []).forEach(function (it) {
      var qty = Number(it.qty) || 0; if (qty <= 0) return;
      var lt = Number(it.lineTotal); if (!isFinite(lt)) lt = (Number(it.unitPrice) || 0) * qty;
      var p = prods[it.productId];
      items.push({ sku: String((p && p.code) || '').trim(), nombre: String(it.name || (p && p.name) || ''), unidad: it.unit || '', precio: Math.round(lt / qty * 10000) / 10000, cantidad: qty });
      suma += lt;
    });
    var total = Number(venta.totalBase); if (!isFinite(total)) total = suma;
    var dif = r2(total - suma);
    if (Math.abs(dif) >= 0.01) items.push({ sku: '', nombre: dif < 0 ? 'Descuento' : 'Cargo por servicio', unidad: '', precio: dif, cantidad: 1 });
    // Efectivo / transferencia (en moneda base)
    var trans = 0;
    if (venta.paymentMethod === 'transfer') trans = total;
    else if (venta.paymentMethod === 'mixed' && Array.isArray(venta.payments)) {
      venta.payments.forEach(function (p) { if (p.method === 'transfer') trans += Number(p.amountBase) || 0; });
      trans = Math.min(total, r2(trans));
    }
    var efec = r2(total - trans);
    var d = {
      vendedor: c.vendedor, pin: c.pin || '', clienteId: 'gn-' + venta.id, estado: 'cobrado', items: items,
      hora: venta.createdAt,
      nota: 'Venta de Gestión Negocio' + (venta.table ? ' · mesa ' + venta.table : '')
    };
    var meta = venta.srv || null;
    if (meta && meta.estado === 'pendiente') {
      // La caja de la PC la cobra: el servidor aplica el x2 si es transferencia
      d.estado = 'pendiente'; d.metodoPago = meta.metodo === 'Transferencia' ? 'Transferencia' : 'Efectivo';
      d.montoRecibido = null; d.cambio = null;
    } else if (meta && meta.x2 && venta.paymentMethod === 'transfer') {
      var recibido = Number(venta.transferAmount) || 0;
      if (venta.transferCurrency && venta.rate) recibido = recibido * Number(venta.rate);
      d.metodoPago = 'Transferencia'; d.montoRecibido = r2(recibido); d.cambio = 0;
    } else if (trans <= 0.004) { d.metodoPago = 'Efectivo'; d.montoRecibido = r2(total); d.cambio = 0; }
    else { d.metodoPago = 'Combinado'; d.pagoEfectivo = efec; d.pagoTransferencia = r2(trans); d.montoRecibido = r2(total); d.cambio = 0; }
    return d;
  }

  /* ---------- núcleo ---------- */
  var busy = false, rehacer = false, ultimoAlmacenes = 0, ultimoCicloCatalogo = 0, ultimaBusqueda = 0;
  function GN() { return window.__GN; }

  async function ventasNoEnviadas(st, desde) {
    var g = GN();
    if (cfg().enviar === false) return []; // envío de ventas desactivado: nada queda pendiente
    var todas = await g.db.sales.where('createdAt').above(desde).toArray();
    return todas.filter(function (v) { return !v.voided && !st.sent[v.id]; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
  }

  // Lo vendido aquí que el servidor aún no sabe, por ubicación y producto: {ubicacion: {productId: cantidad}}
  async function pendientesPorUbicacion(st, desde) {
    var YE = GN().Ye, out = {};
    (await ventasNoEnviadas(st, desde || '')).forEach(function (v) {
      var loc = String(v.sourceLocation || v.area || YE);
      (v.items || []).forEach(function (it) {
        out[loc] = out[loc] || {};
        out[loc][it.productId] = (out[loc][it.productId] || 0) + (Number(it.qty) || 0);
      });
    });
    return out;
  }

  async function enviarCola(c, st) {
    var g = GN();
    var pend = await ventasNoEnviadas(st, c.desde || '');
    if (!pend.length) return { enviadas: 0, error: '' };
    var lista = await g.db.products.toArray(), prods = {};
    lista.forEach(function (p) { prods[p.id] = p; });
    var enviadas = 0, ahora = Date.now();
    for (var i = 0; i < pend.length; i++) {
      var v = pend[i], rj = st.rej[v.id];
      if (rj && ahora - rj.t < REINTENTO_RECHAZO_MS && !ui.forzar) continue;
      var resp;
      try { resp = await http('POST', c.url + '/api/pedidos', payloadDe(v, prods, c), 15000, c.vendedor); }
      catch (e) { ui.online = false; return { enviadas: enviadas, error: '' }; }
      var d = resp.data || {};
      if (resp.status >= 200 && resp.status < 300 && d.ok) {
        st.sent[v.id] = Date.now(); delete st.rej[v.id]; enviadas++; guardarEstado(st);
      } else if (d.requierePin || (resp.status === 403 && /PIN/i.test(d.error || ''))) {
        return { enviadas: enviadas, error: 'PIN o vendedor incorrecto. Revísalos en Ajustes → Servidor de pedidos.' };
      } else if (resp.status >= 500 || resp.status === 0) {
        return { enviadas: enviadas, error: '' };
      } else {
        st.rej[v.id] = { error: String(d.error || ('Error ' + resp.status)), t: Date.now() }; guardarEstado(st);
      }
    }
    return { enviadas: enviadas, error: '' };
  }

  function redondeaCant(x) { return Math.round(x * 1000) / 1000; }

  async function traerCatalogo(c, st) {
    var g = GN();
    var r = await http('GET', c.url + '/api/catalogo', null, 20000, c.vendedor);
    if (r.status !== 200 || !Array.isArray(r.data)) return { error: 'El servidor no entregó el catálogo.' };
    var YE = g.Ye;
    // lo vendido aquí que el servidor todavía no sabe (cola y rechazadas) no debe volver a aparecer como stock
    var pend = await ventasNoEnviadas(st, c.desde || ''), pendPorProd = {};
    pend.forEach(function (v) {
      var loc = String(v.sourceLocation || v.area || YE);
      if (loc !== YE) return;
      (v.items || []).forEach(function (it) { pendPorProd[it.productId] = (pendPorProd[it.productId] || 0) + (Number(it.qty) || 0); });
    });
    var locales = await g.db.products.toArray(), porCodigo = {};
    locales.forEach(function (p) { var k = String(p.code || '').trim(); if (k && !porCodigo[k]) porCodigo[k] = p; });
    var creados = 0, cambiados = 0, n = 0;
    for (var i = 0; i < r.data.length; i++) {
      var s = r.data[i], sku = String(s.sku || '').trim(); if (!sku) continue;
      var nombre = String(s.nombre || '').trim(), precio = Number(s.precio);
      var stockSrv = (s.stock === null || s.stock === undefined) ? null : Number(s.stock);
      var p = porCodigo[sku];
      try {
        if (!p) {
          if (!nombre) continue;
          await g.Kt.create({ code: sku, name: nombre, categoryId: null, unit: (g.ul && g.ul[0]) || 'u', price: isFinite(precio) ? precio : 0, cost: 0, openingStock: stockSrv && stockSrv > 0 ? stockSrv : 0, userId: null });
          creados++;
        } else {
          var camb = false;
          if (nombre && nombre !== p.name && p.active !== false) { await g.Kt.update(p.id, { name: nombre }); camb = true; }
          if (isFinite(precio) && precio >= 0 && !p.priceCurrency && Math.abs(Number(p.price) - precio) >= 0.005) { await g.Kt.changePrice(p.id, precio, { note: 'Servidor de pedidos' }); camb = true; }
          if (c.enviar !== false && stockSrv !== null && isFinite(stockSrv) && p.active !== false) {
            var objetivo = redondeaCant(stockSrv - (pendPorProd[p.id] || 0));
            var actual = await g.up.stockAt(p.id, YE);
            var delta = redondeaCant(objetivo - actual);
            if (Math.abs(delta) >= 0.0005) { await g.up.adjust({ productId: p.id, delta: delta, note: 'Sincronizado con el servidor de pedidos', userId: null, location: YE }); camb = true; }
          }
          if (camb) cambiados++;
        }
      } catch (e) { /* un producto con problema no frena a los demás */ }
      if (++n % 25 === 0) await new Promise(function (res) { setTimeout(res, 0); });
    }
    return { creados: creados, cambiados: cambiados, error: '' };
  }

  // Almacenes reales de AxisPOS (los que entrega el servidor): cada uno pasa a ser un almacén/área de la app.
  async function traerAlmacenes(c, st) {
    var g = GN(), YE = g.Ye;
    if (c.enviar === false) return { error: '' }; // sin envío de ventas, el stock de la app no se pisa
    var r;
    try { r = await http('GET', c.url + '/api/stock-almacenes', null, 30000, c.vendedor); } catch (e) { return { error: '' }; }
    var d = r.data;
    if (r.status !== 200 || !d || !d.ok || !Array.isArray(d.almacenes)) return { error: '' }; // AxisPOS no activo: no es un error
    var pend = await pendientesPorUbicacion(st, c.desde);
    var locales = await g.db.products.toArray(), porCodigo = {};
    locales.forEach(function (p) { var k = String(p.code || '').trim(); if (k && !porCodigo[k]) porCodigo[k] = p; });
    var nombres = [], n = 0;
    for (var a = 0; a < d.almacenes.length; a++) {
      var al = d.almacenes[a], lista = Array.isArray(al.productos) ? al.productos : [];
      var nom = String(al.nombre || '').trim() || ('Almacén ' + al.id);
      if (nom.toLowerCase() === 'almacén' || nom.toLowerCase() === 'almacen') nom = 'Almacén ' + al.id;
      if (!lista.length) continue; // respuesta vacía: no se borra nada por si fue un fallo
      // el almacén tiene que existir como área de la app para poder verse y usarse
      var areas = await g.Pe.getAreas(), loc = null;
      areas.forEach(function (x) { if (!loc && String(x).toLowerCase() === nom.toLowerCase()) loc = x; });
      if (!loc) { loc = nom; await g.Pe.setAreas(areas.concat([nom])); }
      nombres.push(loc);
      var mapa = {};
      lista.forEach(function (x) { var k = String(x.sku || '').trim(); if (k) mapa[k] = (mapa[k] || 0) + (Number(x.stock) || 0); });
      var pl = pend[loc] || {};
      for (var i = 0; i < locales.length; i++) {
        var p = locales[i]; if (p.active === false) continue;
        var k2 = String(p.code || '').trim(); if (!k2 || porCodigo[k2] !== p) continue;
        var actual = Number(((p.stockByLocation || {})[loc]) || 0);
        var objetivo = redondeaCant((mapa[k2] || 0) - (pl[p.id] || 0));
        var delta = redondeaCant(objetivo - actual);
        if (Math.abs(delta) < 0.0005) continue;
        try { await g.up.adjust({ productId: p.id, delta: delta, note: 'Sincronizado con el servidor de pedidos', userId: null, location: loc }); } catch (e) {}
        if (++n % 25 === 0) await new Promise(function (res) { setTimeout(res, 0); });
      }
    }
    return { almacenes: nombres, error: '' };
  }

  async function ciclo(manual) {
    if (busy) { if (manual) rehacer = true; return; }
    if (!GN() || !GN().db) return;
    var c = cfg(); if (!c.url || !c.vendedor) { ui.online = null; avisar(); return; }
    busy = true; ui.trabajando = true; ui.forzar = !!manual; avisar();
    try {
      var st = estado();
      var vivo = await ping(c.url, 3000);
      if (!vivo && !window.__GNsync.noBuscar && (manual || Date.now() - ultimaBusqueda > 120000)) {
        ultimaBusqueda = Date.now();
        var nueva = await buscarServidor(c.url);
        ui.buscando = '';
        if (nueva) { c.url = nueva; guardar(LS_CFG, c); recordar(nueva); vivo = true; }
      }
      ui.online = vivo;
      if (!vivo) { ui.msg = 'Sin conexión con el servidor. Las ventas se guardan y se enviarán solas.'; return; }
      recordar(c.url);
      var env = await enviarCola(c, st);
      ui.authError = env.error;
      if (env.error) { ui.msg = env.error; return; }
      if (manual || Date.now() - ultimoCicloCatalogo > CATALOGO_MS || env.enviadas) {
        var cat = await traerCatalogo(c, st);
        ultimoCicloCatalogo = Date.now();
        if (cat.error) ui.msg = cat.error;
        else {
          ui.msg = ''; ui.ultimaSync = new Date().toLocaleTimeString();
          if (manual || Date.now() - ultimoAlmacenes > ALMACENES_MS || env.enviadas) {
            var alm = await traerAlmacenes(c, st);
            ultimoAlmacenes = Date.now();
            if (alm.almacenes) ui.almacenes = alm.almacenes;
          }
        }
      } else ui.msg = '';
    } catch (e) {
      ui.msg = 'Error al sincronizar: ' + (e && e.message ? e.message : e);
    } finally {
      busy = false; ui.trabajando = false; ui.forzar = false; ui.buscando = ''; avisar();
      if (rehacer) { rehacer = false; setTimeout(function () { ciclo(true); }, 200); }
    }
  }

  /* ---------- arranque ---------- */
  function arrancar() {
    if (!GN() || !GN().db) { setTimeout(arrancar, 500); return; }
    try { GN().db.sales.hook('creating', function () { setTimeout(function () { ciclo(false); }, 1500); }); } catch (e) {}
    setInterval(function () { ciclo(false); }, CICLO_MS);
    window.addEventListener('online', function () { setTimeout(function () { ciclo(false); }, 1000); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') ciclo(false); });
    setTimeout(function () { ciclo(false); }, 2500);
  }
  arrancar();

  /* ---------- tarjeta en Ajustes (usa las mismas clases de la app, sin botones nuevos fuera de Ajustes) ---------- */
  function SrvCard() {
    var R = window.__GN && window.__GN.React; if (!R) return null;
    var h = R.createElement;
    var _f = R.useState(function () { var c = cfg(); return { url: c.url || '', vendedor: c.vendedor || '', pin: c.pin || '', enviar: c.enviar !== false }; }), f = _f[0], setF = _f[1];
    var _t = R.useState(0), setTick = _t[1];
    var _p = R.useState({ n: 0, rej: [] }), info = _p[0], setInfo = _p[1];
    R.useEffect(function () {
      var fn = function () { setTick(function (x) { return x + 1; }); refrescarInfo(); };
      oyentes.push(fn); refrescarInfo();
      return function () { var i = oyentes.indexOf(fn); if (i >= 0) oyentes.splice(i, 1); };
    }, []);
    function refrescarInfo() {
      var c = cfg(); if (!GN() || !c.url) { setInfo({ n: 0, rej: [] }); return; }
      var st = estado();
      ventasNoEnviadas(st, c.desde || '').then(function (p) {
        var rej = p.filter(function (v) { return st.rej[v.id]; }).map(function (v) { return { id: v.id, total: v.totalBase, error: st.rej[v.id].error, fecha: String(v.createdAt || '').slice(0, 16).replace('T', ' ') }; });
        setInfo({ n: p.length, rej: rej });
      }).catch(function () {});
    }
    function set(k) { return function (e) { var o = {}; o[k] = e.target.value; setF(Object.assign({}, f, o)); }; }
    function guardarCfg() {
      var url = normBase(f.url), c = cfg();
      var nuevo = { url: url, vendedor: String(f.vendedor || '').trim(), pin: String(f.pin || '').trim(), desde: c.desde, enviar: !!f.enviar };
      if (nuevo.enviar && c.enviar === false) nuevo.desde = new Date().toISOString(); // al reactivar, no se manda lo vendido mientras estuvo apagado
      if (url && !nuevo.desde) nuevo.desde = new Date().toISOString(); // solo las ventas desde ahora; no se manda el historial viejo
      if (!url) { nuevo.desde = ''; }
      guardar(LS_CFG, nuevo); setF({ url: url, vendedor: nuevo.vendedor, pin: nuevo.pin, enviar: nuevo.enviar });
      ui.msg = url ? 'Guardado. Conectando…' : 'Enlace desactivado.'; avisar();
      if (url) ciclo(true);
    }
    var c = cfg(), activo = !!(c.url && c.vendedor);
    var estadoTxt = !activo ? 'Sin configurar' : ui.trabajando ? 'Sincronizando…' : ui.online === true ? 'Conectado' : ui.online === false ? 'Sin conexión' : 'Esperando…';
    var cls = ui.online === true ? 'ok-text' : ui.online === false ? 'warn-text' : 'muted';
    return h('section', { className: 'card' },
      h('h3', null, 'Servidor de pedidos'),
      h('p', { className: 'muted' }, 'Manda cada venta a la PC y trae productos, precios y stock. Sin conexión sigues vendiendo y se envía todo al reconectar.'),
      h('label', { className: 'field' }, h('span', null, 'Dirección del servidor'), h('input', { value: f.url, onChange: set('url'), placeholder: '192.168.43.5:8080', autoComplete: 'off', autoCapitalize: 'off', spellCheck: false })),
      h('label', { className: 'field' }, h('span', null, 'Vendedor (creado en la PC)'), h('input', { value: f.vendedor, onChange: set('vendedor'), autoComplete: 'off' })),
      h('label', { className: 'field' }, h('span', null, 'PIN del vendedor'), h('input', { value: f.pin, onChange: set('pin'), inputMode: 'numeric', type: 'password', autoComplete: 'off' })),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' } },
        h('input', { type: 'checkbox', checked: !!f.enviar, onChange: function (e) { setF(Object.assign({}, f, { enviar: e.target.checked })); } }),
        h('span', null, 'Enviar mis ventas al servidor')),
      !f.enviar && h('p', { className: 'muted', style: { fontSize: '0.85em' } }, 'Con el envío apagado la app sigue trayendo productos y precios, pero no toca el stock (para no borrar tus propias ventas).'),
      h('button', { className: 'btn btn--primary btn--block', onClick: guardarCfg }, 'Guardar y conectar'),
      activo && h('div', null,
        h('div', { className: 'kv' }, h('span', { className: 'muted' }, 'Estado'), h('strong', { className: cls }, estadoTxt)),
        c.enviar !== false && h('div', { className: 'kv' }, h('span', { className: 'muted' }, 'Ventas por enviar'), h('strong', null, String(info.n))),
        ui.almacenes && ui.almacenes.length > 0 && h('div', { className: 'kv' }, h('span', { className: 'muted' }, 'Almacenes'), h('strong', null, ui.almacenes.join(', '))),
        ui.ultimaSync && h('div', { className: 'kv' }, h('span', { className: 'muted' }, 'Última sincronización'), h('strong', null, ui.ultimaSync)),
        ui.buscando && h('p', { className: 'muted' }, ui.buscando),
        ui.msg && h('p', { className: ui.authError || ui.online === false ? 'warn-text' : 'muted' }, ui.msg),
        info.rej.length > 0 && h('div', null,
          h('p', { className: 'warn-text' }, 'El servidor no aceptó ' + info.rej.length + ' venta(s):'),
          info.rej.slice(0, 5).map(function (r) { return h('p', { key: r.id, className: 'muted', style: { fontSize: '0.85em' } }, r.fecha + ' · $' + r.total + ' — ' + r.error); })),
        h('button', { className: 'btn btn--block', onClick: function () { ciclo(true); }, disabled: ui.trabajando }, ui.trabajando ? 'Sincronizando…' : 'Sincronizar ahora')
      )
    );
  }
  window.__SrvCard = SrvCard;
  // Selector "Cobrado / Pendiente de pago": solo aparece (y solo vale) con el servidor conectado.
  function SrvPick() {
    var R = window.__GN && window.__GN.React; if (!R) return null;
    var _t = R.useState(0), setTick = _t[1];
    R.useEffect(function () { var f = function () { setTick(function (x) { return x + 1; }); }; oyentes.push(f); return function () { var i = oyentes.indexOf(f); if (i >= 0) oyentes.splice(i, 1); }; }, []);
    if (!conectado()) return null;
    var h = R.createElement;
    function tab(txt, val) { return h('button', { className: 'tab ' + (pickEstado === val ? 'is-active' : ''), onClick: function () { pickEstado = val; avisar(); } }, txt); }
    return h('div', { style: { margin: '8px 0' } },
      h('p', { className: 'muted', style: { margin: '0 0 4px', fontSize: '0.85em' } }, 'Estado en el servidor (transferencia = precio x2)'),
      h('div', { className: 'tabs' }, tab('Cobrado', 'cobrado'), tab('Pendiente de pago', 'pendiente')),
      pickEstado === 'pendiente' && h('p', { className: 'muted', style: { fontSize: '0.85em' } }, 'La venta se envía a la PC y la caja la cobra. No hace falta poner montos aquí.'));
  }
  window.__SrvPick = SrvPick;
  window.__GNsync = { sub: function (fn) { oyentes.push(fn); return function () { var i = oyentes.indexOf(fn); if (i >= 0) oyentes.splice(i, 1); }; },
    conectado: conectado, pend: function () { return conectado() && pickEstado === 'pendiente'; },
    x2: function (esTransfer) { return !!esTransfer && conectado(); },
    setIntent: function (m) { intent = m; },
    takeMeta: function (metodo) {
      var m = intent || metodo; intent = null;
      if (!conectado()) { lastPend = false; return null; }
      var meta = { estado: pickEstado, x2: m === 'transfer', metodo: m === 'transfer' ? 'Transferencia' : 'Efectivo' };
      lastPend = (pickEstado === 'pendiente'); pickEstado = 'cobrado'; setTimeout(avisar, 0);
      return meta;
    },
    get lastPend() { return lastPend; },
    ciclo: ciclo, payloadDe: payloadDe, cfg: cfg, estado: estado, ui: ui };
})();
