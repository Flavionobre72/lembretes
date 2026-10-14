// VigilCare · service worker — avisos de lembrete no aparelho (Deploy 016)
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (ev) { ev.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (ev) { ev.respondWith(fetch(ev.request)); });
self.addEventListener("push", function (ev) {
  var d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { corpo: ev.data ? ev.data.text() : "" }; }
  var op = { body: d.corpo || "", icon: "vigilcare-icone-192.png", badge: "vigilcare-icone-192.png", tag: d.tag || "vc-aviso", renotify: true, data: { url: d.url || "/", acoes: d.acoes || null } };
  if (d.acoes) op.actions = d.acoes.map(function (a) { return { action: a.id, title: a.titulo }; });
  ev.waitUntil(self.registration.showNotification(d.titulo || "VigilCare", op));
});
self.addEventListener("notificationclick", function (ev) {
  ev.notification.close();
  var dados = ev.notification.data || {}, url = dados.url || "/";
  if (ev.action && dados.acoes) { var a = dados.acoes.filter(function (x) { return x.id === ev.action; })[0]; if (a && a.url) url = a.url; }
  var alvo = new URL(url, self.location.origin).href;
  ev.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (lista) {
    for (var i = 0; i < lista.length; i++) if ("focus" in lista[i]) { lista[i].navigate ? lista[i].navigate(alvo) : null; return lista[i].focus(); }
    return self.clients.openWindow(alvo);
  }));
});
