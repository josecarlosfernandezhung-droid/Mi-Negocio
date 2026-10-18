/* Puente nativo: descargas, compartir y enlaces externos dentro del APK (Capacitor). En el navegador no hace nada. */
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  function call(plugin, method, opts) {
    var P = C.Plugins && C.Plugins[plugin];
    if (P && typeof P[method] === 'function') return P[method](opts);
    return C.nativePromise(plugin, method, opts);
  }
  function toBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function limpio(n) { return String(n || 'archivo').replace(/[\\/:*?"<>|\s]+/g, '_'); }

  async function guardarYCompartir(blobPromise, nombre, titulo) {
    try {
      var blob = await blobPromise;
      var nom = limpio(nombre);
      var data = await toBase64(blob);
      var w = await call('Filesystem', 'writeFile', { path: nom, data: data, directory: 'CACHE', recursive: true });
      await call('Share', 'share', { title: titulo || nom, dialogTitle: nom, url: w.uri });
    } catch (e) {
      var m = e && e.message ? e.message : String(e);
      if (!/cancel/i.test(m)) alert('No se pudo guardar/compartir el archivo: ' + m);
    }
  }

  // Descargas: <a download href="blob:..."> (la app y jsPDF usan esto)
  function interceptar(a) {
    if (a && a.download && /^(blob:|data:)/.test(a.href || '')) {
      // fetch se inicia ya, antes de que la app revoque el blob
      guardarYCompartir(fetch(a.href).then(function (r) { return r.blob(); }), a.download);
      return true;
    }
    return false;
  }
  var click0 = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (interceptar(this)) return;
    return click0.apply(this, arguments);
  };
  var disp0 = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    if (this instanceof HTMLAnchorElement && ev && ev.type === 'click' && interceptar(this)) return true;
    return disp0.apply(this, arguments);
  };

  // Compartir archivos (turno): el WebView no lo soporta, usamos el selector nativo
  navigator.canShare = function (d) { return !!(d && d.files && d.files.length); };
  navigator.share = function (d) {
    var f = d && d.files && d.files[0];
    if (f) return guardarYCompartir(Promise.resolve(f), f.name, d.title);
    return call('Share', 'share', { title: d && d.title, text: d && d.text, url: d && d.url });
  };

  // Enlaces externos (WhatsApp): abrir en el navegador del sistema
  var open0 = window.open;
  window.open = function (url) {
    // wa.me etc.: se entrega a Android, que abre la app (WhatsApp) directo, sin cargar una página web
    if (/^https?:/i.test(url || '')) { window.location.assign(url); return null; }
    return open0.apply(window, arguments);
  };
})();
